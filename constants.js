/**
 * constants.js — 여러 두뇌·모듈이 공유하는 값 한 곳.
 *
 * 원칙: 여러 곳에 같은 값을 하드코딩하지 않는다(누락·드리프트 방지).
 *       공통으로 쓰는 값은 여기서만 정의하고, 각 파일은 import 해서 쓴다.
 */

module.exports = {
  // 구독 CLI 두뇌(claude·codex)의 대화 응답 타임아웃(ms).
  // thinking+MCP 왕복이 있는 무거운 턴의 상한. 그 이상은 대개 hang이라 실패시키는 게 UX상 낫다.
  // (구독 CLI 는 60초로는 부족하다 — SIGTERM 로그로 확증. 3종을 같은 값으로 맞춘다)
  // 기억 처리(extract·consolidate 등)는 각 호출부가 opts.timeout으로 따로 지정한다.
  SUBSCRIPTION_TURN_TIMEOUT_MS: 240000,
};
