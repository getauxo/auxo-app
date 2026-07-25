/**
 * auxo-mcp-tools.js — Auxo 고유 도구(remember/forget …)를 MCP 서버로 노출.
 *
 * claude 구독(claude CLI)은 커스텀 함수 도구를 직접 못 받지만, MCP 서버는 표준으로 받는다.
 * → claudeGenerate 가 `--mcp-config` 로 이 서버를 띄워 claude 구독도 도구를 쓰게 한다(B 옵션).
 *
 * 호출 측(claudeGenerate)이 env 로 대상 에이전트를 지정한다:
 *   AUXO_DATA_PATH = 에이전트 데이터 폴더 (storage.init 대상)
 *   AUXO_AGENT_ID  = 도구가 다룰 에이전트 id
 *
 * 실행: node auxo-mcp-tools.js  (stdio MCP 서버)
 */
'use strict';
const path = require('path');
const fs = require('fs');
const storage = require('./storage');
const memoryTools = require('./memory-tools');
const subagents = require('./subagents');
const skillsRegistry = require('./skills-registry');
const mcpManager = require('./mcp-manager');
const fsTools = require('./fs-tools');
const procTools = require('./proc-tools');
const webSearchTool = require('./web-search');
const scheduler = require('./scheduler');
const memorySearch = require('./memory-search'); // 기억 v3(B): 과거 대화·기억 능동 검색
const brainClaude = require('./brain-claude');
const brainCodex = require('./brain-codex');

const DATA = process.env.AUXO_DATA_PATH || '';
const AGENT_ID = process.env.AUXO_AGENT_ID || '';

// 구독 두뇌(claude/codex)로 워커를 돌리기 위한 generate. 워커는 도구 없이 호출 → 깊이 1.
function pickSubGen(agent) {
  if (!agent) return null;
  if (agent.brainMode === 'claude-subscription') return (s, u, o = {}) => brainClaude.claudeGenerate(s, u, o);
  if (agent.brainMode === 'codex-subscription') return (s, u, o = {}) => brainCodex.codexGenerate(s, u, o);
  return null;
}

// delegate 도구 선언(engine 의 것과 동일 취지). MCP 서버는 턴 개념이 없어 한 호출당 5명 cap 만 적용.
const DELEGATE_DECL = {
  name: 'delegate_to_workers',
  description: '규모가 크거나 여러 갈래로 나눌 수 있는 작업을, 여러 임시 일꾼에게 나눠 동시에 처리시킨다. '
    + '각 일꾼은 독립적으로 한 부분을 맡아 결과를 돌려준다(한 번에 최대 5명, 너와 같은 두뇌). '
    + '사용자가 "각각/나눠서/동시에/여러 개를" 처리해 달라고 하면 그 항목들을 한 번에 tasks 에 담아 위임해. '
    + '일부만 위임하고 나머지는 직접 답하지 마 — 위임하기로 했으면 해당 항목 전부를 tasks 에 넣어. '
    + '일꾼은 너의 기억·도구를 쓰지 못하니 각 작업을 자세하고 독립적으로 적어줘. 결과가 오면 네가 종합해서 답해.',
  parameters: { type: 'object', properties: {
    tasks: { type: 'array', items: { type: 'string' }, description: '각 일꾼에게 맡길 작업 설명 배열(최대 5개). 각 항목은 독립적으로 처리 가능해야 함.' },
  }, required: ['tasks'] },
};

// P0-a: 구독 두뇌(claude/codex)에도 노출하는 "읽기 전용" 공통 도구.
// 검색·조회뿐이라 실제 변경이 없어 승인 게이트가 없어도 안전. (쓰기/설치는 P0-b 승인모델과 함께)
const READ_DECLS = [
  { name: 'find_mcp', description: '필요한 능력(브라우저 자동화·파일·메모리 등)의 MCP 도구를 신뢰 카탈로그에서 검색한다(읽기 전용). 설치는 사용자 승인이 필요해 별도다.',
    inputSchema: { type: 'object', properties: { need: { type: 'string', description: '필요한 능력/작업 키워드' } }, required: ['need'] } },
  { name: 'find_skill', description: '필요한 능력이 설치된 스킬에 없을 때, 신뢰 카탈로그에서 새 스킬 후보를 검색한다(읽기 전용).',
    inputSchema: { type: 'object', properties: { need: { type: 'string', description: '필요한 능력/작업 키워드' } }, required: ['need'] } },
  { name: 'use_skill', description: '이미 설치된 스킬의 전체 사용법을 펼쳐 읽는다(읽기 전용).',
    inputSchema: { type: 'object', properties: { name: { type: 'string', description: '스킬 이름 또는 id' } }, required: ['name'] } },
  { name: 'search_memory', description: '예전 대화·기억·아카이브를 검색한다(읽기 전용). 사용자가 "저번에/그때/지난주에 ~한 거", "그 식당·그거 뭐였지"처럼 지금 대화창에 없는 과거를 물으면 지어내지 말고 먼저 이걸로 찾아봐. 없으면 솔직히 "기록에 없다"고 해.',
    inputSchema: { type: 'object', properties: { query: { type: 'string', description: '찾을 핵심 키워드' } }, required: ['query'] } },
  { name: 'install_mcp', description: 'MCP 도구(서버)를 설치한다. find_mcp 후보의 id로. 필요한 입력(params, 예: 폴더 경로)이 있으면 함께. 사용자에게 확인받은 뒤 호출.',
    inputSchema: { type: 'object', properties: { id: { type: 'string' }, params: { type: 'object' } }, required: ['id'] } },
  { name: 'install_skill', description: '스킬을 설치한다. find_skill 후보의 id로. 사용자 확인 후.',
    inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] } },
  { name: 'install_skill_web', description: '카탈로그·레지스트리에도 없을 때, 웹에서 찾은 공개 스킬(GitHub SKILL.md 링크)을 설치한다. web_search로 찾은 출처(URL)를 사용자에게 보여주고 승인받은 뒤 호출. 보안 검수(패턴+AI 판정) 통과해야 설치되고 위험하면 자동 차단. GitHub raw/blob 링크만.',
    inputSchema: { type: 'object', properties: { url: { type: 'string' } }, required: ['url'] } },
  { name: 'web_search', description: '인터넷을 검색해 관련 페이지(제목·링크·요약)를 찾는다(읽기 전용). 실시간 정보·최신 사실을 알아볼 때.',
    inputSchema: { type: 'object', properties: { query: { type: 'string' }, max: { type: 'number' } }, required: ['query'] } },
  { name: 'schedule_task', description: '특정 시각 한 번(리마인더, kind=once) 또는 반복(매일/매시/N분마다) 자동 실행할 일을 등록한다. "11시 41분에 알려줘"는 once, at="11:41". PC 켜진 동안 실행돼 결과를 전한다. 실제 등록됐을 때만(scheduled:true) "예약했다"고 답해 — 지어내지 마. channel 미지정 시 앱으로.',
    inputSchema: { type: 'object', properties: { title: { type: 'string' }, kind: { type: 'string', enum: ['once', 'daily', 'hourly', 'interval'] }, at: { type: 'string', description: 'once/daily일 때 HH:MM (예: 11:41)' }, everyMin: { type: 'number' }, prompt: { type: 'string' }, channel: { type: 'string', enum: ['telegram', 'app', 'cli'] } }, required: ['title', 'kind', 'prompt'] } },
  { name: 'list_schedules', description: '등록된 정기 작업 목록을 본다.', inputSchema: { type: 'object', properties: {}, required: [] } },
  { name: 'cancel_schedule', description: '등록된 정기 작업을 취소한다(id 또는 제목).', inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] } },
  { name: 'create_skill', description: '재사용 가능한 방법·절차를 "스킬"로 저장한다(자가학습). 어려운 작업을 잘 해냈고 또 쓸 것 같을 때, 또는 사용자가 "방법 기억해둬"라고 할 때. 사소한 건 만들지 마.',
    inputSchema: { type: 'object', properties: { name: { type: 'string' }, description: { type: 'string' }, body: { type: 'string' } }, required: ['name', 'body'] } },
  { name: 'set_heartbeat', description: '"먼저 안부 묻기(하트비트)" 설정 변경(아침·저녁 하루 2번 먼저 안부). "그만"→enabled=false, "다시 챙겨줘"→true, 시간 변경=morning/evening.',
    inputSchema: { type: 'object', properties: { enabled: { type: 'boolean' }, morning: { type: 'string' }, evening: { type: 'string' } } } },
];

// 파일 도구(공통층) — REST 두뇌(agent-tools)와 같은 fs-tools 코어. allowedDirs 안에서만.
const FILE_DECLS = [
  { name: 'list_files', description: '폴더 안의 파일·하위폴더 목록을 본다. 허용된 폴더 안에서만.',
    inputSchema: { type: 'object', properties: { dir: { type: 'string' } }, required: ['dir'] } },
  { name: 'read_file', description: '파일 내용을 읽는다(텍스트). 허용된 폴더 안에서만.',
    inputSchema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } },
  { name: 'write_file', description: '파일을 만들거나 내용을 쓴다(덮어씀). 허용된 폴더 안에서만. 폴더가 허용 안 됐으면 결과의 needGrant를 사용자에게 알리고 허용을 구해.',
    inputSchema: { type: 'object', properties: { path: { type: 'string' }, content: { type: 'string' } }, required: ['path', 'content'] } },
  { name: 'make_dir', description: '폴더를 만든다. 허용된 폴더 안에서만.',
    inputSchema: { type: 'object', properties: { dir: { type: 'string' } }, required: ['dir'] } },
  { name: 'send_file', description: '허용된 폴더 안의 파일을 사용자에게 채팅으로 보낸다(전달). 사용자가 "그 파일 줘/보내줘"라고 하거나 네가 만든 결과 파일을 건넬 때 호출. 허용폴더 안 파일만. 링크·버튼을 글로 지어내지 말고 반드시 이 도구를 호출해.',
    inputSchema: { type: 'object', properties: { path: { type: 'string', description: '보낼 파일 경로(허용 폴더 안)' }, note: { type: 'string', description: '함께 전할 짧은 설명(선택)' } }, required: ['path'] } },
  { name: 'search_files', description: '폴더 하위에서 이름에 키워드가 든 파일을 찾는다. 허용된 폴더 안에서만.',
    inputSchema: { type: 'object', properties: { dir: { type: 'string' }, query: { type: 'string' } }, required: ['dir'] } },
  { name: 'grant_dir', description: '특정 폴더 접근을 허용 목록에 추가. ⚠️ 사용자가 명시적으로 허용했을 때만. 한 번 허용하면 다시 안 묻는다.',
    inputSchema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } },
  { name: 'run_shell', description: '터미널/셸 명령을 실행한다(허용된 폴더를 작업위치로). 파괴적 명령은 자동 차단. 셸 사용이 아직 허용 안 됐으면 결과 안내대로 사용자 허락을 구해.',
    inputSchema: { type: 'object', properties: { command: { type: 'string' }, cwd: { type: 'string' } }, required: ['command'] } },
  { name: 'grant_shell', description: '터미널 명령 실행을 허용한다. ⚠️ 사용자가 명시적으로 허용했을 때만. 한 번 허용하면 다시 안 묻는다(파괴적 명령은 여전히 차단).',
    inputSchema: { type: 'object', properties: {}, required: [] } },
  { name: 'run_code', description: '코드를 작성해 실행한다(python/node/bash). 긴 코드엔 run_shell보다 편하다. 허용 폴더에서 실행, stdout 반환. grant_shell 필요.',
    inputSchema: { type: 'object', properties: { language: { type: 'string' }, code: { type: 'string' }, cwd: { type: 'string' } }, required: ['language', 'code'] } },
];

// 작업기억(L2) + 자율도 — REST(agent-tools)와 동일 동작을 구독 두뇌에도 노출.
// storage(loadAgent/saveAgent)만 다루는 단순 상태변경이라 MCP 서버에서 그대로 가능. (앱 UI emit은 서버라 생략)
const WORK_DECLS = [
  { name: 'start_project', description: '새 프로젝트를 시작한다(시작과 끝이 있는 일). 사용자가 새 프로젝트를 언급하거나 "프로젝트로 진행"을 원할 때.',
    inputSchema: { type: 'object', properties: { title: { type: 'string' }, goal: { type: 'string' } }, required: ['title', 'goal'] } },
  { name: 'start_routine', description: '반복 루틴을 등록한다(끝없이 반복되는 일). 정기 반복 작업을 언급할 때.',
    inputSchema: { type: 'object', properties: { title: { type: 'string' }, rhythm: { type: 'string' } }, required: ['title'] } },
  { name: 'switch_work', description: '현재 활성 작업을 전환한다. id는 start_project/start_routine이 반환한 id.',
    inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] } },
  { name: 'close_project', description: '프로젝트를 완료 처리한다. 작업기억은 archived 보관, 관계요약 1줄을 1층 기억에 승격.',
    inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] } },
  // ★2026-07-17: L3(plan_task/resume_task) 구독두뇌 배선 — 그간 agent-tools(앱·CLI·봇)에만 있고 구독 MCP엔 빠져 있었다.
  //   큰 일을 단계로 쪼개 순차 실행 + 중단 후 이어하기. 계획은 runPlanner(LLM), 단계 저장·진행·재개는 우리 코드.
  { name: 'plan_task', description: '큰 작업을 단계별로 분해하고 순차 실행한다(L3). 여러 단계가 필요한 복잡한 작업에. 실행 전 계획을 먼저 제시하고 승인받는다.',
    inputSchema: { type: 'object', properties: { task: { type: 'string' }, projectId: { type: 'string' }, autoApprove: { type: 'boolean' } }, required: ['task'] } },
  { name: 'resume_task', description: '중단된 프로젝트의 작업을 이어서 실행한다(done 단계는 건너뜀).',
    inputSchema: { type: 'object', properties: { projectId: { type: 'string' } }, required: ['projectId'] } },
  { name: 'set_trust', description: '도구 사용 "승인 정도(자율도)"를 바꾼다. 사용자가 앞으로의 방침을 바꿔달라고 할 때만 호출 — 예: "앞으로 묻지 말고 알아서 해"·"매번 안 물어봐도 돼"·"항상 허용" → autonomous, "위험한 것만 물어봐"·"중요한 건 확인해" → ask_risky, "뭐든 일일이 물어봐"·"항상 확인받아" → ask_all. 단발성 "승인/그래"(이번 한 번만 허락)와는 구분해 — 그건 set_trust를 부르지 말고 그냥 작업해.',
    inputSchema: { type: 'object', properties: { level: { type: 'string', enum: ['ask_all', 'ask_risky', 'autonomous'], description: 'autonomous=확인 없이 진행, ask_risky=위험 작업만 확인(기본), ask_all=모든 변경 작업 확인' } }, required: ['level'] } },
];

(async () => {
  if (!DATA || !AGENT_ID) { console.error('[auxo-mcp-tools] AUXO_DATA_PATH / AUXO_AGENT_ID 필요'); process.exit(1); }
  storage.init(DATA);
  // 읽기 전용 공통도구가 쓸 스킬·MCP 카탈로그 경로(REST 두뇌의 engine 경로와 동일 규칙).
  skillsRegistry.setSkillsRoot(path.join(DATA, 'skills'));
  mcpManager.setConfigRoot(path.join(DATA, 'mcp'));

  const { Server } = await import('@modelcontextprotocol/sdk/server/index.js');
  const { StdioServerTransport } = await import('@modelcontextprotocol/sdk/server/stdio.js');
  const { ListToolsRequestSchema, CallToolRequestSchema } = await import('@modelcontextprotocol/sdk/types.js');

  const server = new Server({ name: 'auxo-tools', version: '0.1.0' }, { capabilities: { tools: {} } });

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      ...memoryTools.DECLS.map(d => ({ name: d.name, description: d.description, inputSchema: d.parameters })),
      { name: DELEGATE_DECL.name, description: DELEGATE_DECL.description, inputSchema: DELEGATE_DECL.parameters },
      ...READ_DECLS,
      ...FILE_DECLS,
      ...WORK_DECLS,
    ],
  }));

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const { name, arguments: args } = req.params;
    let r;
    if (name === 'remember') r = memoryTools.rememberFact(AGENT_ID, args || {});
    else if (name === 'forget') r = memoryTools.forgetFact(AGENT_ID, args || {});
    else if (name === 'delegate_to_workers') {
      const agent = storage.loadAgent(AGENT_ID);
      const gen = pickSubGen(agent);
      const tasks = (Array.isArray(args && args.tasks) ? args.tasks : [])
        .map(t => String(t || '').trim()).filter(Boolean).slice(0, subagents.MAX_WORKERS);
      if (!gen) r = { error: '이 AI로는 위임할 수 없어' };
      else if (!tasks.length) r = { error: '맡길 작업(tasks 배열)이 필요해' };
      else {
        // 워커는 같은 구독 두뇌로, 도구 없이 generate → 깊이 1. 한 호출 5명 cap.
        const results = await subagents.runWorkers(gen, tasks, { timeout: subagents.WORKER_TIMEOUT_MS });
        r = {
          workers: results.map(x => ({ n: x.n, task: x.task, ok: x.ok, result: x.ok ? x.result : `실패: ${x.error}` })),
          note: '각 일꾼의 결과를 종합해서 사용자에게 자연스럽게 답해. 일꾼/위임이라는 내부 용어는 굳이 노출하지 마.',
        };
      }
    }
    else if (name === 'find_mcp') { const reg = await mcpManager.searchRegistry((args && args.need) || ''); r = { candidates: mcpManager.searchCatalog((args && args.need) || '').concat(reg) }; } // 3b: 공식 npm 레지스트리도
    else if (name === 'find_skill') { await skillsRegistry.refreshLiveCatalog(); r = { candidates: skillsRegistry.searchCatalog((args && args.need) || '') }; } // 3a: 최신 카탈로그 반영
    else if (name === 'use_skill') {
      const want = String((args && args.name) || '');
      const hit = (skillsRegistry.list(AGENT_ID) || []).find(s => s.id === want || s.name === want);
      r = hit ? skillsRegistry.getBody(AGENT_ID, hit.id) : { error: '그런 스킬 없음(또는 미설치): ' + want };
    }
    else if (name === 'search_memory') {
      r = await memorySearch.searchMemory(AGENT_ID, (args && args.query) || ''); // 기억 v3(B)
    }
    else if (name === 'web_search') {
      const ag = storage.loadAgent(AGENT_ID) || {}; const sk = ag.search || {};
      r = await webSearchTool.webSearch(args && args.query, { max: args && args.max, provider: sk.provider, naver: sk.naver, tavily: sk.tavily });
    }
    else if (name === 'install_mcp') {
      const r0 = mcpManager.addFromCatalog(AGENT_ID, (args && args.id) || '', (args && args.params) || {});
      if (!r0 || r0.error) { r = { error: (r0 && r0.error) || '설치 실패', needParams: r0 && r0.needParams }; }
      else {
        // 설치 직후 실제 연결 검증 — 설정 필요 서버가 조용히 안 되는 걸 잡아 거짓 "완료" 방지.
        const v = await mcpManager.verifyInstalled(AGENT_ID, r0.id);
        r = (v && v.ok)
          ? { installed: true, connected: true, message: `'${r0.name || args.id}' 설치 완료. 바로 쓸 수 있어.` }
          : { installed: true, connected: false, needsSetup: true, message: `'${r0.name || args.id}' 등록은 됐는데 지금 바로 연결이 안 됐어(${(v && v.error) || '연결 실패'}). 이 도구는 추가 설정(폴더 경로·토큰 등)이 필요하거나 이 PC에 npx/node 준비가 필요할 수 있어. 뭐가 필요한지 사용자에게 물어보거나, 설정 없이 되는 다른 도구를 제안해. "됐다"고 단정하지 마.` };
      }
    }
    else if (name === 'install_skill') {
      const r0 = await skillsRegistry.installFromCatalog(AGENT_ID, (args && args.id) || '');
      r = (r0 && r0.installed) ? { installed: true, message: '스킬 설치 완료.' } : { error: (r0 && r0.error) || '설치 실패' };
    }
    else if (name === 'install_skill_web') {
      // 3c: 공개 웹 설치 — AI 인젝션 판정(D3)엔 이 에이전트의 구독 두뇌로 generate.
      const ag = storage.loadAgent(AGENT_ID);
      const gen = pickSubGen(ag);
      const r0 = await skillsRegistry.installFromUrl(AGENT_ID, (args && args.url) || '', gen ? (t) => skillsRegistry.aiInjectionJudge(t, gen) : null);
      r = (r0 && r0.installed)
        ? { installed: true, name: r0.name, source: r0.source, message: `'${r0.name}' 설치 완료(출처: ${r0.source}${r0.aiJudged ? ', AI 보안검수 통과' : ''}).` }
        : { error: (r0 && r0.error) || '설치 실패', reason: r0 && r0.reason };
    }
    else if (name === 'create_skill') {
      const r0 = skillsRegistry.saveSkill(AGENT_ID, { name: args && args.name, description: args && args.description, body: args && args.body, source: 'auto' });
      r = (r0 && !r0.error) ? { created: true, id: r0.id, message: `'${args && args.name}' 방법을 스킬로 저장했어.` } : { error: (r0 && r0.error) || '스킬 저장 실패' };
    }
    else if (name === 'set_heartbeat') {
      const fresh = storage.loadAgent(AGENT_ID);
      if (!fresh) r = { error: '저장 실패' };
      else {
        const a = args || {};
        const hb = Object.assign({ enabled: true, morning: '09:30', evening: '19:00', channel: 'telegram' }, fresh.heartbeat || {});
        if (typeof a.enabled === 'boolean') hb.enabled = a.enabled;
        if (/^\d{1,2}:\d{2}$/.test(a.morning || '')) hb.morning = a.morning;
        if (/^\d{1,2}:\d{2}$/.test(a.evening || '')) hb.evening = a.evening;
        fresh.heartbeat = hb; storage.saveAgent(fresh);
        r = { ok: true, heartbeat: { enabled: hb.enabled, morning: hb.morning, evening: hb.evening }, message: hb.enabled ? `먼저 안부 묻기 켜둘게 — 아침 ${hb.morning}, 저녁 ${hb.evening}.` : '먼저 안부 묻기 끌게.' };
      }
    }
    else if (name === 'schedule_task') {
      const s = scheduler.createSchedule(args);
      if (!s.title || !s.prompt) r = { error: 'title과 prompt가 필요해' };
      else { const fresh = storage.loadAgent(AGENT_ID); if (!fresh) r = { error: '저장 실패' }; else { fresh.schedules = fresh.schedules || []; fresh.schedules.push(s); storage.saveAgent(fresh); r = { scheduled: true, id: s.id, message: `'${s.title}' 예약 완료 — ${scheduler.describe(s)}.` }; } }
    }
    else if (name === 'list_schedules') {
      const fresh = storage.loadAgent(AGENT_ID) || {};
      r = { schedules: (fresh.schedules || []).filter(s => s.enabled !== false).map(s => ({ id: s.id, title: s.title, when: scheduler.describe(s), channel: s.channel })) };
    }
    else if (name === 'cancel_schedule') {
      const key = String((args && args.id) || '').trim();
      const fresh = storage.loadAgent(AGENT_ID);
      if (!fresh) r = { error: '저장 실패' };
      else {
        const hits = scheduler.matchSchedules(fresh.schedules || [], key);
        if (!hits.length) { const open = (fresh.schedules || []).filter(s => s.enabled !== false); r = { canceled: false, message: open.length ? `'${key}'에 해당하는 예약을 못 찾았어. 지금 예약: ${open.map(s => s.title).join(', ')}. 어느 걸 취소할까?` : '취소할 예약이 없어.' }; }
        else if (hits.length > 1) { r = { canceled: false, tooMany: true, candidates: hits.map(s => s.title), message: `여러 개가 걸려: ${hits.map(s => s.title).join(', ')}. 어느 걸 취소할까?` }; }
        else { const target = hits[0]; fresh.schedules = (fresh.schedules || []).filter(s => s.id !== target.id); storage.saveAgent(fresh); r = { canceled: true, title: target.title, message: `'${target.title}' 예약을 취소했어.` }; }
      }
    }
    // 사용자에게 파일 보내기 — MCP는 별도 프로세스라 채널로 직접 못 보냄.
    // 우편함(outbox-<agentId>.json)에 적재 → 호스트(engine/main)가 턴 종료 후 실제 채널로 전송.
    else if (name === 'send_file') {
      const a = args || {};
      const ag0 = storage.loadAgent(AGENT_ID) || {};
      const p = String(a.path || '').trim();
      if (!p) r = { error: '보낼 파일 경로가 필요해.' };
      else if (!fsTools.isAllowed(ag0.allowedDirs || [], p)) {
        r = { needGrant: fsTools._norm(p), message: `'${fsTools._norm(p)}'는 아직 허용 안 된 폴더의 파일이야. 사용자에게 허락을 구하고, 허락하면 grant_dir로 허용한 뒤 다시 시도해.` };
      } else {
        const full = fsTools._norm(p);
        if (!fs.existsSync(full)) r = { error: `보낼 파일이 없어: ${p}` };
        else {
          const outbox = path.join(DATA, `outbox-${AGENT_ID}.json`);
          let list = [];
          try { list = JSON.parse(fs.readFileSync(outbox, 'utf8')); } catch (_) {}
          if (!Array.isArray(list)) list = [];
          list.push({ path: full, note: String(a.note || ''), ts: Date.now() });
          try { fs.writeFileSync(outbox, JSON.stringify(list)); r = { sent: true, message: `"${path.basename(full)}" 파일을 사용자에게 보냈어.` }; }
          catch (e) { r = { error: '파일 전송 준비 실패: ' + e.message }; }
        }
      }
    }
    // 파일 도구 — REST와 동일한 fs-tools 코어. allowedDirs는 매 호출 storage에서 신선하게 로드(grant 직후 반영).
    else if (name === 'list_files' || name === 'read_file' || name === 'write_file' || name === 'make_dir' || name === 'search_files') {
      const a = args || {};
      const ag0 = storage.loadAgent(AGENT_ID) || {};
      const exec = (allowed) => {
        if (name === 'list_files') return fsTools.listFiles(allowed, a.dir);
        if (name === 'read_file') return fsTools.readFile(allowed, a.path);
        if (name === 'write_file') return fsTools.writeFile(allowed, a.path, a.content);
        if (name === 'make_dir') return fsTools.makeDir(allowed, a.dir);
        return fsTools.searchFiles(allowed, a.dir, a.query);
      };
      r = exec(ag0.allowedDirs || []);
      // 자율도 autonomous면 폴더 미허용이어도 자동 허용 후 1회 재시도(REST와 동일).
      if (r && r.needGrant && ag0.trustLevel === 'autonomous') {
        const fresh = storage.loadAgent(AGENT_ID);
        if (fresh) {
          fresh.allowedDirs = fresh.allowedDirs || [];
          if (!fresh.allowedDirs.some(d => fsTools._norm(d) === fsTools._norm(r.needGrant))) fresh.allowedDirs.push(r.needGrant);
          storage.saveAgent(fresh);
          r = exec(fresh.allowedDirs);
        }
      }
      if (r && r.needGrant) r.message = `'${r.needGrant}'는 아직 허용 안 된 폴더야. 사용자에게 접근 허용을 구하고, 허락하면 grant_dir로 허용한 뒤 다시 시도해.`;
    }
    else if (name === 'grant_dir') {
      const dir = String((args && args.path) || '').trim();
      const norm = dir ? fsTools._norm(dir) : '';
      if (!dir) r = { error: '허용할 폴더 경로가 필요해' };
      else if (!fsTools.pathOrParentExists(norm)) r = { error: `'${norm}' 경로가 실제로 없어서 허용할 수 없어. 폴더 위치를 정확히 알려줘 — 예: 바탕화면이면 "바탕화면/폴더명"처럼.` };
      else {
        const fresh = storage.loadAgent(AGENT_ID);
        if (!fresh) r = { error: '저장 실패' };
        else {
          fresh.allowedDirs = fresh.allowedDirs || [];
          if (!fresh.allowedDirs.some(d => fsTools._norm(d) === norm)) fresh.allowedDirs.push(norm);
          storage.saveAgent(fresh);
          r = { granted: true, dir: norm, message: `'${norm}' 폴더 접근을 허용했어. 이어서 작업을 진행해.` };
        }
      }
    }
    else if (name === 'run_shell') {
      const ag = storage.loadAgent(AGENT_ID) || {};
      if (!ag.allowShell && ag.trustLevel !== 'autonomous') {
        r = { needGrantShell: true, message: '터미널 명령 실행은 아직 허용 안 됐어. 사용자에게 허락을 구하고, 허락하면 grant_shell로 허용한 뒤 다시 시도해.' };
      } else {
        r = procTools.runShell(ag.allowedDirs || [], args && args.command, args && args.cwd);
      }
    }
    else if (name === 'grant_shell') {
      const fresh = storage.loadAgent(AGENT_ID);
      if (!fresh) r = { error: '저장 실패' };
      else { fresh.allowShell = true; storage.saveAgent(fresh); r = { granted: true, message: '터미널 명령 실행을 허용했어. (파괴적 명령은 여전히 차단.) 이어서 진행해.' }; }
    }
    else if (name === 'run_code') {
      const ag = storage.loadAgent(AGENT_ID) || {};
      if (!ag.allowShell && ag.trustLevel !== 'autonomous') {
        r = { needGrantShell: true, message: '코드 실행은 아직 허용 안 됐어. 사용자 허락 후 grant_shell로 허용하고 다시 시도해.' };
      } else {
        r = procTools.runCode(ag.allowedDirs || [], args && args.language, args && args.code, args && args.cwd);
      }
    }
    // ── 작업기억(L2) — REST(agent-tools)와 동일 로직. storage만 갱신. ──
    else if (name === 'start_project') {
      const title = String((args && args.title) || '').trim();
      const goal = String((args && args.goal) || '').trim();
      if (!title) r = { error: 'title이 필요해' };
      else {
        const fresh = storage.loadAgent(AGENT_ID);
        if (!fresh) r = { error: '에이전트 없음' };
        else {
          if (!fresh.work) fresh.work = { activeId: null, projects: [], routines: [] };
          const id = `proj-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
          const now = new Date().toISOString();
          fresh.work.projects.push({ id, type: 'project', title, goal, status: 'active', createdAt: now, updatedAt: now, steps: [], artifacts: [], log: [], contextDigest: '' });
          fresh.work.activeId = id;
          storage.saveAgent(fresh);
          r = { started: true, id, message: `프로젝트 '${title}'를 시작했어. 이제 이 작업에 집중할게.` };
        }
      }
    }
    else if (name === 'start_routine') {
      const title = String((args && args.title) || '').trim();
      const rhythm = String((args && args.rhythm) || '').trim();
      if (!title) r = { error: 'title이 필요해' };
      else {
        const fresh = storage.loadAgent(AGENT_ID);
        if (!fresh) r = { error: '에이전트 없음' };
        else {
          if (!fresh.work) fresh.work = { activeId: null, projects: [], routines: [] };
          const id = `rt-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
          const now = new Date().toISOString();
          const routine = { id, type: 'routine', title, procedure: '', procedureSkillId: null, rhythm: rhythm || '', recent: [], rollup: '', runCount: 0, createdAt: now, updatedAt: now };
          fresh.work.routines.push(routine);
          fresh.work.activeId = id;
          storage.saveAgent(fresh);
          if (rhythm) {
            try {
              const rhythmFact = brainClaude.promoteRoutineRhythm(routine);
              if (rhythmFact) {
                const fa = storage.loadAgent(AGENT_ID);
                if (fa) { brainClaude.ensureMemoryShape(fa.humanFacts || []); const { merged } = brainClaude.integrateMemory(fa.humanFacts || [], [rhythmFact], {}); fa.humanFacts = merged; storage.saveAgent(fa); }
              }
            } catch (_) {}
          }
          r = { started: true, id, message: `루틴 '${title}'을 등록했어. 매번 이 루틴으로 기억하고 도와줄게.` };
        }
      }
    }
    else if (name === 'switch_work') {
      const id = String((args && args.id) || '').trim();
      if (!id) r = { error: 'id가 필요해' };
      else {
        const fresh = storage.loadAgent(AGENT_ID);
        if (!fresh) r = { error: '에이전트 없음' };
        else {
          if (!fresh.work) fresh.work = { activeId: null, projects: [], routines: [] };
          const proj = fresh.work.projects.find(p => p.id === id);
          const rout = fresh.work.routines.find(x => x.id === id);
          if (!proj && !rout) r = { error: `id '${id}' 를 찾을 수 없어` };
          else { fresh.work.activeId = id; storage.saveAgent(fresh); r = { switched: true, id, message: `'${proj ? proj.title : rout.title}'으로 전환했어. 이제 이 작업에 집중할게.` }; }
        }
      }
    }
    else if (name === 'close_project') {
      const id = String((args && args.id) || '').trim();
      if (!id) r = { error: 'id가 필요해' };
      else {
        const fresh = storage.loadAgent(AGENT_ID);
        if (!fresh) r = { error: '에이전트 없음' };
        else if (!fresh.work) r = { error: '작업기억이 없어' };
        else {
          const proj = fresh.work.projects.find(p => p.id === id);
          if (!proj) r = { error: `프로젝트 id '${id}' 없음` };
          else {
            proj.status = 'archived';
            proj.closedAt = new Date().toISOString();
            brainClaude.ensureMemoryShape(fresh.humanFacts || []);
            for (const f of (fresh.humanFacts || [])) { if (f.scope === `project:${id}`) f._workArchived = true; }
            if (fresh.work.activeId === id) fresh.work.activeId = null;
            storage.saveAgent(fresh);
            // 관계요약 1줄을 1층 기억에 승격(두뇌 필요). 같은 구독 두뇌로 처리, 실패해도 종료는 성립.
            const gen = pickSubGen(fresh);
            if (gen) {
              try {
                const relFact = await brainClaude.promoteProjectToRelationship(proj, gen);
                if (relFact) { const fa = storage.loadAgent(AGENT_ID); if (fa) { brainClaude.ensureMemoryShape(fa.humanFacts || []); const { merged } = brainClaude.integrateMemory(fa.humanFacts || [], [relFact], {}); fa.humanFacts = merged; storage.saveAgent(fa); } }
              } catch (_) {}
            }
            r = { closed: true, id, title: proj.title, message: `프로젝트 '${proj.title}'를 완료했어. 함께한 기억은 요약해서 간직할게.` };
          }
        }
      }
    }
    // ── L3(plan_task/resume_task) — 큰 일 단계분해·순차실행·중단후재개. agent-tools 와 동일 로직. ──
    //    generate = pickSubGen(구독 두뇌). MCP는 실시간 스트리밍(emit)이 없어 onProgress 는 no-op.
    else if (name === 'plan_task') {
      const task = String((args && args.task) || '').trim();
      if (!task) r = { error: 'task가 필요해' };
      else {
        const fresh = storage.loadAgent(AGENT_ID);
        const gen = pickSubGen(fresh);
        if (!fresh) r = { error: '에이전트 없음' };
        else if (!gen) r = { error: '이 AI로는 계획 실행을 못 해' };
        else {
          if (!fresh.work) fresh.work = { activeId: null, projects: [], routines: [] };
          const autoApprove = (args && args.autoApprove) === true;
          const goalHint = fresh.work.activeId ? ((fresh.work.projects.find(p => p.id === fresh.work.activeId) || {}).goal || task) : task;
          const plannedSteps = await brainClaude.runPlanner(task, goalHint, gen);
          if (!autoApprove) {
            let targetProj = fresh.work.projects.find(p => p.id === ((args && args.projectId) || fresh.work.activeId));
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
            const planSummary = plannedSteps.map((s, i) => `  ${i + 1}. ${s.text}`).join('\n');
            r = { status: 'awaiting_approval', projectId: targetProj.id, plan: plannedSteps, message: `다음 ${plannedSteps.length}단계 계획을 세웠어:\n${planSummary}\n\n실행할까요? '승인' 또는 '진행'이라고 답해주면 바로 시작할게.` };
          } else {
            try {
              const result = await brainClaude.runPlannedTask(fresh, task, gen, { onProgress: () => {}, saveAgent: (a) => storage.saveAgent(a), projectId: (args && args.projectId) });
              storage.saveAgent(fresh);
              r = { done: true, projectId: result.projectId, artifact: result.artifact, stepsCount: result.steps.length };
            } catch (e) { r = { error: `작업 실행 중 오류: ${e.message}` }; }
          }
        }
      }
    }
    else if (name === 'resume_task') {
      const projectId = String((args && args.projectId) || '').trim();
      const fresh = storage.loadAgent(AGENT_ID);
      const gen = pickSubGen(fresh);
      if (!projectId) r = { error: 'projectId가 필요해' };
      else if (!fresh || !fresh.work) r = { error: '에이전트 없음' };
      else if (!gen) r = { error: '이 AI로는 재개를 못 해' };
      else {
        const proj = fresh.work.projects.find(p => p.id === projectId);
        if (!proj) r = { error: `프로젝트 id '${projectId}' 없음` };
        else {
          const pending = proj.steps ? proj.steps.filter(s => s.status !== 'done') : [];
          if (pending.length === 0) r = { message: `프로젝트 '${proj.title}' — 모든 단계가 이미 완료됨. resume 불필요.` };
          else {
            fresh.work.activeId = projectId;
            try {
              const result = await brainClaude.runPlannedTask(fresh, proj.goal || proj.title, gen, { onProgress: () => {}, saveAgent: (a) => storage.saveAgent(a), projectId });
              storage.saveAgent(fresh);
              r = { done: true, projectId: result.projectId, artifact: result.artifact, stepsCount: result.steps.length };
            } catch (e) { r = { error: `재개 중 오류: ${e.message}` }; }
          }
        }
      }
    }
    // ── 자율도(trustLevel) — REST와 동일. ──
    else if (name === 'set_trust') {
      const level = ['ask_all', 'ask_risky', 'autonomous'].includes(args && args.level) ? args.level : null;
      if (!level) r = { error: 'level은 ask_all/ask_risky/autonomous 중 하나여야 해' };
      else {
        const fresh = storage.loadAgent(AGENT_ID);
        if (!fresh) r = { error: '저장 실패' };
        else {
          fresh.trustLevel = level; storage.saveAgent(fresh);
          const label = { ask_all: '모든 변경 작업을 매번 확인', ask_risky: '위험한 작업만 확인(기본)', autonomous: '확인 없이 알아서 진행' }[level];
          r = { ok: true, level, message: `알겠어 — 이제부터 '${label}'로 할게. (언제든 다시 바꿔달라고 하면 돼.) 사용자에게 짧게 확인해주고, 하던 작업이 있으면 이어서 진행해.` };
        }
      }
    }
    else r = { error: 'unknown tool: ' + name };
    return { content: [{ type: 'text', text: JSON.stringify(r) }] };
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error('[auxo-mcp-tools] ready (agent=' + AGENT_ID + ')'); // stderr — stdout은 MCP 전용
})().catch(err => { console.error('[auxo-mcp-tools] fatal:', err && err.message); process.exit(1); });
