'use strict';
/**
 * grants.js — **폴더·터미널 허락을 다루는 유일한 자리.**
 *
 * ── 왜 만드나 (2026-08-21) ─────────────────────────────────────────────
 * "허락 대기"를 거는 코드가 **7곳**에 흩어져 있었다 —
 *     agent-tools.js     3곳 (폴더 · run_shell · run_code)
 *     auxo-mcp-tools.js  3곳 (같은 것을 구독 두뇌용으로 다시)
 *     engine.js          1곳 (2026-08-21 에 내가 또 하나 만들었다)
 *
 * 따로 만들었으니 따로 어긋났다 — 문구부터 갈라져 있었다:
 *     agent-tools : "…아직 **허용되지 않았어**"
 *     auxo-mcp    : "…아직 **허용 안 됐어**"
 * 같은 상황인데 **채널마다 다른 말**이 나가고 있었다.
 *
 * 같은 병을 이미 두 번 앓았다 — 도구 설명이 두 벌로 갈라진 것(tool-decls.js),
 * 두뇌별 안전 설정이 갈라진 것(audit-safety-parity.js). 세 번째다.
 *
 * ── 규칙 ──────────────────────────────────────────────────────────────
 * · 허락을 걸고·읽고·지우는 것은 **여기서만** 한다.
 * · 다른 파일에서 `pendingGrant` 를 직접 건드리면 audit-grants.js 가 잡는다.
 * · **허락 여부를 정하는 것은 사용자다.** 이 파일은 "물어보기"까지만 한다 —
 *   실제 허용은 engine 이 사용자의 답을 판정해 consume() 으로 넘길 때만 일어난다.
 *
 * ⚠️ 두 프로세스에서 쓰인다 — engine(앱 안)과 auxo-mcp-tools(별도 프로세스).
 *    그래서 상태는 메모리가 아니라 **저장소**에 둔다(지금과 같다).
 */

const path = require('path');
const storage = require('./storage');

/** 두뇌에게 줄 안내 문구 — **한 벌만 둔다.** 갈라지면 채널마다 다른 말이 나간다. */
const 문구 = {
  dir: (dir) => `'${dir}' 폴더는 아직 허용되지 않았어. 이건 사용자만 허용할 수 있어(네가 직접 허용 못 함).`
    + ` 사용자에게 "이 폴더에 접근해도 될까요?"라고 묻고, 사용자가 허락하면 그다음에 다시 시도해.`,
  shell: () => '터미널 명령 실행은 아직 허용되지 않았어. 이건 사용자만 허용할 수 있어.'
    + ' 사용자에게 "터미널 명령 실행을 허용할까요?"라고 묻고, 허락하면 다시 시도해.',
  code: () => '코드 실행은 아직 허용되지 않았어. 이건 사용자만 허용할 수 있어.'
    + ' 사용자에게 "코드/명령 실행을 허용할까요?"라고 묻고, 허락하면 다시 시도해.',
};

/** 지금 걸린 허락 질문. 없으면 null. */
function pending(agentId) {
  try { const a = storage.loadAgent(agentId); return (a && a.pendingGrant) || null; } catch (_) { return null; }
}

/**
 * **허락을 물어본다** — 질문을 걸어두고, 두뇌에게 줄 결과 객체를 돌려준다.
 *
 * @param {string} agentId
 * @param {'dir'|'shell'|'code'} kind   code 는 문구만 다르고 허락은 shell 과 같은 것이다
 * @param {object} [opts]
 * @param {string} [opts.path]   폴더 허락일 때 — 막힌 경로(파일이면 그 상위 폴더가 허락 단위)
 * @param {object} [opts.agent]  들고 있는 agent 객체가 있으면 함께 갱신(같은 턴 안에서 다시 읽는 곳이 있다)
 */
function ask(agentId, kind, opts = {}) {
  // shell 과 code 는 **같은 허락**이다. 문구만 다르다 — 여기서 한 번만 정한다.
  const 저장할것 = kind === 'dir'
    ? { kind: 'dir', dir: path.dirname(String(opts.path || '')) }
    : { kind: 'shell' };

  // 진단용(AUXO_GRANT_LOG). 평소엔 아무것도 안 찍는다 — mcp-gateway 의 AUXO_GW_LOG 와 같은 방식.
  //   ★왜 필요한가: 허락은 **두 프로세스**에서 걸린다(engine · auxo-mcp-tools).
  //     "허락 질문이 안 걸렸다"가 우리가 안 쓴 건지, 두뇌가 도구를 안 부른 건지
  //     밖에서는 구분이 안 된다. 실제로 이걸로 갈랐다(2026-08-22, 회귀로 의심했으나 아니었다).
  try {
    const fr = storage.loadAgent(agentId);
    if (process.env.AUXO_GRANT_LOG) console.error(`[grants] ask ${kind} pid=${process.pid} 에이전트=${fr ? '있음' : '없음'} → ${JSON.stringify(저장할것)}`);
    if (fr) {
      fr.pendingGrant = 저장할것;
      storage.saveAgent(fr);
      if (opts.agent) opts.agent.pendingGrant = 저장할것;
      if (process.env.AUXO_GRANT_LOG) console.error(`[grants] 저장 뒤 확인 = ${JSON.stringify((storage.loadAgent(agentId) || {}).pendingGrant)}`);
    }
  } catch (e) { if (process.env.AUXO_GRANT_LOG) console.error('[grants] 실패:', e.message); }

  if (kind === 'dir') return { needGrant: opts.path, message: 문구.dir(저장할것.dir) };
  return { needGrantShell: true, message: kind === 'code' ? 문구.code() : 문구.shell() };
}

/**
 * 사용자의 답으로 **소비한다.** engine 만 부른다(사용자 말을 아는 곳이 거기뿐이다).
 *
 * @param {'APPROVE'|'REJECT'|'AUTO'|string} verdict  judgeApproval 의 판정
 * @returns {object} { kind, dir, 결과: 'approve'|'reject'|'unclear'|'none', agent }
 *
 * ★애매할 때 어떻게 하느냐는 **여기 한 줄**로 정해진다.
 *   지금은 옛 동작 그대로 **다시 잡아둔다.** 바꾸려면 이 줄만 바꾸면 되고,
 *   그러면 모든 채널·두뇌에 한 번에 반영된다. 전엔 그럴 자리가 없었다.
 */
function consume(agentId, verdict) {
  const fr = storage.loadAgent(agentId);
  const pg = fr && fr.pendingGrant;
  if (!fr || !pg) return { 결과: 'none' };

  fr.pendingGrant = null;
  const 승낙 = verdict === 'APPROVE' || verdict === 'AUTO';
  const 거절 = verdict === 'REJECT';

  if (승낙) {
    if (verdict === 'AUTO') fr.trustLevel = 'autonomous';
    if (pg.kind === 'shell') fr.allowShell = true;
    else if (pg.dir) {
      fr.allowedDirs = fr.allowedDirs || [];
      if (!fr.allowedDirs.some((d) => d === pg.dir)) fr.allowedDirs.push(pg.dir);
    }
  } else if (!거절) {
    fr.pendingGrant = pg;   // ★애매 → 다시 잡아둔다(옛 동작 유지). 규칙을 바꿀 자리는 여기다.
  }
  storage.saveAgent(fr);
  return { kind: pg.kind, dir: pg.dir, 결과: 승낙 ? 'approve' : (거절 ? 'reject' : 'unclear'), agent: fr };
}

module.exports = { ask, consume, pending, 문구 };
