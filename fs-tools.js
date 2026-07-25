/**
 * fs-tools.js — 공통 파일 도구의 "코어"(두뇌 무관 단일 소스).
 *
 * 설계(결정2: 폴더 한정 + 승인):
 *  - 모든 동작은 allowedDirs(허용 폴더 목록) 안에서만. 밖이면 거부 + needGrant 신호.
 *  - 경로 탈출(../) 은 path.resolve 로 정규화 후 접두 검사로 차단.
 *  - REST 두뇌(agent-tools)와 구독 두뇌(auxo-mcp-tools)가 둘 다 이 코어를 호출 → 두뇌별 동작 불일치 0.
 *  - 쓰기/생성은 위험(상위에서 승인 게이트). 이 코어는 권한검사만 하고 실제 IO 수행.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');

const WIN = process.platform === 'win32';
const HOME = os.homedir();

// 비개발자는 절대경로를 모른다. "바탕화면·다운로드·문서"처럼 일상적으로 부르는 폴더를
// 실제 위치(홈 디렉터리 하위)로 매핑한다. 첫 경로 조각이 별칭이면 치환.
const FOLDER_ALIASES = [
  { re: /^(바탕\s*화면|바탕화면|데스크[탑톱]|desktop)$/i, real: 'Desktop' },
  { re: /^(다운로드|다운로드\s*폴더|내\s*려받기|downloads?)$/i, real: 'Downloads' },
  { re: /^(문서|내\s*문서|내문서|documents?)$/i, real: 'Documents' },
  { re: /^(사진|그림|pictures?)$/i, real: 'Pictures' },
  { re: /^(음악|music)$/i, real: 'Music' },
  { re: /^(동영상|비디오|videos?)$/i, real: 'Videos' },
];

// 경로 해석: 절대경로(드라이브 문자 포함)는 그대로, 상대경로는 "홈 기준"(cwd 아님!).
// 첫 조각이 일상 폴더 별칭이면 실제 폴더명으로 치환. → "바탕화면/메모" = C:\Users\<나>\Desktop\메모
function _resolveAlias(p) {
  let s = String(p || '').trim().replace(/[\\/]+/g, path.sep);
  if (!s) return s;
  if (path.isAbsolute(s) || /^[a-zA-Z]:/.test(s)) return s; // 절대경로/드라이브문자 → 그대로
  const segs = s.split(path.sep).filter(Boolean);
  if (segs.length) {
    for (const a of FOLDER_ALIASES) {
      if (a.re.test(segs[0])) { segs[0] = a.real; break; }
    }
  }
  return path.join(HOME, ...segs); // 상대경로는 앱 폴더가 아니라 사용자 홈 기준
}
function _norm(p) { return path.resolve(_resolveAlias(p)); }
function _cmp(p) { return WIN ? _norm(p).toLowerCase() : _norm(p); } // Windows 대소문자 무시

// 사용자가 보낸 첨부가 담기는 download 폴더 — 항상 허용경계에 포함(사용자 소유 파일이라 에이전트가 읽고·다시 보낼 수 있게).
let _downloadDir = null;
function setDownloadDir(dir) { _downloadDir = dir ? _cmp(dir) : null; }
function _inDir(t, dd) { return t === dd || t.startsWith(dd + path.sep) || t.startsWith(dd + '/'); }

// ── 보호 경로(하드 deny) — allowedDirs로도 절대 못 뚫는다 ──────────────────────
// 에이전트(그리고 에이전트가 받은 스킬·MCP)가 "우리가 만든 계층·지침"을 직접 읽거나 고치지 못하게 한다.
//  · APP_ROOT   : Auxo 프로그램 폴더(brain-*.js·engine.js·시스템프롬프트·정직층·도구코어 전부)
//  · CLAUDE_DIR : 호스트 Claude Code 설정·전역지침(CLAUDE.md)·플러그인 (정체성 오염원)
//  · _protectedData : userData(대화·기억·API키·스킬/MCP 레지스트리) — 단 download(사용자 첨부)는 제외
// 정책(마스터 2026-07-15): "스킬이든 MCP든 우리 계층·지침 직접 수정은 뭘 통해서든 불가." 프롬프트가 아니라 코드로 강제.
const APP_ROOT = _cmp(__dirname);
const CLAUDE_DIR = _cmp(path.join(HOME, '.claude'));
let _protectedData = [];
function setProtectedDataPaths(list) { _protectedData = (Array.isArray(list) ? list : [list]).filter(Boolean).map(_cmp); }
/** target 이 보호 경로 안(또는 동일)인가. download 폴더는 사용자 소유라 예외(보호 대상 아님). */
function isProtected(target) {
  const t = _cmp(target);
  if (_downloadDir && _inDir(t, _downloadDir)) return false; // 사용자 첨부 폴더는 보호 대상 아님(예외 우선)
  if (_inDir(t, APP_ROOT)) return true;
  if (_inDir(t, CLAUDE_DIR)) return true;
  return _protectedData.some(d => _inDir(t, d));
}

/** target 이 허용 폴더(allowedDirs) 중 하나의 내부(또는 동일)인가. download 폴더는 항상 허용, 보호경로는 항상 거부. */
function isAllowed(allowedDirs, target) {
  const t = _cmp(target);
  if (_downloadDir && _inDir(t, _downloadDir)) return true; // 사용자 첨부: 보호검사보다 먼저(항상 허용)
  if (isProtected(target)) return false;                    // 보호경로: allowedDirs로도 못 뚫음(deny가 allow를 이김)
  return (allowedDirs || []).some(d => _inDir(t, _cmp(d)));
}

/** 셸 명령 문자열이 보호 경로를 겨냥하는가(best-effort — 셸은 소프트가드, 진짜 격리는 OS 샌드박스=백로그). */
function commandMentionsProtected(cmd) {
  const s = String(cmd || '');
  const c = WIN ? s.toLowerCase() : s;
  let norm = WIN ? c.replace(/\//g, '\\') : c;
  // download(사용자 첨부) 폴더 언급은 보호검사에서 제외 — isProtected/isAllowed 의 예외와 동일하게 맞춘다.
  //   userData 하위지만 사용자 소유라 셸로 다뤄도 된다. 이 조각만 지우므로 userData 의 다른 보호대상(auxo.db 등)은 그대로 걸린다.
  if (_downloadDir && norm.includes(_downloadDir)) norm = norm.split(_downloadDir).join(' ');
  const roots = [APP_ROOT, CLAUDE_DIR, ..._protectedData];
  if (roots.some(r => r && norm.includes(r))) return true; // 절대경로 직접 겨냥
  // 상대경로 우회 완화: 보호 폴더 '이름'이 경로 조각으로 나와도 차단(예: ../agentlink-app/…, .claude/…).
  const names = [path.basename(APP_ROOT), '.claude'];
  return names.some(n => n && new RegExp('(^|[\\s"\'\\\\/])' + n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '[\\\\/]', 'i').test(s));
}

function listFiles(allowedDirs, dir) {
  if (!isAllowed(allowedDirs, dir)) return { error: '허용되지 않은 폴더예요.', needGrant: _norm(dir) };
  try {
    const entries = fs.readdirSync(_norm(dir), { withFileTypes: true });
    return { dir: _norm(dir), entries: entries.map(e => ({ name: e.name, type: e.isDirectory() ? 'dir' : 'file' })) };
  } catch (e) { return { error: e.message }; }
}

function readFile(allowedDirs, file, maxBytes = 200000) {
  if (!isAllowed(allowedDirs, file)) return { error: '허용되지 않은 경로예요.', needGrant: _norm(file) };
  try {
    const buf = fs.readFileSync(_norm(file));
    return { path: _norm(file), content: buf.slice(0, maxBytes).toString('utf8'), truncated: buf.length > maxBytes, bytes: buf.length };
  } catch (e) { return { error: e.message }; }
}

function writeFile(allowedDirs, file, content) {
  if (!isAllowed(allowedDirs, file)) return { error: '허용되지 않은 경로예요.', needGrant: _norm(file) };
  try {
    fs.mkdirSync(path.dirname(_norm(file)), { recursive: true });
    fs.writeFileSync(_norm(file), content == null ? '' : String(content), 'utf8');
    return { written: true, path: _norm(file) };
  } catch (e) { return { error: e.message }; }
}

function makeDir(allowedDirs, dir) {
  if (!isAllowed(allowedDirs, dir)) return { error: '허용되지 않은 경로예요.', needGrant: _norm(dir) };
  try { fs.mkdirSync(_norm(dir), { recursive: true }); return { created: true, path: _norm(dir) }; }
  catch (e) { return { error: e.message }; }
}

/** dir 하위에서 파일명에 query 가 포함된 것 검색(간단). max 개까지. */
function searchFiles(allowedDirs, dir, query, max = 50) {
  if (!isAllowed(allowedDirs, dir)) return { error: '허용되지 않은 폴더예요.', needGrant: _norm(dir) };
  const q = String(query || '').toLowerCase();
  const hits = [];
  (function walk(d) {
    if (hits.length >= max) return;
    let ents; try { ents = fs.readdirSync(d, { withFileTypes: true }); } catch (_) { return; }
    for (const e of ents) {
      if (hits.length >= max) break;
      const fp = path.join(d, e.name);
      if (e.isDirectory()) walk(fp);
      else if (!q || e.name.toLowerCase().includes(q)) hits.push(fp);
    }
  })(_norm(dir));
  return { matches: hits, truncated: hits.length >= max };
}

// 경로 자신 또는 부모 폴더가 실제로 존재하는지. 두뇌가 'C:\Users\User\...'처럼 지어낸 가짜 경로를
// grant_dir에 등록하지 못하게 막는 용도(부모가 있으면 그 안에 새 폴더를 만들 수는 있으니 허용).
function pathOrParentExists(p) {
  const norm = _norm(p);
  try { if (fs.statSync(norm).isDirectory()) return true; } catch (_) {}
  try { if (fs.statSync(path.dirname(norm)).isDirectory()) return true; } catch (_) {}
  return false;
}

module.exports = { isAllowed, isProtected, commandMentionsProtected, setProtectedDataPaths, listFiles, readFile, writeFile, makeDir, searchFiles, _norm, pathOrParentExists, setDownloadDir };
