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

/** 사람이 읽는 주기 설명. */
function describe(s) {
  if (!s) return '';
  if (s.kind === 'interval') return `${s.everyMin || 60}분마다`;
  if (s.kind === 'daily') return `매일 ${s.at || '09:00'}`;
  if (s.kind === 'hourly') return `매시 ${s.atMin != null ? s.atMin : 0}분`;
  if (s.kind === 'once') return `한 번 (${new Date(s.atMs || 0).toLocaleString()})`;
  return s.kind || '';
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
      const r = await deps.runTurn(agentId, s.prompt);
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
  const kind = ['daily', 'hourly', 'interval', 'once'].includes(a.kind) ? a.kind : 'daily';
  const s = {
    id: 'sch-' + Date.now() + '-' + Math.random().toString(36).slice(2, 6),
    title: String(a.title || '').trim(), kind, prompt: String(a.prompt || '').trim(),
    channel: a.channel || 'app', enabled: true, createdAt: new Date().toISOString(), lastRunAt: null,
  };
  if (kind === 'daily') s.at = /^\d{1,2}:\d{2}$/.test(a.at || '') ? a.at : '09:00';
  else if (kind === 'interval') s.everyMin = Math.max(1, Number(a.everyMin) || 60);
  else if (kind === 'hourly') s.atMin = 0;
  else if (kind === 'once') { s.at = a.at; s.atMs = _onceAtMs(a.at, a.atMs); } // 특정 시각 1회(리마인더)
  return s;
}
/** once용 절대 시각(ms). atMs 직접 주면 그것, 아니면 at="HH:MM"을 오늘 그 시각으로(이미 지났으면 내일). */
function _onceAtMs(at, atMs) {
  const abs = Number(atMs);
  if (Number.isFinite(abs) && abs > 0) return abs;
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(at || '').trim());
  if (!m) return Date.now() + 60000; // 파싱 실패 → 1분 뒤(안전 기본)
  const d = new Date(); d.setHours(Number(m[1]), Number(m[2]), 0, 0);
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
      const r = await deps.runTurn(agent.id, prompt);
      const text = (r && (r.response || r.error)) || '';
      await deps.deliver(_hb(agent).channel, text, { title: kind === 'morning' ? '아침 인사' : '저녁 인사', kind: 'heartbeat' });
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

module.exports = { isDue, dueSchedules, describe, runDueSchedules, createSchedule, tick, dueHeartbeats, runDueHeartbeats, matchSchedules, HB_DEFAULT, DAY };
