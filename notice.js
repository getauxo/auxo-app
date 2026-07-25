/**
 * notice.js — 공지·업데이트 확인 (앱·CLI 공용)
 *
 * 앱(main.js)에만 있던 로직을 빼내 CLI 도 같은 코드를 쓰게 한다.
 * → 한쪽에만 있어 어긋나는 일이 없다(채널 동등성).
 *
 * 원칙:
 *   - 우리 서버가 아니라 GitHub 의 파일 하나를 읽는다(운영 서버 없음, 비용 0).
 *   - "받지 않기"는 배너만 숨기는 게 아니라 네트워크 요청 자체를 막는다.
 *     설정은 데이터 폴더의 notice-off 파일로 두어(호출자가 경로 주입) 어느 채널이든 공유.
 *   - 저장소가 public 이 되면 바로 동작. 그전까지 404 → 조용히 무시.
 */

const fs = require('fs');
const path = require('path');

const NOTICE_URL = 'https://raw.githubusercontent.com/getauxo/Auxo/main/notice.json';

function offPath(dataDir) {
  try { return path.join(dataDir, 'notice-off'); } catch (_) { return null; }
}

/** "공지 받지 않기"가 켜져 있는가. */
function isOff(dataDir) {
  const p = offPath(dataDir);
  return !!(p && fs.existsSync(p));
}

/** 옵트아웃 on/off. 켜면 파일 생성, 끄면 삭제. @returns {boolean} 현재 off 상태 */
function setOff(dataDir, off) {
  const p = offPath(dataDir);
  if (!p) return isOff(dataDir);
  try {
    if (off) fs.writeFileSync(p, '1', 'utf8');
    else if (fs.existsSync(p)) fs.unlinkSync(p);
  } catch (_) {}
  return isOff(dataDir);
}

/**
 * 공지를 확인한다. 옵트아웃이면 네트워크 요청을 아예 하지 않는다.
 * @param {string} dataDir  데이터 폴더(앱=userData, CLI=~/.auxo-cli)
 * @returns {Promise<Object|null>} 공지 객체 또는 null(옵트아웃·오프라인·없음)
 */
async function fetchNotice(dataDir) {
  if (isOff(dataDir)) return null; // 요청 자체를 하지 않는다
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 8000);
    const res = await fetch(NOTICE_URL, { signal: ctrl.signal, headers: { 'Accept': 'application/json' } });
    clearTimeout(timer);
    if (!res.ok) return null;
    return await res.json();
  } catch (_) {
    return null; // 오프라인·타임아웃·미존재 → 조용히 무시(앱/CLI 정상 동작)
  }
}

/** "a.b.c" 버전 비교. a>b → 1, a<b → -1, 같음 → 0. */
function cmpVer(a, b) {
  const A = String(a || '0').split('.').map(Number);
  const B = String(b || '0').split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    if ((A[i] || 0) > (B[i] || 0)) return 1;
    if ((A[i] || 0) < (B[i] || 0)) return -1;
  }
  return 0;
}

/**
 * 공지 → 사용자에게 보여줄 한 줄. 보여줄 게 없으면 null.
 * @param {Object} notice      fetchNotice 결과
 * @param {string} appVersion  현재 버전
 */
function formatLine(notice, appVersion) {
  if (!notice) return null;
  const hasUpdate = notice.latestVersion && cmpVer(notice.latestVersion, appVersion) > 0;
  if (hasUpdate) {
    return `새 버전 ${notice.latestVersion}이 나왔어요${notice.message ? ' — ' + notice.message : ''}`;
  }
  return notice.message || null;
}

module.exports = { NOTICE_URL, isOff, setOff, fetchNotice, cmpVer, formatLine };
