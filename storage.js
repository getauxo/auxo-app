/**
 * storage.js — 로컬 SQLite 기반 저장소 (2026-07-20 JSON→SQLite 이관)
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
 * ★이관 정책(2026-07-20): 전원 fresh-start. 옛 JSON 임포트 없음 → *.pre-sqlite.bak 으로 물러남.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { Database } = require('node-sqlite3-wasm');

const DB_FILE = 'auxo.db';
const LEGACY_JSON = ['auxo-data.json', 'agentlink-data.json'];

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
  `);
  db.run('INSERT OR IGNORE INTO meta(k,v) VALUES (?,?)', ['schema_version', '1']);
}

function init(userDataPath) {
  if (!fs.existsSync(userDataPath)) fs.mkdirSync(userDataPath, { recursive: true });
  dbPath = path.join(userDataPath, DB_FILE);
  archiveDir = path.join(userDataPath, 'archives');
  _retireLegacyJson(userDataPath);
  db = new Database(dbPath);
  try { db.exec('PRAGMA foreign_keys=ON'); db.exec('PRAGMA busy_timeout=5000'); } catch (_) {}
  _createSchema();
  try { require('./fs-tools').setDownloadDir(path.join(userDataPath, 'download')); } catch (_) {}
  try { require('./fs-tools').setProtectedDataPaths([userDataPath]); } catch (_) {}
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
//   humanFacts(≤50)→facts 테이블(트랜잭션 교체). episodes(무한증가)→episodes 테이블.
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
        const rec = { date: (e && e.date) || Date.now(), type: (e.type || '사건'), summary: sum, entities: Array.isArray(e.entities) ? e.entities : [] };
        ins.run([agentId, lc, JSON.stringify(rec)]);
        seen.add(lc);
        added++;
      }
    } finally { ins.finalize(); }
  });
  return added;
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
  saveAgent, loadAgent, loadAllAgents,
  saveConversation, loadConversation, appendMessages,
  saveConversationSummary, loadConversationSummary,
  appendArchivedMessages, loadArchivedMessages, loadArchivedWindow, loadArchivedPage, archiveOldestActive,
  addEpisodes,
  loadMsgEmbCache, saveMsgEmbCache,
  getUnvectorizedMessages, putMsgVecs, loadMsgVecs,
  getDataPath,
};
