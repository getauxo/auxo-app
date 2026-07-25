/**
 * mcp-manager.js — MCP 서버 등록·연결·도구발견·호출 관리 (에이전트별 격리)
 *
 * 사용자가 등록한 MCP 서버(stdio 명령)를 연결하고, 도구를 발견해
 * function-calling decl로 변환한다. 호출은 client.callTool로 라우팅.
 * SDK는 ESM이라 await import()로 로드(앱은 CommonJS).
 *
 * ★ 에이전트별 격리(2026-06-25, 마스터 "독립 정체성" 결정):
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
// 거기 저장하면 에이전트가 못 읽고 못 보내는 충돌이 난다(2026-07-15 실측). → download 로 옮긴다(보호 예외 + 읽기/전송 가능).
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

function addServer(agentId, { id: wantId, name, command, args, env }) {
  if (!command || !String(command).trim()) return { error: '실행 명령(command)이 필요해요.' };
  const cfg = loadConfig(agentId); cfg.servers = cfg.servers || [];
  // id는 영문·숫자·하이픈만 — MCP 도구명(mcp__<id>__<tool>)이 정규화될 때 깨지지 않게(구독 두뇌 사용 위해). wantId(카탈로그 영문 id) 우선.
  const base = String(wantId || name || command).toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-|-$/g, '').slice(0, 24) || 'mcp';
  let id = base, i = 1; while (cfg.servers.find(s => s.id === id)) id = `${base}-${i++}`;
  const argArr = Array.isArray(args) ? args : (args ? String(args).split(/\s+/).filter(Boolean) : []);
  const entry = { id, name: name || id, command: String(command).trim(), args: argArr, enabled: true };
  if (env && typeof env === 'object' && Object.keys(env).length) entry.env = env; // 키(API 키 등) 주입
  cfg.servers.push(entry);
  saveConfig(agentId, cfg);
  return { id, name: name || id };
}
function removeServer(agentId, id) { const cfg = loadConfig(agentId); cfg.servers = (cfg.servers || []).filter(s => s.id !== id); saveConfig(agentId, cfg); disconnect(agentId, id); return { ok: true }; }
function setEnabled(agentId, id, enabled) { const cfg = loadConfig(agentId); const s = (cfg.servers || []).find(x => x.id === id); if (s) { s.enabled = enabled; saveConfig(agentId, cfg); } if (!enabled) disconnect(agentId, id); return { ok: true }; }

// 서버 신뢰(위험도구 자동 승인) 여부
function isAutoApproved(agentId, id) { const s = (loadConfig(agentId).servers || []).find(x => x.id === id); return !!(s && s.autoApprove); }
function setAutoApprove(agentId, id, val) { const cfg = loadConfig(agentId); const s = (cfg.servers || []).find(x => x.id === id); if (s) { s.autoApprove = !!val; saveConfig(agentId, cfg); } return { ok: true }; }

// 위험 도구 판별(휴리스틱): 쓰기·삭제·전송·실행류는 승인 필요. 읽기·조회류는 자유.
const RISKY_RE = /(write|delete|remove|create|update|edit|modify|move|rename|put|post|send|email|exec|execute|run|spawn|install|push|publish|deploy|drop|insert|append|set[_-]|kill|terminate|payment|pay|transfer)/i;
function isRiskyTool(name, desc) { return RISKY_RE.test(String(name || '')) || RISKY_RE.test(String(desc || '')); }

/** 에이전트별 연결 풀 키. */
function ckey(agentId, serverId) { return `${String(agentId || '_shared')}::${serverId}`; }

async function connect(agentId, server) {
  const key = ckey(agentId, server.id);
  if (clients.has(key)) return clients.get(key);
  const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
  const { StdioClientTransport } = await import('@modelcontextprotocol/sdk/client/stdio.js');
  const transport = new StdioClientTransport({ command: server.command, args: server.args || [], cwd: WORK_DIR, ...(server.env ? { env: { ...process.env, ...server.env } } : {}) });
  const client = new Client({ name: 'auxo', version: '0.1.0' }, { capabilities: {} });
  await client.connect(transport);
  const { tools } = await client.listTools();
  const entry = { client, transport, tools: (tools || []).map(t => ({ name: t.name, description: t.description, inputSchema: t.inputSchema })) };
  clients.set(key, entry);
  return entry;
}
function disconnect(agentId, id) { const key = ckey(agentId, id); const e = clients.get(key); if (e) { try { e.client.close(); } catch (_) {} clients.delete(key); } }

/** Gemini가 받는 안전한 함수명. */
function fnName(serverId, tool) { return `mcp__${serverId}__${tool}`.replace(/[^a-zA-Z0-9_]/g, '_').slice(0, 63); }
/** MCP inputSchema → Gemini 안전 스키마(필요 필드만). */
function safeSchema(s) {
  if (!s || typeof s !== 'object' || s.type !== 'object') return { type: 'object', properties: {} };
  return { type: 'object', properties: s.properties || {}, ...(Array.isArray(s.required) ? { required: s.required } : {}) };
}

/** 이 에이전트의 활성 서버 도구를 모아 function-calling decl + 라우팅표 반환. 실패 서버는 건너뜀. */
async function collectTools(agentId) {
  const decls = []; const routes = new Map();
  for (const s of listServers(agentId)) {
    if (s.enabled === false) continue;
    try {
      const e = await connect(agentId, s);
      for (const t of e.tools) {
        const fn = fnName(s.id, t.name);
        decls.push({ name: fn, description: `[MCP:${s.name}] ${t.description || t.name}`, parameters: safeSchema(t.inputSchema) });
        routes.set(fn, { agentId, id: s.id, tool: t.name, server: s.name, risky: isRiskyTool(t.name, t.description) });
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
const TRUSTED_MCP_SCOPES = ['@modelcontextprotocol/'];
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
  // npm 검색: scope: 한정자 단독은 빈 결과라 불안정 → org명을 텍스트로 준다(실측). 그럼 공식 패키지가 상위에 온다.
  const text = q ? `modelcontextprotocol ${q}` : 'modelcontextprotocol server';
  const url = `https://registry.npmjs.org/-/v1/search?text=${encodeURIComponent(text)}&size=40`;
  try {
    const opt = { headers: { 'User-Agent': 'Auxo' } };
    if (AbortSignal && AbortSignal.timeout) opt.signal = AbortSignal.timeout(8000);
    const r = await fetch(url, opt);
    if (!r.ok) return [];
    const data = await r.json();
    return ((data && data.objects) || [])
      .map(o => o.package || {})
      // 실제 설치형 서버(@modelcontextprotocol/server-*)만 노출 — sdk·inspector·client 등 비서버 패키지 제외.
      .filter(p => /^@modelcontextprotocol\/server-/.test(p.name || ''))
      .slice(0, max)
      .map(p => { const short = _pkgShort(p.name); return { id: p.name, name: short, description: `${p.description || ''} (npm 공식·@modelcontextprotocol)`.trim(), params: _configParams(short), registry: true }; });
  } catch (_) { return []; }
}

/** 카탈로그 검색(읽기전용). [{id,name,description,params}] */
function searchCatalog(query) {
  const all = loadCatalog().servers || [];
  const toks = String(query || '').toLowerCase().match(/[\p{L}\p{N}@]+/gu) || [];
  const scored = all.map(s => {
    const hay = `${s.name} ${s.description} ${s.id}`.toLowerCase();
    return { entry: s, score: toks.filter(t => hay.includes(t)).length };
  });
  const hits = scored.filter(s => s.score > 0).sort((a, b) => b.score - a.score);
  return (hits.length ? hits : scored).slice(0, 6)
    .map(({ entry }) => ({ id: entry.id, name: entry.name, description: entry.description, params: entry.params || [] }));
}

/** 카탈로그 항목 설치(이 에이전트): args의 {{key}}를 params로 치환 후 등록. 필수 누락 시 needParams 반환. */
function addFromCatalog(agentId, idOrName, params = {}) {
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

/** 표준 MCP JSON 붙여넣기 등록(이 에이전트). {mcpServers:{name:{command,args}}} / {name:{...}} / {command,args} 허용. */
function addFromJson(agentId, text) {
  let obj; try { obj = JSON.parse(text); } catch (e) { return { error: 'JSON 파싱 실패: ' + e.message }; }
  const root = obj.mcpServers || obj.servers || obj;
  const added = [];
  if (root && root.command) {
    added.push(addServer(agentId, { name: root.name || 'mcp', command: root.command, args: root.args }));
  } else if (root && typeof root === 'object') {
    for (const [name, cfg] of Object.entries(root)) {
      if (cfg && cfg.command) added.push(addServer(agentId, { name, command: cfg.command, args: cfg.args }));
    }
  }
  if (!added.length) return { error: '유효한 서버 설정(command 포함)을 찾지 못했어요.' };
  return { added };
}

module.exports = {
  listServers, addServer, removeServer, setEnabled, isAutoApproved, setAutoApprove, isRiskyTool,
  connect, collectTools, callTool, testServer, disconnect, setConfigRoot, setCatalogPath,
  loadCatalog, searchCatalog, addFromCatalog, addFromJson,
  searchRegistry, isTrustedPackage, verifyInstalled,
  getWorkDir: () => WORK_DIR,
};
