'use strict';
/**
 * memory-search.js — 기억 능동 검색(search_memory).
 *
 * 역할: **주입 창(최근 20,000토큰) 밖의 옛 기억을 꺼내오는 유일한 수단.**
 *   최근 대화는 원문이 통째로 두뇌에 들어가므로 이 도구가 필요 없다. 그보다 옛날은 요약이 흐름만 주므로,
 *   "작년에 그 카페 어디였지?"처럼 정확한 걸 물으면 여기서 원문을 꺼낸다.
 *
 * 찾는 방식: 일화·팩트·대화원문·아카이브를 **임베딩 의미검색**으로("그 바우처" → 여행.pdf). 요약만 substring.
 *   대화원문은 텍스트 해시별 벡터를 파일 캐시(msgemb)에 두고 증분 임베딩 → 첫 호출만 느리고 이후 빠름.
 *   임베딩이 없거나 실패하면 전부 substring 폴백. 두뇌·채널 무관 공통(engine.runTurn 경유).
 *
 * ⚠️ 관련성 판단은 여기서 하지 않는다. 점수로 "관련 없음"을 거르는 건 불가능하다는 게 실측 결론이다
 *   (near-miss: "어깨 수술"0.669 > 정답 0.571). 후보를 주면 **두뇌가 내용을 읽고 판단·정정**한다.
 */
const storage = require('./storage');
const embeddings = require('./embeddings');
const crypto = require('crypto');

function _tokens(q) { return (String(q || '').toLowerCase().match(/[\p{L}\p{N}]+/gu) || []).filter(t => t.length >= 1); }
/** substring 부분일치 카운트(대화·요약·폴백용). 한글도 includes로 동작. */
function _score(text, toks) {
  const s = String(text || '').toLowerCase();
  if (!s) return 0;
  let n = 0;
  for (const t of toks) if (s.includes(t)) n++;
  return n;
}
function _fmtDate(ts) {
  if (!ts) return '';
  try { return new Date(ts).toLocaleString('ko-KR', { timeZone: 'Asia/Seoul', dateStyle: 'medium', timeStyle: 'short' }); }
  catch (_) { return ''; }
}
function _safeEmbedder(ag) { try { return embeddings.getEmbedder(ag); } catch (_) { return null; } }
function _epText(e) { return `${e.summary || ''} ${(e.entities || []).join(' ')}`.trim(); }
function _h(t) { return crypto.createHash('md5').update(String(t || '')).digest('hex').slice(0, 16); } // 메시지 텍스트 → 캐시 키
/**
 * 그 메시지에 딸린 파일(경로) — 검색 결과에 함께 돌려준다.
 * ★사용자는 파일명을 정확히 모른다("아까 그 바우처"). 맥락으로 메시지를 찾아도 파일 경로를 안 주면
 *   에이전트가 파일을 되돌려줄 수 없다 — 대화는 있는데 "받은 PDF가 없다"고 답하게 된다. 맥락 검색 + 파일 동반 반환.
 */
function _filesOf(m) {
  if (!Array.isArray(m.files) || !m.files.length) return undefined;
  const fs = m.files.filter(f => f && f.path).map(f => ({ name: f.name, path: f.path }));
  return fs.length ? fs : undefined;
}

/**
 * items를 query와의 의미 유사도(cosine)로 점수. item._emb 캐시(embedder.key). 실패 시 throw → 호출부 substring 폴백.
 * @returns {Array<{it, s}>}
 */
async function _semanticScores(embedder, query, items, textFn) {
  if (!items.length) return [];
  const qv = (await embedder.embed([query], 'query'))[0];
  if (!Array.isArray(qv) || !qv.length) throw new Error('query embed 실패');
  // 캐시 키에 텍스트 지문을 포함한다 — 모델 키만 보면 내용이 바뀌어도 옛 벡터가 남는다.
  const need = [];
  const needSig = [];
  for (const it of items) {
    const sig = embeddings.embCacheKey(textFn(it), embedder.key);
    if (!Array.isArray(it._emb) || it._embKey !== sig) { need.push(it); needSig.push(sig); }
  }
  if (need.length) {
    const vecs = await embedder.embed(need.map(textFn));
    need.forEach((it, i) => { if (Array.isArray(vecs[i]) && vecs[i].length) { it._emb = vecs[i]; it._embKey = needSig[i]; } });
  }
  return items.map(it => ({ it, s: embeddings.cosine(qv, it._emb) }));
}

// ── 대화 의미검색: 벡터를 int8 로 sqlite 에 저장 + 프로세스 RAM 캐시 ──
//   과거: 매 검색마다 거대 msgemb JSON 통째 로드 + 원문 전체 스캔 → 수십만 개서 느림.
//   지금: 벡터저장소(msg_vec, int8 BLOB)만으로 점수+결과 구성, 프로세스 내 캐시로 재로드 회피.
//   순위=cosine 그대로(정규화 후 int8 내적/127² ≈ cosine). 쿼리/문서 비대칭 임베딩 유지.
const _vecCache = new Map(); // agentId -> {model, rows:[{msg_id,ts,role,snippet,files,i8}]}
function _q8(v) { // 정규화 후 int8 양자화 → Int8Array
  let s = 0; for (let i = 0; i < v.length; i++) s += v[i] * v[i]; s = Math.sqrt(s) || 1;
  const a = new Int8Array(v.length);
  for (let i = 0; i < v.length; i++) { let x = Math.round((v[i] / s) * 127); a[i] = x > 127 ? 127 : x < -127 ? -127 : x; }
  return a;
}
function _bufOf(i8) { return Buffer.from(i8.buffer, i8.byteOffset, i8.byteLength); }
function _i8FromBlob(b) { return Int8Array.from(new Int8Array(b.buffer, b.byteOffset, b.length)); } // 복사(안전)
function _i8dot(a, b) { let d = 0; const n = Math.min(a.length, b.length); for (let i = 0; i < n; i++) d += a[i] * b[i]; return d; }

/** 새 메시지만 임베딩·저장하고, 현재 모델의 전체 벡터행(RAM 캐시)을 돌려준다. */
async function _syncAndLoadVecs(agentId, embedder) {
  const model = embedder.key;
  let entry = _vecCache.get(agentId);
  if (!entry || entry.model !== model) {
    entry = { model, rows: storage.loadMsgVecs(agentId, model).map(r => ({ msg_id: r.msg_id, ts: r.ts, role: r.role, snippet: r.snippet, files: r.files, i8: _i8FromBlob(r.vec) })) };
    _vecCache.set(agentId, entry);
  }
  const need = storage.getUnvectorizedMessages(agentId, model);
  if (need.length) {
    const uniq = [...new Set(need.map(m => String(m.content)))];
    const vecs = await embedder.embed(uniq); // 문서 모드(비대칭)
    const byText = new Map(); uniq.forEach((t, i) => byText.set(t, vecs[i]));
    const toStore = [];
    for (const m of need) {
      const v = byText.get(String(m.content));
      if (!Array.isArray(v) || !v.length) continue;
      const i8 = _q8(v);
      toStore.push({ msg_id: m.id, ts: m.ts, role: m.role, snippet: String(m.content).slice(0, 300), files: m.files, i8, vec: _bufOf(i8) });
    }
    if (toStore.length) {
      storage.putMsgVecs(agentId, model, toStore.map(e => ({ msg_id: e.msg_id, ts: e.ts, role: e.role, snippet: e.snippet, files: e.files, vec: e.vec })));
      for (const e of toStore) entry.rows.push({ msg_id: e.msg_id, ts: e.ts, role: e.role, snippet: e.snippet, files: e.files, i8: e.i8 });
    }
  }
  return entry.rows;
}

/**
 * @returns {Promise<{hits: Array<{kind,when,text,role?,score}>, note}>}  관련순 상위 max개.
 */
async function searchMemory(agentId, query, max = 8) {
  const toks = _tokens(query);
  if (!toks.length) return { hits: [], note: '검색어가 비었어.' };
  const ag = storage.loadAgent(agentId) || {};
  const episodes = ag.episodes || [];

  const out = [];

  // ⑤일화: 의미검색(임베딩) 우선 — 동의어 포착. 실패 시 substring 폴백.
  //
  // ★**그릇(사용자에 대한 기억)은 검색 대상이 아니다.**
  //   통짜 전환으로 그릇 전문이 매 턴 시스템 프롬프트에 통째로 들어간다 → 두뇌 눈앞에 이미 있다.
  //   그걸 또 검색 결과로 돌려주면 같은 내용이 두 번 들어가고, 검색 자리(상한)를 잡아먹어
  //   정작 필요한 일화·원문이 밀린다. 눈앞에 있는 걸 다시 찾아줄 이유가 없다.
  let semanticOK = false;
  const embedder = _safeEmbedder(ag);
  if (embedder) {
    try {
      for (const { it, s } of await _semanticScores(embedder, query, episodes, _epText))
        out.push({ kind: '일화', _ts: (it.date || it.ts), text: (it.summary || ''), score: s + 0.05 }); // 일화 소폭 가중
      semanticOK = true;
    } catch (_) { out.length = 0; } // 임베딩 실패 → 아래 substring 폴백으로
  }
  if (!semanticOK) {
    for (const ep of episodes) { const sc = _score(_epText(ep), toks); if (sc > 0) out.push({ kind: '일화', _ts: (ep.date || ep.ts), text: (ep.summary || ''), score: sc / toks.length + 0.05 }); }
  }

  // ②아카이브 + ①현재 대화 원문: 의미검색 = int8 벡터저장소(msg_vec) + 프로세스 RAM 캐시.
  //   벡터저장소만으로 점수+결과 구성(원문 전체 재로드 없음). 실패 시 substring 폴백(원문 스캔).
  let convSem = false;
  if (embedder && semanticOK) {
    try {
      const rows = await _syncAndLoadVecs(agentId, embedder);
      const qv = (await embedder.embed([query], 'query'))[0]; // 쿼리 모드(비대칭)
      if (!Array.isArray(qv) || !qv.length) throw new Error('query embed 실패');
      const q = _q8(qv);
      for (const row of rows) {
        const score = _i8dot(q, row.i8) / 16129; // /(127²) → cosine 범위로 환산(일화·팩트 점수와 비교 가능)
        out.push({ kind: '대화', role: row.role === 'agent' ? '나' : '사용자', _ts: row.ts, text: row.snippet, score, files: row.files });
      }
      convSem = true;
    } catch (_) { convSem = false; }
  }
  if (!convSem) {
    try {
      const msgs = [].concat(storage.loadArchivedMessages(agentId) || [], storage.loadConversation(agentId) || []).filter(m => m && m.content);
      for (const m of msgs) { const sc = _score(m.content, toks); if (sc > 0) out.push({ kind: '대화', role: m.role === 'agent' ? '나' : '사용자', _ts: (m.ts || m.timestamp), text: String(m.content).slice(0, 300), score: sc / toks.length, files: _filesOf(m) }); }
    } catch (_) {}
  }
  try {
    const sum = storage.loadConversationSummary(agentId);
    const sc = _score(sum, toks);
    if (sc > 0) out.push({ kind: '요약', _ts: null, text: String(sum).slice(0, 400), score: sc / toks.length });
  } catch (_) {}

  out.sort((a, b) => (b.score - a.score));
  const hits = out.slice(0, max);
  // 날짜 포맷(_fmtDate=Intl, 개당 비쌈)은 반환하는 상위 결과에만 적용 — 후보 전체(수만)엔 안 함(대량서 느림 방지).
  for (const h of hits) { h.when = h._ts ? _fmtDate(h._ts) : ''; delete h._ts; }
  return {
    hits,
    note: hits.length
      // ★"여기 나온 건 지난 기록"이라고 못박는다. 이게 없으면 **옛 대화에 나온 일정을 '지금 걸린 알림'으로 답한다.**
      //   실측(2026-08-15, GPT): "알림 뭐 있어?"에 list_schedules 대신 search_memory 를 부르고,
      //   월세·정산·어머니 생신 같은 **없는 알림 6건을 목록으로** 내놨다(실제로는 1건). 사용자는 그걸 믿는다.
      ? '이 중에서 확실한 것만 근거로 답하고, 애매하면 지어내지 말고 "정확힌 못 찾았다"고 해. '
        + '★여기 나온 건 **지난 대화·기억 기록**이야 — 지금 실제로 걸려 있는 예약·알림이 아니다. '
        + '"지금 걸린 알림/예약"을 물으면 이 결과로 답하지 말고 **list_schedules 를 불러서** 답해.'
        + (hits.some(h => h.files) ? ' 결과의 files(파일 경로)는 그때 주고받은 실제 파일이야 — send_file/read_file 에 그 경로를 그대로 쓰면 사용자에게 다시 보내거나 열어볼 수 있어. "파일이 없다"고 하지 마.' : '')
      : '저장된 기억·대화·아카이브에서 못 찾았어. 지어내지 말고 솔직히 "기록에 없다"고 해.',
  };
}

// ★relevantEpisodes(일화 자동 주입)는 두지 않는다 — 창에 원문이 통째로 들어가므로 중복이다.
//   근거 없던 임계값 0.75와 매 턴 일화 임베딩 비용도 함께 사라짐. 일화 '저장'(storage.addEpisodes)은 유지.
module.exports = { searchMemory };
