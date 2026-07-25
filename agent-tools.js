/**
 * agent-tools.js — 앱·CLI·봇 공용 에이전트 도구 (스킬·MCP·작업기억·L3·기억).
 *
 * "창구는 달라도 기능은 동일" — 도구 선언과 실행을 한곳에 모아 main.js(앱)·engine.js(CLI/봇)가
 * 같은 코드를 쓰게 한다. 환경 의존(IPC emit 등)은 ctx 로 주입한다.
 *
 * ctx = {
 *   agentId, agent, generate,
 *   storage, brainClaude, skillsRegistry, mcpManager,
 *   mcpRoutes, offSkills(Set), pendingMcp(Map),
 *   emit(channel, payload),     // 앱=webContents.send / CLI=표시·무시
 *   onRemembered(),             // 기억 변경 플래그(remember/forget 시)
 * }
 *
 * (1차로 engine 이 사용. main.js 통합은 검증 후 별도 — 지금은 중복 유지로 앱 회귀 0.)
 */
'use strict';
const fsTools = require('./fs-tools'); // 공통 파일 도구 코어(허용폴더 한정)
const fs = require('fs');
const path = require('path');
const procTools = require('./proc-tools'); // 공통 셸 실행 코어(허용폴더 cwd + 위험명령 차단)
const webSearchTool = require('./web-search'); // 공통 웹검색 코어(DuckDuckGo 기본 + 네이버/Tavily 키)
const scheduler = require('./scheduler'); // 자율 백그라운드(정기 실행) 코어
const memorySearch = require('./memory-search'); // 기억 v3(B): 과거 대화·기억 능동 검색

function matchByIdOrName(arr, idKey, nameKey, q) {
  if (!q || !Array.isArray(arr)) return null;
  return arr.find(x => x[idKey] === q) || arr.find(x => x[nameKey] === q) || null;
}

/** 1층 '지금 쓸 수 있는 수단' 안내 문구(두뇌별). main.js 와 동일 표현. */
function buildAvailableTools({ toolsOn, webOn, multimodalOn, pdfOn, mcpDecls = [] }) {
  const availableTools = [];
  if (toolsOn) {
    if (webOn) availableTools.push('웹검색·URL읽기(실시간 인터넷 검색 및 링크 내용 읽기)');
    // 이 PC에서 실제 실행 가능한 코드 언어만 안내(없는 언어를 고르지 않게). 예: 보통 node만.
    let codeHint = '코드 실행(run_code — python/node/bash, 긴 코드에 편함)';
    try { const a = procTools.availableLangs(); const u = Object.keys(a).filter(k => a[k]); if (u.length) codeHint = `코드 실행(run_code — 이 PC에선 ${u.join('·')}로 실행돼. 다른 언어는 안 되니 이 중에서 골라. 긴 코드에 편함)`; } catch (_) {}
    availableTools.push('중요한 것 기억하기(remember — 대화 중 알게 된 사용자 사실·선호를 직접 장기기억에 저장)', '기억 지우기(forget — 사용자가 지워달라고 할 때 특정 기억을 삭제)', '옛 기억·대화 검색(search_memory — "저번에/그때/지난주에 ~한 거", "그 식당·그거 뭐였지"처럼 지금 대화창에 없는 과거를 물으면 지어내지 말고 이걸로 먼저 찾기)', '현재 날짜·시각', '정확한 계산(계산기)', 'URL/데이터 가져오기(fetch)', '새 스킬 찾기·설치(find_skill→승인→install_skill, 신뢰 출처)', '새 도구(MCP) 찾기·설치(find_mcp→승인→install_mcp, 예: 브라우저 자동화·파일·메모리)', '승인 정도(자율도) 바꾸기(set_trust — 사용자가 "앞으로 묻지 말고 알아서 해/위험한 것만 물어봐/뭐든 확인해"라고 하면)', '파일 다루기(list_files·read_file·write_file·make_dir·search_files — 허용된 폴더 안에서만, 새 폴더는 사용자 허락 후 grant_dir)', '사용자에게 파일 보내기(send_file — 만들었거나 가진 파일을 채팅으로 전달. 사용자가 "그 파일 줘/보내줘"라고 하면 이 도구를 써. 허용폴더 안 파일만. 링크·버튼을 글로 지어내지 말고 반드시 이 도구 호출)', '터미널 명령 실행(run_shell — 허용 폴더에서, 파괴적 명령 차단; 사용 전 grant_shell로 허락)', codeHint, '웹 검색(web_search — 실시간 정보·최신 사실을 인터넷에서 찾기)', '정기 작업 예약(schedule_task — "매일 9시/매시/N분마다" 자동 실행; PC 켜진 동안)', '방법 익히기·스킬 만들기(create_skill — 잘 해낸 방법을 저장해 다음에 재사용)', '먼저 안부 묻기 설정(set_heartbeat — "그만/다시 챙겨줘/인사 시간 바꿔")');
  }
  if (multimodalOn) availableTools.push(pdfOn ? '이미지·문서(PDF) 보기(사용자가 첨부한 파일을 직접 보고 이해)' : '이미지 보기(사용자가 첨부한 이미지를 직접 보고 이해)');
  if (mcpDecls.length > 0) availableTools.push(`연결된 MCP 도구: ${mcpDecls.map(d => d.name).join(', ')}`);
  return availableTools;
}

/** function-calling 도구 선언 배열. main.js extraDecls 와 동일. */
function buildDecls({ skillCatalog = [], mcpDecls = [] }) {
  const decls = [
    {
      name: 'remember',
      description: '사용자에 관해 새로 알게 된 중요한 사실·선호·관계·진행상황을 장기 기억에 저장한다. 사용자가 알려주거나(예: "나 커피 끊었어") 앞으로 기억해두면 좋을 정보일 때 호출. 사소하거나 일시적인 건 저장하지 마.',
      parameters: { type: 'object', properties: {
        label: { type: 'string', description: '기억 항목 이름(짧게, 예: "선호-음료", "직업")' },
        value: { type: 'string', description: '기억 내용(예: "커피를 끊음")' },
        importance: { type: 'number', description: '중요도 1(낮음)~3(높음). 핵심 정체성·관계는 3.' },
      }, required: ['label', 'value'] },
    },
    {
      name: 'forget',
      description: '사용자가 특정 기억을 지워달라고 명시적으로 요청할 때만 호출한다(예: "내 나이 기억 지워줘", "그건 잊어버려"). 정정 시(이전 기억 삭제 후 remember)도 사용. 요청 없이 임의로 지우지 마.',
      parameters: { type: 'object', properties: {
        query: { type: 'string', description: '지울 기억을 가리키는 말(항목 이름 또는 내용 키워드)' },
      }, required: ['query'] },
    },
  ];
  if (skillCatalog.length > 0) {
    decls.push({
      name: 'use_skill',
      description: '설치된 스킬의 전체 사용법을 펼쳐 읽는다. [사용 가능한 스킬] 목록의 이름으로 호출.',
      parameters: { type: 'object', properties: { name: { type: 'string', description: '스킬 이름 또는 id' } }, required: ['name'] },
    });
  }
  decls.push(
    { name: 'find_skill', description: '필요한 능력이 설치된 스킬에 없을 때, 신뢰 카탈로그에서 새 스킬 후보를 검색한다(읽기 전용). 설치는 사용자 승인 후 install_skill로.',
      parameters: { type: 'object', properties: { need: { type: 'string', description: '필요한 능력/작업 키워드' } }, required: ['need'] } },
    { name: 'install_skill', description: '카탈로그의 스킬을 설치한다. 사용자 승인 후 호출. find_skill 후보의 id로.',
      parameters: { type: 'object', properties: { id: { type: 'string', description: '카탈로그 스킬 id' } }, required: ['id'] } },
    { name: 'install_skill_web', description: '카탈로그·신뢰 레지스트리에도 없을 때, 웹에서 찾은 공개 스킬(GitHub의 SKILL.md 링크)을 설치한다. 반드시 web_search 등으로 찾은 출처(URL)를 사용자에게 보여주고 승인받은 뒤 호출. 보안 검수(패턴+AI 판정)를 통과해야만 설치되며 위험하면 자동 차단된다. GitHub raw/blob 링크만 가능.',
      parameters: { type: 'object', properties: { url: { type: 'string', description: '공개 SKILL.md 링크(github.com/.../blob/... 또는 raw.githubusercontent.com/...)' } }, required: ['url'] } },
    { name: 'search_memory', description: '예전 대화·기억·아카이브를 검색한다. 사용자가 "저번에/그때/지난주에 ~한 거", "그 식당·그 사람·그거 뭐였지"처럼 지금 대화창에 없는 과거를 물으면, 지어내지 말고 이 도구로 먼저 찾아봐. query엔 핵심 키워드(장소·주제·이름 등)를 넣어. 결과가 없으면 솔직히 "기록에 없다"고 해.',
      parameters: { type: 'object', properties: { query: { type: 'string', description: '찾을 핵심 키워드' } }, required: ['query'] } },
    { name: 'find_mcp', description: '필요한 능력(브라우저 자동화·파일·메모리 등)의 MCP 서버를 신뢰 카탈로그에서 검색(읽기전용). 설치는 사용자 승인 후 install_mcp로.',
      parameters: { type: 'object', properties: { need: { type: 'string', description: '필요한 능력 키워드' } }, required: ['need'] } },
    { name: 'install_mcp', description: 'MCP 서버를 설치(등록)한다. 사용자 승인 후 호출. find_mcp 후보의 id로. 필요한 입력(params, 예: 폴더 경로)이 있으면 함께 전달.',
      parameters: { type: 'object', properties: { id: { type: 'string' }, params: { type: 'object' } }, required: ['id'] } },
    { name: 'start_project', description: '새 프로젝트를 시작한다(시작과 끝이 있는 일). 사용자가 새 프로젝트를 언급하거나 "프로젝트로 진행"을 원할 때.',
      parameters: { type: 'object', properties: { title: { type: 'string' }, goal: { type: 'string' } }, required: ['title', 'goal'] } },
    { name: 'start_routine', description: '반복 루틴을 등록한다(끝없이 반복되는 일). 정기 반복 작업을 언급할 때.',
      parameters: { type: 'object', properties: { title: { type: 'string' }, rhythm: { type: 'string' } }, required: ['title'] } },
    { name: 'switch_work', description: '현재 활성 작업을 전환한다. id는 start_project/start_routine이 반환한 id.',
      parameters: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] } },
    { name: 'close_project', description: '프로젝트를 완료 처리한다. 작업기억은 archived 보관, 관계요약 1줄을 1층 기억에 승격.',
      parameters: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] } },
    { name: 'plan_task', description: '큰 작업을 단계별로 분해하고 순차 실행한다(L3). 여러 단계가 필요한 복잡한 작업에. 실행 전 계획을 먼저 제시하고 승인받는다.',
      parameters: { type: 'object', properties: { task: { type: 'string' }, projectId: { type: 'string' }, autoApprove: { type: 'boolean' } }, required: ['task'] } },
    { name: 'resume_task', description: '중단된 프로젝트의 작업을 이어서 실행한다(done 단계는 건너뜀).',
      parameters: { type: 'object', properties: { projectId: { type: 'string' } }, required: ['projectId'] } },
    { name: 'set_trust', description: '도구 사용 "승인 정도(자율도)"를 바꾼다. 사용자가 앞으로의 방침을 바꿔달라고 할 때만 호출 — 예: "앞으로 묻지 말고 알아서 해"·"매번 안 물어봐도 돼"·"항상 허용" → autonomous, "위험한 것만 물어봐"·"중요한 건 확인해" → ask_risky, "뭐든 일일이 물어봐"·"항상 확인받아" → ask_all. 단발성 "승인/그래"(이번 한 번만 허락)와는 구분해 — 그건 set_trust를 부르지 말고 그냥 작업해.',
      parameters: { type: 'object', properties: { level: { type: 'string', enum: ['ask_all', 'ask_risky', 'autonomous'], description: 'autonomous=확인 없이 진행, ask_risky=위험 작업만 확인(기본), ask_all=모든 변경 작업 확인' } }, required: ['level'] } },
    // ── 파일 도구(공통층) — 허용된 폴더(allowedDirs) 안에서만. 밖이면 needGrant 반환 → 사용자에게 허용을 구하고 grant_dir 로 추가. ──
    { name: 'list_files', description: '폴더 안의 파일·하위폴더 목록을 본다. 허용된 폴더 안에서만.',
      parameters: { type: 'object', properties: { dir: { type: 'string', description: '폴더 경로' } }, required: ['dir'] } },
    { name: 'read_file', description: '파일 내용을 읽는다(텍스트). 허용된 폴더 안에서만.',
      parameters: { type: 'object', properties: { path: { type: 'string', description: '파일 경로' } }, required: ['path'] } },
    { name: 'write_file', description: '파일을 만들거나 내용을 쓴다(덮어씀). 허용된 폴더 안에서만. 폴더가 허용 안 됐으면 결과의 needGrant 경로를 사용자에게 알리고 허용을 구해.',
      parameters: { type: 'object', properties: { path: { type: 'string', description: '파일 경로' }, content: { type: 'string', description: '쓸 내용' } }, required: ['path', 'content'] } },
    { name: 'make_dir', description: '폴더를 만든다. 허용된 폴더 안에서만.',
      parameters: { type: 'object', properties: { dir: { type: 'string', description: '만들 폴더 경로' } }, required: ['dir'] } },
    { name: 'search_files', description: '폴더 하위에서 이름에 키워드가 든 파일을 찾는다. 허용된 폴더 안에서만.',
      parameters: { type: 'object', properties: { dir: { type: 'string', description: '검색 시작 폴더' }, query: { type: 'string', description: '파일명 키워드(빈 값이면 전체)' } }, required: ['dir'] } },
    { name: 'send_file', description: '허용된 폴더 안의 파일을 사용자에게 채팅으로 보낸다(전달). 사용자가 "그 파일 줘/보내줘"라고 하거나, 네가 만든 결과 파일을 건넬 때 호출. path=보낼 파일 경로, note=함께 전할 짧은 설명(선택).',
      parameters: { type: 'object', properties: { path: { type: 'string', description: '보낼 파일 경로(허용폴더 안)' }, note: { type: 'string', description: '함께 보낼 설명(선택)' } }, required: ['path'] } },
    { name: 'grant_dir', description: '특정 폴더에 대한 파일 접근을 허용 목록에 추가한다. ⚠️ 사용자가 그 폴더 접근을 명시적으로 허용했을 때만 호출(예: "바탕화면 허용해"·"응 그 폴더 써도 돼"). 한 번 허용하면 그 폴더는 다시 묻지 않는다.',
      parameters: { type: 'object', properties: { path: { type: 'string', description: '허용할 폴더 경로' } }, required: ['path'] } },
    // ── 셸/터미널(공통층) — 허용폴더를 작업위치로, 파괴적 명령 차단. ──
    { name: 'run_shell', description: '터미널/셸 명령을 실행한다(허용된 폴더를 작업위치로). 파괴적·위험 명령은 자동 차단됨. 이 컴퓨터 OS에 맞는 명령을 써. 셸 사용이 아직 허용 안 됐으면 결과 안내대로 사용자 허락을 구해.',
      parameters: { type: 'object', properties: { command: { type: 'string', description: '실행할 명령' }, cwd: { type: 'string', description: '작업 폴더(생략 시 허용폴더 기본)' } }, required: ['command'] } },
    { name: 'grant_shell', description: '터미널 명령 실행을 허용한다. ⚠️ 사용자가 명시적으로 허용했을 때만 호출(예: "명령 실행 허용해"). 한 번 허용하면 다시 묻지 않는다(파괴적 명령은 여전히 차단).',
      parameters: { type: 'object', properties: {}, required: [] } },
    { name: 'run_code', description: '코드를 작성해 실행한다(python/node/bash). 긴 코드나 따옴표가 많은 코드엔 run_shell보다 편하다. 허용 폴더에서 실행하고 stdout을 돌려준다. 셸/코드 실행 허용(grant_shell)이 필요.',
      parameters: { type: 'object', properties: { language: { type: 'string', description: 'python | node | bash' }, code: { type: 'string', description: '실행할 코드 전체' }, cwd: { type: 'string', description: '작업 폴더(생략 시 허용폴더 기본)' } }, required: ['language', 'code'] } },
    { name: 'web_search', description: '인터넷을 검색해 관련 페이지(제목·링크·요약)를 찾는다. 실시간 정보·최신 사실·모르는 것을 알아볼 때 적극 사용. 결과의 링크는 fetch_url로 더 자세히 읽을 수 있어. (읽기 전용, 승인 불필요)',
      parameters: { type: 'object', properties: { query: { type: 'string', description: '검색어' }, max: { type: 'number', description: '결과 개수(기본 5, 최대 10)' } }, required: ['query'] } },
    // ── 자율 백그라운드(정기 실행) — 사용자가 "매일/매시/N분마다/예약" 작업을 요청할 때. PC 켜진 동안 실행. ──
    { name: 'schedule_task', description: '특정 시각 한 번(리마인더) 또는 반복(매일/매시/N분마다) 자동 실행할 일을 등록한다. "11시 41분에 알려줘"·"내일 3시에 리마인드"는 kind=once, "매일 9시 뉴스"는 daily. PC가 켜져 있는 동안 그 시각에 실행돼 결과를 전한다. 실제로 등록됐을 때만(scheduled:true) "예약했다"고 답해 — 지어내지 마.',
      parameters: { type: 'object', properties: {
        title: { type: 'string', description: '짧은 이름(예: 이메일 알림)' },
        kind: { type: 'string', enum: ['once', 'daily', 'hourly', 'interval'], description: 'once=특정 시각에 한 번(리마인더), daily=매일 특정시각, hourly=매시 정각, interval=N분마다' },
        at: { type: 'string', description: 'once/daily일 때 HH:MM (예: 11:41). once는 오늘 그 시각(이미 지났으면 내일).' },
        everyMin: { type: 'number', description: 'interval일 때 분 간격(예: 30)' },
        prompt: { type: 'string', description: '그 시각에 너 자신에게 줄 지시(예: "오늘 주요 뉴스 5개를 한국어로 요약해줘")' },
        channel: { type: 'string', enum: ['telegram', 'app', 'cli'], description: '결과를 보낼 곳. 사용자가 정한 대로 채워(예: "텔레그램으로 보내줘"→telegram). 사용자가 안 정했으면 등록 전에 "결과를 어디로 받으실래요?(텔레그램/여기)"라고 물어보고 채워.' },
      }, required: ['title', 'kind', 'prompt'] } },
    { name: 'list_schedules', description: '등록된 정기 작업 목록을 본다.', parameters: { type: 'object', properties: {}, required: [] } },
    { name: 'cancel_schedule', description: '등록된 정기 작업을 취소한다. id 또는 제목으로.', parameters: { type: 'object', properties: { id: { type: 'string', description: '취소할 작업 id 또는 제목' } }, required: ['id'] } },
    // ── 자가학습 — 잘 해낸 방법·절차를 스킬로 저장해 다음에 재사용. ──
    { name: 'create_skill', description: '재사용 가능한 방법·절차를 "스킬"로 저장한다(자가학습). 어려운 작업을 성공적으로 해냈고 앞으로 또 쓸 것 같을 때, 또는 사용자가 "이 방법 기억해둬/스킬로 만들어"라고 할 때 호출. 다음엔 find_skill→use_skill로 펼쳐 빠르게 처리. 사소하거나 한 번뿐인 일은 만들지 마.',
      parameters: { type: 'object', properties: {
        name: { type: 'string', description: '스킬 이름(짧게, 예: "PDF 여러 개 합치기")' },
        description: { type: 'string', description: '언제 쓰는 스킬인지 한 줄' },
        body: { type: 'string', description: '방법·절차를 단계별로 자세히 — 다음에 이대로 따라 하면 되게.' },
      }, required: ['name', 'body'] } },
    { name: 'set_heartbeat', description: '"먼저 안부 묻기(하트비트)" 설정을 바꾼다. 하트비트는 아침·저녁 하루 2번 네가 먼저 다정하게 안부를 건네는 기능이야. 사용자가 "먼저 말 걸지 마/그만"→enabled=false, "다시 챙겨줘/먼저 말 걸어줘"→enabled=true, "아침 인사 8시로"→morning, "저녁 인사 6시로"→evening 으로 바꿔달라 할 때 호출.',
      parameters: { type: 'object', properties: {
        enabled: { type: 'boolean', description: '켜기(true)/끄기(false)' },
        morning: { type: 'string', description: '아침 인사 시각 HH:MM' },
        evening: { type: 'string', description: '저녁 인사 시각 HH:MM' },
      } } },
  );
  for (const d of mcpDecls) decls.push(d);
  return decls;
}

/** 도구 실행 함수 생성. main.js extraExecute(1239~1593)와 동일 로직, 의존은 ctx 주입. */
function makeExecute(ctx) {
  const { agentId, agent, generate, storage, brainClaude, skillsRegistry, mcpManager } = ctx;
  const mcpRoutes = ctx.mcpRoutes || new Map();
  const extraDecls = Array.isArray(ctx.extraDecls) ? ctx.extraDecls : null; // 같은 턴 새 도구 주입용(가변 참조)
  const offSkills = ctx.offSkills || new Set();
  const pendingMcp = ctx.pendingMcp || new Map();
  const emit = ctx.emit || (() => {});
  const onRemembered = ctx.onRemembered || (() => {});
  const deliverFile = ctx.deliverFile || null; // 채널별 파일 전달 콜백(send_file 도구용) — 없으면 이 채널은 전송 미지원

  return async (n, args) => {
    if (n === 'start_project') {
      const title = String(args.title || '').trim();
      const goal = String(args.goal || '').trim();
      if (!title) return { error: 'title이 필요해' };
      const fresh = storage.loadAgent(agentId);
      if (!fresh) return { error: '에이전트 없음' };
      if (!fresh.work) fresh.work = { activeId: null, projects: [], routines: [] };
      const id = `proj-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
      const now = new Date().toISOString();
      fresh.work.projects.push({ id, type: 'project', title, goal, status: 'active', createdAt: now, updatedAt: now, steps: [], artifacts: [], log: [], contextDigest: '' });
      fresh.work.activeId = id;
      storage.saveAgent(fresh);
      if (agent) agent.work = fresh.work;
      emit('work:updated', { agentId, work: fresh.work });
      return { started: true, id, message: `프로젝트 '${title}'를 시작했어. 이제 이 작업에 집중할게.` };
    }
    if (n === 'start_routine') {
      const title = String(args.title || '').trim();
      const rhythm = String(args.rhythm || '').trim();
      if (!title) return { error: 'title이 필요해' };
      const fresh = storage.loadAgent(agentId);
      if (!fresh) return { error: '에이전트 없음' };
      if (!fresh.work) fresh.work = { activeId: null, projects: [], routines: [] };
      const id = `rt-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
      const now = new Date().toISOString();
      const routine = { id, type: 'routine', title, procedure: '', procedureSkillId: null, rhythm: rhythm || '', recent: [], rollup: '', runCount: 0, createdAt: now, updatedAt: now };
      fresh.work.routines.push(routine);
      fresh.work.activeId = id;
      storage.saveAgent(fresh);
      if (agent) agent.work = fresh.work;
      if (rhythm) {
        const rhythmFact = brainClaude.promoteRoutineRhythm(routine);
        if (rhythmFact) {
          const fa = storage.loadAgent(agentId);
          if (fa) { brainClaude.ensureMemoryShape(fa.humanFacts || []); const { merged } = brainClaude.integrateMemory(fa.humanFacts || [], [rhythmFact], {}); fa.humanFacts = merged; storage.saveAgent(fa); emit('facts:updated', { agentId, humanFacts: merged }); }
        }
      }
      emit('work:updated', { agentId, work: fresh.work });
      return { started: true, id, message: `루틴 '${title}'을 등록했어. 매번 이 루틴으로 기억하고 도와줄게.` };
    }
    if (n === 'switch_work') {
      const id = String(args.id || '').trim();
      if (!id) return { error: 'id가 필요해' };
      const fresh = storage.loadAgent(agentId);
      if (!fresh) return { error: '에이전트 없음' };
      if (!fresh.work) fresh.work = { activeId: null, projects: [], routines: [] };
      const proj = fresh.work.projects.find(p => p.id === id);
      const rout = fresh.work.routines.find(r => r.id === id);
      if (!proj && !rout) return { error: `id '${id}' 를 찾을 수 없어` };
      fresh.work.activeId = id;
      storage.saveAgent(fresh);
      if (agent) agent.work = fresh.work;
      emit('work:updated', { agentId, work: fresh.work });
      return { switched: true, id, message: `'${proj ? proj.title : rout.title}'으로 전환했어. 이제 이 작업에 집중할게.` };
    }
    if (n === 'close_project') {
      const id = String(args.id || '').trim();
      if (!id) return { error: 'id가 필요해' };
      const fresh = storage.loadAgent(agentId);
      if (!fresh) return { error: '에이전트 없음' };
      if (!fresh.work) fresh.work = { activeId: null, projects: [], routines: [] };
      const proj = fresh.work.projects.find(p => p.id === id);
      if (!proj) return { error: `프로젝트 id '${id}' 없음` };
      proj.status = 'archived';
      proj.closedAt = new Date().toISOString();
      brainClaude.ensureMemoryShape(fresh.humanFacts || []);
      for (const f of (fresh.humanFacts || [])) { if (f.scope === `project:${id}`) f._workArchived = true; }
      if (fresh.work.activeId === id) fresh.work.activeId = null;
      storage.saveAgent(fresh);
      if (agent) agent.work = fresh.work;
      emit('work:updated', { agentId, work: fresh.work });
      setImmediate(async () => {
        try {
          const relFact = await brainClaude.promoteProjectToRelationship(proj, generate);
          if (relFact) { const fa = storage.loadAgent(agentId); if (fa) { brainClaude.ensureMemoryShape(fa.humanFacts || []); const { merged } = brainClaude.integrateMemory(fa.humanFacts || [], [relFact], {}); fa.humanFacts = merged; storage.saveAgent(fa); emit('facts:updated', { agentId, humanFacts: merged }); } }
        } catch (_) {}
      });
      return { closed: true, id, title: proj.title, message: `프로젝트 '${proj.title}'를 완료했어. 함께한 기억은 요약해서 간직할게.` };
    }
    if (n === 'remember') {
      const label = String(args.label || '').trim();
      const value = String(args.value || '').trim();
      if (!label || !value) return { error: 'label과 value가 필요해' };
      const imp = Math.max(1, Math.min(3, Number(args.importance) || 1));
      const fresh = storage.loadAgent(agentId);
      if (!fresh) return { error: '저장 실패' };
      brainClaude.ensureMemoryShape(fresh.humanFacts || []);
      const fact = { label, value, importance: imp, ts: new Date().toISOString(), source: 'remember' };
      const activeId = agent && agent.work && agent.work.activeId;
      if (activeId) { const wt = activeId.startsWith('rt-') ? 'routine' : 'project'; fact.scope = `${wt}:${activeId}`; }
      const { merged, added, updated, mergedCount } = brainClaude.integrateMemory(fresh.humanFacts || [], [fact], {});
      if (added > 0 || updated > 0 || mergedCount > 0) {
        fresh.humanFacts = merged; storage.saveAgent(fresh); onRemembered();
        emit('facts:updated', { agentId, humanFacts: merged });
        return { saved: true, message: `'${label}' 기억함. 다시 저장하지 마.` };
      }
      return { saved: false, message: '이미 알고 있는 내용이야.' };
    }
    if (n === 'forget') {
      const query = String(args.query || '').trim();
      if (!query) return { error: '무엇을 잊을지 알려줘' };
      const fresh = storage.loadAgent(agentId);
      if (!fresh) return { error: '저장 실패' };
      const facts = fresh.humanFacts || [];
      const q = query.toLowerCase().trim();
      const STOP = new Set(['기억', '내', '나', '그거', '그건', '그것', '방금', '관련', '부분', '정보', '것', '거', '얘기', '이야기']);
      const qWords = q.split(/[\s,.]+/).filter(w => w.length >= 2 && !STOP.has(w));
      const matchFact = (f) => {
        const label = String(f.label || '').toLowerCase();
        const value = String(f.value || '').toLowerCase();
        if (!label && !value) return false;
        if (label && (label.includes(q) || q.includes(label))) return true;
        if (value && value.includes(q)) return true;
        return qWords.some(w => label.includes(w) || value.includes(w));
      };
      const matches = facts.filter(matchFact);
      if (matches.length === 0) return { forgotten: false, message: `'${query}'에 해당하는 기억이 없어.` };
      if (matches.length > 5) return { forgotten: false, tooMany: true, message: `'${query}' 관련 기억이 ${matches.length}개나 돼. 더 구체적으로 알려줄래?`, candidates: matches.map(m => m.label) };
      const kept = facts.filter(f => !matches.includes(f));
      fresh.humanFacts = kept; storage.saveAgent(fresh); onRemembered();
      emit('facts:updated', { agentId, humanFacts: kept });
      return { forgotten: true, count: matches.length, items: matches.map(m => `${m.label}: ${m.value}`), message: `${matches.length}개 기억을 지웠어: ${matches.map(m => m.label).join(', ')}` };
    }
    if (n === 'find_mcp') {
      const reg = await mcpManager.searchRegistry(args.need || ''); // 3b: 공식 npm 레지스트리(@modelcontextprotocol/*)도 검색
      const candidates = mcpManager.searchCatalog(args.need || '').concat(reg);
      return { candidates };
    }
    if (n === 'install_mcp') {
      const entry = matchByIdOrName(mcpManager.loadCatalog().servers || [], 'id', 'name', args.id);
      let r, installedName;
      if (entry) {
        const params = args.params || {};
        const missing = (entry.params || []).filter(p => p.required && !String(params[p.key] || '').trim());
        if (missing.length) return { needParams: missing, message: `설치 전에 사용자에게 다음을 물어봐: ${missing.map(p => p.label).join(', ')}` };
        r = mcpManager.addFromCatalog(agentId, entry.id, params);
        installedName = entry.name;
      } else if (mcpManager.isTrustedPackage(args.id)) {
        // 3b: 신뢰 레지스트리(공식 npm) 패키지 설치. 설정 필요 서버는 addFromCatalog가 needParams로 요구.
        r = mcpManager.addFromCatalog(agentId, args.id, args.params || {});
        installedName = args.id;
      } else {
        return { error: '카탈로그에도 신뢰 레지스트리에도 없는 MCP: ' + args.id + ' (신뢰 출처만 설치 가능)' };
      }
      if (r && r.needParams) return { needParams: r.needParams, message: `설치 전에 사용자에게 다음을 물어봐: ${r.needParams.map(p => p.label).join(', ')}` };
      if (!r || r.error) return { error: (r && r.error) || '설치 실패' };
      // 같은 턴에 바로 쓸 수 있게: 서버 연결 + 새 도구의 decl/route를 가변 참조에 주입.
      // 동시에 "실제로 연결됐는지"를 확인 — 설정 필요 서버가 조용히 안 되는데 "완료"라 거짓 보고하지 않게.
      let connected = false;
      try {
        const m = await mcpManager.collectTools(agentId);
        for (const [fn, rt] of m.routes) { if (rt.id === r.id) connected = true; if (!mcpRoutes.has(fn)) mcpRoutes.set(fn, rt); }
        if (extraDecls) {
          const have = new Set(extraDecls.map(d => d.name));
          for (const d of m.decls) if (!have.has(d.name)) extraDecls.push(d);
        }
      } catch (_) {}
      return connected
        ? { installed: true, connected: true, name: installedName, message: `'${installedName}' 설치 완료. 이제 바로 쓸 수 있어 — 이어서 요청한 작업을 진행해. 다시 설치하거나 다시 묻지 마.` }
        : { installed: true, connected: false, needsSetup: true, name: installedName, message: `'${installedName}' 등록은 됐는데 지금 바로 연결이 안 됐어. 추가 설정(폴더 경로·토큰 등)이 필요하거나 이 PC에 npx/node 준비가 필요할 수 있어. 뭐가 필요한지 사용자에게 물어보거나 설정 없이 되는 대안을 제안해 — "됐다"고 단정하지 마.` };
    }
    // ── 파일 전달(공통층) — 허용폴더 안의 파일을 채널별 deliver 로 사용자에게 보냄 ──
    if (n === 'send_file') {
      const allowed = (agent && agent.allowedDirs) || [];
      if (!fsTools.isAllowed(allowed, args.path)) return { error: '허용된 폴더 안의 파일만 보낼 수 있어. 그 폴더를 먼저 허용해줘.', needGrant: fsTools._norm(args.path) };
      const full = fsTools._norm(args.path);
      if (!fs.existsSync(full)) return { error: `보낼 파일이 없어: ${args.path}` };
      if (!deliverFile) return { error: '지금 이 창구에서는 파일 전송을 지원하지 않아.' };
      try {
        const out = await deliverFile({ path: full, name: path.basename(full), note: String(args.note || '') });
        if (out && out.error) return { error: out.error };
        return { sent: true, message: `"${path.basename(full)}" 파일을 보냈어.` };
      } catch (e) { return { error: '파일 전송 실패: ' + e.message }; }
    }
    // ── 파일 도구(공통층, fs-tools 코어 호출) — allowedDirs 안에서만 ──
    if (n === 'list_files' || n === 'read_file' || n === 'write_file' || n === 'make_dir' || n === 'search_files') {
      const exec = (allowed) => {
        if (n === 'list_files') return fsTools.listFiles(allowed, args.dir);
        if (n === 'read_file') return fsTools.readFile(allowed, args.path);
        if (n === 'write_file') return fsTools.writeFile(allowed, args.path, args.content);
        if (n === 'make_dir') return fsTools.makeDir(allowed, args.dir);
        return fsTools.searchFiles(allowed, args.dir, args.query);
      };
      let r = exec((agent && agent.allowedDirs) || []);
      // 자율도 autonomous("알아서 해")면 폴더 미허용이어도 자동 허용 후 1회 재시도 — 셸과 동일하게 안 묻는다.
      if (r && r.needGrant && agent && agent.trustLevel === 'autonomous') {
        const fresh = storage.loadAgent(agentId);
        if (fresh) {
          fresh.allowedDirs = fresh.allowedDirs || [];
          if (!fresh.allowedDirs.some(d => fsTools._norm(d) === fsTools._norm(r.needGrant))) fresh.allowedDirs.push(r.needGrant);
          storage.saveAgent(fresh);
          if (agent) agent.allowedDirs = fresh.allowedDirs;
          r = exec(fresh.allowedDirs);
        }
      }
      if (r && r.needGrant) r.message = `'${r.needGrant}' 폴더는 아직 접근이 허용되지 않았어. 사용자에게 "이 폴더에 접근해도 될까요?"라고 물어보고, 허락하면 grant_dir로 허용한 뒤 다시 시도해.`;
      return r;
    }
    if (n === 'grant_dir') {
      const dir = String(args.path || '').trim();
      if (!dir) return { error: '허용할 폴더 경로가 필요해' };
      const norm = fsTools._norm(dir);
      // 존재하지도 않고 부모 폴더도 없는 경로(두뇌가 'C:\Users\User\...'처럼 잘못 지어낸 가짜 경로)는 등록 거부.
      if (!fsTools.pathOrParentExists(norm)) {
        return { error: `'${norm}' 경로가 실제로 없어서 허용할 수 없어. 폴더 위치를 정확히 알려줘 — 예: 바탕화면이면 "바탕화면/폴더명"처럼.` };
      }
      const fresh = storage.loadAgent(agentId);
      if (!fresh) return { error: '저장 실패' };
      fresh.allowedDirs = fresh.allowedDirs || [];
      if (!fresh.allowedDirs.some(d => fsTools._norm(d) === norm)) fresh.allowedDirs.push(norm);
      storage.saveAgent(fresh);
      if (agent) agent.allowedDirs = fresh.allowedDirs; // 같은 턴 재시도에 즉시 반영
      return { granted: true, dir: norm, message: `'${norm}' 폴더 접근을 허용했어. 이제 이 폴더 안에서 파일 작업을 할 수 있어. (이 폴더는 앞으로 다시 안 물어봐.) 하려던 작업이 있으면 이어서 해.` };
    }
    if (n === 'run_shell') {
      const auto = agent && agent.trustLevel === 'autonomous';
      if (!(agent && agent.allowShell) && !auto) {
        return { needGrantShell: true, message: '터미널 명령 실행은 아직 허용되지 않았어. 사용자에게 "터미널 명령 실행을 허용할까요?"라고 묻고, 허락하면 grant_shell로 허용한 뒤 다시 시도해.' };
      }
      return procTools.runShell((agent && agent.allowedDirs) || [], args.command, args.cwd);
    }
    if (n === 'grant_shell') {
      const fresh = storage.loadAgent(agentId);
      if (!fresh) return { error: '저장 실패' };
      fresh.allowShell = true; storage.saveAgent(fresh);
      if (agent) agent.allowShell = true; // 같은 턴 재시도 반영
      return { granted: true, message: '터미널 명령 실행을 허용했어. (파괴적·위험 명령은 여전히 차단돼.) 하려던 작업이 있으면 이어서 해.' };
    }
    if (n === 'run_code') {
      const auto = agent && agent.trustLevel === 'autonomous';
      if (!(agent && agent.allowShell) && !auto) {
        return { needGrantShell: true, message: '코드 실행은 아직 허용되지 않았어. 사용자에게 "코드/명령 실행을 허용할까요?"라고 묻고, 허락하면 grant_shell로 허용한 뒤 다시 시도해.' };
      }
      return procTools.runCode((agent && agent.allowedDirs) || [], args.language, args.code, args.cwd);
    }
    if (n === 'web_search') {
      const sk = (agent && agent.search) || {}; // {provider, naver:{clientId,clientSecret}, tavily:{apiKey}}
      return await webSearchTool.webSearch(args.query, { max: args.max, provider: sk.provider, naver: sk.naver, tavily: sk.tavily });
    }
    if (n === 'schedule_task') {
      const s = scheduler.createSchedule(args);
      if (!s.title || !s.prompt) return { error: 'title과 prompt가 필요해' };
      const fresh = storage.loadAgent(agentId);
      if (!fresh) return { error: '저장 실패' };
      fresh.schedules = fresh.schedules || [];
      fresh.schedules.push(s); storage.saveAgent(fresh);
      if (agent) agent.schedules = fresh.schedules;
      return { scheduled: true, id: s.id, message: `'${s.title}' 예약 완료 — ${scheduler.describe(s)}. PC가 켜져 있을 때 실행돼서 결과를 보낼게.` };
    }
    if (n === 'list_schedules') {
      const fresh = storage.loadAgent(agentId) || {};
      const list = (fresh.schedules || []).filter(s => s.enabled !== false).map(s => ({ id: s.id, title: s.title, when: scheduler.describe(s), channel: s.channel }));
      return { schedules: list };
    }
    if (n === 'create_skill') {
      const r = skillsRegistry.saveSkill(agentId, { name: args.name, description: args.description, body: args.body, source: 'auto' });
      return (r && !r.error)
        ? { created: true, id: r.id, message: `'${args.name}' 방법을 스킬로 저장해뒀어. 다음에 비슷한 일에 써먹을게.` }
        : { error: (r && r.error) || '스킬 저장 실패' };
    }
    if (n === 'set_heartbeat') {
      const fresh = storage.loadAgent(agentId);
      if (!fresh) return { error: '저장 실패' };
      const hb = Object.assign({ enabled: true, morning: '09:30', evening: '19:00', channel: 'telegram' }, fresh.heartbeat || {});
      if (typeof args.enabled === 'boolean') hb.enabled = args.enabled;
      if (/^\d{1,2}:\d{2}$/.test(args.morning || '')) hb.morning = args.morning;
      if (/^\d{1,2}:\d{2}$/.test(args.evening || '')) hb.evening = args.evening;
      fresh.heartbeat = hb; storage.saveAgent(fresh);
      if (agent) agent.heartbeat = hb;
      return { ok: true, heartbeat: { enabled: hb.enabled, morning: hb.morning, evening: hb.evening },
        message: hb.enabled ? `먼저 안부 묻기 켜둘게 — 아침 ${hb.morning}, 저녁 ${hb.evening}에 챙길게.` : '먼저 안부 묻기 끌게. 필요하면 다시 "먼저 챙겨줘"라고 해.' };
    }
    if (n === 'cancel_schedule') {
      const key = String(args.id || '').trim();
      const fresh = storage.loadAgent(agentId);
      if (!fresh) return { error: '저장 실패' };
      // 자연어로도 찾게(유연 매칭). 여러 개면 되묻고, 정확히 하나면 취소.
      const hits = scheduler.matchSchedules(fresh.schedules || [], key);
      if (!hits.length) {
        const open = (fresh.schedules || []).filter(s => s.enabled !== false);
        return { canceled: false, message: open.length ? `'${key}'에 해당하는 예약을 못 찾았어. 지금 예약: ${open.map(s => s.title).join(', ')}. 어느 걸 취소할까?` : '취소할 예약이 없어.' };
      }
      if (hits.length > 1) {
        return { canceled: false, tooMany: true, candidates: hits.map(s => s.title), message: `여러 개가 걸려: ${hits.map(s => s.title).join(', ')}. 어느 걸 취소할까?` };
      }
      const target = hits[0];
      fresh.schedules = (fresh.schedules || []).filter(s => s.id !== target.id);
      storage.saveAgent(fresh); if (agent) agent.schedules = fresh.schedules;
      return { canceled: true, title: target.title, message: `'${target.title}' 예약을 취소했어.` };
    }
    if (n === 'set_trust') {
      const level = ['ask_all', 'ask_risky', 'autonomous'].includes(args.level) ? args.level : null;
      if (!level) return { error: 'level은 ask_all/ask_risky/autonomous 중 하나여야 해' };
      const fresh = storage.loadAgent(agentId);
      if (!fresh) return { error: '저장 실패' };
      fresh.trustLevel = level; storage.saveAgent(fresh);
      if (agent) agent.trustLevel = level; // 같은 턴 게이트에 즉시 반영
      const label = { ask_all: '모든 변경 작업을 매번 확인', ask_risky: '위험한 작업만 확인(기본)', autonomous: '확인 없이 알아서 진행' }[level];
      return { ok: true, level, message: `알겠어 — 이제부터 '${label}'로 할게. (언제든 다시 바꿔달라고 하면 돼.) 사용자에게 짧게 확인해주고, 하던 작업이 있으면 이어서 진행해.` };
    }
    if (n.startsWith('mcp__')) {
      const route = mcpRoutes.get(n);
      // 자율도(trustLevel): autonomous=묻지않음 / ask_all=모든 변경에 확인 / ask_risky(기본)=위험 도구만 확인.
      const trust = (agent && agent.trustLevel) || 'ask_risky';
      const needApproval = !!route && trust !== 'autonomous'
        && (trust === 'ask_all' || route.risky)
        && !mcpManager.isAutoApproved(agentId, route.id);
      if (needApproval) {
        pendingMcp.set(agentId, { fn: n, args: args || {}, server: route.server, tool: route.tool, serverId: route.id });
        return { status: 'awaiting_approval', message: `'${route.server}'의 '${route.tool}'은(는) 쓰기·삭제·전송 등 실제 변경을 일으킬 수 있어. 지금 실행하지 마. 사용자에게 "이 작업을 실행할까요? '승인'이라고 답해주세요"라고 안내하고, 한 줄 덧붙여 — "이런 걸 매번 안 묻게 하려면 '앞으론 알아서 해'라고 말씀해 주세요"라고 알려줘.` };
      }
      const r = await mcpManager.callTool(n, args, mcpRoutes);
      return r || { error: 'MCP 도구를 찾을 수 없음: ' + n };
    }
    if (n === 'use_skill') {
      const hit = skillsRegistry.list(agentId).find(s => (s.id === args.name || s.name === args.name) && !offSkills.has(s.id));
      if (!hit) return { error: '그런 스킬 없음(또는 이 에이전트에서 꺼짐): ' + args.name };
      return skillsRegistry.getBody(agentId, hit.id);
    }
    if (n === 'find_skill') {
      await skillsRegistry.refreshLiveCatalog(); // 3a: 최신 anthropics/skills 반영(TTL 캐시)
      const candidates = skillsRegistry.searchCatalog(args.need || '');
      return { candidates };
    }
    if (n === 'install_skill') {
      // 정적 카탈로그 + 라이브 신규 모두 installFromCatalog 가 검증(라이브 id 직접 허용). 여기서 정적만 걸러 막지 않는다.
      const r = await skillsRegistry.installFromCatalog(agentId, args.id);
      return (r && r.installed)
        ? { installed: true, name: r.name || args.id, message: `'${r.name || args.id}' 스킬 설치 완료. 다시 설치하거나 다시 묻지 마.` }
        : { error: (r && r.error) || '설치 실패' };
    }
    if (n === 'install_skill_web') {
      // 3c: 공개 웹(GitHub SKILL.md) 설치 — 호스트 한정 + 패턴스캔 + AI 인젝션 판정(D3, generate 주입).
      const r = await skillsRegistry.installFromUrl(agentId, args.url, (t) => skillsRegistry.aiInjectionJudge(t, generate));
      return (r && r.installed)
        ? { installed: true, name: r.name, source: r.source, aiJudged: r.aiJudged, message: `'${r.name}' 스킬 설치 완료(출처: ${r.source}${r.aiJudged ? ', AI 보안검수 통과' : ''}). 다시 설치하거나 다시 묻지 마.` }
        : { error: (r && r.error) || '설치 실패', reason: r && r.reason };
    }
    if (n === 'search_memory') {
      return await memorySearch.searchMemory(agentId, args.query); // 기억 v3(B): 아카이브·일화·팩트·요약 능동 검색
    }
    if (n === 'plan_task') {
      const task = String(args.task || '').trim();
      if (!task) return { error: 'task가 필요해' };
      const autoApprove = args.autoApprove === true;
      const fresh = storage.loadAgent(agentId);
      if (!fresh) return { error: '에이전트 없음' };
      if (!fresh.work) fresh.work = { activeId: null, projects: [], routines: [] };
      const goalHint = fresh.work.activeId ? ((fresh.work.projects.find(p => p.id === fresh.work.activeId) || {}).goal || task) : task;
      const plannedSteps = await brainClaude.runPlanner(task, goalHint, generate);
      if (!autoApprove) {
        let targetProj = fresh.work.projects.find(p => p.id === (args.projectId || fresh.work.activeId));
        if (!targetProj) {
          const now = new Date().toISOString();
          const tmpId = `proj-l3-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
          targetProj = { id: tmpId, type: 'project', title: task.slice(0, 40), goal: task, status: 'active', createdAt: now, updatedAt: now, steps: [], artifacts: [], log: [], contextDigest: '' };
          fresh.work.projects.push(targetProj);
          fresh.work.activeId = tmpId;
        }
        targetProj.steps = plannedSteps.map((s, i) => ({ id: `step-${i}-${Date.now()}`, text: s.text, status: 'todo', result: null, assignee: 'self', parallelGroup: null }));
        targetProj.updatedAt = new Date().toISOString();
        storage.saveAgent(fresh);
        if (agent) agent.work = fresh.work;
        emit('work:updated', { agentId, work: fresh.work });
        const planSummary = plannedSteps.map((s, i) => `  ${i + 1}. ${s.text}`).join('\n');
        return { status: 'awaiting_approval', projectId: targetProj.id, plan: plannedSteps, message: `다음 ${plannedSteps.length}단계 계획을 세웠어:\n${planSummary}\n\n실행할까요? '승인' 또는 '진행'이라고 답해주면 바로 시작할게. 계획을 수정하고 싶으면 말해줘.` };
      }
      const onProgress = (msg) => emit('chat:stream', { agentId, delta: `\n[진행] ${msg}` });
      const planCtx = { extraDecls: ctx.extraDecls, extraExecute: null, onProgress, saveAgent: (a) => storage.saveAgent(a), projectId: args.projectId };
      try {
        const result = await brainClaude.runPlannedTask(fresh, task, generate, planCtx);
        storage.saveAgent(fresh);
        if (agent) agent.work = fresh.work;
        emit('work:updated', { agentId, work: fresh.work });
        return { done: true, projectId: result.projectId, artifact: result.artifact, stepsCount: result.steps.length };
      } catch (e) { return { error: `작업 실행 중 오류: ${e.message}` }; }
    }
    if (n === 'resume_task') {
      const projectId = String(args.projectId || '').trim();
      if (!projectId) return { error: 'projectId가 필요해' };
      const fresh = storage.loadAgent(agentId);
      if (!fresh || !fresh.work) return { error: '에이전트 없음' };
      const proj = fresh.work.projects.find(p => p.id === projectId);
      if (!proj) return { error: `프로젝트 id '${projectId}' 없음` };
      const pending = proj.steps ? proj.steps.filter(s => s.status !== 'done') : [];
      if (pending.length === 0) return { message: `프로젝트 '${proj.title}' — 모든 단계가 이미 완료됨. resume 불필요.` };
      const onProgress = (msg) => emit('chat:stream', { agentId, delta: `\n[진행] ${msg}` });
      const planCtx = { extraDecls: ctx.extraDecls, extraExecute: null, onProgress, saveAgent: (a) => storage.saveAgent(a), projectId };
      fresh.work.activeId = projectId;
      try {
        const result = await brainClaude.runPlannedTask(fresh, proj.goal || proj.title, generate, planCtx);
        storage.saveAgent(fresh);
        if (agent) agent.work = fresh.work;
        emit('work:updated', { agentId, work: fresh.work });
        return { done: true, projectId: result.projectId, artifact: result.artifact, stepsCount: result.steps.length };
      } catch (e) { return { error: `재개 중 오류: ${e.message}` }; }
    }
    return null;
  };
}

module.exports = { buildDecls, buildAvailableTools, makeExecute, matchByIdOrName };
