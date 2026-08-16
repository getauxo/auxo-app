'use strict';
/**
 * user-memory.js — "사용자에 대한 기억"(그릇) 단일 구현.
 *
 * ── 무엇을 담는가 ──
 *   이 사람의 **존재** = "끝점이 정해져 있지 않은 것".
 *     담는다   당뇨가 있다 / 커피 하루 한 잔 / eSIM 회사 대표 / 매운 걸 못 먹는다
 *     안 담는다 이직 준비 중(이직하면 끝) / 형 결혼식 10월(그날 지나면 끝) / 오늘 피곤함
 *   "바뀔 수 있다"와 "끝점이 있다"는 다르다 — 직업도 바뀌지만 끝점은 없다. 바뀌면 고쳐 쓴다.
 *
 * ── 왜 통짜 글인가 (낱개 → 통짜) ──
 *   낱개(humanFacts 배열)는 같은 사실이 이름만 달라 여러 칸으로 갈라지고,
 *   갱신 때 두뇌가 다른 칸을 못 봐서 덮어쓰며 마모된다.
 *   통짜 한 덩어리면 두뇌가 **글 전체를 보고** 고치므로 두 문제가 구조적으로 사라진다.
 *   낱개에 붙어 있던 중요도·강도·망각·연상·정리는 전부 필요 없어져 삭제했다
 *   (근거 없는 임계값 0.86/0.72/0.55/0.40/5/8/12/50/20/0.15 도 함께 사라짐).
 *
 * ── 왜 전문 재작성이 아니라 "편집 지시"인가 ★마모 방지의 핵심 ──
 *   매 턴 두뇌에게 전문을 다시 쓰게 하면 그때마다 조금씩 빠뜨린다(그게 오늘 잡은 마모).
 *   그래서 두뇌는 **바꿀 곳만** 지시하고(add/replace/remove), 코드가 그 줄만 만진다.
 *   지시에 없는 줄은 **바이트 단위로 그대로 남는다.** Letta 의 memory_insert/replace 와 같은 방식.
 *
 * ── 가득 차면 ──
 *   지우지도 줄이지도 서랍으로 옮기지도 않는다.
 *   ① 두뇌가 훑어 "끝점 있는 것"(잘못 들어온 사건)을 걷어낸다.
 *   ② 그래도 뺄 게 없으면 = 정말 그만한 사람이다 → 앱이 그릇을 +1,000자 늘리고 기록을 남긴다.
 *   존재를 깎는 건 그 사람을 깎는 것이다. 그릇이 작으면 그릇을 키운다.
 */

// 그릇 기본 크기(글자).
//   근거: 짧은 문장 100~150개 분량. 존재는 대화량이 아니라 "사람 하나"에 비례하므로
//   헤비유저가 10년을 써도 여기 닿기 어렵다. 닿으면 아래 GROW_STEP 으로 늘어나고 기록이 남는다.
const MEMORY_LIMIT_DEFAULT = 5000;
// 한 번에 늘리는 폭. 비율(20% 등)이면 커질수록 폭도 커져 폭주가 빠르므로 고정폭.
//   ※ 측정값이 아니라 판단이다. 늘어날 때마다 memoryGrowth 에 기록되므로 틀리면 드러난다.
const MEMORY_GROW_STEP = 1000;

const LINE_SEP = '\n';

/** 그릇 텍스트를 줄 배열로. 빈 줄 제거. */
function toLines(text) {
  return String(text || '').split(/\r?\n/).map(s => s.trim()).filter(Boolean);
}
/** 줄 배열을 그릇 텍스트로. */
function toText(lines) {
  return lines.filter(Boolean).join(LINE_SEP);
}
/** 그릇이 차지하는 글자 수(줄바꿈 포함). */
function memorySize(text) {
  return String(text || '').length;
}
/** 이 에이전트의 현재 그릇 상한. */
function limitOf(agent) {
  const n = Number(agent && agent.memoryLimit);
  return Number.isFinite(n) && n >= MEMORY_LIMIT_DEFAULT ? n : MEMORY_LIMIT_DEFAULT;
}

// 비교용 정규화 — 공백·따옴표·문장부호 차이로 같은 줄을 못 알아보는 걸 막는다.
function _norm(s) {
  return String(s || '').toLowerCase().replace(/["'“”‘’()（）]/g, '').replace(/\s+/g, '').replace(/[.,·!?]+$/g, '');
}

/**
 * 편집 지시를 그릇에 적용한다. **순수 함수 · LLM 0회.**
 *
 * 지시에 없는 줄은 손대지 않는다 — 이게 마모 방지의 전부다.
 *
 * @param {string} text   현재 그릇
 * @param {Array}  edits  [{op:'add'|'replace'|'remove', old?:string, text?:string}]
 * @returns {{text:string, applied:number, rejected:Array<{edit:object,why:string}>}}
 */
function applyMemoryEdits(text, edits) {
  const lines = toLines(text);
  const rejected = [];
  let applied = 0;
  if (!Array.isArray(edits)) return { text: toText(lines), applied, rejected };

  for (const e of edits) {
    if (!e || typeof e !== 'object') { rejected.push({ edit: e, why: '형식 오류' }); continue; }
    const op = String(e.op || '').toLowerCase();
    const body = String(e.text || '').trim();
    const old = String(e.old || '').trim();

    if (op === 'add') {
      if (!body) { rejected.push({ edit: e, why: '내용 없음' }); continue; }
      // 이미 같은 줄이 있으면 추가하지 않는다(중복 방지).
      if (lines.some(l => _norm(l) === _norm(body))) { rejected.push({ edit: e, why: '이미 있는 내용' }); continue; }
      lines.push(body);
      applied++;
      continue;
    }

    if (op === 'replace') {
      if (!old || !body) { rejected.push({ edit: e, why: 'old/text 누락' }); continue; }
      const idx = lines.findIndex(l => _norm(l) === _norm(old));
      // 지목한 줄을 못 찾으면 **아무것도 하지 않는다.** 짐작해서 다른 줄을 고치면 그게 마모다.
      if (idx < 0) { rejected.push({ edit: e, why: '지목한 줄을 못 찾음' }); continue; }
      lines[idx] = body;
      applied++;
      continue;
    }

    if (op === 'remove') {
      if (!old) { rejected.push({ edit: e, why: 'old 누락' }); continue; }
      const idx = lines.findIndex(l => _norm(l) === _norm(old));
      if (idx < 0) { rejected.push({ edit: e, why: '지목한 줄을 못 찾음' }); continue; }
      lines.splice(idx, 1);
      applied++;
      continue;
    }

    rejected.push({ edit: e, why: '알 수 없는 op: ' + op });
  }
  return { text: toText(lines), applied, rejected };
}

// ────────────────────────────────────────────────────────────────────────────
// 편집 지시 받기 (LLM 1회 / 대화 턴당)
// ────────────────────────────────────────────────────────────────────────────

const EDIT_SYSTEM_PROMPT = `너는 "이 사람에 대한 기억"을 관리하는 담당이야.
지금 적혀 있는 기억 전문과 아래 대화를 보고, **고칠 곳만** 지시해.

## 이 기억에 담는 것 — 이 사람의 "존재"
판단 기준은 딱 하나야: **끝나는 시점이 정해져 있나?**
- 정해져 있지 않다 → 담는다
    당뇨가 있음 / 커피를 하루 한 잔 마심 / eSIM 회사 대표 / 매운 걸 못 먹음 /
    형이 하나 있음 / 부산에서 자람 / 개발자가 아님 / 새벽 1시쯤 잠
- 정해져 있다 → **담지 마**
    이직 준비 중(이직하면 끝) / 형 결혼식 10월(그날 지나면 끝) /
    다음 주 회의 / 디스코드 봇 작업 중 / 오늘 피곤함 / 요즘 허리가 아픔
  → 이런 건 다른 곳에 따로 기록돼. 여기 담지 마.

**"바뀔 수 있다"와 "끝점이 있다"는 달라.** 직업도 사는 곳도 바뀌지만 끝점은 없어 → 담는다.
바뀌면 그때 replace 로 고쳐 쓰면 돼.

## 지시 방법 — 셋뿐이야
- add     : 새로 알게 된 것을 한 줄 추가
- replace : 기존 줄이 바뀌었을 때. old 에 **지금 적혀 있는 줄을 글자 그대로** 옮겨 적어
- (지우는 건 사용자가 직접 지워달라고 할 때만이라 여기선 안 써)

## ★가장 중요 — 지시하지 않은 줄은 그대로 남는다
- 바뀐 게 없으면 **빈 배열 []** 을 내. 그게 정상이고 대부분의 대화가 그래.
- replace 할 때 **원래 있던 정보를 지우지 마.** 바뀐 부분만 갈아끼우고 나머지는 남겨.
    나쁨: "당뇨가 있음(본인이 알려줌). 식사 때 참고" → "당뇨병 있음"   ← 출처·쓰임새가 사라졌다
    좋음: "커피를 하루 두 잔 마심(아침에)" → "커피를 하루 한 잔 마심(아침에). 위가 안 좋아 줄임"
- 서로 다른 얘기면 replace 가 아니라 add 야. ("좋아하는 음식"과 "못 먹는 음식"은 다른 줄)

## 우리가 지켜본 것 vs 사용자가 말한 것
사용자가 직접 말한 게 아니라 우리가 미루어 짐작한 것이면 문장 끝에 근거를 적어.
    "허리가 자주 안 좋음 (여러 번 말씀하신 걸 보고)"

## 첨부파일·문서에서 온 정보
사용자 본인 사실이 아니라 첨부파일·문서·제3자에게서 나온 정보면 target 을 "ref" 로 해.
누구 것인지 불확실하면 무조건 "ref". 특히 문서에 적힌 이름은 절대 사용자 본인이 아니야.

## 호칭
사용자가 자기를 뭐라고 부르라고 정하면(예: "나를 형이라고 불러") 기억에 넣지 말고
{"op":"nickname","text":"형"} 로 따로 알려줘. 호칭 문자열만.

## 출력
JSON 배열만. 다른 텍스트 절대 금지. 고칠 게 없으면 [].
[{"op":"add","target":"user","text":"당뇨가 있음 (본인이 알려줌)"},
 {"op":"replace","target":"user","old":"커피를 하루 두 잔 마심","text":"커피를 하루 한 잔 마심 (위가 안 좋아 줄임)"}]`;

function _parseEdits(raw) {
  const m = String(raw || '').match(/\[[\s\S]*\]/);
  if (!m) return [];
  let arr;
  try { arr = JSON.parse(m[0]); } catch (_) { return []; }
  if (!Array.isArray(arr)) return [];
  return arr
    .filter(e => e && typeof e === 'object')
    .map(e => ({
      op: String(e.op || '').toLowerCase(),
      target: String(e.target || 'user').toLowerCase() === 'ref' ? 'ref' : 'user',
      old: typeof e.old === 'string' ? e.old.trim() : '',
      text: typeof e.text === 'string' ? e.text.trim() : '',
    }))
    .filter(e => ['add', 'replace', 'remove', 'nickname'].includes(e.op))
    .slice(0, 12); // 한 턴에 12개를 넘는 편집은 정상이 아니다(폭주 차단)
}

/**
 * 이번 대화를 보고 그릇을 어떻게 고칠지 두뇌에게 묻는다.
 *
 * @returns {Promise<Array>} 편집 지시 배열(없으면 [])
 */
/**
 * @param {object} p
 * @param {string} [p.conversation] 접히는 구간 원문(주 경로 — 압축 시점에 통으로 본다)
 * @param {string} [p.userMessage]  옛 경로(한 왕복). conversation 이 없을 때만 쓴다.
 * @param {string} [p.agentResponse] 옛 경로(한 왕복)
 */
async function planMemoryEdits({ userMemory, refMemory, conversation, userMessage, agentResponse, generate }) {
  const cur = toLines(userMemory);
  const ref = toLines(refMemory);
  const curText = cur.length ? cur.join('\n') : '(아직 비어 있음)';
  const refText = ref.length ? ref.join('\n') : '(없음)';
  // ★주 재료는 **접히는 구간 통째**다(매 턴 한 왕복이 아니라 압축 시점 한 번).
  //   옛 시그니처(userMessage/agentResponse)도 그대로 받는다 — 테스트·다른 호출부 호환.
  const convo = String(conversation || '').trim()
    || `사용자: ${String(userMessage || '')}\n에이전트: ${String(agentResponse || '')}`;

  let raw;
  try {
    raw = await generate(
      EDIT_SYSTEM_PROMPT,
      `[지금 적혀 있는 기억 — 이 사람에 대해]\n${curText}\n\n`
      + `[참고 자료에서 온 정보]\n${refText}\n\n`
      + `[대화]\n${convo}\n\n고칠 것만 JSON 배열로. 없으면 [].`,
      { timeout: 60000, temperature: 0 },
    );
  } catch (err) {
    console.error('[user-memory] 편집 지시 받기 실패(무시):', err.message);
    return [];
  }
  return _parseEdits(raw);
}

// ────────────────────────────────────────────────────────────────────────────
// 가득 찼을 때 — 훑어서 "끝점 있는 것"만 걷어낸다
// ────────────────────────────────────────────────────────────────────────────

const OVERFLOW_SYSTEM_PROMPT = `이 기억은 "이 사람의 존재"만 담는 곳이야.
**끝나는 시점이 정해져 있는 것**은 여기 있으면 안 돼. 잘못 들어온 거야.

빼야 하는 예 — 끝점이 있는 것
  "이직 준비 중"(이직하면 끝) / "형 결혼식 10월"(그날 지나면 끝) /
  "디스코드 봇 작업 중"(끝나면 끝) / "다음 주 회의" / "요즘 피곤함"

두어야 하는 예 — 끝점이 없는 것
  "당뇨가 있음" / "커피 하루 한 잔" / "eSIM 회사 대표" / "매운 걸 못 먹음" / "부산에서 자람"

## 매우 중요
- **존재를 줄이거나 요약하지 마.** 뺄 건 "끝점 있는 줄" 뿐이야.
- 애매하면 **두는 쪽**으로. 잘못 빼면 그 사람의 일부가 사라진다.
- 뺄 게 하나도 없으면 **빈 배열 []** 을 내. 그게 맞는 답일 수 있어 — 그러면 그릇을 늘릴 거야.

## 출력
뺄 줄을 **글자 그대로** 옮겨 적어. JSON 배열만.
["이직 준비 중", "다음 주 화요일 회의"]`;

/**
 * 그릇이 가득 찼을 때 잘못 들어온 줄(끝점 있는 것)을 걷어낸다.
 *
 * @returns {Promise<{text:string, removed:Array<string>}>}
 */
async function reviewOverflow(userMemory, generate) {
  const lines = toLines(userMemory);
  if (!lines.length) return { text: toText(lines), removed: [] };
  let raw;
  try {
    raw = await generate(
      OVERFLOW_SYSTEM_PROMPT,
      `[지금 적혀 있는 기억]\n${lines.join('\n')}\n\n끝점이 정해져 있는 줄만 골라 JSON 배열로. 없으면 [].`,
      { timeout: 60000, temperature: 0 },
    );
  } catch (err) {
    console.error('[user-memory] 넘침 훑기 실패(무시):', err.message);
    return { text: toText(lines), removed: [] };
  }
  const m = String(raw || '').match(/\[[\s\S]*\]/);
  if (!m) return { text: toText(lines), removed: [] };
  let arr; try { arr = JSON.parse(m[0]); } catch (_) { return { text: toText(lines), removed: [] }; }
  if (!Array.isArray(arr) || !arr.length) return { text: toText(lines), removed: [] };

  const targets = arr.filter(x => typeof x === 'string').map(_norm);
  const kept = [], removed = [];
  for (const l of lines) {
    if (targets.includes(_norm(l))) removed.push(l); else kept.push(l);
  }
  return { text: toText(kept), removed };
}

/**
 * 그릇이 상한을 넘었으면 처리한다.
 *   ① 훑어서 끝점 있는 줄을 걷어낸다 → 자리가 나면 끝
 *   ② 뺄 게 없으면 상한을 +MEMORY_GROW_STEP 늘리고 기록을 남긴다 (존재는 안 깎는다)
 *
 * @param {object} agent  (in-place 수정: userMemory · memoryLimit · memoryGrowth)
 * @returns {Promise<{acted:boolean, removed:Array<string>, grewTo:number|null}>}
 */
async function handleOverflow(agent, generate, nowIso) {
  const limit = limitOf(agent);
  if (memorySize(agent.userMemory) <= limit) return { acted: false, removed: [], grewTo: null };

  console.warn(`[user-memory] 그릇 초과 — ${memorySize(agent.userMemory)}자 / 상한 ${limit}자. 훑기 시작`);
  const { text, removed } = await reviewOverflow(agent.userMemory, generate);

  if (removed.length && memorySize(text) <= limit) {
    agent.userMemory = text;
    console.log(`[user-memory] 잘못 들어온 ${removed.length}줄 걷어냄 → ${memorySize(text)}자. 상한 유지`);
    return { acted: true, removed, grewTo: null };
  }
  // 걷어냈는데도 넘치거나, 뺄 게 아예 없었다 → 그릇을 키운다. 존재는 안 깎는다.
  if (removed.length) agent.userMemory = text;
  const from = limit;
  let to = from;
  while (memorySize(agent.userMemory) > to) to += MEMORY_GROW_STEP;
  agent.memoryLimit = to;
  agent.memoryGrowth = Array.isArray(agent.memoryGrowth) ? agent.memoryGrowth : [];
  agent.memoryGrowth.push({ at: nowIso || new Date().toISOString(), from, to, size: memorySize(agent.userMemory), removed: removed.length });
  console.warn(`[user-memory] 뺄 것 없음(걷어낸 ${removed.length}줄) → 그릇 ${from}→${to}자로 늘림. 기록 남김`);
  return { acted: true, removed, grewTo: to };
}

// ────────────────────────────────────────────────────────────────────────────
// 낡은 데이터 흡수 — 옛 낱개 기억(humanFacts)이 남아 있으면 글로 풀어 넣는다
// ────────────────────────────────────────────────────────────────────────────

/**
 * 옛 낱개 기억을 통짜 글로 옮긴다. **1회성, 멱등.**
 * 이관하지 않은 채 실행돼도 기억을 잃지 않게 한다.
 *
 * @param {object} agent  (in-place)
 * @returns {number} 옮긴 줄 수 (없으면 0)
 */
function absorbLegacyFacts(agent) {
  if (!agent || !Array.isArray(agent.humanFacts) || !agent.humanFacts.length) return 0;
  const userLines = toLines(agent.userMemory);
  const refLines = toLines(agent.refMemory);
  let moved = 0;
  for (const f of agent.humanFacts) {
    if (!f || typeof f.value !== 'string' || !f.value.trim()) continue;
    const label = String(f.label || '').trim();
    // 이름은 화면에 안 쓰이던 잔재라 버리되, 값만으로 뜻이 안 통하면 앞에 붙여 살린다.
    const line = (label && !f.value.includes(label)) ? `${label}: ${f.value.trim()}` : f.value.trim();
    const bucket = (f.subject === 'reference') ? refLines : userLines;
    if (bucket.some(l => _norm(l) === _norm(line))) continue;
    bucket.push(line);
    moved++;
  }
  if (moved) {
    agent.userMemory = toText(userLines);
    agent.refMemory = toText(refLines);
    console.log(`[user-memory] 옛 낱개 기억 ${moved}줄을 통짜로 옮김(1회성)`);
  }
  agent.humanFacts = []; // 옮겼으면 비운다(멱등 — 두 번 돌아도 중복 안 생김)
  return moved;
}

module.exports = {
  MEMORY_LIMIT_DEFAULT, MEMORY_GROW_STEP,
  toLines, toText, memorySize, limitOf,
  applyMemoryEdits, planMemoryEdits,
  reviewOverflow, handleOverflow,
  absorbLegacyFacts,
  EDIT_SYSTEM_PROMPT, OVERFLOW_SYSTEM_PROMPT,
  _norm,
};
