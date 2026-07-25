/**
 * brain-antigravity.js — Google Antigravity(구독) CLI 두뇌 커넥터.
 *
 * `agy --print`(non-interactive)를 호출해 응답을 받는다. claude/codex 구독과 같은
 * "구독/계정 CLI 두뇌" 방식. 인증은 사용자가 Antigravity(앱 또는 CLI 첫 실행)로 OAuth 로그인해둔다.
 * 안티그래비티는 Gemini·Claude·GPT-OSS를 함께 제공하는 멀티모델 허브다(모델 선택=후속).
 *
 * 시그니처는 다른 두뇌와 동일: (systemPrompt, userPrompt, opts) -> Promise<text>
 *
 * 실측 확증(2026-07-06):
 *  - 실행:  `agy --print "<프롬프트>"` — 프롬프트는 **인자 값**(stdin 아님). 출력은 **순수 텍스트**(codex식 헤더/푸터 없음).
 *  - 긴 1층(수천~1만 자)은 Windows cmd 인자 제한(8191)에 걸리므로 **shell:false 로 spawn**(CreateProcess ~32K 통과). 6.2K 실측 PASS.
 *  - 인증:  전용 login/status 명령·자격 파일 없음(OS 키링). → 로그인 여부는 데이터 폴더(~/.gemini/antigravity 등) 존재로 폴백 판단.
 *  - 오염:  GEMINI.md/AGENTS.md 자동 참조 위험(문서). 실측상 기본 cwd 조건에선 자동주입 안 됨 → **깨끗한 cwd** + 1층 [정체성 격리] 지침으로 이중 방어.
 *  - 도구(MCP): 파일 기반 설정만 지원(인자 동적주입 불가) → v1 은 대화·파일입력만, MCP 도구는 후속(백로그).
 *
 * macOS/Linux 추가 실측(2026-07-06, agy 1.0.16 — Windows 와 동작이 다름):
 *  - stdout 이 TTY 가 아니면 응답이 유실됨(google-antigravity/antigravity-cli#76)
 *    → script(1) 로 pseudo-TTY 를 만들어 감싼다. 실패 시 stdout 에 "Error: timeout waiting for response".
 *  - Gemini/GPT-OSS 는 플래너 경로("PlannerResponse without ModifiedResponse")로 빠져 print 가 응답을 못 받음
 *    → macOS/Linux 기본 모델은 실측 검증된 Claude Sonnet 4.6 고정(사용자 지정 시 그대로 전달).
 */
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, execSync } = require('child_process');
const { SUBSCRIPTION_TURN_TIMEOUT_MS } = require('./constants');

/** agy 실행파일 경로 — 공식 설치 위치(%LOCALAPPDATA%\agy\bin\agy.exe) 우선, 없으면 PATH 조회. */
function findAgyBin() {
  try {
    const local = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
    const p = path.join(local, 'agy', 'bin', process.platform === 'win32' ? 'agy.exe' : 'agy');
    if (fs.existsSync(p)) return p;
  } catch (_) {}
  try {
    const cmd = process.platform === 'win32' ? 'where agy' : 'which agy';
    const out = execSync(cmd, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim().split(/\r?\n/)[0];
    if (out) return out;
  } catch (_) {}
  // macOS/Linux curl 설치 스크립트 기본 위치(Electron 배포본은 PATH 에 ~/.local/bin 이 없을 수 있음)
  try {
    const p = path.join(os.homedir(), '.local', 'bin', 'agy');
    if (fs.existsSync(p)) return p;
  } catch (_) {}
  return null;
}
const AGY_BIN = findAgyBin();
function isAvailable() { return !!AGY_BIN; }

/**
 * 로그인(OAuth) 여부 — 전용 status 명령이 없어 데이터 폴더 존재로 폴백 판단.
 * Antigravity 사용 흔적(대화기록·설정)이 있으면 로그인된 것으로 본다(빠른 판정).
 */
function isLoggedIn() {
  try {
    const home = os.homedir();
    const marks = [
      path.join(home, '.gemini', 'antigravity'),
      path.join(home, '.gemini', 'antigravity-cli'), // macOS CLI 데이터 폴더(실측)
      path.join(home, '.antigravity'),
      path.join(home, '.antigravity-ide'),
    ];
    return marks.some(p => { try { return fs.existsSync(p); } catch (_) { return false; } });
  } catch (_) { return false; }
}

/** 상태 요약 — 다른 구독 두뇌의 loginStatus() 와 시그니처 통일. */
function loginStatus() {
  if (!AGY_BIN) return { loggedIn: false };
  return { loggedIn: isLoggedIn() };
}

/** 격리용 깨끗한 작업 폴더(GEMINI.md/AGENTS.md 없는 곳) 보장. */
function cleanWorkspace() {
  const dir = path.join(os.tmpdir(), 'auxo-agy-ws');
  try { fs.mkdirSync(dir, { recursive: true }); } catch (_) {}
  return dir;
}

/**
 * @param {string} systemPrompt  1층 등 시스템 지시(격리 지침 포함)
 * @param {string} userPrompt    사용자 메시지(+대화 맥락)
 * @param {Object} opts          { timeout, model }
 * @returns {Promise<string>}
 */
function antigravityGenerate(systemPrompt, userPrompt, opts = {}) {
  return new Promise((resolve, reject) => {
    if (!AGY_BIN) return reject(new Error('Antigravity(agy) CLI를 찾을 수 없음 — 설치·로그인 필요'));
    // 시스템 지시와 사용자 메시지를 하나의 프롬프트로 합쳐 전달(전용 system 플래그가 없음).
    // 이미지 첨부(비전): claude·codex와 동일 패턴으로 파일 경로를 열어보게 안내. ⚠️ agy CLI 미설치로 실측 미검증(2026-07-13).
    const _imgs = Array.isArray(opts.imageFiles) ? opts.imageFiles.filter(Boolean) : [];
    const _imgNote = _imgs.length ? `\n\n[사용자가 방금 첨부한 파일(이미지·PDF) — 이 파일(들)을 열어서 실제로 보고 답해. 상상하지 말고 반드시 열어봐]\n${_imgs.join('\n')}` : '';
    const fullPrompt = (systemPrompt ? systemPrompt.trim() + '\n\n──────────\n\n' : '') + (userPrompt || '') + _imgNote;
    const timeoutMs = opts.timeout || SUBSCRIPTION_TURN_TIMEOUT_MS; // 대화 타임아웃 = 공통 상수(구독 3종 동일값, 하드코딩 금지).
    // agy 는 에러(quota 소진 등)를 stdout/stderr 로 안 주고 로그파일에만 남긴다 → 임시 로그로 받아 빈 응답 원인 판별.
    const logFile = path.join(os.tmpdir(), `agy-log-${process.pid}-${Date.now()}.log`);
    const unix = process.platform !== 'win32';
    // macOS/Linux: 모델 미지정이면 print 모드가 검증된 Claude Sonnet 으로(파일 상단 주석 참고). Windows 는 agy 기본값.
    const model = opts.model || (unix ? 'Claude Sonnet 4.6 (Thinking)' : null);
    const args = ['--print', fullPrompt, '--print-timeout', Math.ceil(timeoutMs / 1000) + 's', '--log-file', logFile];
    if (model) args.push('--model', String(model)); // 멀티모델 허브(기본은 사용자 설정 모델)

    // macOS/Linux: 비-TTY stdout 유실(#76) 우회 — script(1) 로 pseudo-TTY 할당.
    let cmd = AGY_BIN, cmdArgs = args;
    if (process.platform === 'darwin') {
      cmd = '/usr/bin/script'; cmdArgs = ['-q', '/dev/null', AGY_BIN, ...args];
    } else if (process.platform === 'linux') {
      const q = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`; // linux script 는 -c 한 줄 명령 → 셸 이스케이프
      cmd = 'script'; cmdArgs = ['-qec', [AGY_BIN, ...args].map(q).join(' '), '/dev/null'];
    }

    // ⚠️ 청크를 문자열로 바로 이어붙이지 않는다. 한글 등 멀티바이트 문자가 청크 경계에서 반토막 나면
    //    각 청크가 개별 디코딩되며 깨진다(`포<깨짐>이돈`). → Buffer 로 모아 마지막에 한 번에 UTF-8 디코딩.
    const outChunks = [], errChunks = [];
    // shell:false — 긴 인자를 CreateProcess 로 그대로 전달(cmd 인자 길이 제한 회피). cwd 격리.
    // stdin:'ignore' — agy 가 열린 stdin 에서 입력을 기다려 매달리는 것 방지(--print 는 인자로만 받음).
    const proc = spawn(cmd, cmdArgs, { shell: false, windowsHide: true, cwd: cleanWorkspace(), stdio: ['ignore', 'pipe', 'pipe'] });
    // '무응답(idle)' 타임아웃 — 출력이 흐르는 동안엔 안 죽인다(무거운 생성 중간절단 방지, claude·codex와 동일 원리).
    const IDLE_MS = timeoutMs + 5000;
    let timer = null;
    const armIdle = () => { clearTimeout(timer); timer = setTimeout(() => { try { proc.kill(); } catch (_) {} reject(new Error('Antigravity 응답 시간 초과')); }, IDLE_MS); };
    armIdle();
    // 정지(정지 버튼/ESC): 진행 중 CLI 자식 프로세스를 실제로 종료한다.
    if (opts.signal) {
      const onAbort = () => { try { proc.kill(); } catch (_) {} clearTimeout(timer); reject(Object.assign(new Error('사용자 정지'), { aborted: true })); };
      if (opts.signal.aborted) onAbort(); else opts.signal.addEventListener('abort', onAbort, { once: true });
    }
    proc.stdout.on('data', d => { armIdle(); outChunks.push(d); });
    proc.stderr.on('data', d => { armIdle(); errChunks.push(d); });
    proc.on('error', e => { clearTimeout(timer); reject(e); });
    proc.on('close', (code) => {
      clearTimeout(timer);
      let text = Buffer.concat(outChunks).toString('utf8').trim(); // 순수 텍스트 출력(경계 안전 디코딩)
      const err = Buffer.concat(errChunks).toString('utf8');
      if (unix) {
        // pty 캡처 잔여물 정리: ANSI 이스케이프·제어문자·CR·stdin EOF 캐럿표기("^D")
        text = text
          .replace(/\x1B\[[0-9;?]*[A-Za-z]/g, '').replace(/\x1B\][^\x07]*\x07/g, '')
          .replace(/\r/g, '').replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '')
          .replace(/^(\^D)+/, '').trim();
        // agy 가 응답을 못 받으면 stdout 에 이 문구만 남긴다(종료코드는 script 래핑으로 유실될 수 있음) → 빈 응답으로 취급.
        if (/^Error: timeout waiting for response$/m.test(text)) text = '';
      }
      if (!text) {
        // 빈 응답 — 로그파일에서 원인(사용량 한도 등)을 읽어 사용자에게 정직히 안내.
        let log = '';
        try { log = fs.readFileSync(logFile, 'utf8'); } catch (_) {}
        try { fs.unlinkSync(logFile); } catch (_) {}
        if (/RESOURCE_EXHAUSTED|code 429|quota reached/i.test(log)) {
          const m = log.match(/Resets in (\d+)h/);
          const when = m ? ` (약 ${Math.max(1, Math.ceil(Number(m[1]) / 24))}일 뒤 리셋)` : '';
          return resolve(`지금은 Antigravity 무료 사용량 한도에 걸려서 답을 못 가져왔어${when}. Antigravity는 어떤 모델을 골라도 같은 한도를 써서, 모델만 바꾸는 걸로는 안 돼. 설정에서 "Antigravity 말고 다른 AI"(Claude 구독·Gemini 등)로 바꾸면 바로 이어갈 수 있어.`);
        }
        // macOS/Linux: 플래너 경로로 빠진 모델(Gemini·GPT-OSS)은 응답이 영영 안 옴 → 원인 안내(무한 빈응답 방지)
        if (unix) return reject(new Error(`Antigravity 응답 없음 — 모델(${model || '기본'})이 print 모드와 호환되지 않을 수 있어요. 설정에서 Claude 계열 모델을 권해요.`));
        if (code !== 0) return reject(new Error(`Antigravity 종료(${code}): ${err.slice(0, 200)}`));
        return resolve('(빈 응답)');
      }
      try { fs.unlinkSync(logFile); } catch (_) {}
      resolve(text);
    });
  });
}

module.exports = { antigravityGenerate, isAvailable, isLoggedIn, loginStatus };
