'use strict';
/**
 * memory-post.js — 대화 후 기억 후처리 파이프라인 (공통 모듈)
 *
 * 앱(main.js chat:send)·엔진(engine.processMemory, = CLI·텔레그램·디스코드) 공통.
 * 5단계: (1)추출+scope태깅 → (2)대화 압축 → (3)망각(decay) → (4)정리(consolidate) → (5)루틴.
 * UI 갱신 side-effect는 hooks 콜백으로 위임(앱=IPC webContents.send / 엔진=emit / 봇=no-op).
 *
 * ⚠️ 이 로직은 원래 main.js scheduleMemoryTasks 에 있던 것을 그대로 옮긴 것.
 *    엔진(봇 채널)엔 추출·망각만 있어 압축/정리/루틴이 빠져 있던 파리티 갭을 메운다.
 */
const storage = require('./storage');
const brainClaude = require('./brain-claude');
const agentQueue = require('./agent-queue'); // 압축의 대화 잘라내기를 턴과 직렬화(메시지 유실 방지)

// ── 대화 압축 설정 (main.js와 동일 값) ──
const COMPRESS_TRIGGER = 40;   // 총 메시지 수 초과 시 압축 시작 (기억 v3 D4: 30→40 소폭 상향, ~13~20턴 원문 유지)
const COMPRESS_CHUNK = 14;     // 접을 오래된 메시지 수
// ── 정리(consolidate) 설정 ──
const CONSOLIDATE_MIN = 20;               // 기억이 이만큼 쌓였을 때만 정리 패스
const CONSOLIDATE_DIRTY_THRESHOLD = 3;    // 변경 누적이 이 수 이상이면 정리
// ── 루틴 설정 ──
const ROUTINE_PROC_THRESHOLD = 3;  // 이만큼 실행되면 procedure 고정
const ROUTINE_RECENT_MAX = 7;      // recent 상한(초과 시 rollup 흡수)
// ── 관계역사(reflection) 설정 ──
const REFLECT_EVERY_COMPRESSES = 3; // 대화 압축 N회마다 관계 reflection 1회(≈45턴)
const SUMMARY_HISTORY_MAX = 6;      // 관계 reflection 재료로 쌓아둘 최근 요약 개수

// ── 호칭 감지 (설정 UI 없이 대화로 — 마스터 2026-07-12) ──
// 사용자가 "나를 X라고 불러" 류로 자기 호칭을 정하면 userNickname 필드에 반영.
// 정규식(1인칭 앵커로 제3자 지칭 배제) + 추출의 label="호칭" fact 병행. 감지 시 그 호칭은 일반 기억에 안 남김.
const _NICK_BLOCK = new Set(['뭐', '무엇', '어떻게', '뭐라', '어떤', '누구', '왜', '그냥']);
const _NICK_PATTERNS = [
  /(?:나|날|저|절)\s*(?:는|를|은|에게|한테)?\s*(?:앞으로\s*)?["'“”]?([가-힣A-Za-z][가-힣A-Za-z0-9 ]{0,11}?)["'“”]?\s*(?:라고|이라고|라구|이라구)\s*(?:불러|부르|해줘|해)/,
  /(?:내|제)\s*(?:호칭|별명)(?:은|는|이|가)?\s*["'“”]?([가-힣A-Za-z][가-힣A-Za-z0-9 ]{0,11}?)["'“”]?(?:\s|으?로|라고|부르|$|[.!?~])/,
];
function detectNicknameFromText(text) {
  const s = String(text || '');
  for (const re of _NICK_PATTERNS) {
    const m = s.match(re);
    if (m && m[1]) { const n = m[1].trim(); if (n && n.length <= 12 && !_NICK_BLOCK.has(n)) return n; }
  }
  return null;
}
// 호칭은 짧은 단일 토큰(공백·괄호·쉼표 없음)이어야 함. 문장·복수후보("대장 (또는 대장님)")는 거부.
function cleanNick(v) {
  v = String(v || '').trim().replace(/["'“”]/g, '');
  if (!v) return null;
  if (/^[가-힣A-Za-z0-9]{1,12}님?$/.test(v)) return v;
  return detectNicknameFromText(v); // 문장이면 1인칭 패턴으로만(없으면 null)
}
// 이번 발화가 "제3자를 X라고 불러"인지(사용자 본인 호칭 아님) — 추출 오탐 차단용.
const _THIRD_PARTY = /(그\s*사람|그\s*친구|걔|쟤|그녀|그분|저\s*사람|그를|그 애)\s*[을를]?/;
// 어느 경로(이번 발화 정규식·추출 label='호칭'·두뇌 remember 도구 '사용자 호칭' 등)로 들어온 호칭이든
// userNickname 필드로 흡수하고, 그 호칭 fact들은 일반 기억에서 제거(중복·회상경쟁 방지).
function consolidateNickname(agentId, userMessage, onFacts) {
  try {
    const fresh = storage.loadAgent(agentId);
    if (!fresh || !Array.isArray(fresh.humanFacts)) return;
    const isNickFact = f => f && f.subject !== 'reference' && /호칭|부르는\s*말|뭐라고\s*부/.test(String(f.label || ''));
    const nickFacts = fresh.humanFacts.filter(isNickFact);
    let nk = detectNicknameFromText(userMessage);            // 이번 발화 정규식(1인칭 앵커) 우선
    // 추출 fact 폴백: 단, 이번 발화가 제3자 지칭이면 신뢰하지 않음(오탐 차단)
    if (!nk && nickFacts.length && !_THIRD_PARTY.test(String(userMessage || ''))) nk = cleanNick(nickFacts[nickFacts.length - 1].value);
    let changed = false;
    if (nickFacts.length) { fresh.humanFacts = fresh.humanFacts.filter(f => !isNickFact(f)); changed = true; }
    if (nk && (fresh.userNickname || '') !== nk) { fresh.userNickname = nk; changed = true; }
    if (changed) {
      storage.saveAgent(fresh);
      console.log(`[post:nickname] 호칭="${nk || fresh.userNickname || ''}" (기억 호칭 fact ${nickFacts.length}개 흡수)`);
      if (typeof onFacts === 'function') onFacts(agentId, fresh.humanFacts);
    }
  } catch (_) {}
}

/**
 * 비차단 대화 압축. 실패해도 원본 대화는 절대 삭제하지 않는다.
 */
async function compressConversation(agentId, generate) {
  const messages = storage.loadConversation(agentId);
  if (messages.length <= COMPRESS_TRIGGER) return; // 아직 임계치 미달

  const toCompress = messages.slice(0, COMPRESS_CHUNK); // 접을 오래된 앞부분
  console.log(`[compress] 압축 시작: 전체=${messages.length}, 접을=${toCompress.length}`);

  // 느린 요약은 락 밖에서(턴을 막지 않음). 실패 시 원본 유지(데이터 손실 없음).
  const existingSummary = storage.loadConversationSummary(agentId);
  const newSummary = await brainClaude.summarizeConversation(existingSummary, toCompress, generate);
  if (newSummary === null) {
    console.warn('[compress] 요약 생성 실패 — 원본 대화 유지 (다음 기회에 재시도)');
    return;
  }

  // ⚠️ 대화 잘라내기(saveConversation=전체 덮어쓰기)는 반드시 per-agent 락 안에서 + 최신 재로드.
  //    요약이 도는 몇 초 사이 사용자가 보낸 새 메시지(대화 뒤에 append 됨)를 덮어써 잃지 않도록.
  await agentQueue.runExclusive(agentId, async () => {
    const cur = storage.loadConversation(agentId);
    if (cur.length <= COMPRESS_TRIGGER) return; // 그 사이 이미 압축됨/짧아짐 → 스킵(중복압축 방지)
    // 내가 요약한 바로 그 앞부분이 아직 맨 앞에 그대로인지 확인(ts). 다른 압축이 앞을 이미 잘랐으면
    // 여기서 자르면 '요약 안 된' 메시지를 버리게 되므로 스킵.
    const front0 = cur[0], frontN = cur[COMPRESS_CHUNK - 1];
    const same = front0 && frontN && toCompress[0] && toCompress[COMPRESS_CHUNK - 1]
      && front0.ts === toCompress[0].ts && frontN.ts === toCompress[COMPRESS_CHUNK - 1].ts;
    if (!same) { console.log('[compress] 앞부분 변경 감지 → 스킵(중복압축·유실 방지)'); return; }
    const remaining = cur.slice(COMPRESS_CHUNK); // 오래된 앞 N개만 접음, 그 뒤(요약 도중 append 된 것 포함) 유지
    storage.saveConversationSummary(agentId, newSummary);
    // 원본 보존 + 활성에서 제거를 한 번에: 오래된 앞 N개를 아카이브로 '전환'(플래그만, id 불변).
    //   과거의 appendArchivedMessages(복사) + saveConversation(삭제+재삽입) 조합은 id-churn 으로
    //   벡터저장소(msg_vec) 고아행을 만들었다 → archiveOldestActive 로 근본 차단.
    storage.archiveOldestActive(agentId, COMPRESS_CHUNK);
    console.log(`[compress] 압축 완료 — 요약 ${newSummary.length}자, 활성 대화 ${remaining.length}개(잘라낸 앞 ${COMPRESS_CHUNK})`);
    // 관계역사용: 이번 요약을 히스토리에 축적 + 압축 카운터(주기적 reflection 재료). 락 안이라 안전.
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
}

/**
 * 대화 후 후처리 기억 파이프라인 5단계.
 * @param {object} p
 * @param {string} p.agentId
 * @param {string} p.userMessage
 * @param {string} p.response         두뇌 응답(capturedResponse)
 * @param {function} p.generate       에이전트 두뇌 생성기
 * @param {boolean} [p.rememberedAny] 이번 턴 remember 도구 실행 여부(true면 추출 생략)
 * @param {object} [p.hooks]          { onFacts(agentId, facts), onWork(agentId, work) } — UI 갱신 콜백(옵션)
 * @returns {Promise<{added,updated,mergedCount,removed,humanFacts}>}
 */
async function runPostMemory({ agentId, userMessage, response, generate, rememberedAny = false, hooks = {} }) {
  const onFacts = typeof hooks.onFacts === 'function' ? hooks.onFacts : () => {};
  const onWork = typeof hooks.onWork === 'function' ? hooks.onWork : () => {};
  // activeId는 최신 에이전트에서 유도(호출자가 몰라도 됨).
  const a0 = storage.loadAgent(agentId);
  const activeId = a0 && a0.work && a0.work.activeId ? a0.work.activeId : null;

  let added = 0, updated = 0, mergedCount = 0, removed = 0;
  let memChanges = 0; // 이번 턴 기억 변경 수(추가+갱신+흡수+망각) — 정리 게이트에 사용

  // ── (1) 기억 추출 (rememberedAny면 생략 — 과수집 차단) ──
  if (rememberedAny) {
    console.log('[post:extract] remember 도구 실행 턴 → 추출 생략(과수집 차단)');
  } else {
    try {
      const extracted = await brainClaude.extractFactsFromConversation(userMessage, response, generate);
      if (extracted.length > 0) {
        if (activeId) { // L1 scope 태깅
          const workType = activeId.startsWith('rt-') ? 'routine' : 'project';
          extracted.forEach(f => { if (!f.scope) f.scope = `${workType}:${activeId}`; });
        }
        const fresh = storage.loadAgent(agentId);
        if (fresh) {
          brainClaude.ensureMemoryShape(fresh.humanFacts || []);
          const r = brainClaude.integrateMemory(fresh.humanFacts || [], extracted, {});
          if (r.added > 0 || r.updated > 0 || r.mergedCount > 0) {
            brainClaude.ensureMemoryShape(r.merged);
            added = r.added; updated = r.updated; mergedCount = r.mergedCount;
            memChanges += r.added + r.updated + r.mergedCount;
            fresh.humanFacts = r.merged;
            storage.saveAgent(fresh);
            console.log(`[post:extract] 기억 저장 — 추가=${r.added}, 갱신=${r.updated}, 흡수=${r.mergedCount}, 총=${r.merged.length}`);
            onFacts(agentId, r.merged);
          }
        }
      }
    } catch (err) { console.error('[post:extract] 추출 실패 (무시):', err.message); }
  }

  // ── (1.7) 일화기억(episodes) 추출·저장 (기억 v3/A) — "우리가 뭘 했나"를 남긴다 ──
  //   팩트("누구인가")와 별개. 대부분 턴은 0개(잡담·정보질문 제외). search_memory 로 회상.
  try {
    const eps = await brainClaude.extractEpisodesFromConversation(userMessage, response, generate);
    if (eps && eps.length) {
      const n = storage.addEpisodes(agentId, eps);
      if (n) console.log(`[post:episode] 일화 ${n}개 저장 (총 ${(storage.loadAgent(agentId).episodes || []).length})`);
    }
  } catch (err) { console.error('[post:episode] 일화 추출 실패 (무시):', err.message); }

  // ── (1.5) 호칭 통합: 대화로 정한 호칭을 userNickname 필드로 흡수(설정 없이 대화로) ──
  consolidateNickname(agentId, userMessage, onFacts);

  // ── (2) 대화 압축 ──
  try { await compressConversation(agentId, generate); }
  catch (err) { console.error('[post:compress] 압축 오류 (무시):', err.message); }

  // ── (3) 망각(decay) — 두뇌 무관 순수 로직 ──
  try {
    const fresh = storage.loadAgent(agentId);
    if (fresh && Array.isArray(fresh.humanFacts)) {
      const { kept, removed: rem, capExceeded } = brainClaude.decayFacts(fresh.humanFacts);
      if (rem.length > 0) {
        removed = rem.length;
        memChanges += rem.length;
        fresh.humanFacts = kept;
        storage.saveAgent(fresh);
        console.log(`[post:decay] 망각 ${rem.length}개 → 남은 ${kept.length}`);
        onFacts(agentId, kept);
      }
      if (capExceeded) console.warn(`[post:decay] 상한 초과지만 모두 중요(2·3)라 보존 (${kept.length})`);
    }
  } catch (err) { console.error('[post:decay] 망각 오류 (무시):', err.message); }

  // ── (4) 정리(consolidate) — 기억 많고 + 변경 충분히 누적됐을 때만(비용 절약) ──
  try {
    const fresh = storage.loadAgent(agentId);
    if (fresh && Array.isArray(fresh.humanFacts) && fresh.humanFacts.length >= CONSOLIDATE_MIN) {
      const dirty = (fresh.consolidateDirty || 0) + memChanges;
      const clusterCount = brainClaude.clusterFacts(fresh.humanFacts, 0.8); // _emb 캐시 재사용, LLM 0회
      const clusterTrigger = clusterCount >= 2 && dirty >= 1;
      const shouldConsolidate = dirty >= CONSOLIDATE_DIRTY_THRESHOLD || clusterTrigger;
      if (!shouldConsolidate) {
        if (memChanges > 0) { fresh.consolidateDirty = dirty; storage.saveAgent(fresh); }
        console.log(`[post:consolidate] 스킵 (변경 누적 ${dirty}/${CONSOLIDATE_DIRTY_THRESHOLD}, 클러스터=${clusterCount})`);
      } else {
        const triggerReason = clusterTrigger ? `클러스터${clusterCount}` : `dirty${dirty}`;
        console.log(`[post:consolidate] 트리거(${triggerReason}) → LLM 정리 시작`);
        const result = await brainClaude.consolidateFacts(fresh.humanFacts, generate);
        const after = storage.loadAgent(agentId) || fresh;
        after.consolidateDirty = 0; // 실행했으면 결과 무관 누적 리셋(다음 턴 즉시 재실행 방지)
        if (result && result.changed) {
          after.humanFacts = result.facts;
          console.log(`[post:consolidate] 정리 — ${result.before}→${result.after} (누적 ${dirty} 리셋)`);
          onFacts(agentId, result.facts);
        } else {
          console.log(`[post:consolidate] 변경 없음 (누적 ${dirty} 리셋)`);
        }
        // ── 관계역사 Part1: 일화→의미 승격 + 연상 links (LLM 0회, in-place, 정리 트리거에 편승) ──
        try {
          brainClaude.ensureMemoryShape(after.humanFacts);
          const prom = brainClaude.promoteEpisodicToSemantic(after.humanFacts);
          if (prom.promoted > 0) { after.humanFacts.push(...prom.newFacts); console.log(`[post:promote] 일화→의미 승격 ${prom.promoted}건(의미기억 +${prom.newFacts.length})`); }
          const linked = brainClaude.buildLinks(after.humanFacts, 0.8);
          if (prom.promoted > 0 || linked > 0) onFacts(agentId, after.humanFacts);
        } catch (e) { console.error('[post:promote] 승격/링크 오류(무시):', e.message); }
        storage.saveAgent(after);
      }
    }
  } catch (err) { console.error('[post:consolidate] 정리 오류 (무시):', err.message); }

  // ── (5) 루틴 처리 (activeId가 루틴일 때만) ──
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

  // ── (6) 관계역사: 주기적 관계 reflection (압축 N회마다 1회, LLM) ──
  // 누적된 대화요약(summaryHistory)에서 "관계 흐름"을 시기별 의미기억으로 뽑아 기억에 통합.
  // 별도 타임라인 없이 보통 기억과 같은 회상 경로. 비용 가드: 매번 아니고 압축 N회마다.
  try {
    const ag = storage.loadAgent(agentId);
    const cnt = (ag && ag.compressesSinceReflect) || 0;
    const hist = (ag && Array.isArray(ag.summaryHistory)) ? ag.summaryHistory : [];
    if (ag && cnt >= REFLECT_EVERY_COMPRESSES && hist.length >= 2) {
      console.log(`[post:relationship] 관계 reflection 트리거 (압축 ${cnt}회·요약 ${hist.length}개)`);
      const relFact = await brainClaude.reflectRelationship(hist, '최근', generate);
      const after = storage.loadAgent(agentId) || ag;
      after.compressesSinceReflect = 0; // 실행했으면 성공·실패 무관 리셋(다음 주기까지 대기)
      if (relFact) {
        relFact.scope = 'relationship'; // 관계기억(작업 격리 안 됨, 항상 회상 후보)
        brainClaude.ensureMemoryShape(after.humanFacts || []);
        const r = brainClaude.integrateMemory(after.humanFacts || [], [relFact], {}); // 의미 중복이면 병합
        after.humanFacts = r.merged;
        console.log(`[post:relationship] 관계기억: "${relFact.label}" = "${relFact.value}"`);
        onFacts(agentId, after.humanFacts);
      }
      storage.saveAgent(after);
    }
  } catch (e) { console.error('[post:relationship] 관계 reflection 오류(무시):', e.message); }

  const finalAgent = storage.loadAgent(agentId);
  return { added, updated, mergedCount, removed, humanFacts: (finalAgent && finalAgent.humanFacts) || [] };
}

module.exports = {
  runPostMemory, compressConversation,
  COMPRESS_TRIGGER, COMPRESS_CHUNK, CONSOLIDATE_MIN, CONSOLIDATE_DIRTY_THRESHOLD,
  ROUTINE_PROC_THRESHOLD, ROUTINE_RECENT_MAX,
};
