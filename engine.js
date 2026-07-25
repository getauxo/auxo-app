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
const agentQueue = require('./agent-queue');
const brainClaude = require('./brain-claude');
const youtube = require('./youtube-transcript'); // 유튜브 링크 자동 감지 → 자막/전사 주입(전 채널)
const brainGemini = require('./brain-gemini');
const brainAnthropic = require('./brain-anthropic');
const brainOpenai = require('./brain-openai');
const brainCodex = require('./brain-codex');
const brainAntigravity = require('./brain-antigravity');
const mcpGateway = require('./mcp-gateway');
const embeddings = require('./embeddings');
const localTools = require('./tools');
const subagents = require('./subagents');
const agentTools = require('./agent-tools');
const skillsRegistry = require('./skills-registry');
const mcpManager = require('./mcp-manager');
const learnSkill = require('./learn-skill'); // P3.2 자가학습 reflection
const toolTransparency = require('./tool-transparency'); // 안전장치 3: 도구 사용 투명 표시
const memoryPost = require('./memory-post'); // 대화 후 기억 후처리(추출·압축·망각·정리·루틴) 공통 모듈
const memorySearch = require('./memory-search'); // 기억 v3: 일화 자동 회상(선제 주입) + 검색

// REST 두뇌는 풀 도구셋(스킬·MCP·작업기억·L3)을 function-calling 으로 받는다(앱 TOOLS_PROVIDERS 와 동일).
const TOOLS_BRAINS = new Set(['gemini-api', 'claude-api', 'openai-api', 'openai-compatible']);
/**
 * ★2026-07-16: 실패의 정직한 전달.
 *
 * 기존엔 모든 실패를 "지금 바로 답을 드리지 못했어요 … (일시적 오류)" 한 문장으로 뭉갰다. 문제가 셋이었다:
 *  ① 원인을 알면서(auxo-error.log 에 기록까지 하면서) 사용자에게 숨겼다.
 *  ② 사용량 한도·키 만료·로그아웃은 **일시적이 아닌데** "일시적"이라 단정했다 = 거짓.
 *  ③ "다시 말 걸어주세요"는 한도일 때 해결되지 않는 조언 → 다시 시도 → 또 실패 = 막다른 길.
 * → 원인을 분류해 **사실대로 + 해결책까지** 말한다. 우리 정직 계층의 기본이다.
 *
 * @returns {{kind: string, text: string, retryable: boolean}}
 */
const _BRAIN_LABEL = {
  'claude-subscription': 'Claude 구독', 'codex-subscription': 'Codex 구독',
  'antigravity-subscription': 'Antigravity 구독', 'gemini-api': 'Gemini', 'claude-api': 'Claude API',
  'openai-api': 'GPT', 'openai-compatible': '연결된 모델',
};
function classifyBrainError(err, brainMode) {
  const m = String((err && err.message) || '');
  const who = _BRAIN_LABEL[brainMode] || '지금 두뇌';

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
const WEBSEARCH_BRAINS = new Set(['claude-api']);
// 위험 MCP 도구 승인 대기(턴 간) — CLI/봇 프로세스 전역.
const _enginePendingMcp = new Map();

// 서브에이전트(위임)를 function-calling 으로 즉시 쓸 수 있는 REST 두뇌.
// claude·codex 구독은 도구를 MCP 서버 경유로 받아 별도 작업 필요 → v1 제외(subagent-design.md).
const REST_BRAINS = new Set(['gemini-api', 'openai-api', 'claude-api', 'openai-compatible']);

/**
 * 에이전트 두뇌(brainMode) → (systemPrompt, userPrompt, opts) => Promise<text> 생성기.
 * 모든 LLM 두뇌를 한 시그니처로 통일. 알 수 없는/미설정 두뇌는 null.
 * (main.js pickGenerate 와 동일 — 추후 main.js 가 이 모듈을 재사용하도록 통합 예정)
 */
function pickGenerate(agent) {
  const key = (agent.apiKeys && agent.apiKeys[agent.brainMode]) || agent.apiKey;
  const mdl = (agent.models && agent.models[agent.brainMode]) || agent.model;
  switch (agent.brainMode) {
    case 'gemini-api':
      return (sys, usr, opts = {}) => brainGemini.geminiGenerate(sys, usr, { ...opts, apiKey: key, model: mdl });
    case 'claude-subscription':
      return (sys, usr, opts = {}) => brainClaude.claudeGenerate(sys, usr, opts);
    case 'codex-subscription':
      return (sys, usr, opts = {}) => brainCodex.codexGenerate(sys, usr, opts);
    case 'antigravity-subscription':
      return (sys, usr, opts = {}) => brainAntigravity.antigravityGenerate(sys, usr, { ...opts, model: mdl });
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

// 같은 에이전트의 턴은 한 번에 하나씩 처리한다(앱 chat:send 와 동일 규칙).
// 텔레그램·디스코드는 사용자가 연달아 메시지를 보내기 쉬운 채널이라 특히 중요하다.
async function runTurn(opts) {
  return agentQueue.runExclusive(opts && opts.agentId, () => _runTurn(opts));
}

async function _runTurn({ agentId, userMessage, emit = () => {}, attachments, deliverFile, displayUserMessage, userFiles, onDelta, signal }) {
  // 저장/표시용 메시지(displayUserMessage)와 두뇌 전달용(userMessage)을 분리 가능.
  // 앱이 첨부를 인테이크한 뒤: 두뇌엔 파일내용·경로 인라인(userMessage), 대화엔 "첨부: 이름"만(displayUserMessage)
  // + 첨부 원본 카드(userFiles)를 사용자 메시지에 붙인다. 미지정 시 기존 동작(둘 다 userMessage, 카드 없음).
  const agent = storage.loadAgent(agentId);
  if (!agent) return { error: '에이전트를 찾을 수 없음' };

  // 프롬프트용 히스토리에선 실패 마커(error:true)를 뺀다 — 화면엔 남지만 두뇌엔 안 먹인다(모델 오염 방지).
  // 표시는 렌더러가 storage.loadConversation 을 직접 읽으므로 마커가 그대로 보인다.
  // 두뇌가 보는 대화 = 아카이브(압축으로 접혀 내려간 옛 원문) + 현재 대화.
  // ★2026-07-16: 예전엔 현재 대화만 읽어서, 압축으로 아카이브에 내려간 대화는 두뇌 시야에서 통째로 사라졌다
  //   (저장은 100% 살아 있는데 두뇌만 못 봄 → "받은 적 없다" 거짓의 한 원인). 저장 위치가 달라도 기억은 하나다.
  // 대용량 대비: 아카이브를 통째로 읽지 않고 **맨 앞(head) + 최근(tail)** 만 읽는다.
  //   오래 쓴 사용자(수만 개)일수록 매 턴 전량 로드가 답을 느리게 만든다 — 우리 지향점이 "오래 함께한 친구"라 그대로 둘 수 없다.
  const _arch = storage.loadArchivedWindow(agentId);
  const messages = [].concat(
    _arch.head || [], _arch.tail || [],
    storage.loadConversation(agentId) || []
  ).filter(m => !(m && m.error));
  let mergedFacts = agent.humanFacts || [];

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
  if (!generate) return { error: `알 수 없는 AI: ${agent.brainMode}` };

  // ── 회상 (v2: 임베딩 의미검색 → 키워드 폴백) ──────────────────────
  // 질의어 = 현재 메시지 + 최근 대화(맥락). 기억이 많고(>12) 임베딩 지원 두뇌(gemini/openai)면
  // 의미 유사도로 회상, 아니면 키워드 겹침으로 폴백. (claude 두뇌는 항상 키워드)
  brainClaude.ensureMemoryShape(mergedFacts);
  const recentText = messages.slice(-6).map(m => m.content).join('\n');
  const recallQuery = `${userMessage}\n${recentText}`;
  let recall = null;
  const embedder = embeddings.getEmbedder(agent);
  // ★2026-07-16: "12개만 주입" 상한 제거 — 근거 없는 숫자였다.
  //   팩트는 짧아서(수십 개라도 수백 토큰) 20,000 토큰 창에 전부 넣어도 부담이 없고,
  //   총량은 망각(decay)·정리(consolidate)가 이미 관리한다. 관련순 정렬은 유지하되 전부 주입한다.
  if (embedder && Array.isArray(mergedFacts) && mergedFacts.length > 0) {
    try {
      const r = await embeddings.selectRelevant(mergedFacts, recallQuery, embedder, mergedFacts.length);
      if (r.recalled) {
        recall = { selected: r.selected, recalled: true, total: r.total };
        if (r.changed) { const fa = storage.loadAgent(agentId); if (fa) { fa.humanFacts = mergedFacts; storage.saveAgent(fa); } }
        emit('recall', { selected: recall.selected.length, total: recall.total, mode: 'semantic' });
      }
    } catch (e) { emit('recall-error', { message: e.message }); }
  }
  if (!recall) {
    // 키워드 폴백도 동일: RECALL_MAX(12) 상한을 쓰지 않고 전부 주입한다(위 의미검색 경로와 같은 이유).
    recall = brainClaude.selectRelevantFacts(mergedFacts, recallQuery, {
      activeId: agent.work && agent.work.activeId,
      max: Math.max(1, (mergedFacts || []).length),
    });
    emit('recall', { selected: recall.selected.length, total: recall.total, mode: 'keyword' });
  }

  // ── 기억 v3: 일화 자동 회상 — 현재 맥락에 관련된 지난 '사건'을 선제 주입(검색 요청 없이도 떠올림) ──
  // ★2026-07-17 제거: 일화 자동 주입(relevantEpisodes).
  //   창이 6개(3왕복)뿐이던 시절, "옛 일화를 두뇌가 못 본다"를 메우려고 넣은 보완책이었다.
  //   지금은 최근 20,000토큰 원문 + 아카이브까지 주입하므로 **일화가 원문에 있으면 두뇌가 이미 본다** = 중복.
  //   창 밖(더 옛날)은 요약이 흐름을 주고, 정확한 건 search_memory 로 꺼낸다.
  //   부수 효과: 근거 없던 임계값 0.75 제거 + 매 턴 일화 임베딩 계산(사용자 돈·시간) 제거 + 프롬프트 경량화.
  //   ⑤ 일화 '저장'은 유지 — 원문이 20,000토큰 밖으로 밀려나도 요점은 남아야 하므로.

  // ── 인출 강화: 실제 주입 확정된 기억만 강화(accessCount·strength↑, 망각 저항) ──
  if (recall && recall.recalled && Array.isArray(recall.selected) && recall.selected.length > 0) {
    try {
      const fresh = storage.loadAgent(agentId);
      if (fresh && Array.isArray(fresh.humanFacts)) {
        const selectedIds = new Set(recall.selected.map(f => f.id).filter(Boolean));
        if (selectedIds.size > 0) {
          brainClaude.reinforce(fresh.humanFacts, selectedIds, Date.now());
          storage.saveAgent(fresh);
          const idMap = new Map(fresh.humanFacts.map(f => [f.id, f]));
          for (let i = 0; i < mergedFacts.length; i++) {
            const u = mergedFacts[i].id && idMap.get(mergedFacts[i].id);
            if (u) mergedFacts[i] = u;
          }
        }
      }
    } catch (_) {}
  }

  // ── 시스템 프롬프트 (1층 + 성격 + 회상된 기억). 도구·스킬 없음(v1) ──
  const layer2 = { speech: agent.speech || 'auto', userNickname: agent.userNickname || '', auxoMd: agent.auxoMd || '' };
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
      try { const m = await mcpManager.collectTools(agentId); mcpRoutes = m.routes; mcpDecls = m.decls.filter(d => { const r = m.routes.get(d.name); return !r || !offMcp.has(r.id); }); } catch (_) {}
    }
  }

  // ── 위험 MCP 도구: 직전 턴 '승인 대기'를 이번 사용자 답으로 소비(앱 main.js와 동일 동작). ──
  //    이게 없으면 "승인"해도 실행이 안 되고 두뇌가 도구를 재호출 → 무한 승인 루프가 났다.
  let approvalNote = '';
  if (restTools && _enginePendingMcp.has(agentId)) {
    const p = _enginePendingMcp.get(agentId);
    _enginePendingMcp.delete(agentId); // one-shot
    const isCancel = /(취소|아니|하지\s*마|싫|안\s*해|관둬|nope|no\b)/i.test(userMessage);
    // "앞으로/계속/이제부터 묻지 말고/알아서" = 앞으로 안 묻기(자율도 전환) + 이번 것도 실행. 모델에 의존하지 않고 결정론적으로.
    const isAutoIntent = /(앞으로|앞으론|이제부터|계속|묻지\s*마|묻지\s*말|알아서|그냥\s*해)/.test(userMessage);
    const isApprove = /(승인|허용|그래|응|네|좋아|좋아요|진행|해줘|해도|ok|오케이|yes|ㅇㅇ|항상|하자|콜)/i.test(userMessage);
    if (isCancel && !isAutoIntent) {
      approvalNote = `[시스템 알림: 사용자가 '${p.server}'의 '${p.tool}' 실행을 취소했어. 실행하지 않았어. 다시 시도하지 말고 다른 걸 도와줘.]`;
    } else if (isAutoIntent || isApprove) {
      let flipped = false;
      if (isAutoIntent) { // 자율도 전환(결정론적 — 모델이 set_trust를 안 불러도 됨)
        try { const fr = storage.loadAgent(agentId); if (fr) { fr.trustLevel = 'autonomous'; storage.saveAgent(fr); if (agent) agent.trustLevel = 'autonomous'; flipped = true; } } catch (_) {}
      }
      if (/항상/.test(userMessage)) { try { mcpManager.setAutoApprove(agentId, p.serverId, true); } catch (_) {} }
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

  // Antigravity(구독): 우리 도구(MCP·remember 등)는 #548로 미지원이나 CLI 자체 네이티브 웹검색은 됨(실측 확증) → 웹검색만 정직 안내.
  const availableTools = (agent.brainMode === 'antigravity-subscription') ? ['web'] : ['remember', 'forget'];
  // REST 두뇌(gemini/openai/anthropic)는 커넥터가 localTools(시간·계산·URL)+웹검색을 자동 포함 → 1층에도 안내.
  if (restDelegate) availableTools.push('web', 'fetch_url', 'get_current_time', 'calculator');
  // 능력 안내: REST 두뇌 + 구독 두뇌(claude/codex) 공통. 구독도 auxo-mcp-tools로 아래 도구를 실제로 다 받는다(실행 대칭).
  if (restTools || subDelegate) {
    availableTools.push('새 스킬 찾기·설치(find_skill→승인→install_skill)', '새 도구(MCP) 찾기·설치(find_mcp→승인→install_mcp, 예: 파일·브라우저·메모리)', '프로젝트·루틴 관리(start_project/start_routine/switch_work/close_project)', '승인 정도(자율도) 바꾸기(set_trust — "앞으로 묻지 말고 알아서 해/위험한 것만 물어봐/뭐든 확인해")', '파일 다루기(list_files·read_file·write_file·make_dir·search_files — 허용 폴더 안에서만, 새 폴더는 grant_dir로 사용자 허락 후)', '터미널 명령 실행(run_shell — 허용 폴더에서, 파괴적 명령 차단; 사용 전 grant_shell로 허락)', '코드 실행(run_code — python/node/bash, 긴 코드에 편함)', '웹 검색(web_search — 실시간 정보·최신 사실을 인터넷에서 찾기)', '정기 작업 예약(schedule_task — "매일 9시/매시/N분마다" 자동 실행; PC 켜진 동안)', '방법 익히기·스킬 만들기(create_skill — 잘 해낸 방법을 저장해 다음에 재사용)', '먼저 안부 묻기 설정(set_heartbeat — "그만/다시 챙겨줘/인사 시간 바꿔")');
    if (restTools) availableTools.push('복잡한 작업 단계분해 실행(plan_task/resume_task)'); // L3 플래너는 REST 두뇌 전용(구독 MCP엔 없음)
    if (mcpDecls.length) availableTools.push(`연결된 MCP 도구: ${mcpDecls.map(d => d.name).join(', ')}`);
  }
  if (canDelegate) availableTools.push('delegate_to_workers');
  let systemPrompt = brainClaude.buildSystemPrompt(agent.name, agent.persona, recall.selected, layer2, availableTools, skillCatalog);
  const nowKST = localTools.getCurrentTime().korea_time;
  systemPrompt += `\n\n[현재 시각 (사실 — 반드시 이것만 기준)]\n지금은 한국 시간으로 ${nowKST}야. "오늘/지금/현재/올해" 같은 시점은 절대 추측하지 말고 반드시 이 값을 기준으로 답해.`;
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
  // ★2026-07-16: 예산 절단 제거. 기존엔 getCtxBudget(추측표 × 0.5, 모르는 두뇌는 8,000 가정)으로 잘랐는데,
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
  const evidenceSink = []; // 정직 계층 ④/②: 이번 턴 웹검색 근거(결과+출처) 수집(REST 두뇌가 채움)
  const extraDecls = [
    {
      name: 'remember',
      description: '사용자에 관해 새로 알게 된 중요한 사실·선호·관계·진행상황을 장기 기억에 저장한다. 사용자가 알려주거나 앞으로 기억해두면 좋을 정보일 때 호출. 사소·일시적인 건 저장하지 마.',
      parameters: { type: 'object', properties: {
        label: { type: 'string', description: '기억 항목 이름(짧게)' },
        value: { type: 'string', description: '기억 내용' },
        importance: { type: 'number', description: '중요도 1~3. 핵심 정체성·관계는 3.' },
      }, required: ['label', 'value'] },
    },
    {
      name: 'forget',
      description: '사용자가 특정 기억을 지워달라고 명시적으로 요청할 때만 호출. 정정 시(삭제 후 remember)도 사용. 임의로 지우지 마.',
      parameters: { type: 'object', properties: {
        query: { type: 'string', description: '지울 기억을 가리키는 말(항목 이름/내용 키워드)' },
      }, required: ['query'] },
    },
  ];
  // 서브에이전트 위임 도구 선언 — REST 두뇌만 function-calling 으로(구독은 MCP 서버가 제공).
  if (restDelegate) {
    extraDecls.push({
      name: 'delegate_to_workers',
      description: '규모가 크거나 여러 갈래로 나눌 수 있는 작업을, 여러 임시 일꾼에게 나눠 동시에 처리시킨다. '
        + '각 일꾼은 독립적으로 한 부분을 맡아 결과를 돌려준다(최대 5명, 너와 같은 두뇌). '
        + '사용자가 "각각 / 나눠서 / 동시에 / 세 가지를 / 여러 개를" 처럼 여러 항목을 병렬로 처리해 달라고 하면, '
        + '그 항목 수만큼(최대 5) 한 번에 tasks 에 담아 위임해. '
        + '⚠️ 일부만 위임하고 나머지는 직접 답하는 식으로 쪼개지 마 — 위임하기로 했으면 해당 항목 "전부"를 tasks 에 넣어. '
        + '일꾼은 너의 기억·도구를 쓰지 못하고 받은 작업 설명만 보고 일하니, 각 작업을 자세하고 독립적으로 적어줘. '
        + '결과가 오면 네가 종합해서 사용자에게 답해. 한두 마디로 끝낼 간단한 일은 위임하지 말고 직접 해.',
      parameters: { type: 'object', properties: {
        tasks: { type: 'array', items: { type: 'string' },
          description: '각 일꾼에게 맡길 작업 설명 배열(최대 5개). 각 항목은 독립적으로 처리 가능해야 함.' },
      }, required: ['tasks'] },
    });
  }
  // REST 두뇌: 스킬·MCP·작업기억·L3 도구 추가(remember/forget는 아래 인라인이 처리하므로 제외, delegate는 위에서 처리).
  if (restTools) {
    // 하이브리드(설계): 네이티브 검색이 있는 두뇌(Gemini·Claude)는 자체 검색이 더 정확하므로
    // 공통 web_search(DuckDuckGo)를 주지 않는다 — 약한 쪽을 고르는 걸 막는다. 네이티브 없는 두뇌(GPT 등)만 공통검색.
    const nativeWeb = ['gemini-api', 'claude-api', 'claude-subscription'].includes(agent.brainMode);
    for (const d of agentTools.buildDecls({ skillCatalog, mcpDecls })) {
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
  }) : null;
  const extraExecute = async (n, args) => {
    if (learnSkill.isWorkTool(n)) _toolCalls++; // 자가학습: 작업 도구만 카운트
    if (toolTransparency.isTracked(n)) usedInfoTools.add(n); // 안전장치 3: 정보 도구 사용 기록
    if (n === 'remember') {
      const label = String(args.label || '').trim();
      const value = String(args.value || '').trim();
      if (!label || !value) return { error: 'label과 value가 필요해' };
      const imp = Math.max(1, Math.min(3, Number(args.importance) || 1));
      const fresh = storage.loadAgent(agentId);
      if (!fresh) return { error: '저장 실패' };
      brainClaude.ensureMemoryShape(fresh.humanFacts || []);
      const fact = { label, value, importance: imp, ts: new Date().toISOString(), source: 'remember' };
      const activeId = fresh.work && fresh.work.activeId;
      if (activeId) { const wt = activeId.startsWith('rt-') ? 'routine' : 'project'; fact.scope = `${wt}:${activeId}`; }
      const { merged, added, updated, mergedCount } = brainClaude.integrateMemory(fresh.humanFacts || [], [fact], {});
      if (added || updated || mergedCount) {
        brainClaude.ensureMemoryShape(merged);
        fresh.humanFacts = merged; storage.saveAgent(fresh); rememberedAny = true;
        emit('facts', { humanFacts: merged });
        return { saved: true, message: `'${label}' 기억함. 다시 저장하지 마.` };
      }
      return { saved: false, message: '이미 알고 있는 내용이야.' };
    }
    if (n === 'forget') {
      const query = String(args.query || '').trim();
      if (!query) return { error: '무엇을 잊을지 알려줘' };
      const fresh = storage.loadAgent(agentId);
      if (!fresh) return { error: '저장 실패' };
      const facts = fresh.humanFacts || [];
      const q = query.toLowerCase().trim();
      const STOP = new Set(['기억', '내', '나', '그거', '그건', '그것', '방금', '관련', '부분', '정보', '것', '거', '얘기', '이야기']);
      const qWords = q.split(/[\s,.]+/).filter(w => w.length >= 2 && !STOP.has(w));
      const matchFact = (f) => {
        const label = String(f.label || '').toLowerCase();
        const value = String(f.value || '').toLowerCase();
        if (!label && !value) return false;
        if (label && (label.includes(q) || q.includes(label))) return true;
        if (value && value.includes(q)) return true;
        return qWords.some(w => label.includes(w) || value.includes(w));
      };
      const matches = facts.filter(matchFact);
      if (matches.length === 0) return { forgotten: false, message: `'${query}'에 해당하는 기억이 없어.` };
      if (matches.length > 5) return { forgotten: false, tooMany: true, message: `'${query}' 관련 기억이 ${matches.length}개나 돼. 더 구체적으로 알려줄래?`, candidates: matches.map(m => m.label) };
      const kept = facts.filter(f => !matches.includes(f));
      fresh.humanFacts = kept; storage.saveAgent(fresh); rememberedAny = true;
      emit('facts', { humanFacts: kept });
      return { forgotten: true, count: matches.length, items: matches.map(m => `${m.label}: ${m.value}`), message: `${matches.length}개 기억을 지웠어: ${matches.map(m => m.label).join(', ')}` };
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

  // claude 구독은 MCP 서버로 기억을 '직접' 저장(extraExecute 를 안 거침) → 아래 변경 감지로 rememberedAny 보정.
  const _factSnap = () => JSON.stringify((storage.loadAgent(agentId).humanFacts || []).map(f => (f.id || '') + '|' + f.label + '|' + f.value));
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

  emit('thinking', {});
  // 구독 두뇌 비전: 첨부는 inline_data(API 두뇌)가 아니라 디스크의 파일 경로를 CLI가 직접 열어서 본다.
  // → 구독 3종(claude=native Read / codex=read-only 파일읽기 / antigravity=동일 패턴, 미검증)에 경로 전달.
  //   각 brain-*가 opts.imageFiles로 파일을 열어보도록 안내(+claude는 Read 허용). API 두뇌는 attachments=inline_data 경로 그대로.
  // ⚠️ 이미지뿐 아니라 **PDF도 포함**(claude·codex 실측 2026-07-16: 경로 주면 마커 정확 판독).
  //    PDF를 빼면 구독두뇌 사용자는 PDF 첨부를 아예 못 본다 — file-intake는 이미지·PDF를 똑같이 base64(multimodal)로만
  //    만드는데 구독두뇌는 base64를 못 쓰기 때문. (Office·텍스트는 file-intake가 텍스트로 추출·인라인 → 두뇌 무관 정상.)
  const _subVision = ['claude-subscription', 'codex-subscription', 'antigravity-subscription'].includes(agent.brainMode);
  const _openable = f => f && f.path && (f.isImage || /\.pdf$/i.test(f.name || f.path));
  const imageFiles = (_subVision && Array.isArray(userFiles))
    ? userFiles.filter(_openable).map(f => f.path)
    : undefined;
  // 구독 두뇌(claude·codex): 설치 MCP를 상시 HTTP 게이트웨이로 노출해 매턴 spawn 레이스(pending) 제거.
  // REST 두뇌는 mcpManager 직접 호출이라 불필요. antigravity는 우리 MCP 미지원이라 제외.
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
  // ★2026-07-16: 재시도 여부 = 원인 분류의 retryable 을 따른다.
  //   기존엔 `err.code != null` 이면 재시도해서, **사용량 한도(429)도 곧바로 재시도**했다 —
  //   한도는 시간이 지나야 풀리므로 같은 실패를 반복하며 사용자 대기시간만 2배로 버렸다.
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
        extraDecls, extraExecute, evidenceSink,  // + 검색근거 수집
        attachments: (Array.isArray(attachments) && attachments.length) ? attachments : undefined, // 파일 첨부(멀티모달) — 채널이 file-intake 로 만든 것
        imageFiles: (imageFiles && imageFiles.length) ? imageFiles : undefined, // claude 구독 비전(native Read로 이미지 파일 보기)
        mcpHttp: (mcpHttp && mcpHttp.length) ? mcpHttp : undefined, // 구독 두뇌: 설치 MCP 상시 HTTP 게이트웨이 URL 목록
        auxoHttp,  // 구독 두뇌: 내장 auxo 도구 상시 게이트웨이 URL(있으면 stdio 대신 사용, 없으면 stdio 폴백)

        onDelta: _onDelta,  // 실시간 스트리밍(지원 두뇌만). 채널이 콜백 주입(앱=chat:stream), 미지정 시 최종 일괄.
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
    // ★2026-07-16: 원인을 분류해 **사실대로 + 해결책까지** 전한다.
    //   기존엔 전부 "(일시적 오류) 잠시 후 다시 말 걸어주세요"로 뭉갰다 — 원인을 알면서(로그엔 기록) 숨겼고,
    //   한도·키만료는 일시적이 아닌데 "일시적"이라 단정했으며, 다시 시도해도 또 실패하는 막다른 길이었다.
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
          response += '\n\n(솔직히 덧붙이면, 방금 답 중 일부는 내가 찾은 자료로 완전히 확인하진 못했어. 중요한 내용이면 원래 출처도 같이 확인해줘.)';
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

  // 정직 계층 ③: 도구 배지 상시표시 제거(마스터 결정). 근거는 ④ on-demand 로만 제공. usedTools 는 내부 로깅용으로만 유지.
  return { response, recallCount: recall.selected.length, generate, rememberedAny, usedTools: [...usedInfoTools], sentFiles: outboxSent };
}

/**
 * 대화 후 기억 후처리(추출 → 압축 → 망각 → 정리 → 루틴). 공통 모듈 memory-post 에 위임.
 * 앱 main.js scheduleMemoryTasks 와 동일 파이프라인 → 봇 채널(CLI·텔레그램·디스코드)도 압축/정리/루틴 획득.
 * 외부 시그니처·반환형 유지(호출자 무변경). UI 갱신은 emit 으로 매핑.
 *
 * @returns {Promise<{added, updated, mergedCount, removed, humanFacts}>}
 */
async function processMemory({ agentId, userMessage, response, generate, rememberedAny = false, emit = () => {} }) {
  const r = await memoryPost.runPostMemory({
    agentId, userMessage, response, generate, rememberedAny,
    hooks: {
      onFacts: (id, facts) => emit('facts', { agentId: id, humanFacts: facts }),
      onWork: (id, work) => emit('work', { agentId: id, work }),
    },
  });
  emit('memory', { added: r.added, updated: r.updated, mergedCount: r.mergedCount, removed: r.removed });
  return r;
}

module.exports = { pickGenerate, runTurn, processMemory, drainOutbox, classifyBrainError };
