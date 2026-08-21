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
// 정책: "스킬이든 MCP든 우리 계층·지침 직접 수정은 뭘 통해서든 불가." 프롬프트가 아니라 코드로 강제.
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

/**
 * 짧은 주소(상대경로)를 **어느 폴더 기준으로 풀지** 고른다.
 *
 * ★왜 필요한가 (2026-08-21 실측):
 *   지금까지 짧은 주소는 **무조건 집(홈) 기준**이었다. 그건 *"바탕화면에 메모 만들어줘"* 를
 *   받으려고 일부러 그렇게 한 것이고, 그 경우엔 지금도 맞다.
 *   그런데 짧은 주소가 오는 경우가 **둘**이었다 —
 *     ① "바탕화면에 있는 거"      → 집 기준          ✅ 되고 있었다
 *     ② "방금 그 폴더 안에 있는 거" → 허용 폴더 기준   ❌ 통째로 빠져 있었다
 *   ②가 빠져 있어서 *"옛이름 폴더 이름 바꿔줘"* 가 `C:\Users\<나>\옛이름` 을 찾다 실패했다.
 *   파일 도구 **9개 전부** 같은 증상이었고, 실패할 때 `needGrant` 로 **집 전체**를 달라고 했다.
 *
 * ★넓어지지 않는다 — 후보는 전부 isAllowed 를 통과한 것만 쓴다.
 *   하나도 못 고르면 **예전 그대로**(집 기준)를 돌려준다 → 오류 문구·동작이 그대로 남는다.
 */
function _있나(p) { try { return fs.existsSync(p); } catch (_) { return false; } }
function _부모있나(p) { try { return fs.statSync(path.dirname(p)).isDirectory(); } catch (_) { return false; } }
function _별칭으로시작(s) {
  const seg = String(s).replace(/[\\/]+/g, path.sep).split(path.sep).filter(Boolean)[0];
  return !!seg && FOLDER_ALIASES.some(a => a.re.test(seg));
}
function _pick(allowedDirs, p) {
  const s = String(p || '').trim();
  if (!s) return s;
  const 집기준 = _norm(s);
  if (path.isAbsolute(s) || /^[a-zA-Z]:/.test(s)) return 집기준;   // 절대경로 → 그대로
  if (_별칭으로시작(s)) return 집기준;                              // "바탕화면/…" → 사용자가 대놓고 말한 것
  const 후보 = (allowedDirs || []).map(d => path.resolve(_norm(d), s)).filter(c => isAllowed(allowedDirs, c));
  // ① 실제로 있는 것부터 — 읽기·이름바꾸기처럼 **이미 있는 대상**을 다루는 경우
  if (isAllowed(allowedDirs, 집기준) && _있나(집기준)) return 집기준;
  for (const c of 후보) if (_있나(c)) return c;
  // ② 없으면 부모가 있는 것 — 새로 만드는 경우(write_file·make_dir·옮길 곳)
  if (isAllowed(allowedDirs, 집기준) && _부모있나(집기준)) return 집기준;
  for (const c of 후보) if (_부모있나(c)) return c;
  return 집기준;                                                    // 못 고르면 예전 그대로
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
  // 상대경로 우회 완화: 보호 폴더 '이름'이 경로 조각으로 나와도 차단(예: ../<앱폴더>/…, .claude/…).
  const names = [path.basename(APP_ROOT), '.claude'];
  return names.some(n => n && new RegExp('(^|[\\s"\'\\\\/])' + n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '[\\\\/]', 'i').test(s));
}

function listFiles(allowedDirs, dir) {
  dir = _pick(allowedDirs, dir);
  if (!isAllowed(allowedDirs, dir)) return { error: '허용되지 않은 폴더예요.', needGrant: _norm(dir) };
  try {
    const entries = fs.readdirSync(_norm(dir), { withFileTypes: true });
    return { dir: _norm(dir), entries: entries.map(e => ({ name: e.name, type: e.isDirectory() ? 'dir' : 'file' })) };
  } catch (e) { return { error: e.message }; }
}

function readFile(allowedDirs, file, maxBytes = 200000) {
  file = _pick(allowedDirs, file);
  if (!isAllowed(allowedDirs, file)) return { error: '허용되지 않은 경로예요.', needGrant: _norm(file) };
  try {
    const buf = fs.readFileSync(_norm(file));
    return { path: _norm(file), content: buf.slice(0, maxBytes).toString('utf8'), truncated: buf.length > maxBytes, bytes: buf.length };
  } catch (e) { return { error: e.message }; }
}

function writeFile(allowedDirs, file, content) {
  file = _pick(allowedDirs, file);
  if (!isAllowed(allowedDirs, file)) return { error: '허용되지 않은 경로예요.', needGrant: _norm(file) };
  try {
    fs.mkdirSync(path.dirname(_norm(file)), { recursive: true });
    fs.writeFileSync(_norm(file), content == null ? '' : String(content), 'utf8');
    return { written: true, path: _norm(file) };
  } catch (e) { return { error: e.message }; }
}

function makeDir(allowedDirs, dir) {
  dir = _pick(allowedDirs, dir);
  if (!isAllowed(allowedDirs, dir)) return { error: '허용되지 않은 경로예요.', needGrant: _norm(dir) };
  try { fs.mkdirSync(_norm(dir), { recursive: true }); return { created: true, path: _norm(dir) }; }
  catch (e) { return { error: e.message }; }
}

/**
 * 파일·폴더를 **옮기거나 이름을 바꾼다.**
 *
 * ★왜 만들었나 (2026-08-21 실사용):
 *   사용자가 *"그 폴더 이름을 GPT이미지로 바꿔줘"* 라고 했는데 **그런 도구가 없었다.**
 *   그래서 에이전트가 셸(`Rename-Item`)로 우회하려 했고, 셸은 허용을 받고도 못 부르는
 *   codex 쪽 제약에 걸려 **결국 아무것도 못 했다.**
 *   폴더 이름 바꾸기는 아주 흔한 일이다. 그걸 셸로 돌리는 구조 자체가 잘못이었다.
 *
 * ★출발지와 도착지를 **둘 다** 검사한다. 하나만 보면 허용 폴더 밖으로 빼돌릴 수 있다.
 *   (허용된 폴더 안의 파일을 허용 안 된 곳으로 move 하면 그게 유출이다)
 */
/**
 * 파일·폴더를 **지운다.**
 *
 * ★되돌릴 수 없다. 그래서 다른 파일 도구와 달리 **승인을 받는다**(agent-tools 에서 게이트).
 *   허용된 폴더 안이라도 지우는 것은 다르다 — "쓸 수 있다" 와 "없애도 된다" 는 같은 말이 아니다.
 *
 * ⚠️ 폴더를 지울 때 **안에 든 것까지 통째로** 사라진다. 그래서 개수를 함께 돌려준다 —
 *   에이전트가 사용자에게 "3개가 들어 있는데 지울까요" 라고 물을 수 있어야 한다.
 */
function removeFile(allowedDirs, target) {
  target = _pick(allowedDirs, target);
  if (!isAllowed(allowedDirs, target)) return { error: '허용되지 않은 경로예요.', needGrant: _norm(target) };
  const T = _norm(target);
  if (!fs.existsSync(T)) return { error: '지울 대상이 없어요: ' + T };
  try {
    const st = fs.statSync(T);
    let 안개수 = 0;
    if (st.isDirectory()) { try { 안개수 = fs.readdirSync(T).length; } catch (_) {} }
    fs.rmSync(T, { recursive: true, force: true });
    return { removed: true, path: T, wasDirectory: st.isDirectory(), 안에있던것: 안개수 };
  } catch (e) { return { error: e.message }; }
}

/**
 * 파일·폴더를 **복사한다.** 폴더면 안의 것까지 함께.
 *   moveFile 과 같은 이유로 출발지·도착지를 **둘 다** 검사한다.
 *   이미 있는 이름이면 거부한다 — 덮어쓰면 되돌릴 수 없다.
 */
/**
 * 폴더를 한 겹씩 직접 복사한다.
 *
 * ★왜 fs.cpSync 를 안 쓰나 (2026-08-21 실측):
 *   Node 22.17.0 의 `fs.cpSync` 가 **한글 이름 폴더에서 프로세스를 죽인다**(Segmentation fault).
 *   예외가 아니라 **프로세스가 통째로 사라진다** — try/catch 로도 못 잡는다.
 *   영문 이름은 멀쩡하다. 한국 사용자 제품이라 그냥 둘 수 없어 직접 구현한다.
 */
function _copyTree(F, T) {
  const st = fs.statSync(F);
  if (!st.isDirectory()) { fs.copyFileSync(F, T); return; }
  fs.mkdirSync(T, { recursive: true });
  for (const 이름 of fs.readdirSync(F)) _copyTree(path.join(F, 이름), path.join(T, 이름));
}

/**
 * 파일·폴더를 **복사한다.** 폴더면 안의 것까지 함께.
 *   moveFile 과 같은 이유로 출발지·도착지를 **둘 다** 검사한다.
 *   이미 있는 이름이면 거부한다 — 덮어쓰면 되돌릴 수 없다.
 */
/**
 * 옮길 곳·복사해 넣을 곳이 **짧게** 오면 출발지와 **같은 폴더**로 본다.
 *   "옛이름 → 새이름" 은 자리를 옮기는 게 아니라 **그 자리에서 이름만 바꾸는 것**이다.
 *   이걸 집 기준으로 풀면 이름만 바꾸려던 게 집으로 옮기는 일이 돼버린다.
 */
function _pick도착(allowedDirs, F, to) {
  const s = String(to || '').trim();
  if (!s) return s;
  if (path.isAbsolute(s) || /^[a-zA-Z]:/.test(s) || _별칭으로시작(s)) return _pick(allowedDirs, s);
  const 같은자리 = path.resolve(path.dirname(F), s);
  return isAllowed(allowedDirs, 같은자리) ? 같은자리 : _pick(allowedDirs, s);
}

function copyFile(allowedDirs, from, to) {
  from = _pick(allowedDirs, from);
  to = _pick도착(allowedDirs, _norm(from), to);
  if (!isAllowed(allowedDirs, from)) return { error: '복사할 대상이 허용되지 않은 경로예요.', needGrant: _norm(from) };
  if (!isAllowed(allowedDirs, to)) return { error: '복사해 넣을 곳이 허용되지 않은 경로예요.', needGrant: _norm(to) };
  const F = _norm(from), T = _norm(to);
  if (!fs.existsSync(F)) return { error: '복사할 대상이 없어요: ' + F };
  if (fs.existsSync(T)) return { error: '그 이름이 이미 있어요: ' + T };
  try {
    fs.mkdirSync(path.dirname(T), { recursive: true });
    _copyTree(F, T);
    return { copied: true, from: F, to: T };
  } catch (e) { return { error: e.message }; }
}

function moveFile(allowedDirs, from, to) {
  from = _pick(allowedDirs, from);
  to = _pick도착(allowedDirs, _norm(from), to);
  if (!isAllowed(allowedDirs, from)) return { error: '옮길 대상이 허용되지 않은 경로예요.', needGrant: _norm(from) };
  if (!isAllowed(allowedDirs, to)) return { error: '옮길 곳이 허용되지 않은 경로예요.', needGrant: _norm(to) };
  const F = _norm(from), T = _norm(to);
  if (!fs.existsSync(F)) return { error: '옮길 대상이 없어요: ' + F };
  if (fs.existsSync(T)) return { error: '그 이름이 이미 있어요: ' + T };   // 덮어쓰기는 하지 않는다(되돌릴 수 없다)
  try {
    fs.mkdirSync(path.dirname(T), { recursive: true });
    fs.renameSync(F, T);
    return { moved: true, from: F, to: T };
  } catch (e) {
    // 다른 드라이브 사이면 rename 이 안 된다 — 그때만 복사 후 삭제로 대신한다.
    if (e && e.code === 'EXDEV') {
      try { _copyTree(F, T)   /* cpSync 는 한글 폴더에서 죽는다 */; fs.rmSync(F, { recursive: true, force: true }); return { moved: true, from: F, to: T }; }
      catch (e2) { return { error: e2.message }; }
    }
    return { error: e.message };
  }
}

/** dir 하위에서 파일명에 query 가 포함된 것 검색(간단). max 개까지. */
function searchFiles(allowedDirs, dir, query, max = 50) {
  dir = _pick(allowedDirs, dir);
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

module.exports = { isAllowed, isProtected, commandMentionsProtected, setProtectedDataPaths, listFiles, readFile, writeFile, makeDir, moveFile, removeFile, copyFile, searchFiles, _norm, pathOrParentExists, setDownloadDir };
