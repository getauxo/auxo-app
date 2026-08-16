'use strict';
/**
 * attachment-store.js — 사용자가 보낸 첨부 "원본"을 보관한다(대화에서 카드로 다시 열기·받기용).
 *
 * 데이터(auxo-data.json)와 폴더를 분리해서 download 폴더에 저장한다.
 * 핵심 안전장치:
 *  - 사전 공간 확인(fs.statfsSync): 여유 < (파일크기 + 안전마진)이면 저장하지 않고 안내
 *    → data.json(대화·기억) 저장 공간을 항상 남겨 손상 예방.
 *  - 총량 상한(LRU): download 폴더가 상한을 넘으면 오래된 파일부터 삭제.
 * file-intake.js(두뇌 입력 변환)와는 목적이 다르다 — 이건 "원본 보관".
 */
const fs = require('fs');
const path = require('path');

const MARGIN_BYTES = 200 * 1024 * 1024;   // 안전 마진: 첨부를 저장해도 이만큼은 data.json 몫으로 남긴다
const MAX_TOTAL_BYTES = 500 * 1024 * 1024; // download 폴더 총량 상한(초과 시 오래된 것부터 정리)

/** 저장 볼륨의 여유 바이트. statfs 미지원/실패 시 null(그 경우 사후 ENOSPC로 처리). */
function freeBytes(dir) {
  try {
    const s = fs.statfsSync(dir);
    return s.bsize * s.bavail;
  } catch (_) { return null; }
}

/** download 폴더가 상한을 넘으면 mtime 오래된 파일부터 삭제. */
function pruneOldest(dir, maxBytes) {
  let files;
  try {
    files = fs.readdirSync(dir).map(f => {
      const fp = path.join(dir, f);
      try { const st = fs.statSync(fp); return st.isFile() ? { fp, size: st.size, mtime: st.mtimeMs } : null; }
      catch (_) { return null; }
    }).filter(Boolean);
  } catch (_) { return; }
  let total = files.reduce((a, f) => a + f.size, 0);
  if (total <= maxBytes) return;
  files.sort((a, b) => a.mtime - b.mtime); // 오래된 순
  for (const f of files) {
    if (total <= maxBytes) break;
    try { fs.unlinkSync(f.fp); total -= f.size; } catch (_) {}
  }
}

/**
 * 첨부 원본을 dir에 저장한다.
 * @returns {{ path, name, size } | { error }}
 */
function saveAttachment(dir, name, buffer, opts = {}) {
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) return { error: '빈 파일이라 보관하지 않았어.' };
  const margin = opts.marginBytes != null ? opts.marginBytes : MARGIN_BYTES;
  const maxTotal = opts.maxTotalBytes != null ? opts.maxTotalBytes : MAX_TOTAL_BYTES;
  try { fs.mkdirSync(dir, { recursive: true }); } catch (_) {}

  // 사전 공간 확인 — 여유가 (파일 + 안전마진)보다 적으면 저장하지 않는다(데이터 손상 예방).
  const free = freeBytes(dir);
  if (free != null && free < buffer.length + margin) {
    return { error: '저장 공간이 부족해 파일 원본은 보관하지 못했어요(내용은 확인했어요).' };
  }

  // 경로탈출 차단 + 이름 충돌 회피
  const safe = (path.basename(name).replace(/[\\/:*?"<>|]/g, '_').replace(/^\.+/, '')) || 'file';
  let dest = path.join(dir, safe);
  if (fs.existsSync(dest)) {
    const ext = path.extname(safe);
    const base = ext ? safe.slice(0, -ext.length) : safe;
    dest = path.join(dir, `${base}-${Date.now().toString(36)}${ext}`);
  }
  try { fs.writeFileSync(dest, buffer); }
  catch (e) {
    // statfs가 없거나 부정확했던 경우의 최종 방어(ENOSPC 등)
    return { error: '파일 원본 보관에 실패했어요(' + (e.code || e.message) + ').' };
  }
  try { pruneOldest(dir, maxTotal); } catch (_) {}
  return { path: dest, name: path.basename(dest), size: buffer.length };
}

module.exports = { saveAttachment, freeBytes, pruneOldest, MARGIN_BYTES, MAX_TOTAL_BYTES };
