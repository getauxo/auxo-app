/**
 * app.js — 렌더러 메인 (vanilla JS)
 * P0 기존 동작 유지 + 2층 온보딩 재설계 + 에이전트 설정 화면 추가
 */

/* ── 상태 ─────────────────────────────────────────────── */
let currentAgent = null;
let pendingAttachments = []; // [{mimeType, data(base64), name}]
let _generating = false;     // 응답 생성(대기) 중인지 — 정지 버튼/ESC 제어용
let _stopAgentId = null;     // 정지 대상 agentId
let _queue = [];             // 생성 중 보낸 후속 메시지 대기열 [{text, atts, el}] — 현재 턴 끝나면 순차 처리
const DEFAULT_PERSONA = '따뜻한 친구. 항상 곁에 있어 주고, 진심으로 이 사람을 챙긴다.';
const MAX_ATTACH_MB = 15; // 첨부 1개 상한(대략)
// "이전 대화 더 보기" 한 번에 불러올 개수. 무한스크롤 관례(20~50) 중 50 — 한 번에 전부 붙이면
// 오래 쓴 사용자(수만 개)는 화면이 멈춘다. 데이터 보존 ≠ 화면에 전부 렌더.
const ARCHIVE_PAGE = 50;
const MAX_AVATAR_SRC_MB = 20;  // 원본 파일 상한 (초과 시 거부)
const AVATAR_SIZE = 256;       // canvas 크롭 후 출력 크기 (px)

/* ── 유틸 ─────────────────────────────────────────────── */
function $(sel) { return document.querySelector(sel); }

function showScreen(id) {
  document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
  const el = document.getElementById(id);
  if (el) el.classList.add('active');
}

/* ── 모달 (설정·알림·능력) ───────────────────────────────
   .modal-screen은 .screen과 별개 — 대화 화면을 베이스로 둔 채 위에 띄운다.
   여닫기: openModal/closeModal. 닫기 = X 버튼 · 백드롭 클릭 · ESC. */
function openModal(id) {
  document.querySelectorAll('.modal-screen').forEach(m => m.classList.remove('active'));
  const el = document.getElementById(id);
  if (!el) return;
  el.classList.add('active');
  document.body.classList.add('modal-open');
}
function closeModal() {
  let closed = false;
  document.querySelectorAll('.modal-screen.active').forEach(m => { m.classList.remove('active'); closed = true; });
  document.body.classList.remove('modal-open');
  return closed;
}
// 닫기 트리거 등록 (DOM은 스크립트 로드 시점에 준비됨 — script가 body 끝)
document.querySelectorAll('.modal-screen').forEach(m => {
  m.addEventListener('click', (e) => { if (e.target === m) closeModal(); }); // 백드롭(카드 바깥)
});
document.querySelectorAll('.modal-close').forEach(btn => {
  btn.addEventListener('click', closeModal);
});
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  if (document.querySelector('.modal-screen.active')) { e.preventDefault(); closeModal(); return; }
  // 모달이 없을 때 ESC = 생성 중이면 정지(정지 버튼과 동일 동작).
  if (_generating) { e.preventDefault(); requestStop(); }
});

function scrollToBottom() {
  const el = $('#chat-messages');
  if (el) el.scrollTop = el.scrollHeight;
}

function autoResize(ta) {
  ta.style.height = 'auto';
  ta.style.height = Math.min(ta.scrollHeight, 120) + 'px';
}

function escHtml(s) {
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}

/* ── 테마(외관) ───────────────────────────────────────────
   기본=다크. localStorage('auxo-theme')에 'dark'|'light' 저장.
   다크는 data-theme 속성 없음(=:root 기본), 라이트는 data-theme="light". */
const THEME_KEY = 'auxo-theme';
function getStoredTheme() {
  const t = localStorage.getItem(THEME_KEY);
  return t === 'light' ? 'light' : 'dark'; // 없거나 이상값이면 다크
}
function applyTheme(theme) {
  const t = theme === 'light' ? 'light' : 'dark';
  if (t === 'light') document.documentElement.setAttribute('data-theme', 'light');
  else document.documentElement.removeAttribute('data-theme'); // 다크=기본(:root)
  // 설정 화면 토글 버튼 상태 동기화 (있을 때만)
  const dark = $('#theme-dark');
  const light = $('#theme-light');
  if (dark) dark.classList.toggle('active', t === 'dark');
  if (light) light.classList.toggle('active', t === 'light');
  // Windows 창버튼 오버레이 색도 테마에 맞춤(라이트서 검은 영역 잔존 방지)
  if (window.agentAPI && window.agentAPI.setOverlayTheme) window.agentAPI.setOverlayTheme(t);
}
function setTheme(theme) {
  const t = theme === 'light' ? 'light' : 'dark';
  localStorage.setItem(THEME_KEY, t);
  applyTheme(t);
}
// 시작 시 즉시 적용(깜빡임 최소화)
applyTheme(getStoredTheme());
// ── macOS 보정 (2026-07 실측) ────────────────────────────────
// 1) 신호등 버튼과 햄버거 겹침 방지용 플랫폼 클래스(style.css 참조)
// 2) Antigravity 모델 드롭다운: macOS 는 agy print 모드 버그(#76 계열)로 Gemini/GPT-OSS 가
//    응답을 못 돌려줌 → 기본(빈 값)이 Claude Sonnet 으로 동작함을 표기하고, 불안정 모델에 경고 표기.
if (/Macintosh|Mac OS X/i.test(navigator.userAgent)) {
  document.body.classList.add('platform-darwin');
  window.addEventListener('DOMContentLoaded', () => {
    const sel = document.querySelector('#settings-agy-model');
    if (sel) [...sel.options].forEach(o => {
      if (o.value === '') o.textContent = '기본 (Claude Sonnet 4.6 · macOS 검증됨)';
      else if (!/claude/i.test(o.value)) o.textContent += ' — ⚠️ macOS에서 불안정';
    });
  });
}

/* ── AI 모델(제공자) 메타: API 키 필요 여부·플레이스홀더·기본모델 ───────── */
const BRAIN_META = {
  'claude-subscription': { needsKey: false, supportsWebSearch: false },
  'codex-subscription':  { needsKey: false, supportsWebSearch: false },
  'antigravity-subscription': { needsKey: false, supportsWebSearch: false },
  'gemini-api':          { needsKey: true, supportsWebSearch: true, multimodal: true, keyPlaceholder: 'Gemini API 키 (AIza...)', modelPlaceholder: '모델 (선택 — 비우면 최신 flash 자동)', hint: 'Google AI Studio에서 발급한 키.' },
  'claude-api':          { needsKey: true, supportsWebSearch: true, multimodal: true, keyPlaceholder: 'Anthropic API 키 (sk-ant-...)', modelPlaceholder: '모델 (선택 — 기본 claude-sonnet-5)', hint: 'console.anthropic.com에서 발급한 키. 도구·웹검색·이미지·PDF 지원.' },
  'openai-api':          { needsKey: true, supportsWebSearch: false, multimodal: true, keyPlaceholder: 'OpenAI API 키 (sk-...)', modelPlaceholder: '모델 (선택 — 비우면 최신 GPT 자동)', hint: 'platform.openai.com에서 발급한 키. 도구·이미지 지원(웹검색·PDF는 추후).' },
  'openai-compatible':   { needsKey: true, supportsWebSearch: false, multimodal: true, compat: true, keyPlaceholder: 'API 키 입력', modelPlaceholder: '모델명 (필수 — 제공자 문서 참고)', hint: '' },
};

/* ── OpenAI 호환 제공자 프리셋: 선택하면 base URL·모델 예시·키 발급처 안내 자동 채움 ───────── */
const OPENAI_COMPAT_PRESETS = {
  openrouter: { baseURL: 'https://openrouter.ai/api/v1', modelEg: '예: anthropic/claude-3.7-sonnet, openai/gpt-4o', keyUrl: 'https://openrouter.ai/keys', desc: '키 1개로 GPT·Claude·Gemini·Grok·Llama 등 수백 모델 사용' },
  xai:        { baseURL: 'https://api.x.ai/v1',          modelEg: '예: grok-4',                 keyUrl: 'https://console.x.ai',          desc: 'xAI Grok (검색 내장)' },
  deepseek:   { baseURL: 'https://api.deepseek.com/v1',  modelEg: '예: deepseek-chat',          keyUrl: 'https://platform.deepseek.com', desc: '매우 저렴한 고성능 모델' },
  mistral:    { baseURL: 'https://api.mistral.ai/v1',    modelEg: '예: mistral-large-latest',   keyUrl: 'https://console.mistral.ai',    desc: '유럽 Mistral 모델' },
  groq:       { baseURL: 'https://api.groq.com/openai/v1', modelEg: '예: llama-3.3-70b-versatile', keyUrl: 'https://console.groq.com/keys', desc: '초고속 추론(오픈 모델)' },
  custom:     { baseURL: '',                             modelEg: '제공자 문서의 모델명',        keyUrl: '',                              desc: 'OpenAI 호환 API라면 무엇이든 연결돼요. 제공자 사이트에서 base URL과 키를 확인하세요.' },
};
/** base URL로 어느 프리셋인지 역추정(설정 열 때 복원용). 매칭 없으면 custom. */
function presetKeyFromBaseURL(baseURL) {
  if (!baseURL) return 'custom';
  for (const [k, v] of Object.entries(OPENAI_COMPAT_PRESETS)) {
    if (v.baseURL && baseURL.indexOf(v.baseURL) === 0) return k;
  }
  return 'custom';
}

/** 모델별 API 키 발급처(②-B 1단계 안내) */
const API_ISSUE = {
  'gemini-api':        { url: 'https://aistudio.google.com/apikey', label: 'Google AI Studio 열기 ↗', desc: 'Google AI Studio에서 키를 만들어요(구글 로그인 필요). 무료 한도가 있어요.' },
  'claude-api':        { url: 'https://console.anthropic.com/settings/keys', label: 'Anthropic Console 열기 ↗', desc: 'Anthropic Console에서 키를 만들어요. 쓴 만큼 과금돼요.' },
  'openai-api':        { url: 'https://platform.openai.com/api-keys', label: 'OpenAI Platform 열기 ↗', desc: 'OpenAI Platform에서 키를 만들어요. 쓴 만큼 과금돼요.' },
  'openai-compatible': { url: '', label: '발급처 열기 ↗', desc: '선택한 제공자 사이트에서 키를 만들어요.' },
};

/** 선택 제공자에 맞춰 API 키/모델 입력 영역 갱신(라벨/힌트/호환프리셋). */
function updateApiConfigArea(value) {
  const compat = $('#onboard-compat-config');
  const meta = BRAIN_META[value] || {};
  if (compat) compat.classList.toggle('hidden', !meta.compat);
  if (meta.needsKey) {
    const keyEl = $('#api-key'); const modelEl = $('#api-model'); const hintEl = $('#api-key-hint');
    if (keyEl) keyEl.placeholder = meta.keyPlaceholder || 'API 키 입력';
    if (modelEl) modelEl.placeholder = meta.modelPlaceholder || '모델 (선택)';
    if (hintEl) hintEl.textContent = meta.hint || '';
  }
  if (meta.compat) {
    const presetSel = $('#onboard-compat-preset');
    const pk = (presetSel && presetSel.value) || 'openrouter';
    applyCompatPreset(pk, { fillBaseURL: true, ids: ONBOARD_COMPAT_IDS });
  }
}

/* ━━ 온보딩 3단계 Wizard ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ */
let wizReady2 = false; // ② 연결준비 통과 가능 여부
function selectedMode() { return document.querySelector('input[name="brain-mode"]:checked')?.value || 'claude-subscription'; }
function setWiz2Ready(ok) { wizReady2 = !!ok; const nx = $('#wiz2-next'); if (nx) nx.disabled = !ok; }

function goWizStep(n) {
  [1, 2, 3].forEach(i => { const p = $('#wiz-' + i); if (p) p.classList.toggle('hidden', i !== n); });
  document.querySelectorAll('#wiz-steps .wiz-step').forEach(el => {
    const s = Number(el.getAttribute('data-step'));
    el.classList.toggle('active', s === n);
    el.classList.toggle('done', s < n);
  });
  if (n === 2) enterWizStep2();
  if (n === 3) { const nm = $('#agent-name'); if (nm) setTimeout(() => nm.focus(), 100); }
}

/** ② 진입: 모드에 따라 구독(설치/로그인) / API(발급·입력·테스트) 분기 */
function enterWizStep2() {
  const mode = selectedMode();
  const isSub = mode === 'claude-subscription' || mode === 'codex-subscription' || mode === 'antigravity-subscription';
  $('#prep-sub').classList.toggle('hidden', !isSub);
  $('#prep-api').classList.toggle('hidden', isSub);
  const agyNotice = $('#agy-notice'); // antigravity 리스크·스킬미지원 안내는 antigravity 선택 시만
  if (agyNotice) agyNotice.classList.toggle('hidden', mode !== 'antigravity-subscription');
  setWiz2Ready(false);
  if (isSub) {
    $('#wiz2-title').textContent = '구독 계정에 연결할게요';
    $('#wiz2-sub').textContent = '버튼만 누르면 돼요. 터미널은 필요 없어요.';
    updateCliGate(mode);
  } else {
    $('#wiz2-title').textContent = 'API 키로 연결할게요';
    $('#wiz2-sub').textContent = '키를 발급받아 붙여넣고, 연결을 확인해요.';
    updateApiConfigArea(mode);
    const iss = API_ISSUE[mode] || {};
    if ($('#api-issue-desc')) $('#api-issue-desc').textContent = iss.desc || '';
    if ($('#api-issue-btn')) $('#api-issue-btn').textContent = iss.label || '발급처 열기 ↗';
    const tr = $('#api-test-result'); if (tr) { tr.classList.add('hidden'); tr.textContent = ''; }
  }
}

/* ── ②-A 구독 게이트(버튼형: 자동 설치/로그인) ───────────── */
async function updateCliGate(value) {
  const box = $('#cli-gate'); if (!box) return;
  box.classList.remove('ready', 'warn');
  $('#cli-gate-icon').textContent = '🔌';
  $('#cli-gate-title').textContent = '연결 준비를 확인하는 중…';
  $('#cli-gate-body').innerHTML = '';
  setWiz2Ready(false);
  let r; try { r = await window.agentAPI.cliCheck(value); } catch (_) { r = null; }
  if (selectedMode() !== value) return; // 그새 다른 카드로 바뀜
  if (!r || !r.applicable) { setWiz2Ready(true); return; }
  renderCliGate(value, r);
}

function gateActions(body) {
  let w = body.querySelector('.cli-gate-actions');
  if (!w) { w = document.createElement('div'); w.className = 'cli-gate-actions'; body.appendChild(w); }
  return w;
}
function addGateBtn(body, label, onClick, ghost) {
  const b = document.createElement('button');
  b.textContent = label; if (ghost) b.classList.add('ghost');
  b.addEventListener('click', onClick);
  gateActions(body).appendChild(b);
  return b;
}

function renderCliGate(value, r) {
  const box = $('#cli-gate'); const body = $('#cli-gate-body');
  box.classList.remove('ready', 'warn'); body.innerHTML = '';
  if (r.ready) {
    box.classList.add('ready');
    $('#cli-gate-icon').textContent = '✅';
    $('#cli-gate-title').textContent = `${r.name} 연결 완료`;
    const who = (r.account && r.account.email)
      ? `${r.account.email}${r.account.plan ? ' · ' + r.account.plan + ' 구독' : ''} 계정으로 연결됐어요`
      : '계정이 연결됐어요. 바로 시작할 수 있어요.';
    body.innerHTML = `<div class="step-line">${who}</div>`;
    setWiz2Ready(true);
    return;
  }
  box.classList.add('warn'); setWiz2Ready(false);
  $('#cli-gate-icon').textContent = '🔌';
  // node 없음 → 자동설치 불가 폴백 (스크립트 설치형 antigravity 는 node 불필요라 해당 없음)
  if (!r.installed && r.nodeReady === false && r.installType !== 'script') {
    $('#cli-gate-title').textContent = '먼저 Node.js가 필요해요';
    body.innerHTML = `<div class="step-line">이 PC에 Node.js가 없어 자동 설치를 할 수 없어요. 아래에서 설치한 뒤 다시 시도해 주세요.</div>`;
    addGateBtn(body, 'Node.js 받으러 가기 ↗', () => window.agentAPI.envOpenUrl('https://nodejs.org/'));
    addGateBtn(body, '다시 확인', () => updateCliGate(value), true);
    return;
  }
  if (!r.installed) {
    $('#cli-gate-title').textContent = `${r.name} 설치가 필요해요`;
    body.innerHTML = `<div class="step-line">버튼을 누르면 자동으로 설치하고, 이어서 로그인까지 안내할게요.</div>`;
    addGateBtn(body, '자동 설치하기', () => doCliInstall(value));
  } else if (!r.loginCmd) {
    // Antigravity 등 별도 로그인 CLI 명령이 없는 경우 — 앱/브라우저에서 로그인 후 재확인 안내.
    $('#cli-gate-title').textContent = `${r.name} 로그인이 필요해요`;
    body.innerHTML = `<div class="step-line">Antigravity 앱(또는 사이트)에서 Google 계정으로 한 번 로그인해 주세요. 로그인하면 이 PC에서 바로 인식돼요.</div>`;
    addGateBtn(body, 'Antigravity 로그인 안내 열기 ↗', () => window.agentAPI.envOpenUrl(r.docUrl));
  } else {
    $('#cli-gate-title').textContent = `${r.name} 로그인만 하면 돼요`;
    body.innerHTML = `<div class="step-line">버튼을 누르면 브라우저가 열려요. 로그인하면 자동으로 연결돼요.</div>`;
    addGateBtn(body, '로그인하기', () => doCliLogin(value));
  }
  addGateBtn(body, '다시 확인', () => updateCliGate(value), true);
  // 고급: 직접 터미널
  const adv = document.createElement('details'); adv.className = 'cli-adv';
  adv.innerHTML = `<summary>직접 터미널로 하기</summary><div class="step-line"><code>${r.installCmd}</code></div>${r.loginCmd ? `<div class="step-line"><code>${r.loginCmd}</code></div>` : ''}`;
  body.appendChild(adv);
  const doc = document.createElement('div'); doc.className = 'step-line';
  doc.innerHTML = `<span class="cli-doc">자세한 안내 보기 ↗</span>`;
  doc.querySelector('.cli-doc').addEventListener('click', () => window.agentAPI.envOpenUrl(r.docUrl));
  body.appendChild(doc);
}

async function doCliInstall(value) {
  const body = $('#cli-gate-body');
  $('#cli-gate-icon').textContent = '📦';
  $('#cli-gate-title').textContent = '설치하고 있어요… (보통 1~2분)';
  body.innerHTML = '<div class="step-line">잠깐만요, 자동으로 설치 중이에요.</div><pre class="cli-log" id="cli-log"></pre>';
  const off = window.agentAPI.onCliInstallProgress(({ text }) => {
    const l = $('#cli-log'); if (l) { l.textContent = (l.textContent + text).slice(-1500); l.scrollTop = l.scrollHeight; }
  });
  let res; try { res = await window.agentAPI.cliInstall(value); } catch (e) { res = { ok: false, error: e.message }; }
  if (off) off();
  if (selectedMode() !== value) return;
  if (res && res.ok) { await doCliLogin(value); }
  else {
    $('#cli-gate-icon').textContent = '⚠️';
    $('#cli-gate-title').textContent = '설치에 실패했어요';
    body.innerHTML = `<div class="step-line">자동 설치가 안 됐어요. 다시 시도하거나 직접 설치해 주세요.</div>`;
    addGateBtn(body, '다시 시도', () => doCliInstall(value));
    addGateBtn(body, '다시 확인', () => updateCliGate(value), true);
  }
}

async function doCliLogin(value) {
  const body = $('#cli-gate-body');
  $('#cli-gate-icon').textContent = '🌐';
  $('#cli-gate-title').textContent = '브라우저에서 로그인해 주세요';
  body.innerHTML = '<div class="step-line">로그인 창(브라우저)이 열렸어요. 로그인하면 자동으로 연결돼요. 창이 안 보이면 작업표시줄을 확인해 주세요.</div>';
  let res; try { res = await window.agentAPI.cliLogin(value); } catch (e) { res = { ok: false, error: e.message }; }
  if (selectedMode() !== value) return;
  await updateCliGate(value); // 결과를 상태로 재렌더(성공이면 ✅)
  if (!(res && res.ok)) {
    const b2 = $('#cli-gate-body');
    const note = document.createElement('div'); note.className = 'step-line warn-text';
    note.textContent = '로그인이 완료되지 않았어요. 다시 시도해 주세요.';
    b2.insertBefore(note, b2.firstChild);
  }
}

/* ── ②-B API 연결 테스트 ─────────────────────────────────── */
function showApiTest(kind, msg) {
  const tr = $('#api-test-result'); if (!tr) return;
  tr.className = 'api-test-result ' + kind;
  tr.classList.remove('hidden'); tr.textContent = msg;
}

/* ── 온보딩: 두뇌 카드 클릭(선택만) ───────────────────────── */
document.querySelectorAll('.brain-card').forEach(card => {
  card.addEventListener('click', () => {
    document.querySelectorAll('.brain-card').forEach(c => c.classList.remove('selected'));
    card.classList.add('selected');
    const radio = card.querySelector('input[type="radio"]');
    if (radio) radio.checked = true;
  });
});

/* ── 온보딩 wizard 네비/액션 배선 ─────────────────────────── */
$('#wiz1-next')?.addEventListener('click', () => goWizStep(2));
$('#wiz2-back')?.addEventListener('click', () => goWizStep(1));
$('#wiz2-next')?.addEventListener('click', () => { if (wizReady2) goWizStep(3); });
$('#wiz3-back')?.addEventListener('click', () => goWizStep(2));

$('#api-issue-btn')?.addEventListener('click', () => {
  const mode = selectedMode();
  let url = (API_ISSUE[mode] || {}).url;
  if (mode === 'openai-compatible') {
    const pk = $('#onboard-compat-preset')?.value || 'openrouter';
    url = (OPENAI_COMPAT_PRESETS[pk] || {}).keyUrl || '';
  }
  if (url) window.agentAPI.envOpenUrl(url);
  else alert('이 제공자의 발급처 주소가 없어요. 제공자 사이트에서 키를 받아주세요.');
});

$('#api-test-btn')?.addEventListener('click', async () => {
  const mode = selectedMode();
  const apiKey = $('#api-key')?.value.trim() || '';
  const model = $('#api-model')?.value.trim() || '';
  const baseURL = mode === 'openai-compatible' ? ($('#onboard-base-url')?.value.trim() || '') : '';
  if (!apiKey) { showApiTest('error', '먼저 API 키를 붙여넣어 주세요.'); return; }
  if (mode === 'openai-compatible' && !baseURL) { showApiTest('error', 'base URL을 입력해 주세요.'); return; }
  const btn = $('#api-test-btn'); btn.disabled = true; btn.textContent = '확인 중…';
  showApiTest('pending', '연결을 확인하고 있어요…');
  try {
    const r = await window.agentAPI.apiTest({ brainMode: mode, apiKey, model, baseURL });
    if (r && r.ok) { showApiTest('ok', '✅ 연결됐어요! 다음으로 넘어갈 수 있어요.'); setWiz2Ready(true); }
    else { showApiTest('error', '❌ 연결 실패 — ' + ((r && r.error) || '키를 다시 확인해주세요.')); setWiz2Ready(false); }
  } catch (e) { showApiTest('error', '❌ ' + e.message); setWiz2Ready(false); }
  finally { btn.disabled = false; btn.textContent = '연결 테스트'; }
});

// 키/모델/baseURL 바뀌면 이전 테스트 무효화(재확인 요구)
['#api-key', '#api-model', '#onboard-base-url'].forEach(sel => {
  $(sel)?.addEventListener('input', () => { setWiz2Ready(false); const tr = $('#api-test-result'); if (tr) tr.classList.add('hidden'); });
});

/* ── 온보딩: OpenAI 호환 프리셋 변경 ───────────────────── */
const onboardCompatPreset = $('#onboard-compat-preset');
if (onboardCompatPreset) {
  onboardCompatPreset.addEventListener('change', () => {
    applyCompatPreset(onboardCompatPreset.value, { fillBaseURL: true, ids: ONBOARD_COMPAT_IDS });
    setWiz2Ready(false); const tr = $('#api-test-result'); if (tr) tr.classList.add('hidden'); // 제공자 바뀌면 재테스트
  });
}

/* ── 온보딩: 고급 영역 토글 ─────────────────────────────── */
const toggleAdv = $('#toggle-advanced-brain');
if (toggleAdv) {
  toggleAdv.addEventListener('click', () => {
    const area = $('#advanced-brain-area');
    const arrow = $('#advanced-arrow');
    if (area.classList.contains('hidden')) {
      area.classList.remove('hidden');
      if (arrow) arrow.classList.add('open');
    } else {
      area.classList.add('hidden');
      if (arrow) arrow.classList.remove('open');
      // 고급 숨기면 고급 전용 선택(claude-api·openai-api·openai-compatible)은 기본으로 되돌림
      const checked = document.querySelector('input[name="brain-mode"]:checked');
      if (checked && (checked.value === 'claude-api' || checked.value === 'openai-api' || checked.value === 'openai-compatible')) {
        const defRadio = document.querySelector('input[name="brain-mode"][value="claude-subscription"]');
        if (defRadio) {
          defRadio.checked = true;
          document.querySelectorAll('.brain-card').forEach(c => c.classList.remove('selected'));
          defRadio.closest('.brain-card').classList.add('selected');
        }
        updateApiConfigArea('claude-subscription');
      }
    }
  });
}

/* ── 온보딩: 에이전트 만들기 ─────────────────────────────────── */
const btnCreate = $('#btn-create-agent');
if (btnCreate) {
  btnCreate.addEventListener('click', async () => {
    const name = $('#agent-name').value.trim();
    const persona = DEFAULT_PERSONA;
    const brainMode = document.querySelector('input[name="brain-mode"]:checked')?.value || 'claude-subscription';
    const apiKey = $('#api-key')?.value.trim() || '';
    const model = $('#api-model')?.value.trim() || '';
    const isCompat = brainMode === 'openai-compatible';
    const baseURL = isCompat ? ($('#onboard-base-url')?.value.trim() || '') : '';

    if (!name) {
      alert('에이전트 이름을 지어줘야 해요!');
      $('#agent-name').focus();
      return;
    }

    // 연결(키/구독)은 ②단계에서 이미 검증·통과됨. 여기선 이름만 확인.
    if (isCompat && !baseURL) {
      alert('연결할 제공자의 API base URL이 필요해요. 이전 단계에서 입력해주세요.');
      goWizStep(2);
      return;
    }

    btnCreate.disabled = true;
    btnCreate.textContent = '에이전트 만나러 가는 중...';

    try {
      const agent = await window.agentAPI.saveAgent({
        name,
        persona,
        brainMode,
        apiKey,
        model,
        baseURL,
        speech: 'auto',
        userNickname: '',
      });
      await openChatScreen(agent.id);
    } catch (e) {
      alert('에러: ' + e.message);
    } finally {
      btnCreate.disabled = false;
      btnCreate.textContent = '에이전트 만나러 가기';
    }
  });
}

/* ── 아바타(프로필 사진) 유틸 ─────────────────────────────
   applyAvatar(el, agent) — avatar data URL 있으면 이미지, 없으면 이니셜 폴백.
   대상: .agent-avatar(#sidebar-avatar), .chat-head-av(#chat-head-avatar), .msg-av
   ──────────────────────────────────────────────────────── */
function applyAvatar(el, agent) {
  if (!el) return;
  const dataUrl = agent && agent.avatar;
  if (dataUrl) {
    el.style.backgroundImage = `url("${dataUrl}")`;
    el.classList.add('has-image');
    el.textContent = ''; // 이니셜 텍스트 제거
  } else {
    el.style.backgroundImage = '';
    el.classList.remove('has-image');
    const initial = agent && agent.name ? agent.name.slice(0, 1).toUpperCase() : 'A';
    el.textContent = initial;
  }
}

/**
 * 이미지 파일을 AVATAR_SIZE × AVATAR_SIZE 정사각 크롭 + JPEG 0.85로 변환해 data URL 반환.
 * 원본 중심으로 정사각 잘라낸 뒤 리사이즈 → 파일 크기 최소화.
 */
function cropAndResizeAvatar(file) {
  return new Promise((resolve, reject) => {
    if (file.size > MAX_AVATAR_SRC_MB * 1024 * 1024) {
      return reject(new Error(`파일이 너무 커요. ${MAX_AVATAR_SRC_MB}MB 이하 이미지를 사용해주세요.`));
    }
    const reader = new FileReader();
    reader.onerror = () => reject(new Error('파일 읽기 실패'));
    reader.onload = (ev) => {
      const img = new Image();
      img.onerror = () => reject(new Error('이미지 디코딩 실패'));
      img.onload = () => {
        try {
          const canvas = document.createElement('canvas');
          canvas.width = AVATAR_SIZE;
          canvas.height = AVATAR_SIZE;
          const ctx = canvas.getContext('2d');
          // 정사각 크롭: 짧은 변 기준으로 중심 잘라내기
          const side = Math.min(img.naturalWidth, img.naturalHeight);
          const sx = Math.floor((img.naturalWidth - side) / 2);
          const sy = Math.floor((img.naturalHeight - side) / 2);
          ctx.drawImage(img, sx, sy, side, side, 0, 0, AVATAR_SIZE, AVATAR_SIZE);
          const dataUrl = canvas.toDataURL('image/jpeg', 0.85);
          resolve(dataUrl);
        } catch (e) {
          reject(new Error('캔버스 처리 실패: ' + e.message));
        }
      };
      img.src = ev.target.result;
    };
    reader.readAsDataURL(file);
  });
}

/** 사이드바 두뇌 배지 짧은 이름. openai-compatible은 base URL로 제공자 역추정. */
function brainShortLabel(agent) {
  const m = { 'claude-subscription': 'Claude', 'codex-subscription': 'Codex', 'antigravity-subscription': 'Antigravity', 'gemini-api': 'Gemini', 'claude-api': 'Claude', 'openai-api': 'GPT' };
  if (agent.brainMode === 'openai-compatible') {
    const names = { openrouter: 'OpenRouter', xai: 'Grok', deepseek: 'DeepSeek', mistral: 'Mistral', groq: 'Groq', custom: '기타 모델' };
    return names[presetKeyFromBaseURL(agent.baseURL)] || '기타 모델';
  }
  return m[agent.brainMode] || agent.brainMode;
}
/** 사이드바 두뇌 배지 렌더(모델 변경 시 즉시 갱신용으로 분리). */
function renderSidebarBrain(agent) {
  const el = $('#sidebar-mode');
  if (el) el.innerHTML = `<span class="brain-dot"></span>${escHtml(brainShortLabel(agent))}`;
}

/* ── 대화 화면 열기 ───────────────────────────────────── */
async function openChatScreen(agentId, suppressSmokeReady = false) {
  const agent = await window.agentAPI.loadAgent(agentId);
  if (!agent) return;
  currentAgent = agent;
  pendingAttachments = [];
  renderAttachPreview();

  // 사이드바 채우기 — 원형 아바타(이미지 또는 이니셜), 짧은 두뇌명
  applyAvatar($('#sidebar-avatar'), agent);
  $('#sidebar-name').textContent = agent.name;
  // 두뇌 배지(시안처럼 간결: "Gemini" 등) — 헬퍼로 분리(모델 변경 시 저장 핸들러도 재사용)
  renderSidebarBrain(agent);
  // 대화 영역 상단 헤더(연결 상태 옆)도 채움
  applyAvatar($('#chat-head-avatar'), agent);
  const headName = $('#chat-head-name');
  if (headName) headName.textContent = agent.name;
  // 입력창 placeholder: 시안처럼 "○○에게 메시지 보내기…"
  const chatInputEl = $('#chat-input');
  if (chatInputEl) chatInputEl.placeholder = `${agent.name}에게 메시지 보내기…`;
  $('#memory-persona').textContent = agent.persona;

  renderFacts(agent.humanFacts || []);

  // L1: 작업 기억 섹션 렌더링
  try {
    const w = await window.agentAPI.getWork(agentId);
    if (w && w.work) { if (!currentAgent.work) currentAgent.work = w.work; renderWork(w.work); }
  } catch(_) {}

  // 대화 이력 로드
  const messages = await window.agentAPI.loadConversation(agentId);
  const messagesEl = $('#chat-messages');
  messagesEl.innerHTML = '';
  // 이전 대화에서 붙었던 아카이브 스크롤 리스너 제거(컨테이너는 재사용됨 → 누적 방지).
  if (messagesEl._archiveHandler) { messagesEl.removeEventListener('scroll', messagesEl._archiveHandler); messagesEl._archiveHandler = null; }

  if (messages.length === 0) {
    messagesEl.innerHTML = `<div class="chat-welcome"><p id="welcome-text">${escHtml(agent.name)}와 대화를 시작해보세요.<br>쓸수록 더 잘 알게 됩니다!</p></div>`;
  } else {
    messages.forEach(m => {
      const d = appendMessage(m.role, m.content, false, m.ts || m.timestamp || null, { error: m.error });
      if (m.files && m.files.length) renderFileCards(d, m.files); // 기록에 저장된 파일 카드 복원(썸네일은 아이콘으로)
    });
    // 압축으로 접힌 옛 대화가 있으면 맨 위에 "이전 대화 더 보기" 배너(요약만 남고 원문을 못 보던 문제 해결).
    try {
      // ★2026-07-16: 전량이 아니라 페이지 단위(뒤에서부터 50개씩) — 수만 개 쌓인 사용자도 화면이 안 멈추게.
      const page = await window.agentAPI.loadArchive(agentId, { offset: 0, limit: ARCHIVE_PAGE });
      if (page && page.messages && page.messages.length) renderArchiveBanner(messagesEl, agentId, page);
    } catch (_) {}
  }

  showScreen('screen-chat');
  // 화면을 먼저 활성화(display)해야 scrollHeight가 정확. 레이아웃·이미지 반영 위해 다음 프레임에 한 번 더.
  scrollToBottom();
  requestAnimationFrame(() => scrollToBottom());

  // smoke 모드: 화면 렌더링 완료를 메인에 알림 (settings 타깃이면 억제)
  if (!suppressSmokeReady) {
    try {
      if (window.agentAPI && window.agentAPI.smokeReady) {
        await new Promise(r => setTimeout(r, 200));
        window.agentAPI.smokeReady();
      }
    } catch (_) {}
  }
}

// smoke 모드에서 전역 함수로 노출
window.showChatScreen = openChatScreen;

/* ── 기억 렌더링 (대화 화면용) ─────────────────────────── */
function renderFacts(facts) {
  const list = $('#memory-facts');
  const countEl = $('#fact-count');
  if (!list) return;

  if (facts.length === 0) {
    list.innerHTML = '<li class="fact-empty">아직 없음. 대화를 나눠보세요!</li>';
  } else {
    list.innerHTML = facts.map(f =>
      `<li><span class="fact-label">${escHtml(f.label)}</span><span class="fact-value">${escHtml(f.value)}</span></li>`
    ).join('');
  }
  if (countEl) countEl.textContent = facts.length;
}

/* ── 타임스탬프 한국어 포맷 ("오전/오후 H:MM") ───────────── */
function formatTs(ts) {
  const d = ts ? new Date(ts) : null;
  if (!d || isNaN(d.getTime())) return '';
  let h = d.getHours();
  const m = String(d.getMinutes()).padStart(2, '0');
  const ampm = h < 12 ? '오전' : '오후';
  h = h % 12; if (h === 0) h = 12;
  return `${ampm} ${h}:${m}`;
}

/* ── 메시지 추가 ──────────────────────────────────────────
   시안(chat-dark.html) 구조에 맞춤:
   에이전트 = [원형 아바타] + [본문(말풍선 + 타임스탬프)]
   사용자  = [본문(말풍선 + 타임스탬프)]  (아바타·이름 라벨 없음)
   ※ 호환 보존: 반환 div에서 .querySelector('.bubble') 동작,
     msgDiv.appendChild(hint) 가능, 🔊 버튼 동작, 스트리밍 누적 유지. */
// 파일 카드 렌더(실시간 응답·기록 로드 공통). sf.dataUrl 있으면 썸네일, 없으면 아이콘.
function renderFileCards(msgDiv, files) {
  if (!msgDiv || !files || !files.length) return;
  // 카드는 말풍선 본문(msg-body) 안, 버블 아래에 세로로. (message는 가로 flex라 여기 안 넣으면 옆으로 붙음)
  const container = msgDiv.querySelector('.msg-body') || msgDiv;
  for (const sf of files) {
    const s = sf.size || 0;
    const sizeStr = s ? (s < 1024 ? s + 'B' : s < 1048576 ? (s / 1024).toFixed(0) + 'KB' : (s / 1048576).toFixed(1) + 'MB') : '';
    const sub = [sizeStr, sf.note ? escHtml(sf.note) : ''].filter(Boolean).join(' · ');
    const hasPath = !!sf.path; // 저장 전(사용자 첨부 즉시 표시)엔 경로 없음 → 버튼 비활성
    const card = document.createElement('div');
    card.className = 'file-card';
    card.innerHTML =
      (sf.dataUrl ? `<img class="file-thumb" src="${sf.dataUrl}" alt="">` : `<div class="file-icon">${sf.isImage ? '🖼️' : '📄'}</div>`)
      + `<div class="file-meta">`
      + `<div class="file-name">${escHtml(sf.name)}</div>`
      + (sub ? `<div class="file-sub">${sub}</div>` : '')
      + `<div class="file-actions">`
      + (hasPath ? `<button class="fc-open">열기</button><button class="fc-dl">다운로드</button>` : `<span class="fc-pending">저장 중…</span>`)
      + `</div></div>`;
    container.appendChild(card);
    // 재실행 후 미리보기 복원: 이미지인데 dataUrl이 없으면(대화 JSON엔 base64 미저장) 저장 파일에서 썸네일 지연 로드.
    if (hasPath && sf.isImage && !sf.dataUrl && window.agentAPI.getFilePreview) {
      window.agentAPI.getFilePreview(sf.path).then(r => {
        if (!r || !r.ok || !r.dataUrl) return;
        const icon = card.querySelector('.file-icon');
        if (!icon) return;
        const img = document.createElement('img');
        img.className = 'file-thumb'; img.src = r.dataUrl; img.alt = '';
        img.addEventListener('click', () => window.agentAPI.openFile(sf.path));
        icon.replaceWith(img);
      }).catch(() => {});
    }
    if (hasPath) {
      card.querySelector('.fc-open').addEventListener('click', () => window.agentAPI.openFile(sf.path));
      if (sf.dataUrl) card.querySelector('.file-thumb').addEventListener('click', () => window.agentAPI.openFile(sf.path));
      card.querySelector('.fc-dl').addEventListener('click', async (ev) => {
        const b = ev.target, orig = b.textContent; b.disabled = true; b.textContent = '저장 중…';
        const r = await window.agentAPI.downloadFile(sf.path, sf.name);
        if (r && r.ok) { b.textContent = '저장됨 ✓'; }
        else if (r && r.canceled) { b.textContent = orig; b.disabled = false; }
        else { b.textContent = '실패'; setTimeout(() => { b.textContent = orig; b.disabled = false; }, 1500); }
      });
    }
  }
}

/**
 * 경량 마크다운 → 안전한 HTML. 채팅 버블용(에이전트 메시지). 의존성 0.
 * 보안: (1)HTML 먼저 이스케이프 → 사용자/에이전트 원문의 <script> 등 무력화
 *       (2)생성 태그는 화이트리스트만(strong/em/a/ul/ol/li/table/…), 링크는 http(s)·mailto만 허용.
 * 지원: 코드블록/인라인코드, 표, 순서·비순서 목록, 인용, 굵게/기울임, 링크, 헤딩(#), 문단.
 */
function renderMarkdown(src) {
  const esc = t => String(t).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const M = String.fromCharCode(57344); // 플레이스홀더 마커(U+E000 사설영역 — 텍스트 숫자와 충돌 방지)
  const reF = new RegExp('^' + M + 'F(\\d+)' + M + '$');
  let s = String(src == null ? '' : src);
  const fences = [];
  s = s.replace(/```[a-zA-Z0-9]*\n?([\s\S]*?)```/g, (m, c) => { fences.push('<div class="md-pre-wrap"><pre class="md-pre"><code>' + esc(c.replace(/\n$/, '')) + '</code></pre><button class="copy-btn" title="복사">복사</button></div>'); return M + 'F' + (fences.length - 1) + M; });
  const inline = (raw) => {
    const ic = [];
    let t = String(raw).replace(/`([^`]+)`/g, (m, c) => { ic.push('<code class="md-code">' + esc(c) + '</code>'); return M + 'C' + (ic.length - 1) + M; });
    t = esc(t);
    t = t.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+|mailto:[^\s)]+)\)/g, (m, txt, url) => '<a href="' + url.replace(/"/g, '%22') + '" target="_blank" rel="noopener">' + txt + '</a>');
    // 남은 bare URL(예: 인증 링크) 자동 링크 + 복사 버튼. 이미 href="..."/링크텍스트 안의 URL은 앞 문자(" ' > ])로 제외.
    t = t.replace(/(^|[^"'>\]])(https?:\/\/[^\s<)]+)/g, (m, pre, url) => pre + '<span class="url-wrap"><a href="' + url.replace(/"/g, '%22') + '" target="_blank" rel="noopener">' + url + '</a><button class="copy-btn" title="링크 복사">복사</button></span>');
    t = t.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>').replace(/__([^_]+)__/g, '<strong>$1</strong>');
    t = t.replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<em>$2</em>');
    t = t.replace(new RegExp(M + 'C(\\d+)' + M, 'g'), (m, n) => ic[+n]);
    return t;
  };
  const lines = s.split(/\r?\n/);
  const out = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    const fm = line.trim().match(reF);
    if (fm) { out.push(fences[+fm[1]]); i++; continue; }
    if (/^\s*\|.*\|\s*$/.test(line) && i + 1 < lines.length && /^\s*\|?[\s:|-]+\|?\s*$/.test(lines[i + 1]) && lines[i + 1].includes('-')) {
      const cells = l => l.trim().replace(/^\||\|$/g, '').split('|').map(c => c.trim());
      const header = cells(line); i += 2;
      const rows = [];
      while (i < lines.length && /^\s*\|.*\|\s*$/.test(lines[i])) { rows.push(cells(lines[i])); i++; }
      let tb = '<table class="md-table"><thead><tr>' + header.map(h => '<th>' + inline(h) + '</th>').join('') + '</tr></thead><tbody>';
      for (const r of rows) tb += '<tr>' + r.map(c => '<td>' + inline(c) + '</td>').join('') + '</tr>';
      out.push(tb + '</tbody></table>'); continue;
    }
    if (/^\s*>\s?/.test(line)) { const buf = []; while (i < lines.length && /^\s*>\s?/.test(lines[i])) { buf.push(lines[i].replace(/^\s*>\s?/, '')); i++; } out.push('<blockquote class="md-quote">' + buf.map(inline).join('<br>') + '</blockquote>'); continue; }
    if (/^\s*[-*]\s+/.test(line)) { const buf = []; while (i < lines.length && /^\s*[-*]\s+/.test(lines[i])) { buf.push(lines[i].replace(/^\s*[-*]\s+/, '')); i++; } out.push('<ul class="md-list">' + buf.map(x => '<li>' + inline(x) + '</li>').join('') + '</ul>'); continue; }
    if (/^\s*\d+\.\s+/.test(line)) { const buf = []; while (i < lines.length && /^\s*\d+\.\s+/.test(lines[i])) { buf.push(lines[i].replace(/^\s*\d+\.\s+/, '')); i++; } out.push('<ol class="md-list">' + buf.map(x => '<li>' + inline(x) + '</li>').join('') + '</ol>'); continue; }
    const h = line.match(/^\s*(#{1,3})\s+(.*)$/);
    if (h) { out.push('<div class="md-h md-h' + h[1].length + '">' + inline(h[2]) + '</div>'); i++; continue; }
    if (line.trim() === '') { i++; continue; }
    const buf = [line]; i++;
    while (i < lines.length && lines[i].trim() !== '' && !/^\s*([-*]|\d+\.)\s+/.test(lines[i]) && !/^\s*>/.test(lines[i]) && !/^\s*\|.*\|\s*$/.test(lines[i]) && !/^\s*#{1,3}\s/.test(lines[i]) && !reF.test(lines[i].trim())) { buf.push(lines[i]); i++; }
    out.push('<div class="md-p">' + buf.map(inline).join('<br>') + '</div>');  // 줄마다 먼저 inline(esc 포함) → 진짜 <br>로 이음(esc가 <br>을 글자로 만들지 않게)
  }
  return out.join('');
}

function appendMessage(role, content, animate = true, ts = null, opts = {}) {
  const messagesEl = $('#chat-messages');
  const welcome = messagesEl.querySelector('.chat-welcome');
  if (welcome) welcome.remove();

  const div = document.createElement('div');
  div.className = `message ${role}` + (opts.error ? ' error' : ''); // 실패 마커(error:true)는 눅은 스타일

  // 에이전트 메시지엔 말풍선 왼쪽에 작은 원형 아바타(시안). 사용자엔 없음.
  if (role === 'agent') {
    const av = document.createElement('div');
    av.className = 'msg-av';
    applyAvatar(av, currentAgent);
    div.appendChild(av);
  }

  // 본문 래퍼(말풍선 + 타임스탬프)
  const body = document.createElement('div');
  body.className = 'msg-body';

  const bubble = document.createElement('div');
  bubble.className = 'bubble';
  if (role === 'agent' && content) bubble.innerHTML = renderMarkdown(content);
  else bubble.textContent = content;
  body.appendChild(bubble);

  // 타임스탬프: 있으면 말풍선 아래에 표시(에이전트=왼쪽, 사용자=오른쪽). 없으면 생략.
  const tsText = formatTs(ts);
  if (tsText) {
    const tsEl = document.createElement('span');
    tsEl.className = 'ts';
    tsEl.textContent = tsText;
    body.appendChild(tsEl);
  }

  div.appendChild(body);
  if (opts.prependBefore) {
    messagesEl.insertBefore(div, opts.prependBefore); // 아카이브 되살리기 등 위쪽 삽입(스크롤 이동 없음)
  } else {
    messagesEl.appendChild(div);
    if (animate) scrollToBottom();
  }
  return div;
}

/** 압축으로 접힌 옛 대화가 있으면 위로 스크롤할 때 자동으로 원본을 되살려 앞에 붙인다. */
// ★2026-07-22: 클릭 배너 → 스크롤 자동 로드로 교체(합의했던 "위로 올리면 이전 대화가 나온다").
//   상단 근처(<160px)에 닿으면 다음 페이지(ARCHIVE_PAGE개)를 자동으로 불러온다. 전부 붙이면
//   오래 쓴 사용자(수만 개)는 화면이 멈추므로 페이지 단위 유지. 로딩 중엔 얇은 힌트만 보인다.
function renderArchiveBanner(messagesEl, agentId, firstPage) {
  let pending = firstPage.messages || [];   // 아직 DOM에 안 붙인, 이미 받아둔 페이지
  let remaining = firstPage.remaining || 0; // 그보다 더 앞에 남은 개수
  let loaded = 0;                           // 뒤에서부터 지금까지 불러온 개수
  let loading = false;

  const IDLE = '⌃ 위로 올리면 이전 대화가 더 나타납니다';
  const hint = document.createElement('div');
  hint.className = 'archive-hint';
  hint.textContent = IDLE;
  messagesEl.insertBefore(hint, messagesEl.firstChild);

  async function loadMore() {
    if (loading) return;
    if (!pending.length && !remaining) return;  // 더 없음
    loading = true;
    try {
      // 1) 이미 받아둔 페이지를 앞에 붙인다(스크롤 위치 보정으로 보던 지점 유지).
      if (pending.length) {
        const prevH = messagesEl.scrollHeight, prevTop = messagesEl.scrollTop;
        pending.forEach(m => {
          const d = appendMessage(m.role, m.content, false, m.ts || m.timestamp || null, { error: m.error, prependBefore: hint });
          if (m.files && m.files.length) renderFileCards(d, m.files);
        });
        loaded += pending.length;
        pending = [];
        messagesEl.scrollTop = prevTop + (messagesEl.scrollHeight - prevH);
      }
      // 2) 다음 페이지를 미리 받아 pending에 채워둔다(다음 스크롤에 바로 붙게).
      if (remaining) {
        hint.textContent = '이전 대화 불러오는 중…';
        const p = await window.agentAPI.loadArchive(agentId, { offset: loaded, limit: ARCHIVE_PAGE });
        if (p && p.messages && p.messages.length) { pending = p.messages; remaining = p.remaining || 0; hint.textContent = IDLE; }
        else { remaining = 0; }
      }
      if (!pending.length && !remaining) { cleanup(); hint.remove(); }  // 다 불러옴
    } catch (_) {
      hint.textContent = '⌃ 이전 대화 불러오기 실패 — 다시 위로 올려보세요';
    } finally {
      loading = false;
    }
  }

  function onScroll() { if (messagesEl.scrollTop < 160) loadMore(); }
  function cleanup() {
    if (messagesEl._archiveHandler) { messagesEl.removeEventListener('scroll', messagesEl._archiveHandler); messagesEl._archiveHandler = null; }
  }
  // 대화 전환 시 리스너가 쌓이지 않게 이전 것 먼저 제거(컨테이너는 재사용되므로).
  cleanup();
  messagesEl._archiveHandler = onScroll;
  messagesEl.addEventListener('scroll', onScroll);
}

/* ── 타이핑 인디케이터 ────────────────────────────────── */
function showTyping() {
  const messagesEl = $('#chat-messages');
  const div = document.createElement('div');
  div.className = 'message agent';
  div.id = 'typing-indicator';
  const isClaudeBrain = currentAgent?.brainMode === 'claude-subscription';
  // 아바타: innerHTML 대신 DOM 조작으로 applyAvatar 적용
  const avEl = document.createElement('div');
  avEl.className = 'msg-av';
  applyAvatar(avEl, currentAgent);
  const bodyEl = document.createElement('div');
  bodyEl.className = 'msg-body';
  bodyEl.innerHTML = `<div class="bubble ${isClaudeBrain ? 'thinking-indicator' : 'typing-indicator'}">${
    isClaudeBrain
      ? '<span class="thinking-text">에이전트가 생각 중…</span>'
      : '<div class="typing-dot"></div><div class="typing-dot"></div><div class="typing-dot"></div><span class="thinking-text"></span>'
  }</div>`;
  div.appendChild(avEl);
  div.appendChild(bodyEl);
  messagesEl.appendChild(div);
  scrollToBottom();
}

function hideTyping() {
  const el = document.getElementById('typing-indicator');
  if (el) el.remove();
}

/* ── 메시지 전송 ──────────────────────────────────────── */
/* ── 생성 중 정지 (정지 버튼 / ESC) ─────────────────────── */
// 전송 버튼(↑)은 생성 중 정지 버튼(■)으로 바뀐다. 클릭 또는 ESC 로 진행 중 응답을 멈춘다.
function setGenerating(on, agentId) {
  _generating = !!on;
  _stopAgentId = on ? agentId : null;
  const btn = $('#btn-send');
  if (!btn) return;
  btn.disabled = false;
  if (on) { btn.classList.add('is-stop'); btn.textContent = ''; btn.title = '중지 (Esc)'; } // 네모는 CSS ::before 로 그림
  else { btn.classList.remove('is-stop'); btn.textContent = '↑'; btn.title = ''; }
}
function requestStop() {
  if (!_generating || !_stopAgentId) return;
  try { window.agentAPI.stopChat(_stopAgentId); } catch (_) {}
  clearQueue(); // 정지 = 진행 중 답변 + 대기 중 후속까지 모두 취소
  const btn = $('#btn-send'); if (btn) { btn.disabled = true; btn.textContent = '…'; } // 결과 확정까지 중복클릭 방지
}

/* ── 생성 중 후속 메시지 큐잉 ─────────────────────────────── */
// 생성 중 Enter 로 보낸 메시지는 대기열에 쌓였다가, 현재 답변이 끝나면 순서대로 처리된다.
function queueMessage(text, atts) {
  const strip = $('#queued-strip');
  const item = { text, atts };
  if (strip) {
    const pill = document.createElement('div');
    pill.className = 'queued-pill';
    const tag = document.createElement('span');
    tag.className = 'queued-tag'; tag.textContent = '⏳ 대기 중';
    const label = document.createElement('span');
    label.className = 'queued-text';
    label.textContent = text || (atts.length ? `첨부 ${atts.length}개` : '');
    const x = document.createElement('button');
    x.className = 'queued-x'; x.textContent = '×'; x.title = '대기 취소';
    x.addEventListener('click', () => {
      const i = _queue.indexOf(item);
      if (i >= 0) _queue.splice(i, 1);
      pill.remove();
      if (!_queue.length) strip.classList.add('hidden');
    });
    pill.appendChild(tag); pill.appendChild(label); pill.appendChild(x);
    strip.appendChild(pill);
    strip.classList.remove('hidden');
    item.el = pill;
  }
  _queue.push(item);
}
function clearQueue() {
  _queue = [];
  const strip = $('#queued-strip');
  if (strip) { strip.innerHTML = ''; strip.classList.add('hidden'); }
}
// 현재 턴 종료 후 호출 — 대기열 맨 앞을 이어서 보낸다.
function drainQueue() {
  if (!_queue.length || _generating) return;
  const item = _queue.shift();
  if (item.el) item.el.remove();
  if (!_queue.length) { const strip = $('#queued-strip'); if (strip) strip.classList.add('hidden'); }
  sendMessage(item.text, item.atts);
}

async function sendMessage(qText, qAtts) {
  const fromQueue = (qText !== undefined);
  const input = $('#chat-input');
  const text = fromQueue ? qText : input.value.trim();
  const atts = fromQueue ? (qAtts || []) : pendingAttachments.slice();
  if ((!text && atts.length === 0) || !currentAgent) return;

  // 생성 중 새 입력(큐 아님)은 대기열에 쌓고 종료 — 현재 답변이 끝나면 이어서 처리.
  if (_generating && !fromQueue) {
    queueMessage(text, atts);
    input.value = ''; autoResize(input); clearAttachments();
    return;
  }

  if (!fromQueue) { input.value = ''; autoResize(input); }
  setGenerating(true, currentAgent.id);

  // 첨부는 아래 카드로 표시하므로 버블 텍스트엔 넣지 않음(text만)
  const userMsgDiv = appendMessage('user', text, true, Date.now());
  // 보낸 즉시 사용자 버블에 파일 카드 표시(임시 — 경로/버튼은 응답 후 활성). 이미지는 썸네일 바로.
  if (atts.length) {
    renderFileCards(userMsgDiv, atts.map(a => {
      const isImg = /\.(png|jpe?g|gif|webp)$/i.test(a.name || '');
      return { name: a.name, size: a.size || (a.data ? Math.floor(a.data.length * 0.75) : 0), isImage: isImg, dataUrl: (isImg && a.data) ? `data:${a.mimeType || 'image/jpeg'};base64,${a.data}` : undefined };
    }));
  }
  if (!fromQueue) clearAttachments(); // 큐 처리 중엔 현재 작성 중인 첨부를 건드리지 않는다
  _chatStatusText = '';
  showTyping();

  // ── 살아있음 표시 ─────────────────────────────────────────────────────
  // 긴 작업(도구 사용 등)으로 화면이 잠잠할 때 "멈춘 건지 도는 건지" 불안을 없앤다.
  //  · 첫 토큰 전: "생각 중… N초"  · 스트리밍 중 잠잠(도구 작업): "작업 중… N초 경과"
  let streamDiv = null, streamBubble = null, streamed = '';
  const startedAt = Date.now();
  let lastDelta = startedAt, workEl = null;
  const aliveTimer = setInterval(() => {
    const sec = Math.floor((Date.now() - startedAt) / 1000);
    const tEl = document.querySelector('#typing-indicator .thinking-text');
    if (tEl) {                                   // 아직 첫 토큰 전 — "받는 중" 안내 있으면 그걸, 없으면 경과시간
      tEl.textContent = _chatStatusText
        ? _chatStatusText
        : (currentAgent?.brainMode === 'claude-subscription'
          ? `에이전트가 생각 중… ${sec}초`
          : (sec >= 2 ? `${sec}초` : ''));       // 빠른 두뇌는 2초 넘을 때만 표시(깜빡임 방지)
    } else if (streamDiv) {                       // 스트리밍 시작 후 잠잠하면(도구 작업 등) 살아있음 표시
      if (_chatStatusText || Date.now() - lastDelta > 3000) {
        if (!workEl) { workEl = document.createElement('div'); workEl.className = 'work-pulse'; streamDiv.querySelector('.msg-body').appendChild(workEl); }
        workEl.textContent = _chatStatusText || `작업 중… ${sec}초 경과`;
        scrollToBottom();
      } else if (workEl) { workEl.remove(); workEl = null; }
    }
  }, 1000);

  // 스트리밍 수신: 첫 청크가 오면 타이핑 표시 지우고 실시간 버블에 누적
  const offStream = window.agentAPI.onChatStream((data) => {
    if (!data || data.delta == null) return;
    lastDelta = Date.now();                       // 활동 감지 → 작업중 맥동 해제
    if (workEl) { workEl.remove(); workEl = null; }
    if (!streamDiv) {
      hideTyping();
      streamDiv = appendMessage('agent', '', true, Date.now());
      streamBubble = streamDiv.querySelector('.bubble');
    }
    streamed += data.delta;
    streamBubble.textContent = streamed;
    scrollToBottom();
  });

  try {
    const result = await window.agentAPI.sendMessage(currentAgent.id, text, atts.map(a => ({ mimeType: a.mimeType, data: a.data, name: a.name })));
    hideTyping();

    // 정지됨: 스트리밍된 부분 답변을 그대로 확정한다(첫 토큰 전 정지면 답 없이 사용자 메시지만 남음).
    if (result.stopped) {
      if (streamDiv && streamBubble) {
        streamBubble.innerHTML = renderMarkdown(streamed) + '<span class="stopped-tag">· 중지됨</span>';
      }
      return; // finally 에서 버튼 복구
    }

    // 사용자 첨부: 보낼 때 그린 임시 카드(경로 없음)를 응답 후 경로 포함 카드로 교체(열기/다운로드 활성).
    if (result.userFiles && result.userFiles.length) {
      userMsgDiv.querySelectorAll('.file-card').forEach(c => c.remove());
      renderFileCards(userMsgDiv, result.userFiles);
    }

    if (result.error) {
      if (streamBubble) streamBubble.textContent = '(오류: ' + result.error + ')';
      else appendMessage('agent', '(오류: ' + result.error + ')');
    } else {
      // 스트리밍 버블이 있으면 최종 응답으로 확정(누락 방어), 없으면 일괄 출력
      let msgDiv;
      if (streamDiv) { streamBubble.innerHTML = renderMarkdown(result.response); msgDiv = streamDiv; }
      else { msgDiv = appendMessage('agent', result.response, true, Date.now()); }


      // 정직 계층 ③: 도구 배지 상시표시 제거(마스터 결정). 근거는 사용자가 물으면 on-demand 로 답한다.
      // 에이전트가 보낸 파일(send_file) — 메신저식 파일 카드(썸네일/아이콘 + 열기·다운로드)
      if (result.sentFiles && result.sentFiles.length) renderFileCards(msgDiv, result.sentFiles);
      currentAgent.humanFacts = result.humanFacts;
      renderFacts(result.humanFacts);
    }
  } catch (e) {
    hideTyping();
    if (streamBubble) streamBubble.textContent = '오류가 발생했습니다: ' + e.message;
    else appendMessage('agent', '오류가 발생했습니다: ' + e.message);
  } finally {
    clearInterval(aliveTimer);
    if (workEl) { workEl.remove(); workEl = null; }
    offStream();
    setGenerating(false);
    scrollToBottom();
    drainQueue(); // 대기열에 후속 메시지가 있으면 이어서 처리
  }
}

/* ── 대화 화면: 이벤트 ───────────────────────────────── */
const btnSend = $('#btn-send');
if (btnSend) btnSend.addEventListener('click', () => { if (_generating) requestStop(); else sendMessage(); });

const chatInput = $('#chat-input');
if (chatInput) {
  chatInput.addEventListener('keydown', (e) => {
    // 한글 등 IME 조합 중 Enter: 조합 확정용 키라 전송하면 안 됨(macOS에서 마지막 글자가
    // 전송 후 입력창에 한 번 더 커밋되는 중복 버그). keyCode 229 = 구형 크로미움 폴백.
    if (e.isComposing || e.keyCode === 229) return;
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      sendMessage();
    }
  });
  chatInput.addEventListener('input', () => autoResize(chatInput));
  // 붙여넣기(스크린샷·이미지): 클립보드에 파일이 있으면 첨부로 받는다. 텍스트만이면 그대로 둔다.
  chatInput.addEventListener('paste', async (e) => {
    const items = (e.clipboardData && e.clipboardData.items) ? Array.from(e.clipboardData.items) : [];
    const files = items.filter(it => it.kind === 'file').map(it => it.getAsFile()).filter(Boolean);
    if (!files.length) return; // 이미지/파일 없음 → 일반 텍스트 붙여넣기 그대로
    e.preventDefault(); // 이미지가 입력창에 텍스트로 들어가지 않게
    if (!currentAgent || !canAttachFiles(currentAgent.brainMode)) {
      alert('이 AI 모델은 파일 첨부를 아직 지원하지 않아요. (Gemini·Claude·GPT, 그리고 Claude 구독에서 지원)');
      return;
    }
    for (const file of files) {
      if (file.size > MAX_ATTACH_MB * 1024 * 1024) { alert(`붙여넣은 파일이 ${MAX_ATTACH_MB}MB를 넘어 건너뜁니다.`); continue; }
      try {
        const data = await fileToBase64(file);
        const ext = (file.type && file.type.split('/')[1]) || 'png';
        const name = (file.name && file.name !== 'image.png') ? file.name : `붙여넣기-${Date.now()}.${ext}`;
        pendingAttachments.push({ mimeType: file.type || 'application/octet-stream', data, name, size: file.size });
      } catch (_) { alert('붙여넣은 이미지를 읽지 못했어요.'); }
    }
    renderAttachPreview();
  });
}

// 복사 버튼(코드블록·링크) — 위임 핸들러. 같은 래퍼 안의 code/a 텍스트를 클립보드로.
document.addEventListener('click', async (e) => {
  const btn = e.target && e.target.closest && e.target.closest('.copy-btn');
  if (!btn) return;
  const wrap = btn.closest('.md-pre-wrap, .url-wrap');
  const el = wrap && wrap.querySelector('code, a');
  const text = el ? el.textContent : '';
  if (!text) return;
  try {
    await navigator.clipboard.writeText(text);
    const prev = btn.textContent; btn.textContent = '복사됨'; btn.classList.add('copied');
    setTimeout(() => { btn.textContent = prev; btn.classList.remove('copied'); }, 1200);
  } catch (_) {}
});

/* ── 첨부(이미지·PDF) ────────────────────────────────── */
function clearAttachments() {
  pendingAttachments = [];
  renderAttachPreview();
}
function renderAttachPreview() {
  const box = $('#attach-preview');
  if (!box) return;
  if (pendingAttachments.length === 0) { box.classList.add('hidden'); box.innerHTML = ''; return; }
  box.classList.remove('hidden');
  box.innerHTML = pendingAttachments.map((a, i) =>
    `<span class="attach-chip">${a.mimeType && a.mimeType.startsWith('image/') ? '🖼️' : (a.mimeType === 'application/pdf' ? '📄' : '📎')} ${escHtml(a.name)} <button data-i="${i}" class="attach-remove" title="제거">✕</button></span>`
  ).join('');
  box.querySelectorAll('.attach-remove').forEach(btn => {
    btn.addEventListener('click', () => { pendingAttachments.splice(parseInt(btn.dataset.i, 10), 1); renderAttachPreview(); });
  });
}
function fileToBase64(file) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).split(',')[1] || ''); // data:...;base64,XXXX → XXXX
    r.onerror = reject;
    r.readAsDataURL(file);
  });
}
// 파일 첨부 가능 두뇌: API 멀티모달 4종(inline_data) + 구독 3종(CLI가 이미지 파일을 직접 읽어 봄).
// claude(native Read)·codex(read-only 파일읽기)는 실측 확증. antigravity는 동일 패턴이나 CLI 미설치로 미검증.
const _SUB_VISION = new Set(['claude-subscription', 'codex-subscription', 'antigravity-subscription']);
function canAttachFiles(brainMode) {
  const meta = BRAIN_META[brainMode];
  return !!(meta && meta.multimodal) || _SUB_VISION.has(brainMode);
}
const btnAttach = $('#btn-attach');
const attachInput = $('#attach-input');
if (btnAttach && attachInput) {
  btnAttach.addEventListener('click', () => {
    if (!currentAgent || !canAttachFiles(currentAgent.brainMode)) {
      alert('이 AI 모델은 파일 첨부를 아직 지원하지 않아요. (Gemini·Claude·GPT, 그리고 Claude 구독에서 지원)');
      return;
    }
    attachInput.click();
  });
  attachInput.addEventListener('change', async () => {
    for (const file of Array.from(attachInput.files || [])) {
      if (file.size > MAX_ATTACH_MB * 1024 * 1024) { alert(`${file.name}: ${MAX_ATTACH_MB}MB를 넘어 건너뜁니다.`); continue; }
      try {
        const data = await fileToBase64(file);
        pendingAttachments.push({ mimeType: file.type || 'application/octet-stream', data, name: file.name, size: file.size });
      } catch (_) { alert(`${file.name}: 읽기 실패`); }
    }
    attachInput.value = '';
    renderAttachPreview();
  });
}

/* ── 드래그드롭 첨부 (데스크톱) ─────────────────────────── */
// 파일을 채팅 화면에 끌어다 놓으면 첨부한다(+ 버튼·붙여넣기와 동일 경로 재사용).
// ⚠️ 안전 가드: 드롭 핸들러가 없으면 Electron 이 떨어진 파일로 창을 이동(navigate)해 앱이 깨진다.
//   → 파일 드롭은 창 어디에 떨어져도 기본동작(navigate)을 막는다. 파일이 아닌 드래그(텍스트 등)는 건드리지 않는다.
function _dragHasFiles(e) {
  return !!(e.dataTransfer && Array.from(e.dataTransfer.types || []).includes('Files'));
}
async function addDroppedFiles(fileList) {
  const files = Array.from(fileList || []);
  if (!files.length) return;
  if (!currentAgent || !canAttachFiles(currentAgent.brainMode)) {
    alert('이 AI 모델은 파일 첨부를 아직 지원하지 않아요. (Gemini·Claude·GPT, 그리고 Claude 구독에서 지원)');
    return;
  }
  for (const file of files) {
    if (file.size > MAX_ATTACH_MB * 1024 * 1024) { alert(`${file.name}: ${MAX_ATTACH_MB}MB를 넘어 건너뜁니다.`); continue; }
    try {
      const data = await fileToBase64(file);
      pendingAttachments.push({ mimeType: file.type || 'application/octet-stream', data, name: file.name, size: file.size });
    } catch (_) { alert(`${file.name}: 읽기 실패`); }
  }
  renderAttachPreview();
}
// 창 전체: 파일 드롭의 기본동작(navigate) 차단 — 드롭존 밖에 떨어져도 앱이 안 깨지게.
window.addEventListener('dragover', (e) => { if (_dragHasFiles(e)) e.preventDefault(); });
window.addEventListener('drop', (e) => { if (_dragHasFiles(e)) e.preventDefault(); });
// 채팅 화면 드롭존: 파일 드롭 → 첨부 + 드래그 중 하이라이트.
(() => {
  const dz = $('#screen-chat');
  if (!dz) return;
  let depth = 0; // dragenter/leave 가 자식 위에서도 튀므로 깊이 카운트로 안정화(깜빡임 방지)
  dz.addEventListener('dragenter', (e) => { if (!_dragHasFiles(e)) return; depth++; dz.classList.add('drag-over'); });
  dz.addEventListener('dragover', (e) => { if (_dragHasFiles(e)) e.preventDefault(); });
  dz.addEventListener('dragleave', (e) => { if (!_dragHasFiles(e)) return; depth = Math.max(0, depth - 1); if (depth === 0) dz.classList.remove('drag-over'); });
  dz.addEventListener('drop', (e) => {
    if (!_dragHasFiles(e)) return;
    e.preventDefault();
    depth = 0; dz.classList.remove('drag-over');
    addDroppedFiles(e.dataTransfer.files);
  });
})();

const btnExport = $('#btn-export');
if (btnExport) {
  btnExport.addEventListener('click', async () => {
    if (!currentAgent) return;
    btnExport.disabled = true;
    btnExport.textContent = '내보내는 중...';

    try {
      const includeWork = document.querySelector('input[name="export-scope"]:checked')?.value === 'full'; // 완전 백업(작업·전체대화 포함) 여부
      const result = await window.agentAPI.exportAgent(currentAgent.id, { includeWork });
      const pathEl = $('#export-path');
      if (result.canceled) {
        // 취소됨
      } else if (result.savedTo) {
        pathEl.textContent = '저장됨: ' + result.savedTo;
        pathEl.classList.remove('hidden');
        setTimeout(() => pathEl.classList.add('hidden'), 8000);
      } else if (result.error) {
        alert('내보내기 오류: ' + result.error);
      }
    } catch (e) {
      alert('내보내기 오류: ' + e.message);
    } finally {
      btnExport.disabled = false;
      btnExport.textContent = '내보내기 (Export)';
    }
  });
}

// 읽기용 폴더(마크다운) 내보내기 — 사람·다른 AI가 읽는 형태
const btnExportMd = $('#btn-export-md');
if (btnExportMd) {
  btnExportMd.addEventListener('click', async () => {
    if (!currentAgent) return;
    btnExportMd.disabled = true;
    const orig = btnExportMd.textContent;
    btnExportMd.textContent = '내보내는 중...';
    try {
      const excludeSensitive = $('#export-exclude-sensitive')?.checked;
      const result = await window.agentAPI.exportMarkdown(currentAgent.id, { includeSensitive: !excludeSensitive });
      const pathEl = $('#export-md-path');
      if (result.canceled) {
        // 취소됨
      } else if (result.savedTo) {
        pathEl.textContent = `저장됨: ${result.savedTo} (${result.fileCount}개 파일)`;
        pathEl.classList.remove('hidden');
        setTimeout(() => pathEl.classList.add('hidden'), 10000);
      } else if (result.error) {
        alert('내보내기 오류: ' + result.error);
      }
    } catch (e) {
      alert('내보내기 오류: ' + e.message);
    } finally {
      btnExportMd.disabled = false;
      btnExportMd.textContent = orig;
    }
  });
}

/* ── 온보딩: 에이전트 불러오기 (Import) ─────────────────────────── */
const btnImport = $('#btn-import-agent');
if (btnImport) {
  btnImport.addEventListener('click', async () => {
    btnImport.disabled = true;
    btnImport.textContent = '파일 선택 중...';
    const statusEl = $('#import-status');

    try {
      const result = await window.agentAPI.importAgent();

      if (result.canceled) {
        // 취소됨 — 아무것도 안 함
        return;
      }
      if (result.error) {
        statusEl.textContent = '불러오기 실패: ' + result.error;
        statusEl.classList.remove('hidden');
        statusEl.classList.add('import-error');
        setTimeout(() => {
          statusEl.classList.add('hidden');
          statusEl.classList.remove('import-error');
        }, 6000);
        return;
      }

      // 성공: 복원된 에이전트로 대화 화면 진입
      statusEl.textContent = `"${result.agent.name}" 가져오기 완료! 기억 ${result.agent.humanFacts.length}개 복원됨. AI 모델을 다시 연결해주세요.`;
      statusEl.classList.remove('hidden', 'import-error');
      statusEl.classList.add('import-ok');

      // 잠깐 표시 후 대화 화면으로 이동
      await new Promise(r => setTimeout(r, 1500));
      statusEl.classList.add('hidden');
      statusEl.classList.remove('import-ok');

      await openChatScreen(result.agent.id);
    } catch (e) {
      statusEl.textContent = '불러오기 오류: ' + e.message;
      statusEl.classList.remove('hidden');
      statusEl.classList.add('import-error');
      setTimeout(() => {
        statusEl.classList.add('hidden');
        statusEl.classList.remove('import-error');
      }, 6000);
    } finally {
      btnImport.disabled = false;
      btnImport.textContent = '에이전트 가져오기 (파일 열기)';
    }
  });
}

const btnNewAgent = $('#btn-new-agent');
if (btnNewAgent) {
  btnNewAgent.addEventListener('click', () => {
    currentAgent = null;
    showScreen('screen-onboarding');
  });
}

/* ── 에이전트 설정 화면 ───────────────────────────────────── */

/** 설정 화면 아바타 미리보기 갱신 */
function refreshAvatarPreview(agent) {
  const preview = $('#settings-avatar-preview');
  if (!preview) return;
  if (agent && agent.avatar) {
    preview.style.backgroundImage = `url("${agent.avatar}")`;
    preview.classList.add('has-image');
    preview.textContent = '';
  } else {
    preview.style.backgroundImage = '';
    preview.classList.remove('has-image');
    const initial = agent && agent.name ? agent.name.slice(0, 1).toUpperCase() : '?';
    preview.textContent = initial;
  }
}

/* ── 프로필 사진: 파일 선택 → canvas 크롭 → 저장 ───────── */
const avatarFileInput = $('#avatar-file-input');
const btnAvatarChange = $('#btn-avatar-change');
const btnAvatarDelete = $('#btn-avatar-delete');

if (btnAvatarChange && avatarFileInput) {
  btnAvatarChange.addEventListener('click', () => {
    avatarFileInput.value = '';
    avatarFileInput.click();
  });
  avatarFileInput.addEventListener('change', async () => {
    const file = avatarFileInput.files && avatarFileInput.files[0];
    if (!file) return;
    const statusHint = $('#avatar-status-hint');
    if (statusHint) statusHint.textContent = '처리 중...';
    try {
      const dataUrl = await cropAndResizeAvatar(file);
      // 저장
      if (!currentAgent) throw new Error('에이전트 없음');
      const updated = await window.agentAPI.updateAgent(currentAgent.id, { avatar: dataUrl });
      if (updated && !updated.error) {
        currentAgent = updated;
      } else {
        currentAgent.avatar = dataUrl; // fallback: 로컬만 갱신
      }
      // 세 곳 반영
      applyAvatar($('#sidebar-avatar'), currentAgent);
      applyAvatar($('#chat-head-avatar'), currentAgent);
      refreshAvatarPreview(currentAgent);
      if (statusHint) { statusHint.textContent = '사진이 저장됐어요!'; setTimeout(() => { statusHint.textContent = ''; }, 3000); }
    } catch (e) {
      if (statusHint) statusHint.textContent = '오류: ' + e.message;
      console.error('[avatar] 업로드 오류:', e.message);
    }
    avatarFileInput.value = '';
  });
}

if (btnAvatarDelete) {
  btnAvatarDelete.addEventListener('click', async () => {
    if (!currentAgent) return;
    const statusHint = $('#avatar-status-hint');
    try {
      const updated = await window.agentAPI.updateAgent(currentAgent.id, { avatar: null });
      if (updated && !updated.error) {
        currentAgent = updated;
      } else {
        currentAgent.avatar = null;
      }
      // 세 곳 반영
      applyAvatar($('#sidebar-avatar'), currentAgent);
      applyAvatar($('#chat-head-avatar'), currentAgent);
      refreshAvatarPreview(currentAgent);
      if (statusHint) { statusHint.textContent = '사진이 삭제됐어요.'; setTimeout(() => { statusHint.textContent = ''; }, 3000); }
    } catch (e) {
      if (statusHint) statusHint.textContent = '오류: ' + e.message;
    }
  });
}

/** 설정 화면 열기 */
function openSettingsScreen() {
  if (!currentAgent) return;

  // 프로필 사진 미리보기 갱신
  refreshAvatarPreview(currentAgent);

  // 사용자 지침 (AUXO.md)
  const auxoEl = $('#settings-auxomd');
  if (auxoEl) auxoEl.value = currentAgent.auxoMd || '';

  // 도구 사용 자율도
  const trustEl = $('#settings-trust');
  if (trustEl) trustEl.value = currentAgent.trustLevel || 'ask_risky';

  // AI 모델(LLM) 연결 — 제공자별 키 보관함에서 현재 모델 값 로드
  const curMode = currentAgent.brainMode || 'claude-subscription';
  const brainSel = $('#settings-brain');
  if (brainSel) brainSel.value = curMode;
  const keyEl = $('#settings-api-key');
  if (keyEl) keyEl.value = (currentAgent.apiKeys && currentAgent.apiKeys[curMode]) || currentAgent.apiKey || '';
  const modelEl = $('#settings-model');
  if (modelEl) modelEl.value = (currentAgent.models && currentAgent.models[curMode]) || currentAgent.model || '';
  updateSettingsApiConfig(curMode);
  // OpenAI 호환: 저장된 base URL → 프리셋·입력 복원
  if (curMode === 'openai-compatible') {
    const savedBase = currentAgent.baseURL || '';
    const pk = savedBase ? presetKeyFromBaseURL(savedBase) : 'openrouter';
    const presetSel = $('#settings-compat-preset');
    const baseEl = $('#settings-base-url');
    if (presetSel) presetSel.value = pk;
    applyCompatPreset(pk, { fillBaseURL: !savedBase });
    if (baseEl && savedBase) baseEl.value = savedBase;
  }

  // 기억 목록 렌더링
  renderSettingsFacts(currentAgent.humanFacts || []);

  // 텔레그램·디스코드 연결 상태 갱신
  refreshTelegramUI();
  refreshDiscordUI();

  // 저장 힌트 숨기기
  const hint = $('#settings-save-hint');
  if (hint) hint.classList.add('hidden');

  // 설정 탭: 열 때마다 첫 탭(일반)으로 초기화
  document.querySelectorAll('#screen-settings .stab').forEach(b => b.classList.toggle('active', b.dataset.tab === 'general'));
  document.querySelectorAll('#screen-settings .tab-panel').forEach(p => p.classList.toggle('active', p.dataset.panel === 'general'));

  openModal('screen-settings');
}

// 설정 탭 전환 (2026-07-08 UI 개편: 일반/AI모델/연결/데이터)
document.querySelectorAll('#screen-settings .stab').forEach(btn => {
  btn.addEventListener('click', () => {
    const tab = btn.dataset.tab;
    document.querySelectorAll('#screen-settings .stab').forEach(b => b.classList.toggle('active', b === btn));
    document.querySelectorAll('#screen-settings .tab-panel').forEach(p => p.classList.toggle('active', p.dataset.panel === tab));
  });
});

/* ── 텔레그램 메신저 연결 ─────────────────────────────────── */
function showTgResult(kind, msg) {
  const tr = $('#tg-connect-result'); if (!tr) return;
  tr.className = 'api-test-result ' + kind; tr.classList.remove('hidden'); tr.textContent = msg;
}
async function refreshTelegramUI() {
  let st = null;
  try { st = await window.agentAPI.telegramStatus(); } catch (_) {}
  const connected = !!(st && st.running && currentAgent && st.agentId === currentAgent.id);
  $('#tg-connected')?.classList.toggle('hidden', !connected);
  $('#tg-disconnected')?.classList.toggle('hidden', connected);
  if (connected && $('#tg-username')) $('#tg-username').textContent = '@' + (st.username || '');
  const res = $('#tg-connect-result'); if (res) res.classList.add('hidden');
}
$('#tg-help-btn')?.addEventListener('click', () => window.agentAPI.envOpenUrl('https://t.me/BotFather'));
$('#tg-connect-btn')?.addEventListener('click', async () => {
  const token = $('#tg-token')?.value.trim();
  if (!token) { showTgResult('error', '봇 토큰을 붙여넣어 주세요.'); return; }
  if (!currentAgent) { showTgResult('error', '먼저 에이전트를 선택해 주세요.'); return; }
  const btn = $('#tg-connect-btn'); btn.disabled = true; btn.textContent = '연결 중...';
  showTgResult('pending', '텔레그램 봇을 확인하는 중...');
  try {
    const r = await window.agentAPI.telegramConnect(token, currentAgent.id);
    if (r && r.ok) { $('#tg-token').value = ''; await refreshTelegramUI(); }
    else { showTgResult('error', '❌ ' + ((r && r.error) || '연결 실패')); }
  } catch (e) { showTgResult('error', '❌ ' + e.message); }
  finally { btn.disabled = false; btn.textContent = '연결하기'; }
});
$('#tg-disconnect-btn')?.addEventListener('click', async () => {
  try { await window.agentAPI.telegramDisconnect(); } catch (_) {}
  await refreshTelegramUI();
});

// ── 디스코드 연결 (텔레그램과 동일 패턴) ──
function showDcResult(kind, msg) {
  const tr = $('#dc-connect-result'); if (!tr) return;
  tr.className = 'api-test-result ' + kind; tr.classList.remove('hidden'); tr.textContent = msg;
}
async function refreshDiscordUI() {
  let st = null;
  try { st = await window.agentAPI.discordStatus(); } catch (_) {}
  const connected = !!(st && st.running && currentAgent && st.agentId === currentAgent.id);
  $('#dc-connected')?.classList.toggle('hidden', !connected);
  $('#dc-disconnected')?.classList.toggle('hidden', connected);
  if (connected && $('#dc-username')) $('#dc-username').textContent = '@' + (st.username || '');
  const guide = connected ? $('#dc-guide') : null;
  if (guide) {
    const inv = st.botId ? `https://discord.com/oauth2/authorize?client_id=${st.botId}&permissions=2048&scope=bot` : '';
    guide.innerHTML = '<b>대화하는 법</b> — 봇을 서버에 초대한 뒤:'
      + '<br>① 이 봇을 <b>내 디스코드 서버에 초대</b>' + (inv ? ' → <span class="dc-invite">봇 초대 링크 열기 ↗</span>' : ' (개발자 포털 OAuth2 → bot)')
      + '<br>② 채널 이름을 <b>' + (currentAgent?.name ? currentAgent.name : '에이전트 이름') + '</b> 이나 <b>auxo</b> 로 만들면, 그 채널에선 <b>@멘션 없이 그냥</b> 대화돼요 (추천 — 텔레그램처럼)'
      + '<br>③ 다른 채널은 <b>@봇 멘션</b>, 또는 봇 <b>DM</b>도 돼요. 첫 메시지 보낸 사람이 주인이 됩니다.';
    const iv = guide.querySelector('.dc-invite');
    if (iv && inv) { iv.style.cssText = 'color:var(--accent);cursor:pointer;text-decoration:underline'; iv.addEventListener('click', () => window.agentAPI.envOpenUrl(inv)); }
  }
  const res = $('#dc-connect-result'); if (res) res.classList.add('hidden');
}
$('#dc-help-btn')?.addEventListener('click', () => window.agentAPI.envOpenUrl('https://discord.com/developers/applications'));
$('#dc-connect-btn')?.addEventListener('click', async () => {
  const token = $('#dc-token')?.value.trim();
  if (!token) { showDcResult('error', '봇 토큰을 붙여넣어 주세요.'); return; }
  if (!currentAgent) { showDcResult('error', '먼저 에이전트를 선택해 주세요.'); return; }
  const btn = $('#dc-connect-btn'); btn.disabled = true; btn.textContent = '연결 중...';
  showDcResult('pending', '디스코드 봇을 확인하는 중...');
  try {
    const r = await window.agentAPI.discordConnect(token, currentAgent.id);
    if (r && r.ok) { $('#dc-token').value = ''; await refreshDiscordUI(); }
    else { showDcResult('error', '❌ ' + ((r && r.error) || '연결 실패')); }
  } catch (e) { showDcResult('error', '❌ ' + e.message); }
  finally { btn.disabled = false; btn.textContent = '연결하기'; }
});
$('#dc-disconnect-btn')?.addEventListener('click', async () => {
  try { await window.agentAPI.discordDisconnect(); } catch (_) {}
  await refreshDiscordUI();
});

/** 설정 화면: 기억 목록 렌더링 (편집/삭제 가능) */
function renderSettingsFacts(facts) {
  const list = $('#settings-facts-list');
  const countEl = $('#settings-fact-count');
  if (!list) return;

  if (facts.length === 0) {
    list.innerHTML = '<li class="fact-empty">아직 기억이 없어요.</li>';
  } else {
    list.innerHTML = facts.map((f, i) => `
      <li class="settings-fact-item" data-index="${i}">
        <input type="text" class="fact-label-input" value="${escHtml(f.label)}" placeholder="항목" data-field="label">
        <input type="text" class="fact-value-input" value="${escHtml(f.value)}" placeholder="내용" data-field="value">
        <button class="btn-fact-delete" data-index="${i}" title="삭제">✕</button>
      </li>
    `).join('');

    // 삭제 버튼
    list.querySelectorAll('.btn-fact-delete').forEach(btn => {
      btn.addEventListener('click', async () => {
        const idx = parseInt(btn.dataset.index, 10);
        if (!confirm(`이 기억을 삭제할까요?\n"${currentAgent.humanFacts[idx]?.label}: ${currentAgent.humanFacts[idx]?.value}"`)) return;
        const result = await window.agentAPI.deleteFact(currentAgent.id, idx);
        if (result.error) { alert('오류: ' + result.error); return; }
        currentAgent.humanFacts = result.humanFacts;
        renderFacts(result.humanFacts);
        renderSettingsFacts(result.humanFacts);
      });
    });
  }

  if (countEl) countEl.textContent = facts.length;
}

/** OpenAI 호환 제공자 프리셋 적용(base URL·모델예시·키발급 안내 자동 채움). 설정/온보딩 공용(ids로 구분) */
function applyCompatPreset(presetKey, opts = {}) {
  const p = OPENAI_COMPAT_PRESETS[presetKey] || OPENAI_COMPAT_PRESETS.custom;
  const ids = opts.ids || { base: 'settings-base-url', model: 'settings-model', hint: 'settings-compat-hint' };
  const baseEl = $('#' + ids.base);
  const modelEl = $('#' + ids.model);
  const hintEl = $('#' + ids.hint);
  // 프리셋(custom 아님)을 새로 고르면 base URL 자동 채움. custom이면 사용자 입력 유지/비움.
  if (baseEl && opts.fillBaseURL) baseEl.value = (presetKey === 'custom') ? '' : p.baseURL;
  if (modelEl) modelEl.placeholder = p.modelEg;
  if (hintEl) {
    if (p.keyUrl) {
      hintEl.innerHTML = `${escHtml(p.desc)} · <a href="#" class="compat-keylink" data-url="${p.keyUrl}">키 발급하기 →</a>`;
    } else {
      hintEl.textContent = p.desc;
    }
  }
}
const ONBOARD_COMPAT_IDS = { base: 'onboard-base-url', model: 'api-model', hint: 'onboard-compat-hint' };

/** 설정 화면: 선택한 AI 모델에 맞춰 키/모델 입력 + (호환이면)프리셋 영역 표시 */
function updateSettingsApiConfig(value) {
  const area = $('#settings-api-config');
  const compat = $('#settings-compat-config');
  const agy = $('#settings-agy-config');
  const meta = BRAIN_META[value] || {};
  // OpenAI 호환: 프리셋+base URL 영역 토글
  if (compat) compat.classList.toggle('hidden', !meta.compat);
  // Antigravity: 모델 드롭다운 토글 + 현재 저장된 모델 반영
  if (agy) {
    const isAgy = value === 'antigravity-subscription';
    agy.classList.toggle('hidden', !isAgy);
    if (isAgy) {
      const sel = $('#settings-agy-model');
      if (sel) sel.value = (currentAgent && currentAgent.models && currentAgent.models['antigravity-subscription']) || '';
    }
  }
  if (area) {
    if (meta.needsKey) {
      area.classList.remove('hidden');
      const k = $('#settings-api-key'); const m = $('#settings-model'); const h = $('#settings-api-hint');
      if (k) k.placeholder = meta.keyPlaceholder || 'API 키 입력';
      if (m) m.placeholder = meta.modelPlaceholder || '모델 (선택)';
      if (h) h.textContent = meta.hint || ''; // 호환 모드는 api-hint 비움(안내는 compat-hint에)
    } else {
      area.classList.add('hidden');
    }
  }
  const wsHint = $('#settings-websearch-hint');
  if (wsHint) wsHint.textContent = '';
}

// 설정: OpenAI 호환 프리셋 변경 → base URL·모델예시·키발급 안내 갱신
const settingsCompatPreset = $('#settings-compat-preset');
if (settingsCompatPreset) {
  settingsCompatPreset.addEventListener('change', () => applyCompatPreset(settingsCompatPreset.value, { fillBaseURL: true }));
}
// 외부 링크(위임) → 외부 브라우저로 열기 (키 발급 링크 .compat-keylink + 일반 안내 링크 .ext-link)
document.addEventListener('click', (e) => {
  const a = e.target.closest && e.target.closest('.compat-keylink, .ext-link');
  if (a) { e.preventDefault(); const url = a.dataset.url; if (url && window.agentAPI?.envOpenUrl) window.agentAPI.envOpenUrl(url); }
});

// 설정: AI 모델 변경 시 키/모델 영역 토글 + 입력값 정리
// 다른 제공자로 바꾸면 이전 제공자의 키/모델이 남지 않게 비우고, 원래(저장된) 제공자로 되돌리면 복원.
const settingsBrainSel = $('#settings-brain');
if (settingsBrainSel) {
  settingsBrainSel.addEventListener('change', () => {
    const v = settingsBrainSel.value;
    const keyEl = $('#settings-api-key');
    const modelEl = $('#settings-model');
    // 선택한 제공자의 보관함 값 로드(없으면 빈칸). 제공자마다 키가 따로 보관됨.
    const ks = (currentAgent && currentAgent.apiKeys) || {};
    const ms = (currentAgent && currentAgent.models) || {};
    if (keyEl) keyEl.value = ks[v] || '';
    if (modelEl) modelEl.value = ms[v] || '';
    updateSettingsApiConfig(v);
    // OpenAI 호환: 저장된 base URL이면 그 프리셋 복원, 없으면 OpenRouter 기본 추천
    if (v === 'openai-compatible') {
      const savedBase = (currentAgent && currentAgent.baseURL) || '';
      const pk = savedBase ? presetKeyFromBaseURL(savedBase) : 'openrouter';
      const presetSel = $('#settings-compat-preset');
      const baseEl = $('#settings-base-url');
      if (presetSel) presetSel.value = pk;
      applyCompatPreset(pk, { fillBaseURL: !savedBase });
      if (baseEl && savedBase) baseEl.value = savedBase;
    }
  });
}

/** 에이전트별 사용목록 토글: field='disabledSkills'|'disabledMcp'. use=true면 사용(끈목록에서 제거) */
async function toggleAgentUse(field, id, use) {
  if (!currentAgent) return;
  const cur = new Set(currentAgent[field] || []);
  if (use) cur.delete(id); else cur.add(id);
  const arr = [...cur];
  const updated = await window.agentAPI.updateAgent(currentAgent.id, { [field]: arr });
  currentAgent[field] = (updated && !updated.error && updated[field]) ? updated[field] : arr;
}

/** 설정 화면: 설치된 스킬(SKILL.md) 목록 렌더링(에이전트별 사용 토글 + 삭제) */
async function renderSettingsSkills() {
  const list = $('#settings-skills-list');
  const countEl = $('#settings-skill-count');
  if (!list) return;
  let skills = [];
  try { skills = await window.agentAPI.skillsList(currentAgent && currentAgent.id); } catch (_) {}
  const off = new Set((currentAgent && currentAgent.disabledSkills) || []);
  if (!skills || skills.length === 0) {
    list.innerHTML = '<li class="fact-empty">설치된 스킬이 없어요. "+ 스킬 가져오기"로 SKILL.md 폴더를 추가해보세요.</li>';
  } else {
    list.innerHTML = skills.map(s => `
      <li class="settings-skill-item" data-id="${escHtml(s.id)}">
        <div class="skill-row1">
          <label class="skill-toggle"><input type="checkbox" class="skill-use" data-id="${escHtml(s.id)}" ${off.has(s.id) ? '' : 'checked'}> 이 에이전트에서 사용</label>
          <span class="skill-name-label">🧩 ${escHtml(s.name)}</span>
          <button class="btn-skill-delete" data-id="${escHtml(s.id)}" title="삭제">✕</button>
        </div>
        <div class="skill-desc">${escHtml(s.description || '')}</div>
      </li>
    `).join('');
    list.querySelectorAll('.skill-use').forEach(cb => cb.addEventListener('change', () => {
      toggleAgentUse('disabledSkills', cb.dataset.id, cb.checked);
    }));
    list.querySelectorAll('.btn-skill-delete').forEach(btn => {
      btn.addEventListener('click', async () => {
        if (!confirm('이 스킬을 삭제할까요?')) return;
        await window.agentAPI.skillsRemove(currentAgent && currentAgent.id, btn.dataset.id);
        renderSettingsSkills();
      });
    });
  }
  if (countEl) countEl.textContent = (skills || []).length;
}

/** 설정: 등록된 MCP 서버 목록 렌더링 */
async function renderSettingsMcp() {
  const list = $('#settings-mcp-list');
  const countEl = $('#settings-mcp-count');
  if (!list) return;
  let servers = [];
  try { servers = await window.agentAPI.mcpList(currentAgent && currentAgent.id); } catch (_) {}
  const offM = new Set((currentAgent && currentAgent.disabledMcp) || []);
  if (!servers || servers.length === 0) {
    list.innerHTML = '<li class="fact-empty">등록된 MCP 서버가 없어요.</li>';
  } else {
    list.innerHTML = servers.map(s => `
      <li class="settings-skill-item" data-id="${escHtml(s.id)}">
        <div class="skill-row1">
          <label class="skill-toggle"><input type="checkbox" class="mcp-use" data-id="${escHtml(s.id)}" ${offM.has(s.id) ? '' : 'checked'}> 이 에이전트에서 사용</label>
          <span class="skill-name-label">🔌 ${escHtml(s.name)}</span>
          <button class="btn-mcp-test" data-id="${escHtml(s.id)}" title="연결 테스트">테스트</button>
          <button class="btn-skill-delete" data-id="${escHtml(s.id)}" title="삭제">✕</button>
        </div>
        <div class="skill-desc">${escHtml(s.command)} ${escHtml((s.args || []).join(' '))}</div>
        <label class="skill-toggle" style="margin-top:4px"><input type="checkbox" class="mcp-enabled" data-id="${escHtml(s.id)}" ${s.enabled !== false ? 'checked' : ''}> 서버 켜기(전역 — 모든 에이전트 공통)</label>
        <label class="skill-toggle" style="margin-top:4px"><input type="checkbox" class="mcp-auto" data-id="${escHtml(s.id)}" ${s.autoApprove ? 'checked' : ''}> 위험 도구 자동 허용(신뢰) — 끄면 실행 전 물어봄</label>
      </li>`).join('');
    list.querySelectorAll('.mcp-use').forEach(cb => cb.addEventListener('change', () => {
      toggleAgentUse('disabledMcp', cb.dataset.id, cb.checked);
    }));
    list.querySelectorAll('.mcp-enabled').forEach(cb => cb.addEventListener('change', async () => {
      await window.agentAPI.mcpSetEnabled(currentAgent && currentAgent.id, cb.dataset.id, cb.checked);
    }));
    list.querySelectorAll('.mcp-auto').forEach(cb => cb.addEventListener('change', async () => {
      await window.agentAPI.mcpSetAutoApprove(currentAgent && currentAgent.id, cb.dataset.id, cb.checked);
    }));
    list.querySelectorAll('.btn-mcp-test').forEach(btn => btn.addEventListener('click', async () => {
      btn.textContent = '확인중…';
      const r = await window.agentAPI.mcpTest(currentAgent && currentAgent.id, btn.dataset.id);
      btn.textContent = '테스트';
      if (r && r.ok) alert(`연결 성공! 도구: ${r.tools.join(', ') || '(없음)'}`);
      else alert('연결 실패: ' + ((r && r.error) || '알 수 없음'));
    }));
    list.querySelectorAll('.btn-skill-delete').forEach(btn => btn.addEventListener('click', async () => {
      if (!confirm('이 MCP 서버를 삭제할까요?')) return;
      await window.agentAPI.mcpRemove(currentAgent && currentAgent.id, btn.dataset.id);
      renderSettingsMcp();
      renderMcpCatalog(); // 삭제한 항목을 빠른 추가에 다시 노출
    }));
  }
  if (countEl) countEl.textContent = (servers || []).length;
}

// MCP 서버 추가 버튼
const btnAddMcp = $('#btn-add-mcp');
if (btnAddMcp) {
  btnAddMcp.addEventListener('click', async () => {
    const name = $('#mcp-name')?.value.trim();
    const command = $('#mcp-command')?.value.trim();
    const args = $('#mcp-args')?.value.trim();
    if (!command) { alert('실행 명령을 입력해주세요.'); return; }
    const r = await window.agentAPI.mcpAdd(currentAgent && currentAgent.id, { name, command, args });
    if (r && r.error) { alert('추가 실패: ' + r.error); return; }
    $('#mcp-name').value = ''; $('#mcp-command').value = ''; $('#mcp-args').value = '';
    alert(`MCP 서버 "${r.name}" 추가됨. "테스트"로 연결을 확인해보세요.`);
    renderSettingsMcp();
    renderMcpCatalog();
  });
}

/** 능력: 환경(필요 프로그램) 점검 상태줄 렌더링.
    스킬·MCP 탭 위에 하나씩 있다. 항상 한 줄로 접힌 채 열리고(요약 줄이 이미
    무엇이 없는지 말해준다), 빠진 프로그램이 있으면 경고색으로 표시된다.
    "다시 점검"으로 재렌더할 땐 사용자가 펼쳐둔 상태를 유지한다. */
async function renderEnv() {
  const bars = document.querySelectorAll('#screen-abilities .env-bar');
  if (!bars.length) return;
  // 재렌더(다시 점검)면 펼침 상태 보존, 최초 렌더면 접은 채 시작
  const wasOpen = [...bars].map(b => b.dataset.rendered === '1' && b.open);
  bars.forEach(b => { b.innerHTML = '<summary class="env-bar-head">필요 프로그램 점검 중…</summary>'; });

  let rt = [];
  try { rt = await window.agentAPI.envCheck(); } catch (_) {}
  rt = rt || [];
  const missing = rt.filter(r => !r.ok);

  const head = missing.length
    ? `⚠️ 필요 프로그램 ${missing.length}개가 없어요 — ${missing.map(r => escHtml(r.label)).join(', ')}`
    : `✓ 필요 프로그램 ${rt.length}개 모두 준비됨`;

  const body = `
    <div class="acc-body">
      <p class="hint">스킬·MCP 실행에 필요한 프로그램이에요. 없으면 설치 링크로 안내합니다.</p>
      <ul class="settings-skills-list">
        ${rt.map(r => `
          <li class="settings-skill-item">
            <div class="skill-row1">
              <span class="skill-name-label">${r.ok ? '✅' : '❌'} ${escHtml(r.label)}${r.ok ? ' — ' + escHtml(r.version) : ''}</span>
              ${r.ok ? '' : `<button class="btn-env-install" data-url="${escHtml(r.installUrl)}">설치 안내</button>`}
            </div>
            <div class="skill-desc">${escHtml(r.why)}</div>
          </li>`).join('')}
      </ul>
      <button class="btn-ghost btn-env-recheck">다시 점검</button>
    </div>`;

  bars.forEach((bar, i) => {
    bar.classList.toggle('env-bar-warn', missing.length > 0);
    bar.open = wasOpen[i];
    bar.dataset.rendered = '1';
    bar.innerHTML = `<summary class="env-bar-head">${head}</summary>${body}`;
    bar.querySelectorAll('.btn-env-install').forEach(b => b.addEventListener('click', () => window.agentAPI.envOpenUrl(b.dataset.url)));
    bar.querySelectorAll('.btn-env-recheck').forEach(b => b.addEventListener('click', renderEnv));
  });
}

/* 능력 탭 전환 (2026-07-09: 기본 능력 / 스킬 / MCP) */
document.querySelectorAll('#screen-abilities .stab').forEach(btn => {
  btn.addEventListener('click', () => {
    const tab = btn.dataset.tab;
    document.querySelectorAll('#screen-abilities .stab').forEach(b => b.classList.toggle('active', b === btn));
    document.querySelectorAll('#screen-abilities .tab-panel').forEach(p => p.classList.toggle('active', p.dataset.panel === tab));
  });
});

/** 설정: MCP 카탈로그(빠른 추가) 렌더링 */
async function renderMcpCatalog() {
  const box = $('#mcp-catalog-list');
  if (!box) return;
  let cat = [];
  try { cat = await window.agentAPI.mcpCatalog(); } catch (_) {}
  // 이미 설치된 MCP는 "빠른 추가"에서 제외 — 위 "사용 중" 목록에만 뜨게(중복 방지).
  let installed = [];
  try { installed = await window.agentAPI.mcpList(currentAgent && currentAgent.id); } catch (_) {}
  const have = new Set((installed || []).map(s => s.id));
  cat = (cat || []).filter(s => !have.has(s.id));
  if (!cat.length) { box.innerHTML = '<li class="fact-empty">추가할 수 있는 항목을 모두 등록했어요.</li>'; return; }
  box.innerHTML = cat.map(s => `
    <li class="settings-skill-item" data-id="${escHtml(s.id)}">
      <div class="skill-row1">
        <span class="skill-name-label">🧰 ${escHtml(s.name)}</span>
        ${s.setup ? `<button class="btn-mcp-setup" data-id="${escHtml(s.id)}">${escHtml(s.setup.label)}</button>` : ''}
        <button class="btn-mcp-cat-add" data-id="${escHtml(s.id)}">추가</button>
      </div>
      <div class="skill-desc">${escHtml(s.description)}${(s.params && s.params.length) ? ' (입력 필요: ' + s.params.map(p => escHtml(p.label)).join(', ') + ')' : ''}${(s.requires && s.requires.length) ? ' · 필요: ' + s.requires.join(', ') : ''}</div>
    </li>`).join('');
  box.querySelectorAll('.btn-mcp-setup').forEach(btn => btn.addEventListener('click', async () => {
    const entry = (cat || []).find(s => s.id === btn.dataset.id);
    if (!entry || !entry.setup) return;
    btn.disabled = true; const orig = btn.textContent; btn.textContent = '설치 중…(시간 걸려요)';
    const r = await window.agentAPI.envRunSetup(entry.setup.command, entry.setup.args);
    btn.disabled = false; btn.textContent = orig;
    alert(r && r.ok ? '설치 완료!' : '설치 실패/경고:\n' + ((r && (r.error || r.out)) || '알 수 없음'));
  }));
  box.querySelectorAll('.btn-mcp-cat-add').forEach(btn => btn.addEventListener('click', async () => {
    const entry = (cat || []).find(s => s.id === btn.dataset.id);
    const params = {};
    for (const p of (entry.params || [])) {
      const v = window.prompt(`${entry.name} — ${p.label}${p.example ? '\n예: ' + p.example : ''}`, p.example || '');
      if (p.required && !v) { alert('입력이 필요해 취소했어요.'); return; }
      if (v) params[p.key] = v;
    }
    const r = await window.agentAPI.mcpAddFromCatalog(currentAgent && currentAgent.id, btn.dataset.id, params);
    if (r && r.error) { alert('추가 실패: ' + r.error); return; }
    alert(`'${entry.name}' 추가됨. 목록에서 "테스트"로 연결 확인해보세요.`);
    renderSettingsMcp();
    renderMcpCatalog(); // 방금 추가한 항목을 빠른 추가에서 제거
  }));
}

// JSON으로 MCP 추가
const btnAddMcpJson = $('#btn-add-mcp-json');
if (btnAddMcpJson) {
  btnAddMcpJson.addEventListener('click', async () => {
    const text = $('#mcp-json')?.value.trim();
    if (!text) { alert('JSON을 붙여넣어 주세요.'); return; }
    const r = await window.agentAPI.mcpAddFromJson(currentAgent && currentAgent.id, text);
    if (r && r.error) { alert('추가 실패: ' + r.error); return; }
    $('#mcp-json').value = '';
    alert(`${(r.added || []).length}개 서버 추가됨.`);
    renderSettingsMcp();
    renderMcpCatalog();
  });
}

// 스킬 가져오기(폴더) 버튼
const btnImportSkill = $('#btn-import-skill');
if (btnImportSkill) {
  btnImportSkill.addEventListener('click', async () => {
    const r = await window.agentAPI.skillsImport(currentAgent && currentAgent.id);
    if (r && r.error) { alert('가져오기 실패: ' + r.error); return; }
    if (r && r.canceled) return;
    if (r && r.name) alert(`스킬 "${r.name}" 설치 완료!`);
    renderSettingsSkills();
  });
}

// 설정 화면 진입 버튼 (햄버거 메뉴 안)
const btnOpenSettings = $('#btn-open-settings');
if (btnOpenSettings) {
  btnOpenSettings.addEventListener('click', openSettingsScreen);
}

// 상단바 햄버거 메뉴 토글
const btnHamburger = $('#btn-hamburger');
const appMenu = $('#app-menu');
if (btnHamburger && appMenu) {
  btnHamburger.addEventListener('click', (e) => {
    e.stopPropagation();
    appMenu.classList.toggle('hidden');
  });
  // 메뉴 항목 클릭 또는 바깥 클릭 시 닫기
  appMenu.addEventListener('click', () => appMenu.classList.add('hidden'));
  document.addEventListener('click', (e) => {
    if (!appMenu.contains(e.target) && e.target !== btnHamburger) appMenu.classList.add('hidden');
  });
}

/* ── 공지·업데이트 안테나 (수신 전용) ── */
function cmpVer(a, b) {
  const pa = String(a).split('.').map(n => parseInt(n) || 0);
  const pb = String(b).split('.').map(n => parseInt(n) || 0);
  for (let i = 0; i < 3; i++) { if ((pa[i] || 0) > (pb[i] || 0)) return 1; if ((pa[i] || 0) < (pb[i] || 0)) return -1; }
  return 0;
}
function showNoticeBanner(payload) {
  if (localStorage.getItem('auxo-notice-off') === '1') return;
  if (!payload || !payload.notice) return;
  const n = payload.notice;
  const hasUpdate = n.latestVersion && cmpVer(n.latestVersion, payload.appVersion || '0.0.0') > 0;
  const text = hasUpdate
    ? `새 버전 ${n.latestVersion}이 나왔어요${n.message ? ' — ' + n.message : ''}`
    : (n.message || '');
  if (!text) return;
  const seenKey = 'auxo-notice-seen';
  const id = `${n.id || ''}|${n.latestVersion || ''}|${n.message || ''}`;
  if (localStorage.getItem(seenKey) === id) return; // 이미 닫은 공지
  const bar = document.createElement('div');
  bar.className = 'notice-banner';
  bar.innerHTML = `<span class="notice-text"></span>${n.url ? '<button class="notice-link">보기</button>' : ''}<button class="notice-close" title="닫기">✕</button>`;
  bar.querySelector('.notice-text').textContent = '📣 ' + text;
  const link = bar.querySelector('.notice-link');
  if (link) link.addEventListener('click', () => { try { window.agentAPI.envOpenUrl(n.url); } catch (_) {} });
  bar.querySelector('.notice-close').addEventListener('click', () => { localStorage.setItem(seenKey, id); bar.remove(); });
  document.body.appendChild(bar);
}
if (window.agentAPI && window.agentAPI.onNoticeUpdate) window.agentAPI.onNoticeUpdate(showNoticeBanner);

/* ── 설정: 공지 받기 토글 ──
   localStorage 가 아니라 main 프로세스가 읽는 파일에 저장한다.
   그래야 "공지 받지 않기"가 배너뿐 아니라 네트워크 요청 자체를 막는다. */
const noticeOff = $('#settings-notice-off');
if (noticeOff) {
  (async () => {
    try {
      const r = await window.agentAPI.noticeGetOff();
      noticeOff.checked = !!(r && r.off);
    } catch (_) { noticeOff.checked = localStorage.getItem('auxo-notice-off') === '1'; }
  })();
  noticeOff.addEventListener('change', async () => {
    localStorage.setItem('auxo-notice-off', noticeOff.checked ? '1' : '0'); // 배너 억제(즉시 반영)
    try { await window.agentAPI.noticeSetOff(noticeOff.checked); } catch (_) {}
  });
}

/** 능력 화면 열기 (스킬·MCP·환경점검) */
function openAbilitiesScreen() {
  if (!currentAgent) return;

  // 능력 탭: 열 때마다 첫 탭(기본 능력)으로 초기화
  document.querySelectorAll('#screen-abilities .stab').forEach(b => b.classList.toggle('active', b.dataset.tab === 'base'));
  document.querySelectorAll('#screen-abilities .tab-panel').forEach(p => p.classList.toggle('active', p.dataset.panel === 'base'));
  // 환경 점검 상태줄: 다시 열 때도 접힌 채로 시작
  document.querySelectorAll('#screen-abilities .env-bar').forEach(b => { delete b.dataset.rendered; b.open = false; });

  loadSearchSettings(); // 기본 능력: 웹검색 품질 설정 로드
  // 스킬(설치됨) 목록 렌더링
  renderSettingsSkills();
  // 환경 점검 + MCP 서버 목록 + 카탈로그 렌더링
  renderEnv();
  renderSettingsMcp();
  renderMcpCatalog();
  openModal('screen-abilities');
}

// ── 웹검색 품질(공통 web_search 제공처) 설정 ──
function toggleSearchKeys() {
  const v = $('#settings-search-provider') && $('#settings-search-provider').value;
  const n = $('#search-key-naver'); if (n) n.classList.toggle('hidden', v !== 'naver');
  const t = $('#search-key-tavily'); if (t) t.classList.toggle('hidden', v !== 'tavily');
}
function loadSearchSettings() {
  const s = (currentAgent && currentAgent.search) || {};
  const prov = $('#settings-search-provider'); if (prov) prov.value = s.provider || 'duckduckgo';
  const ni = $('#settings-naver-id'); if (ni) ni.value = (s.naver && s.naver.clientId) || '';
  const ns = $('#settings-naver-secret'); if (ns) ns.value = (s.naver && s.naver.clientSecret) || '';
  const tk = $('#settings-tavily-key'); if (tk) tk.value = (s.tavily && s.tavily.apiKey) || '';
  toggleSearchKeys();
}
{
  const provSel = $('#settings-search-provider');
  if (provSel) provSel.addEventListener('change', toggleSearchKeys);
  const btnSaveSearch = $('#btn-save-search');
  if (btnSaveSearch) btnSaveSearch.addEventListener('click', async () => {
    if (!currentAgent) return;
    const provider = ($('#settings-search-provider') && $('#settings-search-provider').value) || 'duckduckgo';
    const search = {
      provider,
      naver: { clientId: ($('#settings-naver-id') && $('#settings-naver-id').value.trim()) || '', clientSecret: ($('#settings-naver-secret') && $('#settings-naver-secret').value.trim()) || '' },
      tavily: { apiKey: ($('#settings-tavily-key') && $('#settings-tavily-key').value.trim()) || '' },
    };
    btnSaveSearch.disabled = true; btnSaveSearch.textContent = '저장 중...';
    const updated = await window.agentAPI.updateAgent(currentAgent.id, { search });
    if (updated && !updated.error) { currentAgent = updated; btnSaveSearch.textContent = '저장됐어요 ✓'; }
    else { alert('저장에 실패했어요.'); btnSaveSearch.textContent = '검색 설정 저장'; }
    setTimeout(() => { btnSaveSearch.disabled = false; btnSaveSearch.textContent = '검색 설정 저장'; }, 1500);
  });
}

/** 알림 화면 열기 */
function openNotificationsScreen() {
  openModal('screen-notifications');
}

// 사이드바 내비: 능력 더하기 → 능력 화면
const navSkills = $('#nav-skills');
if (navSkills) {
  navSkills.addEventListener('click', openAbilitiesScreen);
}

// 햄버거 메뉴: 알림 → 알림 화면
const btnOpenNotifications = $('#btn-open-notifications');
if (btnOpenNotifications) {
  btnOpenNotifications.addEventListener('click', openNotificationsScreen);
}

// 뒤로 가기
const btnSettingsBack = $('#btn-settings-back');
if (btnSettingsBack) {
  btnSettingsBack.addEventListener('click', () => {
    showScreen('screen-chat');
  });
}
const btnAbilitiesBack = $('#btn-abilities-back');
if (btnAbilitiesBack) {
  btnAbilitiesBack.addEventListener('click', () => {
    showScreen('screen-chat');
  });
}
const btnNotificationsBack = $('#btn-notifications-back');
if (btnNotificationsBack) {
  btnNotificationsBack.addEventListener('click', () => {
    showScreen('screen-chat');
  });
}

// 저장
const btnSettingsSave = $('#btn-settings-save');
if (btnSettingsSave) {
  btnSettingsSave.addEventListener('click', async () => {
    if (!currentAgent) return;

    btnSettingsSave.disabled = true;
    btnSettingsSave.textContent = '저장 중...';

    try {
      // 기억 수정 사항 수집 (입력 필드 현재 값)
      const factItems = document.querySelectorAll('.settings-fact-item');
      for (const item of factItems) {
        const idx = parseInt(item.dataset.index, 10);
        const labelInput = item.querySelector('.fact-label-input');
        const valueInput = item.querySelector('.fact-value-input');
        if (!labelInput || !valueInput) continue;
        const newLabel = labelInput.value.trim();
        const newVal = valueInput.value.trim();
        const old = currentAgent.humanFacts[idx];
        if (old && (old.label !== newLabel || old.value !== newVal)) {
          const r = await window.agentAPI.updateFact(currentAgent.id, idx, newLabel, newVal);
          if (!r.error) currentAgent.humanFacts = r.humanFacts;
        }
      }

      // 지침(AUXO.md) 업데이트 (성격·말투·호칭은 설정에서 제거 — 대화로 자연스럽게 맞춰감)
      const auxoMd = $('#settings-auxomd')?.value.trim() || '';
      const trustLevel = $('#settings-trust')?.value || currentAgent.trustLevel || 'ask_risky';

      // AI 모델(LLM) 연결 업데이트
      const brainMode = $('#settings-brain')?.value || currentAgent.brainMode;
      const apiKey = $('#settings-api-key')?.value.trim() ?? currentAgent.apiKey;
      // Antigravity 는 모델을 드롭다운으로 고른다(멀티모델). 그 외는 텍스트 입력.
      const model = (brainMode === 'antigravity-subscription')
        ? ($('#settings-agy-model')?.value || '')
        : ($('#settings-model')?.value.trim() ?? currentAgent.model);
      // OpenAI 호환: base URL(다른 모드면 빈 문자열로 저장 — 잔존 방지)
      const isCompat = brainMode === 'openai-compatible';
      const baseURL = isCompat ? ($('#settings-base-url')?.value.trim() || '') : '';

      if (BRAIN_META[brainMode]?.needsKey && !apiKey) {
        alert('이 AI 모델은 API 키가 필요해요. 키를 입력해주세요.');
        $('#settings-api-key')?.focus();
        btnSettingsSave.disabled = false;
        btnSettingsSave.textContent = '저장하기';
        return;
      }
      if (isCompat && !baseURL) {
        alert('연결할 제공자의 API base URL이 필요해요. 프리셋을 고르거나 직접 입력해주세요.');
        $('#settings-base-url')?.focus();
        btnSettingsSave.disabled = false;
        btnSettingsSave.textContent = '저장하기';
        return;
      }

      const updated = await window.agentAPI.updateAgent(currentAgent.id, {
        auxoMd, brainMode, apiKey, model, baseURL, trustLevel,
      });

      if (updated && !updated.error) {
        currentAgent = updated;
        // 사이드바 페르소나 업데이트 (값 유지 — 표시만 갱신)
        if (updated.persona != null) $('#memory-persona').textContent = updated.persona;
        renderFacts(currentAgent.humanFacts || []);
        renderSidebarBrain(currentAgent); // 모델 변경 시 사이드바 두뇌 배지 즉시 갱신
      }

      const hint = $('#settings-save-hint');
      if (hint) {
        hint.classList.remove('hidden');
        setTimeout(() => hint.classList.add('hidden'), 3000);
      }
    } catch (e) {
      alert('저장 오류: ' + e.message);
    } finally {
      btnSettingsSave.disabled = false;
      btnSettingsSave.textContent = '저장하기';
    }
  });
}

/* ── 테마 토글 버튼 (설정 화면) ───────────────────────── */
const btnThemeDark = $('#theme-dark');
const btnThemeLight = $('#theme-light');
if (btnThemeDark) btnThemeDark.addEventListener('click', () => setTheme('dark'));
if (btnThemeLight) btnThemeLight.addEventListener('click', () => setTheme('light'));

/* ── 초기 화면 결정 ───────────────────────────────────── */

(async function init() {
  try {
    // smoke 모드: 어느 화면을 보여줄지 조회
    const smokeTarget = await window.agentAPI.getSmokeScreenTarget();
    const smokeId = await window.agentAPI.getSmokeAgentId();

    if (smokeTarget === 'onboarding') {
      // 온보딩 화면 그대로 표시
      showScreen('screen-onboarding');
      goWizStep(1);
      await new Promise(r => setTimeout(r, 300));
      if (window.agentAPI.smokeReady) window.agentAPI.smokeReady();
      return;
    }

    if (smokeTarget === 'settings' && smokeId) {
      // 대화 화면 로드 후 설정 화면으로 전환 (smokeReady 억제 후 settings에서 발송)
      await openChatScreen(smokeId, true);
      openSettingsScreen();
      await new Promise(r => setTimeout(r, 400));
      if (window.agentAPI.smokeReady) window.agentAPI.smokeReady();
      return;
    }

    if (smokeTarget === 'abilities' && smokeId) {
      // 대화 화면 로드 후 능력 화면으로 전환 (smokeReady 억제 후 직접 발송)
      await openChatScreen(smokeId, true);
      openAbilitiesScreen();
      await new Promise(r => setTimeout(r, 400));
      if (window.agentAPI.smokeReady) window.agentAPI.smokeReady();
      return;
    }

    if (smokeTarget === 'notifications' && smokeId) {
      // 대화 화면 로드 후 알림 화면으로 전환 (smokeReady 억제 후 직접 발송)
      await openChatScreen(smokeId, true);
      openNotificationsScreen();
      await new Promise(r => setTimeout(r, 400));
      if (window.agentAPI.smokeReady) window.agentAPI.smokeReady();
      return;
    }

    if (smokeId) {
      // 기존 smoke 동작 (대화 화면)
      await openChatScreen(smokeId);
      return;
    }

    const agents = await window.agentAPI.listAgents();
    if (agents && agents.length > 0) {
      await openChatScreen(agents[0].id);
    } else {
      showScreen('screen-onboarding');
      goWizStep(1); // 3단계 wizard 시작
    }
  } catch (e) {
    console.error('[init] error:', e && e.message, e);
    showScreen('screen-onboarding');
    try { goWizStep(1); } catch (_) {}
    // smoke 모드에서 catch 시에도 신호 전송 (타임아웃 방지)
    try {
      if (window.agentAPI && window.agentAPI.smokeReady) window.agentAPI.smokeReady();
    } catch (_) {}
  }

  // ── 비차단 기억 추출 완료 이벤트 수신 (b 방식) ──────────────────
  // claude-subscription 두뇌가 백그라운드에서 기억을 추출하면 기억 패널 갱신
  if (window.agentAPI.onFactsUpdated) {
    window.agentAPI.onFactsUpdated(({ agentId, humanFacts }) => {
      if (!currentAgent || currentAgent.id !== agentId) return;
      currentAgent.humanFacts = humanFacts;
      renderFacts(humanFacts);

      // 기억이 추가됐음을 미묘하게 표시
      const countEl = $('#fact-count');
      if (countEl) {
        countEl.classList.add('facts-updated');
        setTimeout(() => countEl.classList.remove('facts-updated'), 2000);
      }
      console.log('[app] 기억 패널 갱신 — facts:', humanFacts.length);
    });
  }
})();

/* ── L1 일(Work) 섹션 ──────────────────────────────────── */

/** work 목록을 사이드바에 렌더링 */
function renderWork(work) {
  const list = $('#work-list');
  if (!list) return;
  list.innerHTML = '';
  if (!work) return;
  const all = [
    ...(work.projects || []).filter(p => p.status !== 'archived').map(p => ({ ...p, _kind: 'project' })),
    ...(work.routines || []).map(r => ({ ...r, _kind: 'routine' })),
  ];
  if (all.length === 0) {
    list.innerHTML = '<div style="font-size:11px;color:var(--text-muted);padding:4px 8px;">아직 없음</div>';
    return;
  }
  for (const item of all) {
    const div = document.createElement('div');
    div.className = 'work-item' + (work.activeId === item.id ? ' active' : '');
    div.dataset.id = item.id;
    const icon = item._kind === 'project' ? '📁' : '🔄';
    const statusText = item.status === 'done' ? '완료' : (item._kind === 'routine' ? `${item.runCount || 0}회` : '진행중');
    div.innerHTML = `<span class="work-item-icon">${icon}</span><span class="work-item-title">${escHtml(item.title)}</span><span class="work-item-status">${statusText}</span>`;
    div.addEventListener('click', async () => {
      if (!currentAgent) return;
      const newId = work.activeId === item.id ? null : item.id; // 같은 것 클릭 = 해제
      await window.agentAPI.setWorkActive(currentAgent.id, newId);
      work.activeId = newId;
      renderWork(work);
    });
    list.appendChild(div);
  }
}

/** 새 프로젝트 모달 열기 */
function openNewProjectModal() {
  const m = $('#modal-new-project');
  if (!m) return;
  const t = $('#new-project-title'); const g = $('#new-project-goal');
  if (t) t.value = ''; if (g) g.value = '';
  m.classList.remove('hidden');
  if (t) t.focus();
}

/** 새 루틴 모달 열기 */
function openNewRoutineModal() {
  const m = $('#modal-new-routine');
  if (!m) return;
  const t = $('#new-routine-title'); const r = $('#new-routine-rhythm');
  if (t) t.value = ''; if (r) r.value = '';
  m.classList.remove('hidden');
  if (t) t.focus();
}

// 버튼 이벤트
(function setupWorkUI() {
  const btnNP = $('#btn-new-project');
  if (btnNP) btnNP.addEventListener('click', openNewProjectModal);
  const btnNR = $('#btn-new-routine');
  if (btnNR) btnNR.addEventListener('click', openNewRoutineModal);

  // 프로젝트 생성
  const btnPC = $('#btn-project-create');
  if (btnPC) btnPC.addEventListener('click', async () => {
    const title = ($('#new-project-title').value || '').trim();
    const goal = ($('#new-project-goal').value || '').trim();
    if (!title) { $('#new-project-title').focus(); return; }
    if (!currentAgent) return;
    const modal = $('#modal-new-project');
    if (modal) modal.classList.add('hidden');
    const result = await window.agentAPI.sendMessage(currentAgent.id, `프로젝트를 시작할게. 제목: "${title}", 목표: "${goal || title}"`, []);
    if (result && !result.error) {
      const w = await window.agentAPI.getWork(currentAgent.id);
      if (w && w.work) { currentAgent.work = w.work; renderWork(w.work); }
    }
  });
  const btnPCa = $('#btn-project-cancel');
  if (btnPCa) btnPCa.addEventListener('click', () => { const m = $('#modal-new-project'); if(m) m.classList.add('hidden'); });

  // 루틴 생성
  const btnRC = $('#btn-routine-create');
  if (btnRC) btnRC.addEventListener('click', async () => {
    const title = ($('#new-routine-title').value || '').trim();
    const rhythm = ($('#new-routine-rhythm').value || '').trim();
    if (!title) { $('#new-routine-title').focus(); return; }
    if (!currentAgent) return;
    const modal = $('#modal-new-routine');
    if (modal) modal.classList.add('hidden');
    const msg = rhythm ? `루틴을 등록할게. 이름: "${title}", 리듬: "${rhythm}"` : `루틴을 등록할게. 이름: "${title}"`;
    const result = await window.agentAPI.sendMessage(currentAgent.id, msg, []);
    if (result && !result.error) {
      const w = await window.agentAPI.getWork(currentAgent.id);
      if (w && w.work) { currentAgent.work = w.work; renderWork(w.work); }
    }
  });
  const btnRCa = $('#btn-routine-cancel');
  if (btnRCa) btnRCa.addEventListener('click', () => { const m = $('#modal-new-routine'); if(m) m.classList.add('hidden'); });

  // 모달 외부 클릭 닫기
  ['modal-new-project', 'modal-new-routine'].forEach(id => {
    const m = document.getElementById(id);
    if (m) m.addEventListener('click', e => { if (e.target === m) m.classList.add('hidden'); });
  });
})();

// work:updated IPC → 사이드바 갱신
if (window.agentAPI && window.agentAPI.onWorkUpdated) {
  window.agentAPI.onWorkUpdated((data) => {
    if (currentAgent && data.agentId === currentAgent.id) {
      currentAgent.work = data.work;
      renderWork(data.work);
    }
  });
}

// 예약·하트비트 실행 결과를 채팅창에 실제 메시지로 표시(토스트만 뜨고 채팅 비던 문제 해결)
if (window.agentAPI && window.agentAPI.onScheduleResult) {
  window.agentAPI.onScheduleResult((data) => {
    if (!data || !data.text) return;
    const prefix = (data.kind === 'heartbeat' || !data.title) ? '' : `🔔 ${data.title}\n`;
    const msg = appendMessage('agent', prefix + data.text, true, Date.now());
    try { if (msg && msg.scrollIntoView) msg.scrollIntoView({ behavior: 'smooth', block: 'end' }); } catch (_) {}
  });
}

// 음성/영상/유튜브 처리 중 "받는 중" 안내 — 타이핑 인디케이터에 표시(aliveTimer가 이 값을 우선 노출).
let _chatStatusText = '';
if (window.agentAPI && window.agentAPI.onChatStatus) {
  window.agentAPI.onChatStatus(({ text }) => {
    _chatStatusText = text || '';
    const tEl = document.querySelector('#typing-indicator .thinking-text');
    if (tEl && _chatStatusText) tEl.textContent = _chatStatusText;
    const wEl = document.querySelector('.work-pulse');
    if (wEl && _chatStatusText) wEl.textContent = _chatStatusText;
  });
}

// 텔레그램·디스코드에서 온 대화를 앱 채팅창에 실시간 반영("통합 홈"). 지금 보고 있는 에이전트일 때만.
if (window.agentAPI && window.agentAPI.onChatIncoming) {
  window.agentAPI.onChatIncoming(({ agentId, userMessage, response }) => {
    if (!currentAgent || currentAgent.id !== agentId) return;
    if (userMessage) appendMessage('user', userMessage, true, Date.now());
    if (response) {
      const m = appendMessage('agent', response, true, Date.now());
      try { if (m && m.scrollIntoView) m.scrollIntoView({ behavior: 'smooth', block: 'end' }); } catch (_) {}
    }
  });
}
