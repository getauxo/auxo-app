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

function findCodexBin() {
  try {
    const cmd = process.platform === 'win32' ? 'where codex' : 'which codex';
    const out = execSync(cmd, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim().split(/\r?\n/)[0];
    if (out) return out;
  } catch (_) {}
  return null;
}
const CODEX_BIN = findCodexBin();
function isAvailable() { return !!CODEX_BIN; }

/** codex 로그인(ChatGPT 인증) 여부 — ~/.codex/auth.json 존재로 판단(빠른 폴백). */
function isLoggedIn() {
  try {
    const p = path.join(os.homedir(), '.codex', 'auth.json');
    return fs.existsSync(p) && fs.statSync(p).size > 2;
  } catch (_) { return false; }
}

/** 공식 명령으로 로그인 상태 확인 — `codex login status` ("Logged in using ChatGPT" / "Not logged in"). */
function loginStatus() {
  if (!CODEX_BIN) return { loggedIn: false };
  try {
    // codex 는 status 를 stderr 로 출력 → 2>&1 로 합쳐 캡처
    const out = execSync('codex login status 2>&1', { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 8000 }).trim();
    if (/logged in/i.test(out)) return { loggedIn: true, raw: out };
    if (/not logged in/i.test(out)) return { loggedIn: false, raw: out };
    return { loggedIn: isLoggedIn(), raw: out }; // 예상밖 출력 → 파일 폴백
  } catch (_) {
    // status 비0 종료(미로그인)도 여기로 옴 → 파일 폴백
    return { loggedIn: isLoggedIn() };
  }
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
    if (!CODEX_BIN) return reject(new Error('codex CLI를 찾을 수 없음 (codex login 필요)'));
    // 이미지 첨부(비전): codex는 read-only에서도 파일을 읽으므로 경로를 열어보게 안내(실측 확증: 빨강 PNG "빨강").
    const _imgs = Array.isArray(opts.imageFiles) ? opts.imageFiles.filter(Boolean) : [];
    const _imgNote = _imgs.length ? `\n\n[사용자가 방금 첨부한 파일(이미지·PDF) — 이 파일(들)을 열어서 실제로 보고 답해. 상상하지 말고 반드시 열어봐]\n${_imgs.join('\n')}` : '';
    const fullPrompt = (systemPrompt ? systemPrompt.trim() + '\n\n──────────\n\n' : '') + (userPrompt || '') + _imgNote;
    let codexCwd; // P2: workspace-write 시 작업 폴더(= 허용폴더)
    const args = ['exec', '--skip-git-repo-check', '--color', 'never'];
    if (opts.tools && opts.agentId) {
      // codex 도구: Auxo MCP 서버(remember/forget)를 -c 로 매 호출 동적 주입 + 자동승인.
      // ⚠️ 비인터랙티브 자동승인을 위해 --dangerously-bypass-approvals-and-sandbox 사용 → codex 셸 샌드박스가 풀린다.
      //    (마스터 위험감수 결정 2026-06-26. 보완책=backlog. 1층이 셸·파일 작업을 강하게 억제 중.)
      const mcpJs = path.join(__dirname, 'auxo-mcp-tools.js').replace(/\\/g, '/');
      const dp = String(opts.dataPath || '').replace(/\\/g, '/');
      // 배포본은 시스템 node 가 없을 수 있어 Electron 내장 node(process.execPath)로 실행.
      const nodeBin = (process.env.AUXO_MCP_NODE || 'node').replace(/\\/g, '/');
      // TOML literal(작은따옴표): Windows shell:true 의 cmd 가 큰따옴표를 벗기는 문제 회피.
      args.push(
        '-c', `mcp_servers.auxo.command='${nodeBin}'`,
        '-c', `mcp_servers.auxo.args=['${mcpJs}']`,
        '-c', `mcp_servers.auxo.env.AUXO_DATA_PATH='${dp}'`,
        '-c', `mcp_servers.auxo.env.AUXO_AGENT_ID='${opts.agentId}'`,
      );
      if (process.env.AUXO_MCP_ELECTRON) args.push('-c', "mcp_servers.auxo.env.ELECTRON_RUN_AS_NODE='1'");
      // P0-b: 사용자가 설치한 MCP(브라우저·구글 등)도 codex에 연결(codex는 bypass라 별도 허용 불필요).
      // ★상시 게이트웨이(opts.mcpHttp) 우선: 매 턴 stdio spawn하면 느린 서버가 준비 전에 지나가 도구가 안 붙음(2026-07-14 확증).
      //   engine이 띄워둔 로컬 HTTP MCP 게이트웨이 URL로 주면 즉시 연결. 없을 때만 stdio 직접(폴백).
      const httpGws = Array.isArray(opts.mcpHttp) ? opts.mcpHttp : [];
      if (httpGws.length) {
        for (const g of httpGws) args.push('-c', `mcp_servers.${g.id}.url='${String(g.url).replace(/'/g, '')}'`);
      } else try {
        const mcpManager = require('./mcp-manager');
        mcpManager.setConfigRoot(path.join(opts.dataPath || '', 'mcp'));
        for (const s of mcpManager.listServers(opts.agentId)) {
          if (s.enabled === false) continue;
          const cmd = String(s.command).replace(/\\/g, '/');
          const ar = (s.args || []).map(a => `'${String(a).replace(/\\/g, '/')}'`).join(',');
          args.push('-c', `mcp_servers.${s.id}.command='${cmd}'`, '-c', `mcp_servers.${s.id}.args=[${ar}]`);
          // ⚠️ env(자격증명)도 넘겨야 인증형 MCP 동작(2026-07-14). TOML literal로 키별 주입.
          for (const [k, v] of Object.entries(s.env || {})) args.push('-c', `mcp_servers.${s.id}.env.${k}='${String(v).replace(/\\/g, '/').replace(/'/g, '')}'`);
        }
      } catch (_) {}
      // P2(결정1=A) codex 폴더 한정 — claude·gemini 와 동일하게 "허용폴더에서만". (2026-06-28 실측 작동)
      //   허용폴더(allowedDirs)를 writable_roots 로 → 그 폴더들만 쓰기 가능, 밖은 codex 셸이 차단됨.
      //   Windows 는 unelevated 네이티브 샌드박스(UAC/관리자 불필요). approval_policy=never 로 비인터랙티브 자동 실행.
      //   허용폴더가 없으면 read-only(쓰기 차단; 사용자가 grant_dir 로 폴더 허용 후 쓰기 — 결정2).
      let _dirs = [];
      try { _dirs = (require('./storage').loadAgent(opts.agentId) || {}).allowedDirs || []; } catch (_) {}
      if (_dirs.length) {
        const roots = '[' + _dirs.map(d => `'${String(d).replace(/\\/g, '/')}'`).join(',') + ']';
        const winSb = process.platform === 'win32' ? ['-c', "windows.sandbox='unelevated'"] : [];
        args.push('-s', 'workspace-write', ...winSb, '-c', `sandbox_workspace_write.writable_roots=${roots}`, '-c', "approval_policy='never'");
        codexCwd = _dirs[0];
      } else {
        args.push('-s', 'read-only', '-c', "approval_policy='never'");
      }
    } else {
      args.push('-s', 'read-only');
    }
    let out = '', err = '';
    const proc = spawn('codex', args, { shell: true, windowsHide: true, cwd: codexCwd });
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
      const text = extractResponse(out);
      if (!text && code !== 0) return reject(new Error(`codex 종료(${code}): ${err.slice(0, 200)}`));
      resolve(text || '(빈 응답)');
    });
    try { proc.stdin.write(fullPrompt); proc.stdin.end(); } catch (e) { clearTimeout(timer); reject(e); }
  });
}

module.exports = { codexGenerate, isAvailable, isLoggedIn, loginStatus, extractResponse };
