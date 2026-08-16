'use strict';
/**
 * memory-post.js — 대화 후 기억 후처리 파이프라인 (모든 채널 공통).
 *
 * 앱(main.js chat:send) · 엔진(engine.processMemory = CLI·텔레그램·디스코드) 공통.
 * 채널별로 다른 것은 UI 갱신 콜백(hooks)뿐이다.
 *
 * ── 단계 ──────────────────────────────────────────────────────────────
 *   (1) 그릇 편집   이번 대화에서 알게 된 "존재"를 두뇌가 지시하고 코드가 그 줄만 고친다
 *   (2) 압축+일화   대화창이 차면 앞부분을 요약으로 접고, **그 구간에서 일화를 한 번에 뽑는다**
 *   (3) 승격        같은 얘기가 3번 모이면 → 두뇌 판단 → 그릇에 한 줄
 *   (4) 넘침 처리   그릇이 상한을 넘으면 잘못 들어온 사건을 걷어내고, 없으면 그릇을 키운다
 *   (5) 루틴        진행 중 루틴의 실행 기록
 *   (6) 관계 흐름   압축 N회마다 관계의 역사를 한 줄로
 *
 * ★일화 추출은 (2)에서 한다. 매 턴 돌리면 한 사건이 여러 번 적힌다
 *   (허리 한 번 삐끗한 게 여러 줄). 접히는 구간을 통으로 한 번 보면 사건은 하나다.
 *
 * ── 통짜 그릇으로 오면서 없앤 단계 ──
 *   망각(decay) · 정리(consolidate) · 중복판단(resolveMemoryUpdates) · 연상(links) ·
 *   옛 승격(promoteEpisodicToSemantic). 전부 "낱개 기억"을 전제로 한 장치였고,
 *   그릇이 통짜 + 존재만 담기로 하면서 필요가 없어졌다.
 */
const storage = require('./storage');
const brainClaude = require('./brain-claude');
const userMemory = require('./user-memory');
const episodeMemory = require('./episode-memory');
const embeddings = require('./embeddings');
const agentQueue = require('./agent-queue'); // 압축의 대화 잘라내기를 턴과 직렬화(메시지 유실 방지)

// ── 대화 압축 설정 ──
const COMPRESS_TRIGGER = 40;   // 총 메시지 수 초과 시 압축 시작
const COMPRESS_CHUNK = 14;     // 접을 오래된 메시지 수
// ── 루틴 설정 ──
const ROUTINE_PROC_THRESHOLD = 3;  // 이만큼 실행되면 procedure 고정
const ROUTINE_RECENT_MAX = 7;      // recent 상한(초과 시 rollup 흡수)
// ── 관계역사(reflection) 설정 ──
const REFLECT_EVERY_COMPRESSES = 3; // 대화 압축 N회마다 관계 reflection 1회(≈45턴)
// 관계 흐름 줄을 알아보는 표식. 줄 형식 = `관계 흐름(8월): 처음엔 …`
const REL_PREFIX = /^관계 흐름\s*\(/;
const REL_LABEL = /^(관계 흐름\s*\([^)]*\))/;
const SUMMARY_HISTORY_MAX = 6;      // 관계 reflection 재료로 쌓아둘 최근 요약 개수

// 호칭 형식 검사는 memory-tools 한 곳만 쓴다.
//   도구(set_nickname)와 여기(그릇 편집)가 **같은 규칙**이어야 한다 — 두 벌이면 한쪽만 고치게 된다.
const cleanNick = require('./memory-tools').cleanNick;

/**
 * 비차단 대화 압축. 실패해도 원본 대화는 절대 삭제하지 않는다.
 */
async function compressConversation(agentId, generate) {
  const messages = storage.loadConversation(agentId);
  if (messages.length <= COMPRESS_TRIGGER) return { episodes: [] };

  const toCompress = messages.slice(0, COMPRESS_CHUNK);
  console.log(`[compress] 압축 시작: 전체=${messages.length}, 접을=${toCompress.length}`);

  // 느린 요약은 락 밖에서(턴을 막지 않음). 실패 시 원본 유지(데이터 손실 없음).
  const existingSummary = storage.loadConversationSummary(agentId);
  const newSummary = await brainClaude.summarizeConversation(existingSummary, toCompress, generate);
  if (newSummary === null) {
    console.warn('[compress] 요약 생성 실패 — 원본 대화 유지 (다음 기회에 재시도)');
    return { episodes: [] };
  }

  // ── 일화도 여기서 뽑는다 ─────────────────────────────────────────────
  //   **매 턴** 뽑으면 한 사건이 여러 번 적힌다 —
  //   허리를 한 번 삐끗했는데 뒤이은 턴마다 대화창에 남은 앞 내용을 보고 또 뽑아
  //   "어제 짐 옮기다 허리를 삐끗함" / "짐을 옮기다 허리를 삐끗함" / "어제 허리를 삐끗함" …
  //   같은 사건이 5줄이 됐다(실측). 그 부풀려진 횟수가 승격 문턱까지 무너뜨렸다.
  //
  //   접히는 구간을 **통으로 한 번** 보면 사건은 하나다 → 중복이 구조적으로 안 생긴다.
  //   요약과 같은 재료·같은 시점이라 자리도 맞고, 매 턴 돌던 LLM 호출 하나가 사라진다.
  //   최근 대화의 일화가 늦게 생기는 건 손해가 아니다 — 창 안엔 원문이 그대로 있어
  //   두뇌가 이미 안다. 일화는 **창 밖으로 밀려난 뒤에** 필요한 것이다(요약과 같은 논리).
  // 접히는 구간을 글로 만든다. 일화 추출과 **그릇 편집이 같은 재료를 쓴다**.
  const convo = toCompress.map(m => `${m.role === 'user' ? '사용자' : '에이전트'}: ${m.content}`).join('\n');
  let episodes = [];
  try {
    episodes = await episodeMemory.extractEpisodes(convo, '', generate);
  } catch (err) { console.error('[compress] 일화 추출 실패 (무시):', err.message); }

  // ⚠️ 대화 잘라내기(전체 덮어쓰기)는 반드시 per-agent 락 안에서 + 최신 재로드.
  //    요약이 도는 몇 초 사이 사용자가 보낸 새 메시지를 덮어써 잃지 않도록.
  let saved = [];
  // ★압축이 **실제로 성립했는지**를 따로 표시한다.
  //   saved 는 "일화가 있었을 때"만 채워지므로 성사 여부를 못 나타낸다.
  //   그릇 편집이 이 값을 보고 돌지 말지 정하므로 정확해야 한다.
  let 접힘 = false;
  await agentQueue.runExclusive(agentId, async () => {
    const cur = storage.loadConversation(agentId);
    if (cur.length <= COMPRESS_TRIGGER) return; // 그 사이 이미 압축됨 → 스킵
    const front0 = cur[0], frontN = cur[COMPRESS_CHUNK - 1];
    const same = front0 && frontN && toCompress[0] && toCompress[COMPRESS_CHUNK - 1]
      && front0.ts === toCompress[0].ts && frontN.ts === toCompress[COMPRESS_CHUNK - 1].ts;
    if (!same) { console.log('[compress] 앞부분 변경 감지 → 스킵(중복압축·유실 방지)'); return; }
    storage.saveConversationSummary(agentId, newSummary);
    // 원본 보존 + 활성에서 제거를 한 번에: 플래그만 바꾼다(id 불변 → 벡터저장소 고아행 방지).
    storage.archiveOldestActive(agentId, COMPRESS_CHUNK);
    접힘 = true;
    // 일화 저장도 이 락 안에서 — 압축이 실제로 성립했을 때만 남긴다(중복압축 시 이중 저장 방지).
    if (episodes.length) {
      const n = storage.addEpisodes(agentId, episodes);
      if (n) { saved = episodes; console.log(`[compress] 일화 ${n}개 저장(접힌 구간 통째로 1회)`); }
    }
    console.log(`[compress] 압축 완료 — 요약 ${newSummary.length}자 (잘라낸 앞 ${COMPRESS_CHUNK})`);
    try {
      const ag = storage.loadAgent(agentId);
      if (ag) {
        ag.summaryHistory = Array.isArray(ag.summaryHistory) ? ag.summaryHistory : [];
        ag.summaryHistory.push(newSummary);
        if (ag.summaryHistory.length > SUMMARY_HISTORY_MAX) ag.summaryHistory = ag.summaryHistory.slice(-SUMMARY_HISTORY_MAX);
        ag.compressesSinceReflect = (ag.compressesSinceReflect || 0) + 1;
        storage.saveAgent(ag);
      }
    } catch (_) {}
  });
  // folded = 접힌 구간의 원문. 그릇 편집이 이걸 재료로 쓴다(접혔을 때만 넘긴다).
  // foldedUntil = 접힌 구간의 **마지막 시각**. 그릇 편집 안전망이 "이 재료가 지금보다 과거인가"를
  //   판단하는 데 쓴다. 없으면 0 — 판단할 수 없다는 뜻이라 호출부가 보수적으로 처리한다.
  const 접힌마지막 = 접힘 ? (toCompress.reduce((m, x) => Math.max(m, Number(x && x.ts) || 0), 0)) : 0;
  return { episodes: saved, folded: 접힘 ? convo : null, foldedUntil: 접힌마지막 };
}

/**
 * 대화 후 기억 후처리.
 *
 * @param {object} p
 * @param {string} p.agentId
 * @param {string} p.userMessage
 * @param {string} p.response         두뇌 응답
 * @param {function} p.generate       에이전트 두뇌 생성기
 * @param {boolean} [p.rememberedAny] 이번 턴 remember/forget 도구 실행 여부.
 *   ★그릇 편집은 **접힐 때만** 돌아서 이 값으로 건너뛸 일이 없다 —
 *   호출부(engine) 호환을 위해 인자는 남기고, 채널이 "기억이 바뀌었다"를 알릴 때 쓴다.
 *   과수집 방지는 이제 구조가 한다: 편집 지시가 **현재 그릇 전문**을 함께 보므로
 *   remember 로 이미 들어간 줄은 "바뀐 게 없음"으로 걸러진다.
 * @param {object} [p.hooks]          { onFacts(agentId, userMemoryText), onWork(agentId, work) }
 * @returns {Promise<{edited,promoted,grewTo,removedWrong,userMemory}>}
 */
async function runPostMemory({ agentId, userMessage, response, generate, rememberedAny = false, hooks = {} }) {
  const onFacts = typeof hooks.onFacts === 'function' ? hooks.onFacts : () => {};
  const onWork = typeof hooks.onWork === 'function' ? hooks.onWork : () => {};

  let edited = 0, promoted = 0, grewTo = null, removedWrong = 0;

  // ── (1) 대화 압축 + 일화 추출 + 그릇 편집 ───────────────────────────
  //   ★일화는 **매 턴**이 아니라 **접힐 때** 뽑는다(compressConversation 안).
  //   매 턴 뽑으면 같은 사건이 여러 번 적힌다 — 대화창에 남은 앞 내용을 두뇌가 계속 다시 보기 때문.
  //   접히는 구간을 통으로 한 번 보면 사건은 하나다 → 중복이 구조적으로 안 생긴다.
  //
  //   ★**그릇 편집도 같은 이유로 여기서 한다.**
  //     매 턴 별도로 부르면 **대부분이 헛돈**이다(불러도 그릇이 안 바뀐다).
  //     그릇은 "끝점 없는 것"만 담으니 자주 바뀔 리가 없다 —
  //     편집 지시문도 *"대부분의 대화가 빈 배열"* 이라 적고 있다.
  //     늦어도 되는 이유는 일화와 같다: **방금 한 말은 아직 대화창에 있어 두뇌가 이미 안다.**
  //     그릇은 창 밖으로 밀려난 뒤에 필요한 것이다. 한 턴 토큰도 눈에 띄게 준다.
  //   ※ 즉시 반영이 필요한 두 가지는 따로 길이 있다:
  //       호칭 → set_nickname 도구(대화 그 자리에서)
  //       사용자가 "기억해줘" → remember 도구(그 자리에서)
  //   ※ 보완 여지: **대화가 끝날 때도 한 번** 돌리면 짧게 쓰는 사용자도 챙겨진다.
  //     채널마다 "끝"이 달라 아직 두지 않았다.
  let newEpisodes = [];
  let 접힌구간 = null;
  let 접힌시각 = 0;   // 접힌 구간의 마지막 시각 — 호칭 안전망이 "과거인가"를 판단하는 데 쓴다
  try {
    const r = await compressConversation(agentId, generate);
    newEpisodes = (r && r.episodes) || [];
    접힌구간 = (r && r.folded) || null;
    접힌시각 = (r && r.foldedUntil) || 0;
  } catch (err) { console.error('[post:compress] 압축·일화 오류 (무시):', err.message); }

  // ── (2) 옛 낱개 데이터 흡수 — **매 턴.** 두뇌를 안 부르는 공짜 로컬 이관이라 미룰 이유가 없다.
  //   (engine 도 프롬프트 만들기 전에 같은 일을 한다. 여기는 engine 을 안 거치는 호출부용 안전망.)
  //   ★주의: 이걸 아래 `if (접힌구간)` 안에 두면 옛 사용자의 기억 이관이
  //     최대 8턴 늦어진다 — 편집(유료 호출)만 미루고 흡수(공짜)는 미루지 않는다.
  try {
    const fa = storage.loadAgent(agentId);
    if (fa && userMemory.absorbLegacyFacts(fa)) storage.saveAgent(fa);
  } catch (err) { console.error('[post:absorb] 옛 기억 흡수 실패 (무시):', err.message); }

  // 그릇 편집 — **접혔을 때만.** 접힌 그 구간을 통으로 보고 고칠 곳만 지시받는다.
  if (접힌구간) {
    try {
      const fresh = storage.loadAgent(agentId);
      if (fresh) {
        const edits = await userMemory.planMemoryEdits({
          userMemory: fresh.userMemory, refMemory: fresh.refMemory,
          conversation: 접힌구간, generate,
        });
        if (edits.length) {
          // 호칭은 기억이 아니라 설정으로 간다(회상 경쟁·중복 방지).
          //   ★이제 주 경로는 set_nickname 도구다. 여기는 **안전망** — 도구를 안 불렀어도 늦게라도 잡는다.
          // ── 호칭 안전망 ─────────────────────────────────────────────
          //   주 경로는 `set_nickname` 도구(대화 그 자리에서). 여기는 도구를 안 불렀을 때
          //   **늦게라도 잡는** 자리다. 그런데 재료가 **접힌(과거) 구간**이라 그냥 두면
          //   ★과거가 현재를 덮어쓴다 — 방금 호칭을 바꿨는데, 압축 때 접힌 구간에 옛 호칭 요청이
          //     들어 있으면 그걸 읽고 되돌려 버린다.
          //
          //   그래서 **접힌 구간이 호칭을 정한 시점보다 나중일 때만** 반영한다.
          //   시각을 모르는 경우(옛 데이터·도구 아닌 경로로 정해진 것):
          //     호칭이 이미 있으면 → 건드리지 않는다(되돌림 방지가 우선)
          //     호칭이 비어 있으면 → 반영한다(첫 설정은 늦게라도 잡는 게 안전망의 값어치)
          const nick = edits.find(e => e.op === 'nickname');
          if (nick) {
            const nk = cleanNick(nick.text);
            const 지금호칭 = fresh.userNickname || '';
            const 정한시각 = Number(fresh.userNicknameAt) || 0;
            const 반영가능 = !지금호칭                              // 아직 없다 → 첫 설정
              || (정한시각 > 0 && 접힌시각 > 정한시각);             // 접힌 재료가 더 나중이다
            if (nk && 지금호칭 !== nk && 반영가능) {
              fresh.userNickname = nk;
              fresh.userNicknameAt = 접힌시각 || Date.now();
              console.log(`[post:nickname] 호칭="${nk}" (안전망 경로)`);
            } else if (nk && 지금호칭 !== nk) {
              console.log(`[post:nickname] 무시 — 접힌 구간이 과거다 (지금 "${지금호칭}" 유지, 제안 "${nk}")`);
            }
          }
          const forUser = edits.filter(e => e.op !== 'nickname' && e.target !== 'ref');
          const forRef = edits.filter(e => e.op !== 'nickname' && e.target === 'ref');
          if (forUser.length) {
            const r = userMemory.applyMemoryEdits(fresh.userMemory, forUser);
            fresh.userMemory = r.text; edited += r.applied;
            if (r.rejected.length) console.warn(`[post:edit] 거부 ${r.rejected.length}건: ${r.rejected.map(x => x.why).join(', ')}`);
          }
          if (forRef.length) {
            const r = userMemory.applyMemoryEdits(fresh.refMemory, forRef);
            fresh.refMemory = r.text; edited += r.applied;
          }
          storage.saveAgent(fresh);
          if (edited || nick) {
            console.log(`[post:edit] 그릇 편집 ${edited}건 → ${userMemory.memorySize(fresh.userMemory)}자`);
            onFacts(agentId, fresh.userMemory);
          }
        }
      }
    } catch (err) { console.error('[post:edit] 그릇 편집 실패 (무시):', err.message); }
  }

  // ── (3) 승격 — 같은 얘기가 되풀이되면 "이 사람의 특징"으로 ──────────
  //   사람 머리에서 겪은 일이 사실로 굳는 그 길.
  //   접힐 때만 도니 자주 안 돌고, 세는 횟수도 부풀려지지 않은 진짜 횟수다.
  if (newEpisodes.length) {
    try {
      const fresh = storage.loadAgent(agentId);
      const all = (fresh && fresh.episodes) || [];
      const embedder = embeddings.getEmbedder(fresh || {});
      const groups = await episodeMemory.findRecurring(newEpisodes, all, embedder);
      for (const g of groups) {
        // ★현재 그릇 전문을 함께 넘긴다 — 이미 아는 걸 다시 올리지 않도록.
        //   매번 최신을 읽는다(앞 묶음이 방금 뭔가 올렸을 수 있다).
        const now = storage.loadAgent(agentId);
        const verdict = await episodeMemory.judgePromotion(g.group, generate, (now && now.userMemory) || '');
        if (!verdict.promote) { console.log('[post:promote] 두뇌 판단: 안 올림(특징 아니거나 이미 아는 것)'); continue; }
        const cur = storage.loadAgent(agentId);
        const r = userMemory.applyMemoryEdits(cur.userMemory, [{ op: 'add', text: verdict.text }]);
        if (r.applied) {
          cur.userMemory = r.text;
          storage.saveAgent(cur);
          storage.markEpisodesPromoted(agentId, g.group.map(e => e.summary));
          promoted++;
          console.log(`[post:promote] 되풀이 ${g.group.length}건 → 존재로 승격: "${verdict.text}"`);
          onFacts(agentId, cur.userMemory);
        }
      }
    } catch (err) { console.error('[post:promote] 승격 오류 (무시):', err.message); }
  }

  // ── (4) 넘침 처리 — 존재는 안 깎는다. 잘못 들어온 것만 걷어내고, 없으면 그릇을 키운다 ──
  try {
    const fresh = storage.loadAgent(agentId);
    if (fresh && userMemory.memorySize(fresh.userMemory) > userMemory.limitOf(fresh)) {
      const r = await userMemory.handleOverflow(fresh, generate);
      if (r.acted) {
        storage.saveAgent(fresh);
        removedWrong = r.removed.length;
        grewTo = r.grewTo;
        onFacts(agentId, fresh.userMemory);
      }
    }
  } catch (err) { console.error('[post:overflow] 넘침 처리 오류 (무시):', err.message); }

  // (5) 대화 압축은 (2)로 합쳐졌다 — 일화 추출과 같은 재료·같은 시점이라 한 번만 돈다.

  // ── (5) 루틴 처리 (activeId가 루틴일 때만) ──
  const a1 = storage.loadAgent(agentId);
  const activeId = a1 && a1.work && a1.work.activeId ? a1.work.activeId : null;
  if (activeId && activeId.startsWith('rt-')) {
    try {
      const fresh = storage.loadAgent(agentId);
      if (fresh && fresh.work) {
        const rout = (fresh.work.routines || []).find(r => r.id === activeId);
        if (rout) {
          rout.runCount = (rout.runCount || 0) + 1;
          rout.updatedAt = new Date().toISOString();
          rout.recent = rout.recent || [];
          rout.recent.push({ ts: new Date().toISOString(), digest: `${String(response).slice(0, 120)}...` });
          if (rout.runCount >= ROUTINE_PROC_THRESHOLD && !rout.procedure) {
            rout.procedure = `${rout.title} 루틴 (${rout.runCount}회 실행됨)`;
            console.log(`[post:routine] '${rout.title}' procedure 고정 (runCount=${rout.runCount})`);
          }
          await brainClaude.compressRoutineRecent(rout, generate, ROUTINE_RECENT_MAX);
          storage.saveAgent(fresh);
          onWork(agentId, fresh.work);
        }
      }
    } catch (e) { console.warn('[post:routine] 루틴 처리 오류:', e.message); }
  }

  // ── (6) 관계 흐름 — 압축 N회마다 1회 ────────────────────────────────
  //   "처음엔 업무 위주였다가 점차 일상도" 같은 관계의 역사. 끝점이 없으므로 존재에 속한다.
  try {
    const ag = storage.loadAgent(agentId);
    const cnt = (ag && ag.compressesSinceReflect) || 0;
    const hist = (ag && Array.isArray(ag.summaryHistory)) ? ag.summaryHistory : [];
    if (ag && cnt >= REFLECT_EVERY_COMPRESSES && hist.length >= 2) {
      console.log(`[post:relationship] 관계 흐름 반영 트리거 (압축 ${cnt}회·요약 ${hist.length}개)`);
      // ★이미 적어둔 관계 흐름을 **두뇌에게 보여준다.**
      //   안 보여주면 매번 처음 쓰듯 새로 쓰고, 아래가 무조건 add 라 같은 시기 얘기가 쌓인다(실측).
      const 기존 = userMemory.toLines((ag && ag.userMemory) || '').filter(l => REL_PREFIX.test(l));
      const line = await brainClaude.reflectRelationship(hist, '최근', generate, 기존);
      const after = storage.loadAgent(agentId) || ag;
      after.compressesSinceReflect = 0; // 성공·실패 무관 리셋(다음 주기까지 대기)
      if (line) {
        // 같은 시기(레이블)면 **그 줄을 갱신**하고, 새 시기면 추가한다.
        //   관계의 역사는 "6월엔 이랬고 8월엔 이렇다"처럼 **시기별 한 줄**이 설계 의도다
        //   (원 프롬프트가 기간 레이블을 요구한다). 한 줄로 뭉개면 그 결이 사라진다.
        const 레이블 = (String(line).match(REL_LABEL) || [])[1] || '';
        const 같은시기 = 레이블
          ? userMemory.toLines(after.userMemory).find(l => l.startsWith(레이블))
          : null;
        const 지시 = 같은시기
          ? { op: 'replace', old: 같은시기, text: line }   // 못 찾으면 아무 일도 안 일어난다(안전)
          : { op: 'add', text: line };
        const r = userMemory.applyMemoryEdits(after.userMemory, [지시]);
        if (r.applied) {
          after.userMemory = r.text; edited++; onFacts(agentId, after.userMemory);
          console.log(`[post:relationship] ${같은시기 ? '같은 시기 갱신' : '새 시기 추가'}: ${String(line).slice(0, 60)}`);
        }
      }
      storage.saveAgent(after);
    }
  } catch (e) { console.error('[post:relationship] 관계 흐름 오류(무시):', e.message); }

  const finalAgent = storage.loadAgent(agentId);
  return {
    edited, promoted, grewTo, removedWrong,
    userMemory: (finalAgent && finalAgent.userMemory) || '',
  };
}

module.exports = {
  runPostMemory, compressConversation,
  COMPRESS_TRIGGER, COMPRESS_CHUNK,
  ROUTINE_PROC_THRESHOLD, ROUTINE_RECENT_MAX, REFLECT_EVERY_COMPRESSES,
};
