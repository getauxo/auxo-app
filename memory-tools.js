/**
 * memory-tools.js — 기억 도구(remember/forget)의 **유일한** 구현.
 *
 * engine(REST 두뇌 extraExecute) · agent-tools · auxo-mcp-tools(구독 두뇌 MCP)가 전부 여기를 쓴다.
 * 여러 벌로 나뉘면 미묘하게 달라진다 — 그래서 한 벌만 둔다.
 *
 * ★통짜 그릇:
 *   그릇이 낱개 배열에서 통짜 글로 바뀌면서 두 도구도 "줄 편집"이 됐다.
 *     remember → 한 줄 추가 (이미 있으면 안 넣음)
 *     forget   → 해당 줄 제거 (사용자가 명시적으로 요청할 때만)
 *   낱개 시절의 label/importance/scope 는 사라졌다 — 통짜엔 붙일 자리가 없고,
 *   그릇이 "존재"만 담게 되면서 중요도로 지울 일도 없어졌다.
 */
'use strict';
const storage = require('./storage');
const userMemory = require('./user-memory');

// 지울 대상을 찾을 때 무시하는 흔한 말. 이게 없으면 "그거 기억 지워"의 '그거·기억'이 아무 줄에나 걸린다.
const FORGET_STOP = new Set(['기억', '내', '나', '그거', '그건', '그것', '방금', '관련', '부분', '정보', '것', '거', '얘기', '이야기']);

/**
 * `replaces` 가 가리키는 줄을 그릇에서 찾는다. **하나로 확정될 때만** 돌려준다.
 *
 * 글자 그대로 맞는 게 제일 좋지만, 두뇌가 긴 줄을 옮겨 적을 땐 괄호 안이 조금씩 틀린다.
 * 그래서 한 단계만 느슨하게 본다 — 한쪽이 다른 쪽을 통째로 품고 있으면 같은 줄로 친다.
 * 그 이상(단어 겹침 등)은 **일부러 안 한다.** 엉뚱한 줄을 갈아끼우면 그게 마모다.
 */
function _findLineToReplace(memoryText, quoted) {
  const lines = String(memoryText || '').split('\n').map(s => s.trim()).filter(Boolean);
  const q = userMemory._norm(quoted);
  if (!q) return null;

  const exact = lines.filter(l => userMemory._norm(l) === q);
  if (exact.length === 1) return exact[0];
  if (exact.length > 1) return null;                 // 같은 줄이 여럿이면 손대지 않는다

  const contains = lines.filter(l => {
    const n = userMemory._norm(l);
    return n.includes(q) || q.includes(n);
  });
  return contains.length === 1 ? contains[0] : null; // 후보가 0개거나 2개 이상이면 포기
}

/**
 * 사용자에 관해 알게 된 것을 그릇에 쓴다.
 *
 * ★`replaces` — 무조건 add 만 하면 사용자가 "이건 고쳐줘"라고 할 때
 *   기존 줄이 남은 채 새 줄이 쌓였다 — 같은 얘기(예: 음식 취향)가 여러 줄이 된다.
 *   자동 후처리(user-memory.planMemoryEdits)는 replace 를 정확히 내는데 이 도구만 못 했다.
 *   → 두뇌가 갈아끼울 줄을 지목하면 여기서 replace 한다.
 */
function rememberFact(agentId, { text, replaces, label, value } = {}) {
  // text 가 정식 인자. label/value 는 옛 호출부 호환(둘이 오면 한 줄로 합친다).
  let line = String(text || '').trim();
  if (!line) {
    const l = String(label || '').trim();
    const v = String(value || '').trim();
    if (!v) return { error: '무엇을 기억할지 알려줘' };
    line = (l && !v.includes(l)) ? `${l}: ${v}` : v;
  }
  const fresh = storage.loadAgent(agentId);
  if (!fresh) return { error: '저장 실패(에이전트 없음)' };
  userMemory.absorbLegacyFacts(fresh); // 옛 낱개 데이터가 남아 있으면 먼저 흡수(멱등)

  // ── 정정: 지목한 줄을 갈아끼운다 ──────────────────────────────
  const quoted = String(replaces || '').trim();
  if (quoted) {
    const target = _findLineToReplace(fresh.userMemory, quoted);
    if (target) {
      const r = userMemory.applyMemoryEdits(fresh.userMemory, [{ op: 'replace', old: target, text: line }]);
      if (r.applied) {
        fresh.userMemory = r.text;
        storage.saveAgent(fresh);
        return { saved: true, replaced: true, replacedLine: target, userMemory: r.text,
          message: '고쳐 썼어. 옛날 줄은 지웠으니 따로 지울 필요 없어.' };
      }
    }
    // 못 찾았으면 그냥 넘어가지 않고 **아래에서 새로 적되, 못 찾았다고 알린다.**
    // 조용히 add 만 하면 두뇌는 고쳐진 줄 알고 "정리했어"라고 말해버린다(실제로 그랬다).
  }

  const r = userMemory.applyMemoryEdits(fresh.userMemory, [{ op: 'add', text: line }]);
  if (!r.applied) {
    const why = (r.rejected[0] && r.rejected[0].why) || '알 수 없음';
    return { saved: false, message: why === '이미 있는 내용' ? '이미 알고 있는 내용이야.' : `저장 안 함(${why}).` };
  }
  fresh.userMemory = r.text;
  storage.saveAgent(fresh);
  if (quoted) {
    return { saved: true, replaced: false, userMemory: r.text,
      // ★사용자에게 확인하라고 하지 않는다 — 우리 내부 사정이라 사용자가 알 이유가 없다.
      //   (여기 "사용자에게 확인해줘"를 넣으면 두뇌가 대화 중에 기억 정리를 꺼낸다)
      message: '새로 적긴 했는데, 고치라고 한 줄을 못 찾았어. 옛날 줄이 그대로 남아 있어. '
             + '고치려면 지금 기억에 적힌 문장을 그대로 옮겨서 다시 불러. '
             + '사용자에게는 이 얘기를 꺼내지 마 — 최신 것을 기준으로 답하면 그만이야.' };
  }
  return { saved: true, replaced: false, userMemory: r.text, message: '기억했어. 다시 저장하지 마.' };
}

/**
 * 호칭은 짧은 단일 토큰이어야 한다. 문장·복수후보("대장 (또는 대장님)")는 거부.
 *   의미 판단(이게 호칭인가 / 본인 것인가)은 **두뇌가** 끝냈다 — 여기선 형식만 본다.
 *   ★이 검사는 여기 한 곳에 둔다. 도구(set_nickname)와 그릇 편집이
 *     같은 규칙을 써야 해서다. 두 벌이 되면 "한 곳만 고치고 나머지를 빠뜨리는" 구조가 된다.
 */
function cleanNick(v) {
  v = String(v || '').trim().replace(/["'“”]/g, '');
  if (!v) return null;
  return /^[가-힣A-Za-z0-9]{1,12}님?$/.test(v) ? v : null;
}

/**
 * 사용자가 정해준 호칭을 설정에 반영한다(기억이 아니라 설정 — 회상 경쟁·중복 방지).
 *   ★왜 도구인가: 그릇 편집 호출이 압축 시점으로 옮겨가면 호칭도 최대 8턴 늦어진다.
 *     호칭은 사용자가 바로 알아채는 자리라 **대화 그 자리에서** 반영돼야 한다.
 */
function setNickname(agentId, { nickname } = {}) {
  const nk = cleanNick(nickname);
  if (!nk) return { error: '호칭은 짧은 한 낱말이어야 해(예: "형"). 문장이나 여러 후보는 안 돼.' };
  const agent = storage.loadAgent(agentId);
  if (!agent) return { error: '에이전트를 찾지 못했어' };
  if ((agent.userNickname || '') === nk) return { set: true, nickname: nk, message: '이미 그렇게 부르고 있어.' };
  agent.userNickname = nk;
  // ★**언제 정했는지**를 함께 남긴다.
  //   그릇 편집은 압축 시점에 **접힌(과거) 구간**을 재료로 쓴다. 거기 옛 호칭 요청이 있으면
  //   안전망이 그걸 읽고 **지금 호칭을 과거 것으로 되돌린다.**
  //   시각이 있어야 "과거가 현재를 덮는 것"을 막을 수 있다.
  agent.userNicknameAt = Date.now();
  storage.saveAgent(agent);
  return { set: true, nickname: nk, message: `이제 "${nk}"라고 부를게. 다시 저장하지 마.` };
}

/** 사용자가 명시적으로 요청한 기억을 그릇에서 지운다. */
function forgetFact(agentId, { query } = {}) {
  query = String(query || '').trim();
  if (!query) return { error: '무엇을 잊을지 알려줘' };
  const fresh = storage.loadAgent(agentId);
  if (!fresh) return { error: '저장 실패(에이전트 없음)' };
  userMemory.absorbLegacyFacts(fresh);

  const lines = userMemory.toLines(fresh.userMemory);
  const q = query.toLowerCase();
  const qWords = q.split(/[\s,.]+/).filter(w => w.length >= 2 && !FORGET_STOP.has(w));

  // 좁은 것부터 넓은 것 순으로 본다 — **좁은 단계에서 하나로 특정되면 거기서 끝낸다.**
  //   이 사다리가 없으면 "그 줄 내용을 그대로" 줘도 낱말이 겹치는 다른 줄까지 걸려
  //   영원히 needsPick 만 나오고 **아무것도 못 지우게 된다**.
  const exact = lines.filter(l => userMemory._norm(l) === userMemory._norm(query));
  const contains = lines.filter(l => l.toLowerCase().includes(q) || q.includes(l.toLowerCase()));
  const loose = lines.filter(l => qWords.some(w => l.toLowerCase().includes(w)));
  const matches = exact.length ? exact : (contains.length ? contains : loose);

  if (matches.length === 0) return { forgotten: false, message: `'${query}'에 해당하는 기억이 없어.` };

  // ★**한 줄만 걸릴 때만 바로 지운다.**
  //   여러 줄을 말없이 지우면, "위가 예민해서 커피를 줄임" 한 줄을 지워달라고 할 때
  //   '커피'가 든 다른 줄까지 함께 사라진다(두뇌가 알아채면 되살리지만, 못 알아채면 조용히 유실).
  //   삭제는 **되돌릴 수 없는 유일한 경로**라 가장 보수적이어야 한다.
  //   "5"를 "2"로 바꾸는 게 아니라 기준을 뒤집었다 — 지어낸 숫자가 사라지고
  //   "하나로 특정되면 지우고, 아니면 사용자에게 확인"이라는 원칙만 남는다.
  if (matches.length > 1) {
    return {
      forgotten: false, needsPick: true, candidates: matches,
      message: `'${query}'로 ${matches.length}개가 걸려. 잘못 지우면 되돌릴 수 없으니, `
        + `어느 걸 지울지 사용자에게 확인하고 그 줄의 내용을 그대로 query 에 넣어 다시 불러줘:\n`
        + matches.map((m, i) => `${i + 1}. ${m}`).join('\n'),
    };
  }
  // ★**사용자가 답할 기회 없이 연달아 지우는 것을 막는다.**
  //   여러 줄이 걸려 needsPick 을 돌려주면, 두뇌가 사용자에게 묻지 않고
  //   **같은 턴에 후보를 하나씩 다시 호출해 전부 지울 수 있다.** "카페인 지워줘" 한마디에 녹차 기억까지 사라진다.
  //   코드가 되물어도 두뇌가 두 번 부르면 뚫린다 — 프롬프트로는 못 막는다.
  //
  //   막는 방법: "확인했다"면 **사용자 답이 와야 하고, 그건 다음 턴**이다.
  //   그래서 지울 때 그 시점의 **마지막 메시지 id** 를 남기고, 다음 삭제 때 그게 그대로면 거부한다.
  //   시간·횟수 같은 지어낸 기준이 없다 — 사용자가 실제로 말했는지만 본다.
  //   저장소에 남기므로 구독(별도 프로세스)·REST 두뇌 모두 같이 걸린다.
  const lastMsgId = _lastMessageId(agentId);
  if (fresh._lastForgetMsgId && lastMsgId && fresh._lastForgetMsgId === lastMsgId) {
    return {
      forgotten: false, needsUserTurn: true,
      message: '이번에 이미 기억을 하나 지웠어. 사용자가 아직 아무 말도 하지 않았으니 '
        + '더 지우려면 **먼저 무엇을 지울지 확인받고**, 사용자가 답한 뒤에 다시 불러. '
        + '한 번에 여러 개를 몰아 지우면 안 지워도 될 기억이 사라진다.',
    };
  }

  const r = userMemory.applyMemoryEdits(fresh.userMemory, matches.map(m => ({ op: 'remove', old: m })));
  fresh.userMemory = r.text;
  if (lastMsgId) fresh._lastForgetMsgId = lastMsgId;
  storage.saveAgent(fresh);
  return { forgotten: true, count: r.applied, userMemory: r.text, items: matches, message: `${r.applied}개 기억을 지웠어: ${matches.join(' / ')}` };
}

/** 지금 대화의 마지막 메시지 id — "사용자가 그 뒤로 말했는가"를 판별하는 기준점. */
function _lastMessageId(agentId) {
  try {
    const msgs = storage.loadConversation(agentId) || [];
    if (!msgs.length) return null;
    const last = msgs[msgs.length - 1];
    return String((last && (last.id || last.ts)) || msgs.length);
  } catch (_) { return null; }
}

/** function-calling decl (REST 두뇌·MCP 공용) */
// ★선언 원본은 tool-decls.js 한 곳이다.
//   사본이 따로 놀면 remember 의 "끝점" 기준과 forget 의 확인 절차가
//   **한쪽 두뇌에만** 적용되는 일이 생긴다.
//   DECLS 이름은 기존 호출부 호환으로 남긴다.
const DECLS = require('./tool-decls').pick(['remember', 'forget', 'set_nickname']);


module.exports = { rememberFact, forgetFact, setNickname, cleanNick, DECLS };
