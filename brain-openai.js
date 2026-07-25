/**
 * brain-openai.js — "GPT (OpenAI)" 두뇌 커넥터 (Chat Completions API)
 *
 * OpenAI Chat Completions API(POST /v1/chat/completions)를 직접 호출한다(raw HTTP).
 * - API 키: 환경변수 OPENAI_API_KEY 우선, 없으면 같은 폴더 `openai-api-key` 파일. opts.apiKey가 최우선.
 * - 모델: opts.model > env OPENAI_MODEL > 파일 `openai-model` > DEFAULT_MODEL.
 *
 * 인터페이스는 brain-gemini와 동일 시그니처:
 *   openaiGenerate(systemPrompt, userPrompt, opts) -> Promise<string>
 *   opts: { apiKey, model, temperature, timeout, maxTokens, attachments, tools, extraDecls, extraExecute }
 *  - opts.tools=true → function-calling 루프(시간·계산·fetch + use_skill/MCP 등 extraDecls).
 *  - opts.attachments → 이미지를 image_url(data URI)로 첨부(멀티모달, 이미지만).
 *  - ⚠️ 웹검색: Chat Completions 네이티브 미지원 → 제공 안 함(추후 Responses API/검색모델 어댑터, backlog).
 *  - ⚠️ PDF: Chat Completions는 이미지 입력만 → PDF 첨부는 무시(이미지만 전달).
 */
'use strict';
const fs = require('fs');
const path = require('path');
const localTools = require('./tools'); // keyless 로컬 도구(시간·계산·fetch)
// L2: 대용량 도구출력 요약 헬퍼 (brain-claude에서 공유)
const { summarizeToolResult } = require('./brain-claude');

const OPENAI_ENDPOINT = 'https://api.openai.com/v1/chat/completions';
const DEFAULT_MODEL = 'gpt-5-chat-latest'; // 자동 최신 별칭(GPT-5.5 계열, 노후화 재발 방지). 설정서 변경 가능.
const MAX_TOOL_ROUNDS = 6;

function _readFile(name) {
  try {
    const p = path.join(__dirname, name);
    if (fs.existsSync(p)) return fs.readFileSync(p, 'utf8').trim();
  } catch (_) {}
  return '';
}

/** API 키: env > 파일 */
function getApiKey() {
  if (process.env.OPENAI_API_KEY && process.env.OPENAI_API_KEY.trim()) {
    return process.env.OPENAI_API_KEY.trim();
  }
  return _readFile('openai-api-key');
}

/** 모델명: env > 파일 > 기본 */
function getModel() {
  if (process.env.OPENAI_MODEL && process.env.OPENAI_MODEL.trim()) return process.env.OPENAI_MODEL.trim();
  return _readFile('openai-model') || DEFAULT_MODEL;
}

/** 저수준 POST. 응답 JSON 반환. 실패 시 throw. */
/**
 * baseURL → 완성된 chat/completions endpoint.
 * baseURL 없으면 OpenAI 기본. baseURL은 보통 ".../v1"까지만 받고 우리가 /chat/completions 붙임.
 * 이미 /chat/completions로 끝나면 그대로 사용.
 */
function _endpointFrom(baseURL) {
  if (!baseURL || !String(baseURL).trim()) return OPENAI_ENDPOINT;
  let b = String(baseURL).trim().replace(/\/+$/, '');
  if (/\/chat\/completions$/.test(b)) return b;
  return b + '/chat/completions';
}

async function _post(key, body, timeoutMs, endpoint, extSignal) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs || 120000);
  let res;
  try {
    res = await fetch(endpoint || OPENAI_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${key}` },
      body: JSON.stringify(body),
      signal: extSignal ? AbortSignal.any([ctrl.signal, extSignal]) : ctrl.signal, // 정지: 외부 취소 신호 결합
    });
  } finally { clearTimeout(timer); }
  if (!res.ok) {
    const errText = await res.text().catch(() => '');
    throw new Error(`LLM API ${res.status}: ${errText.slice(0, 300)}`);
  }
  return res.json();
}

/** 저수준 스트리밍 POST(SSE). content를 onDelta로 흘리고, assistant 메시지(tool_calls 포함) 재구성. */
async function _postStream(key, body, timeoutMs, onDelta, endpoint, extSignal) {
  const ctrl = new AbortController();
  // '무응답(idle)' 타임아웃 — 청크 흐르는 동안엔 안 끊음(무거운/긴 생성 중간절단 방지). 전 두뇌 동일.
  const IDLE_MS = timeoutMs || 120000; let timer = null;
  const armIdle = () => { clearTimeout(timer); timer = setTimeout(() => ctrl.abort(), IDLE_MS); };
  armIdle();
  let res;
  try {
    res = await fetch(endpoint || OPENAI_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${key}` },
      body: JSON.stringify({ ...body, stream: true }),
      signal: extSignal ? AbortSignal.any([ctrl.signal, extSignal]) : ctrl.signal, // 정지: 외부 취소 신호 결합
    });
  } catch (e) { clearTimeout(timer); throw e; }
  if (!res.ok) {
    clearTimeout(timer);
    const errText = await res.text().catch(() => '');
    throw new Error(`OpenAI API ${res.status}: ${errText.slice(0, 300)}`);
  }
  const dec = new TextDecoder();
  let buf = '', text = '';
  const callsByIndex = {};
  try {
    for await (const chunk of res.body) {
      armIdle();
      buf += dec.decode(chunk, { stream: true });
      let idx;
      while ((idx = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, idx).trim(); buf = buf.slice(idx + 1);
        if (!line.startsWith('data:')) continue;
        const js = line.slice(5).trim();
        if (!js || js === '[DONE]') continue;
        let obj; try { obj = JSON.parse(js); } catch (_) { continue; }
        const d = obj.choices && obj.choices[0] && obj.choices[0].delta;
        if (!d) continue;
        if (d.content) { text += d.content; if (onDelta) onDelta(d.content); }
        if (Array.isArray(d.tool_calls)) {
          for (const tc of d.tool_calls) {
            const i = tc.index || 0;
            if (!callsByIndex[i]) callsByIndex[i] = { id: tc.id || '', type: 'function', function: { name: '', arguments: '' } };
            if (tc.id) callsByIndex[i].id = tc.id;
            if (tc.function) {
              if (tc.function.name) callsByIndex[i].function.name = tc.function.name;
              if (tc.function.arguments) callsByIndex[i].function.arguments += tc.function.arguments;
            }
          }
        }
      }
    }
  } finally { clearTimeout(timer); }
  const calls = Object.keys(callsByIndex).sort((a, b) => a - b).map(k => callsByIndex[k]);
  const msg = { role: 'assistant', content: text || null };
  if (calls.length) msg.tool_calls = calls;
  return msg;
}

/** Gemini식 decl({name,description,parameters}) → OpenAI tool({type:'function',function:{...}}) */
function _toOpenaiTool(d) {
  return { type: 'function', function: { name: d.name, description: d.description || '', parameters: d.parameters || { type: 'object', properties: {} } } };
}

/** userPrompt + 첨부(이미지) → content (문자열 또는 멀티모달 배열) */
function _userContent(userPrompt, attachments) {
  const imgs = Array.isArray(attachments)
    ? attachments.filter(a => a && a.data && /^image\//.test(a.mimeType || ''))
    : [];
  if (imgs.length === 0) return userPrompt; // 텍스트만이면 문자열
  const parts = [{ type: 'text', text: userPrompt }];
  for (const a of imgs) parts.push({ type: 'image_url', image_url: { url: `data:${a.mimeType};base64,${a.data}` } });
  return parts;
}

/**
 * GPT 응답 생성. (brain-gemini.geminiGenerate와 같은 역할)
 */
async function openaiGenerate(systemPrompt, userPrompt, opts = {}) {
  const key = opts.apiKey || getApiKey();
  if (!key) throw new Error('OPENAI_API_KEY 없음 (env OPENAI_API_KEY 또는 openai-api-key 파일에 넣어주세요)');
  const model = opts.model || getModel();
  const endpoint = _endpointFrom(opts.baseURL); // OpenAI 호환 제공자(OpenRouter·Grok·DeepSeek 등) 지원

  const messages = [];
  if (systemPrompt && systemPrompt.trim()) messages.push({ role: 'system', content: systemPrompt });
  messages.push({ role: 'user', content: _userContent(userPrompt, opts.attachments) });

  const base = { model, messages };
  if (opts.maxTokens) base.max_completion_tokens = opts.maxTokens;

  // ── 단순 모드(도구 없음) ──────────────────────────────────
  if (!opts.tools) {
    let text;
    if (opts.onDelta) {
      const msg = await _postStream(key, base, opts.timeout || 60000, opts.onDelta, endpoint, opts.signal);
      text = msg.content || '';
    } else {
      const data = await _post(key, base, opts.timeout || 60000, endpoint, opts.signal);
      text = (data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content) || '';
    }
    if (!text.trim()) throw new Error('OpenAI 텍스트 없음');
    return text.trim();
  }

  // ── function-calling 루프 모드 ─────────────────────────────
  const extraDecls = Array.isArray(opts.extraDecls) ? opts.extraDecls : [];
  const extraExecute = typeof opts.extraExecute === 'function' ? opts.extraExecute : null;
  for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
    // 매 라운드 재구성 — install_mcp가 같은 턴에 새 도구를 extraDecls에 밀어넣으면 즉시 보이게.
    const tools = [...localTools.DECLS, ...extraDecls].map(_toOpenaiTool);
    let msg;
    if (opts.onDelta) {
      msg = await _postStream(key, { ...base, messages, tools }, opts.timeout || 120000, opts.onDelta, endpoint, opts.signal);
    } else {
      const data = await _post(key, { ...base, messages, tools }, opts.timeout || 120000, endpoint, opts.signal);
      msg = data.choices && data.choices[0] && data.choices[0].message;
    }
    if (!msg) throw new Error('OpenAI 응답 비어있음');
    const calls = msg.tool_calls || [];
    if (calls.length === 0) {
      return (msg.content || '').trim() || '음... 지금 제대로 답을 못 드리겠네요. 다시 한번 말씀해 주시겠어요?';
    }
    messages.push(msg); // 모델의 tool_calls 턴 에코
    for (const call of calls) {
      let args = {};
      try { args = JSON.parse(call.function.arguments || '{}'); } catch (_) {}
      let result;
      try {
        if (extraExecute) {
          const r = await extraExecute(call.function.name, args);
          result = (r === null || r === undefined) ? await localTools.execute(call.function.name, args) : r;
        } else {
          result = await localTools.execute(call.function.name, args);
        }
      } catch (e) { result = { error: String(e.message || e) }; }
      console.log(`[brain-openai:tool] ${call.function.name}(${JSON.stringify(args)}) → ok`);
      // L2: 대용량 도구출력 요약 — TOOL_RESULT_MAX 초과 시만 LLM 요약 (작은 결과는 비용 0)
      const rawContent = typeof result === 'string' ? result : JSON.stringify(result);
      const goalHint = opts.goal || '';
      const summaryFn = (sys, usr, sopts = {}) => openaiGenerate(sys, usr, { ...sopts, apiKey: key, model: opts.model || getModel(), baseURL: opts.baseURL });
      const finalContent = await summarizeToolResult(rawContent, summaryFn, { toolName: call.function.name, goal: goalHint });
      messages.push({
        role: 'tool',
        tool_call_id: call.id,
        content: finalContent,
      });
    }
  }
  // 라운드 소진 → 도구 없이 마지막 정리
  const data = await _post(key, { ...base, messages }, 60000, endpoint, opts.signal);
  const text = (data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content) || '';
  return text.trim() || '(요청을 끝까지 처리하지 못했어요. 다시 시도해 주실래요?)';
}

/** 대화 응답용 안전 래퍼. */
async function askOpenai(systemPrompt, userPrompt, opts = {}) {
  try {
    return await openaiGenerate(systemPrompt, userPrompt, opts);
  } catch (e) {
    console.error('[brain-openai] 오류:', e.message);
    return '지금 생각을 정리하는 데 시간이 좀 걸리고 있어요. 잠시 후 다시 말을 걸어주실래요?';
  }
}

module.exports = {
  openaiGenerate,
  askOpenai,
  getApiKey,
  getModel,
  DEFAULT_MODEL,
};
