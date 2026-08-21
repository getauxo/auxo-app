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
const memoryTools = require('./memory-tools');
const toolDecls = require('./tool-decls'); // 도구 선언 원본(두뇌 공통) // remember·forget 공용 구현(한 벌만 둔다)
const userMemory = require('./user-memory');   // 그릇(통짜) 편집 — 루틴 리듬 등 직접 추가 경로
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
    availableTools.push('중요한 것 기억하기(remember — 대화 중 알게 된 사용자 사실·선호를 직접 장기기억에 저장)', '기억 지우기(forget — 사용자가 지워달라고 할 때 특정 기억을 삭제)', '옛 기억·대화 검색(search_memory — "저번에/그때/지난주에 ~한 거", "그 식당·그거 뭐였지"처럼 지금 대화창에 없는 과거를 물으면 지어내지 말고 이걸로 먼저 찾기)', '현재 날짜·시각', '정확한 계산(계산기)', 'URL/데이터 가져오기(fetch)', '새 스킬 찾기·설치(find_skill→승인→install_skill, 신뢰 출처)', '새 도구(MCP) 찾기·설치(find_mcp→승인→install_mcp, 예: 브라우저 자동화·파일·메모리. 인터넷 주소로 접속하는 원격 MCP도 url로 연결 가능)', '설치한 능력 삭제(remove_mcp·uninstall_skill — 사용자가 "그거 지워줘"라고 할 때만)', '승인 정도(자율도) 바꾸기(set_trust — 사용자가 "앞으로 묻지 말고 알아서 해/위험한 것만 물어봐/뭐든 확인해"라고 하면)', '파일 다루기(list_files·read_file·write_file·make_dir·move_file·search_files — 허용된 폴더 안에서만, 새 폴더는 사용자 허락 후에만·허락은 사용자만. **이름 바꾸기·옮기기는 move_file 이다 — 셸로 하지 마라**)', '사용자에게 파일 보내기(send_file — 만들었거나 가진 파일을 채팅으로 전달. 사용자가 "그 파일 줘/보내줘"라고 하면 이 도구를 써. 허용폴더 안 파일만. 링크·버튼을 글로 지어내지 말고 반드시 이 도구 호출)', '터미널 명령 실행(run_shell — 허용 폴더에서, 파괴적 명령 차단; 사용 전 사용자 허락 필요)', codeHint, '웹 검색(web_search — 실시간 정보·최신 사실을 인터넷에서 찾기)', '예약·알림(schedule_task — "다음 주 화요일 7시"처럼 특정 날짜 1회도, "매일 9시/매시/N분마다" 반복도; PC 켜진 동안)', '방법 익히기·스킬 만들기(create_skill — 잘 해낸 방법을 저장해 다음에 재사용)', '먼저 안부 묻기 설정(set_heartbeat — "그만/다시 챙겨줘/인사 시간 바꿔")');
  }
  if (multimodalOn) availableTools.push(pdfOn ? '이미지·문서(PDF) 보기(사용자가 첨부한 파일을 직접 보고 이해)' : '이미지 보기(사용자가 첨부한 이미지를 직접 보고 이해)');
  if (mcpDecls.length > 0) availableTools.push(`연결된 MCP 도구: ${mcpDecls.map(d => d.name).join(', ')}`);
  return availableTools;
}

/** function-calling 도구 선언 배열. main.js extraDecls 와 동일. */
function buildDecls({ skillCatalog = [], mcpDecls = [], deferred = true }) {
  // ★선언 원본은 tool-decls.js 한 곳. 여기선 **어떤 도구를 줄지**만 정한다.
  //   예전엔 여기에 설명문 사본이 있었고 구독 두뇌(MCP) 쪽과 19개가 달라져 있었다 —
  //   remember 의 "끝점" 기준, forget 의 확인 절차가 구독 쪽에만 있어 두뇌마다 규칙이 달랐다.
  const names = [
    'remember', 'forget', 'search_memory', 'set_nickname',
    'find_skill', 'install_skill', 'install_skill_web', 'uninstall_skill', 'create_skill',
    'find_mcp', 'install_mcp', 'remove_mcp',
    'set_trust', 'set_heartbeat',
    'list_files', 'read_file', 'write_file', 'make_dir', 'move_file', 'copy_file', 'remove_file', 'search_files', 'send_file',
    'run_shell', 'run_code', 'web_search',
    'schedule_task', 'list_schedules', 'cancel_schedule',
    'start_project', 'start_routine', 'switch_work', 'close_project', 'plan_task', 'resume_task',
  ];
  // 설치된 스킬이 있을 때만 use_skill 을 준다(없는데 주면 헛도는 호출이 는다).
  if (skillCatalog.length > 0) names.splice(names.indexOf('create_skill'), 0, 'use_skill');
  // ★지연 로딩: 기본은 **항상 쓸 것 + load_tools** 만 싣는다.
  //   나머지(우리 것 + 설치된 MCP 전부)는 이름 목록으로만 알리고, 두뇌가 필요할 때 꺼낸다.
  //   왜: 설명 33개가 11,522자였고 MCP 를 깔수록 더 커졌다 — 능력을 갖출수록 비싸지는 구조.
  //   가르는 기준·근거는 tool-decls.js 의 ALWAYS 주석. deferred=false 면 옛 동작(전부 싣기).
  //   ※ 구독 두뇌는 CLI 가 이미 지연 로드하므로 이 경로(REST)에만 적용된다.
  if (deferred === false) {
    const flat = toolDecls.pick(names).map(d => ({ ...d }));
    for (const d of mcpDecls) flat.push(d);
    return flat;
  }
  const all = names.concat(mcpDecls.map(d => d.name));
  const split = toolDecls.splitForDeferred(all);
  const decls = toolDecls.pick(split.always).map(d => ({ ...d }));
  decls.push({ ...toolDecls.LOAD_TOOLS });
  // 꺼낼 수 있는 것들 — load_tools 가 여기서 꺼내 extraDecls 에 꽂는다.
  const pool = toolDecls.pick(split.deferred).map(d => ({ ...d }))
    .concat(mcpDecls.filter(d => split.deferred.includes(d.name)));
  Object.defineProperty(decls, "_deferredPool", { value: pool, enumerable: false });
  Object.defineProperty(decls, "deferredNames", { value: split.deferred, enumerable: false });
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
    // ★지연 로딩: 두뇌가 필요한 도구를 꺼낸다.
    //   extraDecls 가 가변 참조라 여기 push 하면 **같은 턴 안에서** 바로 쓸 수 있다
    //   (MCP 설치가 이미 쓰던 통로와 동일 — 새 메커니즘이 아니다).
    if (n === 'load_tools') {
      const want = Array.isArray(args && args.names) ? args.names.map(String) : [];
      if (!want.length) return { error: '꺼낼 도구 이름을 names 에 넣어줘' };
      if (!extraDecls) return { error: '지금은 도구를 꺼낼 수 없어' };
      const pool = (ctx.lazy && Array.isArray(ctx.lazy.pool)) ? ctx.lazy.pool : [];
      const have = new Set(extraDecls.map(d => d.name));
      const added = []; const missing = [];
      // ★`newly` = **이번에 처음 꺼낸 것**만. 이미 실려 있던 도구와 구분해야 한다 —
      //   라운드 가드가 이 값으로 "설명을 아직 못 본 도구"를 판단하는데,
      //   구분하지 않으면 remember 처럼 늘 실려 있는 도구까지 잠가버린다.
      const newly = [];
      for (const nm of want) {
        if (have.has(nm)) { added.push(nm); continue; }   // 이미 있음 — 설명도 이미 봤다
        const d = pool.find(x => x && x.name === nm);
        if (d) { extraDecls.push({ ...d }); have.add(nm); added.push(nm); newly.push(nm); }
        else missing.push(nm);
      }
      // ★없으면 "없다"고 분명히 말해준다. 애매하게 두면 두뇌가 있는 척하고 넘어간다.
      if (!added.length) {
        return { loaded: [], newly: [], missing, message: '그런 도구는 없어: ' + missing.join(', ')
          + '. 목록에 있는 이름만 꺼낼 수 있어. 없는 능력이면 사용자에게 못 한다고 솔직히 말해.' };
      }
      return { loaded: added, newly, missing, message: '꺼냈어: ' + added.join(', ') + '. 지금 바로 부를 수 있어.'
        + (missing.length ? ' (없는 것: ' + missing.join(', ') + ')' : '') };
    }
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
        const line = brainClaude.promoteRoutineRhythm(routine);
        if (line) {
          const fa = storage.loadAgent(agentId);
          if (fa) {
            const r = userMemory.applyMemoryEdits(fa.userMemory, [{ op: 'add', text: line }]);
            if (r.applied) { fa.userMemory = r.text; storage.saveAgent(fa); emit('facts:updated', { agentId, userMemory: r.text }); }
          }
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
      // 통짜 그릇: 작업별 기억 격리(scope)는 두지 않는다 — 그릇은 작업이 아니라
      //   "이 사람"만 담으므로 프로젝트를 닫아도 그릇에서 치울 게 없다.
      if (fresh.work.activeId === id) fresh.work.activeId = null;
      storage.saveAgent(fresh);
      if (agent) agent.work = fresh.work;
      emit('work:updated', { agentId, work: fresh.work });
      // 끝난 프로젝트는 **끝점이 있으므로 그릇(존재)에 안 넣는다.** 겪은 일이니 일화로 남긴다.
      try {
        storage.addEpisodes(agentId, [{
          type: '사건', summary: `프로젝트 '${proj.title}'을 완료함`,
          entities: [proj.title], emotion: { weight: 0.3, valence: 0.5 },
        }]);
      } catch (_) {}
      return { closed: true, id, title: proj.title, message: `프로젝트 '${proj.title}'를 완료했어. 함께한 기억은 요약해서 간직할게.` };
    }
    // remember·forget 은 memory-tools 한 벌만 쓴다.
    //   전엔 engine·agent-tools·memory-tools 3벌이 따로 있었고 미묘하게 달라, 한 곳을 고치면
    //   나머지를 빠뜨리는 구조였다. 채널별 부가 동작(emit·콜백)만 여기서 한다.
    if (n === 'remember') {
      const r = memoryTools.rememberFact(agentId, args || {});
      if (r.saved) { onRemembered(); emit('facts:updated', { agentId, userMemory: r.userMemory }); }
      const { userMemory: _um, ...out } = r;   // 기억 전문을 두뇌에 돌려주지 않는다(토큰)
      return out;
    }
    // 호칭 — 기억이 아니라 설정. 대화 그 자리에서 반영돼야 사용자가 어색함을 안 느낀다.
    if (n === 'set_nickname') {
      const r = memoryTools.setNickname(agentId, args || {});
      if (r.set) emit('facts:updated', { agentId });
      return r;
    }
    if (n === 'forget') {
      const r = memoryTools.forgetFact(agentId, args || {});
      if (r.forgotten) { onRemembered(); emit('facts:updated', { agentId, userMemory: r.userMemory }); }
      const { userMemory: _um, ...out } = r;
      return out;
    }
    if (n === 'find_mcp') {
      const reg = await mcpManager.searchRegistry(args.need || ''); // 3b: 공식 npm 레지스트리(@modelcontextprotocol/*)도 검색
      const candidates = mcpManager.searchCatalog(args.need || '').concat(reg);
      return { candidates };
    }
    if (n === 'install_mcp') {
      const entry = args.url ? null : matchByIdOrName(mcpManager.loadCatalog().servers || [], 'id', 'name', args.id);
      let r, installedName;
      if (args.url) {
        // 원격(HTTP) MCP — 사용자가 준 주소로 바로 붙인다. 설치형과 달리 신뢰 스코프 제한 없음(우리 PC에서 코드를 돌리지 않음).
        r = mcpManager.addRemoteServer(agentId, { id: args.id, name: args.id || args.url, url: args.url, token: args.token, refreshToken: args.refreshToken, headers: args.headers });
        installedName = args.id || args.url;
      } else if (entry) {
        const params = args.params || {};
        const missing = (entry.params || []).filter(p => p.required && !String(params[p.key] || '').trim());
        if (missing.length) return { needParams: missing, message: `설치 전에 사용자에게 다음을 물어봐: ${missing.map(p => p.label).join(', ')}` };
        r = mcpManager.addFromCatalog(agentId, entry.id, params);
        installedName = entry.name;
      } else if (mcpManager.isTrustedPackage(args.id)) {
        // 3b: 신뢰 레지스트리(공식 npm) 패키지 설치. 설정 필요 서버는 addFromCatalog가 needParams로 요구.
        // 설치 전 사전 점검: 출처(스코프)만 보고 깔지 않는다. 수상한 정황이 있으면
        // 설치를 멈추고 사용자에게 알린 뒤 승인(confirm)을 받아야 진행한다.
        if (!args.confirm) {
          const insp = await mcpManager.inspectPackage(args.id);
          if (!insp.ok) {
            return {
              needsConfirm: true, inspection: insp.info, warnings: insp.warnings,
              message: `아직 설치 안 했어. '${args.id}' 확인 결과 짚어둘 게 있어:\n- ${insp.warnings.join('\n- ')}\n사용자에게 이걸 그대로 알리고 "그래도 설치할까요?"라고 물어봐. 사용자가 승인하면 confirm:true 로 다시 호출해. 승인 없이 설치하지 마.`,
            };
          }
        }
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
        const m = await mcpManager.collectTools(agentId, { generate });
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
    if (n === 'list_files' || n === 'read_file' || n === 'write_file' || n === 'make_dir' || n === 'move_file' || n === 'copy_file' || n === 'search_files') {
      const exec = (allowed) => {
        if (n === 'list_files') return fsTools.listFiles(allowed, args.dir);
        if (n === 'read_file') return fsTools.readFile(allowed, args.path);
        if (n === 'write_file') return fsTools.writeFile(allowed, args.path, args.content);
        if (n === 'make_dir') return fsTools.makeDir(allowed, args.dir);
        if (n === 'move_file') return fsTools.moveFile(allowed, args.from, args.to);
        if (n === 'copy_file') return fsTools.copyFile(allowed, args.from, args.to);
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
      if (r && r.needGrant) {
        const gdir = require('path').dirname(r.needGrant); // 허용은 상위 폴더 단위(파일 하나만 아니라 그 폴더)
        try { const fr = storage.loadAgent(agentId); if (fr) { fr.pendingGrant = { kind: 'dir', dir: gdir }; storage.saveAgent(fr); if (agent) agent.pendingGrant = fr.pendingGrant; } } catch (_) {}
        r.message = `'${gdir}' 폴더는 아직 허용되지 않았어. 이건 사용자만 허용할 수 있어(네가 직접 허용 못 함). 사용자에게 "이 폴더에 접근해도 될까요?"라고 묻고, 사용자가 허락하면 그다음에 다시 시도해.`;
      }
      return r;
    }
    if (n === 'grant_dir' || n === 'grant_shell') {
      // 허용은 사용자만 — 모델은 grant를 직접 못 켠다(엔진이 사용자 답으로만 허용). 방어적 거부.
      return { error: '폴더·터미널 접근 허용은 사용자만 할 수 있어. 네가 직접 켤 수 없어 — 사용자에게 허락을 구한 뒤 다시 시도해.' };
    }
    if (n === 'remove_file') {
      // ★지우기는 되돌릴 수 없다 — 허용 폴더 안이어도 **사용자 확인**을 한 번 더 받는다.
      //   "쓸 수 있다" 와 "없애도 된다" 는 같은 말이 아니다.
      const auto = agent && agent.trustLevel === 'autonomous';
      if (!args.confirmed && !auto) {
        return { needConfirm: true, message: '지우는 건 되돌릴 수 없어. 사용자에게 무엇을 지울지 정확히 말하고 "지워도 될까요?"라고 물어봐. 허락하면 confirmed:true 로 다시 불러.' };
      }
      return fsTools.removeFile((agent && agent.allowedDirs) || [], args.path);
    }
    if (n === 'run_shell') {
      const auto = agent && agent.trustLevel === 'autonomous';
      if (!(agent && agent.allowShell) && !auto) {
        try { const fr = storage.loadAgent(agentId); if (fr) { fr.pendingGrant = { kind: 'shell' }; storage.saveAgent(fr); if (agent) agent.pendingGrant = fr.pendingGrant; } } catch (_) {}
        return { needGrantShell: true, message: '터미널 명령 실행은 아직 허용되지 않았어. 이건 사용자만 허용할 수 있어. 사용자에게 "터미널 명령 실행을 허용할까요?"라고 묻고, 허락하면 다시 시도해.' };
      }
      return procTools.runShell((agent && agent.allowedDirs) || [], args.command, args.cwd);
    }
    if (n === 'run_code') {
      const auto = agent && agent.trustLevel === 'autonomous';
      if (!(agent && agent.allowShell) && !auto) {
        try { const fr = storage.loadAgent(agentId); if (fr) { fr.pendingGrant = { kind: 'shell' }; storage.saveAgent(fr); if (agent) agent.pendingGrant = fr.pendingGrant; } } catch (_) {}
        return { needGrantShell: true, message: '코드 실행은 아직 허용되지 않았어. 이건 사용자만 허용할 수 있어. 사용자에게 "코드/명령 실행을 허용할까요?"라고 묻고, 허락하면 다시 시도해.' };
      }
      // `lang` 도 받는다 — 선언은 language 로 명확한데도 두뇌가 lang 으로 보낸다(gemini 실측).
      // 스키마를 지키게 만들 방법이 우리에겐 없다. 사용자 입장에선 되는 게 중요하다.
      return procTools.runCode((agent && agent.allowedDirs) || [], args.language || args.lang, args.code, args.cwd);
    }
    if (n === 'web_search') {
      const sk = (agent && agent.search) || {}; // {provider, naver:{clientId,clientSecret}, tavily:{apiKey}}
      return await webSearchTool.webSearch(args.query, { max: args.max, provider: sk.provider, naver: sk.naver, tavily: sk.tavily });
    }
    if (n === 'schedule_task') {
      // 지금 대화 중인 창구로 알림이 가게 한다(2026-08-20). 없으면 옛 동작대로 app.
      const s = scheduler.createSchedule(args, storage.getActiveChannel(agentId));
      if (s.error) return { error: s.error };   // 예: weekly 인데 요일을 안 줬다 → 되묻게 한다
      if (!s.title || !s.prompt) return { error: 'title과 prompt가 필요해' };
      const fresh = storage.loadAgent(agentId);
      if (!fresh) return { error: '저장 실패' };
      fresh.schedules = fresh.schedules || [];
      fresh.schedules.push(s); storage.saveAgent(fresh);
      if (agent) agent.schedules = fresh.schedules;
      return { scheduled: true, id: s.id, message: `'${s.title}' 예약 완료 — ${scheduler.describe(s)}.${scheduler.caveat(s)} PC가 켜져 있을 때 실행돼서 결과를 보낼게.` };
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
    // 능력 회수: 설치 도구만 있고 삭제가 없으면 한 방향으로 쌓이기만 한다.
    // 그래서 에이전트가 데이터 폴더를 직접 지우려다 보호계층에 막히곤 했다(보호는 정상, 정식 통로가 없던 게 문제).
    // 삭제는 되돌릴 수 없으니 '사용자가 말했을 때만' 규칙은 도구 설명에 박아둔다.
    if (n === 'remove_mcp') {
      const servers = mcpManager.listServers(agentId) || [];
      const hit = matchByIdOrName(servers, 'id', 'name', args.id);
      if (!hit) return { error: `그런 MCP 없음: ${args.id}`, installed: servers.map(s => ({ id: s.id, name: s.name })) };
      const r = mcpManager.removeServer(agentId, hit.id);
      if (r && r.error) return { error: r.error };
      // 지운 서버의 도구를 이번 턴 라우팅에서도 즉시 걷어낸다(지웠는데 계속 보이는 일 방지).
      if (mcpRoutes) for (const [fn, rt] of [...mcpRoutes]) if (rt.id === hit.id) mcpRoutes.delete(fn);
      if (extraDecls) for (let i = extraDecls.length - 1; i >= 0; i--) if (String(extraDecls[i].name || '').startsWith(`mcp__${hit.id}__`)) extraDecls.splice(i, 1);
      return { removed: true, name: hit.name || hit.id, message: `'${hit.name || hit.id}' MCP를 삭제했어. 이제 그 도구들은 못 써.` };
    }
    if (n === 'uninstall_skill') {
      const skills = skillsRegistry.list(agentId) || [];
      const hit = matchByIdOrName(skills, 'id', 'name', args.name);
      if (!hit) return { error: `그런 스킬 없음: ${args.name}`, installed: skills.map(s => ({ id: s.id, name: s.name })) };
      const r = skillsRegistry.remove(agentId, hit.id);
      if (r && r.error) return { error: r.error };
      return { removed: true, name: hit.name || hit.id, message: `'${hit.name || hit.id}' 스킬을 삭제했어.` };
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
