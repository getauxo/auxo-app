/**
 * cli.js — Auxo CLI (독립 에이전트 공간)
 *
 * 앱과 "완전히 분리된" 독립 공간. 자기만의 데이터 폴더(~/.auxo-cli)에
 * 별도의 에이전트들을 둔다. 같은 API 를 써도 이름·성격·기억이 다르면 다른 정체성.
 * 엔진(두뇌·기억)은 engine.js 를 공유한다(데이터만 분리, 코드는 공유).
 *
 * 명령: /help /new /agents /clear /exit  (대화 중 어디서나)
 * 에이전트 만들기 마법사는 어느 단계서든 /cancel 로 취소 가능.
 *
 * 실행: node cli.js
 */
'use strict';

const os = require('os');
const path = require('path');
const fs = require('fs');
const { intakeFile, buildPromptParts } = require('./file-intake'); // 파일 첨부 공통 코어
const readline = require('readline');
const storage = require('./storage');
const engine = require('./engine');
const botTelegram = require('./bot-telegram');
const botDiscord = require('./discord-bot');
const scheduler = require('./scheduler');
const notice = require('./notice');
const APP_VERSION = (() => { try { return require('./package.json').version || '0.0.0'; } catch (_) { return '0.0.0'; } })();

// 내부 디버그 로그(`[brain-claude:extract]`·`[integrateMemory]`·`[brain-gemini:tool]` 등)는
// 일반 사용자 화면에서 숨긴다. 진단이 필요하면 AUXO_DEBUG=1 로 실행.
if (!process.env.AUXO_DEBUG) {
  const hide = (orig) => (...a) => {
    const s = (a.length && typeof a[0] === 'string') ? a[0] : '';
    if (/^\s*\[[a-zA-Z]/.test(s)) return; // 내부 로그(`[brain-...]` 등)로 시작하면 억제
    orig.apply(console, a);
  };
  console.log = hide(console.log);
  console.warn = hide(console.warn);
  console.error = hide(console.error);
}

// ── 데이터 경로: 앱과 분리된 CLI 전용 폴더 ──────────────────────────────
const DATA_DIR = process.env.AUXO_CLI_DATA || path.join(os.homedir(), '.auxo-cli');
const DEFAULT_PERSONA = '따뜻한 친구. 항상 곁에 있어 주고, 진심으로 이 사람을 챙긴다.';
const CANCEL = '/cancel';

const BRAINS = [
  { mode: 'gemini-api',         label: 'Gemini API — Google AI Studio 키',            needsKey: true },
  { mode: 'claude-api',         label: 'Claude API — Anthropic 키(sk-ant-)',          needsKey: true },
  { mode: 'openai-api',         label: 'GPT(OpenAI) API — sk-...',                    needsKey: true },
  { mode: 'openai-compatible',  label: '기타(OpenAI 호환) — 키 + baseURL',            needsKey: true, needsBase: true },
  { mode: 'claude-subscription',label: 'Claude 구독 — 이 PC의 claude CLI',            needsKey: false },
  { mode: 'codex-subscription', label: 'Codex 구독 — 이 PC의 codex CLI (ChatGPT)',    needsKey: false },
];
function brainLabel(mode) { const b = BRAINS.find(x => x.mode === mode); return b ? b.label.split(' — ')[0] : mode; }

// ── 터미널 색 ──────────────────────────────────────────────────────────
const c = {
  dim:    s => `\x1b[2m${s}\x1b[0m`,
  b:      s => `\x1b[1m${s}\x1b[0m`,
  cyan:   s => `\x1b[36m${s}\x1b[0m`,
  green:  s => `\x1b[32m${s}\x1b[0m`,
  yellow: s => `\x1b[33m${s}\x1b[0m`,
  red:    s => `\x1b[31m${s}\x1b[0m`,
  orange: s => `\x1b[38;5;208m${s}\x1b[0m`,
};

// 표시 폭 계산(한글·전각=2). 박스 정렬용. ANSI 색코드는 제외하고 센다.
function dispWidth(s) {
  let w = 0;
  for (const ch of String(s).replace(/\x1b\[[0-9;]*m/g, '')) {
    const cp = ch.codePointAt(0);
    const wide = (cp >= 0x1100 && cp <= 0x115F) || (cp >= 0x2E80 && cp <= 0xA4CF)
      || (cp >= 0xAC00 && cp <= 0xD7A3) || (cp >= 0xF900 && cp <= 0xFAFF)
      || (cp >= 0xFE30 && cp <= 0xFE4F) || (cp >= 0xFF00 && cp <= 0xFF60)
      || (cp >= 0xFFE0 && cp <= 0xFFE6) || (cp >= 0x1F300 && cp <= 0x1FAFF)
      || (cp >= 0x2600 && cp <= 0x27BF);
    w += wide ? 2 : 1;
  }
  return w;
}
// 둥근 박스로 줄들을 감싸 출력(주황 테두리). 한글 폭 보정으로 정렬.
function printBox(lines, minW = 44) {
  const inner = Math.max(minW, ...lines.map(dispWidth));
  console.log('  ' + c.orange('╭' + '─'.repeat(inner + 2) + '╮'));
  for (const l of lines) {
    const pad = Math.max(0, inner - dispWidth(l));
    console.log('  ' + c.orange('│') + ' ' + l + ' '.repeat(pad) + ' ' + c.orange('│'));
  }
  console.log('  ' + c.orange('╰' + '─'.repeat(inner + 2) + '╯'));
}

// 입력을 라인 큐로 받아 파이프(EOF)·인터랙티브 양쪽에서 견고하게 동작.
// 멀티라인 붙여넣기 대응: 짧은 간격(35ms)으로 연달아 오는 줄은 한 메시지로 합친다.
// (사람 타이핑은 줄 사이 간격이 커서 안 합쳐지고, 붙여넣기는 즉시 연속이라 합쳐짐)
const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
const _lineQ = [];
const _waiters = [];
let _closed = false;
let _pending = [];
let _flushTimer = null;
function _deliver(v) { if (_waiters.length) _waiters.shift()(v); else _lineQ.push(v); }
function _flush() {
  _flushTimer = null;
  if (!_pending.length) return;
  const joined = _pending.join('\n');
  _pending = [];
  _deliver(joined);
}
// ── 멀티라인 붙여넣기 처리 ──
// (1순위) bracketed paste: 터미널이 붙여넣기를 \x1b[200~ … \x1b[201~ 로 감싼다 → 마커 사이를
//         한 메시지로 확실히 합침(타이밍 무관). 터미널이 지원하면 main 에서 켠다.
// (폴백) 마커가 없으면(미지원 터미널·파이프) 시간 기반 debounce 로 합침.
const PASTE_GAP_MS = 150;
const PASTE_START = '\x1b[200~';
const PASTE_END = '\x1b[201~';
let _pasting = false;
let _pasteBuf = [];
rl.on('line', (raw) => {
  if (_mask) { _deliver(raw); return; } // 비밀 입력(키)은 즉시 — 합치지 않음
  if (!process.stdin.isTTY) { _deliver(raw); return; } // 파이프(스크립트 입력)는 줄별 즉시
  let l = raw;
  if (!_pasting && l.includes(PASTE_START)) { _pasting = true; l = l.slice(l.indexOf(PASTE_START) + PASTE_START.length); }
  if (_pasting) {
    const e = l.indexOf(PASTE_END);
    if (e >= 0) {                          // 붙여넣기 끝 → 모은 줄을 한 메시지로
      _pasteBuf.push(l.slice(0, e));
      _pasting = false;
      const joined = _pasteBuf.join('\n');
      _pasteBuf = [];
      if (_flushTimer) { clearTimeout(_flushTimer); _flush(); } // 폴백 큐가 있으면 먼저 비움
      _deliver(joined);
    } else {
      _pasteBuf.push(l);                   // 붙여넣기 중간 줄 — 계속 모음
    }
    return;
  }
  // 마커 없음 → 시간 기반 debounce 폴백
  _pending.push(l);
  if (_flushTimer) clearTimeout(_flushTimer);
  _flushTimer = setTimeout(_flush, PASTE_GAP_MS);
});
rl.on('close', () => { _closed = true; if (_flushTimer) { clearTimeout(_flushTimer); _flush(); } while (_waiters.length) _waiters.shift()(null); });
function ask(q) {
  if (q) process.stdout.write(q);
  return new Promise(res => {
    if (_lineQ.length) return res(_lineQ.shift());
    if (_closed) return res(null);
    _waiters.push(res);
  }).then(v => {
    if (v === null) { console.log(c.dim('\n(입력 종료 — 저장됨)')); rl.close(); process.exit(0); }
    return v;
  });
}
// API 키 등 민감 입력은 화면에 '*' 로 마스킹(붙여넣기 포함).
let _mask = false;
const _origWriteToOutput = rl._writeToOutput.bind(rl);
rl._writeToOutput = function (s) {
  if (_mask && s && !/[\r\n]/.test(s)) _origWriteToOutput('*'.repeat(s.length));
  else _origWriteToOutput(s);
};
function askSecret(q) { _mask = true; return ask(q).then(v => { _mask = false; return v; }); }

// bracketed paste 모드 on/off (실제 터미널에서만). 켜면 붙여넣기가 \x1b[200~…201~ 로 표시됨.
function pasteModeOn() { if (process.stdin.isTTY) { try { process.stdout.write('\x1b[?2004h'); } catch (_) {} } }
function pasteModeOff() { if (process.stdin.isTTY) { try { process.stdout.write('\x1b[?2004l'); } catch (_) {} } }
process.on('exit', pasteModeOff); // 어떤 경로로 끝나든 원복(다른 프로그램에 영향 안 주게)

// ── 화면 유틸 (한글 폭 문제 회피 — 박스 대신 구분선 헤더) ──────────────────
function clear() { try { console.clear(); } catch (_) {} }
function banner() {
  console.log('');
  printBox([
    c.b(c.orange('✦ Auxo CLI')) + c.dim('  — 나만의 독립 에이전트 공간'),
    '',
    c.dim('데이터  ') + storage.getDataPath(),
    '',
    c.dim('팁  ') + '/help 로 명령 보기 · /agents 로 에이전트 전환',
    c.dim('    ') + '여러 에이전트를 만들어 서로 다른 정체성으로 쓸 수 있어요',
  ], 52);
}
function agentHeader(agent) {
  console.log('');
  printBox([
    c.b(agent.name) + c.dim(`   ${brainLabel(agent.brainMode)}`),
  ], 44);
  console.log('  ' + c.dim('/help 명령  ·  /agents 전환  ·  /exit 끝내기'));
}
// 공지·업데이트 확인 — 앱과 같은 notice.js 를 쓴다(채널 동등성).
async function showNoticeLine() {
  try {
    const n = await notice.fetchNotice(DATA_DIR); // 옵트아웃이면 요청 없이 null
    const line = notice.formatLine(n, APP_VERSION);
    if (line) {
      console.log('  ' + c.orange('📣 ') + line + (n && n.url ? c.dim('  ' + n.url) : ''));
      console.log('  ' + c.dim('(공지 그만 받기: /notice off)') + '\n');
    }
  } catch (_) { /* 오프라인 등 — 조용히 무시 */ }
}

function greet(agent) {
  console.log('\n' + c.orange('● ') + c.b(agent.name));
  console.log('  안녕하세요! 무슨 이야기든 들려주세요.');
  console.log('  ' + c.dim('(팁: ') + c.cyan('/telegram') + c.dim(' 으로 텔레그램에서도 저와 대화할 수 있어요)'));
}
function printHelp() {
  console.log('\n  ' + c.b('명령어'));
  console.log('    ' + c.cyan('/help') + '     명령 목록 보기');
  console.log('    ' + c.cyan('/new') + '      새 에이전트 만들기');
  console.log('    ' + c.cyan('/agents') + '   에이전트 전환');
  console.log('    ' + c.cyan('/telegram') + ' 텔레그램 메신저로 연결');
  console.log('    ' + c.cyan('/discord') + '  디스코드로 연결 (DM)');
  console.log('    ' + c.cyan('/trust') + '    도구 사용 자율도 설정 (승인 정도)');
  console.log('    ' + c.cyan('/notice') + '   공지·업데이트 확인 켜기/끄기 (/notice on|off)');
  console.log('    ' + c.cyan('/attach') + '  ' + c.dim('파일 첨부 — /attach <경로> [메시지]'));
  console.log('    ' + c.cyan('/clear') + '    화면 깨끗이 (대화·기억은 그대로)');
  console.log('    ' + c.cyan('/exit') + '     끝내기 (저장됨)');
}

// ── 자율도(trustLevel) 설정 — 도구(파일·웹 등)가 실제 변경을 일으킬 때 얼마나 물어볼지 ──
const TRUST_LABELS = {
  ask_all: '매번 물어봄 (모든 변경 작업에 확인)',
  ask_risky: '위험 작업만 물어봄 (기본 — 쓰기·삭제 등만 확인)',
  autonomous: '알아서 진행 (확인 없이 바로 실행 — 신뢰하는 경우)',
};
async function setTrust(agent) {
  const cur = agent.trustLevel || 'ask_risky';
  console.log('\n' + c.orange('● ') + c.b('도구 사용 자율도'));
  console.log(c.dim('  제가 파일을 만들거나 바꾸는 등 ') + '실제 변경' + c.dim('을 할 때, 어디까지 먼저 확인할지 정해요.'));
  const order = ['ask_all', 'ask_risky', 'autonomous'];
  order.forEach((k, i) => {
    const mark = k === cur ? c.green(' ← 지금') : '';
    console.log(`    ${c.cyan(String(i + 1))}. ${TRUST_LABELS[k]}${mark}`);
  });
  const pick = (await ask('  번호 선택 (취소: ' + CANCEL + '): ')).trim();
  if (!pick || pick === CANCEL) { console.log(c.dim('  (변경 안 함)')); return agent; }
  const idx = parseInt(pick, 10) - 1;
  if (idx < 0 || idx >= order.length) { console.log(c.dim('  (잘못된 번호 — 변경 안 함)')); return agent; }
  const next = order[idx];
  const fresh = storage.loadAgent(agent.id) || agent;
  fresh.trustLevel = next; storage.saveAgent(fresh);
  console.log(c.green(`  ✓ '${TRUST_LABELS[next]}' 로 설정했어요.`));
  return fresh;
}

// ── 텔레그램 연결 마법사 — 대화하듯 토큰 입력 → 봇 백그라운드 시작 ──────────
let _botRunning = false;
let _dcRunning = false;

// CLI 시작 시: 이 에이전트에 텔레그램이 연결돼 있으면 봇도 자동으로 함께 켠다(백그라운드).
// → CLI 로 대화하든 텔레그램으로 대화하든 둘 다 바로 작동.
function autoStartTelegram(agent) {
  if (_botRunning) return;
  const cfg = botTelegram.loadConfig();
  if (!cfg.token || cfg.agentId !== agent.id) return; // 이 에이전트에 연결된 게 아니면 패스
  botTelegram.verifyToken(cfg.token).then(me => {
    if (!me || _botRunning) return;
    _botRunning = true;
    botTelegram.startBot({ token: cfg.token, dataPath: DATA_DIR, agentId: agent.id, ownerId: cfg.ownerId }, { log: () => {} }).catch(() => { _botRunning = false; });
    console.log('\n' + c.dim(`  ✓ 텔레그램 @${me.username} 도 함께 켜졌어요 — 거기서도 바로 대화할 수 있어요.`));
  }).catch(() => {});
}

// ── 예약된 정기 작업: PC 켜진 동안 매분 확인 → 시각 되면 실행 → 결과 전달 ──
let _schedTimer = null;
function startScheduler() {
  if (_schedTimer) return;
  const deps = {
    loadAgent: storage.loadAgent,
    loadAllAgents: storage.loadAllAgents,
    saveAgent: storage.saveAgent,
    runTurn: (id, prompt, 표시) => engine.runTurn({ agentId: id, userMessage: prompt, displayUserMessage: 표시, emit: () => {} }),
    deliver: async (ch, text, s) => {
      const isHb = s && s.kind === 'heartbeat'; // 하트비트(먼저 안부)는 '예약' 라벨 없이
      if (ch === 'telegram' && _botRunning) {
        await botTelegram.sendToOwner(isHb ? String(text) : `🔔 ${s.title}\n${text}`).catch(() => {});
      } else if (ch === 'discord' && _dcRunning) {
        await botDiscord.sendToOwner(isHb ? String(text) : `🔔 ${s.title}\n${text}`).catch(() => {});
      } else {
        // ★여기서 이 스코프에 없는 변수를 쓰면, 먼저 안부(하트비트)가 CLI 로 뜨는 순간
        //   ReferenceError 로 터지고 tick 의 catch 가 그걸 삼킨다.
        //   ※ 하트비트가 전역 OFF 라 당장은 안 터지지만 재도입하는 순간 터진다.
        //     이름은 스케줄러가 실어 보낸다.
        const 이름 = (s && s.agentName) || (storage.loadAgent(s && s.agentId) || {}).name || '에이전트';
        console.log('\n' + c.orange('● ') + c.b(isHb ? 이름 : `🔔 ${s.title}`));
        console.log('  ' + String(text).split('\n').join('\n  '));
        process.stdout.write('\n' + c.cyan('  나') + '\n  › ');
      }
    },
  };
  _schedTimer = setInterval(() => { scheduler.tick(Date.now(), deps).catch(() => {}); }, 60000);
}

async function connectTelegram(agent) {
  if (_botRunning) { console.log(c.dim('\n  이미 텔레그램이 연결돼 있어요. (이 창이 켜진 동안 작동 중)')); return; }
  // 이미 이 에이전트로 연결한 적 있으면 토큰 재입력 없이 바로 시작.
  const prev = botTelegram.loadConfig();
  if (prev.token && prev.agentId === agent.id) {
    console.log(c.dim('\n  텔레그램 연결을 확인하는 중...'));
    const me = await botTelegram.verifyToken(prev.token).catch(() => null);
    if (me) {
      _botRunning = true;
      botTelegram.startBot({ token: prev.token, dataPath: DATA_DIR, agentId: agent.id, ownerId: prev.ownerId }, { log: () => {} }).catch(() => { _botRunning = false; });
      console.log(c.green(`  ✓ @${me.username} 다시 연결됐어요!`) + c.dim(' 텔레그램에서 바로 대화할 수 있어요.'));
      return;
    }
    console.log(c.dim('  저장된 토큰이 더는 유효하지 않네요. 새로 연결할게요.'));
  }
  console.log('\n' + c.orange('● ') + c.b(agent.name));
  console.log('  텔레그램으로도 저와 대화할 수 있어요! 연결을 도와드릴게요.');
  console.log(c.dim('  ┌ 텔레그램 앱에서 ') + c.b('@BotFather') + c.dim(' 를 찾아 대화를 시작하고,'));
  console.log(c.dim('  │ ') + c.b('/newbot') + c.dim(' 을 입력해 봇을 하나 만들어 주세요.'));
  console.log(c.dim('  │ (봇 이름·주소를 정하면 긴 토큰을 줍니다)'));
  console.log(c.dim('  └ 그 토큰을 아래에 붙여넣어 주세요.  (취소: ') + CANCEL + c.dim(')'));
  const token = (await askSecret('  토큰: ')).trim();
  if (!token || token === CANCEL) { console.log(c.dim('  (연결을 취소했어요)')); return; }
  console.log(c.dim('  확인 중...'));
  let me = null;
  try { me = await botTelegram.verifyToken(token); } catch (_) {}
  if (!me) { console.log(c.red('  토큰이 올바르지 않은 것 같아요. 다시 ' + c.cyan('/telegram') + ' 으로 시도해 주세요.')); return; }
  // 같은 봇·에이전트 재연결이면 기존 주인(ownerId) 유지, 아니면 새로 등록받음.
  const ownerId = (prev.token === token && prev.agentId === agent.id) ? prev.ownerId : undefined;
  const cfg = { token, dataPath: DATA_DIR, agentId: agent.id, ownerId };
  botTelegram.saveConfig(cfg);
  _botRunning = true;
  botTelegram.startBot(cfg, { log: () => {} }).catch(() => { _botRunning = false; });
  console.log(c.green(`  ✓ @${me.username} 와 연결됐어요!`) + c.dim(' 텔레그램에서 그 봇에게 메시지를 보내면 제가 답할게요.'));
  console.log(c.dim('  (이 창이 켜져 있는 동안 작동해요 — 창을 닫으면 텔레그램도 멈춰요)'));
}

// ── 디스코드 연결 (텔레그램과 동일 패턴, DM 1:1) ──
function autoStartDiscord(agent) {
  if (_dcRunning) return;
  const cfg = botDiscord.loadConfig();
  if (!cfg.token || cfg.agentId !== agent.id) return;
  botDiscord.verifyToken(cfg.token).then(me => {
    if (!me || _dcRunning) return;
    _dcRunning = true;
    botDiscord.startBot({ token: cfg.token, dataPath: DATA_DIR, agentId: agent.id, ownerId: cfg.ownerId }, { log: () => {} }).catch(() => { _dcRunning = false; });
    console.log('\n' + c.dim(`  ✓ 디스코드 @${me.username} 도 함께 켜졌어요 — 거기서 DM으로 대화할 수 있어요.`));
  }).catch(() => {});
}

async function connectDiscord(agent) {
  if (_dcRunning) { console.log(c.dim('\n  이미 디스코드가 연결돼 있어요. (이 창이 켜진 동안 작동 중)')); return; }
  const prev = botDiscord.loadConfig();
  if (prev.token && prev.agentId === agent.id) {
    console.log(c.dim('\n  디스코드 연결을 확인하는 중...'));
    const me = await botDiscord.verifyToken(prev.token).catch(() => null);
    if (me) {
      _dcRunning = true;
      botDiscord.startBot({ token: prev.token, dataPath: DATA_DIR, agentId: agent.id, ownerId: prev.ownerId }, { log: () => {} }).catch(() => { _dcRunning = false; });
      console.log(c.green(`  ✓ @${me.username} 다시 연결됐어요!`) + c.dim(' 디스코드에서 DM으로 대화할 수 있어요.'));
      return;
    }
    console.log(c.dim('  저장된 토큰이 더는 유효하지 않네요. 새로 연결할게요.'));
  }
  console.log('\n' + c.orange('● ') + c.b(agent.name));
  console.log('  디스코드로도 저와 대화할 수 있어요! 연결을 도와드릴게요.');
  console.log(c.dim('  ┌ Discord ') + c.b('개발자 포털') + c.dim('(discord.com/developers)에서 New Application 을 만들고,'));
  console.log(c.dim('  │ ') + c.b('Bot') + c.dim(' 메뉴에서 Reset Token 으로 토큰을 받은 뒤 ') + c.b('Message Content Intent') + c.dim(' 를 켜 주세요.'));
  console.log(c.dim('  └ 그 토큰을 아래에 붙여넣어 주세요.  (취소: ') + CANCEL + c.dim(')'));
  const token = (await askSecret('  토큰: ')).trim();
  if (!token || token === CANCEL) { console.log(c.dim('  (연결을 취소했어요)')); return; }
  console.log(c.dim('  확인 중...'));
  let me = null;
  try { me = await botDiscord.verifyToken(token); } catch (_) {}
  if (!me) { console.log(c.red('  토큰이 올바르지 않은 것 같아요. 다시 ' + c.cyan('/discord') + ' 으로 시도해 주세요.')); return; }
  const ownerId = (prev.token === token && prev.agentId === agent.id) ? prev.ownerId : undefined;
  const cfg = { token, dataPath: DATA_DIR, agentId: agent.id, ownerId };
  botDiscord.saveConfig(cfg);
  _dcRunning = true;
  botDiscord.startBot(cfg, { log: () => {} }).catch(() => { _dcRunning = false; });
  console.log(c.green(`  ✓ @${me.username} 와 연결됐어요!`));
  console.log(c.dim('  대화하려면 → ① 봇을 내 디스코드 서버에 초대(개발자 포털 OAuth2 → bot)'));
  console.log(c.dim(`  ② 채널 이름을 "${agent.name}" 이나 "auxo" 로 만들면 그 채널에선 @멘션 없이 그냥 대화돼요(추천)`));
  console.log(c.dim('  ③ 다른 채널은 @봇 멘션, 또는 봇 우클릭 → 메시지로 DM'));
  console.log(c.dim('  (이 창이 켜져 있는 동안 작동해요)'));
}

// ── 에이전트 생성 마법사 (어느 단계서든 /cancel 로 취소 → null 반환) ──────────
/**
 * 모델 고르기 — 키로 회사에 직접 물어본 목록에서 번호로 고른다.
 * 반환: 모델 id / null(취소). ★기본값이 없으므로 **고를 때까지 안 넘어간다.**
 * 앱(renderer/app.js 의 loadModels)과 같은 원리 — 목록 조회 성공 = 키가 유효하다는 뜻이라
 * 키 확인을 겸한다.
 */
async function pickModelCli(brain, apiKey) {
  // OpenAI 호환은 제공자가 제각각이라 목록 규격을 보장할 수 없다 → 직접 입력.
  if (brain.mode === 'openai-compatible') {
    while (true) {
      const v = (await ask('  모델명 (제공자 문서 참고): ')).trim();
      if (v === CANCEL) return null;
      if (v) return v;
      console.log(c.red('  모델명이 필요해요.'));
    }
  }
  const 모듈 = { 'openai-api': './brain-openai', 'gemini-api': './brain-gemini', 'claude-api': './brain-anthropic' }[brain.mode];
  if (!모듈) return '';
  let list = [];
  try {
    process.stdout.write('  모델 목록을 불러오는 중…');
    list = await require(모듈).listModels(apiKey);
    console.log(c.dim(` ${list.length}개`));
  } catch (e) {
    console.log(c.red('\n  목록을 못 불러왔어요: ' + e.message));
    console.log(c.dim('  키와 결제(크레딧) 상태를 확인해 주세요.'));
    return null;
  }
  if (!list.length) { console.log(c.red('  쓸 수 있는 모델이 없어요.')); return null; }

  let 보기 = list;
  while (true) {
    console.log();
    보기.slice(0, 30).forEach((m, i) => {
      // ★모델명만 — 컨텍스트 크기 같은 건 비개발자가 모른다(앱과 같은 규칙).
      console.log('    ' + c.cyan(String(i + 1).padStart(2)) + ') ' + m.label);
    });
    if (보기.length > 30) console.log(c.dim(`    … 외 ${보기.length - 30}개 (검색어를 입력하면 좁혀져요)`));
    const v = (await ask(`  번호 또는 검색어 (취소: ${CANCEL}): `)).trim();
    if (v === CANCEL) return null;
    const n = Number(v);
    if (Number.isInteger(n) && n >= 1 && n <= Math.min(보기.length, 30)) return 보기[n - 1].id;
    if (v) {
      const q = v.toLowerCase();
      const 좁힘 = list.filter((m) => (m.id + ' ' + m.label).toLowerCase().includes(q));
      if (좁힘.length) { 보기 = 좁힘; continue; }
      console.log(c.red('  그런 모델이 없어요.'));
    } else {
      console.log(c.red('  사용할 모델을 골라주세요. (기본값이 없어서 안 고르면 대화가 안 돼요)'));
    }
  }
}

async function createAgent() {
  console.log('\n  ' + c.b('── 새 에이전트 만들기 ──') + c.dim(`   (취소: ${CANCEL})`));
  let name = '';
  while (!name) {
    const v = (await ask('  이름: ')).trim();
    if (v === CANCEL) return null;
    if (!v) { console.log(c.red(`  이름이 필요해요.  (취소하려면 ${CANCEL})`)); continue; }
    name = v;
  }

  console.log('\n  AI 선택:');
  BRAINS.forEach((b, i) => console.log(`    ${i + 1}) ${b.label}`));
  let brain = null;
  while (!brain) {
    const v = (await ask('  번호: ')).trim();
    if (v === CANCEL) return null;
    brain = BRAINS[parseInt(v, 10) - 1] || null;
    if (!brain) console.log(c.red(`  목록의 번호를 골라주세요.  (취소: ${CANCEL})`));
  }

  let apiKey = '', model = '', baseURL = '';
  if (brain.needsBase) {
    while (!baseURL) {
      const v = (await ask('  API base URL (예: https://openrouter.ai/api/v1): ')).trim();
      if (v === CANCEL) return null;
      baseURL = v;
    }
  }
  if (brain.needsKey) {
    while (!apiKey) {
      const v = (await askSecret('  API 키: ')).trim();
      if (v === CANCEL) return null;
      if (!v) { console.log(c.red('  이 AI는 키가 필요해요.')); continue; }
      apiKey = v;
    }
  }
  // ── 모델 고르기 ────────────────────────────────────────────
  // ★"비우면 기본값" 방식은 쓰지 않는다. 코드에 박아둔 기본 모델을
  //   **제공사가 내리면 그 두뇌가 통째로 죽는다.** 기본값은 언젠가 반드시 죽는다.
  //   → **회사에 직접 물어본 목록에서 고르게** 한다. 안 고르면 진행하지 않는다.
  if (brain.needsKey) {
    model = await pickModelCli(brain, apiKey);
    if (model === null) return null; // 취소
  }

  const id = `agent-${Date.now()}`;
  const agent = {
    id, name, persona: DEFAULT_PERSONA, brainMode: brain.mode,
    apiKey, model, baseURL,
    apiKeys: apiKey ? { [brain.mode]: apiKey } : {},
    models:  model  ? { [brain.mode]: model }  : {},
    speech: 'auto', userNickname: '',
    userMemory: '',   // 이 사람에 대한 기억(통짜 글)
    refMemory: '',    // 첨부·문서에서 온 정보(본인 사실과 분리)
    work: { activeId: null, projects: [], routines: [] },
    createdAt: new Date().toISOString(),
  };
  storage.saveAgent(agent);
  console.log(c.green(`\n  ✓ "${name}" 생성 완료 (AI: ${brainLabel(brain.mode)}).`));
  return storage.loadAgent(id);
}

// ── 시작: 기존 선택 또는 새로 만들기 (취소 가능) ──────────────────────────
async function selectOrCreate() {
  while (true) {
    const agents = storage.loadAllAgents();
    if (!agents.length) {
      console.log(c.dim('\n  아직 에이전트가 없어요. 새로 만들어요.'));
      const a = await createAgent();
      if (a) return a;
      return null; // 0개에서 취소 → 종료
    }
    console.log('\n  ' + c.b('에이전트 선택:'));
    agents.forEach((a, i) => console.log(`    ${i + 1}) ${a.name} ${c.dim(`(${brainLabel(a.brainMode)})`)}`));
    console.log(`    0) ${c.cyan('+ 새 에이전트 만들기')}`);
    const v = (await ask('  번호: ')).trim();
    const idx = parseInt(v, 10);
    if (idx >= 1 && idx <= agents.length) return agents[idx - 1];
    if (idx === 0) { const a = await createAgent(); if (a) return a; /* 취소 → 목록 재표시 */ }
    else console.log(c.red('  목록의 번호를 골라주세요.'));
  }
}

// ── 대화 중 에이전트 전환 (/agents) ──────────────────────────────────────
async function switchAgent(current) {
  const agents = storage.loadAllAgents();
  if (agents.length <= 1) { console.log(c.dim('\n  다른 에이전트가 없어요. /new 로 만들 수 있어요.')); return current; }
  console.log('\n  ' + c.b('에이전트 전환:') + c.dim(`   (취소: ${CANCEL})`));
  agents.forEach((a, i) => {
    const here = a.id === current.id ? c.green('  ← 지금') : '';
    console.log(`    ${i + 1}) ${a.name} ${c.dim(`(${brainLabel(a.brainMode)})`)}${here}`);
  });
  const v = (await ask('  전환할 번호: ')).trim();
  if (v === CANCEL) return current;
  const idx = parseInt(v, 10);
  if (idx >= 1 && idx <= agents.length) {
    const next = agents[idx - 1];
    if (next.id === current.id) { console.log(c.dim('  이미 이 에이전트예요.')); return current; }
    clear(); banner(); agentHeader(next); greet(next);
    return next;
  }
  console.log(c.red('  번호가 올바르지 않아요.'));
  return current;
}

function printFacts(agentId) {
  const a = storage.loadAgent(agentId);
  if (!a) { console.log(c.dim('  (에이전트 없음)')); return; }
  const um = require('./user-memory');
  um.absorbLegacyFacts(a); // 옛 낱개 데이터가 남아 있으면 글로 풀어 보여준다(저장은 안 건드림)
  const lines = um.toLines(a.userMemory);
  const refs = um.toLines(a.refMemory);
  if (!lines.length && !refs.length) { console.log(c.dim('  (아직 기억 없음)')); return; }
  if (lines.length) {
    console.log(c.b(`  ${a.name}이(가) 당신에 대해 아는 것 (${um.memorySize(a.userMemory)}자 / 그릇 ${um.limitOf(a)}자):`));
    lines.forEach(l => console.log(`  · ${l}`));
  }
  if (refs.length) {
    console.log(c.b(`\n  참고 자료에서 알게 된 것 (본인 사실 아님):`));
    refs.forEach(l => console.log(`  · ${l}`));
  }
}

// ── 대화 루프 ────────────────────────────────────────────────────────────
async function chatLoop(agent) {
  agentHeader(agent);
  greet(agent);

  const emit = (t, p) => {
    // 기억 회상 표시는 사용자에게 노출하지 않음(백그라운드).
    // 서브에이전트(임시 일꾼) 진행 표시 — 투명성(무슨 일을 누구에게 시켰는지)
    if (t === 'workers-start') {
      console.log(c.yellow(`\n  ⛏ 일꾼 ${p.count}명에게 작업 분배:`));
      (p.tasks || []).forEach((task, i) => console.log(c.dim(`    ${i + 1}. ${String(task).slice(0, 60)}`)));
    }
    if (t === 'worker-done') process.stdout.write(p.ok ? c.green(`  ✓일꾼${p.n}`) : c.red(`  ✗일꾼${p.n}`));
    if (t === 'workers-done') console.log(c.dim(`\n  (일꾼 ${p.ok}/${p.count} 완료 — 종합 중)`));
    if (t === 'status' && p && p.text) console.log(c.dim(`  ⏳ ${p.text}`)); // 음성/영상/유튜브 "받는 중"
  };

  while (true) {
    process.stdout.write('\n' + c.cyan('  나') + '\n  › ');
    const lineIn = (await ask('')).trim();
    if (!lineIn) continue;
    if (lineIn === '/exit') break;
    if (lineIn === '/help') { printHelp(); continue; }
    if (lineIn === '/clear') { clear(); agentHeader(agent); continue; }
    if (lineIn === '/agents') { agent = await switchAgent(agent); continue; }
    if (lineIn === '/telegram') { await connectTelegram(agent); continue; }
    if (lineIn === '/discord') { await connectDiscord(agent); continue; }
    if (lineIn === '/trust') { agent = await setTrust(agent); continue; }
    if (lineIn === '/notice' || lineIn.startsWith('/notice ')) {
      const arg = lineIn.slice(7).trim();
      if (arg === 'off') { notice.setOff(DATA_DIR, true); console.log('  ' + c.dim('공지·업데이트 확인을 끕니다. (다시 켜기: /notice on)')); }
      else if (arg === 'on') { notice.setOff(DATA_DIR, false); console.log('  ' + c.dim('공지·업데이트 확인을 켭니다.')); }
      else { console.log('  ' + c.dim(`공지 확인: ${notice.isOff(DATA_DIR) ? '꺼짐' : '켜짐'}  ·  바꾸기: /notice on|off`)); }
      continue;
    }
    if (lineIn === '/new') {
      const a = await createAgent();
      if (a) { clear(); banner(); agent = a; agentHeader(agent); greet(agent); }
      else console.log(c.dim('  (취소됨 — 지금 에이전트와 계속 대화해요)'));
      continue;
    }

    // 파일 첨부: /attach <경로> [메시지]  (경로에 공백 있으면 "따옴표")
    let userMessage = lineIn;
    let attachments, userFiles;
    if (lineIn.startsWith('/attach')) {
      const rest = lineIn.slice('/attach'.length).trim();
      let filePath, caption;
      const q = rest.match(/^"([^"]+)"\s*([\s\S]*)$/);
      if (q) { filePath = q[1]; caption = q[2].trim(); }
      else { const sp = rest.indexOf(' '); if (sp < 0) { filePath = rest; caption = ''; } else { filePath = rest.slice(0, sp); caption = rest.slice(sp + 1).trim(); } }
      if (!filePath) { console.log(c.dim('  사용법: /attach <파일경로> [메시지]   (경로에 공백이 있으면 "따옴표")')); continue; }
      let buf;
      try { buf = fs.readFileSync(filePath); }
      catch (e) { console.log(c.red(`  파일을 못 읽었어: ${e.message}`)); continue; }
      const intake = await intakeFile({ name: path.basename(filePath), buffer: buf }, { onStatus: (m) => console.log(c.dim(`  ⏳ ${m}`)) });
      if (intake.error) { console.log(c.red(`  ${intake.error}`)); continue; }
      const parts = buildPromptParts([intake]);
      attachments = parts.attachments;
      userMessage = (caption ? caption + '\n\n' : '') + parts.noteText;
      userFiles = [{ path: filePath, name: path.basename(filePath), isImage: /\.(png|jpe?g|gif|webp)$/i.test(filePath) }]; // 구독두뇌 비전(경로로 이미지 보기) — 앱과 동등
      console.log(c.dim(`  📎 첨부: ${path.basename(filePath)} (${intake.kind})`));
    }

    const r = await engine.runTurn({
      agentId: agent.id, userMessage, attachments, userFiles, emit,
      deliverFile: async ({ path: fp, name, note }) => {
        console.log('\n' + c.green('  📎 파일 받음: ') + c.b(name) + (note ? c.dim('  — ' + note) : ''));
        console.log(c.dim('    경로: ' + fp));
        console.log(c.dim('    (열기: 터미널에 `start "" "' + fp + '"` 또는 탐색기에서 위 경로)'));
      },
    });
    if (r.error) { console.log(c.red(`\n  [오류] ${r.error}`)); continue; }
    console.log('\n' + c.orange('● ') + c.b(agent.name));
    console.log('  ' + String(r.response).split('\n').join('\n  '));
    // 정직 계층 ③: 도구 배지를 상시 표시하지 않는다. 근거는 물으면 on-demand 로.

    // 기억 정리는 사람처럼 조용히 — 표시 없이 백그라운드 처리.
    if (r.generate) {
      await engine.processMemory({
        agentId: agent.id, userMessage, response: r.response, generate: r.generate,
        rememberedAny: r.rememberedAny, emit: () => {},
      });
    }
  }
}

// ── 진입 ────────────────────────────────────────────────────────────────
async function main() {
  storage.initOrExit(DATA_DIR);
  pasteModeOn();
  clear();
  banner();

  const agent = await selectOrCreate();
  // ★인사에 호칭을 기본값으로 박지 않는다.
  //   호칭은 대화로 자연히 정해지는 것이지 억지로 붙이는 게 아니다.
  if (!agent) { console.log(c.dim('\n  안녕히 가세요.')); rl.close(); return; }

  clear();
  banner();
  await showNoticeLine(); // 새 버전·공지 확인(옵트아웃이면 요청 안 함) — 앱과 동일 통로
  autoStartTelegram(agent); // 텔레그램이 연결돼 있으면 봇도 함께 켠다 → 양쪽에서 바로 대화
  autoStartDiscord(agent);  // 디스코드도 연결돼 있으면 함께 켠다
  startScheduler(); // 예약된 정기 작업 자동 실행(매분 확인) — PC 켜진 동안
  await chatLoop(agent);

  console.log(c.dim('\n  안녕히 가세요. (대화·기억은 저장되었습니다)'));
  cleanupChildren();
  rl.close();
}

/**
 * 띄워 둔 MCP 자식 프로세스를 정리한다. **없으면 CLI 가 안 죽는다.**
 * 실측(2026-08-14): /exit 를 쳐도 `node auxo-mcp-tools.js` 가 남고, 그게 부모(cli.js)까지
 * 붙잡아 15분 넘게 살아 있었다. 앱은 will-quit 에서 부르는데 CLI 에는 이 호출이 아예 없었다.
 */
function cleanupChildren() {
  try { require('./mcp-gateway').shutdown(); } catch (_) {}
}
// 창을 닫거나 Ctrl+C 로 끝내도 자식이 남지 않게 — 정상 종료 경로만 막으면 반쪽이다.
for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
  try { process.on(sig, () => { cleanupChildren(); process.exit(0); }); } catch (_) {}
}
process.on('exit', cleanupChildren);

main().catch(err => { console.error(c.red('치명적 오류:'), err); cleanupChildren(); rl.close(); process.exit(1); });
