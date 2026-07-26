/**
 * main.js — Electron 메인 프로세스
 */
const { app, BrowserWindow, ipcMain, dialog, shell, Menu, Notification } = require('electron');
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');
const storage = require('./storage');
const brainClaude = require('./brain-claude');
const brainGemini = require('./brain-gemini');
const brainAnthropic = require('./brain-anthropic');
const brainOpenai = require('./brain-openai');
const brainCodex = require('./brain-codex');
const brainAntigravity = require('./brain-antigravity');
const botTelegram = require('./bot-telegram');
const botDiscord = require('./discord-bot');
const engine = require('./engine'); // 예약 작업 실행용(채널 무관 엔진)
const scheduler = require('./scheduler');
const learnSkill = require('./learn-skill'); // P3.2 자가학습
const toolTransparency = require('./tool-transparency'); // 안전장치 3: 도구 사용 투명 표시
const embeddings = require('./embeddings');
const skillsRegistry = require('./skills-registry');
const mcpManager = require('./mcp-manager');
const agentTools = require('./agent-tools'); // P0-c: 앱도 공통 도구층 사용(CLI·텔레그램과 동일)
const { intakeFile, buildPromptParts } = require('./file-intake'); // 파일 첨부 공통 코어(두뇌 입력 변환)
const audioTranscribe = require('./audio-transcribe'); // 음성 전사 모델 관리(base 번들 / small 업그레이드)
const attachStore = require('./attachment-store'); // 사용자 첨부 원본 보관(카드로 다시 열기·받기)
const env = require('./env');
const localTools = require('./tools');
const agentQueue = require('./agent-queue');
const notice = require('./notice');
const companionFormat = require('./companion-format');
const memoryExport = require('./memory-export'); // 읽기·이식용 마크다운 폴더 내보내기

const isSmokeMode = process.argv.includes('--smoke');

// 배포본에선 시스템 node 가 없을 수 있다 → MCP 서버(auxo-mcp-tools)를 Electron 내장 node 로 실행.
// brain-claude/codex 가 이 env 를 읽어 command/실행환경을 정한다. dev(시스템 node 있음)는 그대로 'node'.
if (app.isPackaged) {
  process.env.AUXO_MCP_NODE = process.execPath;   // = Auxo.exe
  process.env.AUXO_MCP_ELECTRON = '1';            // → ELECTRON_RUN_AS_NODE 로 순수 node 모드
}

// 콘솔 창의 내부 디버그 로그(`[brain-...]`·`[telegram]`·`[integrateMemory]` 등)는 숨긴다.
// (배포본은 콘솔 자체가 없지만, dev 실행 시 검은 창을 깔끔히 + 한글 깨짐 방지). smoke는 검증로그 유지.
if (!process.env.AUXO_DEBUG && !isSmokeMode) {
  const hide = (orig) => (...a) => {
    const s = (a.length && typeof a[0] === 'string') ? a[0] : '';
    if (/^\s*\[[a-zA-Z]/.test(s)) return;
    orig.apply(console, a);
  };
  console.log = hide(console.log); console.warn = hide(console.warn); console.error = hide(console.error);
}
const APP_VERSION = (() => { try { return require('./package.json').version || '0.0.0'; } catch (_) { return '0.0.0'; } })();

// ── 오류 기록(파일) ─────────────────────────────────────────
// 배포본엔 콘솔 창이 없고 위에서 console.error 도 숨긴다 → 사용자 PC에서 무엇이 실패했는지
// 알 길이 없었다(2026-07-10 테스터 "생각을 정리하는 중" 무한 반복, 원인 추적 불가).
// 앱 폴더의 auxo-error.log 에 남겨 테스터가 그대로 보내줄 수 있게 한다. 개인정보는 담지 않는다.
let _errLogPath = null;
function errorLogPath() {
  if (_errLogPath) return _errLogPath;
  try { _errLogPath = path.join(app.getPath('userData'), 'auxo-error.log'); } catch (_) { _errLogPath = null; }
  return _errLogPath;
}
/** 구독 두뇌 실패 시 "왜"를 좁히기 위한 상태 한 줄(개인정보 없음). */
function brainDiag(brainMode) {
  try {
    if (brainMode === 'claude-subscription') {
      const s = brainClaude.authStatus();
      const bin = brainClaude.binPath ? brainClaude.binPath() : '?';
      return `claude cli: installed=${brainClaude.isAvailable()} loggedIn=${!!s.loggedIn} bin=${bin}`;
    }
    if (brainMode === 'codex-subscription') {
      return `codex cli: installed=${brainCodex.isAvailable()} loggedIn=${!!brainCodex.loginStatus().loggedIn}`;
    }
    if (brainMode === 'antigravity-subscription') {
      return `agy cli: installed=${brainAntigravity.isAvailable()} loggedIn=${!!brainAntigravity.loginStatus().loggedIn}`;
    }
  } catch (e) { return `diag 실패: ${e.message}`; }
  return '';
}

function logError(scope, err, extra) {
  const p = errorLogPath(); if (!p) return;
  const when = new Date().toISOString();
  const msg = (err && err.message) ? err.message : String(err);
  const code = err && (err.code || err.errno) ? ` code=${err.code || err.errno}` : '';
  const killed = err && err.killed ? ' killed=true(timeout 추정)' : '';
  const line = `[${when}] ${scope}${code}${killed} v${APP_VERSION}\n  ${msg}\n${extra ? `  ${extra}\n` : ''}`;
  try { fs.appendFileSync(p, line, 'utf8'); } catch (_) {}
  try { const st = fs.statSync(p); if (st.size > 512 * 1024) fs.writeFileSync(p, line, 'utf8'); } catch (_) {} // 512KB 넘으면 리셋
}

// ── 공지·업데이트 "안테나" (수신 전용, 익명) ──────────────────────────
// 공지·업데이트 확인은 notice.js 공용 모듈에 있다(앱·CLI 공통, 채널 동등성).
// 설정(받지 않기)은 userData 폴더의 notice-off 파일에 둔다 → main 이 읽어 요청 자체를 막는다.
function noticeDir() { try { return app.getPath('userData'); } catch (_) { return null; } }
ipcMain.handle('notice:setOff', async (e, off) => {
  const d = noticeDir(); if (!d) return { ok: false };
  return { ok: true, off: notice.setOff(d, off) };
});
ipcMain.handle('notice:getOff', async () => ({ off: notice.isOff(noticeDir() || '') }));

async function checkNotice() {
  const d = noticeDir(); if (!d) return;
  const n = await notice.fetchNotice(d); // 옵트아웃이면 요청 없이 null
  if (n && mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('notice:update', { notice: n, appVersion: APP_VERSION });
  }
}
let smokeAgentId = null;      // smoke 모드에서 세팅됨
let smokeScreenTarget = null; // 'onboarding' | 'chat' | 'settings' | 'abilities' | 'notifications'

let mainWindow = null;

function createWindow(show = true) {
  // 상단 기본 메뉴바(File/Edit/View…) 제거 — 클로드 데스크탑처럼 깔끔하게
  Menu.setApplicationMenu(null);
  mainWindow = new BrowserWindow({
    width: 1100,
    height: 750,
    show: show,
    backgroundColor: '#0b0b12',
    autoHideMenuBar: true,   // 메뉴바 숨김(Alt 눌러도 안 뜨게 setApplicationMenu(null)와 병행)
    titleBarStyle: 'hidden', // 기본 타이틀바 제거(프레임리스) — 커스텀 상단바 사용
    titleBarOverlay: { color: '#0b0b12', symbolColor: '#cfd0e0', height: 44 }, // Windows 창버튼 오버레이(다크 기본)
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
    icon: path.join(__dirname, 'icon.png'), // 런타임 창·작업표시줄 아이콘(개발앱 포함, PNG=Electron 확실 로드). 패키지 exe는 build.win.icon(.ico).
    title: 'Auxo',
  });

  // 음성(마이크) 권한 허용 — 로컬 앱이라 음성 입력(STT)·녹음 허용
  try {
    mainWindow.webContents.session.setPermissionRequestHandler((wc, permission, cb) => {
      cb(permission === 'media' || permission === 'audioCapture' || permission === 'microphone');
    });
  } catch (_) {}

  // 외부 링크(target=_blank·window.open)는 앱 안 팝업창이 아니라 기본 브라우저로 연다.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^(https?:\/\/|mailto:)/i.test(url)) { try { shell.openExternal(url); } catch (_) {} }
    return { action: 'deny' };
  });

  // 창 이동(navigate) 백스톱: 앱은 로컬 index.html 하나만 로드한다. 그 밖의 이동
  // (파일을 창에 드롭했을 때의 file:// navigate, 실수로 뜬 링크 등)은 원천 차단해 앱이 깨지지 않게 한다.
  // 외부 http(s) 는 기본 브라우저로 넘긴다(setWindowOpenHandler 와 동일 정책).
  mainWindow.webContents.on('will-navigate', (e, url) => {
    e.preventDefault();
    if (/^(https?:\/\/|mailto:)/i.test(url)) { try { shell.openExternal(url); } catch (_) {} }
  });

  mainWindow.loadFile('renderer/index.html');

  if (!isSmokeMode) {
    // 개발 시 DevTools 열기 원하면 주석 해제
    // mainWindow.webContents.openDevTools();
  }

  return mainWindow;
}

app.whenReady().then(async () => {
  // Windows 토스트 알림의 소리·아이콘이 제대로 나오려면 AppUserModelId 등록 필요(build.appId와 일치).
  if (process.platform === 'win32') { try { app.setAppUserModelId('com.auxo.app'); } catch (_) {} }
  const userData = app.getPath('userData');
  // smoke 캡처는 별도 데이터 경로로 격리 — 실데이터(에이전트/대화) 오염 방지.
  storage.init(isSmokeMode ? path.join(userData, 'smoke-data') : userData);
  // 쓰기 데이터는 userData로(설치본에서 앱폴더는 읽기전용). 기존/번들은 1회 시드.
  try {
    // 스킬은 에이전트별 격리(skills/<agentId>/). 신규 에이전트는 빈손 — 번들 자동시드 없음.
    skillsRegistry.setSkillsRoot(path.join(userData, 'skills'));
    // MCP도 에이전트별 격리(mcp-<agentId>.json). 신규 에이전트는 빈손.
    mcpManager.setConfigRoot(path.join(userData, 'mcp'));
    // 음성 전사: whisper 모델은 첫 음성 때 userData/models 로 자동 다운로드(설치본 앱폴더는 읽기전용).
    audioTranscribe.setUserModelsDir(path.join(userData, 'models'));
    // 영상·mp3·m4a 처리용 ffmpeg, 유튜브용 yt-dlp 바이너리는 첫 필요 시 userData/bin 로 자동 다운로드.
    require('./media-ffmpeg').setUserBinDir(path.join(userData, 'bin'));
    require('./youtube-transcript').setUserBinDir(path.join(userData, 'bin'));
  } catch (e) { console.error('[paths] userData 경로 설정 실패:', e.message); }

  if (isSmokeMode) {
    await runSmokeScreenshot();
    return;
  }

  createWindow(true);

  // 창이 뜬 뒤 비차단으로 공지 확인(안테나)
  setTimeout(() => { checkNotice(); }, 3000);

  // 저장된 텔레그램 연결 자동 복원(smoke 제외)
  if (!isSmokeMode) restoreTelegram();
  if (!isSmokeMode) restoreDiscord();
  if (!isSmokeMode) startAppScheduler(); // 예약된 정기 작업 자동 실행(매분)

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow(true);
  });
});

app.on('window-all-closed', () => {
  // smoke 모드에서는 창 전환 중간에 앱이 꺼지면 안 됨 — 무시
  if (isSmokeMode) return;
  if (process.platform !== 'darwin') app.quit();
});
// 종료 시 MCP 상시 게이트웨이(로컬 HTTP 서버) 정리.
app.on('will-quit', () => { try { require('./mcp-gateway').shutdown(); } catch (_) {} });

// ── Smoke 스크린샷 모드 ─────────────────────────────────────────
async function runSmokeScreenshot() {
  const evidenceDir = path.join(__dirname, 'evidence');
  if (!fs.existsSync(evidenceDir)) fs.mkdirSync(evidenceDir);

  // 시드 데이터 삽입
  const agentId = 'smoke-agent-001';
  smokeAgentId = agentId;
  // smoke: 더미 avatar(빨강 단색 1px PNG) 주입 → avatar 렌더링 경로 검증(눈에 띄는 색)
  const SMOKE_DUMMY_AVATAR = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
  const seedAgent = {
    id: agentId,
    name: '여행친구',
    persona: '여행을 좋아하는 활발한 친구. 항상 새로운 여행지를 추천해줌.',
    brainMode: 'gemini-api', // smoke: 렌더링 검증용(대화는 미리 심음 — 두뇌 호출 안 함). 키 없음.
    speech: 'casual',
    userNickname: '형',
    avatar: SMOKE_DUMMY_AVATAR,    // smoke: avatar 렌더링 증거용 더미
    humanFacts: [
      { label: '이름', value: '가라세개' },
      { label: '좋아하는 것', value: '여행' },
    ],
    // L1: smoke용 work 시드 (UI 검증)
    work: {
      activeId: 'proj-smoke-001',
      projects: [
        {
          id: 'proj-smoke-001', type: 'project', title: '6월 여행 기획',
          goal: '제주도 3박4일 일정 완성', status: 'active',
          createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
          steps: [], artifacts: [], log: [], contextDigest: '',
        },
      ],
      routines: [
        {
          id: 'rt-smoke-001', type: 'routine', title: '매일 여행 일기',
          procedure: '', rhythm: '매일 저녁', recent: [], rollup: '',
          runCount: 2, createdAt: new Date().toISOString(),
        },
      ],
    },
    createdAt: new Date().toISOString(),
  };
  storage.saveAgent(seedAgent);

  const seedMessages = [
    { role: 'user', content: '내 이름은 가라세개야', ts: Date.now() - 3000 },
    { role: 'agent', content: '가라세개라고 기억할게! 반가워, 형!', ts: Date.now() - 2500 },
    { role: 'user', content: '나는 여행을 좋아해', ts: Date.now() - 2000 },
    { role: 'agent', content: '여행 얘기 항상 설레! 저도 그 얘기 듣고 싶었어!', ts: Date.now() - 1500 },
    { role: 'user', content: '오늘 뭐할까?', ts: Date.now() - 1000 },
    { role: 'agent', content: '오늘 새 여행지 검색해보는 건 어때? 저번에 여행 좋아한다고 했잖아, 형!', ts: Date.now() - 500 },
    // smoke: 실패 마커(error:true) 렌더링 검증 — 답 못 준 턴이 눅은 톤으로 보이는지
    { role: 'user', content: '이 질문은 실패했었어', ts: Date.now() - 300 },
    { role: 'agent', content: '지금 바로 답을 드리지 못했어요. 잠시 후 다시 말 걸어주시면 이어서 답할게요. (일시적 오류)', ts: Date.now() - 250, error: true },
  ];
  storage.saveConversation(agentId, seedMessages);
  // smoke: 압축으로 접힌 옛 대화(아카이브) 시드 → 대화 상단 "이전 대화 더 보기" 배너 렌더링 검증
  storage.appendArchivedMessages(agentId, [
    { role: 'user', content: '(옛 대화) 처음 만났을 때 얘기', ts: Date.now() - 100000 },
    { role: 'agent', content: '(옛 대화) 그때 반가웠어 형!', ts: Date.now() - 99000 },
  ]);

  // ── 스크린샷 1: 온보딩 화면 (상단) ──────────────────────────
  await captureScreen({
    evidenceDir,
    agentId: null,       // null → 온보딩 화면 표시
    smokeTarget: 'onboarding',
    outFile: 'screenshot-onboarding.png',
    waitMs: 1200,
  });

  // ── 스크린샷 1b: 온보딩 화면 (하단 — 에이전트 불러오기 버튼 확인) ──
  await captureScreen({
    evidenceDir,
    agentId: null,
    smokeTarget: 'onboarding',
    outFile: 'screenshot-onboarding-import-btn.png',
    waitMs: 1200,
    scrollToBottom: true,
  });

  // ── 온보딩 wizard 단계 캡처 (②구독·②API·③이름) ──
  await captureScreen({
    evidenceDir, agentId: null, smokeTarget: 'onboarding',
    outFile: 'wiz2-sub.png', waitMs: 800, tall: true,
    wizExec: "var c=document.querySelector('.brain-card[data-value=\"codex-subscription\"]'); if(c)c.click(); goWizStep(2);",
  });
  await captureScreen({
    evidenceDir, agentId: null, smokeTarget: 'onboarding',
    outFile: 'wiz2-api.png', waitMs: 800, tall: true,
    wizExec: "var c=document.querySelector('.brain-card[data-value=\"gemini-api\"]'); if(c)c.click(); goWizStep(2);",
  });
  await captureScreen({
    evidenceDir, agentId: null, smokeTarget: 'onboarding',
    outFile: 'wiz3-name.png', waitMs: 800,
    wizExec: "goWizStep(3);",
  });

  // ── 스크린샷 1c: 대화 화면 (시안 디자인 확인용) ──────────────
  await captureScreen({
    evidenceDir,
    agentId,             // 에이전트 있음 → 대화 화면
    smokeTarget: 'chat',
    outFile: 'screenshot-chat.png',
    waitMs: 1500,
  });

  // ── 스크린샷 avatar: 더미 avatar가 적용된 대화 화면 (사이드바+헤더+메시지 아바타) ──
  await captureScreen({
    evidenceDir,
    agentId,
    smokeTarget: 'chat',
    outFile: 'screenshot-avatar.png',
    waitMs: 1800,
  });

  // ── 스크린샷 chat-archive: 대화 상단으로 스크롤 → "이전 대화 더 보기" 배너 렌더 검증 ──
  await captureScreen({
    evidenceDir,
    agentId,
    smokeTarget: 'chat',
    outFile: 'screenshot-chat-archive.png',
    waitMs: 1500,
    wizExec: "setTimeout(function(){ var m=document.getElementById('chat-messages'); if(m) m.scrollTop=0; }, 400);",
  });

  // ── 스크린샷 chat-archive-open: 위로 스크롤 → 접혔던 옛 대화가 위에 자동으로 되살아나는지 검증 ──
  await captureScreen({
    evidenceDir,
    agentId,
    smokeTarget: 'chat',
    outFile: 'screenshot-chat-archive-open.png',
    waitMs: 1800,
    // 위로 스크롤 → 자동 로드 → 로드 후 스크롤 위치 보정으로 새 옛대화가 화면 위로 밀리므로,
    // 다시 상단으로 올려 되살아난 옛 대화가 실제로 보이는지 캡처(기능 증명).
    wizExec: "setTimeout(function(){ var m=document.getElementById('chat-messages'); if(!m) return; m.scrollTop=0; m.dispatchEvent(new Event('scroll')); setTimeout(function(){ m.scrollTop=0; }, 600); }, 400);",
  });

  // ── 스크린샷 chat-stop: 생성 중 전송 버튼(↑)→정지(■) 렌더 검증 (큐잉 pill은 기능 제거로 삭제) ──
  await captureScreen({
    evidenceDir, agentId, smokeTarget: 'chat',
    outFile: 'screenshot-chat-stop.png', waitMs: 1200,
    wizExec: "setTimeout(function(){ try{ setGenerating(true, 'smoke-agent-001'); }catch(e){} }, 300);",
  });

  // ── 스크린샷 chat-dragover: 파일 드래그 중 입력영역 하이라이트 렌더 검증 ──
  await captureScreen({
    evidenceDir, agentId, smokeTarget: 'chat',
    outFile: 'screenshot-chat-dragover.png', waitMs: 1000,
    wizExec: "setTimeout(function(){ try{ var s=document.getElementById('screen-chat'); if(s)s.classList.add('drag-over'); }catch(e){} }, 300);",
  });

  // ── 스크린샷 alive: "살아있음 표시"(생각 중 N초 + 작업 중 N초 경과) 렌더 검증 ──
  await captureScreen({
    evidenceDir,
    agentId,
    smokeTarget: 'chat',
    outFile: 'screenshot-alive.png',
    waitMs: 1500,
    wizExec: "setTimeout(function(){ try{ showTyping(); var t=document.querySelector('#typing-indicator .thinking-text'); if(t)t.textContent='에이전트가 생각 중… 14초'; var bodies=document.querySelectorAll('.message.agent .msg-body'); var b=bodies[bodies.length-1]; if(b){ var w=document.createElement('div'); w.className='work-pulse'; w.textContent='작업 중… 23초 경과'; b.appendChild(w);} var m=document.getElementById('chat-messages'); if(m)m.scrollTop=m.scrollHeight; }catch(e){} }, 400);",
  });

  // ── 스크린샷 2: 에이전트 설정 화면 (프로필 사진 UI 포함) ──────────
  await captureScreen({
    evidenceDir,
    agentId,             // 에이전트 있음 → 대화 화면 로드 후 에이전트설정 화면으로 전환
    smokeTarget: 'settings',
    outFile: 'screenshot-settings.png',
    waitMs: 1200,
  });

  // ── 스크린샷 settings-avatar: 설정 화면 하단(프로필 사진 섹션 보이게) ──
  await captureScreen({
    evidenceDir,
    agentId,
    smokeTarget: 'settings',
    outFile: 'screenshot-settings-avatar.png',
    waitMs: 1200,
    scrollSettingsToAvatar: true,
  });

  // ── 스크린샷 settings-export: 설정 화면 내보내기 섹션 ──
  await captureScreen({
    evidenceDir,
    agentId,
    smokeTarget: 'settings',
    outFile: 'screenshot-settings-export.png',
    waitMs: 1200,
    scrollSettingsToExport: true,
  });

  // ── 스크린샷 settings-telegram: 설정 화면 텔레그램 연결 섹션 ──
  await captureScreen({
    evidenceDir, agentId, smokeTarget: 'settings',
    outFile: 'settings-telegram.png', waitMs: 1000, tall: true,
    wizExec: "document.querySelectorAll('#screen-settings .settings-section-title').forEach(function(h){ if(h.textContent.indexOf('텔레그램')>=0) h.scrollIntoView({block:'center'}); });",
  });

  // ── 스크린샷 settings-discord: 디스코드 연결 섹션(개발자 포털 링크 확인) ──
  await captureScreen({
    evidenceDir, agentId, smokeTarget: 'settings',
    outFile: 'settings-discord.png', waitMs: 1200, tall: true,
    wizExec: "var b=document.querySelector('#screen-settings .stab[data-tab=\"connect\"]'); if(b)b.click(); setTimeout(function(){ document.querySelectorAll('#screen-settings .settings-section-title').forEach(function(h){ if(h.textContent.indexOf('디스코드')>=0) h.scrollIntoView({block:'center'}); }); }, 250);",
  });

  // ── 스크린샷 3: 능력 화면 — 3탭(기본 능력 / 스킬 / MCP) 각각 ────
  await captureScreen({
    evidenceDir,
    agentId,             // 에이전트 있음 → 대화 화면 로드 후 능력 화면으로 전환
    smokeTarget: 'abilities',
    outFile: 'screenshot-abilities.png',
    waitMs: 1200,
    tall: true,
  });
  for (const tab of ['skills', 'mcp']) {
    await captureScreen({
      evidenceDir, agentId, smokeTarget: 'abilities',
      outFile: `abilities-${tab}.png`, waitMs: 1500, tall: true,
      wizExec: `var b=document.querySelector('#screen-abilities .stab[data-tab="${tab}"]'); if(b)b.click();`,
    });
  }

  // ── 스크린샷 4: 알림 화면 ────────────────────────────────────
  await captureScreen({
    evidenceDir,
    agentId,             // 에이전트 있음 → 대화 화면 로드 후 알림 화면으로 전환
    smokeTarget: 'notifications',
    outFile: 'screenshot-notifications.png',
    waitMs: 1200,
  });

  app.quit();
}

/**
 * 특정 화면을 캡처해 PNG로 저장한다.
 * @param {Object} opts
 *   evidenceDir  저장 폴더
 *   agentId      null이면 온보딩, 값이 있으면 해당 에이전트 화면
 *   smokeTarget  'onboarding' | 'settings' — 렌더러에 전달해 어느 화면으로 갈지 지시
 *   outFile      저장 파일명
 *   waitMs       캡처 전 대기 ms
 */
async function captureScreen({ evidenceDir, agentId, smokeTarget, outFile, waitMs, scrollToBottom = false, scrollSettingsToAvatar = false, scrollSettingsToExport = false, tall = false, wizExec = null }) {
  return new Promise(async (resolve) => {
    const win = new BrowserWindow({
      width: 1100,
      height: (scrollSettingsToExport || tall) ? 2000 : 750,
      show: false,
      backgroundColor: '#0f0f1a',
      webPreferences: {
        preload: path.join(__dirname, 'preload.js'),
        contextIsolation: true,
        nodeIntegration: false,
      },
    });

    // smoke:get-agent-id IPC는 전역 핸들러에 등록됨
    // 임시로 agentId를 재세팅
    smokeAgentId = agentId;
    // smokeTarget을 렌더러가 조회할 수 있도록
    smokeScreenTarget = smokeTarget;

    win.loadFile('renderer/index.html');

    let done = false;
    const finish = async () => {
      if (done) return;
      done = true;
      // 이 핸들러 제거
      ipcMain.removeListener('smoke:ready', onReady);
      await new Promise(r => setTimeout(r, waitMs));
      try {
        // scrollToBottom: 온보딩 하단(불러오기 버튼)을 보여주기 위해 스크롤
        if (scrollToBottom) {
          await win.webContents.executeJavaScript(
            'document.querySelector(".onboard-wrap") && (document.querySelector(".onboard-wrap").scrollTop = 9999);'
          );
          await new Promise(r => setTimeout(r, 300));
        }
        // scrollSettingsToAvatar: 설정 화면에서 프로필 사진 섹션이 보이게 스크롤
        if (scrollSettingsToAvatar) {
          await win.webContents.executeJavaScript(
            '(function(){ var el=document.getElementById("section-avatar"); if(el) el.scrollIntoView({behavior:"instant",block:"center"}); })()'
          );
          await new Promise(r => setTimeout(r, 400));
        }
        // scrollSettingsToExport: 설정 화면 스크롤 컨테이너(.settings-body)를 맨 아래로 → 내보내기 섹션 노출
        if (scrollSettingsToExport) {
          await win.webContents.executeJavaScript(
            '(function(){ var b=document.querySelector("#screen-settings .settings-body"); if(b){ b.scrollTop = b.scrollHeight; } })()'
          );
          await new Promise(r => setTimeout(r, 400));
        }
        // wizExec: 온보딩 wizard 상태를 직접 조작(단계/모드 캡처용). 실행 후 게이트/렌더 대기.
        if (wizExec) {
          try { await win.webContents.executeJavaScript(`(function(){ try { ${wizExec} } catch(e){ console.error(e); } })()`); }
          catch (_) {}
          await new Promise(r => setTimeout(r, 1500));
        }
        // wizExec 등으로 DOM을 바꾼 뒤엔 capturePage가 예전 합성 프레임을 담을 수 있다.
        // 리페인트를 강제하고 두 프레임 기다린 뒤에 찍는다.
        await win.webContents.executeJavaScript(`(function(){
          document.body.style.opacity = '0.999';
          void document.body.offsetHeight;
          document.body.style.opacity = '';
          return new Promise(function(r){ requestAnimationFrame(function(){ requestAnimationFrame(function(){ r(1); }); }); });
        })()`);
        const image = await win.webContents.capturePage();
        const pngPath = path.join(evidenceDir, outFile);
        fs.writeFileSync(pngPath, image.toPNG());
        console.log(`[SMOKE-SCREENSHOT] saved: ${pngPath} (${image.getSize().width}x${image.getSize().height})`);
      } catch (e) {
        console.error('[SMOKE-SCREENSHOT] capturePage failed:', e.message);
      }
      try { win.destroy(); } catch(_) {}
      resolve();
    };

    // smoke:ready 신호 또는 4초 타임아웃 중 먼저 오는 쪽으로 캡처
    const onReady = () => finish();
    ipcMain.on('smoke:ready', onReady);
    setTimeout(finish, 4000);
  });
}

// ── IPC 핸들러 ────────────────────────────────────────────────────

// smoke 모드 에이전트 ID 조회
ipcMain.handle('smoke:get-agent-id', () => smokeAgentId);

// smoke 화면 타깃 조회 (onboarding | settings | null)
ipcMain.handle('smoke:get-screen-target', () => smokeScreenTarget);

// 에이전트 저장 (온보딩에서 신규 생성)
ipcMain.handle('agent:save', async (e, agentData) => {
  const agent = {
    id: agentData.id || `agent-${Date.now()}`,
    name: agentData.name,
    persona: agentData.persona || '따뜻한 친구. 항상 곁에 있어 주고, 진심으로 이 사람을 챙긴다.',
    brainMode: agentData.brainMode || '', // 두뇌 없는 파일 import → 빈 값(가져온 뒤 모델 재연결 안내)
    apiKey: agentData.apiKey || '',
    model: agentData.model || '',                  // API 모델(선택, 비우면 커넥터 기본값)
    baseURL: agentData.baseURL || '',              // openai-compatible 전용: 제공자 API base URL
    // 제공자별 키/모델 보관함(여러 AI 모델 교체 사용 시 각자 보관)
    apiKeys: (agentData.apiKey && agentData.brainMode) ? { [agentData.brainMode]: agentData.apiKey } : {},
    models: (agentData.model && agentData.brainMode) ? { [agentData.brainMode]: agentData.model } : {},
    speech: agentData.speech || 'auto',         // 'formal'|'casual'
    userNickname: agentData.userNickname || '',    // 에이전트가 사용자를 부르는 호칭
    auxoMd: agentData.auxoMd || '',                // 사용자 자유 지침(auxo.md), 1층 아래 종속
    disabledSkills: agentData.disabledSkills || [], // 이 에이전트에서 끈 스킬 id (기본=전부 사용)
    disabledMcp: agentData.disabledMcp || [],       // 이 에이전트에서 끈 MCP 서버 id (기본=전부 사용)
    humanFacts: [],
    createdAt: new Date().toISOString(),
  };
  storage.saveAgent(agent);
  return agent;
});

// 에이전트 설정 업데이트 (에이전트 설정 화면에서 저장)
ipcMain.handle('agent:update', async (e, { agentId, updates }) => {
  const agent = storage.loadAgent(agentId);
  if (!agent) return { error: '에이전트 없음' };
  const allowed = ['name', 'persona', 'speech', 'userNickname', 'auxoMd', 'disabledSkills', 'disabledMcp', 'avatar', 'baseURL', 'trustLevel', 'search'];
  for (const key of allowed) {
    if (updates[key] !== undefined) agent[key] = updates[key];
  }
  // 두뇌(AI 모델) + 키 보관함: brainMode 먼저 반영 후, 키/모델을 그 제공자 보관함에 저장.
  if (!agent.apiKeys || typeof agent.apiKeys !== 'object') agent.apiKeys = {};
  if (!agent.models || typeof agent.models !== 'object') agent.models = {};
  if (updates.brainMode !== undefined) agent.brainMode = updates.brainMode;
  if (updates.apiKey !== undefined) {
    agent.apiKey = updates.apiKey;                       // 현재 미러(하위호환)
    if (agent.brainMode) agent.apiKeys[agent.brainMode] = updates.apiKey;
  } else if (agent.brainMode) {
    // 제공자만 바뀐 경우: 미러를 그 제공자 보관함 값으로 동기화
    agent.apiKey = agent.apiKeys[agent.brainMode] || '';
  }
  if (updates.model !== undefined) {
    agent.model = updates.model;
    if (agent.brainMode) agent.models[agent.brainMode] = updates.model;
  } else if (agent.brainMode) {
    agent.model = agent.models[agent.brainMode] || '';
  }
  storage.saveAgent(agent);
  return agent;
});

// 기억 삭제
ipcMain.handle('fact:delete', async (e, { agentId, factIndex }) => {
  const agent = storage.loadAgent(agentId);
  if (!agent) return { error: '에이전트 없음' };
  const facts = agent.humanFacts || [];
  if (factIndex < 0 || factIndex >= facts.length) return { error: '인덱스 범위 초과' };
  facts.splice(factIndex, 1);
  agent.humanFacts = facts;
  storage.saveAgent(agent);
  return { humanFacts: facts };
});

// 기억 수정
ipcMain.handle('fact:update', async (e, { agentId, factIndex, label, value }) => {
  const agent = storage.loadAgent(agentId);
  if (!agent) return { error: '에이전트 없음' };
  const facts = agent.humanFacts || [];
  if (factIndex < 0 || factIndex >= facts.length) return { error: '인덱스 범위 초과' };
  facts[factIndex] = { label, value };
  agent.humanFacts = facts;
  storage.saveAgent(agent);
  return { humanFacts: facts };
});

// 에이전트 목록
ipcMain.handle('agent:list', async () => {
  return storage.loadAllAgents();
});

// ── 스킬(SKILL.md) ────────────────────────────────────────────────
ipcMain.handle('skills:list', async (e, agentId) => skillsRegistry.list(agentId));

ipcMain.handle('skills:import', async (e, agentId) => {
  const { filePaths, canceled } = await dialog.showOpenDialog(mainWindow, {
    title: '스킬 폴더 선택 (SKILL.md 포함)',
    properties: ['openDirectory'],
  });
  if (canceled || !filePaths || !filePaths[0]) return { canceled: true };
  const r = skillsRegistry.importFromDir(agentId, filePaths[0]);
  return r;
});

ipcMain.handle('skills:remove', async (e, { agentId, id }) => skillsRegistry.remove(agentId, id));

// ── MCP 서버 ──────────────────────────────────────────────────────
ipcMain.handle('mcp:list', async (e, agentId) => mcpManager.listServers(agentId));
ipcMain.handle('mcp:add', async (e, { agentId, data }) => mcpManager.addServer(agentId, data || {}));
ipcMain.handle('mcp:remove', async (e, { agentId, id }) => mcpManager.removeServer(agentId, id));
ipcMain.handle('mcp:setEnabled', async (e, { agentId, id, enabled }) => mcpManager.setEnabled(agentId, id, enabled));
ipcMain.handle('mcp:setAutoApprove', async (e, { agentId, id, val }) => mcpManager.setAutoApprove(agentId, id, val));
ipcMain.handle('mcp:catalog', async () => (mcpManager.loadCatalog().servers || []));
ipcMain.handle('mcp:addFromCatalog', async (e, { agentId, id, params }) => mcpManager.addFromCatalog(agentId, id, params || {}));
ipcMain.handle('mcp:addFromJson', async (e, { agentId, text }) => mcpManager.addFromJson(agentId, text));

// ── 구독 CLI 두뇌 설치/로그인 (온보딩 wizard ②-A) ──────────────────────
// 사용자가 구독 모델(claude/codex)을 고르면, 해당 CLI가 이 PC에 설치+로그인 됐는지 확인.
// 상태 판정은 공식 명령(claude auth status / codex login status)으로(파일 추측 X).
const CLI_GUIDES = {
  'claude-subscription': {
    name: 'Claude (Max·Pro 구독)', pkg: '@anthropic-ai/claude-code',
    installCmd: 'npm install -g @anthropic-ai/claude-code',
    loginCmd: 'claude auth login', docUrl: 'https://docs.anthropic.com/en/docs/claude-code/setup',
  },
  'codex-subscription': {
    name: 'Codex (ChatGPT 구독)', pkg: '@openai/codex',
    installCmd: 'npm install -g @openai/codex',
    loginCmd: 'codex login', docUrl: 'https://developers.openai.com/codex/cli/',
  },
  'antigravity-subscription': {
    // Antigravity 는 npm 이 아니라 공식 설치 스크립트로 설치되고, 로그인은 별도 CLI 명령이 없다
    // (앱/CLI 첫 실행 시 브라우저 OAuth·OS 키링 자동). → installType='script', loginCmd=null.
    name: 'Antigravity (Google 구독 — Gemini·Claude·GPT)', installType: 'script',
    installCmd: process.platform === 'win32'
      ? 'powershell -NoProfile -Command "irm https://antigravity.google/cli/install.ps1 | iex"'
      : 'curl -fsSL https://antigravity.google/cli/install.sh | bash', // macOS/Linux 공식 설치 스크립트
    loginCmd: null, docUrl: 'https://antigravity.google/docs/cli/install',
  },
};
ipcMain.handle('cli:check', async (e, brainMode) => {
  const g = CLI_GUIDES[brainMode];
  if (!g) return { applicable: false };
  let installed = false, loggedIn = false, account = null;
  if (process.env.AUXO_CLI_FORCE === 'noinstall') { /* smoke: 미설치 강제 */ }
  else if (process.env.AUXO_CLI_FORCE === 'nologin') { installed = true; }
  else try {
    if (brainMode === 'claude-subscription') {
      installed = brainClaude.isAvailable();
      if (installed) { const s = brainClaude.authStatus(); loggedIn = !!s.loggedIn; if (loggedIn) account = { email: s.email || '', plan: s.subscriptionType || '' }; }
    } else if (brainMode === 'codex-subscription') {
      installed = brainCodex.isAvailable();
      if (installed) loggedIn = !!brainCodex.loginStatus().loggedIn;
    } else if (brainMode === 'antigravity-subscription') {
      installed = brainAntigravity.isAvailable();
      if (installed) loggedIn = !!brainAntigravity.loginStatus().loggedIn;
    }
  } catch (_) {}
  // node/npm 존재(설치 버튼 동작 가능 여부) — 없으면 폴백 안내 필요
  let nodeReady = false;
  try { const rt = env.checkRuntimes ? await env.checkRuntimes() : null; nodeReady = !!(rt && (rt.node || rt.npm)); } catch (_) {}
  if (nodeReady === false) { try { require('child_process').execSync('npm -v', { stdio: 'ignore', timeout: 5000 }); nodeReady = true; } catch (_) {} }
  return { applicable: true, name: g.name, installed, loggedIn, ready: installed && loggedIn,
    account, nodeReady, installType: g.installType || 'npm', installCmd: g.installCmd, loginCmd: g.loginCmd, docUrl: g.docUrl };
});

// 자동 설치: npm install -g <pkg>. 진행 로그를 'cli:install-progress' 로 렌더러에 스트리밍.
ipcMain.handle('cli:install', async (e, brainMode) => {
  const g = CLI_GUIDES[brainMode];
  if (!g) return { ok: false, error: 'unknown brainMode' };
  return await new Promise((resolve) => {
    let proc;
    try {
      if (g.installType === 'script') {
        // Antigravity: 공식 설치 스크립트(npm 불필요) — OS 별 분기(Windows=PowerShell, macOS/Linux=curl|bash).
        proc = process.platform === 'win32'
          ? spawn('powershell', ['-NoProfile', '-Command', 'irm https://antigravity.google/cli/install.ps1 | iex'], { shell: true, windowsHide: true })
          : spawn('bash', ['-c', 'curl -fsSL https://antigravity.google/cli/install.sh | bash'], { windowsHide: true });
      } else {
        proc = spawn('npm', ['install', '-g', g.pkg], { shell: true, windowsHide: true });
      }
    }
    catch (err) { return resolve({ ok: false, error: err.message, needNode: g.installType !== 'script' }); }
    let log = '';
    const push = (t) => { log += t; try { e.sender.send('cli:install-progress', { brainMode, text: String(t) }); } catch (_) {} };
    proc.stdout.on('data', d => push(d));
    proc.stderr.on('data', d => push(d));
    proc.on('error', err => resolve({ ok: false, error: err.message, needNode: /ENOENT/.test(err.message) }));
    proc.on('close', (code) => resolve({ ok: code === 0, code, log: log.slice(-600) }));
  });
});

// 자동 로그인: 브라우저 OAuth 띄우고 완료까지 대기 → 끝나면 공식 status 재확인.
// codex login(localhost 콜백) / claude auth login --claudeai. 사용자가 브라우저에서 로그인.
ipcMain.handle('cli:login', async (e, brainMode) => {
  const specs = {
    'claude-subscription': ['claude', ['auth', 'login', '--claudeai']],
    'codex-subscription': ['codex', ['login']],
  };
  const spec = specs[brainMode];
  if (!spec) return { ok: false, error: 'unknown brainMode' };
  return await new Promise((resolve) => {
    let proc;
    try { proc = spawn(spec[0], spec[1], { shell: true, windowsHide: true }); }
    catch (err) { return resolve({ ok: false, error: err.message }); }
    let log = '';
    proc.stdout.on('data', d => { log += d; });
    proc.stderr.on('data', d => { log += d; });
    // 로그인 창이 떴다는 신호(브라우저 안내 출력) 한 번 전달
    const notify = () => { try { e.sender.send('cli:login-progress', { brainMode, text: log.slice(-300) }); } catch (_) {} };
    proc.stdout.on('data', notify); proc.stderr.on('data', notify);
    const timer = setTimeout(() => { try { proc.kill(); } catch (_) {} resolve({ ok: false, error: 'timeout', log: log.slice(-300) }); }, 5 * 60 * 1000);
    proc.on('error', err => { clearTimeout(timer); resolve({ ok: false, error: err.message }); });
    proc.on('close', () => {
      clearTimeout(timer);
      let loggedIn = false, account = null;
      try {
        if (brainMode === 'claude-subscription') { const s = brainClaude.authStatus(); loggedIn = !!s.loggedIn; if (loggedIn) account = { email: s.email || '', plan: s.subscriptionType || '' }; }
        else { loggedIn = !!brainCodex.loginStatus().loggedIn; }
      } catch (_) {}
      resolve({ ok: loggedIn, loggedIn, account, log: log.slice(-300) });
    });
  });
});

// API 키 연결 테스트: 해당 두뇌로 가벼운 1회 호출 → 성공/실패.
ipcMain.handle('api:test', async (e, { brainMode, apiKey, model, baseURL }) => {
  try {
    const gen = pickGenerate({ brainMode, apiKey, model, baseURL });
    if (!gen) return { ok: false, error: '이 모델은 테스트가 필요 없어요.' };
    const txt = await gen('You are a connection tester.', 'Reply with the single word: OK', { timeout: 25000, maxTokens: 8 });
    return { ok: true, sample: String(txt || '').trim().slice(0, 60) };
  } catch (err) {
    return { ok: false, error: (err && err.message) || '연결 실패' };
  }
});

// 봇(텔레그램/디스코드) 대화를 앱 채팅창에 실시간 반영(같은 프로세스). 앱이 그 에이전트를 보고 있으면 렌더러가 append.
function _botExchange(ex) { try { if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('chat:incoming', ex); } catch (_) {} }

// ── 텔레그램 메신저 연결 (에이전트를 메신저 창구로) ──────────────────────
let tgBot = { running: false, stop: false, username: null, agentId: null };
function tgConfigPath() { return path.join(app.getPath('userData'), 'telegram-bot.json'); }
function tgDataPath() { return path.dirname(storage.getDataPath()); } // 앱 데이터 폴더

ipcMain.handle('telegram:status', () => ({ running: tgBot.running, username: tgBot.username, agentId: tgBot.agentId }));

ipcMain.handle('telegram:connect', async (e, { token, agentId }) => {
  if (!token || !agentId) return { ok: false, error: '토큰과 에이전트가 필요해요.' };
  let me = null;
  try { me = await botTelegram.verifyToken(token); } catch (_) {}
  if (!me) return { ok: false, error: '토큰이 올바르지 않아요. BotFather 토큰을 다시 확인해 주세요.' };
  // 기존 봇 중지(이전 stopRef 가 종료됨)
  tgBot.stop = true;
  await new Promise(r => setTimeout(r, 100));
  const cp = tgConfigPath();
  const prev = botTelegram.readConfig(cp);
  const ownerId = (prev.token === token && prev.agentId === agentId) ? prev.ownerId : undefined;
  const cfg = { token, dataPath: tgDataPath(), agentId, ownerId, configPath: cp };
  botTelegram.saveConfig(cfg);
  tgBot = { running: true, stop: false, username: me.username, agentId };
  const ref = tgBot;
  botTelegram.startBot(cfg, { stop: () => ref.stop, onExchange: _botExchange }).catch(() => { ref.running = false; });
  return { ok: true, username: me.username };
});

ipcMain.handle('telegram:disconnect', () => { tgBot.stop = true; tgBot.running = false; return { ok: true }; });

// ── 디스코드 메신저 연결 (텔레그램과 동일 구조, engine 공유) ──────────────
let dcBot = { running: false, stop: false, username: null, agentId: null };
function dcConfigPath() { return path.join(app.getPath('userData'), 'discord-bot.json'); }

ipcMain.handle('discord:status', () => ({ running: dcBot.running, username: dcBot.username, agentId: dcBot.agentId, botId: dcBot.botId }));

ipcMain.handle('discord:connect', async (e, { token, agentId }) => {
  if (!token || !agentId) return { ok: false, error: '토큰과 에이전트가 필요해요.' };
  let me = null;
  try { me = await botDiscord.verifyToken(token); } catch (_) {}
  if (!me) return { ok: false, error: '토큰이 올바르지 않아요. Discord Developer Portal 의 Bot 토큰을 다시 확인해 주세요.' };
  dcBot.stop = true;
  await new Promise(r => setTimeout(r, 100));
  const cp = dcConfigPath();
  const prev = botDiscord.readConfig(cp);
  const ownerId = (prev.token === token && prev.agentId === agentId) ? prev.ownerId : undefined;
  const cfg = { token, dataPath: tgDataPath(), agentId, ownerId, configPath: cp };
  botDiscord.saveConfig(cfg);
  dcBot = { running: true, stop: false, username: me.username, agentId, botId: me.id };
  const ref = dcBot;
  botDiscord.startBot(cfg, { stop: () => ref.stop, onExchange: _botExchange }).catch(() => { ref.running = false; });
  return { ok: true, username: me.username };
});

ipcMain.handle('discord:disconnect', () => { dcBot.stop = true; dcBot.running = false; return { ok: true }; });

// 앱 시작 시 저장된 디스코드 연결 자동 복원
async function restoreDiscord() {
  try {
    const saved = botDiscord.readConfig(dcConfigPath());
    if (!saved.token || !saved.agentId) return;
    const me = await botDiscord.verifyToken(saved.token);
    if (!me) return;
    const cfg = { ...saved, dataPath: tgDataPath(), configPath: dcConfigPath() };
    dcBot = { running: true, stop: false, username: me.username, agentId: saved.agentId, botId: me.id };
    const ref = dcBot;
    botDiscord.startBot(cfg, { stop: () => ref.stop, onExchange: _botExchange }).catch(() => { ref.running = false; });
    console.log(`[discord] 자동 복원: @${me.username} ↔ ${saved.agentId}`);
  } catch (_) {}
}

// 예약된 정기 작업: PC(앱) 켜진 동안 매분 확인 → 실행 → 텔레그램/시스템알림으로 전달.
let _appSchedTimer = null;
function startAppScheduler() {
  if (_appSchedTimer) return;
  const deps = {
    loadAgent: storage.loadAgent,
    loadAllAgents: storage.loadAllAgents,
    saveAgent: storage.saveAgent,
    runTurn: (id, prompt) => engine.runTurn({ agentId: id, userMessage: prompt, emit: () => {} }),
    deliver: async (ch, text, s) => {
      const isHb = s && s.kind === 'heartbeat'; // 하트비트(먼저 안부)는 '예약' 라벨 없이 자연스럽게
      const body = String(text);
      if (ch === 'telegram') { await botTelegram.sendToOwner(isHb ? body : `🔔 ${s.title}\n${body}`).catch(() => {}); return; }
      if (ch === 'discord') { await botDiscord.sendToOwner(isHb ? body : `🔔 ${s.title}\n${body}`).catch(() => {}); return; }
      try {
        if (Notification.isSupported()) {
          const n = new Notification(isHb ? { body: body.slice(0, 240), silent: false, timeoutType: 'default' } : { title: `🔔 ${s.title}`, body: body.slice(0, 240), silent: false, timeoutType: 'default' });
          // 토스트 클릭 → 앱 띄우고 포커스(내용은 채팅창에 이미 남김)
          n.on('click', () => { try { if (mainWindow && !mainWindow.isDestroyed()) { if (mainWindow.isMinimized()) mainWindow.restore(); mainWindow.show(); mainWindow.focus(); } } catch (_) {} });
          n.show();
        }
      } catch (_) {}
      try { if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('schedule:result', { title: s.title, text: body, kind: isHb ? 'heartbeat' : 'schedule' }); } catch (_) {}
    },
  };
  _appSchedTimer = setInterval(() => { scheduler.tick(Date.now(), deps).catch(() => {}); }, 60000);
}

// 앱 시작 시 저장된 텔레그램 연결 자동 복원(친화: 한 번 연결하면 켤 때마다 자동).
async function restoreTelegram() {
  try {
    const saved = botTelegram.readConfig(tgConfigPath());
    if (!saved.token || !saved.agentId) return;
    const me = await botTelegram.verifyToken(saved.token);
    if (!me) return;
    const cfg = { ...saved, dataPath: tgDataPath(), configPath: tgConfigPath() };
    tgBot = { running: true, stop: false, username: me.username, agentId: saved.agentId };
    const ref = tgBot;
    botTelegram.startBot(cfg, { stop: () => ref.stop, onExchange: _botExchange }).catch(() => { ref.running = false; });
    console.log(`[telegram] 자동 복원: @${me.username} ↔ ${saved.agentId}`);
  } catch (_) {}
}

// ── 환경(필요 프로그램) 점검 ───────────────────────────────────────
ipcMain.handle('env:check', async () => env.checkRuntimes());
ipcMain.handle('env:runSetup', async (e, { command, args }) => env.runSetup(command, args));
ipcMain.handle('env:openUrl', async (e, url) => { try { await shell.openExternal(url); return { ok: true }; } catch (err) { return { error: err.message }; } });

// 테마 변경 시 Windows 창버튼 오버레이(최소화/닫기 영역) 색을 맞춤 — 라이트서 검은 영역 잔존 방지
ipcMain.handle('window:setOverlayTheme', (e, theme) => {
  if (!mainWindow || mainWindow.isDestroyed() || !mainWindow.setTitleBarOverlay) return { ok: false };
  try {
    if (theme === 'light') mainWindow.setTitleBarOverlay({ color: '#ffffff', symbolColor: '#14161b', height: 44 });
    else mainWindow.setTitleBarOverlay({ color: '#0b0b12', symbolColor: '#cfd0e0', height: 44 });
    return { ok: true };
  } catch (err) { return { error: err.message }; }
});
ipcMain.handle('mcp:test', async (e, { agentId, id }) => {
  const s = mcpManager.listServers(agentId).find(x => x.id === id);
  if (!s) return { error: '서버 없음' };
  return mcpManager.testServer(agentId, s);
});

// 에이전트 로드
ipcMain.handle('agent:load', async (e, id) => {
  return storage.loadAgent(id);
});

// L1: 작업 기억 조회 (UI용)
ipcMain.handle('work:get', async (e, agentId) => {
  const agent = storage.loadAgent(agentId);
  if (!agent) return { work: null };
  if (!agent.work) agent.work = { activeId: null, projects: [], routines: [] };
  return { work: agent.work };
});

// L1: 작업 활성 전환 (UI 직접 클릭용)
ipcMain.handle('work:setActive', async (e, { agentId, id }) => {
  const agent = storage.loadAgent(agentId);
  if (!agent) return { error: '에이전트 없음' };
  if (!agent.work) agent.work = { activeId: null, projects: [], routines: [] };
  agent.work.activeId = id || null;
  storage.saveAgent(agent);
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('work:updated', { agentId, work: agent.work });
  return { ok: true, activeId: agent.work.activeId };
});

// 멀티모달 입력(이미지·PDF·파일)을 네이티브로 받는 두뇌. (제공자별 확장)
const MULTIMODAL_PROVIDERS = new Set(['gemini-api', 'claude-api', 'openai-api', 'openai-compatible']);

/**
 * 에이전트의 두뇌(brainMode)에 맞는 생성기를 고른다.
 * 모든 LLM 두뇌는 (systemPrompt, userPrompt, opts) -> Promise<text> 시그니처로 통일.
 * 알 수 없는/미설정 두뇌는 null 반환(호출부가 "모델 연결" 안내).
 */
function pickGenerate(agent) {
  // 키 보관함 우선(제공자별), 없으면 단일 미러 폴백(하위호환)
  const key = (agent.apiKeys && agent.apiKeys[agent.brainMode]) || agent.apiKey;
  const mdl = (agent.models && agent.models[agent.brainMode]) || agent.model;
  switch (agent.brainMode) {
    case 'gemini-api':
      return (sys, usr, opts = {}) =>
        brainGemini.geminiGenerate(sys, usr, { ...opts, apiKey: key, model: mdl });
    case 'claude-subscription':
      return (sys, usr, opts = {}) => brainClaude.claudeGenerate(sys, usr, opts);
    case 'codex-subscription':
      return (sys, usr, opts = {}) => brainCodex.codexGenerate(sys, usr, opts);
    case 'antigravity-subscription':
      return (sys, usr, opts = {}) => brainAntigravity.antigravityGenerate(sys, usr, { ...opts, model: mdl });
    case 'claude-api':
      return (sys, usr, opts = {}) =>
        brainAnthropic.anthropicGenerate(sys, usr, { ...opts, apiKey: key, model: mdl });
    case 'openai-api':
      return (sys, usr, opts = {}) =>
        brainOpenai.openaiGenerate(sys, usr, { ...opts, apiKey: key, model: mdl });
    case 'openai-compatible':
      // OpenAI 호환 범용 커넥터(OpenRouter·xAI Grok·DeepSeek·Mistral·Groq 등). baseURL로 제공자 지정.
      return (sys, usr, opts = {}) =>
        brainOpenai.openaiGenerate(sys, usr, { ...opts, apiKey: key, model: mdl, baseURL: agent.baseURL });
    default:
      return null; // 미설정/알 수 없는 두뇌
  }
}

// 메시지 전송 (LLM 두뇌: claude 구독 / gemini api / …)
// 같은 에이전트의 대화는 한 번에 하나씩 처리한다.
// 사용자가 답을 기다리지 않고 말을 이어 붙여도, 뒤 메시지는 앞 답변까지 본 뒤 처리된다.
ipcMain.handle('chat:send', async (e, payload) => handleChatSend(e, payload));

// 진행 중 턴의 취소 핸들(agentId → AbortController). 정지 버튼/ESC 가 이걸 abort 한다.
const _inflightTurns = new Map();
// 정지: 진행 중인 두뇌 호출을 취소한다. 부분 답변은 엔진이 보존한다(stopped 결과).
ipcMain.handle('chat:stop', async (e, { agentId }) => {
  const ac = _inflightTurns.get(agentId);
  if (ac) { try { ac.abort(); } catch (_) {} return { ok: true }; }
  return { ok: false };
});

// 앱 대화 처리 — 공통 엔진(engine.runTurn/processMemory)에 위임하고 앱 고유(첨부 인테이크·스트리밍·파일카드·알림·IPC)만 얹는다.
// (2026-07-12 엔진 통합: 회상·프롬프트·L2·도구루프·생성·정직②④·응답저장·기억후처리는 engine 담당 = CLI·텔레그램·디스코드와 동일 루프.
//  직렬화는 engine.runTurn 내부 runExclusive 가 하므로 여기서 바깥 래핑하지 않는다 — 같은 agentId 중첩이면 데드락.)
async function handleChatSend(e, { agentId, userMessage, attachments }) {
  const agent = storage.loadAgent(agentId);
  if (!agent) return { error: '에이전트를 찾을 수 없음' };
  if (!agent.work) agent.work = { activeId: null, projects: [], routines: [] };

  // ── 첨부 인테이크 (앱 고유: 원본 보관·멀티모달 변환·표시메시지 분리) ──
  let atts;
  let displayUserMessage = userMessage; // 대화 저장·표시용 — 파일 원문 대신 "첨부: 이름" (재실행 시 원문노출 방지)
  let userFiles = [];                    // 사용자 첨부 원본(카드로 다시 열기·받기)
  if (Array.isArray(attachments) && attachments.length) {
    const dlDir = path.join(path.dirname(storage.getDataPath()), 'download');
    const bufs = attachments.map(a => ({ a, buf: Buffer.from(a.data || '', 'base64') }));
    const skipped = [];
    for (const { a, buf } of bufs) {
      const saved = attachStore.saveAttachment(dlDir, a.name || 'file', buf);
      if (saved && !saved.error) userFiles.push({ path: saved.path, name: saved.name, size: saved.size, isImage: /\.(png|jpe?g|gif|webp)$/i.test(saved.name) });
      else if (saved && saved.error) skipped.push(saved.error);
    }
    const _emitStatus = (m) => { try { if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('chat:status', { agentId, text: m }); } catch (_) {} };
    const results = await Promise.all(bufs.map(({ a, buf }) => intakeFile({ name: a.name || 'file', mimeType: a.mimeType, buffer: buf }, { onStatus: _emitStatus })));
    const parts = buildPromptParts(results);
    const multimodalOn = MULTIMODAL_PROVIDERS.has(agent.brainMode);
    atts = (multimodalOn && parts.attachments.length) ? parts.attachments : undefined;
    const _names = attachments.map(a => a.name || '파일').join(', ');
    displayUserMessage = userFiles.length ? userMessage : ((userMessage ? userMessage + '\n' : '') + `[첨부: ${_names}]`);
    if (parts.noteText) userMessage = (userMessage ? userMessage + '\n\n' : '') + parts.noteText;
    if (userFiles.length) {
      const _paths = userFiles.map(f => `"${f.name}" → ${f.path}`).join('\n');
      userMessage = (userMessage ? userMessage + '\n\n' : '') + `[받은 파일이 아래 경로에 저장됨 — 필요하면 read_file/send_file로 다룰 수 있어]\n${_paths}`;
    }
    if (skipped.length) userMessage = (userMessage ? userMessage + '\n\n' : '') + `(시스템 안내: ${skipped[0]})`;
  }

  // ── 앱 UI 콜백 ──
  const send = (ch, p) => { try { if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(ch, p); } catch (_) {} };
  const onDelta = (d) => { if (d) send('chat:stream', { agentId, delta: d }); }; // 실시간 스트리밍
  const sentFiles = []; // 에이전트가 send_file 로 보낸 파일(렌더러 카드)
  const deliverFileToApp = async ({ path: fp, name, note }) => {
    const item = { path: fp, name, note: note || '' };
    try {
      const st = fs.statSync(fp); item.size = st.size;
      const ext = path.extname(name).toLowerCase();
      if (/\.(png|jpe?g|gif|webp)$/.test(ext) && st.size <= 5 * 1024 * 1024) {
        const mime = ext === '.png' ? 'image/png' : ext === '.gif' ? 'image/gif' : ext === '.webp' ? 'image/webp' : 'image/jpeg';
        item.dataUrl = `data:${mime};base64,${fs.readFileSync(fp).toString('base64')}`; // 이미지 미리보기(5MB 이하)
      }
    } catch (_) {}
    sentFiles.push(item);
  };
  // 엔진 이벤트 → 렌더러 IPC 매핑. 엔진은 'facts'/'work'(제네릭)와 'facts:updated'/'work:updated'/'skill:learned'/'chat:stream'(도구층 IPC명)을 섞어 emit → 여기서 통일 + agentId 보정.
  const emit = (ch, p) => {
    const pl = (p && typeof p === 'object' && !Array.isArray(p) && !p.agentId) ? { agentId, ...p } : p;
    if (ch === 'facts') return send('facts:updated', pl);
    if (ch === 'work') return send('work:updated', pl);
    if (ch === 'status') return send('chat:status', pl); // 유튜브·모델 다운로드 "받는 중" 안내
    if (typeof ch === 'string' && ch.includes(':')) return send(ch, pl); // facts:updated·work:updated·skill:learned·chat:stream 그대로
    // 'thinking'·'recall'·'recall-error'·'memory' 등 렌더러 미사용 → 무시
  };

  // ── 대화 처리(공통 엔진) — 회상·프롬프트·도구·생성·정직②④·응답저장 전부 담당 ──
  // 정지(정지 버튼/ESC) 지원: 이 턴의 AbortController 를 등록하고 signal 을 엔진에 넘긴다.
  // 같은 agentId 로 새 턴이 오면 이전 핸들을 덮어쓴다(마지막 턴이 정지 대상).
  const _ac = new AbortController();
  _inflightTurns.set(agentId, _ac);
  let r;
  try {
    r = await engine.runTurn({
      agentId, userMessage, displayUserMessage,
      userFiles: userFiles.length ? userFiles : undefined,
      attachments: atts, onDelta, deliverFile: deliverFileToApp, emit,
      signal: _ac.signal,
    });
  } finally {
    if (_inflightTurns.get(agentId) === _ac) _inflightTurns.delete(agentId);
  }
  let response = (r && r.response) || '음... 지금 제대로 답을 못 드리겠네요. 다시 한번 말씀해 주시겠어요?';
  if (r && r.error) {
    console.error('[chat:send] engine 오류:', r.error);
    // 엔진이 실패 마커(r.response)를 이미 대화에 저장한다 → 라이브 표시도 같은 문구로 맞춘다(재로드 시 불일치 방지).
    response = (r && r.response) || '지금 생각을 정리하는 데 시간이 좀 걸리고 있어요. 잠시 후 다시 말을 걸어주실래요?';
  }

  // ── 기억 후처리(공통 memory-post, 비차단) ── 생성기 없으면 봇·CLI와 동일하게 생략(채널 동등).
  // 정지된 턴(stopped)은 답이 미완이라 기억 추출을 건너뛴다(불완전 답에서 사실 뽑지 않음).
  if (r && r.generate && !r.stopped) {
    engine.processMemory({ agentId, userMessage, response, generate: r.generate, rememberedAny: r.rememberedAny, emit })
      .catch(err => console.error('[chat:send] processMemory 오류(무시):', err && err.message));
  }

  // ── 응답 알림(앱 고유): 창 비활성(비포커스·최소화·숨김)일 때만 OS 푸시 + 소리 ──
  try {
    const inactive = mainWindow && !mainWindow.isDestroyed() && (!mainWindow.isFocused() || mainWindow.isMinimized() || !mainWindow.isVisible());
    if (inactive && Notification.isSupported() && response && !(r && r.stopped)) {
      const n = new Notification({ title: (agent && agent.name) || 'Auxo', body: String(response).slice(0, 240), silent: false, timeoutType: 'default' });
      n.on('click', () => { try { if (mainWindow.isMinimized()) mainWindow.restore(); mainWindow.show(); mainWindow.focus(); } catch (_) {} });
      n.show();
    }
  } catch (_) {}

  // 렌더러 반환(기억패널 즉시 갱신용 최신 humanFacts 포함). 응답·대화저장은 engine 이 이미 처리.
  const fa = storage.loadAgent(agentId);
  const outFacts = (fa && Array.isArray(fa.humanFacts)) ? fa.humanFacts : (agent.humanFacts || []);
  return { response, humanFacts: outFacts, usedTools: (r && r.usedTools) || [], sentFiles, userFiles, stopped: !!(r && r.stopped) };
}

// 파일 전달: 에이전트가 보낸 파일 열기/폴더에서 보기 (send_file → sentFiles → renderer 버튼)
ipcMain.handle('file:open', async (e, { path: fp, reveal }) => {
  try {
    if (reveal) { shell.showItemInFolder(fp); return { ok: true }; }
    const err = await shell.openPath(fp);
    if (err) return { error: err };
    return { ok: true };
  } catch (e2) { return { error: e2.message }; }
});

// 파일 다운로드: 에이전트가 보낸 파일을 사용자가 원하는 위치로 저장
ipcMain.handle('file:download', async (e, { path: fp, name }) => {
  try {
    const { filePath, canceled } = await dialog.showSaveDialog(mainWindow, { defaultPath: name || path.basename(fp) });
    if (canceled || !filePath) return { canceled: true };
    fs.copyFileSync(fp, filePath);
    return { ok: true, savedTo: filePath };
  } catch (e2) { return { error: e2.message }; }
});

// 이미지 미리보기: 저장된 파일 경로 → dataUrl. 대화 JSON엔 base64를 안 넣으므로(용량),
// 재실행 후 파일 카드 썸네일은 저장된 원본에서 지연 로드해 복원한다. 이미지·5MB 이하만.
ipcMain.handle('file:preview', async (e, { path: fp }) => {
  try {
    if (!fp || !/\.(png|jpe?g|gif|webp)$/i.test(fp) || !fs.existsSync(fp)) return { error: 'not-image' };
    if (fs.statSync(fp).size > 5 * 1024 * 1024) return { error: 'too-large' };
    const ext = path.extname(fp).toLowerCase();
    const mime = ext === '.png' ? 'image/png' : ext === '.gif' ? 'image/gif' : ext === '.webp' ? 'image/webp' : 'image/jpeg';
    return { ok: true, dataUrl: `data:${mime};base64,${fs.readFileSync(fp).toString('base64')}` };
  } catch (e2) { return { error: e2.message }; }
});

// 대화 로드
ipcMain.handle('chat:load', async (e, agentId) => {
  return storage.loadConversation(agentId);
});

// 압축으로 접힌 옛 원본 대화(아카이브) 로드 — 대화 상단 "이전 대화 더 보기"용.
ipcMain.handle('chat:loadArchive', async (e, agentId, opts) => {
  // ★2026-07-16: 페이징 — opts 있으면 뒤에서부터 페이지만(대화 수만 개인 사용자도 화면이 안 멈추게).
  //   opts 없이 부르던 기존 호출은 그대로 전량 반환(하위호환).
  if (opts) return storage.loadArchivedPage(agentId, opts);
  return storage.loadArchivedMessages(agentId);
});

// Export — 표준 에이전트 파일 포맷(companion-format v1.0)으로 내보내기
// 결정 A: apiKey 절대 미포함 (companion-format.serialize 내부에서 화이트리스트 + 사후검증)
ipcMain.handle('agent:export', async (e, payload) => {
  // payload: 문자열(구) 또는 {agentId, includeWork}. includeWork=true면 완전 백업(작업·전체대화 포함).
  const agentId = typeof payload === 'string' ? payload : (payload && payload.agentId);
  const includeWork = !!(payload && payload.includeWork);
  const agent = storage.loadAgent(agentId);
  if (!agent) return { error: '에이전트 없음' };
  const messages = storage.loadArchivedMessages(agentId).concat(storage.loadConversation(agentId)); // 완전백업: 아카이브(옛 대화)+활성 전체
  const conversationSummary = storage.loadConversationSummary(agentId);

  let exportData;
  try {
    exportData = companionFormat.serialize(agent, messages, conversationSummary, { includeWork });
  } catch (serErr) {
    console.error('[agent:export] serialize 오류:', serErr.message);
    return { error: 'export 직렬화 오류: ' + serErr.message };
  }

  // 파일명: <에이전트이름>.에이전트.json
  const safeName = agent.name.replace(/[\\/:*?"<>|]/g, '_');
  const defaultFileName = `${safeName}.에이전트.json`;

  const { filePath, canceled } = await dialog.showSaveDialog(mainWindow, {
    title: '에이전트 내보내기 (파일 저장)',
    defaultPath: path.join(app.getPath('desktop'), defaultFileName),
    filters: [{ name: '에이전트 파일', extensions: ['json'] }],
  });

  if (canceled || !filePath) return { canceled: true };

  fs.writeFileSync(filePath, JSON.stringify(exportData, null, 2), 'utf8');
  console.log(`[agent:export] 저장 완료: ${filePath} (기억 ${exportData.memory.length}개, 대화 ${exportData.conversation.includedTurns}개)`);
  return { savedTo: filePath };
});

// Export(읽기용) — 사람·다른 AI가 읽는 마크다운 폴더로 내보내기. apiKey·임베딩·내부수치 미포함.
//   payload: {agentId, includeSensitive}. 폴더를 고르면 그 아래 "<이름>-기억/" 생성.
ipcMain.handle('agent:export-markdown', async (e, payload) => {
  const agentId = typeof payload === 'string' ? payload : (payload && payload.agentId);
  const includeSensitive = !(payload && payload.includeSensitive === false); // 기본 포함
  const agent = storage.loadAgent(agentId);
  if (!agent) return { error: '에이전트 없음' };
  const { filePaths, canceled } = await dialog.showOpenDialog(mainWindow, {
    title: '읽기용 폴더로 내보내기 (저장할 위치 선택)',
    defaultPath: app.getPath('desktop'),
    properties: ['openDirectory', 'createDirectory'],
  });
  if (canceled || !filePaths || !filePaths[0]) return { canceled: true };
  try {
    const r = memoryExport.exportToFolder(agentId, storage, filePaths[0], { includeSensitive });
    console.log(`[agent:export-markdown] 저장 완료: ${r.dir} (파일 ${r.fileCount}개, 민감포함=${includeSensitive})`);
    return { savedTo: r.dir, fileCount: r.fileCount };
  } catch (err) {
    console.error('[agent:export-markdown] 오류:', err.message);
    return { error: '마크다운 내보내기 오류: ' + err.message };
  }
});

// Export (연기 없이 고정 경로 — smoke/테스트용)
ipcMain.handle('agent:export-silent', async (e, agentId) => {
  const agent = storage.loadAgent(agentId);
  if (!agent) return { error: '에이전트 없음' };
  const messages = storage.loadArchivedMessages(agentId).concat(storage.loadConversation(agentId)); // 완전백업: 아카이브(옛 대화)+활성 전체
  const conversationSummary = storage.loadConversationSummary(agentId);

  let exportData;
  try {
    exportData = companionFormat.serialize(agent, messages, conversationSummary);
  } catch (serErr) {
    return { error: 'export 직렬화 오류: ' + serErr.message };
  }

  const safeName = agent.name.replace(/[\\/:*?"<>|]/g, '_');
  const outPath = path.join(app.getPath('desktop'), `${safeName}.에이전트.json`);
  fs.writeFileSync(outPath, JSON.stringify(exportData, null, 2), 'utf8');
  return { savedTo: outPath };
});

// Import — 에이전트 파일 불러오기 (새 에이전트로 등록)
// 결정 A: apiKey 는 파일에 없으므로 복원 안 됨. 사용자가 두뇌를 나중에 연결.
ipcMain.handle('agent:import', async (e) => {
  const { filePaths, canceled } = await dialog.showOpenDialog(mainWindow, {
    title: '에이전트 가져오기',
    filters: [{ name: '에이전트 파일', extensions: ['json'] }],
    properties: ['openFile'],
  });

  if (canceled || !filePaths || filePaths.length === 0) return { canceled: true };

  const filePath = filePaths[0];
  let raw;
  try {
    const content = fs.readFileSync(filePath, 'utf8');
    raw = JSON.parse(content);
  } catch (parseErr) {
    return { error: `파일을 읽을 수 없어요. (${parseErr.message})` };
  }

  const result = companionFormat.deserialize(raw);
  if (!result.ok) {
    return { error: result.error };
  }

  const { data, conversation } = result;

  // 새 에이전트로 등록 (새 id 부여) — 완전 백업 복원(인격·기억·지침·설정·작업기억 전부)
  const newAgent = {
    id: `agent-imported-${Date.now()}`,
    name: data.name,
    persona: data.persona,
    avatar: data.avatar || null,
    speech: data.speech,
    userNickname: data.userNickname,
    auxoMd: data.auxoMd || '',
    disabledSkills: data.disabledSkills || [],
    disabledMcp: data.disabledMcp || [],
    brainMode: data.brainMode,
    baseURL: data.baseURL || '',
    apiKey: '',                         // 결정 A: 키는 복원 안 함(새 기기서 재입력)
    apiKeys: {},
    models: {},
    humanFacts: data.humanFacts,
    work: data.work || { activeId: null, projects: [], routines: [] }, // 작업기억 복원
    createdAt: new Date().toISOString(),
    importedFrom: {
      originalId: data.originalId,
      originalCreatedAt: data.originalCreatedAt,
      exportedAt: data.exportedAt,
      baseLayerVersion: data.baseLayerVersion,
      filePath,
    },
  };

  storage.saveAgent(newAgent);
  // 복원: 옛 대화는 아카이브로, 최근 것만 활성으로 → 활성/아카이브 구분 유지(옛 대화가 활성에 통째로 쌓이지 않게).
  const KEEP_ACTIVE = 20;
  if (conversation.length > KEEP_ACTIVE) {
    storage.appendArchivedMessages(newAgent.id, conversation.slice(0, conversation.length - KEEP_ACTIVE));
    storage.saveConversation(newAgent.id, conversation.slice(conversation.length - KEEP_ACTIVE));
  } else {
    storage.saveConversation(newAgent.id, conversation);
  }
  if (data.conversationSummary) storage.saveConversationSummary(newAgent.id, data.conversationSummary); // 대화 요약 복원
  // 일화(함께한 일) 복원 — saveAgent는 episodes를 안 쓰므로(addEpisodes 소유) 명시 복원. 원본 날짜 보존.
  if (Array.isArray(data.episodes) && data.episodes.length) storage.addEpisodes(newAgent.id, data.episodes);

  console.log(`[agent:import] 에이전트 복원 완료: "${newAgent.name}" (id=${newAgent.id}, 기억=${data.humanFacts.length}개, 일화=${(data.episodes||[]).length}개, 대화=${conversation.length}개, 작업=${(newAgent.work.projects||[]).length}프로젝트)`);
  return { agent: newAgent, conversationCount: conversation.length };
});
