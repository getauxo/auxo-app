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
  const key = agent && agent.apiKey;
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
  // 구독형(claude/codex/antigravity)·claude-api·키없음 등 API 임베딩 불가 → 로컬 임베딩으로 의미검색 제공
  // (키·서버 불필요·오프라인·비용0). 모델 로드/다운로드 실패 시 호출부(engine) try/catch가 키워드로 폴백.
  return _getLocalEmbedder();
}

// 로컬 임베딩(키·서버 불필요) — 구독형 두뇌 등 API 임베딩이 없는 경우의 의미검색 제공.
// transformers.js는 ESM이라 CommonJS에서 dynamic import. 파이프라인은 1회 로드 후 재사용(lazy 싱글톤).
//
// ★2026-07-17 모델 교체: multilingual-e5-base → EmbeddingGemma-300m (실측 근거)
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
let _localPipePromise = null;
function _getLocalEmbedder() {
  return {
    key: 'local:' + LOCAL_EMBED_MODEL,
    embed: async (texts, role) => {
      if (!_localPipePromise) {
        _localPipePromise = import('@huggingface/transformers')
          .then(m => {
            // 번들된 모델 우선 — 설치본에 models/ 가 있으면 그걸 쓴다(인터넷 불필요).
            // 우리는 로컬 설치형 제품이다. 대화하려는데 인터넷이 필요하면 정체성 배신이다.
            // 없으면(개발 중 등) 기존대로 원격에서 받는다. 준비=`npm run prepare-model`(dist 시 자동).
            try {
              const path = require('path'), fs = require('fs');
              const dir = path.join(__dirname, 'models');
              if (fs.existsSync(path.join(dir, ...LOCAL_EMBED_MODEL.split('/'), 'config.json'))) {
                m.env.localModelPath = dir;
                m.env.allowLocalModels = true;
              }
            } catch (_) {}
            return m.pipeline('feature-extraction', LOCAL_EMBED_MODEL, { dtype: LOCAL_EMBED_DTYPE });
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
    },
  };
}

function cosine(a, b) {
  if (!a || !b || a.length !== b.length || a.length === 0) return 0;
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

/** fact → 임베딩 대상 텍스트 */
function _factText(f) { return `${f.label || ''}: ${f.value || ''}`.trim(); }

/**
 * 의미 검색으로 관련 기억 선별 (Phase 2: activationScore 골격 공유).
 * - fact 벡터 캐시(없거나 키 불일치면 재생성), 쿼리 벡터 1회.
 * - 중요도 높은(>=3) 기억은 점수와 무관하게 항상 포함(핵심 보존).
 * - Phase 2: cosine을 relevance 항으로 activationScore에 넘겨 통일 골격 사용.
 * @returns {{ selected:Array, recalled:boolean, total:number, changed:boolean, qEmb:number[]|null }}
 *   changed=true면 fact._emb 캐시가 갱신됨 → 호출부가 저장 권장.
 *   qEmb: 쿼리 임베딩 벡터 (reinforce 및 키워드판과 일관성 위해 반환)
 */
async function selectRelevant(facts, query, embedder, topK = 12, textFn = _factText) {
  const total = facts.length;
  let changed = false;

  // 1) 캐시 없는/키 다른 fact만 배치 임베딩
  const need = [];
  for (const f of facts) {
    if (!Array.isArray(f._emb) || f._embKey !== embedder.key) need.push(f);
  }
  if (need.length > 0) {
    const vecs = await embedder.embed(need.map(textFn));
    for (let i = 0; i < need.length; i++) {
      if (Array.isArray(vecs[i]) && vecs[i].length) { need[i]._emb = vecs[i]; need[i]._embKey = embedder.key; changed = true; }
    }
  }

  // 2) 쿼리 임베딩
  const qv = (await embedder.embed([query], 'query'))[0];
  if (!Array.isArray(qv) || !qv.length) {
    // 쿼리 임베딩 실패 → 폴백 신호(빈 selected 대신 전량 반환은 호출부가 키워드로)
    return { selected: facts, recalled: false, total, changed, qEmb: null };
  }

  // 3) Phase 2: activationScore 골격으로 점수 계산 (brain-claude.js의 activationScore와 동일 구조)
  // embeddings.js는 brain-claude.js를 require할 수 없으므로(순환 의존) 동일 계산을 인라인.
  // 상수는 brain-claude.js와 동기화 (W_REL=.45 W_REC=.15 W_FREQ=.10 W_IMP=.15 W_STR=.05)
  const W_REL = 0.45, W_REC = 0.15, W_FREQ = 0.10, W_IMP = 0.15, W_STR = 0.05;
  const TAU_R = 14, C_MAX = 50;
  const nowMs = Date.now();

  const scored = facts.map((f, i) => {
    // relevance: cosine (임베딩판이므로 항상 cosine)
    const relevance = cosine(qv, f._emb);

    // recency
    const lastAccMs = f.lastAccessed ? Date.parse(f.lastAccessed) : (f.ts ? Date.parse(f.ts) : nowMs);
    const dtDays = Math.max(0, (nowMs - (isNaN(lastAccMs) ? nowMs : lastAccMs)) / (1000 * 60 * 60 * 24));
    const recency = Math.exp(-dtDays / TAU_R);

    // frequency
    const cnt = Math.max(0, Number(f.accessCount) || 0);
    const frequency = Math.log(1 + cnt) / Math.log(1 + C_MAX);

    // importanceN
    const imp = Math.max(1, Math.min(3, Number(f.importance) || 2));
    const importanceN = (imp - 1) / 2;

    // strength
    const strength = Math.max(0, Math.min(1, Number(f.strength) || 0.5));

    const score = W_REL * relevance + W_REC * recency + W_FREQ * frequency
                + W_IMP * importanceN + W_STR * strength;

    return { f, i, imp, score };
  });

  scored.sort((a, b) => b.score - a.score);

  // 4) 선별: top-K + 핵심(imp≥3) 항상 포함
  const picked = new Map();
  for (const { f } of scored.slice(0, topK)) picked.set(f, true);
  for (const f of facts) {
    if (Number(f.importance) >= 3) picked.set(f, true);
  }
  const selected = facts.filter(f => picked.has(f));
  return { selected, recalled: true, total, changed, qEmb: qv };
}

module.exports = { getEmbedder, selectRelevant, cosine };
