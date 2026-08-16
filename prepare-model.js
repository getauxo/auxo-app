#!/usr/bin/env node
'use strict';
/**
 * prepare-model.js — 로컬 AI 모델을 앱에 번들할 수 있게 `models/` 로 준비한다.
 *
 * 왜: 우리는 로컬 설치형 제품이다. **대화하려는데 인터넷이 필요하면 정체성 배신**이다.
 *     모델을 첫 사용 때 받는 대신 설치본에 넣어, 오프라인에서도 동작하게 한다.
 *     (음성 전사는 텔레그램·디스코드 등 헤드리스 채널에도 필요 → on-demand 아닌 번들. 채널 동등성.)
 *
 * 왜 git 에 안 넣나: 수백MB 바이너리를 커밋하면 repo 가 비대해진다.
 *     대신 **빌드 전에 이 스크립트로 준비**한다(`npm run pack`/`dist` 가 자동 실행 — package.json).
 *
 * 동작: transformers.js 캐시(node_modules/.../.cache)에 이미 받아둔 모델이 있으면 복사하고,
 *      없으면 먼저 내려받은 뒤(1회) 복사한다. 이미 models/ 에 있으면 건너뛴다(멱등).
 */
const fs = require('fs');
const path = require('path');

const DEST = path.join(__dirname, 'models');
const CACHE = path.join(__dirname, 'node_modules', '@huggingface', 'transformers', '.cache');

// 번들할 모델 목록. sentinel = 준비 완료 판단용 대표 파일(있으면 스킵).
const MODELS = [
  {
    id: 'onnx-community/embeddinggemma-300m-ONNX',
    task: 'feature-extraction',
    dtype: 'q4f16',
    sentinel: path.join('onnx', 'model_q4f16.onnx_data'),
    note: '기억 의미검색(임베딩)',
  },
  // 음성 전사(whisper)는 번들하지 않는다 — 첫 음성 때 자동 다운로드(on-demand, audio-transcribe.js).
];

function copyDir(src, dst) {
  fs.mkdirSync(dst, { recursive: true });
  for (const e of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, e.name), d = path.join(dst, e.name);
    if (e.isDirectory()) copyDir(s, d);
    else fs.copyFileSync(s, d);
  }
}
function dirSize(p) {
  let n = 0;
  for (const e of fs.readdirSync(p, { withFileTypes: true })) {
    const q = path.join(p, e.name);
    n += e.isDirectory() ? dirSize(q) : fs.statSync(q).size;
  }
  return n;
}

async function prepareOne(m) {
  const dest = path.join(DEST, ...m.id.split('/'));
  if (fs.existsSync(path.join(dest, m.sentinel))) {
    console.log(`[prepare-model] 이미 준비됨: models/${m.id} (${(dirSize(dest) / 1e6).toFixed(0)} MB) — ${m.note}`);
    return;
  }
  const cached = path.join(CACHE, ...m.id.split('/'));
  if (!fs.existsSync(path.join(cached, m.sentinel))) {
    console.log(`[prepare-model] 캐시에 없음 → 내려받는 중(1회): ${m.id} …`);
    const { pipeline } = await import('@huggingface/transformers');
    await pipeline(m.task, m.id, { dtype: m.dtype });
    console.log('[prepare-model] 다운로드 완료');
  }
  if (!fs.existsSync(path.join(cached, m.sentinel))) {
    console.error('[prepare-model] 실패: 캐시를 찾지 못함 —', cached);
    process.exit(1);
  }
  console.log(`[prepare-model] models/ 로 복사 중: ${m.id} …`);
  copyDir(cached, dest);
  console.log(`[prepare-model] 완료: models/${m.id} (${(dirSize(dest) / 1e6).toFixed(0)} MB) — ${m.note}`);
}

(async () => {
  for (const m of MODELS) await prepareOne(m);
  console.log('[prepare-model] → 설치본에 포함되어 인터넷 없이도 기억검색·음성전사가 동작한다.');
})().catch(e => { console.error('[prepare-model] 오류:', e.message); process.exit(1); });
