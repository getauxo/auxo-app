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
const userMemory = require('./user-memory'); // 그릇(통짜) 편집 — 루틴 리듬 등 직접 추가 경로
const subagents = require('./subagents');
const skillsRegistry = require('./skills-registry');
const mcpManager = require('./mcp-manager');
const fsTools = require('./fs-tools');
const grants = require('./grants');
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
// ── 도구 선언 — 원본은 tool-decls.js 한 곳. 여기선 이름만 고르고 MCP 형식으로 바꾼다. ──
//   여기에 설명문 사본을 두면 REST 쪽과 갈라진다(실제로 수십 개가 어긋난 적이 있다).
//   (remember 의 "끝점" 기준, forget 의 확인 절차가 구독 쪽에만 있는 식) → 원본 일원화.
const toolDecls = require('./tool-decls');

const DELEGATE_DECL = toolDecls.byName.get('delegate_to_workers');

// P0-a: 구독 두뇌(claude/codex)에도 노출하는 "읽기 전용" 공통 도구.
const READ_DECLS = toolDecls.toMcp(toolDecls.pick([
  'find_mcp', 'install_mcp', 'remove_mcp', 'find_skill', 'install_skill', 'install_skill_web',
  'uninstall_skill', 'use_skill', 'create_skill', 'search_memory', 'web_search',
  'schedule_task', 'list_schedules', 'cancel_schedule', 'set_trust', 'set_heartbeat',
  'run_shell', 'run_code',
]));

// 파일 도구(공통층) — REST(agent-tools)와 같은 fs-tools 코어. allowedDirs 안에서만.
const FILE_DECLS = toolDecls.toMcp(toolDecls.pick([
  'list_files', 'read_file', 'write_file', 'make_dir', 'move_file', 'copy_file', 'remove_file', 'search_files', 'send_file',
]));

// 작업기억(L2) + 자율도 — REST(agent-tools)와 동일 동작을 구독 두뇌에도 노출.
// ★L3(plan_task/resume_task)도 구독 두뇌에 배선한다 — 한쪽에만 있으면 채널이 갈라진다.
const WORK_DECLS = toolDecls.toMcp(toolDecls.pick([
  'start_project', 'start_routine', 'switch_work', 'close_project', 'plan_task', 'resume_task',
]));

// ★로컬 도구(시간·계산)도 구독 두뇌에 배선한다. 빠지면 **채널 동등성이 깨진다.**
//   REST 두뇌(gemini/openai/anthropic)는 커넥터가 tools.js 를 자동으로 실어줘서 갖고 있었는데,
//   구독 두뇌엔 자동으로 실리지 않아, 선언을 합칠 때 **tools.js 가 빠지기 쉽다.**
//   시간 도구가 없으면 예약이 "오늘이 그날인지 확인해라"를 수행하려다
//   **run_shell 을 부르고**, 셸 권한이 없어 막히며 사용자가 요청한 적 없는 허용 대기가 생긴다.
//   ※ fetch_url 은 일부러 뺐다 — 구독은 네이티브 WebFetch 가 이미 허용돼 있어 중복이다.
const localTools = require('./tools');
const LOCAL_NAMES = ['get_current_time', 'calculator'];
const LOCAL_DECLS = toolDecls.toMcp(localTools.DECLS.filter((d) => LOCAL_NAMES.includes(d.name)));

(async () => {
  if (!DATA || !AGENT_ID) { console.error('[auxo-mcp-tools] AUXO_DATA_PATH / AUXO_AGENT_ID 필요'); process.exit(1); }
  storage.initOrExit(DATA);
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
      ...LOCAL_DECLS,   // 시간·계산 — REST 두뇌와 동일하게(채널 동등성)
    ],
  }));

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const { name, arguments: args } = req.params;
    // ★구독 두뇌는 여기서 도구가 돌아 엔진이 못 본다. 같은 DB 장부에 남긴다.
    //   기록은 **맨 끝에서 결과를 보고** 한다 — 여기서 미리 남기면 실패도 성공으로 적힌다.
    let r;
    if (name === 'remember') r = memoryTools.rememberFact(AGENT_ID, args || {});
    else if (name === 'set_nickname') r = memoryTools.setNickname(AGENT_ID, args || {});
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
      // 설치 전 사전 점검 — 신뢰 스코프 npm 패키지라도 출처만 보고 깔지 않는다.
      // 수상한 정황(설치 스크립트·저장소 없음·방치·미사용)이면 멈추고 사용자 승인을 받는다.
      let 점검 = null;
      if (args && !args.url && !args.confirm && mcpManager.isTrustedPackage(args.id)) {
        const insp = await mcpManager.inspectPackage(args.id);
        if (!insp.ok) 점검 = insp;
      }
      if (점검) {
        // ★여기서 `return` 하면 이 핸들러 **맨 끝의 { content:[...] } 감싸기를 건너뛴다.**
        //   그러면 두뇌는 읽을 수 없는 응답을 받고("응답이 비어서…"), 경고는 사용자에게 한 글자도 안 간다.
        //   설치는 정상 차단되는데 두뇌는 "설치 명령은 실행했어, 오류는 안 났어"라고
        //   정반대로 말하게 된다. 안전장치가 절반만 작동하는 셈 — 알리는 쪽이 이 기능의 존재 이유다.
        //   원인은 API 키 경로(agent-tools.js)의 `return` 을 그대로 옮겨온 것. 거기선 반환값을 그대로 쓰지만
        //   여기선 감싸야 한다. → **다른 도구와 똑같이 r 에 담아 한 출구로 내보낸다.**
        r = { needsConfirm: true, inspection: 점검.info, warnings: 점검.warnings,
          message: `아직 설치 안 했어. '${args.id}' 확인 결과 짚어둘 게 있어:\n- ${점검.warnings.join('\n- ')}\n사용자에게 이걸 그대로 알리고 "그래도 설치할까요?"라고 물어봐. 승인하면 confirm:true 로 다시 호출해. 승인 없이 설치하지 마.` };
      } else {
        // 원격(HTTP) MCP — 주소가 오면 그대로 붙인다. 설치형과 달리 이 PC에서 코드를 돌리지 않는다.
        const r0 = (args && args.url)
          ? mcpManager.addRemoteServer(AGENT_ID, { id: args.id, name: args.id || args.url, url: args.url, token: args.token, refreshToken: args.refreshToken, headers: args.headers })
          : mcpManager.addFromCatalog(AGENT_ID, (args && args.id) || '', (args && args.params) || {});
        if (!r0 || r0.error) { r = { error: (r0 && r0.error) || '설치 실패', needParams: r0 && r0.needParams }; }
        else {
          // 설치 직후 실제 연결 검증 — 설정 필요 서버가 조용히 안 되는 걸 잡아 거짓 "완료" 방지.
          const v = await mcpManager.verifyInstalled(AGENT_ID, r0.id);
          r = (v && v.ok)
            ? { installed: true, connected: true, message: `'${r0.name || args.id}' 설치 완료. 바로 쓸 수 있어.` }
            : { installed: true, connected: false, needsSetup: true, message: `'${r0.name || args.id}' 등록은 됐는데 지금 바로 연결이 안 됐어(${(v && v.error) || '연결 실패'}). 이 도구는 추가 설정(폴더 경로·토큰 등)이 필요하거나 이 PC에 npx/node 준비가 필요할 수 있어. 뭐가 필요한지 사용자에게 물어보거나, 설정 없이 되는 다른 도구를 제안해. "됐다"고 단정하지 마.` };
        }
      }
    }
    else if (name === 'install_skill') {
      const r0 = await skillsRegistry.installFromCatalog(AGENT_ID, (args && args.id) || '');
      r = (r0 && r0.installed) ? { installed: true, message: '스킬 설치 완료.' } : { error: (r0 && r0.error) || '설치 실패' };
    }
    // 능력 회수: 설치만 있고 삭제가 없으면 비대칭이다. 삭제는 사용자가 말했을 때만(도구 설명에 명시).
    else if (name === 'remove_mcp') {
      const want = String((args && args.id) || '').trim().toLowerCase();
      const servers = mcpManager.listServers(AGENT_ID) || [];
      const hit = servers.find(s => String(s.id).toLowerCase() === want || String(s.name || '').toLowerCase() === want);
      if (!hit) r = { error: `그런 MCP 없음: ${(args && args.id) || ''}`, installed: servers.map(s => ({ id: s.id, name: s.name })) };
      else {
        const r0 = mcpManager.removeServer(AGENT_ID, hit.id);
        r = (r0 && r0.error) ? { error: r0.error } : { removed: true, name: hit.name || hit.id, message: `'${hit.name || hit.id}' MCP를 삭제했어. 이제 그 도구들은 못 써.` };
      }
    }
    else if (name === 'uninstall_skill') {
      const want = String((args && args.name) || '').trim().toLowerCase();
      const skills = skillsRegistry.list(AGENT_ID) || [];
      const hit = skills.find(s => String(s.id).toLowerCase() === want || String(s.name || '').toLowerCase() === want);
      if (!hit) r = { error: `그런 스킬 없음: ${(args && args.name) || ''}`, installed: skills.map(s => ({ id: s.id, name: s.name })) };
      else {
        const r0 = skillsRegistry.remove(AGENT_ID, hit.id);
        r = (r0 && r0.error) ? { error: r0.error } : { removed: true, name: hit.name || hit.id, message: `'${hit.name || hit.id}' 스킬을 삭제했어.` };
      }
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
      // ★구독 두뇌 경로. 이 프로세스는 앱과 **따로 돌기 때문에** 창구를 저장소에서 읽는다(2026-08-20).
      const s = scheduler.createSchedule(args, storage.getActiveChannel(AGENT_ID));
      if (s.error) r = { error: s.error };      // 예: weekly 인데 요일을 안 줬다 → 되묻게 한다
      else if (!s.title || !s.prompt) r = { error: 'title과 prompt가 필요해' };
      else { const fresh = storage.loadAgent(AGENT_ID); if (!fresh) r = { error: '저장 실패' }; else { fresh.schedules = fresh.schedules || []; fresh.schedules.push(s); storage.saveAgent(fresh); r = { scheduled: true, id: s.id, message: `'${s.title}' 예약 완료 — ${scheduler.describe(s)}.${scheduler.caveat(s)}` }; } }
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
    else if (name === 'list_files' || name === 'read_file' || name === 'write_file' || name === 'make_dir' || name === 'move_file' || name === 'copy_file' || name === 'search_files') {
      const a = args || {};
      const ag0 = storage.loadAgent(AGENT_ID) || {};
      const exec = (allowed) => {
        if (name === 'list_files') return fsTools.listFiles(allowed, a.dir);
        if (name === 'read_file') return fsTools.readFile(allowed, a.path);
        if (name === 'write_file') return fsTools.writeFile(allowed, a.path, a.content);
        if (name === 'make_dir') return fsTools.makeDir(allowed, a.dir);
        if (name === 'move_file') return fsTools.moveFile(allowed, a.from, a.to);
        if (name === 'copy_file') return fsTools.copyFile(allowed, a.from, a.to);
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
      if (r && r.needGrant) {
        // ★허락은 grants 한 곳에서만 건다 — 전엔 여기와 agent-tools 가 따로 걸어
        //   문구까지 갈라져 있었다("허용되지 않았어" vs "허용 안 됐어"). 채널마다 다른 말이 나갔다.
        Object.assign(r, grants.ask(AGENT_ID, 'dir', { path: r.needGrant }));
      }
    }
    else if (name === 'grant_dir' || name === 'grant_shell') {
      // 허용은 사용자만 — 모델은 grant를 직접 못 켠다(엔진이 사용자 답으로만 허용). 방어적 거부.
      r = { error: '폴더·터미널 접근 허용은 사용자만 할 수 있어. 네가 직접 켤 수 없어 — 사용자에게 허락을 구한 뒤 다시 시도해.' };
    }
    else if (name === 'remove_file') {
      // ★지우기는 되돌릴 수 없다 — 허용 폴더 안이어도 **사용자 확인**을 한 번 더 받는다(REST 경로와 동일).
      //   이 파일은 agent 객체를 안 들고 다닌다 — 매 호출 storage 에서 신선하게 읽는다(grant 직후 반영).
      const a2 = args || {};
      const ag2 = storage.loadAgent(AGENT_ID) || {};
      if (!a2.confirmed && ag2.trustLevel !== 'autonomous') {
        r = { needConfirm: true, message: '지우는 건 되돌릴 수 없어. 사용자에게 무엇을 지울지 정확히 말하고 "지워도 될까요?"라고 물어봐. 허락하면 confirmed:true 로 다시 불러.' };
      } else {
        r = fsTools.removeFile(ag2.allowedDirs || [], a2.path);
      }
    }
    else if (name === 'run_shell') {
      const ag = storage.loadAgent(AGENT_ID) || {};
      if (!ag.allowShell && ag.trustLevel !== 'autonomous') {
        r = grants.ask(AGENT_ID, 'shell');
      } else {
        r = procTools.runShell(ag.allowedDirs || [], args && args.command, args && args.cwd);
      }
    }
    else if (name === 'run_code') {
      const ag = storage.loadAgent(AGENT_ID) || {};
      if (!ag.allowShell && ag.trustLevel !== 'autonomous') {
        r = grants.ask(AGENT_ID, 'code');
      } else {
        // `lang` 도 받는다(agent-tools 같은 자리의 주석 참고) — 채널이 달라도 같게.
        r = procTools.runCode(ag.allowedDirs || [], args && (args.language || args.lang), args && args.code, args && args.cwd);
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
              const line = brainClaude.promoteRoutineRhythm(routine);
              if (line) {
                const fa = storage.loadAgent(AGENT_ID);
                if (fa) {
                  const rr = userMemory.applyMemoryEdits(fa.userMemory, [{ op: 'add', text: line }]);
                  if (rr.applied) { fa.userMemory = rr.text; storage.saveAgent(fa); }
                }
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
            // 통짜 그릇: 작업별 기억 격리(scope)는 두지 않는다 — 그릇은 "이 사람"만 담는다.
            if (fresh.work.activeId === id) fresh.work.activeId = null;
            storage.saveAgent(fresh);
            // 끝난 프로젝트는 끝점이 있으므로 그릇(존재)에 안 넣는다. 겪은 일이니 일화로 남긴다.
            try {
              storage.addEpisodes(AGENT_ID, [{
                type: '사건', summary: `프로젝트 '${proj.title}'을 완료함`,
                entities: [proj.title], emotion: { weight: 0.3, valence: 0.5 },
              }]);
            } catch (_) {}
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
    // ★로컬 도구(시간·계산) — tools.js 코어를 그대로 쓴다(REST 두뇌와 같은 구현).
    else if (LOCAL_NAMES.includes(name)) {
      // execute 는 async — await 를 빼면 Promise 가 그대로 JSON.stringify 돼 빈 {} 가 나간다.
      try { r = await localTools.execute(name, args || {}); }
      catch (e) { r = { error: `${name} 실행 오류: ${e.message}` }; }
    }
    else r = { error: 'unknown tool: ' + name };
    // 결과를 보고 장부에 남긴다. 실패 판정 = `{error}` 를 돌려준 경우.
    //   ※ `{saved:false, message:"이미 알고 있는 내용이야"}` 같은 건 정상 동작이라 실패가 아니다.
    try { storage.recordToolCall(AGENT_ID, name, !(r && typeof r === 'object' && r.error)); } catch (_) {}
    return { content: [{ type: 'text', text: JSON.stringify(r) }] };
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error('[auxo-mcp-tools] ready (agent=' + AGENT_ID + ')'); // stderr — stdout은 MCP 전용
})().catch(err => { console.error('[auxo-mcp-tools] fatal:', err && err.message); process.exit(1); });
