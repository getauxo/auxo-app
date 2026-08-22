/**
 * engine.js — 채널 무관 대화 엔진 코어 (walking skeleton v1)
 *
 * 앱(Electron)·CLI·봇 등 어느 창구든 "같은 두뇌·같은 기억 파이프라인"을 쓰도록
 * main.js chat:send 의 핵심 골자를 추출한 모듈. Electron 의존 없음.
 *
 * v1 범위: 에이전트 로드 → 1층+성격+회상된 기억 프롬프트 → 회상(키워드) → 응답 →
 *          대화 저장 → 기억 추출·병합·망각.
 * v2 예정: 도구루프(use_skill/MCP/work)·L2 작업기억·대화 압축·임베딩 의미검색·강화·정리.
 *
 * storage 는 호출자가 storage.init(userDataPath) 한 뒤 사용한다.
 * → 데이터 경로(= 에이전트가 사는 곳)는 "창구"가 결정한다. 앱과 CLI 가 다른 경로를 쓰면 분리.
 */
'use strict';

const path = require('path');
const fs = require('fs');
const storage = require('./storage');
const memoryTools = require('./memory-tools');
const agentQueue = require('./agent-queue');
const brainClaude = require('./brain-claude');
const youtube = require('./youtube-transcript'); // 유튜브 링크 자동 감지 → 자막/전사 주입(전 채널)
const brainGemini = require('./brain-gemini');
const brainAnthropic = require('./brain-anthropic');
const brainOpenai = require('./brain-openai');
const brainCodex = require('./brain-codex');
const mcpGateway = require('./mcp-gateway');
const embeddings = require('./embeddings');
const localTools = require('./tools');
const scheduler = require('./scheduler');   // 1층에 "지금 걸린 알림"을 사실로 싣는다(describe)
const subagents = require('./subagents');
const agentTools = require('./agent-tools');
const toolDecls = require('./tool-decls'); // 도구 선언 원본(두뇌 공통)
const skillsRegistry = require('./skills-registry');
const mcpManager = require('./mcp-manager');
const learnSkill = require('./learn-skill'); // P3.2 자가학습 reflection
const toolTransparency = require('./tool-transparency'); // 안전장치 3: 도구 사용 투명 표시
const claimCheck = require('./claim-check'); // 정직 계층 ⑤: 말과 행동 대조
const grants = require('./grants');
const memoryPost = require('./memory-post'); // 대화 후 기억 후처리(추출·압축·망각·정리·루틴) 공통 모듈
const memorySearch = require('./memory-search'); // 기억 v3: 일화 자동 회상(선제 주입) + 검색

// REST 두뇌는 풀 도구셋(스킬·MCP·작업기억·L3)을 function-calling 으로 받는다(앱 TOOLS_PROVIDERS 와 동일).
const TOOLS_BRAINS = new Set(['gemini-api', 'claude-api', 'openai-api', 'openai-compatible']);
/**
 * ★실패의 정직한 전달.
 *
 * 모든 실패를 "지금 바로 답을 드리지 못했어요 … (일시적 오류)" 한 문장으로 뭉개면 문제가 셋이다:
 *  ① 원인을 알면서(auxo-error.log 에 기록까지 하면서) 사용자에게 숨겼다.
 *  ② 사용량 한도·키 만료·로그아웃은 **일시적이 아닌데** "일시적"이라 단정했다 = 거짓.
 *  ③ "다시 말 걸어주세요"는 한도일 때 해결되지 않는 조언 → 다시 시도 → 또 실패 = 막다른 길.
 * → 원인을 분류해 **사실대로 + 해결책까지** 말한다. 우리 정직 계층의 기본이다.
 *
 * @returns {{kind: string, text: string, retryable: boolean}}
 */
const _BRAIN_LABEL = {
  'claude-subscription': 'Claude 구독', 'codex-subscription': 'Codex 구독',
  'gemini-api': 'Gemini', 'claude-api': 'Claude API',
  'openai-api': 'GPT', 'openai-compatible': '연결된 모델',
};
function classifyBrainError(err, brainMode) {
  const m = String((err && err.message) || '');
  const who = _BRAIN_LABEL[brainMode] || '지금 두뇌';

  // ⓪ 결제·크레딧 부족 — ★키를 받고 충전을 안 한 사용자가 **가장 흔하게** 만나는 실패다.
  //    분류가 없으면 ⑦(unknown)으로 떨어져 화면에 영어 JSON 원문이 그대로 나간다(실측).
  //      Anthropic API 400: {"error":{"message":"Your credit balance is too low to access the
  //      Anthropic API. Please go to Plans & Billing to upgrade or purchase credits."}}
  //    비개발자는 이걸 읽고 뭘 해야 할지 알 수 없다. 할 일이 딱 하나(충전)라 그것만 말한다.
  //    ★★①보다 **먼저** 와야 한다 — OpenAI 는 크레딧 부족을 429 + 'exceeded your current quota' 로 보내는데,
  //      ①의 패턴에 `quota` 가 있어 거기 먼저 걸리면 **"시간이 지나야 풀려요"라는 틀린 안내**가 나간다.
  //      (실제로는 충전해야 풀린다. 기다리면 영영 안 풀린다.)
  if (/credit balance is too low|insufficient[_ ]quota|insufficient credit|billing.{0,20}(hard limit|not active)|exceeded your current quota|purchase credits|add a payment method/i.test(m)) {
    const 곳 = brainMode === 'claude-api' ? 'Anthropic Console(console.anthropic.com) → Plans & Billing'
             : brainMode === 'openai-api' ? 'OpenAI Platform(platform.openai.com) → Settings → Billing'
             : brainMode === 'gemini-api' ? 'Google AI Studio → 결제(Billing)'
             : '해당 제공사의 결제(Billing) 화면';
    return { kind: 'billing', retryable: false,
      text: `${who}의 결제 잔액이 부족해서 연결이 안 됐어요. ${곳} 에서 크레딧을 충전한 뒤 다시 말 걸어주세요. (키는 정상이에요 — 충전만 하면 바로 이어집니다.)` };
  }
  // ⓪-b 모델이 없거나 폐기됨 — 제공사가 모델을 내리면 404 가 오는데, 분류가 없으면
  //    ⑦로 떨어져 JSON 이 그대로 나간다. 사용자가 할 일은 "다른 모델 고르기" 하나다.
  if (/model.{0,20}(not found|does not exist|has been deprecated|is deprecated)|model_not_found|MODEL_NOT_SET/i.test(m)) {
    if (/MODEL_NOT_SET/.test(m)) {
      return { kind: 'model_unset', retryable: false,
        text: '쓸 모델을 아직 안 골랐어요. 설정 > AI 모델에서 [모델 불러오기]를 누르고 하나 골라주세요.' };
    }
    return { kind: 'model_gone', retryable: false,
      text: `지금 고른 모델은 ${who} 쪽에서 더 이상 쓸 수 없어요. 설정 > AI 모델에서 [모델 불러오기]를 눌러 다른 모델을 골라주세요.` };
  }
  // ① 사용량 한도 — 줄여도 소용없다. 시간이 지나야 풀린다. 재시도 금지.
  //    CLI(구독)="You've hit your session limit · resets 3:45pm" / API=429 {"type":"rate_limit_error"} + retry-after
  if (/usage limit reached|hit your .{0,20}limit|limit will reset|\b429\b|rate.?limit|rate_limit_error|quota|too many requests/i.test(m)) {
    const at = m.match(/resets?(?:\s+at)?\s+([0-9]{1,2}:[0-9]{2}\s*(?:am|pm)?[^\s,.)]*)/i)
            || m.match(/try again after\s+([^\.\n,]+)/i)
            || m.match(/retry[- ]after[":\s]+(\d+)\s*(?:seconds?)?/i);
    const when = at ? ` (${/^\d+$/.test(at[1]) ? `약 ${Math.ceil(Number(at[1]) / 60)}분 뒤` : at[1]} 쯤 풀려요)` : '';
    return { kind: 'usage_limit', retryable: false,
      text: `${who} 사용량 한도에 걸렸어요.${when} 한도는 시간이 지나야 풀려서, 지금 다시 물어도 같은 결과예요. 설정에서 다른 두뇌로 바꾸면 바로 이어갈 수 있어요.` };
  }
  // ② 컨텍스트 초과 — 접지 않고 사실대로. (다른 모델 스펙을 우리가 모르므로 "저건 되니 바꾸세요" 식 추측 금지)
  if (/context.{0,20}(length|window).{0,20}(exceed|too long)|maximum context|too many tokens|prompt is too long/i.test(m)) {
    return { kind: 'context', retryable: false,
      text: '대화가 너무 길어져서 이번 요청을 못 보냈어요. 새로 대화를 시작하거나, 더 큰 모델을 쓰는 방법이 있어요.' };
  }
  // ②-b 답이 통째로 비어 왔다 — **왜 비었는지에 따라 사용자가 할 일이 다르다.**
  //     예전엔 두뇌 파일이 "음... 지금 제대로 답을 못 드리겠네요. 다시 한번 말씀해 주시겠어요?"로 덮었다.
  //     그러면 ①사용자는 **자기가 잘못 말한 줄 알고** 같은 말을 되풀이하고(그래도 또 빈다)
  //     ②우리는 원인을 영영 못 본다. 실측(2026-08-14, gemini): 도구는 정상 호출됐는데 답만 비었다.
  //     ※ 아직 실제 finishReason 을 못 봤다 — 아래 값들은 Gemini 문서상 정의된 값이라 미리 갈라 둔 것이고,
  //       우리 사례가 어느 쪽인지는 확증하지 않았다. 모르면 모른다고 말하는 마지막 갈래를 둔다.
  // 세 두뇌가 필드명도 값도 다르다 → 여기서 한 번에 받는다.
  //   gemini finishReason=MAX_TOKENS / openai finish_reason=length / anthropic stop_reason=max_tokens
  if (/텍스트 없음|finish_?reason=|stop_reason=/i.test(m)) {
    if (/MAX_TOKENS|reason=length/i.test(m)) {
      return { kind: 'output_truncated', retryable: false,
        text: '답이 너무 길어져서 끝을 못 맺었어요. 질문을 몇 개로 나눠서 물어보시면 끝까지 답할 수 있어요.' };
    }
    if (/SAFETY|RECITATION|BLOCKLIST|PROHIBITED|content_filter|refusal/i.test(m)) {
      return { kind: 'blocked', retryable: false,
        text: `${who} 쪽 안전 필터에 걸려서 답이 안 왔어요. 표현을 조금 바꿔서 다시 물어봐 주세요.` };
    }
    return { kind: 'empty_response', retryable: true,
      text: `${who}가 이번엔 빈 답을 보냈어요. 한 번 더 말 걸어주시면 이어갈게요. (사장님 말씀이 잘못된 건 아니에요.)` };
  }
  // ③-a 이 두뇌의 키가 아직 없다 — **남의 키로 대신 부르지 않는다.**
  //     예전엔 옛 단일키로 폴백해서 "제미나이 키로 OpenAI 호출 → 401"이 났다.
  //     ★이 안내를 보는 사람은 대개 **에이전트를 파일로 가져온 사용자**다.
  //       설정 화면은 키 없이 저장을 막지만(app.js needsKey 검사), 내보내기는 brainMode 는 담고
  //       **키는 일부러 뺀다**(companion-format — 키가 파일에 딸려가면 안 되니까).
  //       그래서 가져오면 "두뇌는 있는데 키는 없는" 상태가 되고, 첫 말에 바로 여기로 온다.
  //       예전엔 이 자리에서 `GEMINI_API_KEY 없음 (env …)` 같은 **개발자 문구가 그대로 화면에 나갔고**,
  //       거기 붙은 "다시 말 걸어주시면"은 **틀린 안내**였다(다시 말해도 똑같이 실패한다).
  //     가져온 사람이 가장 먼저 걱정하는 건 "내 기억도 날아갔나"다 — 그걸 먼저 안심시킨다.
  if (/API_KEY_MISSING/.test(m)) {
    return { kind: 'key_missing', retryable: false,
      text: `${who}에 연결할 API 키가 없어요. 설정 > AI 모델에서 키를 넣어주시면 바로 이어갈 수 있어요. `
          + '(에이전트를 파일로 가져오셨다면 — 키는 안전을 위해 같이 옮겨지지 않아요. 기억과 성격은 그대로예요.)' };
  }
  // ③ 인증·키
  if (/\b401\b|\b403\b|invalid.{0,12}(api)?.?key|unauthorized|authentication|api key not valid/i.test(m)) {
    return { kind: 'auth', retryable: false,
      text: `${who} 인증이 거부됐어요. 설정 > 두뇌에서 API 키를 확인해주세요.` };
  }
  // ④ 구독 CLI 로그아웃 / 미설치
  if (/로그인|not logged in|please log ?in|unauthenticated/i.test(m)) {
    return { kind: 'login', retryable: false, text: `${who} 로그인이 풀렸어요. 터미널에서 로그인한 뒤 다시 말 걸어주세요.` };
  }
  if (/CLI를 찾을 수 없|ENOENT|command not found/i.test(m)) {
    return { kind: 'not_found', retryable: false, text: `${who} 실행 파일을 못 찾았어요. 설치 상태를 확인하거나 설정에서 다른 두뇌로 바꿔주세요.` };
  }
  // ⑤ 네트워크 — 진짜 일시적
  if (/ETIMEDOUT|ECONNRESET|ENOTFOUND|EAI_AGAIN|ECONNREFUSED|EPIPE|fetch failed|network|socket hang up/i.test(m)) {
    return { kind: 'network', retryable: true, text: '인터넷 연결이 불안정해서 답을 못 받았어요. 연결을 확인하고 다시 말 걸어주세요.' };
  }
  // ⑥ 과부하·타임아웃 — 진짜 일시적
  if (/\b(503|529)\b|overloaded|unavailable|high demand/i.test(m)) {
    return { kind: 'overloaded', retryable: true, text: `${who} 쪽이 지금 몰려서 응답을 못 받았어요. 잠시 후 다시 말 걸어주세요.` };
  }
  if (/시간 초과|timeout|스트리밍 실패|killed|SIGTERM/i.test(m)) {
    return { kind: 'timeout', retryable: true, text: '답이 너무 오래 걸려서 중간에 끊겼어요. 다시 말 걸어주시면 이어서 해볼게요.' };
  }
  // ⑦ 그 외 — 원인을 숨기지 않는다(모르면 모른다고 하되 실제 메시지를 보여준다)
  return { kind: 'unknown', retryable: true,
    text: `지금 답을 못 드렸어요. 원인은 이렇게 나왔어요: "${m.slice(0, 160)}" — 다시 말 걸어주시면 이어서 해볼게요.` };
}

// opts.webSearch(네이티브 검색 스위치) 배선이 필요한 REST 두뇌.
// gemini-api는 brain-gemini가 자체 'web' 도구(WEB_DECL)를 매 라운드 항상 붙여 검색하므로 제외(중복·충돌 방지).
// claude-api는 brain-anthropic이 opts.webSearch일 때만 네이티브 web_search를 붙임 → 여기서 켜준다(안 켜면 검색 0인데 능력은 광고됨).
// ★"제공자 **네이티브** 웹검색을 켤 두뇌" — 검색 능력의 유무가 아니다.
//   claude-api 만 서버도구(web_search)를 요청 몸통에 붙인다. 나머지도 **검색은 된다** —
//   gemini 는 자체 `web` 도구로, openai 는 우리 공용 `web_search` 도구(ALWAYS)로 한다(셋 다 실측).
//   ⚠️여기 없다고 "그 두뇌는 검색 못 한다"로 읽지 말 것. 내가 그렇게 읽고 사용자 문구를 틀리게 썼다.
const WEBSEARCH_BRAINS = new Set(['claude-api']);
// 위험 MCP 도구 승인 대기(턴 간) — CLI/봇 프로세스 전역.
const _enginePendingMcp = new Map();

// 서브에이전트(위임)를 function-calling 으로 즉시 쓸 수 있는 REST 두뇌.
// claude·codex 구독은 도구를 MCP 서버 경유로 받아 별도 작업 필요 → v1 제외(subagent-design.md).
const REST_BRAINS = new Set(['gemini-api', 'openai-api', 'claude-api', 'openai-compatible']);
// 키가 있어야만 부를 수 있는 두뇌(구독 CLI 두뇌는 로그인으로 쓰므로 키가 없다).
const API_KEY_BRAINS = REST_BRAINS;

/**
 * 에이전트 두뇌(brainMode) → (systemPrompt, userPrompt, opts) => Promise<text> 생성기.
 * 모든 LLM 두뇌를 한 시그니처로 통일. 알 수 없는/미설정 두뇌는 null.
 * (main.js pickGenerate 와 동일 — 추후 main.js 가 이 모듈을 재사용하도록 통합 예정)
 */
function pickGenerate(agent) {
  // ★**그 두뇌의 키·모델만 쓴다.** 예전엔 없으면 옛 단일키(agent.apiKey)로 폴백했는데,
  //   그건 "제미나이 키로 OpenAI 를 부른다"는 뜻이었다 → 401 Incorrect API key(실측 2026-08-14).
  //   특히 우리는 한도에 걸린 사용자에게 **"다른 두뇌로 바꾸면 이어갈 수 있어요"라고 안내한다.**
  //   그 안내를 따르면 바로 이 길로 들어갔다. 사용자 눈엔 키가 채워져 있으니 자기 키를 의심하게 된다.
  //   옛 데이터 호환은 storage._ensureKeyring 이 로드마다 apiKeys/models 로 옮겨 주므로 폴백은 필요 없다.
  const key = (agent.apiKeys && agent.apiKeys[agent.brainMode]) || '';
  const mdl = (agent.models && agent.models[agent.brainMode]) || '';
  // 키가 있어야 하는 두뇌인데 비었으면, 남의 키로 부르지 말고 **무엇을 해야 하는지** 말한다.
  if (API_KEY_BRAINS.has(agent.brainMode) && !key) {
    return () => { throw new Error(`API_KEY_MISSING: ${agent.brainMode}`); };
  }
  switch (agent.brainMode) {
    case 'gemini-api':
      return (sys, usr, opts = {}) => brainGemini.geminiGenerate(sys, usr, { ...opts, apiKey: key, model: mdl });
    case 'claude-subscription':
      return (sys, usr, opts = {}) => brainClaude.claudeGenerate(sys, usr, opts);
    case 'codex-subscription':
      return (sys, usr, opts = {}) => brainCodex.codexGenerate(sys, usr, opts);
    case 'claude-api':
      return (sys, usr, opts = {}) => brainAnthropic.anthropicGenerate(sys, usr, { ...opts, apiKey: key, model: mdl });
    case 'openai-api':
      return (sys, usr, opts = {}) => brainOpenai.openaiGenerate(sys, usr, { ...opts, apiKey: key, model: mdl });
    case 'openai-compatible':
      return (sys, usr, opts = {}) => brainOpenai.openaiGenerate(sys, usr, { ...opts, apiKey: key, model: mdl, baseURL: agent.baseURL });
    default:
      return null; // 미설정/알 수 없는 두뇌
  }
}

/**
 * 한 번의 대화 턴을 처리한다(응답 생성 + 대화 저장).
 * 기억 후처리는 processMemory 로 분리(응답을 먼저 돌려줄 수 있게).
 *
 * @param {object}   p
 * @param {string}   p.agentId
 * @param {string}   p.userMessage
 * @param {function} [p.emit]  (type, payload) 진행 이벤트 콜백(선택)
 * @returns {Promise<{response?, recallCount?, generate?, error?}>}
 */
/**
 * 구독 두뇌(claude/codex)의 send_file 우편함(outbox-<agentId>.json)을 비우며 실제 채널로 전송한다.
 * MCP 서버는 별도 프로세스라 deliverFile 콜백을 못 받으므로, 우편함에 남긴 요청을 호스트가 여기서 대신 보낸다.
 * @returns {Promise<Array>} 실제 전송된 파일들 [{path,name,note}]
 */
async function drainOutbox(agentId, deliverFile) {
  if (typeof deliverFile !== 'function') return [];
  const outbox = path.join(path.dirname(storage.getDataPath()), `outbox-${agentId}.json`);
  let list = [];
  try { list = JSON.parse(fs.readFileSync(outbox, 'utf8')); } catch (_) { return []; }
  if (!Array.isArray(list) || !list.length) return [];
  try { fs.unlinkSync(outbox); } catch (_) {} // 먼저 비워 중복 전송 방지
  const sent = [];
  for (const it of list) {
    if (!it || !it.path) continue;
    try {
      const name = path.basename(it.path);
      const out = await deliverFile({ path: it.path, name, note: it.note || '' });
      if (!(out && out.error)) sent.push({ path: it.path, name, note: it.note || '' });
    } catch (_) { /* 개별 전송 실패는 나머지에 영향 안 줌 */ }
  }
  return sent;
}

/**
 * 승인 대기 상태에서 사용자의 답이 승인인지 거절인지 판정한다.
 *
 * 왜 LLM인가:
 *   정규식 단어 목록으로 판정하면(승인=그래|응|네|좋아|ok…, 취소=아니|싫|안해…)
 *   목록에 없는 말("ㄱㄱ", "가보자", "그러든지")은 못 알아듣고, 두 목록에 동시에 걸리는 말
 *   ("안 해도 될 것 같은데 그냥 해줘")은 취소로 뒤집힌다. 사람 말의 의미를 판정하는 건
 *   LLM 이 제일 잘하는 일이라 단어 목록으로 대신하지 않는다.
 *
 * 안전: 실행 통제권은 그대로 코드에 있다. LLM 은 '무슨 뜻인지'만 답하고, 실제 실행은 엔진이 한다.
 *   판정 실패·타임아웃·형식 불명은 전부 UNCLEAR → 사용자에게 다시 묻는다(fail-safe).
 *   즉 애매하면 실행하지 않는 쪽으로 기운다.
 */
async function judgeApproval(generate, userMessage, what) {
  // ★실측: *"응 그럼 잘 자"* · *"네 근데 그건 그렇고 저녁 뭐 먹지?"* 같은 말이
  //   폴더 접근과 MCP 도구 실행 **양쪽에서 APPROVE** 로 판정된 적이 있다.
  //   앞의 긍정어("응/네")만 보고 뒤 내용이 무관해도 승인으로 읽은 것이다.
  //   사용자는 인사한 줄 아는데 폴더가 열리거나 도구가 실행된다.
  //   → **"무엇에 대한 승인인지"를 판정 기준의 앞에 세운다.** 승인은 "그 일을 하라"는 뜻일 때만.
  //   ⚠️ 조일 때 반대쪽(진짜 승인을 UNCLEAR 로 떨구는 것)이 늘면 사용자가 답답해진다.
  //      measure-approval-judge.js 가 두 숫자(위험/답답)를 함께 재니 고칠 때 꼭 같이 볼 것.
  const sys = '너는 사용자의 답을 분류하는 판정기야. 설명·인사 없이 APPROVE, AUTO, REJECT, UNCLEAR 중 한 단어만 출력해.';
  const prompt = `[상황] 방금 사용자에게 "${what}"을(를) 해도 되는지 물어봤어.\n`
    + `[사용자 답] ${String(userMessage || '').slice(0, 500)}\n\n`
    + `이 답이 **그 일(${what})에 대한 대답인지** 먼저 보고, 한 단어로만 답해.\n`
    + `APPROVE = 그 일을 해도 된다는 뜻이 분명하다\n`
    + `AUTO = 앞으로도 묻지 말고 알아서 하라 (이번 것도 해도 된다는 뜻)\n`
    + `REJECT = 하지 말라\n`
    + `UNCLEAR = 그 밖의 전부 — 승인도 거절도 아니거나, **그 일과 상관없는 얘기를 하고 있다**\n\n`
    + `★가장 흔한 실수: 문장이 "응/네/그래/어"로 시작한다고 APPROVE 로 보는 것.\n`
    + `  그 말들은 그냥 말버릇이거나 앞말에 대한 맞장구일 때가 많다.\n`
    + `  **뒤에 오는 내용이 그 일과 상관없으면 UNCLEAR 다.** 예:\n`
    + `   · "응 그럼 잘 자" → 인사다. UNCLEAR\n`
    + `   · "네 근데 그건 그렇고 저녁 뭐 먹지?" → 화제를 바꿨다. UNCLEAR\n`
    + `   · "응 그래서 내일 하기로 했어" → 다른 일 얘기다. UNCLEAR\n`
    + `  반대로 그 일을 하라는 뜻이 분명하면 APPROVE 다. 예:\n`
    + `   · "응 해줘" / "그래 허용할게" / "네 진행하세요" → APPROVE\n\n`
    + `애매하면 UNCLEAR. 다시 물어보면 되지만, 잘못 승인하면 되돌릴 수 없다.\n`
    + `오직 한 단어만.`;
  try {
    const raw = await generate(sys, prompt, { temperature: 0, timeout: 20000 });
    const s = String(raw || '').toUpperCase();
    if (/\bAUTO\b/.test(s)) return 'AUTO';
    if (/\bAPPROVE\b/.test(s)) return 'APPROVE';
    if (/\bREJECT\b/.test(s)) return 'REJECT';
    return 'UNCLEAR';
  } catch (_) {
    return 'UNCLEAR'; // 판정 자체가 실패하면 실행하지 않고 다시 묻는다
  }
}

// 같은 에이전트의 턴은 한 번에 하나씩 처리한다(앱 chat:send 와 동일 규칙).
// 텔레그램·디스코드는 사용자가 연달아 메시지를 보내기 쉬운 채널이라 특히 중요하다.
async function runTurn(opts) {
  return agentQueue.runExclusive(opts && opts.agentId, () => _runTurn(opts));
}

async function _runTurn({ agentId, userMessage, emit = () => {}, attachments, deliverFile, displayUserMessage, userFiles, onDelta, signal, channel }) {
  // ★어느 창구에서 온 턴인지 남긴다 — 예약 알림을 **걸었던 그 창구로** 보내기 위함(2026-08-20).
  //   전엔 이 정보가 아예 없어서 텔레그램에서 걸어도 알림이 앱으로만 갔다.
  //   두뇌에게 묻지 않는다. 코드가 아는 사실이므로 코드가 넣는다.
  //   ※ 저장소에 두는 이유 = 구독 두뇌는 MCP 가 **별도 프로세스**라 메모리를 못 나눈다([[storage.setActiveChannel]] 주석).
  if (channel) { try { storage.setActiveChannel(agentId, channel); } catch (_) {} }
  // 저장/표시용 메시지(displayUserMessage)와 두뇌 전달용(userMessage)을 분리 가능.
  // 앱이 첨부를 인테이크한 뒤: 두뇌엔 파일내용·경로 인라인(userMessage), 대화엔 "첨부: 이름"만(displayUserMessage)
  // + 첨부 원본 카드(userFiles)를 사용자 메시지에 붙인다. 미지정 시 기존 동작(둘 다 userMessage, 카드 없음).
  const agent = storage.loadAgent(agentId);
  if (!agent) return { error: '에이전트를 찾을 수 없음' };

  // 프롬프트용 히스토리에선 실패 마커(error:true)를 뺀다 — 화면엔 남지만 두뇌엔 안 먹인다(모델 오염 방지).
  // 표시는 렌더러가 storage.loadConversation 을 직접 읽으므로 마커가 그대로 보인다.
  // 두뇌가 보는 대화 = 아카이브(압축으로 접혀 내려간 옛 원문) + 현재 대화.
  // ★현재 대화만 읽으면 압축으로 아카이브에 내려간 대화가 두뇌 시야에서 통째로 사라진다
  //   (저장은 살아 있는데 두뇌만 못 봄 → "받은 적 없다" 거짓의 한 원인). 저장 위치가 달라도 기억은 하나다.
  // 대용량 대비: 아카이브를 통째로 읽지 않고 **맨 앞(head) + 최근(tail)** 만 읽는다.
  //   오래 쓴 사용자(수만 개)일수록 매 턴 전량 로드가 답을 느리게 만든다 — 우리 지향점이 "오래 함께한 친구"라 그대로 둘 수 없다.
  const _arch = storage.loadArchivedWindow(agentId);
  const messages = [].concat(
    _arch.head || [], _arch.tail || [],
    storage.loadConversation(agentId) || []
  ).filter(m => !(m && m.error));
  // 기억 그릇(통짜) — 옛 낱개 데이터가 남아 있으면 여기서 한 번 흡수하고 저장한다(멱등).
  const userMemory = require('./user-memory');
  if (Array.isArray(agent.humanFacts) && agent.humanFacts.length) {
    try {
      const fa = storage.loadAgent(agentId);
      if (fa && userMemory.absorbLegacyFacts(fa)) {
        storage.saveAgent(fa);
        agent.userMemory = fa.userMemory; agent.refMemory = fa.refMemory; agent.humanFacts = [];
      }
    } catch (e) { console.warn('[engine] 옛 기억 흡수 실패(무시):', e.message); }
  }
  const memory = { user: agent.userMemory || '', ref: agent.refMemory || '' };

  // send_file 로 전달된 파일을 agent 메시지에 카드로 영속시키기 위해 tally 한다(모든 채널 공통).
  // → 앱 재실행 후에도 파일 카드가 대화에 남는다. 채널이 준 deliverFile 을 감싸 경량 카드(썸네일 제외)만 기록.
  const _sentCards = [];
  const _deliverFile = (typeof deliverFile === 'function') ? async (f) => {
    const res = await deliverFile(f);
    try {
      const st = fs.statSync(f.path);
      _sentCards.push({ path: f.path, name: f.name, size: st.size, note: f.note || '', isImage: /\.(png|jpe?g|gif|webp)$/i.test(f.name || '') });
    } catch (_) { _sentCards.push({ path: f.path, name: f.name, note: f.note || '' }); }
    return res;
  } : deliverFile;

  const generate = pickGenerate(agent);
  if (!generate) return { error: `더 이상 지원하지 않거나 설정되지 않은 AI 입니다: ${agent.brainMode}. 설정에서 다른 두뇌를 골라주세요.` };

  // ── 기억 주입 — 골라내지 않는다 (통짜 그릇) ──────────────────────────
  //   관련성 점수로 기억을 골라 넣을 수도 있다(임베딩 의미검색 → 키워드 폴백 + 인출 강화 + 연상).
  //   그릇이 "이 사람의 존재"만 담고 글자 상한을 갖게 되면서 **통째로 넣어도 싸다** →
  //   골라내기·강화·연상이 전부 필요 없어져 삭제했다(근거 없던 임계값 여러 개도 함께 사라짐).
  //   일화·원문은 예전처럼 자동 주입하지 않는다 — 최근 원문은 창에 이미 들어가고,
  //   창 밖은 요약이 흐름을 주며 정확한 건 search_memory 로 꺼낸다.
  emit('recall', { chars: memory.user.length, refChars: memory.ref.length, mode: 'whole' });

  // ── 시스템 프롬프트 (1층 + 성격 + 회상된 기억). 도구·스킬 없음(v1) ──
  // userSpeech = 사용자가 **말로 정한** 말투('formal'|'casual'). 없으면 미러링(옛 동작).
  //   ※ speech(옛 필드)는 2026-07-13 에 'auto' 로 무력화됐다. 그건 설정 화면용이었고 이건 대화로 정한 것이다.
  const layer2 = {
    speech: agent.speech || 'auto',
    userSpeech: agent.userSpeech || '',
    userNickname: agent.userNickname || '',
    auxoMd: agent.auxoMd || '',
  };
  // 도구 모드: 1층에 쓸 수 있는 도구를 알린다(없으면 두뇌가 "도구 없음"으로 판단해 호출 안 함).
  // 모든 LLM 두뇌 도구 지원: claude·codex=MCP 주입, gemini·openai=function-calling.
  // 위임 경로: REST 두뇌=function-calling(extraDecls + 누적 가드레일) / 구독 두뇌=MCP 서버(auxo-mcp-tools).
  const restDelegate = REST_BRAINS.has(agent.brainMode);
  const restTools = TOOLS_BRAINS.has(agent.brainMode); // REST 두뇌 = 풀 도구셋(스킬·MCP·작업기억·L3)
  const subDelegate = agent.brainMode === 'claude-subscription' || agent.brainMode === 'codex-subscription';
  const canDelegate = restDelegate || subDelegate; // 1층 안내는 둘 다
  // 이어가기(v2): 한 턴 누적 워커 한도. REST 경로에서만(구독은 MCP가 stateless라 호출당 5명 cap).
  const autonomous = restDelegate && subagents.detectAutonomous(userMessage);
  const workerCap = autonomous ? subagents.CAP_AUTO : subagents.CAP_APPROVAL;
  let workerUsed = 0;     // 이번 턴 누적 워커 수(REST 경로)
  let emptyRounds = 0;    // 결과 없는 라운드 연속 수(진전 없음 차단)

  // 스킬·MCP 카탈로그 준비(앱·CLI·봇 동일). 스킬 목록은 값싼 파일읽기라 구독 두뇌도 준비(능력 인식) —
  // MCP collectTools는 서버 연결(스폰)이라 REST만(구독은 claudeGenerate가 MCP를 따로 주입하고 claude CLI가 네이티브로 노출 → 이중 스폰 방지).
  let skillCatalog = [], mcpDecls = [], mcpRoutes = new Map(), offSkills = new Set();
  if (restTools || subDelegate) {
    const dataDir = path.dirname(storage.getDataPath());
    skillsRegistry.setSkillsRoot(path.join(dataDir, 'skills'));
    offSkills = new Set(agent.disabledSkills || []);
    skillCatalog = skillsRegistry.list(agentId).filter(s => !offSkills.has(s.id));
    if (restTools) {
      mcpManager.setConfigRoot(path.join(dataDir, 'mcp'));
      const offMcp = new Set(agent.disabledMcp || []);
      try { const m = await mcpManager.collectTools(agentId, { generate }); mcpRoutes = m.routes; mcpDecls = m.decls.filter(d => { const r = m.routes.get(d.name); return !r || !offMcp.has(r.id); }); } catch (_) {}
    }
  }

  // ── 위험 MCP 도구: 직전 턴 '승인 대기'를 이번 사용자 답으로 소비(앱 main.js와 동일 동작). ──
  //    이게 없으면 "승인"해도 실행이 안 되고 두뇌가 도구를 재호출 → 무한 승인 루프가 났다.
  let approvalNote = '';
  if (restTools && _enginePendingMcp.has(agentId)) {
    const p = _enginePendingMcp.get(agentId);
    _enginePendingMcp.delete(agentId); // one-shot
    const verdict = await judgeApproval(generate, userMessage, `'${p.server}'의 '${p.tool}' 실행`);
    const isCancel = verdict === 'REJECT';
    const isAutoIntent = verdict === 'AUTO';
    const isApprove = verdict === 'APPROVE';
    if (isCancel && !isAutoIntent) {
      approvalNote = `[시스템 알림: 사용자가 '${p.server}'의 '${p.tool}' 실행을 취소했어. 실행하지 않았어. 다시 시도하지 말고 다른 걸 도와줘.]`;
    } else if (isAutoIntent || isApprove) {
      let flipped = false;
      if (isAutoIntent) { // 자율도 전환(결정론적 — 모델이 set_trust를 안 불러도 됨)
        try { const fr = storage.loadAgent(agentId); if (fr) { fr.trustLevel = 'autonomous'; storage.saveAgent(fr); if (agent) agent.trustLevel = 'autonomous'; flipped = true; } } catch (_) {}
      }
      if (isAutoIntent) { try { mcpManager.setAutoApprove(agentId, p.serverId, true); } catch (_) {} }
      try {
        const r = await mcpManager.callTool(p.fn, p.args, mcpRoutes);
        approvalNote = (r && !r.error)
          ? `[시스템 알림: 승인됨 → '${p.server}'의 '${p.tool}' 실행 완료.${flipped ? ' 그리고 앞으로 이런 변경 작업은 묻지 않고 바로 진행하도록 바꿨어.' : ''} 결과: ${String(r.result).slice(0, 800)} — 이 결과로 사용자에게 자연스럽게 답해. 같은 도구를 다시 호출하지 마(이미 끝났어).]`
          : `[시스템 알림: '${p.tool}' 실행 실패: ${(r && r.error) || '알 수 없음'}. 사용자에게 솔직히 알리고 대안을 제안해.]`;
      } catch (e) { approvalNote = `[시스템 알림: '${p.tool}' 실행 오류: ${e.message}]`; }
    } else {
      approvalNote = `[시스템 알림: '${p.tool}' 실행 승인 대기였는데 명확한 승인/거절이 아니야. 사용자에게 한 번 더 간단히 확인해.]`;
    }
  }

  // ── 파일/셸 접근 허용: 직전 턴 '허용 대기'를 이번 사용자 답으로 소비(모든 두뇌·채널 공통). ──
  //    허용 결정권은 모델이 아니라 사용자에게 있다(grant_dir/grant_shell 도구 제거). 엔진이 사용자 답으로만 허용.
  //    ★상태를 다루는 것은 **grants 가 한다.** 여기는 사용자 말을 판정해 넘기고, 결과를 두뇌에게 전할 뿐이다.
  //      전엔 허락을 **거는 곳이 7군데**(agent-tools 3 · auxo-mcp 3 · 여기 1)였고 소비는 여기뿐이라,
  //      규칙이 어디 있는지 알 수 없었고 실제로 안내 문구까지 갈라져 있었다 — 채널마다 다른 말이 나갔다.
  const _대기 = grants.pending(agentId);
  if (_대기) {
    const gVerdict = await judgeApproval(generate, userMessage, _대기.kind === 'shell' ? '터미널 명령 실행' : `'${_대기.dir}' 폴더 접근`);
    const g = grants.consume(agentId, gVerdict);
    const _이름 = g.dir || '터미널 실행';
    if (g.결과 === 'reject') approvalNote += `\n[시스템 알림: 사용자가 '${_이름}' 접근을 거절했어. 그 작업은 하지 말고 다른 걸 도와줘.]`;
    else if (g.결과 === 'approve') approvalNote += g.kind === 'shell'
      ? `\n[시스템 알림: 사용자가 터미널 명령 실행을 허용했어. 하려던 작업을 이어서 진행해.]`
      : `\n[시스템 알림: 사용자가 '${g.dir}' 폴더 접근을 허용했어. 하려던 파일 작업을 이어서 진행해.]`;
    else approvalNote += `\n[시스템 알림: '${_이름}' 허용 대기 중인데 명확한 승인/거절이 아니야. 사용자에게 간단히 다시 확인해.]`;
    const fr = g.agent || storage.loadAgent(agentId) || agent;
    agent.allowedDirs = fr.allowedDirs; agent.allowShell = fr.allowShell; agent.trustLevel = fr.trustLevel; agent.pendingGrant = fr.pendingGrant;
  }

  // ★여기 `remember, forget` 을 이름만 넣으면 **구독 두뇌에서 도구가 죽는다.**
  //   1층 문장이 이렇게 만들어진다 —
  //     "지금 너가 쓸 수 있는 도구: remember, forget, 쓸 수 있는 도구: cancel_schedule(...), ..."
  //   ① 라벨이 두 번 겹쳐 문장이 깨지고 ② remember 는 **설명 없는 이름**으로만 남고
  //   ③ ALWAYS 의 search_memory·web_search·set_nickname 은 **아예 안 보인다.**
  //   codex 실측: *"remember 도구는 내 도구 목록에 없어서"* 라며 도구를 0/8 로 안 불렀다.
  //   (claude 는 관대해서 넘어갔다 — 그래서 두 달간 안 드러났다)
  const availableTools = [];
  // REST 두뇌(gemini/openai/anthropic)는 커넥터가 localTools(시간·계산·URL)+웹검색을 자동 포함 → 1층에도 안내.
  if (restDelegate) availableTools.push('web', 'fetch_url', 'get_current_time', 'calculator');
  // 능력 안내: REST 두뇌 + 구독 두뇌(claude/codex) 공통. 구독도 auxo-mcp-tools로 아래 도구를 실제로 다 받는다(실행 대칭).
  if (restTools || subDelegate) {
    // ★산문 나열이 아니라 **실제 도구 이름 목록**을 준다. 두 가지를 동시에 푼다.
    //   ① 중복 — 여기서 이름을 나열하고 아래 선언에서 또 설명하던 것(같은 걸 두 번 말함)
    //   ② 지연 로딩 — 두뇌가 꺼낼 이름을 정확히 알아야 load_tools 를 부를 수 있다
    //   REST 두뇌만 load_tools 를 갖는다(구독은 CLI 가 이미 지연 로드).
    {
      const _all = toolDecls.DECLS.map(d => d.name).concat(mcpDecls.map(d => d.name));
      const _sp = toolDecls.splitForDeferred(_all);
      const _idx = toolDecls.deferredIndex(_sp.deferred, mcpDecls);
      if (restTools && _idx) {
        // REST 두뇌: 지연 로딩이 있으니 **이미 실린 것**과 **꺼내 쓸 것**을 나눠 보여준다.
        //   ★회귀 주의: `availableTools` 초기값을 비우면 REST 쪽에서 ALWAYS 5개가
        //     **1층에서 통째로 사라진다.** 함수 선언으로 전달되니 호출 자체는 되지만,
        //     **1층 안내가 부실하면 두뇌가 "그런 도구 없다"고 판단한다.**
        const _always = toolDecls.deferredIndex(_sp.always, mcpDecls);
        if (_always) availableTools.push(`지금 바로 쓸 수 있는 도구: ${_always}`);
        availableTools.push(`[지금 꺼내 쓸 수 있는 도구] ${_idx}`);
        availableTools.push('★위 도구는 아직 안 실려 있어. 쓰려면 load_tools({names:["이름"]}) 로 먼저 꺼내. '
          + '꺼내면 이번 턴에 바로 쓸 수 있어. 꺼내지 않고 "했다"고 말하면 안 돼 — 못 하면 못 한다고 말해.');
      } else if (subDelegate) {
        // 구독 두뇌(claude·codex): 지연 로딩이 없다 — **전부 한 번에, 설명과 함께** 보여준다.
        //   ALWAYS 를 빼면 안 된다. 그 5개가 remember·search_memory 처럼 **가장 많이 쓰는 것**이라,
        //   빠지면 두뇌가 "그런 도구는 없다"고 판단해 말로 때운다(실측).
        const _full = toolDecls.deferredIndex(_all, mcpDecls);
        if (_full) availableTools.push(_full);
      }
    }
    if (restTools) availableTools.push('복잡한 작업 단계분해 실행(plan_task/resume_task)'); // L3 플래너는 REST 두뇌 전용(구독 MCP엔 없음)
    if (mcpDecls.length) availableTools.push(`연결된 MCP 도구: ${mcpDecls.map(d => d.name).join(', ')}`);
  }
  if (canDelegate) availableTools.push('delegate_to_workers');
  // toolsAreLive: 구독 두뇌(claude·codex)는 MCP 로 도구가 **이미 붙어 있다**. 그 사실을 말해줘야
  //   두뇌가 목록을 '설명'이 아니라 '지금 부를 수 있는 것'으로 읽는다(brain-claude.buildSystemPrompt 주석의 실측).
  let systemPrompt = brainClaude.buildSystemPrompt(agent.name, agent.persona, memory, layer2, availableTools, skillCatalog,
    // toolsOutsideSandbox: 구독 두뇌는 CLI 자체 자물쇠(codex -s workspace-write / claude --disallowedTools) 안에서 돈다.
    //   그 자물쇠는 **자기 손**에만 걸리고 우리 MCP 도구와는 무관한데, 두뇌가 둘을 섞어 '차단됐다'며 아예 안 부른다(실측 0/8).
    { toolsAreLive: subDelegate, toolsOutsideSandbox: subDelegate });
  const nowKST = localTools.getCurrentTime().korea_time;
  systemPrompt += `\n\n[현재 시각 (사실 — 반드시 이것만 기준)]\n지금은 한국 시간으로 ${nowKST}야. "오늘/지금/현재/올해" 같은 시점은 절대 추측하지 말고 반드시 이 값을 기준으로 답해.`;
  // ★지금 걸린 알림을 **사실로** 싣는다 — 현재 시각과 같은 이유다.
  //   없으면 두뇌가 **옛 대화에 나온 일정 이야기를 "지금 걸린 알림"으로 답한다.**
  //   실측(2026-08-15, GPT): "알림 뭐 있어?"에 조회 도구를 안 부르고 월세·정산·어머니 생신 등
  //   **없는 알림 6건**을 목록으로 내놨다(실제 1건). 사용자는 그걸 믿고 그날을 놓친다.
  //   기억(그릇)에는 "월세 알림 맡길 만큼 신뢰가 쌓임" 같은 서술이 남아 있어 지어낼 재료가 늘 있다.
  //   → 답할 재료를 미리 줘놓고 도구를 부르길 기대하지 말고, **맞는 값을 준다.**
  {
    const _sch = (agent.schedules || []).filter(s => s && s.enabled !== false);
    systemPrompt += `\n\n[지금 걸린 알림·예약 (사실 — 반드시 이것만 기준)]\n`;
    if (!_sch.length) {
      systemPrompt += '지금 걸려 있는 알림·예약은 **하나도 없어.** 예전 대화에 나온 일정 이야기를 "걸려 있다"고 말하면 안 돼.';
    } else {
      systemPrompt += _sch.map(s => `· ${s.title || '(제목 없음)'} — ${scheduler.describe(s)}`).join('\n')
        + `\n위가 전부야. 여기 없는 건 **걸려 있지 않다.** 예전 대화에 나왔더라도 지금은 없는 것이다.`;
    }
  }
  // ★지금 **접근이 허용된 폴더**를 사실로 싣는다 — [현재 시각]·[지금 걸린 알림] 과 같은 자리다.
  //   전엔 이걸 **한 번도 안 알려줬다.** 허용 직후 한 턴만 approvalNote 로 알리고(451줄) 그 뒤엔 깜깜하다.
  //   그래서 두뇌가 **추측한다** — 실측(2026-08-21 재현): Desktop 이 이미 허용돼 있는데도
   //   *"실행 자체가 정책에서 막혔어요"* 라며 list_files 를 안 불렀다(되돌림 2회를 다 쓰고도).
  //   codex 는 자기 샌드박스가 좁아서 그 감각으로 우리 허용 범위까지 좁게 짐작한다.
  //   → 짐작할 자리를 없앤다. **맞는 값을 준다.**
  {
    const _dirs = Array.isArray(agent.allowedDirs) ? agent.allowedDirs.filter(Boolean) : [];
    if (_dirs.length) {
      systemPrompt += `

[지금 접근이 허용된 폴더 (사실 — 반드시 이것만 기준)]
`
        + _dirs.map((d) => `· ${d}`).join('\n')
        + `
이 폴더들(과 그 아래)에서는 파일·폴더 작업이 **실제로 된다.** "권한이 없다"고 짐작하지 말고 그냥 해.`
        + `
여기 없는 곳은 도구를 부르면 사용자에게 허용 요청이 뜬다 — 부르지 않으면 요청조차 안 생긴다.`;
    } else {
      systemPrompt += `

[지금 접근이 허용된 폴더 (사실)]
아직 **하나도 없다.** 파일·폴더 작업을 부탁받으면`
        + ` 도구를 불러라 — 그래야 사용자에게 허용 요청이 뜬다. 미리 "권한이 없어 못 한다"고 답하지 마.`;
    }
    // ★셸도 같다 — 폴더와 똑같이 **한 번도 안 알려주고 있었다.**
    //   실측(2026-08-21): allowShell 이 꺼진 상태에서 *"node 버전 좀 확인해줘"* 에
    //   run_shell 을 **안 부르고** "실행 정책에 막혔어" + PowerShell 안내로 빠졌다(되돌림 2회를 다 쓰고도).
    //   폴더 사고와 **같은 모양**이다: 짐작 → 미호출 → 허용 요청이 안 생김.
    systemPrompt += agent.allowShell
      ? `\n[터미널 명령 실행 (사실)]\n사용자가 **이미 허용했다.** run_shell·run_code 를 그냥 써. "권한이 없다"고 짐작하지 마.`
      : `\n[터미널 명령 실행 (사실)]\n아직 허용 안 됐다. 그래도 **필요하면 도구를 불러라** — 그래야 사용자에게 허용 요청이 뜬다. 미리 "막혔다"고 답하지 마.\n★**네 자체 셸(bash/PowerShell)이 막힌 것과 run_shell 은 별개다.** run_shell 은 네 프로세스 밖에서 돈다.`;
  }
  const _osName = process.platform === 'win32' ? 'Windows (명령프롬프트/PowerShell — dir·type·copy 등)' : process.platform === 'darwin' ? 'macOS (zsh/bash — ls·cat·cp 등)' : 'Linux (bash — ls·cat·cp 등)';
  // 설치된 런타임 = 환경 '사실' → 모든 두뇌 공통으로 알려준다(구독 두뇌도 자기 환경을 알게). availableLangs는 1회 캐시라 매 턴 비용 없음.
  // ※ 과거엔 이 사실이 run_code 도구 안내에 붙어 restTools(REST 두뇌) 뒤에만 있어, claude/codex 구독은 "뭐가 설치됐는지"를 프롬프트로 몰랐다 → 매번 직접 확인·망각. 사실은 모두에게, 도구 주의만 도구 두뇌에.
  let _envLangs = '';    // 설치 사실(모든 두뇌)
  let _langCaveat = '';  // run_code 사용 주의(도구 두뇌만)
  try {
    const a = require('./proc-tools').availableLangs();
    _envLangs = ' 이 PC에 설치된 런타임: ' + Object.entries(a).map(([k, v]) => `${k}${v ? '✓' : '✗(없음)'}`).join(', ') + '.';
    if (restTools) _langCaveat = ' run_code는 ✓ 표시된 런타임만 써(없는 건 고르지 마).';
  } catch (_) {}
  systemPrompt += `\n\n[이 컴퓨터] OS: ${_osName}.${_envLangs} run_shell/run_code는 이 OS에 맞는 명령을 써.${_langCaveat}`;
  if (approvalNote) systemPrompt += `\n\n${approvalNote}`; // 직전 턴 승인 대기 처리 결과를 두뇌에 전달
  // 정직 계층 ④: 직전 답변의 검색 출처를 on-demand 로 노출(상시 표시 안 함, 물으면 정직히).
  if (agent.lastEvidence && Array.isArray(agent.lastEvidence.items) && agent.lastEvidence.items.length) {
    const srcLines = [];
    for (const it of agent.lastEvidence.items) {
      for (const s of (it.sources || [])) srcLines.push(`- ${s.title}${s.uri ? ` (${s.uri})` : ''}`);
    }
    if (srcLines.length) {
      systemPrompt += `\n\n[직전 답변의 근거 출처 — 사용자가 "어디서 봤어/출처/그거 정말이야?"처럼 물으면 이걸 정직하게 알려줘.`
        + ` 안 물으면 굳이 먼저 꺼내지 마. 여기 없는 출처를 지어내지 마]\n${srcLines.slice(0, 8).join('\n')}`;
    }
  }

  // ── 유저 프롬프트 (요약 + 최근 대화 + 현재 메시지) ─────────────────
  const summary = storage.loadConversationSummary(agentId);
  // 프롬프트 조립 = brainClaude.budgetPrompt — Hermes 방식(처음 교환 + 중간 요약 + 최근 20,000 토큰 원문).
  // ★예산으로 미리 자르지 않는다. 추측표(모르는 두뇌는 8,000 가정) 기준으로 자르면,
  //   ① 토큰 비용은 사용자 것이라 우리가 아끼려 자를 이유가 없고 ② 우리는 사용자 모델 한도를 모른다(표는 항상 낡음).
  //   자를지는 우리가 추측하지 않고, 실제 신호(컨텍스트 초과 에러)에 반응한다.
  // 활성 프로젝트/루틴의 contextDigest(작업 맥락)를 프롬프트에 주입.
  const activeWork = agent.work && agent.work.activeId
    ? (agent.work.projects || []).find(p => p.id === agent.work.activeId) ||
      (agent.work.routines || []).find(r => r.id === agent.work.activeId)
    : null;
  const l2CtxDigest = (activeWork && activeWork.contextDigest) || '';

  // 유튜브 링크 자동 감지 → 자막/전사를 두뇌 입력에 주입(사용자는 링크만 보내면 됨). 전 채널 공통.
  // 두뇌엔 내용을 주되, 저장/화면(displayUserMessage)은 원문(링크)만 남긴다(거대한 전사는 저장 안 함).
  if (youtube.hasYoutube(userMessage)) {
    if (displayUserMessage == null) displayUserMessage = userMessage;
    emit('thinking', {});
    try {
      const yt = await youtube.fetchTranscript(userMessage, { onStatus: (m) => emit('status', { text: m }) });
      userMessage += `\n\n[사용자가 보낸 유튜브 영상 "${yt.title}"의 내용(${yt.source}). 아래가 그 내용이야]\n${yt.text}`;
    } catch (e) {
      userMessage += `\n\n[유튜브 영상 내용을 가져오지 못했어(${e.message}). 이 사실을 사용자에게 정직하게 알려.]`;
    }
  }

  const userPrompt = brainClaude.budgetPrompt(summary, messages, userMessage, {
    contextDigest: l2CtxDigest,
    // 아카이브가 커서 중간을 안 읽었으면(창 읽기) 그 사실을 알린다 → 요약이 그 자리를 대신하게.
    middleTruncated: !!_arch.truncated,
    nowMs: Date.now(), // 대화 이력에 '어제/오늘' 시간 표지를 심어 시점 인지(친구 컨셉). ts는 이미 저장돼 있음.
  });

  // ── 도구 (v2a: remember/forget — 두뇌가 대화 중 기억을 직접 관리) ──
  // 스킬·MCP·작업기억(L1) 도구는 v2b 예정(chat:send 도구로직 공유 추출 후). 여기선 기억 도구만.
  let rememberedAny = false;
  let _toolCalls = 0; // P3.2 자가학습 트리거(작업 도구 호출 수)
  const usedInfoTools = new Set(); // 안전장치 3: 이번 턴에 실제로 쓴 정보 도구(투명 표시용)
  // 지연 로딩 홀더 — buildDecls 뒤에 채워지고 load_tools 가 여기서 꺼낸다(참조로 넘겨야 해서 객체).
  const _lazy = { pool: [], names: [] };
  const _turnStartTs = Date.now(); // [[claim-check]] 턴 경계 — 이 시각 이후 도구 호출만 이번 턴 것
  const evidenceSink = []; // 정직 계층 ④/②: 이번 턴 웹검색 근거(결과+출처) 수집(REST 두뇌가 채움)
  // ★remember/forget 선언은 사본을 두지 않는다. 원본은 tool-decls.js 한 곳.
  //   사본을 두면 memory-tools.DECLS(구독 두뇌용)와 어긋나, API 키 두뇌만
  //   그릇의 "끝점" 기준도 forget 확인 절차도 못 보게 된다.
  const extraDecls = toolDecls.pick(['remember', 'forget']).map(d => ({ ...d }));
  // 서브에이전트 위임 도구 선언 — REST 두뇌만 function-calling 으로(구독은 MCP 서버가 제공).
  if (restDelegate) extraDecls.push(...toolDecls.pick(['delegate_to_workers']).map(d => ({ ...d })));
  // REST 두뇌: 스킬·MCP·작업기억·L3 도구 추가(remember/forget는 아래 인라인이 처리하므로 제외, delegate는 위에서 처리).
  if (restTools) {
    // 하이브리드(설계): 네이티브 검색이 있는 두뇌(Gemini·Claude)는 자체 검색이 더 정확하므로
    // 공통 web_search(DuckDuckGo)를 주지 않는다 — 약한 쪽을 고르는 걸 막는다. 네이티브 없는 두뇌(GPT 등)만 공통검색.
    const nativeWeb = ['gemini-api', 'claude-api', 'claude-subscription'].includes(agent.brainMode);
    const _built = agentTools.buildDecls({ skillCatalog, mcpDecls });
    _lazy.pool = _built._deferredPool || [];   // load_tools 가 여기서 꺼낸다
    _lazy.names = _built.deferredNames || [];  // 1층엔 이름만 알린다
    for (const d of _built) {
      if (d.name === 'remember' || d.name === 'forget') continue;
      if (nativeWeb && d.name === 'web_search') continue;
      extraDecls.push(d);
    }
  }
  // REST 두뇌의 스킬·MCP·작업기억·L3 실행기(remember/forget/delegate 는 아래 인라인이 먼저 처리).
  const _toolsExec = restTools ? agentTools.makeExecute({
    agentId, agent, generate, storage, brainClaude, skillsRegistry, mcpManager,
    mcpRoutes, offSkills, pendingMcp: _enginePendingMcp,
    emit: (ch, p) => emit(ch, p),
    onRemembered: () => { rememberedAny = true; },
    deliverFile: _deliverFile, // send_file 도구 → 채널별 파일 전달(CLI·텔레그램이 주입) + 카드 tally
    extraDecls,
    lazy: _lazy,
  }) : null;
  const _runTool = async (n, args) => {
    if (learnSkill.isWorkTool(n)) _toolCalls++; // 자가학습: 작업 도구만 카운트
    if (toolTransparency.isTracked(n)) usedInfoTools.add(n); // 안전장치 3: 정보 도구 사용 기록
    // remember·forget 은 memory-tools 한 벌만 쓴다.
    //   여러 벌로 나뉘면 미묘하게 달라지고(예: 오래된 agent 스냅샷에서 scope 를 읽는 판)
    //   한 곳을 고치면 나머지를 빠뜨리게 된다. 채널별 부가 동작(emit·플래그)만 여기서 한다.
    if (n === 'remember') {
      const r = memoryTools.rememberFact(agentId, args || {});
      if (r.saved) { rememberedAny = true; emit('facts', { userMemory: r.userMemory }); }
      const { userMemory: _um, ...out } = r;   // 기억 전문을 두뇌에 돌려주지 않는다(토큰)
      return out;
    }
    if (n === 'forget') {
      const r = memoryTools.forgetFact(agentId, args || {});
      if (r.forgotten) { rememberedAny = true; emit('facts', { userMemory: r.userMemory }); }
      const { userMemory: _um, ...out } = r;
      return out;
    }
    if (n === 'delegate_to_workers') {
      const clean = (Array.isArray(args.tasks) ? args.tasks : [])
        .map(t => String(t || '').trim()).filter(Boolean).slice(0, subagents.MAX_WORKERS);
      if (!clean.length) return { error: '맡길 작업(tasks 배열)이 필요해' };

      // 진전 없음 차단: 결과 없는 라운드가 연속되면 중단(무한 위임 방지).
      if (emptyRounds >= subagents.NO_PROGRESS_ROUNDS) {
        return { stopped: true, message: '일꾼들이 연달아 결과를 내지 못했어. 더 위임하지 말고, 지금까지 상황을 사용자에게 솔직히 알려.' };
      }
      // 누적 한도(이어가기): planRound 로 이번에 돌릴 수 있는 인원 계산.
      const plan = subagents.planRound(workerUsed, workerCap, clean.length);
      if (plan.limitReached) {
        return {
          limitReached: true, used: workerUsed, cap: workerCap, mode: autonomous ? 'auto' : 'approval',
          message: autonomous
            ? `자동 진행 한도(${workerCap}명)에 도달했어. 더 위임하지 말고, 여기까지 한 결과를 종합해 사용자에게 보고하고 더 필요한지 물어봐.`
            : `이번 작업에 일꾼 ${workerCap}명을 다 썼어. 지금까지 결과로 사용자에게 답하고, 더 진행하려면 "계속 진행할까요?"라고 물어 승인을 받아. 승인 없이 더 위임하지 마.`,
        };
      }

      const allowed = clean.slice(0, plan.allowed); // 한도 내에서만
      const results = await subagents.runWorkers(generate, allowed, { emit, timeout: subagents.WORKER_TIMEOUT_MS });
      workerUsed += allowed.length;
      const okCount = results.filter(r => r.ok && r.result).length;
      if (okCount === 0) emptyRounds += 1; else emptyRounds = 0;

      const out = {
        workers: results.map(r => ({ n: r.n, task: r.task, ok: r.ok, result: r.ok ? r.result : `실패: ${r.error}` })),
        used: workerUsed, cap: workerCap, mode: autonomous ? 'auto' : 'approval',
        note: '각 일꾼의 결과를 종합해서 사용자에게 자연스럽게 답해. 일꾼/위임이라는 내부 용어는 굳이 노출하지 마.',
      };
      if (plan.truncated > 0) {
        out.truncated = plan.truncated;
        out.note += ` 요청한 ${clean.length}개 중 한도 때문에 ${allowed.length}개만 처리했어. ${autonomous ? '' : '나머지는 사용자 승인 후 이어서 해.'}`;
      }
      return out;
    }
    // REST 풀도구(스킬·MCP·작업기억·L3) — 위 인라인(remember/forget/delegate)에 없는 도구는 여기서 처리.
    if (_toolsExec) {
      const r = await _toolsExec(n, args);
      if (r !== null) {
        // 정직 계층 ④/②: 공통 web_search 결과(원본 스니펫)를 근거로 수집(OpenAI 등 네이티브 검색 없는 두뇌).
        if (n === 'web_search' && r && Array.isArray(r.results) && r.results.length) {
          evidenceSink.push({
            query: r.query || args.query || '',
            text: r.results.map(x => `${x.title || ''}: ${x.snippet || ''}`).join('\n').slice(0, 4000),
            sources: r.results.slice(0, 5).map(x => ({ title: x.title || '(제목없음)', uri: x.url || '' })),
          });
        }
        return r;
      }
    }
    return null;
  };

  // ★도구 호출 장부 — **실행한 뒤** 결과를 보고 남긴다(claim-check 가 이걸로 '했다' 주장과 대조한다).
  //   실행 전에 남기면 결과를 모르는 채 전부 "성공"으로 기록된다. 그러면
  //   *"알림 걸어놨어요"* 라고 해놓고 실제로는 인자가 틀려 실패한 턴이 검사를 통과한다(실측).
  //   ※ 실패 판정 = 도구가 `{error}` 를 돌려주거나 예외를 던진 경우.
  //     `{saved:false, message:"이미 알고 있는 내용이야"}` 같은 건 **정상 동작**이라 실패가 아니다.
  const extraExecute = async (n, args) => {
    let ok = true;
    try {
      const out = await _runTool(n, args);
      ok = !(out && typeof out === 'object' && out.error);
      return out;
    } catch (e) {
      ok = false;
      throw e;
    } finally {
      try { storage.recordToolCall(agentId, n, ok); } catch (_) {}
    }
  };

  // claude 구독은 MCP 서버로 기억을 '직접' 저장(extraExecute 를 안 거침) → 아래 변경 감지로 rememberedAny 보정.
  const _factSnap = () => String((storage.loadAgent(agentId) || {}).userMemory || '');
  const _beforeSnap = _factSnap();

  // ── 사용자 메시지를 "지금 바로" 남긴다 (두뇌 호출 전) ─────────────────────
  // 두뇌 호출은 수십 초 걸린다. 그 사이 사용자가 말을 이어 붙이면(메신저에서 특히 잦다)
  // 뒤 메시지가 이 메시지를 못 본 채 답하거나, 나중에 끝난 턴이 대화를 덮어써 사라진다.
  storage.appendMessages(agentId, [{
    role: 'user',
    content: (typeof displayUserMessage === 'string' && displayUserMessage.length) ? displayUserMessage : userMessage,
    ts: Date.now(),
    files: (Array.isArray(userFiles) && userFiles.length) ? userFiles : undefined,
  }]);

  // ── 정직 계층 ⑤ 준비: **요청 판정을 지금 미리 띄운다** ──────────────────
  //   이 판정은 *"사용자가 부탁한 게 도구를 요하나"* 만 본다 — **답변을 안 본다.**
  //   그러니 답을 기다릴 이유가 없다. 주 호출과 **나란히** 돌리면 체감 지연이 0 이 된다.
  //   ★안 그러면 잡담 턴마다 답이 다 나온 뒤 **+4.6초**가 붙는다(2026-08-21 실측, codex).
  //     동반자 제품에서 잡담이 가장 흔한 턴이라 그 지연은 그대로 제품 품질이다.
  //   대가 = 도구를 쓴 턴에서도 판정이 돌아 헛돈다(실사용 표본 13턴 중 4턴).
  //     토큰으로는 턴당 +170 정도 — **4.6초와 바꿀 값으로 싸다**고 봤다.
  //   ※ 직전 발언은 **지금** 읽어야 한다. 이 턴 답변은 아직 저장 전(943줄)이라 안전하다.
  let _prevAssistant = '';
  try {
    const _conv = storage.loadConversation(agentId) || [];
    for (let k = _conv.length - 1; k >= 0; k--) {
      if (_conv[k] && _conv[k].role !== 'user' && _conv[k].content) { _prevAssistant = String(_conv[k].content); break; }
    }
  } catch (_) {}
  //   실패해도 대화를 막지 않는다 — null 이면 check 가 알아서 스스로 판정한다.
  const _needToolP = userMessage
    ? claimCheck.needsTool(userMessage, _prevAssistant, generate).catch(() => null)
    : Promise.resolve(null);

  emit('thinking', {});
  // 구독 두뇌 비전: 첨부는 inline_data(API 두뇌)가 아니라 디스크의 파일 경로를 CLI가 직접 열어서 본다.
  // → 구독 2종(claude=native Read / codex=read-only 파일읽기)에 경로 전달.
  //   각 brain-*가 opts.imageFiles로 파일을 열어보도록 안내(+claude는 Read 허용). API 두뇌는 attachments=inline_data 경로 그대로.
  // ⚠️ 이미지뿐 아니라 **PDF도 포함**(claude·codex 실측: 경로를 주면 정확히 읽는다).
  //    PDF를 빼면 구독두뇌 사용자는 PDF 첨부를 아예 못 본다 — file-intake는 이미지·PDF를 똑같이 base64(multimodal)로만
  //    만드는데 구독두뇌는 base64를 못 쓰기 때문. (Office·텍스트는 file-intake가 텍스트로 추출·인라인 → 두뇌 무관 정상.)
  const _subVision = ['claude-subscription', 'codex-subscription'].includes(agent.brainMode);
  const _openable = f => f && f.path && (f.isImage || /\.pdf$/i.test(f.name || f.path));
  const imageFiles = (_subVision && Array.isArray(userFiles))
    ? userFiles.filter(_openable).map(f => f.path)
    : undefined;
  // 구독 두뇌(claude·codex): 설치 MCP를 상시 HTTP 게이트웨이로 노출해 매턴 spawn 레이스(pending) 제거.
  // REST 두뇌는 mcpManager 직접 호출이라 불필요.
  let mcpHttp, auxoHttp;
  if (subDelegate) {
    const _dp = path.dirname(storage.getDataPath());
    try { mcpHttp = await mcpGateway.ensureGateways(agentId, _dp); }
    catch (e) { console.error('[engine] mcp-gateway 준비 실패:', e && e.message); }
    // 내장 auxo 도구도 상시 게이트웨이로 warm → 매턴 stdio 스폰 레이스(=거짓무능) 제거. 실패 시 brain이 stdio 폴백.
    try {
      auxoHttp = await mcpGateway.ensureAuxoGateway(agentId, {
        id: 'auxo',
        command: process.env.AUXO_MCP_NODE || 'node',
        args: [path.join(__dirname, 'auxo-mcp-tools.js')],
        env: { AUXO_DATA_PATH: _dp, AUXO_AGENT_ID: String(agentId), ...(process.env.AUXO_MCP_ELECTRON ? { ELECTRON_RUN_AS_NODE: '1' } : {}) },
      });
    } catch (e) { console.error('[engine] auxo 게이트웨이 준비 실패(→stdio 폴백):', e && e.message); }
  }
  // 실시간 스트리밍이 이미 나간 뒤엔 재시도하면 화면에 답이 두 번 그려진다 → 델타 방출 여부를 센다.
  // + 정지 시 부분 답변을 보존하려고 스트리밍된 텍스트를 누적한다(_streamed).
  let _deltaCount = 0, _streamed = '';
  const _onDelta = (typeof onDelta === 'function')
    ? (d) => { if (d) { _deltaCount++; _streamed += d; } return onDelta(d); }
    : onDelta;

  // 일시적 두뇌 실패(구독 CLI 크래시·타임아웃·스트리밍 실패)만 재시도 대상. 영구 실패(CLI 미탐·미로그인)는 재시도 무의미.
  // ★재시도 여부 = 원인 분류의 retryable 을 따른다.
  //   `err.code != null` 이면 재시도하는 식이면 **사용량 한도(429)도 곧바로 재시도**하게 된다 —
  //   한도는 시간이 지나야 풀리므로 같은 실패를 반복하며 사용자 대기시간만 2배로 버린다.
  const _isTransient = (err) => classifyBrainError(err, agent.brainMode).retryable;

  // ── 두뇌 호출 (일시적 실패 시 1회 재시도 — 전 두뇌·전 채널 공통) ─────────────
  const MAX_ATTEMPTS = 2; // 최초 1 + 재시도 1
  let response, lastErr = null;
  // 정지(정지 버튼/ESC): abort 되면 두뇌 응답을 끝까지 기다리지 않고 즉시 빠져나온다(사용자 체감=즉시 멈춤).
  //   진행 중이던 upstream 호출은 백그라운드에서 자연 종료된다(그 1회분은 낭비 — 브레인별 '진짜 취소'는 후속 과제).
  const _abortErr = () => { const e = new Error('사용자 정지'); e.aborted = true; return e; };
  const _abortRace = signal ? new Promise((_, reject) => {
    if (signal.aborted) return reject(_abortErr());
    signal.addEventListener('abort', () => reject(_abortErr()), { once: true });
  }) : null;
  if (_abortRace) _abortRace.catch(() => {}); // 미소비 시 unhandledRejection 방지
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      const _genP = generate(systemPrompt, userPrompt, {
        tools: true, webSearch: WEBSEARCH_BRAINS.has(agent.brainMode), // REST 두뇌용(함수 도구) + claude-api 네이티브 검색 스위치
        // codex 구독: 자기 셸의 자물쇠를 **사용자가 허락했을 때만** 푼다(brain-codex 에서 씀).
        allowShell: !!agent.allowShell || agent.trustLevel === 'autonomous',
        extraDecls, extraExecute, evidenceSink,  // + 검색근거 수집
        attachments: (Array.isArray(attachments) && attachments.length) ? attachments : undefined, // 파일 첨부(멀티모달) — 채널이 file-intake 로 만든 것
        imageFiles: (imageFiles && imageFiles.length) ? imageFiles : undefined, // claude 구독 비전(native Read로 이미지 파일 보기)
        mcpHttp: (mcpHttp && mcpHttp.length) ? mcpHttp : undefined, // 구독 두뇌: 설치 MCP 상시 HTTP 게이트웨이 URL 목록
        auxoHttp,  // 구독 두뇌: 내장 auxo 도구 상시 게이트웨이 URL(있으면 stdio 대신 사용, 없으면 stdio 폴백)

        onDelta: _onDelta,  // 실시간 스트리밍(지원 두뇌만). 채널이 콜백 주입(앱=chat:stream), 미지정 시 최종 일괄.
        // ★도구를 부르기 직전의 앞머리("I'll load the file tools…")를 **대화 본문 대신 상태 자리로** 보낸다.
        //   다른 앱이 "웹 검색 중…"을 보여주는 것과 같다 — 정보는 그대로 보이고, 대화 기록에는 안 남는다.
        //   유튜브 받는 중 안내가 쓰던 통로를 그대로 쓴다(emit('status') → chat:status).
        onStatus: (m) => { try { emit('status', { text: String(m).slice(0, 120) }); } catch (_) {} },
        agentId, dataPath: path.dirname(storage.getDataPath()), // claude·codex 구독용(MCP 서버 주입) — 폴더 경로
        signal,  // (후속) 두뇌가 이 신호로 진행 중 fetch/자식 프로세스를 직접 취소하도록 배선 예정.
      });
      response = await (_abortRace ? Promise.race([_genP, _abortRace]) : _genP);
      lastErr = null;
      break;
    } catch (err) {
      lastErr = err;
      // 폴백의 실제 원인을 파일에 남긴다(콘솔은 dev에서 숨겨져 진단 불가였음).
      // killed=true·signal=SIGTERM 이면 타임아웃, ENOENT 면 CLI 미탐, 그 외는 API/실행 오류. 전 채널·전 두뇌 공통.
      try {
        const logPath = path.join(path.dirname(storage.getDataPath()), 'auxo-error.log');
        fs.appendFileSync(logPath, `[${new Date().toISOString()}] AI 호출 실패 brain=${agent.brainMode} attempt=${attempt}/${MAX_ATTEMPTS} killed=${err.killed} signal=${err.signal} code=${err.code} msg=${err.message}\n`);
      } catch (_) {}
      // 정지(사용자 취소)면 재시도하지 않는다 — 멈추라는 지시다.
      if (signal && signal.aborted) break;
      // 재시도 조건: 시도 남음 + 일시적 실패 + 아직 스트리밍 출력 없음(중복 출력 방지).
      if (attempt < MAX_ATTEMPTS && _isTransient(err) && _deltaCount === 0) {
        evidenceSink.length = 0; // 부분 수집된 검색근거 폐기(재시도는 처음부터)
        emit('thinking', { retry: attempt });
        await new Promise(r => setTimeout(r, 500 * attempt));
        continue;
      }
      break;
    }
  }

  // ── 정지(사용자 취소) 처리 ─────────────────────────────────────────
  // 정지 버튼/ESC 로 abort 된 경우: 실패가 아니라 "멈춤"이다. 실패 마커를 남기지 않고,
  // 그때까지 스트리밍된 부분 답변을 정상 메시지로 보존한다(ChatGPT 등과 동일 관례).
  // 부분이 없으면(첫 토큰 전에 멈춤) 아무 답도 저장하지 않는다(사용자 메시지는 이미 저장됨).
  if (signal && signal.aborted && lastErr) {
    const partial = (_streamed || '').trim();
    if (partial) {
      try { storage.appendMessages(agentId, [{ role: 'agent', content: _streamed, ts: Date.now(), stopped: true }]); } catch (_) {}
    }
    return { response: _streamed || '', stopped: true, rememberedAny };
  }

  if (lastErr) {
    // 근본 처리: 실패해도 사용자 메시지만 답 없이 덩그러니 남지 않게 — 대화에 '답 실패' 마커를 저장한다.
    // → 채널 재로드 시에도 상황이 보이고, user 메시지가 답 없이 연속으로 쌓이는 컨텍스트 오염이 사라진다.
    // 이 마커(error:true)는 다음 턴 프롬프트 히스토리에선 제외된다(_runTurn 상단 필터).
    // ★원인을 분류해 **사실대로 + 해결책까지** 전한다.
    //   전부 "(일시적 오류) 잠시 후 다시 말 걸어주세요"로 뭉개면 — 원인을 알면서(로그엔 기록) 숨기는 것이고,
    //   한도·키만료는 일시적이 아닌데 "일시적"이라 단정하게 되며, 다시 시도해도 또 실패하는 막다른 길이 된다.
    const info = classifyBrainError(lastErr, agent.brainMode);
    const failMsg = info.text;
    try { storage.appendMessages(agentId, [{ role: 'agent', content: failMsg, ts: Date.now(), error: true }]); } catch (_) {}
    return { error: `AI 호출 실패(${info.kind}): ${lastErr.message}`, response: failMsg, errored: true, errorKind: info.kind };
  }
  // claude 구독이 MCP 도구(remember/forget)로 기억을 바꿨으면 rememberedAny 보정 → processMemory 의 중복 추출(b방식) 생략.
  if (!rememberedAny && _factSnap() !== _beforeSnap) rememberedAny = true;

  // 구독 두뇌가 send_file을 우편함에 남겼으면 실제 채널로 전송(REST 두뇌는 tool loop에서 이미 직접 전송, 우편함 비어있음).
  let outboxSent = [];
  if (typeof deliverFile === 'function') {
    try { outboxSent = await drainOutbox(agentId, _deliverFile); } catch (_) {}
  }

  // ★네이티브 웹검색을 장부에 남긴다 — 없으면 **검색해놓고 거짓말쟁이로 몰린다.**
  //   REST 두뇌는 검색을 자체 실행한다(gemini 의 `web`, claude-api 의 서버도구 `web_search`).
  //   둘 다 extraExecute 를 안 거치는데 장부 기록이 그 안에 있어서,
  //   **실제로 검색한 턴인데 장부가 텅 빈다.**
  //   그러면 아래 ⑤가 "아무것도 안 하고 했다고 말했다"로 판정한다(실측).
  //   근거(evidenceSink)가 남았다는 건 **검색이 실제로 돌았다는 뜻**이다. 그게 곧 실행 증거다.
  //   ※ 구독 두뇌(claude·codex)는 auxo-mcp-tools 가 이미 장부에 남기므로 여기 해당 없음.
  //   부수 이득: 장부가 차면 ⑤의 2차(유료) 호출을 건너뛴다 → 검색 턴 비용이 준다.
  if (evidenceSink.length) { try { storage.recordToolCall(agentId, 'web_search'); } catch (_) {} }

  // ── 정직 계층 ⑤: 말과 행동 대조 ─────────────────────────────────
  //   두 가지를 잡는다(2026-08-20 확장).
  //     · **빠뜨림** — 사용자가 부탁한 일이 도구를 요했는데 **하나도 안 불렀다**(요청 기준)
  //     · **거짓 완료** — 부탁받지도 않고 "했다"고 말했는데 안 불렀다(말 기준, 원래 방식)
  //   전엔 말 기준만 있어서 *"차단됐습니다"* 같은 **실패 주장**이 통째로 새 나갔다.
  //   근거·설계 = claim-check.js. 실패해도 대화는 그대로 나간다(검사가 답을 막지 않는다).
  const _원래답 = response;   // 되돌림이 답을 **더 나쁘게** 만들 수 있어 원본을 쥐고 있는다(아래 참조)
  let _허락묻는턴 = false;      // 되돌림이 "허락을 물어라"였던 턴 — 아래 되돌리기에서 예외로 둔다
  try {
    for (let attempt = 0; attempt < 2; attempt++) {
      const v = await claimCheck.check({
        agentId, responseText: response, userMessage, prevAssistant: _prevAssistant,
        // ★턴 시작 때 미리 띄운 판정(위). 이미 끝나 있어 기다리는 시간이 0 이다.
        //   되돌림 2회차에도 **같은 값을 그대로 쓴다** — 사용자 요청은 그 사이 바뀌지 않았다.
        //   (전엔 2회차에 null 을 넘겨 판정을 한 번 더 불렀다. 같은 답을 돈 주고 두 번 산 셈이다.)
        needResult: await _needToolP,
        turnStartTs: _turnStartTs, generate,
      });
      if (!v.suspect) break;
      const _왜 = v.reason === 'request' ? `요청은 '${v.kind}' 도구가 필요한데 호출 0` : `완료 주장 ${v.claims.length}건인데 도구 호출 0`;
      console.warn(`[claim] ${_왜} — 되돌림 ${attempt + 1}/2${v.claims.length ? ': ' + v.claims.join(" / ") : ''}`);
      // 두 번째도 실패 → **사용자에게 정직하게 알린다.** 답을 지우지는 않고 덧붙이기만 한다.
      //   ★요청 기준에도 반드시 붙여야 한다. 검색이 특히 그렇다 —
      //     실측: 날씨를 안 찾아보고 수치와 **출처 링크까지 지어냈다.** 사용자는 그걸 믿는다.
      if (attempt === 1) {
        // ★2026-08-22: **사용자 화면에는 붙이지 않는다. 장부에만 남긴다.**
        //
        //   [왜 뺐나]  codex 자기 셸을 열자(사용자가 허락한 경우) **판정이 못 믿을 것이 됐다.**
        //         codex 가 자기 손으로 한 일은 우리 tool_calls 에 안 남는다 → 멀쩡히 해놓고도
        //         "도구 호출 0" 으로 찍힌다. 그 결과 한 답변 안에서 스스로를 부정했다(실측 3/3) —
        //           *"써뒀습니다. (솔직히 덧붙이면 — 파일·폴더 쪽은 실제로 처리하지 못했습니다.)"*
        //         사용자는 됐는지 안 됐는지 알 수 없게 된다. **틀린 경고는 경고가 아니다.**
        //
        //   [무엇을 잃나]  진짜로 안 했을 때도 사용자에게 안 알린다. 그건 감수한다 —
        //         **되돌림 2회와 "우리가 대신 부르기"가 앞에 그대로 있다.** 이 문장은 셋 다
        //         실패했을 때의 마지막 안전망이었고, 지금은 그 판정 자체를 못 믿는 상황이다.
        //
        //   [대신]  판정을 **claim_checks 장부에 남긴다.** 전엔 console.warn 뿐이라
        //         배포된 앱에서는 흔적이 아예 없었다. 이제 실사용에서 헛짚은 비율을 잴 수 있다.
        //         (이 PC 밖으로 나가지 않는다 — 전송 코드 없음)
        try {
          storage.recordClaimCheck(agentId, {
            reason: v.reason, kind: v.kind, claims: v.claims,
            retried: attempt + 1, resolved: false,
            brain: agent.brainMode,
            allowShell: !!agent.allowShell || agent.trustLevel === 'autonomous',
          });
        } catch (_) {}
        break;
      }
      // 되돌림 문구에 넣을 도구 이름.
      //   ★전엔 구독 두뇌에 **빈 배열**을 줘서 "먼저 네 도구 목록을 확인해"라고만 나갔다.
      //     CLI 가 무엇을 노출하는지 우리가 정확히는 모른다는 이유였는데, 그건 지나친 조심이었다 —
      //     availableTools 는 **우리가 MCP 로 실제로 넘긴 목록**이라 이름을 대주는 편이 낫다.
      //     이름을 안 대주면 두뇌가 "그런 도구는 없다"는 출구로 빠지기 쉽다(실측: 되돌림 뒤에도 PowerShell 안내).
      const known = restTools && Array.isArray(extraDecls)
        ? extraDecls.map(d => d.name)
        : (Array.isArray(availableTools) ? availableTools : []);
      // ── 검색만은 되돌림이 안 통한다 → **우리가 대신 부른다** ──────────────
      //   실측(2026-08-21, codex): *"오늘 서울 날씨 검색해서 알려줘"* 에 `web_search` 를
      //   **한 번도 안 부르고** 기온·강수확률을 지어내고 **출처 링크까지 만들어 붙였다.**
      //   되돌림 0/4. 프롬프트도 소진 — 사실을 못박아도(A 0/3 · B 0/3 · C 0/3) 그대로였다.
      //   답을 보면 *"검색해봤어"·"조회 기준으로"* 라고 **대놓고 말한다.** 못 한다고 믿는 게 아니라
      //   **했다고 여긴다.** 그래서 "불러라"는 말이 닿지 않는다.
      //
      //   → 업계 원칙대로 **결정론적 시스템이 실제 호출을 담당**한다.
      //     이 파일이 이미 쓰는 방식이기도 하다 — [현재 시각]·[지금 걸린 알림] 과 같다:
      //     *"답할 재료를 미리 줘놓고 도구를 부르길 기대하지 말고, **맞는 값을 준다**"*(위 515줄).
      //   ⚠️ 검색이 실패해도 대화는 그대로 간다 — 그냥 평소 되돌림으로 떨어진다.
      //
      //   ★왜 **검색만** 대신 부르나 (나머지는 여전히 말로 설득한다)
      //     · 검색 = **읽기 전용.** 사용자 대신 해도 아무것도 안 바뀐다. 안전하다.
      //     · 파일·셸 = **허용이 필요하다.** 우리가 대신 부르면 사용자 승인 체계를 우리 손으로 건너뛰는 셈이다.
      //       그건 이 제품이 지켜온 선을 넘는다 — 허락은 사용자만 한다.
      //     · 예약 = 사용자가 확인하지 않은 일정이 실제로 생긴다. 되돌리기 어렵다.
      //     · 기억 조회 = 읽기 전용이라 후보이긴 하나, **실측 3/3 이라 손댈 이유가 없다.**
      let _준검색 = '';
      if (v.reason === 'request' && v.kind === 'search' && attempt === 0) {
        try {
          const _sk = (agent && agent.search) || {};
          //   ★검색어는 **판정기가 뽑아준 것**을 쓴다(추가 호출 없이 같이 받아둔다).
          //     사용자 말을 통째로 넣으면 *"그거 좀 찾아봐"* 같은 게 그대로 검색어가 돼
          //     엉뚱한 결과를 **사실이라며 주입**하게 된다. 그게 안 하느니만 못하다.
          const _q = (v.query && v.query.trim()) || String(userMessage).slice(0, 200);
          const _r = await require('./web-search').webSearch(_q, {
            max: 5, provider: _sk.provider, naver: _sk.naver, tavily: _sk.tavily,
          });
          const _items = (_r && Array.isArray(_r.results)) ? _r.results.slice(0, 5) : [];
          if (_items.length) {
            _준검색 = '\n\n[검색 결과 — 우리가 실제로 찾아온 것. **이것만 근거로 답해라.**]\n'
              + _items.map((x) => `· ${x.title}\n  ${x.snippet || ''}\n  (${x.url})`).join('\n')
              + '\n여기 없는 수치·사실은 **쓰지 마.** 출처 링크는 위 것만 쓰고 상상해서 만들지 마.\n물어본 것과 **관계없는 결과뿐이면** 억지로 답하지 말고 "지금은 못 찾았다"고 말해.';
            //   근거를 남긴다 — 정직 계층 ②·④ 가 이걸 쓰고, 장부에도 남아 다음 검사가 통과된다.
            for (const x of _items) evidenceSink.push({ text: `${x.title}\n${x.snippet || ''}`, sources: [{ title: x.title, uri: x.url }] });
            try { storage.recordToolCall(agentId, 'web_search'); } catch (_) {}
            console.warn(`[claim] 검색은 되돌림이 안 통한다 — 우리가 대신 ${_items.length}건 찾아 넣는다`);
          }
        } catch (e) { console.error('[claim] 대신 검색 실패(무시):', e.message); }
      }
      // ── 셸도 되돌림이 안 통한다 → **통로만 우리가 갈아끼운다** ─────────────
      //   실측(2026-08-21, codex 구독): *"node 버전 좀 확인해줘"* 에 **자기 셸**을 집었다가
      //   막히고 *"실행 정책에서 차단됐어요"* 로 끝냈다. 우리 run_shell 은 옆에 멀쩡히 있었다.
      //   2×2 로 갈라 6판씩 재보니 —
      //         · "한 줄 일 + 폴더 얘기 없음"  → **0/6** (되돌림 2회를 다 쓰고도)
      //         · 나머지 세 칸                → 4/6
      //   어느 한 축이 범인이 아니라 **둘 다 없을 때** 무너진다. 도구 설명 문구는 원인이 아니었다
      //   (문구에서 "허용된 폴더를 작업위치로"를 빼고 재봤다 — 0/6 → 1/6, 기준 미달).
      //   그리고 **실패한 판은 전부 되돌림 2회를 다 쓴 뒤 실패**했다. 늘려도 소용없다는 뜻이다.
      //
      //   ★검색과 **다르게** 간다. 검색은 판정기가 검색어를 새로 지어도 안전했다(읽기 전용).
      //     셸은 틀리면 실제로 뭔가 벌어진다 → **새로 짓지 않고, 하려던 명령만 뽑는다.**
      //     명령 자체는 두뇌가 이미 만들어놨다(답변에 `node --version` 이라고 적혀 있다).
      //     못 만드는 게 아니라 **통로를 잘못 고른 것**이라, 통로만 바꾼다.
      //
      //   ★★허락은 사용자만 한다 — 이 선은 안 넘는다.
      //     아직 허용 전이면 **실행하지 않는다.** 대신 허용 요청을 띄운다:
      //     codex 는 도구를 아예 안 불러서 **그 요청조차 안 생기고 있었다**(실측 허용요청 0/3).
      //     사용자는 "차단됐다"는 말만 듣고 켤 기회를 못 받았다. 그게 더 나쁘다.
      let _준셸 = '', _셸대신함 = false, _셸허락필요 = false;
      if (v.reason === 'request' && v.kind === 'shell' && attempt === 0) {
        try {
          const _자율 = agent.trustLevel === 'autonomous';
          if (!agent.allowShell && !_자율) {
            if (!(grants.pending(agentId) || {}).kind) {
              grants.ask(agentId, 'shell', { agent });   // ★허락은 grants 한 곳에서만 건다
              console.warn('[claim] 셸이 필요한데 아직 허용 전 — 허용 요청을 우리가 띄운다');
            }
            // ★허락은 **다음 사용자 말**로 받는다(위 pendingGrant 소비 자리). 버튼이 아니라 대화다.
            //   그래서 에이전트가 **실제로 물어야** 사용자가 켤 기회를 얻는다.
            //   묻지 않고 *"정책상 차단됐어요"* 로 끝내면, 허용 요청은 떠 있는데
            //   사용자는 그런 게 있는 줄도 모른다 — 그게 지금까지의 모습이었다.
            _셸허락필요 = true; _허락묻는턴 = true;
            _준셸 = '\n\n[사실] 터미널 명령 실행은 **사용자만 켤 수 있다.** 지금은 꺼져 있다.'
              + `\n[사용자가 부탁한 것] ${String(userMessage).slice(0, 200)}`;
          } else {
            const _cmd = await claimCheck.extractShellCommand(userMessage, response, _osName, generate);
            if (_cmd) {
              // 우리 run_shell 코어를 그대로 지난다 → 파괴적 명령 차단·보호경로 차단이 전부 붙는다.
              const _r = require('./proc-tools').runShell(agent.allowedDirs || [], _cmd);
              try { storage.recordToolCall(agentId, 'run_shell', !(_r && (_r.error || _r.blocked))); } catch (_) {}
              if (_r && _r.ok) {
                // ★말이 새지 않게 못박는다. 안 박으면 이렇게 나간다(실측 2/6) —
                //   *"사용자님이 붙여주신 실제 실행 결과 기준으로는…"* · *"정책에 막혀서 직접 확인은 못 했어요"*
                //   우리가 준 재료를 **남이 준 것**처럼 말해버린다. 사용자는 준 적이 없다.
                //   이건 내부 사정이라 대화에 나오면 안 된다 — **결과만** 자기 말로 전해야 한다.
                _준셸 = `\n\n[명령 실행 결과 — **네가 부른 도구가 돌려준 값이다.** 이것만 근거로 답해라.]\n`
                  + `$ ${_cmd}\n${String(_r.stdout || '').slice(0, 2000)}\n`
                  + `★이 결과가 어디서 왔는지는 **말하지 마.** "사용자가 준"·"붙여주신"·"정책에 막혀서"·`
                  + `"직접 확인은 못 했지만" 같은 말은 금지다. 네가 확인한 것으로 **결과만** 전해라.\n`
                  + `여기 없는 값은 쓰지 마.`;
                _셸대신함 = true;
                console.warn(`[claim] 셸은 되돌림이 안 통한다 — 우리가 대신 돌린다: ${_cmd}`);
              } else {
                const _왜 = (_r && (_r.error || _r.stderr)) || '알 수 없는 실패';
                _준셸 = `\n\n[명령 실행 결과 — 우리가 실제로 돌렸고 **실패했다.**]\n$ ${_cmd}\n${String(_왜).slice(0, 600)}\n`
                  + `이 실패를 사용자에게 **그대로** 전해라. 지어내지 말고.`;
                console.warn(`[claim] 대신 돌렸으나 실패: ${_cmd} — ${String(_왜).slice(0, 80)}`);
              }
            }
          }
        } catch (e) { console.error('[claim] 대신 셸 실패(무시):', e.message); }
      }
      // ★이미 우리가 돌려서 결과가 있으면 **되돌림 문구를 붙이지 않는다.**
      //   되돌림 문구는 *"너 도구를 안 불렀다, 불러라"* 는 말이라 두뇌를 **실패 틀**에 앉힌다.
      //   그 틀에서 답하면 결과를 손에 쥐고도 *"정책에 막혔지만 제공된 결과로는…"* 이라고 나간다(실측).
      //   할 일이 이미 끝났으면 남은 일은 **결과를 사용자 말로 옮기는 것**뿐이다.
      const _nudge = _셸대신함
        ? '사용자에게 답할 차례다. 아래 결과를 네 말로 전해라.'
        : _셸허락필요
        ? '사용자에게 **터미널 명령 실행을 허용해도 되는지 물어라.** 한 문장이면 된다.\n'
          + '★"정책에 막혔다"·"차단됐다"·"권한이 없다" 같은 말은 **쓰지 마.** 그건 우리 사정이지 사용자가 알 일이 아니다.\n'
          + '무엇을 하려는지 짧게 말하고 허락해줄지 물어라. 사용자가 다음 말로 허락하면 바로 이어서 한다.'
        : (v.reason === 'request'
          ? claimCheck.buildRequestNudge(v.kind, known, userMessage)
          : claimCheck.buildNudge(v.claims, known));
      const _nudgeFull = _nudge + _준검색 + _준셸;   // 대신 해온 게 있으면 재료로 함께 넘긴다
      //   ★도구를 다시 쓸 수 있어야 의미가 있다 → 원래 턴과 같은 도구 조건으로 되돌린다.
      const retry = await generate(systemPrompt, _nudgeFull, {
        tools: true, webSearch: WEBSEARCH_BRAINS.has(agent.brainMode),
        // codex 구독: 자기 셸의 자물쇠를 **사용자가 허락했을 때만** 푼다(brain-codex 에서 씀).
        allowShell: !!agent.allowShell || agent.trustLevel === 'autonomous',
        extraDecls, extraExecute,
        mcpHttp: (mcpHttp && mcpHttp.length) ? mcpHttp : undefined, auxoHttp,
        agentId, dataPath: path.dirname(storage.getDataPath()),
      });
      if (retry && String(retry).trim()) response = String(retry).trim(); else break;
      // ★허락을 물었으면 **거기서 끝이다.** 한 번 더 검사해봐야 도구는 여전히 0 이고
      //   (허락 전이니 당연하다) 두뇌 호출만 한 번 더 쓰고 *"실제로 실행하지는 못했습니다"* 라는
      //   군더더기가 붙는다 — 방금 허락을 물어놓고 또 묻는 꼴이다.
      if (_허락묻는턴) break;
    }
  } catch (err) { console.error("[claim] 대조 실패(무시):", err.message); }

  // ★되돌림이 **답을 더 나쁘게** 만들 수 있다 — 그때는 원래 답으로 되돌린다.
  //   되돌림은 대화 이력을 안 실어 보낸다(그래서 싸다). 그래서 두뇌가 맥락을 잃고
  //   요청과 무관한 말을 내놓을 수 있다(2026-08-21 E2E 실측: 폴더 요청에 "앞으로 잘하겠다"는 다짐이 나왔다).
  //   기준은 **도구를 결국 불렀는가** 하나다 — 불렀으면 되돌림이 제 일을 한 것이고,
  //   끝내 안 불렀으면 새 답은 아무것도 못 고친 채 맥락만 잃은 것이다.
  //   ※ "우리가 대신 검색"한 턴은 장부에 web_search 가 남아 여기서 안 되돌린다 — 맞다.
  //     장부가 묻는 건 **일이 실제로 일어났나**이고, 우리가 부른 것도 실제로 일어난 것이다
  //     (엔진이 네이티브 검색에도 같은 방식으로 남긴다 — 위 evidenceSink 자리).
  //   ※ **허락을 물으라고 되돌린 턴은 예외다.** 그 턴은 도구를 안 부르는 게 맞다 —
  //     허락은 사용자만 켤 수 있으니 에이전트가 할 일은 **묻는 것**뿐이다.
  //     여기서 되돌리면 애써 물어본 답이 버려지고 *"정책상 차단됐어요"* 가 그대로 나간다(실측 0/4).
  //     그러면 허용 요청은 떠 있는데 사용자는 그런 게 있는 줄도 모른다.
  if (response !== _원래답 && !_허락묻는턴) {
    let _결국불렀나 = [];
    try { _결국불렀나 = storage.toolAttemptsSince(agentId, _turnStartTs) || []; } catch (_) {}
    if (!_결국불렀나.length) {
      console.warn('[claim] 되돌림 뒤에도 도구 호출 0 — 원래 답을 그대로 쓴다(맥락 잃은 답으로 바꾸지 않는다)');
      response = _원래답;
    }
  }
  // (정직 안내를 사용자 화면에 붙이던 자리 — 2026-08-22 에 뺐다. 위 attempt===1 주석 참고.
  //  판정은 claim_checks 장부에만 남는다. 사용자에게는 아무것도 덧붙이지 않는다.)

  // ── 정직 계층 ②: post-hoc 사실 검증 ─────────────────────────────
  // 검색 근거가 있을 때만(=실시간·사실 답변) 작동 → 잡담은 비용 0. 지지도 낮으면 말투만 눅인다(재생성 안 함).
  // ⚠️ 네이티브 검색 두뇌(gemini·claude)는 근거가 '원본 스니펫'이 아니라 자기 요약이라 부실 → 멀쩡한 답에도 오탐(완충)이 붙음.
  //    그래서 ②는 공통 web_search(원본 스니펫)를 쓰는 두뇌에만 적용. 네이티브 두뇌는 ①(프롬프트)+④(출처보관)로 커버.
  const _nativeWebBrain = ['gemini-api', 'claude-api', 'claude-subscription'].includes(agent.brainMode);
  if (!_nativeWebBrain && evidenceSink.length && response && response.length > 20) {
    try {
      const evText = evidenceSink.map(e => e && e.text || '').filter(Boolean).join('\n---\n').slice(0, 4000);
      if (evText) {
        const judgeSys = '너는 냉정한 사실 검증기야. 설명·인사 없이 0.0~1.0 숫자 하나만 출력해.';
        const judgePrompt = `[답변]\n${response.slice(0, 3000)}\n\n[답변할 때 실제로 얻은 검색 근거]\n${evText}\n\n`
          + `[답변]이 담은 구체적 사실·수치 주장이 [검색 근거]로 뒷받침되는 정도를 0.0~1.0 숫자 하나로만 답해. `
          + `근거에 없는 수치·사실을 답변이 단정했으면 낮게(0에 가깝게), 근거와 일치하면 높게(1에 가깝게). 오직 숫자만.`;
        const raw = await generate(judgeSys, judgePrompt, { temperature: 0, timeout: 30000 });
        const m = String(raw || '').match(/\b(0?\.\d+|1(?:\.0+)?|0)\b/);
        const score = m ? parseFloat(m[0]) : null;
        if (score !== null && score < 0.5) {
          // ★2026-08-22: **사용자 화면에 붙이지 않는다. 장부에만 남긴다.**
          //   ①③ 을 뺄 때 여기를 같이 안 봤다 — 같은 문구를 붙이는 자리가 **두 군데**였는데
          //   한 곳만 고쳤다. 실사용에서 그대로 나갔다(2026-08-22 15:01).
          //
          //   [왜 빼나]  판정 자체는 맞았다 — 검색은 했는데 답에 **확인 안 된 사실이 섞여** 있었다.
          //     문제는 알리는 방식이다. **어느 부분이 확인 안 됐는지 못 짚어주면서** 경고만 한다.
          //     사용자는 판단할 근거 없이 불안해지고, 앞에서 출처를 대놓고 뒤에서 부정하는 꼴이 된다.
          //   [왜 다시 안 시키나]  같은 두뇌가 같은 근거로 다시 쓰는 것이라 두 번째도 똑같이 지어낼 수 있다.
          //     "근거에 있는 것만 써라"로 못박으면 지어내는 건 줄지만 **아는 것도 안 쓰게 돼 답이 부실해진다.**
          //     시간은 대략 두 배가 된다. 막는 대신 잃는 것이 분명하다.
          //   [그래서]  판정을 남겨두고, 실사용에서 얼마나 잦은지 숫자로 본 뒤 다시 정한다.
          try {
            storage.recordClaimCheck(agentId, {
              reason: 'fact', kind: 'evidence', claims: [`지지도 ${score}`],
              retried: 0, resolved: false,
              brain: agent.brainMode,
              allowShell: !!agent.allowShell || agent.trustLevel === 'autonomous',
            });
          } catch (_) {}
        }
      }
    } catch (_) { /* 검증 실패는 답변에 영향 주지 않음 */ }
  }

  // ── 대화 저장 ────────────────────────────────────────────────────
  // 사용자 메시지는 두뇌 호출 전에 이미 남겼다 → 답변만 덧붙인다.
  // saveConversation(전체 덮어쓰기) 금지: 그 사이 다른 턴이 남긴 메시지가 사라진다.
  storage.appendMessages(agentId, [{ role: 'agent', content: response, ts: Date.now(), files: _sentCards.length ? _sentCards : undefined }]);

  // 정직 계층 ④: 이번 턴 검색 근거를 보관(다음 턴 on-demand 출처용). 검색 안 한 턴이면 이전 근거를 비운다(주제가 바뀌었으므로).
  try {
    const evItems = evidenceSink.filter(e => e && Array.isArray(e.sources) && e.sources.length);
    const fresh = storage.loadAgent(agentId);
    if (fresh) {
      if (evItems.length) fresh.lastEvidence = { ts: Date.now(), items: evItems.map(e => ({ query: e.query, sources: e.sources })) };
      else if (fresh.lastEvidence) delete fresh.lastEvidence;
      storage.saveAgent(fresh);
    }
  } catch (_) { /* 근거 보관 실패는 대화에 영향 주지 않음 */ }

  // P3.2 자가학습(b): 복잡 작업(작업 도구 2개+) 성공 후에만, 비차단으로 "스킬화할지" 판단.
  if (restTools && _toolCalls >= 2 && response && response.length > 10) {
    setImmediate(async () => {
      try {
        const existing = (skillsRegistry.list(agentId) || []).map(s => s.name || s.id);
        const r = await learnSkill.reflectAndLearn({ agentId, userMessage, response, generate, skillsRegistry, existing });
        if (r && r.learned) emit('skill:learned', { name: r.name, id: r.id });
      } catch (_) {}
    });
  }

  // 정직 계층 ③: 도구 배지를 상시 표시하지 않는다. 근거는 ④ on-demand 로만 제공. usedTools 는 내부 로깅용으로만 유지.
  return { response, recallCount: memory.user ? memory.user.split('\n').filter(Boolean).length : 0, generate, rememberedAny, usedTools: [...usedInfoTools], sentFiles: outboxSent };
}

/**
 * 대화 후 기억 후처리(추출 → 압축 → 망각 → 정리 → 루틴). 공통 모듈 memory-post 에 위임.
 * 앱 main.js scheduleMemoryTasks 와 동일 파이프라인 → 봇 채널(CLI·텔레그램·디스코드)도 압축/정리/루틴 획득.
 * 외부 시그니처·반환형 유지(호출자 무변경). UI 갱신은 emit 으로 매핑.
 *
 * @returns {Promise<{edited, promoted, grewTo, removedWrong, userMemory}>}
 */
async function processMemory({ agentId, userMessage, response, generate, rememberedAny = false, emit = () => {} }) {
  const r = await memoryPost.runPostMemory({
    agentId, userMessage, response, generate, rememberedAny,
    hooks: {
      onFacts: (id, text) => emit('facts', { agentId: id, userMemory: text }),
      onWork: (id, work) => emit('work', { agentId: id, work }),
    },
  });
  emit('memory', { added: r.added, updated: r.updated, mergedCount: r.mergedCount, removed: r.removed });
  return r;
}

module.exports = { pickGenerate, runTurn, processMemory, drainOutbox, classifyBrainError, __judgeApproval: judgeApproval };
