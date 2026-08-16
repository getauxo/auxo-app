/**
 * main.js — Electron 메인 프로세스
 */
const { app, BrowserWindow, ipcMain, dialog, shell, Menu, Notification, nativeImage } = require('electron');
const path = require('path');

// 토스트(푸시) 알림 아이콘 = 새 로고. asar 안 경로를 OS가 못 읽을 수 있어 nativeImage로 메모리에 실어 전달(경로 지정 방식보다 안전). 1회 로드 후 캐시.
let _notiIcon = null;
function notiIcon() {
  if (_notiIcon === null) {
    try { const img = nativeImage.createFromPath(path.join(__dirname, 'icon.png')); _notiIcon = (img && !img.isEmpty()) ? img : undefined; }
    catch (_) { _notiIcon = undefined; }
  }
  return _notiIcon;
}
const fs = require('fs');
const { spawn } = require('child_process');
const storage = require('./storage');
const brainClaude = require('./brain-claude');
const brainGemini = require('./brain-gemini');
const brainAnthropic = require('./brain-anthropic');
const brainOpenai = require('./brain-openai');
const brainCodex = require('./brain-codex');
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
// 알 길이 없다(예: "생각을 정리하는 중"이 무한 반복돼도 원인 추적 불가).
// 앱 폴더의 auxo-error.log 에 남겨 **사용자가 그대로 보내줄 수 있게** 한다. 개인정보는 담지 않는다.
//   ★이걸 보낼 사람은 **실사용자**다. 그래서 이 로그는 "우리끼리 보는 것"이 아니라
//   **모르는 사람이 통째로 보내도 안전해야** 한다.
//   실측: 홈 경로·이메일·API키·토큰·에이전트id·대화 조각 **전부 0건**.
//   ⚠️ 새로 logError 를 부르는 자리를 만들 때는 **경로·대화 내용이 err.message 에 섞이지 않는지** 보고 넣는다.
//      (파일 도구·MCP 설치 실패 등은 경로가 메시지에 들어가기 쉽다 — 아직 그 표본은 못 봤다)
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
// 앱 버전 — 화면 구석에 보여준다. ★예전엔 index.html 에 `v0.1.0` 이 **글자로 박혀 있어서**,
//   package.json 을 올려도 화면은 옛 번호 그대로였다. 사용자가 자기 버전을 잘못 알면
//   "고쳤다는데 왜 그대로냐" 같은 문의를 되풀이하게 된다 → 실제 값을 준다.
ipcMain.handle('app:info', () => ({ version: APP_VERSION }));

async function checkNotice() {
  const d = noticeDir(); if (!d) return;
  const n = await notice.fetchNotice(d); // 옵트아웃이면 요청 없이 null
  if (n && mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('notice:update', { notice: n, appVersion: APP_VERSION });
  }
}

// 설치가 끝난 뒤에도 받아둔 설치본이 캐시에 그대로 남는다(실측: 업데이트 1회에 510MB).
//   우리 앱이 원래 큰 편이라 그냥 두면 사용자 디스크를 계속 먹는다.
//   ★이미 설치된 버전의 잔여물만 지운다 — 아직 설치 안 된 대기분(현재보다 높은 버전)은 건드리지 않는다.
function cleanupUpdaterCache() {
  try {
    const base = process.env.LOCALAPPDATA;
    if (!base) return;
    const dir = path.join(base, 'auxo-updater');
    const info = path.join(dir, 'pending', 'update-info.json');
    if (!fs.existsSync(info)) return;

    const name = (JSON.parse(fs.readFileSync(info, 'utf8')) || {}).fileName || '';
    const m = /(\d+)\.(\d+)\.(\d+)/.exec(name);
    if (!m) return;
    const 받아둔 = [+m[1], +m[2], +m[3]];
    const 지금 = String(APP_VERSION).split('.').map(Number);
    for (let i = 0; i < 3; i++) {
      if ((받아둔[i] || 0) > (지금[i] || 0)) return;   // 아직 설치 안 된 새 버전 — 그대로 둔다
      if ((받아둔[i] || 0) < (지금[i] || 0)) break;    // 옛 버전 잔여물 — 지운다
    }
    fs.rmSync(path.join(dir, 'pending'), { recursive: true, force: true });
    try { fs.rmSync(path.join(dir, 'installer.exe'), { force: true }); } catch (_) {}
    logError('updater', { message: `설치 끝난 잔여물 정리 (${name})` });
  } catch (e) { logError('updater:cleanup', e); }
}

// ── 자동 업데이트 ────────────────────────────────────────────────────
// 사용자가 홈페이지에서 직접 받아 다시 설치하게 하지 않는다.
//   앱이 조용히 받아 두고, **앱을 끌 때 설치**한다 → 다음에 켜면 새 버전. 사용자가 할 일은 없다.
//
// ★대화·기억은 userData 에 있고 프로그램 폴더와 분리돼 있어 업데이트로 사라지지 않는다.
// ★"공지 받지 않기"를 켠 사용자는 업데이트 확인도 하지 않는다 — 네트워크를 안 쓰겠다는 뜻이므로.
// 지금 업데이트가 어떤 상태인가 — 화면에서 물어볼 수 있게 밖에 둔다.
// ★예전엔 이게 전부 setupAutoUpdate 안에만 있어서, **사용자도 우리도 상태를 알 방법이 없었다.**
//   0.2.1~0.2.3 이 업데이트 불능으로 나갔는데도 아무도 눈치채지 못한 이유가 이것이다(2026-08-16).
let _updater = null;
let _updateState = { stage: 'idle', text: '아직 확인하지 않았어요', version: null };

function setupAutoUpdate() {
  if (!app.isPackaged) { _updateState = { stage: 'skipped', text: '개발 실행 중이라 업데이트는 확인하지 않아요', version: null }; return; }
  if (notice.isOff(noticeDir() || '')) { _updateState = { stage: 'off', text: '설정에서 “새 소식·업데이트 확인 받지 않기”가 켜져 있어요', version: null }; return; }
  let autoUpdater;
  try { ({ autoUpdater } = require('electron-updater')); } catch (e) {
    logError('updater:load', e);
    _updateState = { stage: 'error', text: '업데이트 기능을 불러오지 못했어요', version: null };
    return;
  }
  _updater = autoUpdater;

  autoUpdater.autoDownload = true;                // 발견하면 바로 받아 둔다(사용자에게 묻지 않음)
  autoUpdater.autoInstallOnAppQuit = true;        // 끌 때 설치 — 쓰는 도중에 끊지 않는다
  autoUpdater.logger = null;

  const say = (m) => { try { logError('updater', { message: m }); } catch (_) {} };
  const send = (ev, data) => {
    try { if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(ev, data); } catch (_) {}
  };
  // 기록만 남기지 않는다 — **화면에도 같은 것을 보낸다.**
  const 알림 = (stage, text, version) => {
    _updateState = { stage, text, version: version || _updateState.version };
    say(text);
    send('update:state', _updateState);
  };

  autoUpdater.on('checking-for-update', () => 알림('checking', '새 버전이 있는지 확인하는 중이에요'));
  autoUpdater.on('update-available', (i) => 알림('downloading', `새 버전 ${i && i.version} 을 받는 중이에요`, i && i.version));
  autoUpdater.on('update-not-available', () => 알림('latest', '최신 버전을 쓰고 계세요'));
  autoUpdater.on('download-progress', (p) => 알림('downloading', `새 버전을 받는 중이에요 ${Math.round((p && p.percent) || 0)}%`));
  autoUpdater.on('update-downloaded', (i) => {
    알림('ready', `새 버전 ${i && i.version} 준비됐어요 — 앱을 끄면 설치돼요`, i && i.version);
    send('update:ready', { version: i && i.version });
  });
  autoUpdater.on('error', (e) => 알림('error', '업데이트에 실패했어요: ' + ((e && e.message) || e)));

  autoUpdater.checkForUpdates().catch((e) => 알림('error', '확인하지 못했어요: ' + ((e && e.message) || e)));
}

// 화면이 물어볼 때 — 지금 상태를 그대로 준다.
ipcMain.handle('update:state', () => ({ ..._updateState, current: app.getVersion() }));

// 「지금 확인」 — 사용자가 직접 눌렀을 때. 자동으로만 돌면 안 될 때 손쓸 방법이 없다.
ipcMain.handle('update:check', async () => {
  if (!app.isPackaged) return { ok: false, ..._updateState };
  if (!_updater) { setupAutoUpdate(); if (!_updater) return { ok: false, ..._updateState }; }
  try { await _updater.checkForUpdates(); return { ok: true, ..._updateState }; }
  catch (e) {
    _updateState = { stage: 'error', text: '확인하지 못했어요: ' + ((e && e.message) || e), version: _updateState.version };
    return { ok: false, ..._updateState };
  }
});
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
  // ★기억 데이터가 이 앱보다 새 버전이면 storage 가 열지 않고 던진다.
  //   그냥 두면 창도 안 뜨고 조용히 죽는다 — 사용자는 무슨 일인지 알 수 없다. 그래서 여기서 받아 알린다.
  try {
    storage.init(isSmokeMode ? path.join(userData, 'smoke-data') : userData);
  } catch (e) {
    const known = e && (e.code === 'DB_TOO_NEW' || e.code === 'DB_BACKUP_FAILED');
    dialog.showErrorBox('Auxo 를 시작할 수 없습니다',
      known ? e.message
            : `기억 데이터를 여는 중 문제가 생겼습니다.\n\n${e && e.message ? e.message : e}`);
    app.quit();
    return;
  }
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

  // 기억모델 백그라운드 워밍업 — 스플래시/시동 뒤에서 미리 로딩해 첫 대화의 1회성 지연 제거.
  if (!isSmokeMode) setTimeout(() => {
    try { const ags = storage.loadAllAgents(); if (ags && ags.length) embeddings.warm(ags[0]); } catch (_) {}
  }, 1500);

  if (isSmokeMode) {
    // ★화면 촬영기는 smoke-capture.js 로 분리돼 있다 — 개발 전용이라 **사용자에게 나가면 안 된다.**
    //   `smoke*.js` 는 build.files 와 .gitattributes 에서 제외되므로 배포본·공개본에 안 들어간다.
    //   따라서 여기 require 는 **--smoke 로 띄웠을 때만** 실행돼야 한다(사용자 경로에선 파일 자체가 없다).
    //   ★try 로 감싼다 — 설치본엔 이 파일이 **없는 게 정상**이라, 혹시 --smoke 로 띄워도 앱이 죽으면 안 된다.
    let smoke = null;
    try { smoke = require('./smoke-capture'); } catch (_) {}
    if (!smoke) { console.error('[smoke] 촬영기는 개발 전용입니다(설치본에는 없음).'); app.quit(); return; }
    await smoke({
      app, BrowserWindow, ipcMain, storage,
      상태설정: (id, target) => { smokeAgentId = id; smokeScreenTarget = target; },
    }).runSmokeScreenshot();
    return;
  }

  createWindow(true);

  // 창이 뜬 뒤 비차단으로 공지 확인(안테나)
  setTimeout(() => { checkNotice(); }, 3000);
  // 자동 업데이트도 창이 뜬 뒤에 — 시동을 늦추지 않는다
  //   정리를 먼저 한다: 새로 받기 전에 지난 잔여물을 비운다.
  if (!isSmokeMode) 지난실행확인();   // 지난번이 어떻게 끝났는지 먼저 남긴다
  if (!isSmokeMode) setTimeout(() => { cleanupUpdaterCache(); setupAutoUpdate(); }, 5000);

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

// ── 앱이 어떻게 끝났는지 남긴다 ────────────────────────────────────
// 왜: 사용자가 "안 닫았는데 앱이 저절로 꺼졌다"고 할 때, **우리 기록에는 아무것도 없었다**(2026-08-16).
//   logError 는 우리가 붙잡은 오류만 남기므로, 프로세스가 갑자기 사라지면 흔적이 0이다.
//   그래서 실행 중임을 표시해 두고, 정상 종료 때 지운다. 다음에 켰을 때 표시가 남아 있으면
//   **지난번은 비정상 종료**였다는 뜻 — 그것을 기록해 둔다.
function 실행표시경로() { try { return path.join(app.getPath('userData'), 'running.json'); } catch (_) { return null; } }
function 지난실행확인() {
  const p = 실행표시경로(); if (!p) return;
  try {
    if (fs.existsSync(p)) {
      const r = JSON.parse(fs.readFileSync(p, 'utf8')) || {};
      logError('lifecycle', { message: `지난 실행이 정상적으로 끝나지 않았다 (v${r.version || '?'}, 시작 ${r.startedAt || '?'}, pid ${r.pid || '?'})` });
    }
    fs.writeFileSync(p, JSON.stringify({ pid: process.pid, version: APP_VERSION, startedAt: new Date().toISOString() }), 'utf8');
  } catch (_) {}
}
function 정상종료표시(why) {
  const p = 실행표시경로(); if (!p) return;
  try { logError('lifecycle', { message: `정상 종료 (${why})` }); fs.rmSync(p, { force: true }); } catch (_) {}
}
app.on('before-quit', () => 정상종료표시('사용자 또는 앱 요청'));

// 자식 프로세스(GPU·유틸리티)가 죽는 것도 남긴다 — 반복되면 앱 전체가 불안정해진다.
app.on('child-process-gone', (_e, d) => {
  try { if (d && d.reason !== 'clean-exit') logError('lifecycle', { message: `자식 프로세스 종료: ${d.type}/${d.serviceName || ''} 이유=${d.reason} 코드=${d.exitCode}` }); } catch (_) {}
});
app.on('render-process-gone', (_e, _w, d) => {
  try { if (d && d.reason !== 'clean-exit') logError('lifecycle', { message: `화면 프로세스 종료: 이유=${d.reason} 코드=${d.exitCode}` }); } catch (_) {}
});

// ── Smoke 스크린샷 모드 ─────────────────────────────────────────

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
    userMemory: '',   // 이 사람에 대한 기억(통짜 글). [[user-memory]] 가 관리
    refMemory: '',    // 첨부·문서에서 온 정보(본인 사실과 분리)
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

// 기억 삭제/수정 IPC(fact:delete·fact:update)는 두지 않는다.
//   기억 관리 화면이 없는데 핸들러와 렌더러 함수만 남으면
//   "화면에 기억 목록이 있다"고 잘못 읽게 된다.
//   기억을 고치는 길은 대화(remember/forget) 하나다.

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
// 'mcp:add'(임의 명령 직접 등록)·'mcp:addFromJson'은 두지 않는다: 신뢰검사 우회 통로가 된다.
// MCP 등록은 addFromCatalog(신뢰 카탈로그) + 에이전트 find_mcp/install_mcp(신뢰 스코프)로만.
ipcMain.handle('mcp:remove', async (e, { agentId, id }) => mcpManager.removeServer(agentId, id));
ipcMain.handle('mcp:setEnabled', async (e, { agentId, id, enabled }) => mcpManager.setEnabled(agentId, id, enabled));
ipcMain.handle('mcp:setAutoApprove', async (e, { agentId, id, val }) => mcpManager.setAutoApprove(agentId, id, val));
// 능력 메뉴 "빠른 추가"엔 추가만으로 바로 되는 것만 노출(menu:false 는 숨김).
// 숨긴 것(예: Google — 키 입력·비공식)은 사용자가 대화로 요청하면 에이전트가 find_mcp 로 찾아 안내·설치.
ipcMain.handle('mcp:catalog', async () => (mcpManager.loadCatalog().servers || []).filter(s => s.menu !== false));
ipcMain.handle('mcp:addFromCatalog', async (e, { agentId, id, params }) => mcpManager.addFromCatalog(agentId, id, params || {}));

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
    }
  } catch (_) {}
  // 「자동 설치하기」가 동작할 수 있나 = **npm 이 있나**. 그거 하나만 본다.
  // ⚠️ 예전엔 env.checkRuntimes() 를 불렀는데, 그건 **배열**을 돌려주는데 `rt.node`·`rt.npm` 처럼
  //    객체로 읽어서 **결과가 항상 undefined** 였다(= 아래 npm -v 폴백이 매번 진짜 판정을 했다).
  //    쓰지도 않을 결과를 위해 node·npx·python·uv 넷을 순서대로 띄우며 사용자를 기다리게 했고,
  //    python 이 없는 PC 는 Windows 스토어 실행기가 끼어들어 더 느려진다(항목당 타임아웃 8초).
  let nodeReady = false;
  try { require('child_process').execSync('npm -v', { stdio: 'ignore', timeout: 5000 }); nodeReady = true; } catch (_) {}
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
      proc = spawn('npm', ['install', '-g', g.pkg], { shell: true, windowsHide: true });
    }
    catch (err) { return resolve({ ok: false, error: err.message }); }
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
    // ★로그인 여부를 **프로세스 종료로 판단하지 않는다.**
    //   `claude auth login` 은 브라우저 승인이 끝나도 **바로 안 죽는다**(대화형이라 입력을 기다리기도 한다).
    //   예전엔 close 만 기다려서, 사용자가 브라우저에서 승인까지 마쳤는데도 화면이
    //   "브라우저에서 로그인해 주세요"에 **5분간 묶였다**(실사용자 실측 2026-08-16).
    //   그 화면엔 버튼도 없어서 **할 수 있는 게 아무것도 없었다.**
    //   → 인증 흔적(authStatus)을 **주기적으로 확인**해서, 되는 순간 바로 넘어간다.
    let done = false;
    const 끝 = (r) => { if (done) return; done = true; clearTimeout(timer); clearInterval(poll); try { proc.kill(); } catch (_) {} resolve(r); };
    // ⚠️ 폴링에서는 **파일만 본다.** `claude auth status`·`codex login status` 는 execSync(최대 8초)라
    //    2초마다 부르면 **메인 프로세스가 통째로 멈춘다**(앱 전체가 얼어붙는다).
    //    계정 정보(이메일·플랜)는 로그인이 확인된 **그때 한 번만** 조회한다.
    const 파일로확인 = () => {
      try {
        return brainMode === 'claude-subscription' ? !!brainClaude.isLoggedIn() : !!brainCodex.isLoggedIn();
      } catch (_) { return false; }
    };
    const 확인 = () => {
      if (!파일로확인()) return null;
      let account = null;
      try {
        if (brainMode === 'claude-subscription') {
          const s = brainClaude.authStatus();          // 여기서만 느린 호출 — 이미 로그인된 뒤라 1회
          if (s && s.loggedIn) account = { email: s.email || '', plan: s.subscriptionType || '' };
        }
      } catch (_) {}
      return { ok: true, loggedIn: true, account };
    };
    const poll = setInterval(() => { const r = 확인(); if (r) 끝({ ...r, log: log.slice(-300) }); }, 2000);
    const timer = setTimeout(() => 끝({ ok: false, error: 'timeout', log: log.slice(-300) }), 5 * 60 * 1000);
    proc.on('error', err => 끝({ ok: false, error: err.message }));
    proc.on('close', () => {
      // 프로세스가 먼저 끝났으면 그때 한 번 더 본다(폴링보다 빠를 수 있다).
      const r = 확인();
      끝(r ? { ...r, log: log.slice(-300) } : { ok: false, loggedIn: false, account: null, log: log.slice(-300) });
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

/**
 * 이 키로 쓸 수 있는 모델 목록. 기본 모델을 두지 않기 때문에 필요한 통로다.
 *
 * 왜 필요한가: 우리가 정한 기본 모델 하나에 전부 걸어두면, 제공사가 그 모델을 내리는 순간
 *   **두뇌 전체가 죽는다.** 기본값을 바꿔봐야 그것도 언젠가 죽는다. 그래서 기본을 두지 않고
 *   **회사에 직접 물어본 목록에서 사용자가 고르게** 한다. 우리는 목록을 하나도 안 들고 있으므로
 *   회사가 모델을 바꿔도 우리가 할 일이 없다.
 *
 * ★키 검증을 겸한다 — 목록 조회가 성공했다는 건 키가 유효하다는 뜻이다.
 *   그래서 온보딩에서 "연결 테스트"와 "모델 불러오기"를 한 번에 끝내 단계가 안 늘어난다.
 */
ipcMain.handle('api:models', async (e, { brainMode, apiKey }) => {
  try {
    const 두뇌 = {
      'openai-api': () => require('./brain-openai'),
      'gemini-api': () => require('./brain-gemini'),
      'claude-api': () => require('./brain-anthropic'),
    }[brainMode];
    // openai-compatible 은 제공자가 제각각이라 목록 규격을 보장할 수 없다 → 직접 입력을 유지한다.
    if (!두뇌) return { ok: false, error: '이 연결 방식은 모델 목록을 불러올 수 없어요. 모델명을 직접 입력해 주세요.' };
    const models = await 두뇌().listModels(apiKey);
    if (!models.length) return { ok: false, error: '쓸 수 있는 모델이 없어요. 키와 결제(크레딧) 상태를 확인해 주세요.' };
    return { ok: true, models };
  } catch (err) {
    return { ok: false, error: (err && err.message) || '모델 목록을 못 불러왔어요.' };
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
    runTurn: (id, prompt, 표시) => engine.runTurn({ agentId: id, userMessage: prompt, displayUserMessage: 표시, emit: () => {} }),
    deliver: async (ch, text, s) => {
      const isHb = s && s.kind === 'heartbeat'; // 하트비트(먼저 안부)는 '예약' 라벨 없이 자연스럽게
      const body = String(text);
      if (ch === 'telegram') { await botTelegram.sendToOwner(isHb ? body : `🔔 ${s.title}\n${body}`).catch(() => {}); return; }
      if (ch === 'discord') { await botDiscord.sendToOwner(isHb ? body : `🔔 ${s.title}\n${body}`).catch(() => {}); return; }
      try {
        if (Notification.isSupported()) {
          const n = new Notification(isHb ? { body: body.slice(0, 240), silent: false, timeoutType: 'default', icon: notiIcon() } : { title: `🔔 ${s.title}`, body: body.slice(0, 240), silent: false, timeoutType: 'default', icon: notiIcon() });
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
// ★사본을 두지 않는다 — engine.pickGenerate 한 곳을 쓴다.
//   두 벌이면 새 두뇌를 추가할 때 한쪽만 갱신돼 갈라진다.
//   여기(main)는 설정 화면의 "연결 테스트"에만 쓰이고, 대화는 engine.runTurn 이 처리한다.
const pickGenerate = engine.pickGenerate;

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
// (엔진 통합: 회상·프롬프트·L2·도구루프·생성·정직②④·응답저장·기억후처리는 engine 담당 = CLI·텔레그램·디스코드와 동일 루프.
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
      const n = new Notification({ title: (agent && agent.name) || 'Auxo', body: String(response).slice(0, 240), silent: false, timeoutType: 'default', icon: notiIcon() });
      n.on('click', () => { try { if (mainWindow.isMinimized()) mainWindow.restore(); mainWindow.show(); mainWindow.focus(); } catch (_) {} });
      n.show();
    }
  } catch (_) {}

  // 응답·대화저장은 engine 이 이미 처리. 기억 패널은 화면에 없으므로 안 돌려준다.
  return { response, usedTools: (r && r.usedTools) || [], sentFiles, userFiles, stopped: !!(r && r.stopped) };
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
  // ★페이징 — opts 있으면 뒤에서부터 페이지만(대화 수만 개인 사용자도 화면이 안 멈추게).
  //   opts 없이 부르던 기존 호출은 그대로 전량 반환(하위호환).
  if (opts) return storage.loadArchivedPage(agentId, opts);
  return storage.loadArchivedMessages(agentId);
});

// Export — 표준 에이전트 파일 포맷(companion-format v1.0)으로 내보내기
// 결정 A: apiKey 절대 미포함 (companion-format.serialize 내부에서 화이트리스트 + 사후검증)
ipcMain.handle('agent:export', async (e, payload) => {
  // payload: 문자열(구) 또는 {agentId}. 범위 옵션은 두지 않는다 — 항상 전부 담는다.
  const agentId = typeof payload === 'string' ? payload : (payload && payload.agentId);
  const agent = storage.loadAgent(agentId);
  if (!agent) return { error: '에이전트 없음' };
  const messages = storage.loadArchivedMessages(agentId).concat(storage.loadConversation(agentId)); // 아카이브(옛 대화)+활성 전체
  const conversationSummary = storage.loadConversationSummary(agentId);

  let exportData;
  try {
    exportData = companionFormat.serialize(agent, messages, conversationSummary, { includeWork: true });
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

// ── 문제 기록 내보내기 ─────────────────────────────────────────────────
//   왜: 안 되는 걸 알려주려 해도 사용자는 **로그 파일이 어디 있는지 모른다.**
//   ★자동으로 보내지 않는다. 파일로 저장만 해주고 **보낼지는 사용자가 정한다.**
//     개인정보 방침에 *"우리가 수집하거나 보관하는 것은 없습니다"* 라고 공개 약속을 해뒀다 —
//     자동 전송은 기능 하나가 아니라 **제품이 팔리는 이유**를 깨는 일이다.
//   담기는 것(실측): 두뇌 종류·시도 횟수·실패 사유뿐.
//     홈 경로·이메일·API키·토큰·에이전트id·대화 조각 **전부 0건**.
ipcMain.handle('errorlog:save', async () => {
  const p = errorLogPath();
  let 내용 = '';
  try { 내용 = fs.readFileSync(p, 'utf8'); } catch (_) { /* 파일이 없으면 = 아직 오류가 없었다 */ }
  if (!내용.trim()) return { empty: true };

  const 날짜 = new Date().toISOString().slice(0, 10);
  const { filePath, canceled } = await dialog.showSaveDialog(mainWindow, {
    title: '문제 기록 저장',
    defaultPath: path.join(app.getPath('desktop'), `Auxo-문제기록-${날짜}.txt`),
    filters: [{ name: '텍스트 파일', extensions: ['txt'] }],
  });
  if (canceled || !filePath) return { canceled: true };

  // 받는 쪽(우리)이 뭘 보는지 사용자도 알 수 있게 머리말을 붙인다.
  const 머리말 = [
    `Auxo 문제 기록 (${new Date().toLocaleString('ko-KR')})`,
    `버전 ${app.getVersion()} · ${process.platform} ${require('os').release()}`,
    '',
    '이 파일에는 대화 내용·기억·API 키·비밀번호가 담기지 않습니다.',
    '언제 어떤 기능이 실패했는지만 적혀 있습니다.',
    'hello@getauxo.app 으로 보내주시면 원인을 찾는 데 큰 도움이 됩니다.',
    '─'.repeat(60), '',
  ].join('\n');
  fs.writeFileSync(filePath, 머리말 + 내용, 'utf8');
  return { savedTo: filePath, lines: 내용.split('\n').filter(Boolean).length };
});

// Export(읽기용) — 사람·다른 AI가 읽는 마크다운 폴더로 내보내기. apiKey·임베딩·내부수치 미포함.
//   payload: {agentId}. 민감기억 제외 옵션은 두지 않는다 — 지킬 수 없는 약속이다.
ipcMain.handle('agent:export-markdown', async (e, payload) => {
  const agentId = typeof payload === 'string' ? payload : (payload && payload.agentId);
  const agent = storage.loadAgent(agentId);
  if (!agent) return { error: '에이전트 없음' };
  // 폴더 선택(showOpenDialog)이 아니라 저장 대화상자를 쓴다 — 위치와 **폴더 이름**을 사용자가 정하게.
  // 위치만 고르게 하고 이름을 우리가 박으면 사용자가 폴더 이름을 바꿀 수 없다.
  const folderName = `${(agent.name || '내AI').replace(/[\\/:*?"<>|]/g, '_')}-기억`;
  const { filePath, canceled } = await dialog.showSaveDialog(mainWindow, {
    title: '읽기용 폴더로 내보내기',
    message: '저장할 위치와 폴더 이름을 정해주세요. 이 이름으로 폴더가 만들어집니다.',
    defaultPath: path.join(app.getPath('desktop'), folderName),
    buttonLabel: '내보내기',
    nameFieldLabel: '폴더 이름',
    properties: ['createDirectory', 'showOverwriteConfirmation'],
  });
  if (canceled || !filePath) return { canceled: true };
  try {
    const r = memoryExport.exportToFolder(agentId, storage, filePath, { asFinalDir: true });
    console.log(`[agent:export-markdown] 저장 완료: ${r.dir} (파일 ${r.fileCount}개)`);
    return { savedTo: r.dir, fileCount: r.fileCount };
  } catch (err) {
    console.error('[agent:export-markdown] 오류:', err.message);
    return { error: '글로 저장하는 중 오류가 났어요: ' + err.message }; // 사용자에게 그대로 보이는 문구 — '마크다운' 같은 말은 쓰지 않는다
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
    userMemory: data.userMemory || '',
    refMemory: data.refMemory || '',
    humanFacts: data.humanFacts || [],   // 옛 파일(v1.2 이하) 복원분 — 첫 실행에 통짜로 흡수된다
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

  console.log(`[agent:import] 에이전트 복원 완료: "${newAgent.name}" (id=${newAgent.id}, 기억=${(newAgent.userMemory||'').length}자${(data.humanFacts||[]).length ? ` + 옛 낱개 ${data.humanFacts.length}개(첫 실행에 흡수)` : ''}, 일화=${(data.episodes||[]).length}개, 대화=${conversation.length}개, 작업=${(newAgent.work.projects||[]).length}프로젝트)`);
  return { agent: newAgent, conversationCount: conversation.length };
});
