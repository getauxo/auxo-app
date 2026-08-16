'use strict';
/**
 * episode-memory.js — 일화(겪은 일) 추출 + "되풀이되면 존재로 올려보내기".
 *
 * ── 왜 일화가 있어야 하는가 ──
 *   인지과학에서 일화기억은 **저장고가 아니라 통로**다. 겪은 일이 되풀이되면
 *   시간·장소·맥락을 잃고 "이 사람은 이렇다"는 사실(의미기억)로 굳는다
 *   (Tulving 1972 / systems consolidation).
 *
 *   그런데 우리 일화는 통로가 아니라 **막다른 창고**였다:
 *     - 담는 범위가 "추천·결정·약속·방문" 뿐이라 "허리가 아프다" 같은 건 아예 안 들어왔고
 *     - 그릇으로 올라가는 길이 코드에 없었다
 *       (`promoteEpisodicToSemantic` 은 이름과 달리 일화를 보지 않고 그릇 안 기억만 만졌다)
 *   그래서 "여러 달에 걸쳐 열 번 말한 것"이 어디에도 쌓이지 않고 원문에만 흩어졌다.
 *
 * ── 그래서 바꾼 것 ──
 *   ① 범위: "관계에 의미 있는 사건" → "나중에 이 사람을 이해하는 데 쓰일, 겪은 일"
 *      (몸·마음 상태 / 실제로 한 일 / 겪은 어려움 추가)
 *   ② 애매하면 뽑는다. 일화는 매 턴 주입되지 않으므로 틀려도 손해가 작고,
 *      진짜 관문은 **그릇 입구**(아래 승격 판단)다.
 *   ③ 되풀이 감지 → 두뇌가 "이게 이 사람의 특징이냐" 판단 → 그릇에 한 줄.
 *
 * ── 되풀이를 어떻게 세는가 (비용) ──
 *   전부끼리 비교하면 개수의 제곱이라 무겁다(1만 개 → 5천만 번).
 *   **새로 들어온 일화 하나만** 기존 전체와 견준다 → 개수에 비례(선형). 10만 개여도 감당된다.
 *   글자 겹침이 아니라 뜻으로 견준다(로컬 임베딩. 두뇌 종류와 무관하게 동작).
 */

// 같은 얘기가 이만큼 모이면 "되풀이"로 보고 두뇌에게 물어본다.
//   2번은 우연일 수 있고 4번 이상이면 알아채는 게 늦다.
//   ※ 물어보기만 하는 시점이고 판단은 두뇌가 한다 — 이 숫자가 틀려도 잘못 저장되지 않는다.
const RECUR_COUNT = 3;
// 뜻이 이만큼 가까우면 같은 얘기로 본다.
//   ※ 근거 없는 값이다(오늘 정리한 그 목록의 하나). 다만 여기서는 **넉넉히 묶고 두뇌가 거르는**
//     구조라 틀렸을 때 사용자가 손해를 보지 않는다. 회상·검색 임계값과 성격이 다르다.
const RECUR_SIM = 0.72;

const EPISODE_SYSTEM_PROMPT = `너는 대화 구간에서 "이 사람이 겪은 일"을 뽑는 추출기야.
'이 사람이 어떤 사람인가'(지속적 사실)가 아니라 **그동안 있었던 일**을 뽑아.

## ★같은 일은 한 번만
여러 턴에 걸쳐 이야기된 **하나의 사건은 하나로** 적어.
  나쁨: "허리를 삐끗함" / "짐 옮기다 허리를 삐끗함" / "어제 허리를 삐끗함"  ← 같은 일을 세 번
  좋음: "짐을 옮기다 허리를 삐끗했고, 며칠째 오래 앉아 있으면 뻐근함"      ← 하나로, 경과까지
대화가 이어지며 같은 일이 되풀이 언급됐다면 **가장 온전한 한 줄**로 합쳐.

## 뽑을 것 — 나중에 이 사람을 이해하는 데 쓰일 만한, 겪은 일
- 몸·마음 상태: "허리를 삐끗함", "밤을 샘", "크게 기뻐함", "많이 지침"
- 실제로 한 일: 어디 갔다 / 뭘 먹었다 / 뭘 샀다 / 무엇을 해냈다
- 겪은 어려움: "그 작업이 잘 안 됨", "무엇 때문에 힘들어함"
- 함께 정한 결정·계획·약속
- 추천했고 사용자가 실제로 한 것
- 기억할 만한 순간·마일스톤(처음 ○○, 중요한 문제를 해결함)

## 뽑지 말 것
- 단순 정보 질문·답변(날씨·계산·검색), 인사, 도구 사용 과정
- 아직 안 정해진 가정적인 얘기
- 이 사람의 지속적 성향·선호 (그건 '사실'이지 '겪은 일'이 아님 — 다른 곳에서 다룬다)

**애매하면 뽑아둬.** 이건 바로 쓰이는 게 아니라 나중에 되풀이되는지 보려고 쌓아두는 거야.
다만 위 "뽑지 말 것"은 확실히 빼.

## 감정
겪은 일에는 감정이 실린다. weight(0.0~1.0)=감정의 세기, valence(-1.0~+1.0)=방향.
그냥 있었던 일이면 0 이어도 된다.

## 출력 (JSON 배열만, 설명 금지)
각 원소: {"type":"상태|행동|어려움|결정|추천|사건","summary":"한 문장 요지(구체적으로)",
         "entities":["장소·대상·핵심어"],"emotion":{"weight":0.0,"valence":0.0}}
겪은 일이 없으면 정확히 [] 만 출력.`;

function parseEpisodes(raw) {
  const m = String(raw || '').match(/\[[\s\S]*\]/);
  if (!m) return [];
  let arr; try { arr = JSON.parse(m[0]); } catch (_) { return []; }
  if (!Array.isArray(arr)) return [];
  return arr
    .filter(e => e && typeof e === 'object' && String(e.summary || '').trim())
    .map(e => {
      const em = (e.emotion && typeof e.emotion === 'object') ? e.emotion : {};
      const num = (v, lo, hi) => { const n = Number(v); return Number.isFinite(n) ? Math.max(lo, Math.min(hi, n)) : 0; };
      return {
        type: String(e.type || '사건').slice(0, 10),
        summary: String(e.summary).trim().slice(0, 200),
        entities: Array.isArray(e.entities) ? e.entities.map(x => String(x).slice(0, 30)).filter(Boolean).slice(0, 8) : [],
        emotion: { weight: num(em.weight, 0, 1), valence: num(em.valence, -1, 1) },
      };
    })
    .slice(0, 8); // 한 턴에 8개를 넘는 일화는 정상이 아니다
}

/**
 * 대화 구간에서 겪은 일을 뽑는다.
 *
 * ★**대화가 접힐 때 구간 통째로** 부른다(매 턴이 아니다).
 *   매 턴 부르면 대화창에 남은 앞 내용을 계속 다시 보고 같은 사건을 여러 번 적었다.
 * @param {string} conversation  구간 전체(여러 턴). 옛 호출부 호환으로 (user, agent) 2개도 받는다.
 */
async function extractEpisodes(conversation, agentResponse, generate, triesLeft = 1) {
  const conversationText = agentResponse
    ? `사용자: ${conversation}\n에이전트: ${agentResponse}`   // 옛 2인자 호출부 호환
    : String(conversation || '');
  try {
    const raw = await generate(
      EPISODE_SYSTEM_PROMPT,
      `다음 대화 구간에서 "겪은 일"을 뽑아. 같은 일은 한 줄로 합쳐. 없으면 []. JSON 배열만:\n\n${conversationText}`,
      { timeout: 60000, temperature: 0 },
    );
    const eps = parseEpisodes(raw);
    if (eps.length) console.log(`[episode] 일화 ${eps.length}개 추출`);
    return eps;
  } catch (err) {
    if (triesLeft > 0) { await new Promise(r => setTimeout(r, 1200)); return extractEpisodes(userMessage, agentResponse, generate, triesLeft - 1); }
    console.error('[episode] 추출 실패(포기):', err.message);
    return [];
  }
}

// ────────────────────────────────────────────────────────────────────────────
// 되풀이 감지 → 존재로 승격
// ────────────────────────────────────────────────────────────────────────────

function _epText(e) {
  return `${(e && e.summary) || ''} ${(e && Array.isArray(e.entities) ? e.entities.join(' ') : '')}`.trim();
}

/**
 * 새 일화들과 뜻이 가까운 옛 일화를 찾는다. **새것 하나 × 전체 = 선형.**
 *
 * @returns {Promise<Array<{seed:object, group:Array<object>}>>} RECUR_COUNT 이상 모인 묶음만
 */
async function findRecurring(newEpisodes, allEpisodes, embedder) {
  if (!Array.isArray(newEpisodes) || !newEpisodes.length) return [];
  if (!Array.isArray(allEpisodes) || allEpisodes.length < RECUR_COUNT) return [];
  if (!embedder) return []; // 뜻 비교가 안 되면 조용히 건너뛴다(글자 겹침으로는 "허리↔요통"을 못 잡는다)

  const { cosine } = require('./embeddings');
  const pool = allEpisodes.filter(e => e && e.summary && !e.promoted);
  if (pool.length < RECUR_COUNT) return [];

  let poolVecs, newVecs;
  try {
    poolVecs = await embedder.embed(pool.map(_epText));
    newVecs = await embedder.embed(newEpisodes.map(_epText));
  } catch (err) {
    console.warn('[episode:recur] 뜻 비교 실패(건너뜀):', err.message);
    return [];
  }

  const out = [];
  const usedSeeds = new Set();
  for (let i = 0; i < newEpisodes.length; i++) {
    const nv = newVecs[i];
    if (!Array.isArray(nv) || !nv.length) continue;
    const group = [];
    for (let j = 0; j < pool.length; j++) {
      const pv = poolVecs[j];
      if (!Array.isArray(pv) || !pv.length) continue;
      if (cosine(nv, pv) >= RECUR_SIM) group.push(pool[j]);
    }
    if (group.length < RECUR_COUNT) continue;
    // 같은 묶음을 두 번 올리지 않는다(한 턴에 비슷한 일화가 둘 뽑힌 경우).
    const key = group.map(g => g.summary).sort().join('|');
    if (usedSeeds.has(key)) continue;
    usedSeeds.add(key);
    out.push({ seed: newEpisodes[i], group });
  }
  if (out.length) console.log(`[episode:recur] 되풀이 묶음 ${out.length}개 발견 (${RECUR_COUNT}개 이상)`);
  return out;
}

const PROMOTE_SYSTEM_PROMPT = `이 사람이 겪은 일 몇 개가 되풀이되고 있어.
이게 **이 사람의 특징(존재)**이라고 볼 만한지 판단해줘.

## ★먼저 — 이미 기억하고 있는 것인지 확인해
아래에 **지금 기억하고 있는 것 전부**를 함께 줄 거야.
거기에 **같은 얘기가 이미 있으면 문장이 달라도 promote:false 다.**
  이미 있음: "커피를 하루 한 잔 마심 (주로 아침에). 위가 안 좋아 줄임"
  올리려는 것: "위가 예민한 편이라 커피를 하루 한 잔으로 줄여 드심"
  → **같은 얘기다. promote:false.**
기존 줄에 없는 **새로운 사실이 더해질 때만** 올려.

## 존재로 올릴 것 — 끝나는 시점이 정해져 있지 않은 것
  "허리가 아팠다"가 여러 번  →  "허리가 자주 안 좋음"          ○
  "매운 걸 먹고 탈났다"가 여러 번 →  "매운 음식이 잘 안 맞음"    ○
  "밤을 샜다"가 여러 번      →  "늦게까지 깨어 있는 편"          ○

## 올리지 말 것
  누구나 하는 일          "점심을 먹었다" → 특징이 아님          ✕
  끝나는 일이 되풀이된 것  "그 프로젝트 회의를 했다" → 끝나면 끝   ✕
  우연히 비슷해 보이는 것  서로 다른 얘기가 묶인 경우             ✕

**엄격하게 봐.** 이건 매 턴 항상 보이는 자리에 들어가는 거라, 시시한 게 들어가면 계속 걸리적거려.
애매하면 올리지 마. 다음에 더 쌓이면 또 물어볼 거야.

## 출력 (JSON 객체만)
올릴 때   {"promote":true,"text":"허리가 자주 안 좋음"}
안 올릴 때 {"promote":false}

text 는 한 줄로 짧게. **사용자가 직접 말한 게 아니라 우리가 지켜보고 미루어 짐작한 것**이므로
문장 끝에 "(여러 번 말씀하신 걸 보고)" 처럼 근거를 붙여.`;

/**
 * 되풀이 묶음이 "이 사람의 특징"인지 두뇌에게 묻는다.
 *
 * ★**현재 그릇 전문을 함께 보여준다.**
 *   전엔 되풀이 일화만 보여줘서, 두뇌가 "이미 기억하고 있는지" 알 길이 없었다.
 *   그래서 같은 얘기가 문장만 바꿔 다시 올라왔다(실측: 커피·허리 각각 2줄).
 *   그릇 편집(user-memory.planMemoryEdits)은 이미 전문을 보여주는데 승격만 안 보여주고 있었다.
 *
 * @param {Array}  group        되풀이로 묶인 일화들
 * @param {function} generate   두뇌
 * @param {string} [userMemory] 현재 그릇 전문(중복 판단용). 없으면 예전처럼 일화만 보고 판단.
 * @returns {Promise<{promote:boolean, text:string}>}
 */
async function judgePromotion(group, generate, userMemory = '') {
  const list = group.map((e, i) => `${i + 1}. [${e.date || e.ts || '날짜미상'}] ${e.summary}`).join('\n');
  const cur = String(userMemory || '').trim();
  let raw;
  try {
    raw = await generate(
      PROMOTE_SYSTEM_PROMPT,
      `[지금 기억하고 있는 것 — 여기 이미 있으면 올리지 마]\n${cur || '(아직 비어 있음)'}\n\n`
      + `[되풀이되는 겪은 일]\n${list}\n\nJSON 객체만 출력해.`,
      { timeout: 60000, temperature: 0 },
    );
  } catch (err) {
    console.error('[episode:promote] 판단 실패(무시):', err.message);
    return { promote: false, text: '' };
  }
  const m = String(raw || '').match(/\{[\s\S]*\}/);
  if (!m) return { promote: false, text: '' };
  let obj; try { obj = JSON.parse(m[0]); } catch (_) { return { promote: false, text: '' }; }
  const text = typeof obj.text === 'string' ? obj.text.trim() : '';
  return { promote: obj.promote === true && !!text, text };
}

module.exports = {
  RECUR_COUNT, RECUR_SIM,
  EPISODE_SYSTEM_PROMPT, PROMOTE_SYSTEM_PROMPT,
  parseEpisodes, extractEpisodes,
  findRecurring, judgePromotion,
  _epText,
};
