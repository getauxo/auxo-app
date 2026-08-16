/**
 * brain-openai.js — "GPT (OpenAI)" 두뇌 커넥터 (Chat Completions API)
 *
 * OpenAI Chat Completions API(POST /v1/chat/completions)를 직접 호출한다(raw HTTP).
 * - API 키: 환경변수 OPENAI_API_KEY 우선, 없으면 같은 폴더 `openai-api-key` 파일. opts.apiKey가 최우선.
 * - 모델: opts.model > env OPENAI_MODEL > 파일 `openai-model`. **기본값 없음** — 사용자가 목록에서 고른다.
 *
 * 인터페이스는 brain-gemini와 동일 시그니처:
 *   openaiGenerate(systemPrompt, userPrompt, opts) -> Promise<string>
 *   opts: { apiKey, model, temperature, timeout, maxTokens, attachments, tools, extraDecls, extraExecute }
 *  - opts.tools=true → function-calling 루프(시간·계산·fetch + use_skill/MCP 등 extraDecls).
 *  - opts.attachments → 이미지는 image_url, **PDF 는 file 블록**(file_data=data URI)으로 첨부.
 *  - 웹검색: 제공자 **네이티브** 검색은 없다(Chat Completions 미지원, 추후 Responses API 어댑터=backlog).
 *    ⚠️단 "검색이 안 된다"는 뜻이 아니다 — `web_search` 는 tool-decls 의 **우리 공용 도구**이고 ALWAYS 라
 *    이 두뇌에도 실린다. 실측: 모델이 web_search 를 부르고 fetch_url 로 더 읽는다.
 *    (BRAIN_META 의 supportsWebSearch:false 는 **네이티브 유무**를 뜻한다. 사용자 관점에선 검색이 된다.)
 *
 * ★"Chat Completions 는 이미지 입력만 되고 PDF 첨부는 무시된다"는 말은 **사실이 아니다.**
 *   실측에서 PDF 를 그대로 읽었다. 걸러야 할 이유가 없으므로 `_userContent` 에서 버리지 않는다.
 *   버리면 사용자는 파일을 보냈는데 두뇌는 받은 줄도 모른다.
 *   ⚠️ 주석의 "안 된다"를 사실로 믿고 옮기지 말 것. **보내보면 금방 안다.**
 */
'use strict';
const fs = require('fs');
const path = require('path');
const localTools = require('./tools'); // keyless 로컬 도구(시간·계산·fetch)
// L2: 대용량 도구출력 요약 헬퍼 (brain-claude에서 공유)
const { summarizeToolResult } = require('./brain-claude');
const toolDecls = require('./tool-decls');   // 라운드 가드(꺼내기와 쓰기 분리)

const OPENAI_ENDPOINT = 'https://api.openai.com/v1/chat/completions';
// ★기본 모델을 두지 않는다.
//   전엔 `gpt-5-chat-latest` 를 기본으로 뒀는데 **OpenAI 가 그 모델을 폐기해 두뇌 전체가 죽어 있었다.**
//   기본값을 다른 이름으로 바꿔봐야 그것도 언젠가 죽는다. 별칭(`chat-latest`)은 안 죽지만
//   **뭘 쓰는지도, 얼마짜리인지도 알 수 없어** "사용자가 비용을 보고 고른다"는 원칙에 어긋난다.
//   → 기본을 두지 않고 **사용자가 목록에서 직접 고른다.** 못 고르면 진행을 막는다.
const MAX_TOOL_ROUNDS = 6;
const MODELS_ENDPOINT = 'https://api.openai.com/v1/models';

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

/** 모델명: env > 파일. **기본값 없음** — 못 찾으면 빈 문자열(호출부가 막는다). */
function getModel() {
  if (process.env.OPENAI_MODEL && process.env.OPENAI_MODEL.trim()) return process.env.OPENAI_MODEL.trim();
  return _readFile('openai-model') || '';
}

/**
 * 이 키로 지금 쓸 수 있는 **대화용** 모델 목록. 최신순.
 * 반환: [{ id, label, hint }] — id=호출에 쓰는 값, label=사람이 읽는 이름, hint=부가설명
 *
 * ⚠️ OpenAI 는 목록에 **용도·사람이름을 안 준다**(id·created·owned_by 뿐).
 *    Gemini 는 supportedGenerationMethods, Anthropic 은 display_name 을 주는데 여기만 없다.
 *    그래서 대화용 판별을 **우리가 이름 규칙으로** 해야 한다 — 이 규칙은 언젠가 낡는다(알고 쓴다).
 *    걸러내는 쪽(음성·이미지·임베딩)만 지정하고 나머지는 통과시켜, 새 모델이 나와도 안 사라지게 한다.
 */
async function listModels(apiKey) {
  const key = apiKey || getApiKey();
  if (!key) throw new Error('OPENAI_API_KEY 없음');
  const res = await fetch(MODELS_ENDPOINT, { headers: { Authorization: `Bearer ${key}` } });
  if (!res.ok) throw new Error(`모델 목록 조회 실패 (HTTP ${res.status})`);
  const json = await res.json();
  const 제외 = /whisper|tts|audio|realtime|transcribe|speech|dall-e|sora|image|embedding|moderation|search-api|codex/i;
  return (json.data || [])
    .filter((m) => m && m.id && !제외.test(m.id))
    .sort((a, b) => (b.created || 0) - (a.created || 0))
    .map((m) => ({ id: m.id, label: m.id, hint: '' }));
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

/**
 * 출력 상한 파라미터 이름을 바꿔 한 번 더 시도한다. (max_tokens ↔ max_completion_tokens)
 * ★제공자마다 받는 이름이 다르고 서로 배타적이라, 규격을 외워두면 반드시 낡는다.
 *   오류 메시지가 **어느 쪽을 쓰라고 정확히 알려주므로** 그걸 보고 바꾼다.
 * @returns 바꾼 새 body / 바꿀 게 없으면 null
 */
function _상한이름바꾸기(body, errText) {
  if (!/max_tokens|max_completion_tokens/i.test(errText)) return null;
  const b = { ...body };
  if ('max_tokens' in b) { b.max_completion_tokens = b.max_tokens; delete b.max_tokens; return b; }
  if ('max_completion_tokens' in b) { b.max_tokens = b.max_completion_tokens; delete b.max_completion_tokens; return b; }
  return null;
}

async function _post(key, body, timeoutMs, endpoint, extSignal, 상한재시도) {
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
    // ★출력 상한 이름만 안 맞는 경우면 이름을 바꿔 **한 번만** 재시도한다(무한 재시도 방지: _재시도 표시).
    //   ⚠️표시를 body 에 넣으면 안 된다 — 모르는 필드를 거부하는 제공자가 있다. **인자로** 넘긴다.
    if (res.status === 400 && !상한재시도) {
      const 바꾼 = _상한이름바꾸기(body, errText);
      if (바꾼) {
        console.log('[brain-openai] 출력 상한 파라미터 이름을 바꿔 재시도 (제공자 규격 차이)');
        return _post(key, 바꾼, timeoutMs, endpoint, extSignal, true);
      }
    }
    throw new Error(`LLM API ${res.status}: ${errText.slice(0, 300)}`);
  }
  return res.json();
}

/** 저수준 스트리밍 POST(SSE). content를 onDelta로 흘리고, assistant 메시지(tool_calls 포함) 재구성. */
async function _postStream(key, body, timeoutMs, onDelta, endpoint, extSignal, 상한재시도) {
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
    // ★스트리밍 경로에도 같은 처리 — 여기만 빠지면 "일반 대화는 되는데 스트리밍만 죽는" 반쪽 상태가 된다.
    if (res.status === 400 && !상한재시도) {
      const 바꾼 = _상한이름바꾸기(body, errText);
      if (바꾼) {
        console.log('[brain-openai] 출력 상한 파라미터 이름을 바꿔 재시도 (스트리밍)');
        return _postStream(key, 바꾼, timeoutMs, onDelta, endpoint, extSignal, true);
      }
    }
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
function _userContent(userPrompt, attachments, 호환) {
  const all = Array.isArray(attachments) ? attachments.filter(a => a && a.data && a.mimeType) : [];
  const imgs = all.filter(a => /^image\//.test(a.mimeType));
  // ★PDF 도 보낸다. 이미지만 거르고 **PDF 를 버리면** 사용자는 파일을 보냈는데
  //   두뇌는 받은 줄도 몰라, 모른 채 답하거나 "첨부가 없다"고 한다(정직할 기회조차 없는 셈).
  //   실측: file 블록으로 보내면 PDF 내용을 그대로 읽는다.
  //   ⚠️호환 제공자에는 PDF 를 보내지 않는다 — `type:'file'` 은 **OpenAI 확장**이라 규격을 보장 못 하고,
  //     모르는 블록을 받으면 400 으로 **대화 자체가 실패**한다(첨부 하나 때문에 답을 못 받는 게 더 나쁘다).
  //     대신 아래에서 **못 읽는다고 말해준다** — 조용히 버리면 두뇌가 받은 줄도 모른다.
  const pdfs = 호환 ? [] : all.filter(a => /^application\/pdf$/i.test(a.mimeType));
  const 버린PDF = 호환 ? all.filter(a => /^application\/pdf$/i.test(a.mimeType)) : [];
  let 본문 = userPrompt;
  if (버린PDF.length) {
    본문 += `\n\n[알림] 사용자가 PDF(${버린PDF.map(a => a.name || 'document.pdf').join(', ')})를 보냈지만, `
      + '지금 연결된 제공자는 PDF 첨부 규격이 확인되지 않아 전달하지 못했어. '
      + '내용을 아는 척하지 말고, 다른 두뇌(Claude·Gemini·GPT)로 바꾸거나 내용을 붙여넣어 달라고 안내해.';
  }
  if (imgs.length === 0 && pdfs.length === 0) return 본문; // 텍스트만이면 문자열
  const parts = [{ type: 'text', text: 본문 }];
  for (const a of imgs) parts.push({ type: 'image_url', image_url: { url: `data:${a.mimeType};base64,${a.data}` } });
  for (const a of pdfs) {
    parts.push({ type: 'file', file: { filename: a.name || 'document.pdf', file_data: `data:application/pdf;base64,${a.data}` } });
  }
  return parts;
}

/**
 * GPT 응답 생성. (brain-gemini.geminiGenerate와 같은 역할)
 */
async function openaiGenerate(systemPrompt, userPrompt, opts = {}) {
  const key = opts.apiKey || getApiKey();
  if (!key) throw new Error('OPENAI_API_KEY 없음 (env OPENAI_API_KEY 또는 openai-api-key 파일에 넣어주세요)');
  const model = opts.model || getModel();
  // ★기본값이 없다 — 안 고르고 온 건 설정이 덜 된 것이다. 아무거나 골라 대신 부르지 않는다
  //   (그렇게 하면 "기본값"이 되살아나고, 사용자는 자기가 뭘 얼마에 쓰는지 다시 모르게 된다).
  if (!model) throw new Error('MODEL_NOT_SET: 쓸 모델을 아직 안 골랐어요. 설정에서 모델을 골라주세요.');
  const endpoint = _endpointFrom(opts.baseURL); // OpenAI 호환 제공자(OpenRouter·Grok·DeepSeek 등) 지원

  // ★호환 제공자(OpenRouter·DeepSeek·Grok·Mistral·Groq 등)는 **OpenAI 확장 규격을 다 따르지 않는다.**
  //   baseURL 이 있으면 = 순정 OpenAI 가 아니다 → 보수적으로 **공통분모만** 보낸다.
  const 호환 = !!(opts.baseURL && String(opts.baseURL).trim());

  const messages = [];
  if (systemPrompt && systemPrompt.trim()) messages.push({ role: 'system', content: systemPrompt });
  messages.push({ role: 'user', content: _userContent(userPrompt, opts.attachments, 호환) });

  const base = { model, messages };
  // ★출력 상한 파라미터는 이름이 제공자마다 다르고 **서로 배타적**이다(실측).
  //     OpenAI 신모델 : max_tokens 를 보내면 400 "Use 'max_completion_tokens' instead"
  //     호환 제공자 다수: max_completion_tokens 를 모른다(DeepSeek 문서는 max_tokens)
  //   어느 쪽을 고정해도 반대편에서 깨진다 → **일단 보내고, 그 오류가 오면 이름을 바꿔 한 번 더 시도**한다.
  //   (오늘 "모델이 죽으면 자동으로 갈아탄다"와 같은 발상 — 우리가 규격을 외워두면 낡는다.)
  if (opts.maxTokens) {
    if (호환) base.max_tokens = opts.maxTokens;
    else base.max_completion_tokens = opts.maxTokens;
  }

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
  // ★도구를 부르면서 같이 보낸 말을 버리지 않는다 — 버리면 마지막 라운드가 빌 수 있다(gemini 실측).
  let 라운드말 = '';
  for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
    // 매 라운드 재구성 — install_mcp가 같은 턴에 새 도구를 extraDecls에 밀어넣으면 즉시 보이게.
    const tools = [...localTools.DECLS, ...extraDecls].map(_toOpenaiTool);
    let msg, why = null;
    if (opts.onDelta) {
      msg = await _postStream(key, { ...base, messages, tools }, opts.timeout || 120000, opts.onDelta, endpoint, opts.signal);
    } else {
      const data = await _post(key, { ...base, messages, tools }, opts.timeout || 120000, endpoint, opts.signal);
      const ch = data.choices && data.choices[0];
      msg = ch && ch.message; why = ch && ch.finish_reason;
    }
    if (!msg) throw new Error('OpenAI 응답 비어있음');
    const calls = msg.tool_calls || [];
    if (calls.length === 0) {
      const text = (msg.content || '').trim();
      if (text) return text;
      if (라운드말) return 라운드말;   // 도구를 부르며 이미 답을 말해 뒀다(gemini 쪽 같은 자리의 실측 참고)
      // ★빈 응답 — 이유를 버리지 않는다(gemini 쪽 같은 자리의 주석 참고).
      //   "다시 한번 말씀해 주시겠어요?"로 덮으면 사용자는 자기 탓인 줄 알고 같은 말을 되풀이한다.
      throw new Error(`OpenAI 텍스트 없음 (finish_reason=${why || '?'}, round=${round + 1})`);
    }
    { const t = (msg.content || '').trim(); if (t && !라운드말.includes(t)) 라운드말 = 라운드말 ? `${라운드말}\n${t}` : t; }
    messages.push(msg); // 모델의 tool_calls 턴 에코
    // 한 라운드에 "꺼내기"와 "쓰기"가 같이 오면, 설명을 못 본 채 인자를 지어낸다 → 막고 다시 부르게 한다.
    const 라운드가드 = toolDecls.newRoundGuard();
    for (const call of calls) {
      let args = {};
      try { args = JSON.parse(call.function.arguments || '{}'); } catch (_) {}
      let result;
      if (라운드가드.blocked(call.function.name)) {
        result = 라운드가드.message(call.function.name);
        console.log(`[brain-openai:tool] ${call.function.name} — 방금 꺼낸 도구라 이번 라운드에선 실행하지 않음`);
        messages.push({ role: 'tool', tool_call_id: call.id, content: JSON.stringify(result) });
        continue;
      }
      try {
        if (extraExecute) {
          const r = await extraExecute(call.function.name, args);
          result = (r === null || r === undefined) ? await localTools.execute(call.function.name, args) : r;
        } else {
          result = await localTools.execute(call.function.name, args);
        }
      } catch (e) { result = { error: String(e.message || e) }; }
      라운드가드.note(call.function.name, result);   // load_tools 로 꺼낸 것들을 이번 라운드 동안 잠근다
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
  listModels,
};
