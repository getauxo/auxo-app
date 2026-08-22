/**
 * storage.js — 로컬 SQLite 기반 저장소 (JSON→SQLite 이관)
 *
 * 이전: userData/auxo-data.json 단일 파일을 매 저장마다 통째 read-modify-write.
 * 지금: userData/auxo.db (node-sqlite3-wasm). 버킷별 테이블 → 관련 행만 R/W.
 *   - 라이브러리 = node-sqlite3-wasm(WASM): ABI 무관 → node(CLI·봇)·electron(앱)·전 OS 한 아티팩트로 동작.
 *     (네이티브 better-sqlite3는 node↔electron ABI 충돌 → 배포 견고성 위해 wasm 선택. WAL 미지원은
 *      감수 — 단일 사용자 데스크톱 + 프로세스내 runExclusive + append INSERT 로 실사용 안전.)
 *   - 핫 데이터(agents·facts·episodes·messages·summaries) = SQLite.
 *   - 메시지 임베딩 캐시(msgemb)는 여전히 archives/<id>.msgemb.json 파일(핫 아님·캐시·정밀도 보존).
 *
 * ★불변 원칙: 기억 알고리즘은 안 건드린다. 이 파일(그릇)만 교체.
 *   공개 함수 시그니처를 100% 유지 → 소비처 무변경. loadAgent 가 기존과 '동일한 객체'를 재조립해 반환.
 * ★이관 정책: 전원 fresh-start. 옛 JSON 임포트 없음 → *.pre-sqlite.bak 으로 물러남.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { Database } = require('node-sqlite3-wasm');

const DB_FILE = 'auxo.db';
const LEGACY_JSON = ['auxo-data.json'];

let db = null;
let dbPath = null;
let archiveDir = null;

function _requireDb() { if (!db) throw new Error('storage not initialized'); return db; }

/** 다중 문장 트랜잭션(수동 — wasm엔 db.transaction 헬퍼 없음). */
function _tx(fn) {
  db.exec('BEGIN');
  try { const r = fn(); db.exec('COMMIT'); return r; }
  catch (e) { try { db.exec('ROLLBACK'); } catch (_) {} throw e; }
}

function _retireLegacyJson(userDataPath) {
  for (const name of LEGACY_JSON) {
    const p = path.join(userDataPath, name);
    try {
      if (fs.existsSync(p)) {
        const bak = p + '.pre-sqlite.bak';
        if (!fs.existsSync(bak)) fs.renameSync(p, bak);
      }
    } catch (_) { /* 물러나기 실패해도 무해(임포트 안 함) */ }
  }
}

function _createSchema() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT);
    CREATE TABLE IF NOT EXISTS agents (id TEXT PRIMARY KEY, uid TEXT, data TEXT);
    CREATE TABLE IF NOT EXISTS facts (agent_id TEXT, fact_id TEXT, data TEXT);
    CREATE INDEX IF NOT EXISTS ix_facts_agent ON facts(agent_id);
    CREATE TABLE IF NOT EXISTS episodes (agent_id TEXT, summary_lc TEXT, data TEXT,
      PRIMARY KEY (agent_id, summary_lc));
    CREATE TABLE IF NOT EXISTS messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      agent_id TEXT, archived INTEGER DEFAULT 0, data TEXT);
    CREATE INDEX IF NOT EXISTS ix_msg_agent ON messages(agent_id, archived, id);
    CREATE TABLE IF NOT EXISTS summaries (agent_id TEXT PRIMARY KEY, summary TEXT);
    CREATE TABLE IF NOT EXISTS msg_vec (
      agent_id TEXT, msg_id INTEGER, model TEXT,
      ts INTEGER, role TEXT, snippet TEXT, files TEXT, vec BLOB,
      PRIMARY KEY (agent_id, msg_id));
    CREATE INDEX IF NOT EXISTS ix_msgvec_agent ON msg_vec(agent_id, model);
    -- ★도구 호출 장부. "했다고 말했는데 실제로 불렀나"를 대조하는 데 쓴다.
    --   구독 두뇌는 도구가 **별도 프로세스(auxo-mcp-tools)**에서 돌아 엔진이 호출을 못 본다.
    --   두 프로세스가 같은 DB를 쓰므로, 여기 남기면 엔진이 턴 끝에 읽을 수 있다.
    --   append-only 라 프로세스가 겹쳐도 서로 덮어쓰지 않는다(agents 레코드에 넣으면 lost update).
    CREATE TABLE IF NOT EXISTS tool_calls (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      agent_id TEXT, ts INTEGER, name TEXT, ok INTEGER);
    CREATE INDEX IF NOT EXISTS ix_toolcalls_agent ON tool_calls(agent_id, ts);

    -- 정직 계층 판정 장부 (2026-08-22)
    --   판정은 지금까지 **화면 콘솔로만** 나가고 아무 데도 안 남았다. 배포된 앱에서는 그대로 사라진다.
    --   그래서 "얼마나 헛짚었나 / 되돌림이 통했나"를 나중에 볼 방법이 없었다.
    --   ★사용자에게 붙이던 안내 문구를 **화면에서 뺀 대신**(codex 자기 셸을 열면 장부가 비어
    --     멀쩡히 한 일도 "안 했다"로 찍혀 답이 스스로를 부정했다) 여기에 남긴다.
    --   ⚠️ 이 기록은 **이 PC 밖으로 나가지 않는다.** 우리가 이 PC 에서 읽을 때만 쓴다.
    CREATE TABLE IF NOT EXISTS claim_checks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      agent_id TEXT, ts INTEGER,
      reason TEXT,      -- 'request'(요청 기준) | 'claim'(완료 주장 기준)
      kind TEXT,        -- file|schedule|search|shell|other  (요청 기준일 때)
      claims TEXT,      -- 완료 주장 목록(주장 기준일 때)
      retried INTEGER,  -- 되돌림 횟수
      resolved INTEGER, -- 끝내 도구를 불렀나(1) 아닌가(0)
      brain TEXT, allow_shell INTEGER);   -- 판정을 못 믿는 조합인지 나중에 가르려고
    CREATE INDEX IF NOT EXISTS ix_claimchecks_agent ON claim_checks(agent_id, ts);
  `);
}

// ── 스키마 버전 관리 ─────────────────────────────────────────────────────────
// ★schema_version 은 **쓰기만 하고 읽지 않으면 아무 소용이 없다.**
//   그래서 아래 두 가지를 막을 수단이 없었다:
//     ① 사용자가 옛 버전 앱을 다시 실행하면, 옛 코드가 새 구조 DB 를 열고
//        자기가 모르는 필드를 버린 채 저장한다 → **에러 없이 기억만 조용히 깎인다.**
//        (같은 모양이 실제로 난 적 있다 — 정리 로직이 감정·safety·scope 를 버렸고 로그에도 안 남았다)
//     ② 구조를 바꿔도 이관 전 백업이 없어 되돌릴 수단이 없다.
//   → 버전을 **읽고**, 앱보다 데이터가 새것이면 **열지 않고 정직하게 알리고**,
//     올려야 하면 **먼저 백업하고** 올린다.
const SCHEMA_VERSION = 2;

// from → to 로 올릴 때 할 일. 데이터 변경이 없으면 빈 함수라도 남겨 "그 단계를 거쳤음"을 명시한다.
const MIGRATIONS = {
  // 1 → 2 : 통짜 그릇(agents.data.userMemory)·도구 호출 장부(tool_calls) 도입 시점을 기준선으로 기록.
  //   테이블은 CREATE TABLE IF NOT EXISTS 로 이미 만들어지므로 옮길 데이터는 없다.
  //   버전을 처음 세는 지점이라, 여기서 백업이 한 번 남는 것 자체가 목적이다.
  1: () => {},
};

/** 저장된 버전. 기록이 없으면 null(=새 DB 또는 버전 이전 시절). */
function _readVersion() {
  try {
    const r = db.get("SELECT v FROM meta WHERE k='schema_version'");
    const n = r && Number(r.v);
    return Number.isFinite(n) && n > 0 ? n : null;
  } catch (_) { return null; }
}
function _writeVersion(v) {
  db.run("INSERT INTO meta(k,v) VALUES('schema_version',?) ON CONFLICT(k) DO UPDATE SET v=excluded.v", [String(v)]);
}

/* ── 지금 이 에이전트가 어느 창구에서 대화 중인가 ─────────────────────────
 * 왜 저장소에 두나 (2026-08-20):
 *   예약 알림이 **어느 채널에서 걸든 항상 앱으로만** 갔다. 텔레그램에서 걸어도 앱으로 갔다.
 *   원인 = 예약을 만들 때 채널 정보가 아예 전달되지 않아 기본값 'app' 으로 저장된 것.
 *   ★그런데 **구독 두뇌(claude·codex)는 MCP 가 별도 프로세스**라 메모리를 공유할 수 없고,
 *     게이트웨이는 상시 유지라 환경변수로도 턴마다 바뀌는 값을 못 넘긴다.
 *   → 두 경로(REST · MCP 별도 프로세스)가 **함께 보는 곳은 저장소뿐**이라 여기에 둔다.
 * 성격: 휘발성 힌트다. 없으면 'app' 으로 친다(기존 동작과 같음).
 */
function setActiveChannel(agentId, channel) {
  if (!agentId || !channel) return;
  try {
    db.run("INSERT INTO meta(k,v) VALUES(?,?) ON CONFLICT(k) DO UPDATE SET v=excluded.v",
      ['active_channel:' + agentId, String(channel)]);
  } catch (_) {}
}
function getActiveChannel(agentId) {
  if (!agentId) return '';
  try {
    const r = db.get('SELECT v FROM meta WHERE k=?', ['active_channel:' + agentId]);
    return (r && r.v) ? String(r.v) : '';
  } catch (_) { return ''; }
}

/** 이관 전 원본 그대로 한 벌 남긴다. 최근 3개만 유지(무한히 쌓이면 그것대로 문제). */
function _backupBeforeMigrate(from) {
  let bak = null;
  try {
    try { db.close(); } catch (_) {}
    db = null;
    const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
    // 초 단위라 같은 초에 두 번 돌면 이름이 겹친다 → 겹치면 번호를 붙인다.
    // (겹칠 때 그냥 건너뛰면 "백업했다"고 하면서 실제로는 앞의 것만 남는다 = 조용한 실패)
    bak = `${dbPath}.v${from}-${stamp}.bak`;
    for (let i = 2; fs.existsSync(bak) && i < 100; i++) bak = `${dbPath}.v${from}-${stamp}-${i}.bak`;
    fs.copyFileSync(dbPath, bak);
    const dir = path.dirname(dbPath);
    const olds = fs.readdirSync(dir)
      .filter((f) => f.startsWith(DB_FILE + '.v') && f.endsWith('.bak'))
      .sort();
    for (const f of olds.slice(0, Math.max(0, olds.length - 3))) {
      try { fs.unlinkSync(path.join(dir, f)); } catch (_) {}
    }
  } catch (e) {
    // 백업에 실패하면 이관하지 않는다 — 되돌릴 수단 없이 구조를 바꾸는 게 더 위험하다.
    const err = new Error(
      '기억 데이터를 백업하지 못해 업데이트를 멈췄습니다.\n' +
      '디스크 공간이나 파일 권한을 확인해 주세요.\n\n' + `(${e.message})`);
    err.code = 'DB_BACKUP_FAILED';
    throw err;
  } finally {
    if (!db) {
      db = new Database(dbPath);
      try { db.exec('PRAGMA foreign_keys=ON'); db.exec('PRAGMA busy_timeout=5000'); } catch (_) {}
    }
  }
  return bak;
}

/**
 * 버전을 맞춘다. 세 갈래뿐이다.
 *   같다 → 아무것도 안 한다 / 데이터가 더 새것 → 열지 않는다 / 앱이 더 새것 → 백업하고 올린다
 * @param {number|null} found  기존 DB 에 적혀 있던 버전(새 DB 면 null)
 * @param {boolean} existed    이번 실행 전에 DB 파일이 있었나
 */
function _guardTooNew(found, existed) {
  if (!existed || found === null || found <= SCHEMA_VERSION) return;
  // 앱이 데이터보다 옛것. 열어서 쓰면 모르는 필드를 버린 채 저장하게 된다 → 손대기 전에 멈춘다.
  try { db.close(); } catch (_) {}
  db = null;
  const err = new Error(
    '이 기억 데이터는 더 새로운 버전의 Auxo 에서 만들어졌습니다.\n' +
    '지금 버전으로 열면 기억이 손상될 수 있어 열지 않았습니다.\n\n' +
    '최신 버전 Auxo 를 설치하면 그대로 이어서 쓸 수 있습니다.\n' +
    `(데이터 v${found} / 이 앱 v${SCHEMA_VERSION})`);
  err.code = 'DB_TOO_NEW';
  err.dataVersion = found;
  err.appVersion = SCHEMA_VERSION;
  throw err;
}

function _migrate(found, existed) {
  if (!existed) { _writeVersion(SCHEMA_VERSION); return; }
  // 기록이 없는 기존 DB = 버전을 세기 전(v1) 시절 것.
  const from = found === null ? 1 : found;
  if (from === SCHEMA_VERSION) { _writeVersion(SCHEMA_VERSION); return; }

  const bak = _backupBeforeMigrate(from);
  console.log(`[storage] 기억 데이터 v${from} → v${SCHEMA_VERSION} 이관. 백업: ${bak}`);
  for (let v = from; v < SCHEMA_VERSION; v++) {
    const step = MIGRATIONS[v];
    if (!step) throw new Error(`기억 데이터 v${v} → v${v + 1} 이관 절차가 없습니다.`);
    step();
  }
  _writeVersion(SCHEMA_VERSION);
}

function init(userDataPath) {
  if (!fs.existsSync(userDataPath)) fs.mkdirSync(userDataPath, { recursive: true });
  dbPath = path.join(userDataPath, DB_FILE);
  archiveDir = path.join(userDataPath, 'archives');
  _retireLegacyJson(userDataPath);
  const existed = fs.existsSync(dbPath);
  db = new Database(dbPath);
  try { db.exec('PRAGMA foreign_keys=ON'); db.exec('PRAGMA busy_timeout=5000'); } catch (_) {}
  // 순서가 중요하다: 읽고 → (열면 안 되면 여기서 멈추고) → 스키마 → 이관.
  // 열면 안 되는 DB 를 CREATE 로 먼저 건드리지 않는다.
  const found = existed ? _readVersion() : null;
  _guardTooNew(found, existed);
  _createSchema();
  _migrate(found, existed);
  try { require('./fs-tools').setDownloadDir(path.join(userDataPath, 'download')); } catch (_) {}
  try { require('./fs-tools').setProtectedDataPaths([userDataPath]); } catch (_) {}
  // ★장부 정리는 **여기서** 한다 — 앱을 켤 때 한 번. 턴마다 지우면 쓸데없는 쓰기가 늘고,
  //   호출자에게 맡기면 아무도 안 부른다(pruneToolCalls 가 실제로 그랬다 — 죽은 코드였다).
  pruneLedgers();
}

/**
 * 터미널 채널(CLI·텔레그램·디스코드·구독 도구 프로세스)의 진입점용.
 * 앱은 창을 띄울 수 있어 init 을 직접 부르고 dialog 로 알린다.
 * 여기서는 스택 대신 **사람이 읽을 문장만** 보여 주고 멈춘다 — 채널이 달라도 판정과 문장은 같다.
 */
function initOrExit(userDataPath) {
  try { init(userDataPath); }
  catch (e) {
    console.error('\n❌ Auxo 를 시작할 수 없습니다\n');
    console.error((e && e.message ? e.message : String(e)) + '\n');
    process.exit(1);
  }
}

// ── 신원(uid)·키링 멱등 보정(원본 동작 그대로) ──
function _ensureIdentity(agent) {
  if (!agent) return agent;
  if (!agent.uid || typeof agent.uid !== 'string') agent.uid = 'auxo-' + crypto.randomUUID();
  return agent;
}
function _ensureKeyring(agent) {
  if (!agent) return agent;
  if (!agent.apiKeys || typeof agent.apiKeys !== 'object') {
    agent.apiKeys = {};
    if (agent.brainMode && agent.apiKey) agent.apiKeys[agent.brainMode] = agent.apiKey;
  }
  if (!agent.models || typeof agent.models !== 'object') {
    agent.models = {};
    if (agent.brainMode && agent.model) agent.models[agent.brainMode] = agent.model;
  }
  return agent;
}

// ── 에이전트 ──
//   기억 그릇(userMemory/refMemory)은 통짜 글이라 agents.data 안에 그대로 들어간다.
//   facts 테이블은 통짜 전환 전 낡은 낱개 기억을 읽어들이기 위해 남아 있다(첫 실행에 흡수 후 빈다).
//   saveAgent 는 episodes 를 건드리지 않는다(addEpisodes 가 소유 → 라운드트립 유실 없음).
function saveAgent(agent) {
  _requireDb();
  _ensureIdentity(agent);
  const facts = Array.isArray(agent.humanFacts) ? agent.humanFacts : [];
  const rest = { ...agent };
  delete rest.humanFacts;
  delete rest.episodes;
  _tx(() => {
    db.run('INSERT INTO agents(id,uid,data) VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET uid=excluded.uid, data=excluded.data',
      [agent.id, agent.uid || null, JSON.stringify(rest)]);
    db.run('DELETE FROM facts WHERE agent_id=?', [agent.id]);
    const ins = db.prepare('INSERT INTO facts(agent_id,fact_id,data) VALUES(?,?,?)');
    try { facts.forEach((f, i) => ins.run([agent.id, String((f && f.id) || ('idx-' + i)), JSON.stringify(f)])); }
    finally { ins.finalize(); }
  });
}

function _assembleAgent(row) {
  if (!row) return null;
  const agent = JSON.parse(row.data);
  agent.humanFacts = db.all('SELECT data FROM facts WHERE agent_id=? ORDER BY rowid', [agent.id]).map(r => JSON.parse(r.data));
  agent.episodes = db.all('SELECT data FROM episodes WHERE agent_id=? ORDER BY rowid', [agent.id]).map(r => JSON.parse(r.data));
  return _ensureIdentity(_ensureKeyring(agent));
}
function loadAgent(id) {
  _requireDb();
  return _assembleAgent(db.get('SELECT data FROM agents WHERE id=?', [id]));
}
function loadAllAgents() {
  _requireDb();
  return db.all('SELECT id FROM agents').map(r => loadAgent(r.id));
}

// ── 활성 대화(messages archived=0) ──
function saveConversation(agentId, messages) {
  _requireDb();
  _tx(() => {
    db.run('DELETE FROM messages WHERE agent_id=? AND archived=0', [agentId]);
    const ins = db.prepare('INSERT INTO messages(agent_id,archived,data) VALUES(?,0,?)');
    try { for (const m of (messages || [])) ins.run([agentId, JSON.stringify(m)]); }
    finally { ins.finalize(); }
  });
}
function loadConversation(agentId) {
  _requireDb();
  return db.all('SELECT data FROM messages WHERE agent_id=? AND archived=0 ORDER BY id', [agentId]).map(r => JSON.parse(r.data));
}
/** 메시지 덧붙이기(INSERT) — 옛 통째덮어쓰기 lost-update 근본 회피. @returns 전체 활성 대화 */
/**
 * 도구 호출을 장부에 남긴다(append-only).
 * ★왜 필요한가: 두뇌가 도구를 안 부르고 "지웠습니다"라고 답하는 일을
 *   코드가 잡으려면 "이번 턴에 뭘 불렀나"가 있어야 한다. 구독 두뇌는 도구가 별도
 *   프로세스에서 돌아 엔진이 못 보므로, 양쪽이 같은 DB의 이 표에 남긴다.
 */
function recordToolCall(agentId, name, ok = true) {
  _requireDb();
  if (!agentId || !name) return;
  try { db.run('INSERT INTO tool_calls(agent_id,ts,name,ok) VALUES(?,?,?,?)', [agentId, Date.now(), String(name), ok ? 1 : 0]); }
  catch (_) { /* 장부 실패가 대화를 막지 않는다 */ }
}

/**
 * 정직 계층 판정을 장부에 남긴다.
 *
 * ★왜 (2026-08-22): 판정은 여태 console.warn 으로만 나갔다 — 배포된 앱에서는 **아무 데도 안 남는다.**
 *   사용자에게 붙이던 안내 문구를 화면에서 뺐으므로(engine 주석 참고), 남는 흔적이 여기뿐이다.
 *   이 기록으로 나중에 **"헛짚은 비율 / 되돌림이 통한 비율"** 을 실제 사용에서 잴 수 있다.
 * ⚠️ 이 PC 밖으로 나가지 않는다. 전송하는 코드는 없다.
 */
function recordClaimCheck(agentId, r = {}) {
  _requireDb();
  if (!agentId) return;
  try {
    db.run('INSERT INTO claim_checks(agent_id,ts,reason,kind,claims,retried,resolved,brain,allow_shell) VALUES(?,?,?,?,?,?,?,?,?)',
      [agentId, Date.now(), String(r.reason || ''), String(r.kind || ''),
        JSON.stringify(r.claims || []), Number(r.retried || 0),
        r.resolved ? 1 : 0, String(r.brain || ''), r.allowShell ? 1 : 0]);
  } catch (_) { /* 장부 실패가 대화를 막지 않는다 */ }
}

/** 특정 시각 이후 이 에이전트가 부른 도구 이름들(중복 제거). 턴 경계는 호출자가 ts 로 정한다. */
function toolCallsSince(agentId, sinceTs) {
  _requireDb();
  try {
    // ★**성공한 호출만** 돌려준다. 실패한 호출을 "했다"의 근거로 쓰면
    //   *"알림 걸어놨어요"* 라고 해놓고 실제로는 인자가 틀려 실패한 턴이 통과한다(실측).
    //   사용자에겐 안 한 것과 똑같다 — 오히려 시각·내용까지 들어서 더 믿게 된다.
    const rows = db.all('SELECT name FROM tool_calls WHERE agent_id=? AND ts>=? AND ok=1 ORDER BY id', [agentId, Number(sinceTs) || 0]);
    return [...new Set(rows.map(r => r.name))];
  } catch (_) { return []; }
}

/**
 * 이번 턴에 도구를 **부르기라도 했나** — 성공·실패를 가리지 않는다.
 *
 * ★`toolCallsSince` 와 **묻는 것이 다르다.** 헷갈리면 안 된다.
 *   · `toolCallsSince` (ok=1 만)  → *"했다고 말한 게 진짜인가"*
 *       실패를 근거로 쓰면 *"알림 걸어놨어요"* 인데 인자가 틀려 실패한 턴이 통과한다.
 *   · `toolAttemptsSince` (전부)  → *"아예 시도조차 안 했나"*
 *       도구를 불렀다가 **권한에 막힌 것은 정직한 행동**이다. 그걸 되돌리면 오탐이다.
 *       (2026-08-20 사고의 세 번째 턴이 정확히 그것 — make_dir FAIL 이지만 에이전트는 옳게 행동했다)
 */
function toolAttemptsSince(agentId, sinceTs) {
  _requireDb();
  try {
    const rows = db.all('SELECT name FROM tool_calls WHERE agent_id=? AND ts>=? ORDER BY id', [agentId, Number(sinceTs) || 0]);
    return [...new Set(rows.map(r => r.name))];
  } catch (_) { return []; }
}

/** 장부가 무한히 자라지 않게 오래된 것을 지운다(기본 3일). 특정 에이전트만. */
function pruneToolCalls(agentId, keepMs = 3 * 24 * 60 * 60 * 1000) {
  _requireDb();
  try { db.run('DELETE FROM tool_calls WHERE agent_id=? AND ts < ?', [agentId, Date.now() - keepMs]); } catch (_) {}
}

/**
 * 장부 두 개(tool_calls · claim_checks)에서 오래된 것을 **모든 에이전트에 대해** 지운다.
 *
 * ★왜 이걸 따로 만드나 (2026-08-22):
 *   `pruneToolCalls` 는 **만들어만 놓고 부르는 곳이 한 군데도 없었다.** 죽은 코드였다.
 *   그래서 도구 장부는 처음부터 지금까지 **한 번도 정리된 적이 없다.**
 *   정리 함수가 있다는 사실이 "정리되고 있다"는 착각을 만들었다 —
 *   **배선되지 않은 안전장치는 없는 것과 같다.**
 *   claim_checks 를 새로 만들면서 같은 실수를 반복할 뻔했다.
 *
 *   에이전트별로 부르게 두면 **호출자가 모든 에이전트를 훑어야** 해서 또 빠뜨린다.
 *   그래서 여기서 한 번에 지우고, init 에서 한 줄로 부른다.
 *
 * 보관 기간: 도구 장부 3일(턴 대조용이라 그 이상 필요 없다) / 판정 장부 30일(추세를 봐야 한다).
 */
function pruneLedgers(toolKeepMs = 3 * 24 * 60 * 60 * 1000, claimKeepMs = 30 * 24 * 60 * 60 * 1000) {
  if (!db) return;
  const now = Date.now();
  try { db.run('DELETE FROM tool_calls WHERE ts < ?', [now - toolKeepMs]); } catch (_) {}
  try { db.run('DELETE FROM claim_checks WHERE ts < ?', [now - claimKeepMs]); } catch (_) {}
}

function appendMessages(agentId, newMessages) {
  _requireDb();
  if (!Array.isArray(newMessages) || !newMessages.length) return loadConversation(agentId);
  _tx(() => {
    const ins = db.prepare('INSERT INTO messages(agent_id,archived,data) VALUES(?,0,?)');
    try { for (const m of newMessages) ins.run([agentId, JSON.stringify(m)]); }
    finally { ins.finalize(); }
  });
  return loadConversation(agentId);
}

// ── 대화 요약 ──
function saveConversationSummary(agentId, summary) {
  _requireDb();
  db.run('INSERT INTO summaries(agent_id,summary) VALUES(?,?) ON CONFLICT(agent_id) DO UPDATE SET summary=excluded.summary',
    [agentId, String(summary || '')]);
}
function loadConversationSummary(agentId) {
  _requireDb();
  const r = db.get('SELECT summary FROM summaries WHERE agent_id=?', [agentId]);
  return (r && r.summary) || '';
}

// ── 아카이브(messages archived=1) ──
function appendArchivedMessages(agentId, messages) {
  _requireDb();
  if (!Array.isArray(messages) || !messages.length) return;
  _tx(() => {
    const ins = db.prepare('INSERT INTO messages(agent_id,archived,data) VALUES(?,1,?)');
    try { for (const m of messages) ins.run([agentId, JSON.stringify(m)]); }
    finally { ins.finalize(); }
  });
}
function loadArchivedMessages(agentId) {
  _requireDb();
  return db.all('SELECT data FROM messages WHERE agent_id=? AND archived=1 ORDER BY id', [agentId]).map(r => JSON.parse(r.data));
}
/**
 * 활성 대화의 오래된 앞 count개를 아카이브로 전환(archived=1). **id 불변**(삭제+재삽입 아님).
 * 압축(compress) 전용 — 삭제+재삽입의 id-churn 이 벡터저장소(msg_vec) 고아행을 만들던 문제를 근본 차단.
 */
function archiveOldestActive(agentId, count) {
  _requireDb();
  if (!count || count < 1) return;
  db.run('UPDATE messages SET archived=1 WHERE id IN (SELECT id FROM messages WHERE agent_id=? AND archived=0 ORDER BY id LIMIT ?)', [agentId, count]);
}
function loadArchivedPage(agentId, opts = {}) {
  const offset = Math.max(0, opts.offset || 0);
  const limit = Math.max(1, opts.limit || 50);
  const all = loadArchivedMessages(agentId) || [];
  const end = Math.max(0, all.length - offset);
  const start = Math.max(0, end - limit);
  return { messages: all.slice(start, end), remaining: start };
}
/** 두뇌 프롬프트용 창: head(맨 앞 headLines) + tail(최근 ~tailBytes) + truncated. 부분 읽기. */
function loadArchivedWindow(agentId, opts = {}) {
  _requireDb();
  const headLines = opts.headLines != null ? opts.headLines : 2;
  const tailBytes = opts.tailBytes != null ? opts.tailBytes : 300000;
  const total = (db.get('SELECT COALESCE(SUM(LENGTH(data)),0) AS b FROM messages WHERE agent_id=? AND archived=1', [agentId]) || {}).b || 0;
  if (total <= tailBytes) {
    return { head: [], tail: loadArchivedMessages(agentId), truncated: false };
  }
  const head = db.all('SELECT data FROM messages WHERE agent_id=? AND archived=1 ORDER BY id LIMIT ?', [agentId, headLines]).map(r => JSON.parse(r.data));
  const tailRev = [];
  let used = 0;
  const st = db.prepare('SELECT data FROM messages WHERE agent_id=? AND archived=1 ORDER BY id DESC');
  try {
    for (const r of st.iterate([agentId])) {
      used += r.data.length;
      if (used > tailBytes && tailRev.length) break;   // 최소 1개 보장
      tailRev.push(JSON.parse(r.data));
    }
  } finally { st.finalize(); }
  tailRev.reverse();
  return { head, tail: tailRev, truncated: true };
}

// ── 일화(episodes) — addEpisodes 가 유일 writer(INSERT), summary 소문자 dedup ──
function addEpisodes(agentId, episodes) {
  _requireDb();
  if (!Array.isArray(episodes) || !episodes.length) return 0;
  const seen = new Set(db.all('SELECT summary_lc FROM episodes WHERE agent_id=?', [agentId]).map(r => r.summary_lc));
  let added = 0;
  _tx(() => {
    const ins = db.prepare('INSERT OR IGNORE INTO episodes(agent_id,summary_lc,data) VALUES(?,?,?)');
    try {
      for (const e of episodes) {
        const sum = String((e && e.summary) || '').trim();
        if (!sum) continue;
        const lc = sum.toLowerCase();
        if (seen.has(lc)) continue;
        // emotion: 겪은 일에 실린 감정. 여기서 빠뜨리면 추출해놓고 저장이 안 된다.
        //   사람은 사실이 아니라 겪은 일에 감정이 붙는다 — 그래서 그릇이 아니라 일화에 남긴다.
        const em = (e && e.emotion && typeof e.emotion === 'object') ? e.emotion : null;
        const rec = {
          date: (e && e.date) || Date.now(), type: (e.type || '사건'), summary: sum,
          entities: Array.isArray(e.entities) ? e.entities : [],
          ...(em ? { emotion: { weight: Number(em.weight) || 0, valence: Number(em.valence) || 0 } } : {}),
        };
        ins.run([agentId, lc, JSON.stringify(rec)]);
        seen.add(lc);
        added++;
      }
    } finally { ins.finalize(); }
  });
  return added;
}

// 되풀이로 인정돼 그릇(존재)으로 올라간 일화에 표시를 남긴다.
//   표시가 없으면 같은 주제가 4번째·5번째 나올 때마다 두뇌에게 또 물어보게 되어 호출만 는다.
//   일화 자체는 지우지 않는다 — 원문과 함께 그대로 남는다.
function markEpisodesPromoted(agentId, summaries) {
  _requireDb();
  if (!Array.isArray(summaries) || !summaries.length) return 0;
  let n = 0;
  _tx(() => {
    for (const s of summaries) {
      const lc = String(s || '').trim().toLowerCase();
      if (!lc) continue;
      const row = db.get('SELECT data FROM episodes WHERE agent_id=? AND summary_lc=?', [agentId, lc]);
      if (!row) continue;
      let rec; try { rec = JSON.parse(row.data); } catch (_) { continue; }
      if (rec.promoted) continue;
      rec.promoted = true;
      db.run('UPDATE episodes SET data=? WHERE agent_id=? AND summary_lc=?', [JSON.stringify(rec), agentId, lc]);
      n++;
    }
  });
  return n;
}

// ── 메시지 임베딩 캐시(P1: 파일 유지 — 핫 아님·캐시·정밀도 보존) ──
function _msgEmbFile(agentId) {
  const safe = String(agentId || '_shared').replace(/[\\/]/g, '');
  return path.join(archiveDir || path.dirname(dbPath || '.'), `${safe}.msgemb.json`);
}
function loadMsgEmbCache(agentId) {
  try { return JSON.parse(fs.readFileSync(_msgEmbFile(agentId), 'utf8')); }
  catch (_) { return { model: null, map: {} }; }
}
function saveMsgEmbCache(agentId, cache) {
  try {
    if (archiveDir) fs.mkdirSync(archiveDir, { recursive: true });
    fs.writeFileSync(_msgEmbFile(agentId), JSON.stringify(cache), 'utf8');
  } catch (e) { console.error('[storage] msgemb 캐시 저장 실패:', e && e.message); }
}

// ── 메시지 벡터 저장소(의미검색 확장) ──────────────────────────────────────
//   int8 양자화 벡터(BLOB) + 메시지별 메타를 msg_id(=messages.id) 기준 1행.
//   검색이 이 테이블만으로 점수+결과를 구성 → 매 검색마다 원문 전체 재로드 불필요.
//   양자화(number[]↔BLOB)는 호출부(memory-search)가 하고, 여기선 BLOB 그대로 저장.
/** 아직 (현재 model로) 벡터화 안 된 메시지들: {id, content, ts, role, files}. */
function getUnvectorizedMessages(agentId, model) {
  const rows = db.all(
    `SELECT m.id AS id, m.data AS data FROM messages m
     WHERE m.agent_id=? AND NOT EXISTS
       (SELECT 1 FROM msg_vec v WHERE v.agent_id=m.agent_id AND v.msg_id=m.id AND v.model=?)`,
    [agentId, model]);
  const out = [];
  for (const r of rows) {
    let m; try { m = JSON.parse(r.data); } catch (_) { continue; }
    if (m && m.content) out.push({ id: r.id, content: m.content, ts: m.ts, role: m.role, files: m.files });
  }
  return out;
}
/** 벡터+메타 upsert. entries: [{msg_id, ts, role, snippet, files, vec(Buffer)}]. model 바뀌면 REPLACE로 교체. */
function putMsgVecs(agentId, model, entries) {
  _requireDb();
  if (!Array.isArray(entries) || !entries.length) return;
  _tx(() => {
    const ins = db.prepare('INSERT OR REPLACE INTO msg_vec(agent_id,msg_id,model,ts,role,snippet,files,vec) VALUES(?,?,?,?,?,?,?,?)');
    try {
      for (const e of entries) ins.run([agentId, e.msg_id, model, e.ts != null ? e.ts : null, e.role || null, e.snippet || '', e.files ? JSON.stringify(e.files) : null, e.vec]);
    } finally { ins.finalize(); }
  });
}
/** 현재 model의 전체 벡터행: [{msg_id, ts, role, snippet, files, vec(Uint8Array/Buffer)}]. */
function loadMsgVecs(agentId, model) {
  _requireDb();
  return db.all('SELECT msg_id,ts,role,snippet,files,vec FROM msg_vec WHERE agent_id=? AND model=? ORDER BY msg_id', [agentId, model])
    .map(r => ({ msg_id: r.msg_id, ts: r.ts, role: r.role, snippet: r.snippet, files: r.files ? JSON.parse(r.files) : undefined, vec: r.vec }));
}

function getDataPath() { return dbPath; }

module.exports = {
  init,
  initOrExit,
  SCHEMA_VERSION,
  saveAgent, loadAgent, loadAllAgents,
  saveConversation, loadConversation, appendMessages,
  recordToolCall, recordClaimCheck, toolCallsSince, toolAttemptsSince, pruneToolCalls, pruneLedgers,
  saveConversationSummary, loadConversationSummary,
  appendArchivedMessages, loadArchivedMessages, loadArchivedWindow, loadArchivedPage, archiveOldestActive,
  addEpisodes, markEpisodesPromoted,
  loadMsgEmbCache, saveMsgEmbCache,
  getUnvectorizedMessages, putMsgVecs, loadMsgVecs,
  setActiveChannel, getActiveChannel,
  getDataPath,
};
