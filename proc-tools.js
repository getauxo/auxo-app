/**
 * proc-tools.js — 공통 셸/터미널 실행 코어(두뇌 무관 단일 소스).
 *
 * 안전 모델(소프트 가드 — OS급 완전 격리는 아님, 진짜 격리는 백로그):
 *  - 작업 위치(cwd)는 allowedDirs 안에서만 (fs-tools.isAllowed 재사용).
 *  - 파괴적 명령(rm -rf, format, shutdown, del /s, reg delete 등)은 패턴 차단(allowShell이어도 차단).
 *  - 타임아웃 + 출력 크기 제한.
 *  - "셸 사용 허용"(allowShell)·자율도(autonomous)는 상위(agent-tools/auxo-mcp)에서 게이트.
 */
'use strict';
const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');
const fsTools = require('./fs-tools');

// execSync 공통 옵션(셸·환경은 기본값 사용 — 셸을 명시했던 건 헛다리였다. ENOENT의 진짜 원인은 '없는 cwd'였다).
function execOpts(dir, opts) {
  return { cwd: dir, timeout: opts.timeout || 30000, maxBuffer: 1024 * 1024 * 4,
    stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, encoding: 'utf8' };
}

// 파괴적/시스템 위험 명령 — 차단(우회 가능하지만 1차 방어). 이름만으로도 막는다.
const DANGER = /(\brm\s+-[a-z]*r[a-z]*f|\brm\s+-[a-z]*f[a-z]*r|\bdel\s+\/|\brmdir\s+\/s|\brd\s+\/s|\bformat\b|\bshutdown\b|\breboot\b|\bmkfs\b|\bdiskpart\b|\breg\s+delete\b|\bdd\s+if=|>\s*\/dev\/(sd|hd|null\/)|:\(\)\s*\{\s*:|\bfork\b.*bomb|\bchmod\s+-R\s+777\s+\/|\bsudo\s+rm)/i;

function isDangerous(cmd) { return DANGER.test(String(cmd || '')); }

// 보호 경로: 호스트 Claude Code 설정·플러그인(~/.claude, 플러그인 마켓플레이스) 등 시스템 폴더.
// 분신이 남의 스킬/플러그인을 "고치겠다"며 이 폴더를 git·수정하는 정체성 오염 사고(2026-07-14) 차단.
const PROTECTED = /(\.claude[\\/]|[\\/]\.claude(["'\s]|$)|claude[\\/]plugins[\\/]|[\\/]plugins[\\/]marketplaces[\\/])/i;
function touchesProtected(cmd) { return PROTECTED.test(String(cmd || '')); }

/**
 * @param {string[]} allowedDirs  허용 폴더
 * @param {string}   command      실행할 명령
 * @param {string}   [cwd]        작업 폴더(없으면 allowedDirs[0])
 * @param {object}   [opts]       { timeout, maxOut }
 */
// 작업 폴더(cwd) 결정 — 근본 안전장치.
// 핵심: "실제로 존재하는 허용 폴더"에서만 실행한다. 두뇌가 'C:\Users\User\...'처럼 사용자명을 잘못
// 지어낸 경로를 cwd로 주거나, 그게 허용목록에 등록돼 있더라도, 디렉터리가 실제로 없으면 절대 쓰지 않는다.
// (없는 폴더를 cwd로 넘기면 spawn이 'cmd.exe ENOENT'를 낸다 — 이게 그 에러의 진짜 원인이었다.)
function resolveCwd(allowedDirs, cwd) {
  const norm = (allowedDirs || []).map(d => fsTools._norm(d));
  const existing = norm.filter(d => { try { return fs.statSync(d).isDirectory(); } catch (_) { return false; } });
  const fb = existing[0] || null;                       // 실제 존재하는 허용 폴더 중 첫 번째
  let dir = (cwd && String(cwd).trim()) ? fsTools._norm(cwd) : fb;
  if (!dir) return { error: '실행할 수 있는 폴더가 없어. 존재하는 폴더를 허용해줘(grant_dir).', needGrant: true };
  // cwd가 허용목록 안이고 + 실제로 존재할 때만 그대로 사용. 아니면 존재하는 허용 폴더로.
  if (!(fsTools.isAllowed(allowedDirs, dir) && existing.includes(dir))) {
    if (fb) dir = fb;
    else return { error: '허용된 폴더가 실제로 존재하지 않아. 존재하는 폴더를 다시 허용(grant_dir)해줘.', needGrant: dir };
  }
  return { dir };
}

function runShell(allowedDirs, command, cwd, opts = {}) {
  const cmd = String(command || '').trim();
  if (!cmd) return { error: '실행할 명령이 비어 있어.' };
  if (isDangerous(cmd)) return { blocked: true, error: '파괴적/위험 명령이라 차단했어: ' + cmd };
  if (touchesProtected(cmd)) return { blocked: true, error: '시스템/설정 폴더(~/.claude·플러그인 등)는 이 앱의 작업 범위가 아니라 건드릴 수 없어. 이건 Auxo 기능이 아니야.' };
  // Auxo 자체 코드·데이터(우리 계층·지침)를 절대경로로 직접 겨냥하면 차단 — 셸을 통한 자기수정 방지.
  if (fsTools.commandMentionsProtected(cmd)) return { blocked: true, error: 'Auxo 자체 프로그램·설정·데이터는 내가 고칠 수 없는 보호 영역이야.' };
  const rc = resolveCwd(allowedDirs, cwd);
  if (rc.error) return rc;
  const dir = rc.dir;
  const maxOut = opts.maxOut || 8000;
  try {
    const out = execSync(cmd, execOpts(dir, opts));
    return { ok: true, stdout: String(out).slice(0, maxOut) };
  } catch (e) {
    return {
      ok: false, code: e.status != null ? e.status : null,
      stdout: (e.stdout ? String(e.stdout) : '').slice(0, maxOut),
      stderr: (e.stderr ? String(e.stderr) : (e.message || '')).slice(0, maxOut),
      timedOut: e.signal === 'SIGTERM' || /ETIMEDOUT/.test(String(e.message || '')),
    };
  }
}

// 코드를 임시 파일에 써서 런타임으로 실행한다(긴 코드·이스케이프 회피). 실행 위치(cwd)는 allowedDirs 안.
// ⚠️ 코드 실행은 본질적으로 임의 코드 = 셸과 같은 위험군(상위에서 allowShell/autonomous 게이트).
const RUNNERS = { python: 'python', python3: 'python', node: 'node', javascript: 'node', js: 'node', bash: 'bash', sh: 'sh' };
const EXTS = { python: 'py', python3: 'py', node: 'js', javascript: 'js', js: 'js', bash: 'sh', sh: 'sh' };
function runCode(allowedDirs, language, code, cwd, opts = {}) {
  const lang = String(language || '').toLowerCase();
  const runner = RUNNERS[lang];
  if (!runner) return { error: `지원 안 하는 언어: ${language} (python/node/bash 중 하나)` };
  if (!String(code || '').trim()) return { error: '실행할 코드가 비어 있어.' };
  // 이 PC에 그 런타임이 실제로 있는지 먼저 확인. 없으면 명확히 알려 다른 언어로 다시 짜게 한다.
  // (Windows는 python 미설치여도 Store 별칭 때문에 실행만 하면 'Python' 안내만 떠 혼란 → 사전 차단)
  const avail = availableLangs();
  const availKey = runner === 'node' ? 'node' : runner === 'python' ? 'python' : (runner === 'bash' || runner === 'sh') ? 'bash' : null;
  if (availKey && !avail[availKey]) {
    const usable = Object.keys(avail).filter(k => avail[k]);
    return { error: `이 컴퓨터에선 '${language}' 코드를 실행할 수 없어(런타임 없음). 지금 쓸 수 있는 언어: ${usable.length ? usable.join(', ') : '없음'}. 그 중 하나로 코드를 다시 작성해서 실행해.`, availableLangs: usable };
  }
  const rc = resolveCwd(allowedDirs, cwd);
  if (rc.error) return rc;
  const dir = rc.dir;
  const tmp = path.join(os.tmpdir(), `auxo_code_${Date.now()}_${Math.floor(Math.random() * 1e6)}.${EXTS[lang] || 'txt'}`);
  try { fs.writeFileSync(tmp, String(code), 'utf8'); } catch (e) { return { error: '코드 파일 생성 실패: ' + e.message }; }
  const maxOut = opts.maxOut || 8000;
  try {
    const out = execSync(`${runner} "${tmp}"`, execOpts(dir, opts));
    return { ok: true, stdout: String(out).slice(0, maxOut) };
  } catch (e) {
    return {
      ok: false, code: e.status != null ? e.status : null,
      stdout: (e.stdout ? String(e.stdout) : '').slice(0, maxOut),
      stderr: (e.stderr ? String(e.stderr) : (e.message || '')).slice(0, maxOut),
      timedOut: /ETIMEDOUT/.test(String(e.message || '')),
    };
  } finally { try { fs.unlinkSync(tmp); } catch (_) {} }
}

// 이 컴퓨터에서 실제로 쓸 수 있는 코드 런타임 탐지(1회 캐시). 두뇌가 없는 런타임을 고르지 않게 안내용.
let _avail = null;
function availableLangs() {
  if (_avail) return _avail;
  _avail = {};
  for (const [k, bin] of [['node', 'node'], ['python', 'python'], ['bash', 'bash']]) {
    try {
      const out = execSync(`${bin} --version`, { stdio: ['ignore', 'pipe', 'pipe'], timeout: 5000, windowsHide: true, encoding: 'utf8' });
      // 실제 버전 문자열(숫자.숫자)이 나와야 진짜 설치. Windows의 python Store 별칭은 빈 출력이라 여기서 걸러진다.
      _avail[k] = /\d+\.\d+/.test(String(out || ''));
    } catch (_) { _avail[k] = false; }
  }
  return _avail;
}

module.exports = { runShell, runCode, isDangerous, availableLangs };
