/**
 * agent-queue.js — 에이전트별 처리 직렬화
 *
 * 왜 필요한가:
 *   사용자는 답을 기다리지 않고 말을 이어 붙인다. ("서대문역 근처" → "시간은 저녁 6~7시")
 *   두 요청이 동시에 두뇌를 부르면, 뒤 요청은 앞 메시지를 보지 못한 채 답한다.
 *   실제로 2026-07-10 테스터가 지역을 알려줬는데 "지역을 아직 안 알려주셨어요"라는
 *   답을 받았다. 게다가 늦게 끝난 요청이 대화를 통째로 덮어써 메시지가 사라졌다.
 *
 * 무엇을 하나:
 *   같은 agentId 의 작업을 "한 번에 하나씩" 순서대로 실행한다.
 *   덕분에 두 번째 메시지는 첫 번째 답변까지 본 상태에서 처리된다.
 *   서로 다른 에이전트는 서로를 기다리지 않는다.
 *
 * 채널 무관(앱·텔레그램·디스코드·CLI)으로 같은 잠금을 쓴다.
 * 단 CLI 는 별도 프로세스라 자기 프로세스 안에서만 유효하다(각 채널이 제 프로세스를 직렬화).
 */

const chains = new Map(); // agentId → 마지막 작업의 Promise

/**
 * 같은 agentId 의 작업을 순서대로 실행한다.
 * @param {string} agentId
 * @param {() => Promise<any>} task
 * @returns {Promise<any>} task 의 결과(또는 예외)
 */
function runExclusive(agentId, task) {
  const key = String(agentId);
  const prev = chains.get(key) || Promise.resolve();

  // 앞 작업이 실패해도 뒤 작업은 실행돼야 한다 → catch 로 흡수한 뒤 이어붙인다.
  const run = prev.then(() => task(), () => task());

  // 체인에는 "성공/실패 무관하게 끝났다"는 사실만 남긴다.
  const settled = run.then(() => {}, () => {});
  chains.set(key, settled);

  // 대기열이 비면 Map 에서 지운다(에이전트가 많아도 메모리가 새지 않게).
  settled.then(() => {
    if (chains.get(key) === settled) chains.delete(key);
  });

  return run;
}

/** 지금 이 에이전트가 처리 중인 작업이 있는가(테스트·진단용). */
function isBusy(agentId) {
  return chains.has(String(agentId));
}

module.exports = { runExclusive, isBusy };
