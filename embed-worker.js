// embed-worker.js — 로컬 임베딩 전용 워커 스레드.
// 목적: onnxruntime 계산(모델 로드+추론)이 메인/CLI 이벤트루프를 막아 UI가 "(응답 없음)"이
//       되던 문제 해결. 이 계산을 별도 스레드에서 돌려 메인 스레드는 항상 자유롭게 둔다.
// 통신: parentPort 로 { id, texts, role } 받아 { id, vecs } 또는 { id, error } 반환.
// 로직은 embeddings.js 의 로컬 임베더와 동일해야 한다(모델·dtype·프리픽스).
const { parentPort, workerData } = require('worker_threads');

const model = workerData && workerData.model;
const dtype = workerData && workerData.dtype;
const modelDir = workerData && workerData.modelDir; // 번들 모델 경로(app.asar.unpacked/models) — 없으면 원격
const threads = (workerData && workerData.threads) || 1; // onnxruntime 스레드 상한(저사양 UI 보호)

let _pipePromise = null;
function getPipe() {
  if (!_pipePromise) {
    _pipePromise = import('@huggingface/transformers')
      .then((m) => {
        if (modelDir) { m.env.localModelPath = modelDir; m.env.allowLocalModels = true; }
        // onnxruntime이 모든 코어를 점유해 UI를 굶기지 않도록 스레드 제한(2코어 노트북 대응).
        return m.pipeline('feature-extraction', model, {
          dtype,
          session_options: { intraOpNumThreads: threads, interOpNumThreads: 1 },
        });
      })
      .catch((e) => { _pipePromise = null; throw e; }); // 실패 시 재시도 가능
  }
  return _pipePromise;
}

parentPort.on('message', async (msg) => {
  const { id, texts, role } = msg || {};
  try {
    const pipe = await getPipe();
    // EmbeddingGemma 비대칭 프리픽스(embeddings.js 와 동일).
    const wrap = (t) => role === 'query' ? `task: search result | query: ${t}` : `title: none | text: ${t}`;
    const out = [];
    for (const t of (texts || [])) {
      const o = await pipe(wrap(String(t || '')), { pooling: 'mean', normalize: true });
      out.push(Array.from(o.data));
    }
    parentPort.postMessage({ id, vecs: out });
  } catch (e) {
    parentPort.postMessage({ id, error: (e && e.message) || String(e) });
  }
});
