/**
 * brain-codex.js — Codex(ChatGPT 구독) CLI 두뇌 커넥터.
 *
 * `codex exec`(non-interactive)를 호출해 응답을 받는다. claude 구독(claude CLI)과 같은
 * "구독/계정 CLI 두뇌" 방식. 인증은 사용자가 `codex login`(ChatGPT)으로 미리 해둔다.
 *
 * 시그니처는 다른 두뇌와 동일: (systemPrompt, userPrompt, opts) -> Promise<text>
 *  - 프롬프트는 stdin 으로 전달(인자 이스케이프 회피). 시스템+유저를 합쳐 보낸다.
 *  - codex 는 코딩 에이전트라 -s read-only 로 셸/파일 변경을 막고, 1층에서도 도구 사용을 억제.
 *
 * 출력 형식(codex exec): 헤더 → "--------" → "user\n<프롬프트>" → "codex\n<응답>" → "tokens used".
 *  → "codex\n" 과 "tokens used" 사이가 최종 응답.
 */
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, execSync } = require('child_process');
const { SUBSCRIPTION_TURN_TIMEOUT_MS } = require('./constants');

const WIN_EXEC_EXT = ['.exe', '.cmd', '.bat', '.com'];
function isRunnable(p) {
  try {
    if (!p || !fs.existsSync(p)) return false;
    if (process.platform !== 'win32') return true;
    return WIN_EXEC_EXT.includes(path.extname(p).toLowerCase());
  } catch (_) { return false; }
}

function findCodexBin() {
  // ① 파일 경로를 **직접** 본다. `where` 는 PATH 에만 의존하는데, 앱 안에서 npm 전역 설치를 하면
  //    그 PATH 가 이 프로세스에 반영돼 있지 않을 수 있다(설치 폴더가 PATH 에 없던 경우).
  const home = process.env.USERPROFILE || process.env.HOME || os.homedir() || '';
  const appdata = process.env.APPDATA || path.join(home, 'AppData', 'Roaming');
  const cands = process.platform === 'win32' ? [
    path.join(appdata, 'npm', 'codex.cmd'),          // npm 전역 설치 — 실행 가능한 쪽
    path.join(home, '.local', 'bin', 'codex.exe'),
  ] : [
    path.join(home, '.local', 'bin', 'codex'),
    '/usr/local/bin/codex', '/opt/homebrew/bin/codex',
  ];
  for (const c of cands) { try { if (isRunnable(c)) return c; } catch (_) {} }
  // ② 그 다음 PATH
  try {
    const cmd = process.platform === 'win32' ? 'where codex' : 'which codex';
    const out = execSync(cmd, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim().split(/\r?\n/)[0];
    if (out) return out;
  } catch (_) {}
  return null;
}

// ⚠️ 상수로 **박아두지 않는다.** 앱을 켤 때 CLI 가 없으면 그 `null` 이 그대로 굳어서,
//    사용자가 「자동설치하기」로 진짜 설치·로그인을 끝내도 앱은 **재시작 전까지 계속 "없다"** 고 본다.
//    → 로그인해도 다음으로 안 넘어가고, 「다시확인하기」도 같은 값을 읽어 무반응처럼 보인다.
//    (실사용자 실측 2026-08-16 · claude/codex 둘 다 재현)
//    찾은 뒤에는 재탐색하지 않으므로 `where` 반복 실행 부담은 없다.
let _bin = findCodexBin();
function codexBin() {
  if (!_bin) _bin = findCodexBin();
  return _bin;
}
/** shell:true 로 넘길 때 경로에 공백이 있어도 깨지지 않게(예: `C:\Users\홍 길동\...`). */
function _q(p) { return p && /\s/.test(p) ? `"${p}"` : (p || 'codex'); }
function isAvailable() { return !!codexBin(); }

/** codex 로그인(ChatGPT 인증) 여부 — ~/.codex/auth.json 존재로 판단(빠른 폴백). */
function isLoggedIn() {
  try {
    const p = path.join(os.homedir(), '.codex', 'auth.json');
    return fs.existsSync(p) && fs.statSync(p).size > 2;
  } catch (_) { return false; }
}

/** 공식 명령으로 로그인 상태 확인 — `codex login status` ("Logged in using ChatGPT" / "Not logged in"). */
function loginStatus() {
  if (!codexBin()) return { loggedIn: false };
  try {
    // codex 는 status 를 stderr 로 출력 → 2>&1 로 합쳐 캡처
    const out = execSync(`${_q(codexBin())} login status 2>&1`, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 8000 }).trim();
    if (/logged in/i.test(out)) return { loggedIn: true, raw: out };
    if (/not logged in/i.test(out)) return { loggedIn: false, raw: out };
    return { loggedIn: isLoggedIn(), raw: out }; // 예상밖 출력 → 파일 폴백
  } catch (_) {
    // status 비0 종료(미로그인)도 여기로 옴 → 파일 폴백
    return { loggedIn: isLoggedIn() };
  }
}

/**
 * codex stderr 에서 **실패 이유만** 뽑아낸다.
 *
 * codex 는 claude 와 달리 이유를 stderr 에 쓴다 — 거기까진 기존 코드가 맞았다.
 * 문제는 **앞에서 200자만 잘라 담던 것.** 실측(`--model 없는모델`):
 *   stderr 820자 · 실제 `ERROR: {...}` 는 **464번째 글자**에서 시작
 *   → slice(0,200) 은 배너("Reading prompt from stdin / workdir / model / sandbox…")만 담고
 *     정작 원인을 통째로 잘라냈다. engine.classifyBrainError 가 한도·인증을 알아볼 수 없다.
 * → ERROR 줄이 있으면 그 줄부터, 없으면 **뒤에서부터** 남긴다(원인은 대개 끝에 있다).
 */
function extractStderrReason(stderr) {
  const s = String(stderr || '').trim();
  if (!s) return '';
  const m = s.match(/^\s*(ERROR|error|Error)[:\s][\s\S]*$/m);
  const body = m ? m[0].trim() : s.slice(-1200);
  return body.slice(0, 1200);
}

/** codex exec stdout 에서 최종 응답만 뽑아낸다. */
function extractResponse(stdout) {
  const s = String(stdout || '');
  const m = s.match(/\ncodex\n([\s\S]*?)\ntokens used/);
  if (m) return m[1].trim();
  // 폴백: 마지막 "--------" 이후 전체(헤더 제거 시도)
  const idx = s.lastIndexOf('\ncodex\n');
  if (idx >= 0) return s.slice(idx + 7).replace(/\ntokens used[\s\S]*$/, '').trim();
  return s.trim();
}

/**
 * @param {string} systemPrompt  1층 등 시스템 지시
 * @param {string} userPrompt    사용자 메시지(+대화 맥락)
 * @param {Object} opts          { timeout }
 * @returns {Promise<string>}
 */
function codexGenerate(systemPrompt, userPrompt, opts = {}) {
  return new Promise((resolve, reject) => {
    if (!codexBin()) return reject(new Error('codex CLI를 찾을 수 없음 (codex login 필요)'));
    // 이미지 첨부(비전): codex는 read-only에서도 파일을 읽으므로 경로를 열어보게 안내(실측 확증: 빨강 PNG "빨강").
    const _imgs = Array.isArray(opts.imageFiles) ? opts.imageFiles.filter(Boolean) : [];
    const _imgNote = _imgs.length ? `\n\n[사용자가 방금 첨부한 파일(이미지·PDF) — 이 파일(들)을 열어서 실제로 보고 답해. 상상하지 말고 반드시 열어봐]\n${_imgs.join('\n')}` : '';
    const fullPrompt = (systemPrompt ? systemPrompt.trim() + '\n\n──────────\n\n' : '') + (userPrompt || '') + _imgNote;
    let codexCwd; // P2: workspace-write 시 작업 폴더(= 허용폴더)
    // --ignore-user-config: 이 PC 사용자의 codex 설정(~/.codex/config.toml)을 안 싣는다.
    //   ★claude 는 `--setting-sources project,local` 로 **모든 호출**에서 호스트 사용자 설정을
    //     끊는다. codex 도 같은 기준이어야 한다 — 두뇌가 달라도 안전 기준은 하나다.
    //   실측: 이걸 빼면 사용자 설정의 MCP 가 **기억 처리 호출에 실려 실제로 호출까지 된다.**
    //     기억 추출이 사용자의 도구를 부를 수 있다는 뜻이다.
    //   ※ 대화 경로에도 건다 — 우리 도구는 `-c mcp_servers.auxo…` 로 따로 주입하므로 안 죽는다.
    //     실측(_verify-codex-tools): 걸어도 **우리 것은 붙고 남의 것만 빠진다**.
    //   ※ 목록만 비우는 방법(-c mcp_servers={})은 **안 먹힌다** — 문법 3종 전부 그대로 붙었다(실측).
    //   ※ 같이 안 실리는 것: personality(우리는 우리 성격을 따로 준다) · notify(기억 정리에 외부 실행 불필요)
    //     · trust_level(우리는 --skip-git-repo-check 와 -s 로 별도 처리). 인증은 CODEX_HOME 이라 유지(실측).
    const args = ['exec', '--skip-git-repo-check', '--ignore-user-config', '--color', 'never'];
    if (opts.tools && opts.agentId) {
      // codex 도구: Auxo MCP 서버(remember/forget)를 -c 로 매 호출 동적 주입 + 자동승인.
      // ★**자물쇠(샌드박스)는 건 채로 둔다.** 바이패스 없이 MCP 도구만 자동 승인된다.
      //   방법 = 서버마다 `default_tools_approval_mode='approve'`. 아래 MCP 설정마다 함께 붙인다.
      //   실측:
      //     · 내장 auxo  → `remember` 호출됨(우리 DB tool_calls 흔적)
      //     · 설치 MCP   → `sequential-thinking` 호출됨(서버가 실제로 Thought 를 출력)
      //     · 홈 디렉터리에 파일 쓰기 시도 → **막힘**("안 됨") = 샌드박스가 살아 있다
      //   ⚠️ 시험은 게이트웨이(URL) 경로로 해야 한다. stdio 직접 spawn 은 원래 안 붙는다(확증).
      const mcpJs = path.join(__dirname, 'auxo-mcp-tools.js').replace(/\\/g, '/');
      // 서버마다 붙일 승인 설정 — 이걸 빠뜨린 서버는 도구가 조용히 죽는다(비대화형이라 자동 거부).
      const 승인 = (id) => ['-c', `mcp_servers.${id}.default_tools_approval_mode='approve'`];
      const dp = String(opts.dataPath || '').replace(/\\/g, '/');
      // 배포본은 시스템 node 가 없을 수 있어 Electron 내장 node(process.execPath)로 실행.
      const nodeBin = (process.env.AUXO_MCP_NODE || 'node').replace(/\\/g, '/');
      // TOML literal(작은따옴표): Windows shell:true 의 cmd 가 큰따옴표를 벗기는 문제 회피.
      // auxo 내장 도구: engine이 상시 게이트웨이 URL(opts.auxoHttp)을 주면 그걸 쓴다(매턴 stdio 스폰
      // 레이스로 도구가 안 붙던 '거짓무능' 제거). 없으면 기존처럼 stdio 직접 spawn(폴백).
      if (opts.auxoHttp) {
        args.push('-c', `mcp_servers.auxo.url='${String(opts.auxoHttp).replace(/'/g, '')}'`);
      } else {
        args.push(
          '-c', `mcp_servers.auxo.command='${nodeBin}'`,
          '-c', `mcp_servers.auxo.args=['${mcpJs}']`,
          '-c', `mcp_servers.auxo.env.AUXO_DATA_PATH='${dp}'`,
          '-c', `mcp_servers.auxo.env.AUXO_AGENT_ID='${opts.agentId}'`,
        );
        if (process.env.AUXO_MCP_ELECTRON) args.push('-c', "mcp_servers.auxo.env.ELECTRON_RUN_AS_NODE='1'");
      }
      args.push(...승인('auxo'));
      // P0-b: 사용자가 설치한 MCP(브라우저·구글 등)도 codex에 연결.
      //   ★자물쇠를 건 채로 두므로 **이쪽에도 승인 설정을 붙여야 한다**
      //   — 빠뜨리면 사용자 도구만 조용히 죽는다.
      // ★상시 게이트웨이(opts.mcpHttp) 우선: 매 턴 stdio spawn 하면 느린 서버가 준비 전에 지나가 도구가 안 붙는다(확증).
      //   engine이 띄워둔 로컬 HTTP MCP 게이트웨이 URL로 주면 즉시 연결. 없을 때만 stdio 직접(폴백).
      const httpGws = Array.isArray(opts.mcpHttp) ? opts.mcpHttp : [];
      if (httpGws.length) {
        for (const g of httpGws) args.push('-c', `mcp_servers.${g.id}.url='${String(g.url).replace(/'/g, '')}'`, ...승인(g.id));
      } else try {
        const mcpManager = require('./mcp-manager');
        mcpManager.setConfigRoot(path.join(opts.dataPath || '', 'mcp'));
        for (const s of mcpManager.listServers(opts.agentId)) {
          if (s.enabled === false) continue;
          const cmd = String(s.command).replace(/\\/g, '/');
          const ar = (s.args || []).map(a => `'${String(a).replace(/\\/g, '/')}'`).join(',');
          args.push('-c', `mcp_servers.${s.id}.command='${cmd}'`, '-c', `mcp_servers.${s.id}.args=[${ar}]`);
          // ⚠️ env(자격증명)도 넘겨야 인증형 MCP 가 동작한다. TOML literal 로 키별 주입.
          for (const [k, v] of Object.entries(s.env || {})) args.push('-c', `mcp_servers.${s.id}.env.${k}='${String(v).replace(/\\/g, '/').replace(/'/g, '')}'`);
          args.push(...승인(s.id));
        }
      } catch (_) {}
      // ★**자물쇠(샌드박스)는 건 채로 둔다.**
      //
      //   [왜 풀고 싶어지나]  codex 는 MCP 도구 호출마다 승인을 요구하는데 `codex exec` 는
      //         비대화형이라 물어볼 사람이 없어 **자동 거부**된다(`user cancelled MCP tool call`).
      //         `approval_policy='never'` 는 **셸 명령**용이라 MCP 에 안 걸린다.
      //         `--dangerously-bypass-approvals-and-sandbox` 로 뚫으면 되는 것처럼 보이지만,
      //         그 플래그는 승인과 **샌드박스를 같이** 끈다 = codex 자신의 파일 쓰기를 못 막는다.
      //         실측하면 최악이 나온다 — **도구는 거의 안 붙고 안전만 잃는다.**
      //
      //   [답]  서버마다 `default_tools_approval_mode='approve'` (위 `승인()`).
      //         "이 서버의 도구는 미리 승인된 것으로 친다"는 뜻이라 **셸·파일 샌드박스는 그대로 남는다.**
      //
      //   [실측]
      //         · 내장 auxo   → `remember` 호출됨 (우리 DB tool_calls 흔적)
      //         · 설치 MCP    → `sequential-thinking` 호출됨 (서버가 Thought 를 실제 출력)
      //         · 홈 디렉터리에 파일 쓰기 → **막힘** = 샌드박스 살아 있음
      //         ⚠️ 반드시 **게이트웨이(URL) 경로로** 시험할 것. stdio 직접 spawn 은 원래 안 붙어서
      //            "자물쇠 때문에 안 된다"로 오판하게 된다.
      //
      //   [남는 것]  `workspace-write` 는 작업폴더(아래 빈 임시 폴더)와 /tmp 에는 쓸 수 있다.
      //         그래서 아래 "빈 임시 폴더에서 실행"은 그대로 둔다 — 그게 작업폴더의 범위를 정한다.
      //
      // ★2026-08-22: **사용자가 셸을 허락했으면 codex 자기 손도 풀어준다.**
      //   [왜]  codex 는 명령 한 줄짜리 부탁("node 버전 확인해줘")에서 **자기 셸을 먼저 집는다.**
      //         그게 막혀 있으면 우리 run_shell 로 오지 않고 *"실행 정책에서 차단됐어요"* 로 끝냈다
      //         (실측 2×2: "한 줄 일 + 폴더 얘기 없음" 칸만 0/6, 나머지 세 칸은 4/6).
      //         codex CLI 는 **자기 손을 이름으로 끄는 수단을 주지 않는다** — claude 의 --disallowedTools 같은 게 없다.
      //   [왜 workspace-write 가 아닌가]  그 값은 **무시된다**(codex 0.142.2 실측).
      //         `-s` 자체는 먹는데 workspace-write 만 read-only 로 떨어진다. git 저장소 안·승인정책 변경·
      //         --add-dir·전용 CODEX_HOME 까지 여덟 가지를 시도했고 전부 실패했다.
      //         **폴더에 가두는 중간값이 없다** — 닫혀 있거나, 다 열리거나 둘 중 하나다.
      //   [무엇을 잃나]  이 손에는 우리 안전장치가 **하나도 안 붙는다** —
      //         파괴적 명령 차단 · 보호경로 차단 · 도구 호출 장부. 우리 run_shell 은 그대로 다 붙는다.
      //   [그래서 조건]  **사용자가 셸을 허락한 경우에만** 푼다(allowShell / 자율도 autonomous).
      //         허락 전에는 예전 그대로 닫아 둔다 — "허락은 사용자만 한다"는 선은 그대로다.
      const _셸허락 = !!(opts && opts.allowShell);
      if (_셸허락) args.push('-s', 'danger-full-access');
      else args.push('-s', 'workspace-write');
    } else {
      // 기억 처리 등 도구가 필요 없는 호출은 **자물쇠를 그대로 둔다**(claude 와 동일).
      args.push('-s', 'read-only');
    }
    // ★**빈 임시 폴더에서 실행**. claude 와 동등하게(두뇌가 달라도 같은 기준).
    //   cwd 를 안 정하거나 허용폴더로 두면 **codex 가 사용자 바탕화면 한가운데 서서** 돌게 된다.
    //   그 상태로 "파일 뭐 있어?" 하면 그게 그대로 보인다.
    //   ※ 쓰기 허용 범위는 cwd 가 아니라 writable_roots 가 정한다 — 빈 폴더로 옮겨도 허용폴더 쓰기는 그대로다.
    codexCwd = fs.mkdtempSync(path.join(os.tmpdir(), 'auxo-cx-'));
    let out = '', err = '';
    // 검증용: 실제로 codex 에 넘기는 인자를 보고 싶을 때. `only` 면 찍고 실행하지 않는다(토큰 0).
    //   ※ 이게 없어서 오늘 한참 헤맸다 — 인자가 맞는지 못 보고 codex 를 여러 번 헛되이 불렀다.
    if (process.env.AUXO_CODEX_DUMP_ARGS) {
      console.error('[codex args] cwd=' + codexCwd + '\n' + args.join(' '));
      // ★반환 타입은 **평소와 같아야 한다.** 여기만 객체 `{text,tokens}` 를 돌려주는 바람에
      //   호출부가 문자열로 알고 쓰다 `result.trim is not a function` 으로 죽었다
      //   (compressRoutineRecent 요약이 조용히 실패 — 실측 2026-08-15).
      //   검증용 갈래라도 **모양이 다르면 그 갈래에서만 나는 버그**가 생긴다.
      if (process.env.AUXO_CODEX_DUMP_ARGS === 'only') return resolve('(dump only)');
    }
    // 실행도 **찾은 경로 그대로** 쓴다. 'codex' 라는 이름으로 부르면 PATH 에만 의존하는데,
    // 위 findCodexBin 은 파일 경로도 보므로 "찾았다고 판정해놓고 실행은 실패"하는
    // 어긋남이 생긴다(= 화면엔 연결 완료, 대화만 안 됨). claude 쪽이 이미 겪은 함정.
    const proc = spawn(_q(codexBin()), args, { shell: true, windowsHide: true, cwd: codexCwd });
    // ⚠️ '총 시간'이 아니라 '무응답(idle)' 타임아웃 — 출력이 흐르는 동안엔 안 죽인다(무거운 생성 중간절단 방지, claude와 동일 원리).
    const IDLE_MS = opts.timeout || SUBSCRIPTION_TURN_TIMEOUT_MS;
    let timer = null;
    const armIdle = () => { clearTimeout(timer); timer = setTimeout(() => { try { proc.kill(); } catch (_) {} reject(new Error('codex 응답 시간 초과')); }, IDLE_MS); };
    armIdle();
    // 정지(정지 버튼/ESC): 진행 중 CLI 자식 프로세스를 실제로 종료한다.
    if (opts.signal) {
      const onAbort = () => { try { proc.kill(); } catch (_) {} clearTimeout(timer); reject(Object.assign(new Error('사용자 정지'), { aborted: true })); };
      if (opts.signal.aborted) onAbort(); else opts.signal.addEventListener('abort', onAbort, { once: true });
    }
    proc.stdout.on('data', d => { armIdle(); out += d; }); // 출력 오면 리셋
    proc.stderr.on('data', d => { armIdle(); err += d; });
    proc.on('error', e => { clearTimeout(timer); reject(e); });
    proc.on('close', (code) => {
      clearTimeout(timer);
      // 빈 임시 폴더 정리 — claude 와 동일(만들었으면 끝날 때 지운다). 실패해도 대화엔 영향 없음.
      try { if (codexCwd) fs.rmSync(codexCwd, { recursive: true, force: true }); } catch (_) {}
      const text = extractResponse(out);
      // ★이유를 **맨 앞**에 세운다. "codex 종료(N)" 이 앞서면 분류기가 원인을 못 짚는다.
      if (!text && code !== 0) {
        const re = extractStderrReason(err);
        const e = new Error(re ? `${re} (codex 종료 ${code})` : `codex 종료(${code}): (원인 없음)`);
        e.stderr = String(err || '').slice(0, 4000);
        e.cliReason = re;
        return reject(e);
      }
      resolve(text || '(빈 응답)');
    });
    try { proc.stdin.write(fullPrompt); proc.stdin.end(); } catch (e) { clearTimeout(timer); reject(e); }
  });
}

module.exports = { codexGenerate, isAvailable, isLoggedIn, loginStatus, extractResponse,
  binPath: () => codexBin(),   // 진단용 — 어떤 파일을 실행하려 했는지 로그에 남긴다(claude 와 동일)
  __extractStderrReason: extractStderrReason };
