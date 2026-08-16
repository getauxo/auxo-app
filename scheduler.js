/**
 * scheduler.js — 자율 백그라운드(정기 실행) 코어.
 *
 * "PC 켜진 동안, 정한 시각/주기에 에이전트가 알아서 일한다." (로컬 전용)
 *  - 스케줄 저장: agent.schedules = [{id, title, kind, at/everyMin/atMin, prompt, channel, enabled, lastRunAt}]
 *  - 이 코어는 "지금 실행할 스케줄"만 판정(순수 함수, 테스트 쉬움). 실제 실행/전달은 호출자(앱·CLI)가.
 *  - now 는 타임스탬프(ms)를 인자로 받는다(테스트 위해 Date.now 직접 안 씀).
 */
'use strict';

const DAY = 86400000;

/** 한 스케줄이 now 시점에 실행돼야 하나. */
// ── 날짜·달 ──────────────────────────────────────────────────────────
//   ★주 단위와 같은 축. 월·년 주기가 없으면
//   월세·카드값·월 정산 같은 **월 단위 생활**과 생일·기념일 같은 **연 단위**를 표현할 수 없었다.
//   생일·기념일은 "나를 기억하는 AI" 라는 제품 성격에서 특히 중요하다 —
//   지금은 `once` 로 한 번 걸고 끝나서 **내년엔 아무도 안 챙긴다.**
const MON_NAME = ['', 'jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
const _MON = {}; MON_NAME.forEach((m, i) => { if (m) _MON[m] = i; });

/** 그 달의 마지막 날(28~31). */
function lastDayOf(year, month0) { return new Date(year, month0 + 1, 0).getDate(); }

/**
 * 그 달에 실제로 걸리는 날짜.
 * ★없는 날이면 **그 달 마지막 날로 당긴다**(건너뛰지 않는다).
 *   예: 매월 31일 → 2월엔 28·29일 / 매년 2월 29일 → 평년엔 2월 28일.
 *   건너뛰면 2월 월세 알림이 조용히 안 온다 — 하루 당겨 오는 편이 낫다.
 */
function domInMonth(dom, year, month0) {
  const last = lastDayOf(year, month0);
  if (dom === 'last') return last;
  const n = Number(dom);
  if (!Number.isInteger(n) || n < 1) return last;
  return Math.min(n, last);
}

/** 날짜 표기를 1~31 또는 'last' 로. "31"·"31일"·"말일"·"마지막"·"last" 다 받는다. 못 알아들으면 null. */
function normDom(v) {
  if (v === undefined || v === null || v === '') return null;
  const s = String(v).trim().toLowerCase();
  if (/^(last|말일|마지막|마지막날|월말)$/.test(s)) return 'last';
  const n = Number(s.replace(/일$/, ''));
  if (Number.isInteger(n) && n >= 1 && n <= 31) return n;
  return null;
}

/** 달 표기를 1~12 로. "3"·"3월"·"mar"·"March" 다 받는다. 못 알아들으면 null. */
function normMonth(v) {
  if (v === undefined || v === null || v === '') return null;
  const s = String(v).trim().toLowerCase().replace(/월$/, '');
  const n = Number(s);
  if (Number.isInteger(n) && n >= 1 && n <= 12) return n;
  const k3 = s.slice(0, 3);
  if (k3 in _MON) return _MON[k3];
  return null;
}

function isDue(s, now) {
  if (!s || s.enabled === false) return false;
  const d = new Date(now);
  const sameDay = (a, b) => new Date(a).toDateString() === new Date(b).toDateString();

  if (s.kind === 'interval') {                 // N분마다
    const ms = Math.max(1, s.everyMin || 60) * 60000;
    if (!s.lastRunAt) return true;
    return (now - s.lastRunAt) >= ms;
  }
  if (s.kind === 'daily') {                     // 매일 HH:MM
    const [h, m] = String(s.at || '09:00').split(':').map(Number);
    if (d.getHours() !== h || d.getMinutes() !== m) return false;
    if (s.lastRunAt && sameDay(s.lastRunAt, now)) return false; // 오늘 이미 실행
    return true;
  }
  if (s.kind === 'weekly') {                    // 매주 <요일> HH:MM
    if (d.getDay() !== s.dow) return false;
    const [h, m] = String(s.at || '09:00').split(':').map(Number);
    if (d.getHours() !== h || d.getMinutes() !== m) return false;
    if (s.lastRunAt && sameDay(s.lastRunAt, now)) return false; // 오늘 이미 실행
    return true;
  }
  if (s.kind === 'monthly') {                   // 매월 <N일|말일> HH:MM
    if (d.getDate() !== domInMonth(s.dom, d.getFullYear(), d.getMonth())) return false;
    const [h, m] = String(s.at || '09:00').split(':').map(Number);
    if (d.getHours() !== h || d.getMinutes() !== m) return false;
    if (s.lastRunAt && sameDay(s.lastRunAt, now)) return false;
    return true;
  }
  if (s.kind === 'yearly') {                    // 매년 <M월> <N일|말일> HH:MM
    if (d.getMonth() + 1 !== s.month) return false;
    if (d.getDate() !== domInMonth(s.dom, d.getFullYear(), d.getMonth())) return false;
    const [h, m] = String(s.at || '09:00').split(':').map(Number);
    if (d.getHours() !== h || d.getMinutes() !== m) return false;
    if (s.lastRunAt && sameDay(s.lastRunAt, now)) return false;
    return true;
  }
  if (s.kind === 'hourly') {                    // 매시 atMin분(기본 0분)
    const mm = s.atMin != null ? s.atMin : 0;
    if (d.getMinutes() !== mm) return false;
    if (s.lastRunAt) { const l = new Date(s.lastRunAt); if (l.getHours() === d.getHours() && sameDay(s.lastRunAt, now)) return false; }
    return true;
  }
  if (s.kind === 'once') {                       // 특정 시각 1회 (atMs)
    if (s.lastRunAt) return false;
    return now >= (s.atMs || 0) && now < (s.atMs || 0) + 2 * 60000; // 2분 창
  }
  return false;
}

/** now 시점에 실행할 스케줄들. */
function dueSchedules(schedules, now) {
  return (Array.isArray(schedules) ? schedules : []).filter(s => isDue(s, now));
}

// ── 요일 ─────────────────────────────────────────────────────────────
//   ★주 단위가 없으면(once/daily/hourly/interval 넷뿐)
//   "매주 화요일 원두 받고 재고 세기" 같은 흔한 생활 주기를 표현할 수 없었다.
//   에이전트가 실대화에서 스스로 한계를 말했다 — *"내 예약은 주 단위가 없어서,
//   매일 걸어두고 화요일에만 뜨게 하는 식으로 잡으면 돼."*
//   그 우회는 나머지 6일에 두뇌를 헛되이 부르고, "조용히 종료" 응답이 대화에 매일 쌓인다.
const DOW_NAME = ['일', '월', '화', '수', '목', '금', '토'];
const _DOW = {
  일: 0, 월: 1, 화: 2, 수: 3, 목: 4, 금: 5, 토: 6,
  sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6,
};
/** 요일 표기를 0~6 으로. 숫자·"화"·"화요일"·"tue"·"Tuesday" 다 받는다. 못 알아들으면 null. */
function normDow(v) {
  if (v === undefined || v === null || v === '') return null;
  const n = Number(v);
  if (Number.isInteger(n) && n >= 0 && n <= 6) return n;
  const s = String(v).trim().toLowerCase().replace(/요일$/, '');
  if (s in _DOW) return _DOW[s];
  const k3 = s.slice(0, 3);
  if (k3 in _DOW) return _DOW[k3];
  return null;
}

/** 사람이 읽는 주기 설명. */
function describe(s) {
  if (!s) return '';
  if (s.kind === 'interval') return `${s.everyMin || 60}분마다`;
  if (s.kind === 'daily') return `매일 ${s.at || '09:00'}`;
  if (s.kind === 'weekly') return `매주 ${DOW_NAME[s.dow] || '?'}요일 ${s.at || '09:00'}`;
  if (s.kind === 'monthly') return `매월 ${s.dom === 'last' ? '말일' : s.dom + '일'} ${s.at || '09:00'}`;
  if (s.kind === 'yearly') return `매년 ${s.month}월 ${s.dom === 'last' ? '말일' : s.dom + '일'} ${s.at || '09:00'}`;
  if (s.kind === 'hourly') return `매시 ${s.atMin != null ? s.atMin : 0}분`;
  if (s.kind === 'once') return `한 번 (${new Date(s.atMs || 0).toLocaleString()})`;
  return s.kind || '';
}

/**
 * 등록할 때 **미리 알려야 할 단서**. 없으면 ''.
 *
 * 왜: *"매월 30일은? 2월엔 30일도 없잖아."*
 *   맞다 — 29·30·31일은 달에 따라 당겨진다. 그런데 `describe()` 는 *"매월 30일"* 이라고만 하니
 *   사용자는 **2월에 28일에 오는 걸 모른다.** 알림이 예상과 다른 날 오면 그것대로 혼란이다.
 *   → 그 날짜가 실제로 당겨지는 달이 있을 때만 한 줄 붙인다. 25일 같은 건 아무 말 안 한다.
 *
 * ※ 겹침은 감수한다: 2월엔 "매월 30일"과 "매월 31일"이 **같은 28일에** 온다.
 *   월세·카드값은 **안 오는 게 훨씬 큰 손해**라 겹쳐도 둘 다 보내는 쪽이 맞다.
 */
function caveat(s) {
  if (!s || (s.kind !== 'monthly' && s.kind !== 'yearly')) return '';
  if (s.dom === 'last') return '';                       // "말일"은 말 자체가 뜻을 담고 있다
  const n = Number(s.dom);
  if (!Number.isInteger(n) || n <= 28) return '';        // 28일 이하는 어느 달에나 있다
  // 평년·윤년 둘 다 놓고, 실제로 당겨지는 달을 찾는다(규칙을 두 번 적지 않으려고 domInMonth 를 그대로 쓴다).
  const 달들 = s.kind === 'yearly' ? [Number(s.month) - 1] : [...Array(12).keys()];
  const 당겨짐 = [];
  for (const m0 of 달들) {
    if (m0 < 0 || m0 > 11) continue;
    for (const y of [2027, 2028]) {                      // 2027=평년, 2028=윤년
      if (domInMonth(n, y, m0) !== n) { 당겨짐.push(m0 + 1); break; }
    }
  }
  if (!당겨짐.length) return '';
  if (s.kind === 'yearly') {
    return n === 29 && Number(s.month) === 2
      ? ' 2월 29일이 없는 해엔 28일에 갈게.'
      : ` ${s.month}월엔 ${n}일이 없어서 그 달 마지막 날에 갈게.`;
  }
  return ` ${당겨짐.join('·')}월처럼 그 날짜가 없는 달엔 그 달 마지막 날에 갈게.`;
}

/**
 * now 시점에 due 한 스케줄들을 실행한다(틱 1회). 의존은 주입(테스트 쉬움).
 * @param {string} agentId
 * @param {number} now  타임스탬프(ms)
 * @param {object} deps { loadAgent, saveAgent, runTurn(agentId,prompt)->{response}, deliver(channel,text,sched) }
 * @returns {Promise<Array>} 실행된 [{id,title,channel,ok}]
 */
async function runDueSchedules(agentId, now, deps) {
  const ag = deps.loadAgent(agentId);
  if (!ag) return [];
  const due = dueSchedules(ag.schedules, now);
  const ran = [];
  for (const s of due) {
    let ok = false, text = '';
    try {
      // ★세 번째 인자 = **대화에 남길 표시**.
      //   `s.prompt` 는 에이전트가 자기 자신에게 쓴 메모다("…확인해라. 아니면 조용히 종료해라").
      //   그걸 그대로 넘기면 engine 이 **사용자가 한 말**로 저장한다.
      //   사용자는 자기가 안 한 명령조 문장을 자기 말로 보게 되고, 그게 **매 턴 두뇌에게 실려**
      //   "이 사용자는 나한테 명령조로 말한다"는 인상을 준다. 매일 도는 예약이면 매일 쌓인다.
      const r = await deps.runTurn(agentId, s.prompt, `[예약] ${s.title || '알림'}`);
      text = (r && (r.response || r.error)) || '';
      await deps.deliver(s.channel, text, s);
      ok = true;
    } catch (e) { text = '실행 오류: ' + (e && e.message); }
    // lastRunAt 갱신(신선 로드 — 실행 중 바뀌었을 수 있음)
    try {
      const fresh = deps.loadAgent(agentId);
      const t = (fresh.schedules || []).find(x => x.id === s.id);
      if (t) { t.lastRunAt = now; deps.saveAgent(fresh); }
    } catch (_) {}
    ran.push({ id: s.id, title: s.title, channel: s.channel, ok });
  }
  return ran;
}

/** schedule_task 인자 → 스케줄 객체(공통 — agent-tools·auxo-mcp 둘 다 사용). */
function createSchedule(args) {
  const a = args || {};
  const kind = ['daily', 'weekly', 'monthly', 'yearly', 'hourly', 'interval', 'once'].includes(a.kind) ? a.kind : 'daily';
  // 주기에 꼭 필요한 값이 없으면 **조용히 daily 로 떨어뜨리지 않는다.**
  //   그러면 매일 울려서 사용자가 "왜 매일 오지" 하게 되고, 원인을 알 길이 없다. 되물어야 한다.
  if (kind === 'weekly' && normDow(a.dow) === null) {
    return { error: '몇 요일인지 알려줘 (예: 화요일). 주 단위 예약은 요일이 있어야 걸 수 있어.' };
  }
  if (kind === 'monthly' && normDom(a.dom) === null) {
    return { error: '며칠인지 알려줘 (예: 25일, 또는 "말일"). 월 단위 예약은 날짜가 있어야 걸 수 있어.' };
  }
  if (kind === 'yearly' && (normMonth(a.month) === null || normDom(a.dom) === null)) {
    return { error: '몇 월 며칠인지 알려줘 (예: 3월 5일). 해마다 오는 예약은 달과 날짜가 둘 다 있어야 걸 수 있어.' };
  }
  const s = {
    id: 'sch-' + Date.now() + '-' + Math.random().toString(36).slice(2, 6),
    title: String(a.title || '').trim(), kind, prompt: String(a.prompt || '').trim(),
    channel: a.channel || 'app', enabled: true, createdAt: new Date().toISOString(), lastRunAt: null,
  };
  if (kind === 'daily') s.at = /^\d{1,2}:\d{2}$/.test(a.at || '') ? a.at : '09:00';
  else if (kind === 'weekly') {
    s.at = /^\d{1,2}:\d{2}$/.test(a.at || '') ? a.at : '09:00';
    s.dow = normDow(a.dow);
  }
  else if (kind === 'monthly') {
    s.at = /^\d{1,2}:\d{2}$/.test(a.at || '') ? a.at : '09:00';
    s.dom = normDom(a.dom);
  }
  else if (kind === 'yearly') {
    s.at = /^\d{1,2}:\d{2}$/.test(a.at || '') ? a.at : '09:00';
    s.month = normMonth(a.month);
    s.dom = normDom(a.dom);
  }
  else if (kind === 'interval') s.everyMin = Math.max(1, Number(a.everyMin) || 60);
  else if (kind === 'hourly') s.atMin = 0;
  else if (kind === 'once') {                    // 특정 시각 1회(리마인더)
    s.at = a.at; if (a.date) s.date = String(a.date).trim();
    s.atMs = _onceAtMs(a.at, a.atMs, a.date);
    // 지난 시각에 걸면 **영영 오지 않는다**(isDue 는 그 시각부터 2분 창만 본다).
    // 조용히 안 오는 게 제일 나쁘다 → 되묻게 한다.
    if (s.atMs <= Date.now()) {
      return { error: `${new Date(s.atMs).toLocaleString('ko-KR')}은(는) 이미 지난 시각이야. 언제로 할지 다시 알려줘.` };
    }
  }
  return s;
}
/**
 * once 용 절대 시각(ms). 우선순위 = ①date+at → ②atMs → ③at.
 *
 * ★①이 최우선인 이유 — **두뇌에게 epoch 밀리초를 계산시키면 틀린다.**
 *   실측(2026-08-14, 같은 요청 "다음 주 금요일 오후 2시"):
 *     · gemini  4/4 전부 빗나감 (-13.3시간 · +9.7시간 · -6.3시간 …). 답변으로는 "8월 21일 오후 2시"라고
 *       정확히 말하면서 atMs 만 어긋났다 — **날짜는 맞히고 13자리 산술에서 틀린다.**
 *     · codex   3/3 정확.
 *   되는 두뇌가 있다고 설계가 맞는 건 아니다. 사용자는 두뇌를 고를 뿐인데 알림이 엉뚱한 때 온다.
 *   → 두뇌는 사람이 읽는 값("2026-08-21", "14:00")만 대고, **변환은 코드가 한다.** 그러면 아무도 못 틀린다.
 * ②atMs 는 옛 예약·다른 경로 호환으로 계속 받는다(도구 선언에서는 뺐다).
 */
function _onceAtMs(at, atMs, date) {
  const hm = /^(\d{1,2}):(\d{2})$/.exec(String(at || '').trim());
  const ymd = /^(\d{4})[-/.]?(\d{1,2})[-/.]?(\d{1,2})$/.exec(String(date || '').trim());
  if (ymd) {
    const d = new Date(Number(ymd[1]), Number(ymd[2]) - 1, Number(ymd[3]));
    // 날짜가 있는데 시각이 없으면 오전 9시(사람이 "그날"이라고만 할 때의 상식적 기본).
    d.setHours(hm ? Number(hm[1]) : 9, hm ? Number(hm[2]) : 0, 0, 0);
    if (d.getMonth() === Number(ymd[2]) - 1) return d.getTime();  // 2월 30일 같은 없는 날짜는 버린다
  }
  const abs = Number(atMs);
  if (Number.isFinite(abs) && abs > 0) return abs;
  if (!hm) return Date.now() + 60000; // 파싱 실패 → 1분 뒤(안전 기본)
  const d = new Date(); d.setHours(Number(hm[1]), Number(hm[2]), 0, 0);
  let t = d.getTime();
  if (t <= Date.now()) t += 24 * 3600000; // 이미 지난 시각이면 내일로
  return t;
}

// ── 하트비트(먼저 말 걸기) — 하루 2회(아침·저녁) 고정 시각. 동반자 차별점. ──
// ⚠️ 현재 보류(전역 OFF). 이유: 맥락 없는 기계적 안부·내부 프롬프트 노출 버그·게이트 부재로 미성숙.
// 재도입 조건: ①하트비트-기억 연결(무엇을 왜 꺼낼지) 제대로 ②게이트(최근 상호작용·최소 대화 수) ③노출버그 근본수정(지시문을 대화 user로 저장하지 않기) ④정직 톤. 상세=HANDOFF/설계문서.
const HEARTBEAT_ENABLED = false; // 이 플래그를 true로 켜기 전, 위 재도입 조건 먼저 충족할 것.
const HB_DEFAULT = { enabled: false, morning: '09:30', evening: '19:00', channel: 'telegram' };
const HB_PROMPTS = {
  morning: '지금은 아침이야. 사용자가 말 건 게 아니라, 네가 먼저 다정하게 안부를 건네는 상황이야. 챙길 기억(약속·일정·고민)이 있으면 그걸 자연스럽게 언급해. 없으면 web_search로 오늘 날씨를 알아보고 가볍게 알려주며 안부를 물어. 짧고 따뜻하게, 매번 다른 멘트로(한두 문장).',
  evening: '지금은 저녁이야. 네가 먼저 사용자에게 오늘 하루 어땠는지 다정하게 물어보는 상황이야. 챙길 기억이 있으면 그것 기반으로(예: "오늘 발표 어땠어?"). 짧고 따뜻하게, 매번 다른 멘트로(한두 문장).',
};
// 하트비트는 특히 자연스러워야 한다 — 자기가 기기·프로그램이라는 식의 기계적 표현 금지.
const HB_TONE = ' 사람 친구처럼 자연스럽게 말해. 자기가 기기·프로그램·시스템·앱이라거나 "곁에서 기다렸다" 같은 기계적·작위적 표현은 쓰지 마.';
function _hb(agent) { return Object.assign({}, HB_DEFAULT, (agent && agent.heartbeat) || {}); }

/** 예약 취소·조회용 유연 매칭: id 정확 → 제목 정확 → 부분 포함 → 키워드. 자연어로도 찾게. */
function matchSchedules(schedules, query) {
  const list = (schedules || []).filter(s => s && s.enabled !== false);
  const raw = String(query || '').trim();
  const q = raw.toLowerCase();
  if (!q) return [];
  let m = list.filter(s => s.id === raw);
  if (!m.length) m = list.filter(s => String(s.title || '').toLowerCase() === q);
  if (!m.length) m = list.filter(s => { const t = String(s.title || '').toLowerCase(); return t && (t.includes(q) || q.includes(t)); });
  if (!m.length) { const toks = q.split(/\s+/).filter(t => t.length >= 2); m = list.filter(s => { const t = String(s.title || '').toLowerCase(); return toks.some(tok => t.includes(tok)); }); }
  return m;
}

/** now 시점에 보낼 하트비트 종류(morning/evening). 시각 일치 + 오늘 아직 안 보냄. */
function dueHeartbeats(agent, now) {
  if (!HEARTBEAT_ENABLED) return []; // 전역 보류 — 기존 데이터가 켜져 있어도 돌지 않게(노출버그까지 차단)
  const hb = _hb(agent);
  if (!hb.enabled) return [];
  const d = new Date(now);
  const hhmm = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  const sameDay = (a) => a && new Date(a).toDateString() === d.toDateString();
  const out = [];
  if (hhmm === hb.morning && !sameDay(hb.lastMorning)) out.push('morning');
  if (hhmm === hb.evening && !sameDay(hb.lastEvening)) out.push('evening');
  return out;
}

async function runDueHeartbeats(agent, now, deps) {
  const kinds = dueHeartbeats(agent, now);
  if (!kinds.length) return [];
  const ran = [];
  for (const kind of kinds) {
    const h0 = _hb(deps.loadAgent(agent.id) || agent);
    let prompt = HB_PROMPTS[kind] + HB_TONE;
    if (!h0.introSent) prompt += ` 이게 네가 처음 먼저 거는 인사니, "가끔 이렇게 아침·저녁으로 먼저 안부 물을게요, 부담되면 '그만'이라고 해줘요" 정도를 자연스럽게 한 번만 곁들여.`;
    try {
      // 하트비트도 같은 이유로 표시를 넘긴다. 지금은 전역 OFF 지만 재도입 조건에
      //   *"지시문을 대화 user 로 저장하지 않기"* 가 적혀 있다 — 그게 바로 이것이다.
      const r = await deps.runTurn(agent.id, prompt, `[먼저 안부] ${kind === 'morning' ? '아침' : '저녁'}`);
      const text = (r && (r.response || r.error)) || '';
      // agentId·agentName 을 함께 실어 보낸다 — 먼저 거는 안부는 '🔔 예약' 라벨 대신
      //   **에이전트 이름**으로 뜨는 게 자연스러워서 채널이 이름을 필요로 한다(CLI 가 그렇다).
      //   전엔 안 넘겨서 CLI 가 자기 스코프에 없는 변수를 참조했다 — 하트비트가 전역 OFF 라
      //   재도입하면 CLI 안부가 통째로 사라질 자리다.
      await deps.deliver(_hb(agent).channel, text, {
        title: kind === 'morning' ? '아침 인사' : '저녁 인사', kind: 'heartbeat',
        agentId: agent.id, agentName: agent.name || '',
      });
      const fresh = deps.loadAgent(agent.id);
      if (fresh) { fresh.heartbeat = Object.assign(_hb(fresh), { [kind === 'morning' ? 'lastMorning' : 'lastEvening']: now, introSent: true }); deps.saveAgent(fresh); }
      ran.push({ heartbeat: kind, id: agent.id });
    } catch (_) {}
  }
  return ran;
}

/** 모든 에이전트의 due 스케줄 + 하트비트를 1회 처리(앱·CLI 공통 틱). */
async function tick(now, deps) {
  const agents = (deps.loadAllAgents && deps.loadAllAgents()) || [];
  const ran = [];
  for (const ag of agents) {
    if (!ag) continue;
    if (Array.isArray(ag.schedules) && ag.schedules.length) {
      try { ran.push(...await runDueSchedules(ag.id, now, deps)); } catch (_) {}
    }
    try { ran.push(...await runDueHeartbeats(ag, now, deps)); } catch (_) {}
  }
  return ran;
}

module.exports = { isDue, dueSchedules, describe, caveat, runDueSchedules, createSchedule, tick, dueHeartbeats, runDueHeartbeats, matchSchedules, HB_DEFAULT, DAY };
