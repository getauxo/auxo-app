/**
 * subagents.js — 서브에이전트(임시 일꾼) 실행.
 *
 * 메인 에이전트가 규모 있는/병렬 작업을 여러 임시 일꾼에게 나눠 시킨다.
 * 일꾼은 같은 두뇌(generate)로 한 부분만 처리하고 결과를 돌려준 뒤 소멸한다.
 *
 * 안전 규칙:
 *  - 한 라운드 최대 5명(MAX_WORKERS)
 *  - 워커당 타임아웃 3분(WORKER_TIMEOUT_MS)
 *  - 깊이 1: 워커 generate 에 도구를 주지 않음 → 워커는 위임 도구를 못 써서 서브의 서브 생성 불가
 *  - 워커는 기억을 저장하지 않음(임시 존재)
 */
'use strict';

const MAX_WORKERS = 5;            // 한 라운드(delegate 1회) 최대 일꾼 수
const WORKER_TIMEOUT_MS = 180000; // 3분
const WORKER_TIMEOUT_MAX_MS = 300000; // 5분 상한

// 이어가기(v2) 한 턴 누적 한도. 기본=승인 필요(1라운드), 자율(사용자 위임)=가드레일까지.
const CAP_APPROVAL = 5;   // 기본: 5명 쓰면 멈추고 사용자 승인 요구
const CAP_AUTO = 20;      // 자율: "끝까지" 위임 시 누적 20명까지 자동
const NO_PROGRESS_ROUNDS = 2; // 결과 없는 라운드가 이만큼 연속이면 중단

const WORKER_SYS = `너는 메인 에이전트가 부린 "임시 일꾼"이야.
아래에 주어진 '맡은 작업' 하나만 처리해서 결과를 돌려줘.

규칙:
- 간결하고 정확하게, 결과 위주로 답해.
- 인사·자기소개·잡담 없이 작업 결과만.
- 너는 임시 존재라 기억을 저장하지 않고, 다른 일꾼을 만들 수도 없어.
- 작업에 필요한 정보가 부족하면, 추측한 부분을 분명히 밝혀.`;

/**
 * tasks 를 같은 generate 로 병렬(≤max) 처리한다.
 * @param {function} generate (sys, usr, opts) => Promise<text>  — 메인과 같은 두뇌
 * @param {string[]} tasks    각 일꾼에게 맡길 작업 설명
 * @param {object}   [opts]   { emit, timeout, max }
 * @returns {Promise<Array<{n,task,ok,result?,error?}>>}
 */
async function runWorkers(generate, tasks, { emit = () => {}, timeout = WORKER_TIMEOUT_MS, max = MAX_WORKERS } = {}) {
  const limited = (Array.isArray(tasks) ? tasks : [])
    .map(t => String(t || '').trim()).filter(Boolean).slice(0, max);
  if (!limited.length) return [];
  const ms = Math.min(Math.max(Number(timeout) || WORKER_TIMEOUT_MS, 1000), WORKER_TIMEOUT_MAX_MS);

  emit('workers-start', { count: limited.length, tasks: limited });

  const withTimeout = (p, t) => Promise.race([
    p,
    new Promise((_, rej) => setTimeout(() => rej(new Error(`시간 초과(${Math.round(t / 1000)}초)`)), t)),
  ]);

  // 동시 실행(최대 max=5). cap 이 작아 단순 Promise.all 로 충분.
  const results = await Promise.all(limited.map(async (task, i) => {
    const n = i + 1;
    emit('worker-start', { n, task });
    try {
      const out = await withTimeout(generate(WORKER_SYS, task, { timeout: ms }), ms);
      const result = String(out || '').trim();
      emit('worker-done', { n, ok: true });
      return { n, task, ok: true, result };
    } catch (e) {
      emit('worker-done', { n, ok: false, error: e.message });
      return { n, task, ok: false, error: e.message };
    }
  }));

  emit('workers-done', { count: results.length, ok: results.filter(r => r.ok).length });
  return results;
}

/**
 * 이번 delegate 호출에서 실제로 몇 명을 돌릴지 계산(이어가기 누적 한도 + 한 라운드 5명 cap).
 * @returns {{allowed:number, limitReached:boolean, truncated:number}}
 */
function planRound(used, cap, requested) {
  const want = Math.max(0, requested | 0);          // 원 요청 수
  const perRound = Math.min(want, MAX_WORKERS);      // 한 라운드 상한(5)
  const remaining = Math.max(0, cap - used);         // 누적 한도 잔여
  if (remaining <= 0) return { allowed: 0, limitReached: true, truncated: want };
  const allowed = Math.min(perRound, remaining);
  return { allowed, limitReached: false, truncated: want - allowed }; // 이번에 못 돌린 전부
}

/** 사용자 메시지에서 "끝까지 자율 진행" 위임 의도를 감지(자율 모드 트리거). */
function detectAutonomous(userMessage) {
  const m = String(userMessage || '');
  return /(끝까지|완료까지|끝날\s*때까지).*(진행|해|가|마무리)/.test(m)
    || /(캡|한도|제한).*(걸려도|상관\s*없|무시|넘어도)/.test(m)
    || /승인\s*(없이|필요\s*없)/.test(m)
    || /(알아서|네가)\s*(끝까지|완료|다)\s*(해|진행|처리)/.test(m);
}

module.exports = {
  runWorkers, WORKER_SYS, detectAutonomous, planRound,
  MAX_WORKERS, WORKER_TIMEOUT_MS, WORKER_TIMEOUT_MAX_MS,
  CAP_APPROVAL, CAP_AUTO, NO_PROGRESS_ROUNDS,
};
