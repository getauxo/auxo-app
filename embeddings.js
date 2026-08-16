/**
 * embeddings.js — 임베딩 기반 의미 검색(회상)
 *
 * 기억 회상을 키워드 겹침이 아니라 "의미 유사도"로 한다. ("여행"↔"트래블" 같은 동의어 포착)
 * - 임베딩은 에이전트의 BYO 키를 재사용한다(추가 키 불필요):
 *     gemini-api → Google text-embedding-004
 *     openai-api → OpenAI text-embedding-3-small
 *   그 외 두뇌(claude-api·claude-subscription)는 임베딩 없음 → 호출부가 키워드 폴백.
 * - 비용/지연: 기억이 많을 때(>전량주입 한도)만 사용. fact 벡터는 캐시(fact._emb), 쿼리만 매번 1회.
 * - 이식: fact._emb/_embKey는 companion-format 화이트리스트에 없어 export에서 자동 제외됨.
 */
'use strict';

// Gemini 임베딩: text-embedding-004는 단종됨(404) → gemini-embedding-001 사용.
// 새 모델은 batchEmbedContents 미지원 → embedContent(단건)을 순차 호출.
// outputDimensionality로 차원 축소(로컬 JSON 비대 방지, cosine은 차원만 맞으면 무관).
const GEMINI_EMBED_MODEL = 'gemini-embedding-001';
const GEMINI_EMBED_DIM = 768;
const OPENAI_EMBED = 'https://api.openai.com/v1/embeddings';
const OPENAI_EMBED_MODEL = 'text-embedding-3-small';

async function _fetchJson(url, opts, timeoutMs) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs || 30000);
  let res;
  try { res = await fetch(url, { ...opts, signal: ctrl.signal }); }
  finally { clearTimeout(timer); }
  if (!res.ok) {
    const t = await res.text().catch(() => '');
    throw new Error(`${res.status}: ${t.slice(0, 200)}`);
  }
  return res.json();
}

/**
 * 에이전트 두뇌에 맞는 임베더를 반환. 지원 안 하면 null.
 * @returns {{ key: string, embed: (texts:string[]) => Promise<number[][]> } | null}
 */
function getEmbedder(agent) {
  // ★두뇌별 키 보관함을 먼저 본다. 예전엔 옛 단일키(agent.apiKey)만 봐서,
  //   키가 apiKeys 에만 있는 사용자는 **임베딩이 조용히 꺼졌다** — 기억 검색 품질이 떨어지는데
  //   화면엔 아무 표시도 안 난다. (단일키는 옛 데이터 호환으로만 남겨 둔다.)
  const key = agent && ((agent.apiKeys && agent.apiKeys[agent.brainMode]) || agent.apiKey);
  if (key && agent.brainMode === 'gemini-api') {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_EMBED_MODEL}:embedContent`;
    return {
      key: 'gemini:' + GEMINI_EMBED_MODEL,
      embed: async (texts) => {
        // 새 모델은 배치 미지원 → 단건 순차 호출(소량·캐시되므로 1회성). 레이트리밋 보수적.
        const out = [];
        for (const t of texts) {
          const data = await _fetchJson(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key },
            body: JSON.stringify({
              model: 'models/' + GEMINI_EMBED_MODEL,
              content: { parts: [{ text: String(t || '') }] },
              outputDimensionality: GEMINI_EMBED_DIM,
            }),
          });
          out.push((data.embedding && data.embedding.values) || []);
        }
        return out;
      },
    };
  }
  if (key && agent.brainMode === 'openai-api') {
    return {
      key: 'openai:' + OPENAI_EMBED_MODEL,
      embed: async (texts) => {
        const data = await _fetchJson(OPENAI_EMBED, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${key}` },
          body: JSON.stringify({ model: OPENAI_EMBED_MODEL, input: texts.map(t => String(t || '')) }),
        });
        return (data.data || []).map(d => d.embedding || []);
      },
    };
  }
  // 구독형(claude/codex)·claude-api·키없음 등 API 임베딩 불가 → 로컬 임베딩으로 의미검색 제공
  // (키·서버 불필요·오프라인·비용0). 모델 로드/다운로드 실패 시 호출부(engine) try/catch가 키워드로 폴백.
  return _getLocalEmbedder();
}

// 로컬 임베딩(키·서버 불필요) — 구독형 두뇌 등 API 임베딩이 없는 경우의 의미검색 제공.
// transformers.js는 ESM이라 CommonJS에서 dynamic import. 파이프라인은 1회 로드 후 재사용(lazy 싱글톤).
//
// ★임베딩 모델 = EmbeddingGemma-300m (실측 근거)
//  | 항목            | e5-base    | EmbeddingGemma |
//  |-----------------|------------|----------------|
//  | 한국어 동의어    | 4/4        | 4/4            |
//  | 영어 동의어      | 6/6        | 6/6            |
//  | 언어 간(한→영)   | **4/5**    | **5/5**        |  ← "발표 언제였지"에서 e5는 엉뚱한 기억을 1위로
//  | 무관 질문 최고점 | **0.763**  | **0.401**      |  ← e5는 무관한 것도 정답(0.80대)과 거의 붙음
//  | 크기(quantized) | **279MB**  | **175MB**      |  ← 번들 필수라 100MB 차이가 큼
// 향후 영어 진출 시 한국어·영어가 섞인 기억을 다뤄야 하는데 e5는 언어 간 검색에서 흔들린다.
// 번들을 결정하는 지금 한 번에 정하는 게, 나중에 또 갈아끼우고 또 검증하는 것보다 낫다.
// ⚠️ 임계값으로 "관련 없음"을 자르는 건 이 모델로도 불가(near-miss 실측: "어깨 수술"0.669 > 정답 0.571).
//    관련성 판단은 두뇌가 내용을 읽고 한다 — memory-search-relevance-research.md 참고.
const LOCAL_EMBED_MODEL = 'onnx-community/embeddinggemma-300m-ONNX';
const LOCAL_EMBED_DTYPE = 'q4f16';   // 175MB. electron 31(Node 20)에서 동작 확인
const { Worker } = require('worker_threads');
let _localPipePromise = null;

// ── 로컬 임베딩 오프로드 ────────────────────────────────────────────────────
// onnxruntime 계산(모델 로드+추론)이 메인/CLI 이벤트루프를 막아 UI가 "(응답 없음)"이 되던
// 메인 스레드에서 돌리면 저사양 PC 에서 수 초씩 화면이 멎는다(실측). 계산을 워커 스레드에서 돌려
// 메인 스레드는 항상 자유롭게 둔다. 워커 불가 환경은 과거 방식(인프로세스)으로 자동 폴백.
let _embWorker = null, _embWorkerBroken = false, _embReqId = 0;
const _embPending = new Map();

function _localModelDir() {
  try {
    const path = require('path'), fs = require('fs');
    const dir = path.join(__dirname, 'models').replace(`app.asar${path.sep}`, `app.asar.unpacked${path.sep}`);
    if (fs.existsSync(path.join(dir, ...LOCAL_EMBED_MODEL.split('/'), 'config.json'))) return dir;
  } catch (_) {}
  return null;
}

// onnxruntime 스레드 상한. 코어를 UI/메인에 남긴다. ≤4 논리코어(대개 2물리코어=저사양 노트북)는
// 1개만 써서 화면이 굶지 않게 한다. 큰 머신은 4논리코어를 UI 여유로 남긴다.
function _embThreads() {
  try { const n = require('os').cpus().length || 2; return n <= 4 ? 1 : Math.max(1, n - 4); }
  catch (_) { return 1; }
}

function _startEmbWorker() {
  const path = require('path');
  const wp = path.join(__dirname, 'embed-worker.js'); // asar 내부 경로(Electron 동일프로세스 asar 패치로 로드)
  const w = new Worker(wp, { workerData: { model: LOCAL_EMBED_MODEL, dtype: LOCAL_EMBED_DTYPE, modelDir: _localModelDir(), threads: _embThreads() } });
  w.on('message', (msg) => {
    const p = _embPending.get(msg.id); if (!p) return; _embPending.delete(msg.id);
    if (msg.error) p.reject(new Error(msg.error)); else p.resolve(msg.vecs);
  });
  const failAll = (e) => { for (const [, p] of _embPending) p.reject(e); _embPending.clear(); _embWorker = null; };
  w.on('error', (e) => { _embWorkerBroken = true; failAll(e); });
  w.on('exit', (code) => { if (code !== 0) failAll(new Error('embed worker exit ' + code)); });
  if (w.unref) w.unref(); // CLI 등에서 프로세스 종료를 막지 않게(대기 중 embed는 turn이 살려둠)
  return w;
}

function _workerEmbed(texts, role) {
  if (_embWorkerBroken) return _localInProcessEmbed(texts, role);
  try { if (!_embWorker) _embWorker = _startEmbWorker(); }
  catch (e) { _embWorkerBroken = true; return _localInProcessEmbed(texts, role); }
  return new Promise((resolve, reject) => {
    const id = ++_embReqId;
    _embPending.set(id, { resolve, reject });
    _embWorker.postMessage({ id, texts, role });
  }).catch(() => { _embWorkerBroken = true; return _localInProcessEmbed(texts, role); });
}

// 폴백(과거 동작): 워커를 못 쓰는 환경에서만 메인에서 직접 계산.
async function _localInProcessEmbed(texts, role) {
  if (!_localPipePromise) {
    _localPipePromise = import('@huggingface/transformers')
      .then(m => {
        // 번들된 모델 우선 — 설치본에 models/ 가 있으면 그걸 쓴다(인터넷 불필요).
        try {
          const path = require('path'), fs = require('fs');
          const dir = path.join(__dirname, 'models').replace(`app.asar${path.sep}`, `app.asar.unpacked${path.sep}`);
          if (fs.existsSync(path.join(dir, ...LOCAL_EMBED_MODEL.split('/'), 'config.json'))) {
            m.env.localModelPath = dir;
            m.env.allowLocalModels = true;
          }
        } catch (_) {}
        return m.pipeline('feature-extraction', LOCAL_EMBED_MODEL, {
          dtype: LOCAL_EMBED_DTYPE,
          session_options: { intraOpNumThreads: _embThreads(), interOpNumThreads: 1 },
        });
      })
      .catch(e => { _localPipePromise = null; throw e; }); // 실패 시 재시도 가능하게 리셋
  }
  const pipe = await _localPipePromise;
  // EmbeddingGemma는 검색용 비대칭 프리픽스를 쓴다(질의/문서 형식이 다름).
  const wrap = (t) => role === 'query' ? `task: search result | query: ${t}` : `title: none | text: ${t}`;
  const out = [];
  for (const t of texts) {
    const o = await pipe(wrap(String(t || '')), { pooling: 'mean', normalize: true });
    out.push(Array.from(o.data));
  }
  return out;
}

function _getLocalEmbedder() {
  return {
    key: 'local:' + LOCAL_EMBED_MODEL,
    embed: (texts, role) => _workerEmbed(texts, role),
  };
}

function cosine(a, b) {
  if (!a || !b || a.length !== b.length || a.length === 0) return 0;
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}


/**
 * 임베딩 캐시 키 = 모델 키 + 그 텍스트의 지문.
 *
 * 모델 키만 비교하면 기억의 값이 바뀌어도(정리·갱신·병합)
 *   옛 벡터가 그대로 남았다 — 검색이 "지금은 없는 옛 내용"으로 걸려 엉뚱한 기억을 물어온다.
 *   텍스트가 바뀌면 키도 바뀌어 자동으로 다시 계산된다.
 *   (기존 사용자는 옛 형식 키와 불일치 → 최초 1회 전량 재계산. 로컬 모델이라 비용 없음.)
 */
function embCacheKey(text, embedderKey) {
  const s = String(text || '');
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = (((h << 5) + h) ^ s.charCodeAt(i)) >>> 0;
  return `${embedderKey}|${s.length}|${h.toString(36)}`;
}


// 워밍업: 로컬 임베딩 모델을 미리(백그라운드) 로딩해 첫 대화 때의 1회성 지연을 없앤다.
// 로컬 임베더일 때만 동작(API 임베더는 불필요한 호출 방지). 실패는 조용히 무시(다음 사용 시 재시도).
async function warm(agent) {
  try {
    const e = getEmbedder(agent);
    if (e && typeof e.embed === 'function' && String(e.key || '').startsWith('local:')) {
      await e.embed(['워밍업'], 'query');
    }
  } catch (_) {}
}

module.exports = { getEmbedder, cosine, warm, embCacheKey };
// selectRelevant(관련성으로 기억 골라내기)는 두지 않는다 — 그릇을 통째로 주입하기 때문이다.
