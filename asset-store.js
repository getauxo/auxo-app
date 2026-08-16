'use strict';
/**
 * asset-store.js — 우리 공개 릴리스(getauxo/auxo-assets)에서 자산(모델·바이너리)을
 * 받아 **무결성 검증(sha256)** 후 userData 에 배치하는 통일 다운로더.
 *
 * 왜 우리 릴리스인가: 외부 제3자 호스트(개인 repo 등)는 파일이 지워지거나 바뀌면
 *   기능이 통째로 깨진다. 우리가 소유한 공개 릴리스는 우리가 통제하니 rot 없음.
 *   (자산은 공개 오픈소스 모델·도구일 뿐 — 우리 소스코드/키는 절대 안 올라간다.)
 * 왜 sha256: 받은 파일이 우리가 올린 그 파일이 맞는지 확인(변조·손상 차단).
 */
const fs = require('fs');
const path = require('path');
const https = require('https');
const crypto = require('crypto');
const yauzl = require('yauzl');

function sha256File(file) {
  return new Promise((resolve, reject) => {
    const h = crypto.createHash('sha256');
    fs.createReadStream(file).on('data', d => h.update(d)).on('end', () => resolve(h.digest('hex'))).on('error', reject);
  });
}

// https GET → 파일 저장. GitHub 릴리스는 CDN 으로 302 리다이렉트하므로 따라간다.
function download(url, destFile, onProgress, redirects = 0) {
  return new Promise((resolve, reject) => {
    if (redirects > 5) return reject(new Error('리다이렉트 너무 많음'));
    const req = https.get(url, { headers: { 'User-Agent': 'Auxo' } }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        return resolve(download(res.headers.location, destFile, onProgress, redirects + 1));
      }
      if (res.statusCode !== 200) {
        res.resume();
        return reject(new Error(res.statusCode === 404
          ? '도구가 아직 준비되지 않았어요(파일을 찾지 못함)'
          : `도구를 받지 못했어요(연결 문제 HTTP ${res.statusCode})`));
      }
      const total = parseInt(res.headers['content-length'] || '0', 10);
      let got = 0, lastPct = -1;
      const out = fs.createWriteStream(destFile);
      res.on('data', (c) => {
        got += c.length;
        if (onProgress && total) { const pct = Math.floor(got / total * 100); if (pct >= lastPct + 10) { lastPct = pct; onProgress(pct); } }
      });
      res.pipe(out);
      out.on('finish', () => out.close(() => resolve(destFile)));
      out.on('error', reject);
    });
    req.on('error', reject);
    req.setTimeout(60000, () => { req.destroy(new Error('다운로드 시간 초과')); });
  });
}

function extractZip(zipFile, destDir) {
  return new Promise((resolve, reject) => {
    yauzl.open(zipFile, { lazyEntries: true }, (err, zip) => {
      if (err || !zip) return reject(err || new Error('zip 열기 실패'));
      zip.on('entry', (entry) => {
        const outPath = path.join(destDir, entry.fileName);
        // 경로탈출 차단
        if (!path.resolve(outPath).startsWith(path.resolve(destDir))) { zip.readEntry(); return; }
        if (/\/$/.test(entry.fileName)) { fs.mkdirSync(outPath, { recursive: true }); zip.readEntry(); return; }
        fs.mkdirSync(path.dirname(outPath), { recursive: true });
        zip.openReadStream(entry, (e, rs) => {
          if (e || !rs) { zip.readEntry(); return; }
          const ws = fs.createWriteStream(outPath);
          rs.pipe(ws);
          ws.on('finish', () => zip.readEntry());
          ws.on('error', () => zip.readEntry());
        });
      });
      zip.on('end', resolve);
      zip.on('error', reject);
      zip.readEntry();
    });
  });
}

/**
 * 단일 파일 자산(바이너리 등) 확보. 이미 있고 sha256 맞으면 스킵.
 * @param {Object} a { url, sha256, dest, onStatus?, label?, mode? }  mode=파일권한(예: 0o755)
 */
async function ensureFile(a) {
  if (fs.existsSync(a.dest)) {
    try { if ((await sha256File(a.dest)) === a.sha256) return a.dest; } catch (_) {}
  }
  fs.mkdirSync(path.dirname(a.dest), { recursive: true });
  const tmp = a.dest + '.dl';
  if (a.onStatus) a.onStatus(`${a.label || '파일'}을 받는 중…`);
  await download(a.url, tmp, (pct) => { if (a.onStatus) a.onStatus(`${a.label || '파일'} 받는 중… ${pct}%`); });
  const got = await sha256File(tmp);
  if (got !== a.sha256) { try { fs.unlinkSync(tmp); } catch (_) {} throw new Error(`무결성 검증 실패(${a.label || '파일'}): 받은 파일이 우리 것과 달라요.`); }
  fs.renameSync(tmp, a.dest);
  if (a.mode != null) { try { fs.chmodSync(a.dest, a.mode); } catch (_) {} }
  return a.dest;
}

/**
 * zip 자산(모델 폴더 등) 확보 → destDir 로 풀기. sentinel(대표 파일)이 있으면 스킵.
 * @param {Object} a { url, sha256, destDir, sentinel, onStatus?, label? }
 */
async function ensureZipDir(a) {
  if (a.sentinel && fs.existsSync(path.join(a.destDir, a.sentinel))) return a.destDir;
  fs.mkdirSync(a.destDir, { recursive: true });
  const zipTmp = path.join(a.destDir, '.download.zip');
  if (a.onStatus) a.onStatus(`${a.label || '자산'}을 받는 중…`);
  await download(a.url, zipTmp, (pct) => { if (a.onStatus) a.onStatus(`${a.label || '자산'} 받는 중… ${pct}%`); });
  const got = await sha256File(zipTmp);
  if (got !== a.sha256) { try { fs.unlinkSync(zipTmp); } catch (_) {} throw new Error(`무결성 검증 실패(${a.label || '자산'}): 받은 파일이 우리 것과 달라요.`); }
  if (a.onStatus) a.onStatus(`${a.label || '자산'} 설치 중…`);
  await extractZip(zipTmp, a.destDir);
  try { fs.unlinkSync(zipTmp); } catch (_) {}
  return a.destDir;
}

module.exports = { ensureFile, ensureZipDir, sha256File, download, extractZip };
