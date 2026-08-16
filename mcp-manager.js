/**
 * mcp-manager.js — MCP 서버 등록·연결·도구발견·호출 관리 (에이전트별 격리)
 *
 * 사용자가 등록한 MCP 서버(stdio 명령)를 연결하고, 도구를 발견해
 * function-calling decl로 변환한다. 호출은 client.callTool로 라우팅.
 * SDK는 ESM이라 await import()로 로드(앱은 CommonJS).
 *
 * ★ 에이전트별 격리 — 에이전트는 저마다 독립된 정체성을 갖는다:
 *   MCP 서버는 에이전트마다 독립이다. 설정 = <CONFIG_ROOT>/mcp-<agentId>.json,
 *   런타임 연결 풀(clients)도 에이전트별 키(`agentId::serverId`)로 분리한다.
 *   신규 에이전트는 빈손으로 시작. 모든 등록/조회/연결/호출 함수는 agentId 를 받는다.
 *
 * 보안: 서버 등록=사용자의 명시적 행위(명령 실행 동의). 결과는 데이터로 취급.
 */
'use strict';
const fs = require('fs');
const path = require('path');

let CONFIG_ROOT = __dirname;                       // 기본; setConfigRoot 로 userData/mcp 로 교체
// MCP 서버의 작업폴더(cwd). 기본이 앱 폴더(__dirname)면 보호구역이라, Playwright 등이 산출물(스크린샷)을
// 거기 저장하면 에이전트가 못 읽고 못 보내는 충돌이 난다(실측). → download 로 옮긴다(보호 예외 + 읽기/전송 가능).
let WORK_DIR = __dirname;
let CATALOG_PATH = path.join(__dirname, 'mcp-catalog.json');
const clients = new Map(); // `${agentId}::${serverId}` -> { client, transport, tools:[{name,description,inputSchema}] }

function setConfigRoot(rootDir) {
  CONFIG_ROOT = rootDir;
  try { fs.mkdirSync(CONFIG_ROOT, { recursive: true }); } catch (_) {}
  // rootDir = <userData>/mcp → 작업폴더는 <userData>/download (fs-tools 보호 예외 + 에이전트 허용경계).
  try { WORK_DIR = path.join(path.dirname(rootDir), 'download'); fs.mkdirSync(WORK_DIR, { recursive: true }); } catch (_) { WORK_DIR = __dirname; }
}
function setCatalogPath(p) { CATALOG_PATH = p; }

/** 에이전트별 MCP 설정 파일 경로. agentId 없으면 공용 폴백(_shared). */
function configFor(agentId) {
  const safe = String(agentId || '_shared').replace(/[\\/]/g, '');
  return path.join(CONFIG_ROOT, `mcp-${safe}.json`);
}
function loadConfig(agentId) { try { return JSON.parse(fs.readFileSync(configFor(agentId), 'utf8')); } catch (_) { return { servers: [] }; } }
function saveConfig(agentId, cfg) { fs.writeFileSync(configFor(agentId), JSON.stringify(cfg, null, 2), 'utf8'); }

function listServers(agentId) { return loadConfig(agentId).servers || []; }

function addServer(agentId, { id: wantId, name, command, args, env, url, headers, refreshToken, tokenUrl, clientId }) {
  const remote = !!(url && String(url).trim());
  if (!remote && (!command || !String(command).trim())) return { error: '실행 명령(command)이 필요해요.' };
  if (remote) {
    let u; try { u = new URL(String(url).trim()); } catch (_) { return { error: '주소(url)가 올바르지 않아요.' }; }
    if (!/^https?:$/.test(u.protocol)) return { error: 'http/https 주소만 연결할 수 있어요.' };
  }
  const cfg = loadConfig(agentId); cfg.servers = cfg.servers || [];

  // ── 같은 것을 다시 붙이면 새로 만들지 않고 갱신한다 ──
  // 원격은 '주소'가 곧 그 서버다. 토큰만 갈아끼우는 일이 흔한데(만료·갱신) 갱신하지 않으면
  // playmcp / playmcp-1 / playmcp-2 처럼 항목이 쌓인다. 죽은 항목은 매 턴 헛되게 접속을 시도해
  // 대화를 느리게 만든다. 설치형도 같은 명령·인자면 같은 서버로 본다.
  const same = remote
    ? (cfg.servers || []).find(s => s.url && s.url === String(url).trim())
    : (cfg.servers || []).find(s => s.command === String(command).trim()
        && JSON.stringify(s.args || []) === JSON.stringify(Array.isArray(args) ? args : (args ? String(args).split(/\s+/).filter(Boolean) : [])));
  if (same) {
    if (remote) {
      if (headers && typeof headers === 'object' && Object.keys(headers).length) same.headers = headers;
      if (refreshToken) same.refreshToken = String(refreshToken);
      if (tokenUrl) same.tokenUrl = String(tokenUrl);
      if (clientId) same.clientId = String(clientId);
    } else if (env && typeof env === 'object' && Object.keys(env).length) {
      same.env = env;
    }
    if (name) same.name = name;
    same.enabled = true;
    saveConfig(agentId, cfg);
    disconnect(agentId, same.id); // 새 인증정보로 다시 붙게 기존 연결을 끊는다
    return { id: same.id, name: same.name, remote, updated: true };
  }
  // id는 영문·숫자·하이픈만 — MCP 도구명(mcp__<id>__<tool>)이 정규화될 때 깨지지 않게(구독 두뇌 사용 위해). wantId(카탈로그 영문 id) 우선.
  const base = String(wantId || name || (remote ? new URL(url).hostname : command)).toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-|-$/g, '').slice(0, 24) || 'mcp';
  let id = base, i = 1; while (cfg.servers.find(s => s.id === id)) id = `${base}-${i++}`;
  const entry = { id, name: name || id, enabled: true };
  if (remote) {
    entry.url = String(url).trim();
    if (headers && typeof headers === 'object' && Object.keys(headers).length) entry.headers = headers; // 인증 토큰 등
    if (refreshToken) entry.refreshToken = String(refreshToken); // 만료 시 자동 갱신용
    if (tokenUrl) entry.tokenUrl = String(tokenUrl);
    if (clientId) entry.clientId = String(clientId);
  } else {
    entry.command = String(command).trim();
    entry.args = Array.isArray(args) ? args : (args ? String(args).split(/\s+/).filter(Boolean) : []);
    if (env && typeof env === 'object' && Object.keys(env).length) entry.env = env; // 키(API 키 등) 주입
  }
  cfg.servers.push(entry);
  saveConfig(agentId, cfg);
  return { id, name: name || id, remote };
}
function removeServer(agentId, id) { const cfg = loadConfig(agentId); cfg.servers = (cfg.servers || []).filter(s => s.id !== id); saveConfig(agentId, cfg); disconnect(agentId, id); return { ok: true }; }
function setEnabled(agentId, id, enabled) { const cfg = loadConfig(agentId); const s = (cfg.servers || []).find(x => x.id === id); if (s) { s.enabled = enabled; saveConfig(agentId, cfg); } if (!enabled) disconnect(agentId, id); return { ok: true }; }

// 서버 신뢰(위험도구 자동 승인) 여부
function isAutoApproved(agentId, id) { const s = (loadConfig(agentId).servers || []).find(x => x.id === id); return !!(s && s.autoApprove); }
function setAutoApprove(agentId, id, val) { const cfg = loadConfig(agentId); const s = (cfg.servers || []).find(x => x.id === id); if (s) { s.autoApprove = !!val; saveConfig(agentId, cfg); } return { ok: true }; }

// 위험 도구 판별(휴리스틱): 쓰기·삭제·전송·실행류는 승인 필요. 읽기·조회류는 자유.
// ★도구가 위험한지는 영어 단어 매칭이 아니라 LLM 이 판정한다.
//   영어 단어만 보면 한국어로 설명된 도구는 전부 '안전'으로 새고, 반대로 이름에 create 가 들어갔다는
//   이유만으로 '메모 만들기'까지 승인을 요구한다. 도구엔 설명이 붙어 있으니 LLM 이 읽고 판단하면 된다.
//   아래 정규식은 **LLM 판정을 못 했을 때의 폴백**으로만 남는다(판정 실패가 곧 무승인 실행이 되면 안 되므로).
const RISKY_RE = /(write|delete|remove|create|update|edit|modify|move|rename|put|post|send|email|exec|execute|run|spawn|install|push|publish|deploy|drop|insert|append|set[_-]|kill|terminate|payment|pay|transfer)/i;
function isRiskyTool(name, desc) { return RISKY_RE.test(String(name || '')) || RISKY_RE.test(String(desc || '')); }

/**
 * 서버의 도구 목록 중 "사용자 승인을 받고 실행해야 할 것"을 LLM 이 골라낸다.
 * 도구 목록은 서버마다 고정이라 한 번 판정하고 설정에 캐시한다(목록이 바뀌면 다시 판정).
 * generate 가 없거나 판정이 실패하면 null → 호출부가 정규식 폴백을 쓴다.
 */
async function classifyRiskyTools(agentId, server, tools, generate) {
  const list = (tools || []).map(t => ({ name: t.name, description: String(t.description || '').slice(0, 200) }));
  if (!list.length) return new Set();
  const sig = list.map(t => t.name).sort().join('|');

  const cfg = loadConfig(agentId);
  const entry = (cfg.servers || []).find(s => s.id === server.id);
  if (entry && entry.riskySig === sig && Array.isArray(entry.riskyTools)) return new Set(entry.riskyTools);
  if (typeof generate !== 'function') return null;

  const sys = '너는 도구 목록을 보고 위험한 것을 골라내는 분류기야. 설명 없이 도구 이름만 쉼표로 나열해. 없으면 NONE.';
  const prompt = `아래는 어떤 서버가 제공하는 도구 목록이야.\n\n`
    + list.map(t => `- ${t.name}: ${t.description || '(설명 없음)'}`).join('\n')
    + `\n\n이 중 **사용자 승인을 받고 실행해야 할 도구**의 이름만 쉼표로 나열해.\n`
    + `승인이 필요한 것 = 무언가를 바꾸거나 지우거나, 밖으로 보내거나 공개하거나, 돈이 나가거나, 되돌리기 어려운 일.\n`
    + `승인이 필요 없는 것 = 조회·검색·읽기처럼 보기만 하고 아무것도 바꾸지 않는 일.\n`
    + `애매하면 승인이 필요한 쪽으로 넣어. 이름만, 쉼표로. 없으면 NONE.`;
  try {
    const raw = await generate(sys, prompt, { temperature: 0, timeout: 30000 });
    const s = String(raw || '').trim();
    if (!s) return null;
    const known = new Set(list.map(t => t.name));
    const picked = /^\s*NONE\s*$/i.test(s) ? [] : s.split(/[,\n]/).map(x => x.trim().replace(/^[-*\s]+/, '')).filter(x => known.has(x));
    if (!picked.length && !/^\s*NONE\s*$/i.test(s)) return null; // 형식이 어긋나면 폴백
    if (entry) { entry.riskyTools = picked; entry.riskySig = sig; try { saveConfig(agentId, cfg); } catch (_) {} }
    return new Set(picked);
  } catch (_) {
    return null; // 판정 실패 → 폴백(정규식). 승인 요구를 건너뛰지 않는다.
  }
}

/** 에이전트별 연결 풀 키. */
function ckey(agentId, serverId) { return `${String(agentId || '_shared')}::${serverId}`; }

// ── Node(npx) 사용 가능 여부 ──────────────────────────────────────────────
// MCP 서버·PDF 생성 등은 npx로 외부를 띄운다 → 시스템 Node 필요.
// 앱 자체는 Electron 내장 Node로 돌아 기본 대화·기억엔 시스템 Node가 필요 없다.
// Node 없는 사용자에게 "Connection closed" 같은 암호 에러/거짓 완료 대신 정직한 안내를 주려고 미리 감지한다.
const NODE_HELP_MSG = '이 기능은 Node.js가 필요한데, 이 컴퓨터에 아직 설치돼 있지 않은 것 같아요. https://nodejs.org 에서 LTS 버전을 설치한 뒤 Auxo를 다시 실행하면 쓸 수 있어요. (기본 대화·기억은 Node 없이도 그대로 됩니다.)';
let _nodeOk = null; // 1회 감지 후 캐시
function nodeAvailable() {
  if (_nodeOk !== null) return _nodeOk;
  try {
    const { spawnSync } = require('child_process');
    // Windows에선 npx=npx.cmd라 shell:true로 확인. 5초 넘으면 없음으로 간주.
    const r = spawnSync('npx', ['--version'], { shell: true, timeout: 5000, windowsHide: true });
    _nodeOk = !r.error && r.status === 0;
  } catch (_) { _nodeOk = false; }
  return _nodeOk;
}

/**
 * 원격(HTTP) MCP 연결. server.url 이 있으면 이 경로.
 *
 * 왜 필요한가:
 *   MCP는 ①내 PC에 설치해 쓰는 것(stdio) ②인터넷 주소로 접속해 쓰는 것(HTTP) 두 종류다.
 *   ①만 지원하면 PlayMCP 같은 원격 서버는 아예 붙일 수가 없다.
 *   ("원격은 원천 불가"로 보이기 쉬운데, 그건 mcp-remote 자동 OAuth 한 방식의 실패이고,
 *    토큰을 헤더로 직접 넣으면 표준 MCP로 정상 연결된다 — 실측 확인.)
 *   원격은 우리 PC에서 코드를 돌리지 않으므로 시스템 Node 도 필요 없다.
 *
 * Accept-Encoding: identity — 일부 게이트웨이(PlayMCP 실측)가 brotli 로 응답하면
 * 클라이언트에서 압축 해제 오류가 난다. 압축을 끄면 통한다.
 */
/**
 * 원격 MCP 서버의 토큰 갱신 주소를 표준 규격으로 찾아낸다.
 *
 * MCP 원격 서버는 인증이 없으면 401 과 함께
 *   WWW-Authenticate: Bearer resource_metadata="…/.well-known/oauth-protected-resource/…"
 * 를 준다. 그 문서의 authorization_servers 를 따라가 RFC 8414 메타데이터를 읽으면 token_endpoint 가 나온다.
 * (PlayMCP 로 전 과정 실측 — issuer 에 경로가 붙는 경우 RFC 8414 는
 *  /.well-known/oauth-authorization-server/<경로> 형태라 두 위치를 모두 시도한다.)
 * 서비스별 하드코딩 없이 규격만 따르므로 다른 원격 MCP 에도 그대로 통한다.
 */
async function discoverTokenUrl(serverUrl) {
  const get = async (u) => {
    const opt = {};
    if (AbortSignal && AbortSignal.timeout) opt.signal = AbortSignal.timeout(8000);
    const r = await fetch(u, opt);
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return r.json();
  };
  try {
    // 1) 401 의 WWW-Authenticate 에서 리소스 메타데이터 위치를 얻는다
    const probe = await fetch(serverUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Accept': 'application/json, text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'auxo', version: '0.1.0' } } }),
      ...(AbortSignal && AbortSignal.timeout ? { signal: AbortSignal.timeout(8000) } : {}),
    });
    const wa = probe.headers.get('www-authenticate') || '';
    const m = wa.match(/resource_metadata="([^"]+)"/i);
    const rmUrl = m ? m[1] : new URL('/.well-known/oauth-protected-resource', serverUrl).toString();
    const rm = await get(rmUrl);
    const issuer = (rm.authorization_servers || [])[0];
    if (!issuer) return null;

    // 2) 인증서버 메타데이터 — RFC 8414(경로 삽입형)와 OIDC 두 위치를 시도
    const iss = new URL(issuer);
    const candidates = [
      new URL(`/.well-known/oauth-authorization-server${iss.pathname === '/' ? '' : iss.pathname}`, iss.origin).toString(),
      `${issuer.replace(/\/$/, '')}/.well-known/oauth-authorization-server`,
      `${issuer.replace(/\/$/, '')}/.well-known/openid-configuration`,
    ];
    for (const c of candidates) {
      try {
        const meta = await get(c);
        if (meta && meta.token_endpoint) return meta.token_endpoint;
      } catch (_) { /* 다음 후보 */ }
    }
    return null;
  } catch (_) { return null; }
}

/**
 * refresh_token 으로 액세스 토큰을 갱신하고 설정에 저장한다.
 *
 * 왜 코드가 하나: 액세스 토큰은 짧게(PlayMCP 는 12시간) 만료되고
 * 리프레시 토큰은 길다(90일). 다른 클라이언트들은 조용히 갱신해서 사용자가 만료를 느끼지 않는다.
 * 이걸 에이전트에게 맡기면 대화 중에 "토큰이 만료됐어요"로 흐름이 끊긴다. 만료 시각 비교와
 * 갱신 요청은 판단이 아니라 절차라 코드가 할 일이다.
 * 갱신 방법을 못 찾으면 우기지 않고 실패를 알린다 → 에이전트가 사용자에게 새 토큰을 요청.
 * @returns {Promise<string|null>} 새 액세스 토큰(성공) 또는 null
 */
async function refreshRemoteToken(agentId, serverId) {
  const cfg = loadConfig(agentId);
  const srv = (cfg.servers || []).find(s => s.id === serverId);
  if (!srv || !srv.refreshToken) return null;

  let tokenUrl = srv.tokenUrl;
  if (!tokenUrl) {
    tokenUrl = await discoverTokenUrl(srv.url);
    if (!tokenUrl) return null;
    srv.tokenUrl = tokenUrl; // 다음부터는 찾지 않는다
  }

  const body = new URLSearchParams({ grant_type: 'refresh_token', refresh_token: srv.refreshToken });
  if (srv.clientId) body.set('client_id', srv.clientId);
  try {
    const opt = { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Accept': 'application/json' }, body };
    if (AbortSignal && AbortSignal.timeout) opt.signal = AbortSignal.timeout(15000);
    const r = await fetch(tokenUrl, opt);
    if (!r.ok) return null;
    const j = await r.json();
    // 표준(snake_case)과 카카오 OTT 교환 응답(중첩 tokenValue) 양쪽을 받아준다
    const access = j.access_token || (j.accessToken && j.accessToken.tokenValue);
    const newRefresh = j.refresh_token || (j.refreshToken && j.refreshToken.tokenValue);
    if (!access) return null;
    srv.headers = { ...(srv.headers || {}), Authorization: `Bearer ${access}` };
    if (newRefresh) srv.refreshToken = newRefresh; // 리프레시 토큰이 회전하는 서버도 있다
    saveConfig(agentId, cfg);
    disconnect(agentId, serverId);
    console.log(`[mcp] '${srv.name || serverId}' 액세스 토큰 자동 갱신됨`);
    return access;
  } catch (_) { return null; }
}

async function connectRemote(client, server) {
  const headers = { 'Accept-Encoding': 'identity', ...(server.headers || {}) };
  const url = new URL(server.url);
  const { StreamableHTTPClientTransport } = await import('@modelcontextprotocol/sdk/client/streamableHttp.js');
  const transport = new StreamableHTTPClientTransport(url, { requestInit: { headers } });
  try {
    await client.connect(transport);
    return transport;
  } catch (err) {
    // 구형 서버는 Streamable HTTP 대신 SSE만 지원한다 → 폴백.
    try { await transport.close(); } catch (_) {}
    const { SSEClientTransport } = await import('@modelcontextprotocol/sdk/client/sse.js');
    const sse = new SSEClientTransport(url, {
      requestInit: { headers },
      eventSourceInit: { fetch: (u, init) => fetch(u, { ...init, headers: { ...(init && init.headers), ...headers } }) },
    });
    try {
      await client.connect(sse);
      return sse;
    } catch (err2) {
      // 두 방식 다 실패 — 원문 에러를 정직하게 올린다(원인 파악이 가능하게).
      throw new Error(`${err.message} / SSE 폴백도 실패: ${err2.message}`);
    }
  }
}

async function connect(agentId, server) {
  const key = ckey(agentId, server.id);
  if (clients.has(key)) return clients.get(key);
  const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
  const client = new Client({ name: 'auxo', version: '0.1.0' }, { capabilities: {} });
  let transport;
  if (server.url) {
    try {
      transport = await connectRemote(client, server);
    } catch (err) {
      // 인증 만료(401)면 리프레시 토큰으로 조용히 갱신하고 한 번 더 — 사용자는 만료를 느끼지 않는다.
      if (/\b401\b|unauthorized/i.test(err.message) && server.refreshToken) {
        const fresh = await refreshRemoteToken(agentId, server.id);
        if (!fresh) throw new Error(`인증이 만료됐고 자동 갱신도 실패했어요. 새 토큰이 필요합니다. (${err.message})`);
        const updated = (loadConfig(agentId).servers || []).find(s => s.id === server.id) || server;
        const c2 = new Client({ name: 'auxo', version: '0.1.0' }, { capabilities: {} });
        transport = await connectRemote(c2, updated);
        const { tools: t2 } = await c2.listTools();
        const e2 = { client: c2, transport, tools: (t2 || []).map(t => ({ name: t.name, description: t.description, inputSchema: t.inputSchema })) };
        clients.set(key, e2);
        return e2;
      }
      throw err;
    }
  } else {
    // npx 기반 서버인데 시스템 Node가 없으면 정직한 안내로 실패(암호 에러 방지).
    if (String(server.command) === 'npx' && !nodeAvailable()) throw new Error(NODE_HELP_MSG);
    const { StdioClientTransport } = await import('@modelcontextprotocol/sdk/client/stdio.js');
    transport = new StdioClientTransport({ command: server.command, args: server.args || [], cwd: WORK_DIR, ...(server.env ? { env: { ...process.env, ...server.env } } : {}) });
    await client.connect(transport);
  }
  const { tools } = await client.listTools();
  const entry = { client, transport, tools: (tools || []).map(t => ({ name: t.name, description: t.description, inputSchema: t.inputSchema })) };
  clients.set(key, entry);
  return entry;
}
function disconnect(agentId, id) { const key = ckey(agentId, id); const e = clients.get(key); if (e) { try { e.client.close(); } catch (_) {} clients.delete(key); } }
/**
 * 열려 있는 MCP 연결을 **전부** 끊는다(= 자식 프로세스 종료). **종료 시점 전용.**
 *
 * ★없으면 자식이 살아남는다. 실측(2026-08-14): CLI 를 끝냈는데 `node auxo-mcp-tools.js` 가
 *   15분 넘게 떠 있었고, 그 프로세스가 부모(cli.js)까지 붙잡아 CLI 자체가 안 죽었다.
 *   앱도 같은 구조다 — 껐는데 node 가 남으면 사용자는 작업관리자를 열 줄 모르고,
 *   무엇보다 **자동 업데이트 설치 때 파일이 잠겨 실패한다** — 설치는 켤 때 하지만
 *   그 직전에 앱이 스스로 종료하므로, 자식이 남으면 그때 똑같이 막힌다.
 */
function disconnectAll() {
  let n = 0;
  for (const [key, e] of clients) {
    // ★client.close() 는 Promise 를 돌려준다. 종료 직전엔 그걸 기다려 줄 사람이 없어서
    //   자식이 살아남을 수 있다 → transport 와 자식 프로세스를 **동기로** 직접 끊는다.
    try { e.client.close(); } catch (_) {}
    try { if (e.transport && typeof e.transport.close === 'function') e.transport.close(); } catch (_) {}
    for (const p of [e.transport && e.transport._process, e.transport && e.transport.process]) {
      try { if (p && typeof p.kill === 'function' && p.exitCode === null) p.kill(); } catch (_) {}
    }
    clients.delete(key); n++;
  }
  return n;
}

/** Gemini가 받는 안전한 함수명. */
function fnName(serverId, tool) { return `mcp__${serverId}__${tool}`.replace(/[^a-zA-Z0-9_]/g, '_').slice(0, 63); }
/** MCP inputSchema → Gemini 안전 스키마(필요 필드만). */
function safeSchema(s) {
  if (!s || typeof s !== 'object' || s.type !== 'object') return { type: 'object', properties: {} };
  return { type: 'object', properties: s.properties || {}, ...(Array.isArray(s.required) ? { required: s.required } : {}) };
}

/**
 * 이 에이전트의 활성 서버 도구를 모아 function-calling decl + 라우팅표 반환. 실패 서버는 건너뜀.
 * opts.generate 를 주면 "승인이 필요한 도구"를 LLM 이 판정한다(서버별 1회, 이후 캐시).
 * 안 주거나 판정 실패면 정규식 폴백 — 승인 요구를 건너뛰는 쪽으로는 절대 새지 않는다.
 */
async function collectTools(agentId, opts = {}) {
  const decls = []; const routes = new Map();
  for (const s of listServers(agentId)) {
    if (s.enabled === false) continue;
    try {
      const e = await connect(agentId, s);
      const riskySet = await classifyRiskyTools(agentId, s, e.tools, opts.generate);
      for (const t of e.tools) {
        const fn = fnName(s.id, t.name);
        decls.push({ name: fn, description: `[MCP:${s.name}] ${t.description || t.name}`, parameters: safeSchema(t.inputSchema) });
        routes.set(fn, { agentId, id: s.id, tool: t.name, server: s.name, risky: riskySet ? riskySet.has(t.name) : isRiskyTool(t.name, t.description) });
      }
    } catch (err) { console.error(`[mcp] '${s.name}' 연결 실패:`, err.message); }
  }
  return { decls, routes };
}

/** function 이름으로 MCP 도구 호출. routes는 collectTools()가 준 표(agentId 포함). */
async function callTool(name, args, routes) {
  const r = routes && routes.get(name); if (!r) return null;
  const e = clients.get(ckey(r.agentId, r.id)); if (!e) return { error: 'MCP 연결이 없어요(서버 꺼짐?)' };
  try {
    const res = await e.client.callTool({ name: r.tool, arguments: args || {} });
    const text = (res.content || []).map(c => (c.type === 'text' ? c.text : JSON.stringify(c))).join('\n');
    console.log(`[mcp] ${name}(${JSON.stringify(args || {})}) → ok`);
    return { result: text || '(빈 결과)' };
  } catch (err) { return { error: err.message }; }
}

/** 등록 전/후 연결 테스트: 도구 목록 반환 or error. */
async function testServer(agentId, server) {
  try { const e = await connect(agentId, server); return { ok: true, tools: e.tools.map(t => t.name) }; }
  catch (err) { disconnect(agentId, server.id); return { error: err.message }; }
}

/**
 * 설치 직후 "실제로 연결되는지" 검증(타임아웃 포함). 설정 필요 서버가 조용히 안 되는 걸 잡는다.
 * → install 이 거짓 "완료"를 보고하지 않게. 연결 실패/시간초과면 {ok:false, error}.
 */
async function verifyInstalled(agentId, id, timeoutMs = 30000) {
  const srv = (loadConfig(agentId).servers || []).find(s => s.id === id);
  if (!srv) return { ok: false, error: '설치 항목을 찾을 수 없음' };
  try {
    return await Promise.race([
      testServer(agentId, srv),
      new Promise((_, rej) => setTimeout(() => rej(new Error('연결 시간 초과')), timeoutMs)),
    ]);
  } catch (e) { try { disconnect(agentId, id); } catch (_) {} return { ok: false, error: e.message }; }
}

// ── 카탈로그(원클릭 / 자율 설치 공용) — 전역(에이전트 무관). 설치 결과만 에이전트 설정으로. ──
function loadCatalog() { try { return JSON.parse(fs.readFileSync(CATALOG_PATH, 'utf8')); } catch (_) { return { servers: [] }; } }

// ── 3b: 신뢰 레지스트리(npm 공식) 확대 ────────────────────────────────────────
// MCP는 '실제 실행되는 코드' → 임의 패키지 자동설치는 금지(D2/D4: 샌드박스 전엔 신뢰출처만).
// 공식 네임스페이스 @modelcontextprotocol/* 만 발견·설치 허용(서버 20+종: filesystem·github·memory·fetch·time 등).
// 신뢰 npm 스코프(공식 조직만). 이 스코프로 올라온 서버는 검색·설치 허용, 그 외 임의 패키지는 거부.
// ⚠️ 각 스코프가 실제 그 회사 공식 소유인지 확인된 것만 추가(사칭 방지). (원격 호스팅형 공식은 카탈로그로 큐레이션.)
// 스코프가 몇 개뿐이면 사실상 대부분을 막는 셈이라 "대화로 알아서 붙인다"가 성립하지 않는다.
// 추가 기준 3가지를 전부 만족한 것만 넣는다 — npm 실조회로 확인:
//   ①npm 스코프가 그 회사 공식 GitHub org 와 일치(사칭 방지의 핵심) ②살아있는 프로젝트 ③실사용 규모
// 스코프↔org 이름이 어긋나거나(@browserbasehq↔browserbase, @e2b↔e2b-dev) 저장소 메타가 없는 건
// 같은 회사로 보여도 넣지 않았다. @cloudflare 는 npm 판이 1년 넘게 방치(원격 MCP로 이동) → 원격 경로로.
const TRUSTED_MCP_SCOPES = [
  '@modelcontextprotocol/', '@playwright/', '@notionhq/',
  '@upstash/',     // upstash/context7        · 주간 844k · 07-25
  '@supabase/',    // supabase/mcp            · 주간 119k · 07-17
  '@azure/',       // microsoft/mcp           · 주간 114k · 07-28
  '@sentry/',      // getsentry/sentry-mcp    · 주간 104k · 07-02
  '@stripe/',      // stripe/ai               · 주간  14k · 03-24
  '@heroku/',      // heroku/heroku-mcp-server· 주간   7k · 06-29
  '@mongodb-js/',  // mongodb-js/mongodb-mcp-server    · 2025-04
  '@elastic/',     // elastic/mcp-server-elasticsearch · 2025-07
];
function isTrustedPackage(name) { return TRUSTED_MCP_SCOPES.some(s => String(name || '').startsWith(s)); }

// 설정이 필요한 공식 서버 — 무설정 bare 설치하면 "연결은 되나 실제론 안 되는"(예: filesystem 경로 없음) 벽에 부딪힌다.
// 설치 전에 필요한 설정을 요구(needParams)해서 거짓 "완료"를 막는다. args=명령 인자, env=환경변수 주입.
const NEEDS_CONFIG = {
  'server-filesystem': { args: [{ key: 'path', label: '접근을 허용할 폴더 경로', required: true }] },
  'server-github': { env: 'GITHUB_PERSONAL_ACCESS_TOKEN', label: 'GitHub 액세스 토큰' },
  'server-gitlab': { env: 'GITLAB_PERSONAL_ACCESS_TOKEN', label: 'GitLab 토큰' },
  'server-slack': { env: 'SLACK_BOT_TOKEN', label: 'Slack 봇 토큰' },
  'server-google-maps': { env: 'GOOGLE_MAPS_API_KEY', label: 'Google Maps API 키' },
  'server-brave-search': { env: 'BRAVE_API_KEY', label: 'Brave Search API 키' },
  'server-postgres': { args: [{ key: 'url', label: 'PostgreSQL 접속 문자열', required: true }] },
};
function _pkgShort(pkg) { return String(pkg || '').replace(/^@[^/]+\//, ''); }
function _configParams(short) {
  const spec = NEEDS_CONFIG[short];
  if (!spec) return [];
  return spec.args ? spec.args : [{ key: 'token', label: spec.label, required: true }];
}

/** npm 레지스트리에서 신뢰 네임스페이스 MCP 서버 검색(읽기전용). 실패 시 빈 배열 → 정적 카탈로그로 degrade. */
async function searchRegistry(query, max = 6) {
  const q = String(query || '').trim();
  // 신뢰 스코프(공식 조직) 서버만 노출. 검색은 넓게 하되 isTrustedPackage + 서버성(mcp/server) 필터로 좁힌다.
  const text = q ? `${q} mcp server` : 'mcp server';
  const url = `https://registry.npmjs.org/-/v1/search?text=${encodeURIComponent(text)}&size=40`;
  try {
    const opt = { headers: { 'User-Agent': 'Auxo' } };
    if (AbortSignal && AbortSignal.timeout) opt.signal = AbortSignal.timeout(8000);
    const r = await fetch(url, opt);
    if (!r.ok) return [];
    const data = await r.json();
    // npm 은 못 찾아도 빈손으로 돌려보내지 않고 인기 패키지를 채워 준다. 그걸 그대로 넘기면
    // 에이전트는 "검색 결과"로 믿는다("깃허브" 검색에 azure 를 추천하는 사고). 그래서 우리가
    // 다시 확인한다 — 검색어가 이름·설명에 실제로 있는 것만. 없으면 빈손이 정답이다.
    // (npm 은 영문 저장소라 한글 검색어는 여기서 걸러진다. 다시 어떻게 찾을지는 에이전트가 판단한다.)
    const toks = q.toLowerCase().match(/[a-z0-9]+/g) || [];
    if (!toks.length) return [];
    return ((data && data.objects) || [])
      .map(o => o.package || {})
      // 신뢰 스코프(@modelcontextprotocol·@playwright·@notionhq…)의 실제 MCP 서버만 — sdk·client 등 비서버 제외.
      .filter(p => isTrustedPackage(p.name) && /(mcp|server)/i.test(p.name || ''))
      .filter(p => { const hay = `${p.name} ${p.description || ''}`.toLowerCase(); return toks.some(t => hay.includes(t)); })
      .slice(0, max)
      .map(p => { const short = _pkgShort(p.name); return { id: p.name, name: short, description: `${p.description || ''} (npm 공식 스코프)`.trim(), params: _configParams(short), registry: true }; });
  } catch (_) { return []; }
}

/**
 * 설치 전 사전 점검.
 *
 * 왜 필요한가:
 *   스킬은 '글'이라 AI가 읽고 SAFE/UNSAFE 를 판정할 수 있지만, MCP 는 '프로그램'이라
 *   내용 검사가 불가능하다(난독화하면 사람도 못 읽는다). 그래서 여태 방어는 '신뢰 출처'
 *   하나뿐이었는데, 스코프를 3→11 로 넓히고 원격을 개방하면서 그 방어만으론 얇아졌다.
 *   코드를 읽는 대신 **공개된 사실**(설치 스크립트·다운로드·갱신일·저장소)을 모아
 *   에이전트가 사용자에게 알리고, 사용자가 결정하게 한다.
 *
 * ⚠️ 한계: 이건 악성 코드 탐지가 아니다. 진짜 코드 검사는 샌드박스 없이는 불가능하다.
 *   여기서 하는 건 "수상한 정황을 숨기지 않고 보여주는 것"까지다.
 */
async function inspectPackage(pkgName) {
  const pkg = String(pkgName || '').trim();
  const warnings = [];
  const info = { name: pkg };
  if (!pkg) return { ok: false, warnings: ['패키지 이름이 없어요.'], info };

  const get = async (url) => {
    const opt = { headers: { 'User-Agent': 'Auxo' } };
    if (AbortSignal && AbortSignal.timeout) opt.signal = AbortSignal.timeout(8000);
    const r = await fetch(url, opt);
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return r.json();
  };

  let meta;
  try { meta = await get(`https://registry.npmjs.org/${pkg.split('/').map(encodeURIComponent).join('/')}`); }
  catch (e) {
    // 조회 실패를 조용히 넘기지 않는다 — "확인 못 했다"는 사실 자체가 사용자 판단 재료다.
    return { ok: false, warnings: [`npm 에서 정보를 확인하지 못했어요(${e.message}). 확인 없이 설치하는 셈이에요.`], info };
  }

  const latest = meta['dist-tags'] && meta['dist-tags'].latest;
  const v = (meta.versions && meta.versions[latest]) || {};
  info.version = latest;

  // ① 설치 스크립트 — 가장 중요한 위험 신호. 설치만 해도 코드가 돈다.
  const scripts = v.scripts || {};
  const risky = ['preinstall', 'install', 'postinstall'].filter(k => scripts[k]);
  if (risky.length) {
    info.installScripts = risky.map(k => `${k}: ${String(scripts[k]).slice(0, 120)}`);
    warnings.push(`설치할 때 자동 실행되는 스크립트가 있어요(${risky.join(', ')}). 설치만 해도 이 코드가 이 컴퓨터에서 실행됩니다.`);
  }

  // ② 저장소 — 공식 출처를 확인할 수 있는가
  const repo = String((v.repository && (v.repository.url || v.repository)) || '').replace(/^git\+|^ssh:\/\/git@|\.git$/g, '');
  info.repository = repo || '(없음)';
  if (!repo) warnings.push('공개 저장소 주소가 없어요. 어디서 만든 코드인지 확인할 수 없어요.');

  // ③ 갱신일 — 방치된 프로젝트인가
  const when = (meta.time && meta.time[latest]) || '';
  info.lastPublish = when.slice(0, 10);
  if (when) {
    const days = Math.floor((Date.now() - new Date(when).getTime()) / 86400000);
    info.daysSincePublish = days;
    if (days > 365) warnings.push(`${Math.floor(days / 30)}개월째 갱신이 없어요. 관리가 멈춘 프로젝트일 수 있어요.`);
  }

  // ④ 실사용 규모 — 아무도 안 쓰는 패키지인가
  try {
    const d = await get(`https://api.npmjs.org/downloads/point/last-week/${pkg}`);
    info.weeklyDownloads = d.downloads;
    if (typeof d.downloads === 'number' && d.downloads < 100) {
      warnings.push(`주간 다운로드가 ${d.downloads}회뿐이에요. 거의 쓰이지 않는 패키지예요.`);
    }
  } catch (_) { info.weeklyDownloads = null; }

  return { ok: warnings.length === 0, warnings, info };
}

/** 카탈로그 검색(읽기전용). [{id,name,description,params}] */
function searchCatalog(query) {
  const all = loadCatalog().servers || [];
  const toks = String(query || '').toLowerCase().match(/[\p{L}\p{N}@]+/gu) || [];
  const scored = all.map(s => {
    const hay = `${s.name} ${s.description} ${s.id}`.toLowerCase();
    return { entry: s, score: toks.filter(t => hay.includes(t)).length };
  });
  // 못 찾으면 빈손으로 돌려준다. 점수 0인데도 목록을 채워 보내면
  // 에이전트에게 "이게 검색 결과다"라는 거짓을 넘기게 된다. 무엇을 찾고 어떻게 다시
  // 물어볼지는 에이전트가 판단할 몫이고, 우리는 사실만 준다.
  return scored.filter(s => s.score > 0).sort((a, b) => b.score - a.score).slice(0, 6)
    .map(({ entry }) => ({ id: entry.id, name: entry.name, description: entry.description, params: entry.params || [] }));
}

/** 카탈로그 항목 설치(이 에이전트): args의 {{key}}를 params로 치환 후 등록. 필수 누락 시 needParams 반환. */
function addFromCatalog(agentId, idOrName, params = {}) {
  // 카탈로그·신뢰 패키지 설치는 전부 npx로 실행 → 시스템 Node 없으면 등록 막고 정직히 안내(죽은 서버 방지).
  if (!nodeAvailable()) return { error: NODE_HELP_MSG, needNode: true };
  const key = String(idOrName || '').trim().toLowerCase();
  const e = (loadCatalog().servers || []).find(s => s.id.toLowerCase() === key || (s.name || '').toLowerCase() === key);
  if (!e) {
    // 3b: 카탈로그에 없어도 신뢰 네임스페이스(@modelcontextprotocol/*) npm 패키지면 npx로 설치.
    //     무설정 서버(memory·fetch·time·sequential-thinking 등)는 바로 동작. 설정 필요한 건 여기서 요구(needParams).
    if (isTrustedPackage(idOrName)) {
      const pkg = String(idOrName).trim();
      const short = _pkgShort(pkg);
      const spec = NEEDS_CONFIG[short];
      const args = ['-y', pkg];
      let env;
      if (spec) {
        if (spec.args) {
          for (const a of spec.args) {
            const val = params[a.key];
            if (a.required && !String(val || '').trim()) return { error: `설정 필요: ${a.label}`, needParams: _configParams(short) };
            if (val != null && String(val).trim()) args.push(String(val));
          }
        }
        if (spec.env) {
          const val = params.token || params[spec.env] || params.value;
          if (!String(val || '').trim()) return { error: `설정 필요: ${spec.label}`, needParams: _configParams(short) };
          env = { [spec.env]: String(val) };
        }
      }
      return addServer(agentId, { id: short, name: pkg, command: 'npx', args, ...(env ? { env } : {}) });
    }
    return { error: '카탈로그에 없는 MCP: ' + idOrName };
  }
  for (const p of (e.params || [])) {
    if (p.required && !String(params[p.key] || '').trim()) return { error: `필요 입력 누락: ${p.label}`, needParams: e.params };
  }
  const args = (e.args || []).map(a => a.replace(/\{\{(\w+)\}\}/g, (_, k) => (params[k] != null ? params[k] : '')));
  let env;
  if (e.env && typeof e.env === 'object') {
    env = {};
    for (const [k, v] of Object.entries(e.env)) env[k] = String(v).replace(/\{\{(\w+)\}\}/g, (_, kk) => (params[kk] != null ? params[kk] : ''));
  }
  return addServer(agentId, { id: e.id, name: e.name, command: e.command, args, env });
}

// addFromJson(임의 MCP JSON 붙여넣기 등록)은 두지 않는다: 신뢰검사 없는 우회 통로가 된다.
// 로컬 설치형 MCP 등록은 addFromCatalog(신뢰 카탈로그) + find_mcp/install_mcp(신뢰 스코프)로만.

/**
 * 원격(HTTP) MCP 등록. 사용자가 주소를 주면 그대로 붙인다.
 *
 * 로컬 설치형과 달리 신뢰 스코프 allowlist 를 걸지 않는다
 * — 방식이 무엇이든 사용자의 에이전트가 할 수 있어야 한다. 근거: 로컬 설치형은 우리 PC에서
 * 임의 코드를 실행하지만, 원격은 우리가 지정한 주소로 HTTP 요청만 보낸다 — 위험의 성격이 다르다.
 * 대신 등록은 사용자의 명시적 승인 뒤에만 이뤄진다(에이전트가 임의로 붙이지 않는다).
 */
function addRemoteServer(agentId, { id, name, url, headers, token, refreshToken, tokenUrl, clientId } = {}) {
  const h = { ...(headers && typeof headers === 'object' ? headers : {}) };
  if (token && String(token).trim() && !h.Authorization && !h.authorization) {
    h.Authorization = /^Bearer\s/i.test(String(token).trim()) ? String(token).trim() : `Bearer ${String(token).trim()}`;
  }
  return addServer(agentId, { id, name, url, headers: h, refreshToken, tokenUrl, clientId });
}

module.exports = {
  listServers, addServer, addRemoteServer, removeServer, setEnabled, isAutoApproved, setAutoApprove, isRiskyTool,
  connect, collectTools, callTool, testServer, disconnect, disconnectAll, setConfigRoot, setCatalogPath,
  loadCatalog, searchCatalog, addFromCatalog,
  searchRegistry, isTrustedPackage, verifyInstalled, inspectPackage,
  refreshRemoteToken, discoverTokenUrl,
  __classifyRiskyTools: classifyRiskyTools,
  getWorkDir: () => WORK_DIR,
};
