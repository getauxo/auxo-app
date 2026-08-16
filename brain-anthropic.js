/**
 * brain-anthropic.js — "Claude API" 두뇌 커넥터 (Anthropic Messages API)
 *
 * Anthropic Messages API(POST /v1/messages)를 직접 호출한다(raw HTTP).
 * - claude CLI 구독과 달리 순수 API라 CLAUDE.md·도구 누수 구조적 불가(brain-claude.js의 구독 경로와 별개).
 * - API 키: 환경변수 ANTHROPIC_API_KEY 우선, 없으면 같은 폴더 `anthropic-api-key` 파일. opts.apiKey가 최우선.
 * - 모델: opts.model > env ANTHROPIC_MODEL > 파일 `anthropic-model`. **기본값 없음** — 사용자가 목록에서 고른다.
 *
 * 인터페이스는 brain-gemini와 동일 시그니처(능력 평행):
 *   anthropicGenerate(systemPrompt, userPrompt, opts) -> Promise<string>
 *   opts: { apiKey, model, temperature, timeout, maxTokens, attachments, tools, webSearch, extraDecls, extraExecute }
 *  - opts.tools=true → function-calling 루프(시간·계산·fetch + use_skill/MCP 등 extraDecls). + opts.webSearch면 네이티브 web_search 도구 합류.
 *  - opts.attachments → 이미지/PDF를 content 블록으로 첨부(멀티모달).
 */
'use strict';
const fs = require('fs');
const path = require('path');
const localTools = require('./tools'); // keyless 로컬 도구(시간·계산·fetch)
// L2: 대용량 도구출력 요약 헬퍼 (brain-claude에서 공유)
const { summarizeToolResult } = require('./brain-claude');
const toolDecls = require('./tool-decls');   // 라운드 가드(꺼내기와 쓰기 분리)

const ANTHROPIC_ENDPOINT = 'https://api.anthropic.com/v1/messages';
const ANTHROPIC_VERSION = '2023-06-01';
// ★기본 모델을 두지 않는다 — 상세 근거는 brain-openai.js 같은 자리에.
//   요지: 기본값은 언젠가 반드시 죽고(OpenAI 에서 실제로 겪음), 별칭은 안 죽는 대신 뭘 얼마에 쓰는지 감춘다.
//   → 사용자가 목록에서 직접 고른다. 못 고르면 진행을 막는다.
const MODELS_ENDPOINT = 'https://api.anthropic.com/v1/models?limit=100';
const DEFAULT_MAX_TOKENS = 4096;
const MAX_TOOL_ROUNDS = 6; // function-calling 최대 왕복(무한루프 방지)
const WEB_SEARCH_TOOL = { type: 'web_search_20260209', name: 'web_search', max_uses: 5 }; // 네이티브 서버 도구

function _readFile(name) {
  try {
    const p = path.join(__dirname, name);
    if (fs.existsSync(p)) return fs.readFileSync(p, 'utf8').trim();
  } catch (_) {}
  return '';
}

/** API 키: env > 파일 */
function getApiKey() {
  if (process.env.ANTHROPIC_API_KEY && process.env.ANTHROPIC_API_KEY.trim()) {
    return process.env.ANTHROPIC_API_KEY.trim();
  }
  return _readFile('anthropic-api-key');
}

/** 모델명: env > 파일. **기본값 없음** — 못 찾으면 빈 문자열(호출부가 막는다). */
function getModel() {
  if (process.env.ANTHROPIC_MODEL && process.env.ANTHROPIC_MODEL.trim()) return process.env.ANTHROPIC_MODEL.trim();
  return _readFile('anthropic-model') || '';
}

/**
 * 이 키로 지금 쓸 수 있는 모델 목록. 반환 형식은 세 두뇌 공통 — [{ id, label, hint }].
 * Anthropic 은 셋 중 정보가 가장 풍부하다 — display_name(사람이 읽는 이름)·created_at·max_input_tokens.
 * 목록 전체가 대화용이라 따로 거를 게 없다.
 */
async function listModels(apiKey) {
  const key = apiKey || getApiKey();
  if (!key) throw new Error('ANTHROPIC_API_KEY 없음');
  const res = await fetch(MODELS_ENDPOINT, {
    headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01' },
  });
  if (!res.ok) throw new Error(`모델 목록 조회 실패 (HTTP ${res.status})`);
  const json = await res.json();
  return (json.data || []).map((m) => {
    const 만 = m.max_input_tokens ? `${Math.round(m.max_input_tokens / 10000) / 100}M 담김` : '';
    return { id: m.id, label: m.display_name || m.id, hint: 만 };
  });
}

/** 저수준 POST. Message 객체 반환. 실패 시 throw. */
async function _post(key, body, timeoutMs, extSignal) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs || 120000);
  let res;
  try {
    res = await fetch(ANTHROPIC_ENDPOINT, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': key,
        'anthropic-version': ANTHROPIC_VERSION,
      },
      body: JSON.stringify(body),
      signal: extSignal ? AbortSignal.any([ctrl.signal, extSignal]) : ctrl.signal, // 정지: 외부 취소 신호 결합
    });
  } finally { clearTimeout(timer); }
  if (!res.ok) {
    const errText = await res.text().catch(() => '');
    throw new Error(`Anthropic API ${res.status}: ${errText.slice(0, 300)}`);
  }
  return res.json();
}

/** 저수준 스트리밍 POST(SSE). 텍스트를 onDelta로 흘리고, content 블록 재구성 + stop_reason 반환. */
async function _postStream(key, body, timeoutMs, onDelta, extSignal) {
  const ctrl = new AbortController();
  // '무응답(idle)' 타임아웃 — 청크 흐르는 동안엔 안 끊음(무거운/긴 생성 중간절단 방지). 전 두뇌 동일.
  const IDLE_MS = timeoutMs || 120000; let timer = null;
  const armIdle = () => { clearTimeout(timer); timer = setTimeout(() => ctrl.abort(), IDLE_MS); };
  armIdle();
  let res;
  try {
    res = await fetch(ANTHROPIC_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': key, 'anthropic-version': ANTHROPIC_VERSION },
      body: JSON.stringify({ ...body, stream: true }),
      signal: extSignal ? AbortSignal.any([ctrl.signal, extSignal]) : ctrl.signal, // 정지: 외부 취소 신호 결합
    });
  } catch (e) { clearTimeout(timer); throw e; }
  if (!res.ok) {
    clearTimeout(timer);
    const errText = await res.text().catch(() => '');
    throw new Error(`Anthropic API ${res.status}: ${errText.slice(0, 300)}`);
  }
  const dec = new TextDecoder();
  let buf = '', stopReason = null;
  const blocks = [], jsonAcc = {};
  try {
    for await (const chunk of res.body) {
      armIdle();
      buf += dec.decode(chunk, { stream: true });
      let idx;
      while ((idx = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, idx).trim(); buf = buf.slice(idx + 1);
        if (!line.startsWith('data:')) continue;
        const js = line.slice(5).trim();
        if (!js) continue;
        let obj; try { obj = JSON.parse(js); } catch (_) { continue; }
        if (obj.type === 'content_block_start') {
          const i = obj.index;
          blocks[i] = JSON.parse(JSON.stringify(obj.content_block || {}));
          if (blocks[i].type === 'tool_use') { jsonAcc[i] = ''; if (blocks[i].input === undefined) blocks[i].input = {}; }
        } else if (obj.type === 'content_block_delta') {
          const i = obj.index, d = obj.delta || {};
          if (d.type === 'text_delta') {
            if (blocks[i] && blocks[i].type === 'text') blocks[i].text = (blocks[i].text || '') + (d.text || '');
            if (onDelta && d.text) onDelta(d.text);
          } else if (d.type === 'input_json_delta') {
            jsonAcc[i] = (jsonAcc[i] || '') + (d.partial_json || '');
          }
        } else if (obj.type === 'message_delta') {
          if (obj.delta && obj.delta.stop_reason) stopReason = obj.delta.stop_reason;
        }
      }
    }
  } finally { clearTimeout(timer); }
  for (const i in jsonAcc) {
    if (blocks[i] && blocks[i].type === 'tool_use') {
      try { blocks[i].input = JSON.parse(jsonAcc[i] || '{}'); } catch (_) { blocks[i].input = {}; }
    }
  }
  return { content: blocks.filter(Boolean), stop_reason: stopReason };
}

/** 응답 content 블록에서 텍스트만 추출. */
function _text(msg) {
  const blocks = (msg && msg.content) || [];
  return blocks.filter(b => b.type === 'text').map(b => (b.text || '').trim()).filter(Boolean).join('\n').trim();
}

/** Gemini식 decl({name,description,parameters}) → Anthropic tool({name,description,input_schema}) */
function _toAnthropicTool(d) {
  return { name: d.name, description: d.description || '', input_schema: d.parameters || { type: 'object', properties: {} } };
}

/** userPrompt + 첨부 → content 블록 배열 */
function _userContent(userPrompt, attachments) {
  const content = [{ type: 'text', text: userPrompt }];
  if (Array.isArray(attachments)) {
    for (const a of attachments) {
      if (!a || !a.mimeType || !a.data) continue;
      if (a.mimeType === 'application/pdf') {
        content.push({ type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: a.data } });
      } else if (/^image\//.test(a.mimeType)) {
        content.push({ type: 'image', source: { type: 'base64', media_type: a.mimeType, data: a.data } });
      }
    }
  }
  return content;
}

/**
 * Claude 응답 생성. (brain-gemini.geminiGenerate와 같은 역할)
 */
async function anthropicGenerate(systemPrompt, userPrompt, opts = {}) {
  const key = opts.apiKey || getApiKey();
  if (!key) throw new Error('ANTHROPIC_API_KEY 없음 (env ANTHROPIC_API_KEY 또는 anthropic-api-key 파일에 넣어주세요)');
  const model = opts.model || getModel();
  // ★기본값이 없다 — 안 고르고 온 건 설정이 덜 된 것이다(근거는 brain-openai.js 같은 자리).
  if (!model) throw new Error('MODEL_NOT_SET: 쓸 모델을 아직 안 골랐어요. 설정에서 모델을 골라주세요.');
  const maxTokens = opts.maxTokens || DEFAULT_MAX_TOKENS;
  const system = (systemPrompt && systemPrompt.trim()) ? systemPrompt : undefined;

  const messages = [{ role: 'user', content: _userContent(userPrompt, opts.attachments) }];

  // ── 단순 모드(도구 없음) — 기억 백그라운드 작업 등 ──────────────
  if (!opts.tools) {
    const body = { model, max_tokens: maxTokens, messages };
    if (system) body.system = system;
    const msg = opts.onDelta
      ? await _postStream(key, body, opts.timeout || 60000, opts.onDelta, opts.signal)
      : await _post(key, body, opts.timeout || 60000, opts.signal);
    const text = _text(msg);
    if (!text) throw new Error(`Anthropic 텍스트 없음 (stop_reason=${msg.stop_reason || '?'})`);
    return text;
  }

  // ── function-calling 루프 모드 ─────────────────────────────
  const extraDecls = Array.isArray(opts.extraDecls) ? opts.extraDecls : [];
  const extraExecute = typeof opts.extraExecute === 'function' ? opts.extraExecute : null;
  // ★도구를 부르면서 같이 보낸 말을 버리지 않는다 — 버리면 마지막 라운드가 빌 수 있다(gemini 실측).
  let 라운드말 = '';
  for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
    // 매 라운드 재구성 — install_mcp가 같은 턴에 새 도구를 extraDecls에 밀어넣으면 즉시 보이게.
    const tools = [...localTools.DECLS, ...extraDecls].map(_toAnthropicTool);
    if (opts.webSearch) tools.push(WEB_SEARCH_TOOL); // 네이티브 웹검색(서버 실행)
    const body = { model, max_tokens: maxTokens, messages, tools };
    if (system) body.system = system;
    const msg = opts.onDelta
      ? await _postStream(key, body, opts.timeout || 120000, opts.onDelta, opts.signal)
      : await _post(key, body, opts.timeout || 120000, opts.signal);

    // 정직 계층 ④/②: 네이티브 web_search 결과(출처)를 근거로 수집. (원본 스니펫은 서버 암호화라 title+url 위주)
    if (Array.isArray(opts.evidenceSink)) {
      for (const b of (msg.content || [])) {
        if (b && b.type === 'web_search_tool_result' && Array.isArray(b.content)) {
          const hits = b.content.filter(x => x && x.type === 'web_search_result');
          const sources = hits.slice(0, 5).map(x => ({ title: x.title || '(제목없음)', uri: x.url || '' }));
          if (sources.length) {
            opts.evidenceSink.push({ query: '', text: hits.map(x => `${x.title || ''}: ${x.url || ''}`).join('\n').slice(0, 4000), sources });
          }
        }
      }
    }

    // 서버 도구(web_search)가 한도 도달 → 그대로 이어서 재요청
    if (msg.stop_reason === 'pause_turn') {
      messages.push({ role: 'assistant', content: msg.content });
      continue;
    }
    // 우리(클라이언트) 함수 호출 처리
    if (msg.stop_reason === 'tool_use') {
      { const t = _text(msg); if (t && !라운드말.includes(t)) 라운드말 = 라운드말 ? `${라운드말}\n${t}` : t; }
      messages.push({ role: 'assistant', content: msg.content }); // 함수호출 포함 전체 에코
      const toolUses = (msg.content || []).filter(b => b.type === 'tool_use');
      const results = [];
      // 한 라운드에 "꺼내기"와 "쓰기"가 같이 오면, 설명을 못 본 채 인자를 지어낸다 → 막고 다시 부르게 한다.
      const 라운드가드 = toolDecls.newRoundGuard();
      for (const call of toolUses) {
        let result;
        if (라운드가드.blocked(call.name)) {
          result = 라운드가드.message(call.name);
          console.log(`[brain-anthropic:tool] ${call.name} — 방금 꺼낸 도구라 이번 라운드에선 실행하지 않음`);
          results.push({ type: 'tool_result', tool_use_id: call.id, content: JSON.stringify(result) });
          continue;
        }
        try {
          if (extraExecute) {
            const r = await extraExecute(call.name, call.input || {});
            result = (r === null || r === undefined) ? await localTools.execute(call.name, call.input || {}) : r;
          } else {
            result = await localTools.execute(call.name, call.input || {});
          }
        } catch (e) { result = { error: String(e.message || e) }; }
        라운드가드.note(call.name, result);   // load_tools 로 꺼낸 것들을 이번 라운드 동안 잠근다
        console.log(`[brain-anthropic:tool] ${call.name}(${JSON.stringify(call.input || {})}) → ok`);
        // L2: 대용량 도구출력 요약 — TOOL_RESULT_MAX 초과 시만 LLM 요약 (작은 결과는 비용 0)
        const rawContent = typeof result === 'string' ? result : JSON.stringify(result);
        const goalHint = opts.goal || '';
        // summarizeToolResult는 async이므로 await (루프 내 직렬 처리)
        const summaryFn = (sys, usr, sopts = {}) => anthropicGenerate(sys, usr, { ...sopts, apiKey: key, model, maxTokens });
        const finalContent = await summarizeToolResult(rawContent, summaryFn, { toolName: call.name, goal: goalHint });
        results.push({
          type: 'tool_result',
          tool_use_id: call.id,
          content: finalContent,
        });
      }
      messages.push({ role: 'user', content: results });
      continue;
    }
    // 종료(end_turn / max_tokens / refusal …)
    if (msg.stop_reason === 'refusal') return '미안해요, 그 요청은 도와드리기 어려워요.';
    const text = _text(msg);
    if (text) return text;
    if (라운드말) return 라운드말;   // 도구를 부르며 이미 답을 말해 뒀다(gemini 쪽 같은 자리의 실측 참고)
    // ★빈 응답 — 이유를 버리지 않는다(gemini 쪽 같은 자리의 주석 참고).
    //   stop_reason 을 알고 있으면서 "다시 한번 말씀해 주시겠어요?"로 덮으면,
    //   사용자는 자기 탓인 줄 알고 같은 말을 되풀이하고 우리는 원인을 못 본다.
    throw new Error(`Claude 텍스트 없음 (stop_reason=${msg.stop_reason || '?'})`);
  }
  // 라운드 소진 → 도구 없이 마지막 정리
  const body = { model, max_tokens: maxTokens, messages };
  if (system) body.system = system;
  const msg = await _post(key, body, 60000, opts.signal);
  return _text(msg) || '(요청을 끝까지 처리하지 못했어요. 다시 시도해 주실래요?)';
}

/** 대화 응답용 안전 래퍼. */
async function askAnthropic(systemPrompt, userPrompt, opts = {}) {
  try {
    return await anthropicGenerate(systemPrompt, userPrompt, opts);
  } catch (e) {
    console.error('[brain-anthropic] 오류:', e.message);
    return '지금 생각을 정리하는 데 시간이 좀 걸리고 있어요. 잠시 후 다시 말을 걸어주실래요?';
  }
}

module.exports = {
  anthropicGenerate,
  askAnthropic,
  getApiKey,
  getModel,
  listModels,
};
