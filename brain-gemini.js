/**
 * brain-gemini.js — "Gemini API" 두뇌 커넥터
 *
 * Google Generative Language REST API(generateContent)를 직접 호출한다.
 * - 순수 API라서 내장 도구가 없음 → claude CLI 같은 도구 누수 위험 없음.
 * - API 키: 환경변수 GEMINI_API_KEY 우선, 없으면 같은 폴더 `gemini-api-key` 파일.
 * - 모델: env GEMINI_MODEL > 파일 `gemini-model`. **기본값 없음** — 사용자가 목록에서 고른다.
 *
 * 인터페이스는 brain-claude의 generate 계열과 동일 시그니처:
 *   geminiGenerate(systemPrompt, userPrompt, opts) -> Promise<string>
 * → 기억 작업(추출·요약·정리)을 두뇌-무관하게 갈아끼울 수 있다.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const localTools = require('./tools'); // keyless 로컬 도구(시간·계산·fetch)
// L2: 대용량 도구출력 요약 헬퍼 (brain-claude에서 공유)
const { summarizeToolResult } = require('./brain-claude');
const toolDecls = require('./tool-decls');   // 라운드 가드(꺼내기와 쓰기 분리)

const GEMINI_ENDPOINT = 'https://generativelanguage.googleapis.com/v1beta/models';
// ★기본 모델을 두지 않는다 — 상세 근거는 brain-openai.js 같은 자리에.
//   요지: 기본값은 언젠가 반드시 죽고(OpenAI 에서 실제로 겪음), 별칭은 안 죽는 대신 뭘 얼마에 쓰는지 감춘다.
//   → 사용자가 목록에서 직접 고른다. 못 고르면 진행을 막는다.
const MODELS_ENDPOINT = 'https://generativelanguage.googleapis.com/v1beta/models';
const MAX_TOOL_ROUNDS = 10; // function-calling 최대 왕복(무한루프 방지). 다단계 검색(어제/오늘 비교 등)이 6회를 넘겨 미완성되던 문제로 상향.

// 'web' 도구 = 제공자 네이티브 검색/URL읽기를 함수로 감싼 것
// (Gemini는 내장도구와 함수호출을 한 요청에 못 섞으므로, web 핸들러가 별도 네이티브 호출을 함)
const WEB_DECL = {
  name: 'web',
  description: '인터넷 검색 또는 특정 URL 페이지 읽기. 최신 정보·실시간 정보·뉴스·링크 내용이 필요할 때. request에 검색어나 URL 또는 자연어 요청을 넣어.',
  parameters: {
    type: 'object',
    properties: { request: { type: 'string', description: '예: "오늘 서울 환율" 또는 "https://example.com 요약"' } },
    required: ['request'],
  },
};

function _readFile(name) {
  try {
    const p = path.join(__dirname, name);
    if (fs.existsSync(p)) return fs.readFileSync(p, 'utf8').trim();
  } catch (_) {}
  return '';
}

/** API 키: env > 파일 */
function getApiKey() {
  if (process.env.GEMINI_API_KEY && process.env.GEMINI_API_KEY.trim()) {
    return process.env.GEMINI_API_KEY.trim();
  }
  return _readFile('gemini-api-key');
}

/** 모델명: env > 파일. **기본값 없음** — 못 찾으면 빈 문자열(호출부가 막는다). */
function getModel() {
  if (process.env.GEMINI_MODEL && process.env.GEMINI_MODEL.trim()) return process.env.GEMINI_MODEL.trim();
  return _readFile('gemini-model') || '';
}

/**
 * 이 키로 지금 쓸 수 있는 **대화용** 모델 목록. 반환 형식은 세 두뇌 공통 — [{ id, label, hint }].
 *
 * ⚠️ `supportedGenerationMethods` 만으로는 부족하다. 처음엔 "회사가 준 사실이니 정확하다"고 봤는데
 *    실측하니 **`Gemini 2.5 Flash Preview TTS`(음성 합성)가 통과했다** — TTS·이미지 모델도
 *    generateContent 를 지원한다. 그래서 이름 규칙 제외를 함께 쓴다(OpenAI 와 같은 한계, 알고 쓴다).
 *    걸러내는 쪽만 지정하고 나머지는 통과시켜, 새 모델이 나와도 목록에서 사라지지 않게 한다.
 */
async function listModels(apiKey) {
  const key = apiKey || getApiKey();
  if (!key) throw new Error('GEMINI_API_KEY 없음');
  const res = await fetch(`${MODELS_ENDPOINT}?key=${encodeURIComponent(key)}&pageSize=200`);
  if (!res.ok) throw new Error(`모델 목록 조회 실패 (HTTP ${res.status})`);
  const json = await res.json();
  // 명백히 대화용이 아닌 것만 뺀다. **완전히는 못 거른다** — 규칙을 늘릴수록 새 모델을 놓친다.
  //   남는 것(예: Deep Research·Computer Use)은 사용자가 고를 수도 있으니 두고,
  //   잘못 고른 경우는 호출 실패 메시지로 안내한다.
  const 제외 = /tts|image|imagen|embedding|aqa|veo|audio|live-|lyria|banana|robotics/i;
  return (json.models || [])
    .filter((m) => m && Array.isArray(m.supportedGenerationMethods) && m.supportedGenerationMethods.includes('generateContent'))
    .map((m) => {
      const id = String(m.name || '').replace(/^models\//, '');
      const 만 = m.inputTokenLimit ? `${Math.round(m.inputTokenLimit / 10000) / 100}M 담김` : '';
      return { id, label: m.displayName || id, hint: 만 };
    })
    .filter((m) => !제외.test(m.id) && !제외.test(m.label));
}


/**
 * Gemini generateContent 호출. 텍스트를 반환. 실패 시 throw.
 * @param {string} systemPrompt  시스템 지시(1층). 비면 생략.
 * @param {string} userPrompt    사용자 프롬프트(요약+최근대화+현재메시지)
 * @param {Object} opts  { apiKey, model, temperature, timeout }
 */
/** 저수준 generateContent POST. 첫 candidate 반환. 실패 시 throw. */
async function _post(key, model, body, timeoutMs, extSignal) {
  const url = `${GEMINI_ENDPOINT}/${encodeURIComponent(model)}:generateContent`;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs || 60000);
  let res;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key },
      body: JSON.stringify(body),
      signal: extSignal ? AbortSignal.any([ctrl.signal, extSignal]) : ctrl.signal, // 정지: 외부 취소 신호 결합
    });
  } finally { clearTimeout(timer); }
  if (!res.ok) {
    const errText = await res.text().catch(() => '');
    throw new Error(`Gemini API ${res.status}: ${errText.slice(0, 300)}`);
  }
  const data = await res.json();
  const cand = data && data.candidates && data.candidates[0];
  if (!cand) {
    const fb = data && data.promptFeedback ? JSON.stringify(data.promptFeedback) : '응답 없음';
    throw new Error(`Gemini 응답 비어있음: ${fb}`);
  }
  return cand;
}

/** 저수준 streamGenerateContent(SSE). 텍스트 청크를 onDelta로 흘리고, 합성 candidate 반환. */
async function _postStream(key, model, body, timeoutMs, onDelta, extSignal) {
  const url = `${GEMINI_ENDPOINT}/${encodeURIComponent(model)}:streamGenerateContent?alt=sse`;
  const ctrl = new AbortController();
  // '무응답(idle)' 타임아웃 — 청크가 흐르는 동안엔 안 끊는다(무거운/긴 생성 중간절단 방지). 전 두뇌 동일 원리.
  const IDLE_MS = timeoutMs || 120000;
  let timer = null;
  const armIdle = () => { clearTimeout(timer); timer = setTimeout(() => ctrl.abort(), IDLE_MS); };
  armIdle();
  let res;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key },
      body: JSON.stringify(body),
      signal: extSignal ? AbortSignal.any([ctrl.signal, extSignal]) : ctrl.signal, // 정지: 외부 취소 신호 결합
    });
  } catch (e) { clearTimeout(timer); throw e; }
  if (!res.ok) {
    clearTimeout(timer);
    const errText = await res.text().catch(() => '');
    throw new Error(`Gemini API ${res.status}: ${errText.slice(0, 300)}`);
  }
  const dec = new TextDecoder();
  let buf = '', fullText = '', gm = null, finishReason = null;
  const calls = [];
  try {
    for await (const chunk of res.body) {
      armIdle(); // 출력 오면 리셋
      buf += dec.decode(chunk, { stream: true });
      let idx;
      while ((idx = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, idx).trim(); buf = buf.slice(idx + 1);
        if (!line.startsWith('data:')) continue;
        const js = line.slice(5).trim();
        if (!js || js === '[DONE]') continue;
        let obj; try { obj = JSON.parse(js); } catch (_) { continue; }
        const cand = obj.candidates && obj.candidates[0];
        if (!cand) continue;
        if (cand.finishReason) finishReason = cand.finishReason;
        if (cand.groundingMetadata) gm = cand.groundingMetadata;
        const parts = (cand.content && cand.content.parts) || [];
        for (const p of parts) {
          if (p.text) { fullText += p.text; if (onDelta) onDelta(p.text); }
          // functionCall part 전체를 보존 — thinking 모델(gemini-3.5+)은 thoughtSignature가 붙어 오고,
          // 다음 요청에 그대로 되돌려주지 않으면 400(missing thought_signature). part 째로 보관해 유지한다.
          if (p.functionCall) calls.push(p);
        }
      }
    }
  } finally { clearTimeout(timer); }
  const outParts = [];
  if (fullText) outParts.push({ text: fullText });
  for (const p of calls) outParts.push(p); // functionCall part 그대로(thoughtSignature 포함) 재조립
  return { content: { parts: outParts }, groundingMetadata: gm, finishReason };
}

/** candidate에서 텍스트 추출(중복 part 방어). */
function _text(cand) {
  const parts = (cand.content && cand.content.parts) || [];
  const tp = parts.map(p => (p.text || '').trim()).filter(Boolean);
  return tp.filter((t, i) => tp.indexOf(t) === i).join('\n').trim();
}

/** userPrompt + 첨부 → parts 배열 */
function _userParts(userPrompt, attachments) {
  const parts = [{ text: userPrompt }];
  if (Array.isArray(attachments)) {
    for (const a of attachments) {
      if (a && a.mimeType && a.data) parts.push({ inline_data: { mime_type: a.mimeType, data: a.data } });
    }
  }
  return parts;
}

/** 'web' 도구 실행: 네이티브 검색/URL읽기 별도 호출(함수호출과 못 섞이므로 분리). */
async function _webNative(request, key, model, extSignal) {
  const body = {
    contents: [{ role: 'user', parts: [{ text: String(request || '') }] }],
    generationConfig: { temperature: 0.2 },
    tools: [{ google_search: {} }, { url_context: {} }],
  };
  // 검색이 일시적으로 503/529(과부하)를 뱉으면 짧게 1회 재시도 — 라운드 낭비·미완성 폴백 방지.
  let cand;
  for (let attempt = 0; ; attempt++) {
    try { cand = await _post(key, model, body, 90000, extSignal); break; }
    catch (e) {
      if (attempt < 1 && /\b(503|529)\b|UNAVAILABLE|overloaded|high demand/i.test(String((e && e.message) || e))) {
        await new Promise(r => setTimeout(r, 800));
        continue;
      }
      throw e;
    }
  }
  let text = _text(cand);
  // 출처(title+uri) 수집 — ④ 근거보관/②검증용. 중복 title 제거, 최대 5.
  const sources = [];
  const gm = cand.groundingMetadata;
  if (gm && Array.isArray(gm.groundingChunks)) {
    const seen = new Set();
    for (const c of gm.groundingChunks) {
      const w = c && c.web;
      if (!w || !w.title || seen.has(w.title)) continue;
      seen.add(w.title);
      sources.push({ title: w.title, uri: w.uri || '' });
      if (sources.length >= 5) break;
    }
    // ③ 상시 출처표시 제거 — 출처는 sources 로만 반환(engine 이 ④ 근거보관에 사용). 답변 텍스트엔 안 붙임.
  }
  return { text: text || '(검색 결과 없음)', sources };
}

/**
 * Gemini 응답 생성. 모드:
 *  - opts.tools=true → function calling 루프(시간·계산·fetch + web). 키리스 도구 통합.
 *  - opts.webSearch=true → 네이티브 검색/URL(함수 없이).
 *  - 기본 → 단순 생성.
 * @param {Object} opts { apiKey, model, temperature, timeout, attachments, tools, webSearch }
 */
async function geminiGenerate(systemPrompt, userPrompt, opts = {}) {
  const key = opts.apiKey || getApiKey();
  if (!key) throw new Error('GEMINI_API_KEY 없음 (env GEMINI_API_KEY 또는 gemini-api-key 파일에 넣어주세요)');
  const model = opts.model || getModel();
  // ★기본값이 없다 — 안 고르고 온 건 설정이 덜 된 것이다(근거는 brain-openai.js 같은 자리).
  if (!model) throw new Error('MODEL_NOT_SET: 쓸 모델을 아직 안 골랐어요. 설정에서 모델을 골라주세요.');
  const sysPart = (systemPrompt && systemPrompt.trim()) ? { system_instruction: { parts: [{ text: systemPrompt }] } } : {};
  const genCfg = { temperature: opts.temperature != null ? opts.temperature : 0.7 };

  // ── function-calling 루프 모드 ─────────────────────────────
  if (opts.tools) {
    // 기본 도구 + (선택)외부 주입 도구(use_skill 등). extraExecute(name,args)->result|null
    const extraDecls = Array.isArray(opts.extraDecls) ? opts.extraDecls : [];
    const extraExecute = typeof opts.extraExecute === 'function' ? opts.extraExecute : null;
    const contents = [{ role: 'user', parts: _userParts(userPrompt, opts.attachments) }];
    let usedWeb = false;
    // ★도구를 부르면서 **같이 보낸 말**을 버리지 않는다.
    //   gemini 는 [답변 + functionCall]을 한 번에 보낸다. 그 말이 곧 최종 답인 경우가 많다.
    //   예전엔 functionCall 만 집고 텍스트를 버린 뒤 다음 라운드에 다시 물었는데,
    //   모델은 **이미 말했다고 여겨** 빈 응답(parts:[] · finishReason=STOP)을 돌려줬다.
    //   실측(2026-08-14): 1라운드 text="기억해둘게요, 사장님…"(49토큰) → 버림 → 2라운드 parts 0개.
    //   사용자에겐 답이 안 가고, 5만 토큰짜리 요청만 한 번 더 나갔다.
    let 라운드말 = '';
    for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
      // 매 라운드 재구성 — install_mcp가 같은 턴에 새 도구를 extraDecls에 밀어넣으면 즉시 보이게.
      const decls = [...localTools.DECLS, WEB_DECL, ...extraDecls];
      const reqBody = { contents, generationConfig: genCfg, ...sysPart, tools: [{ function_declarations: decls }] };
      // 스트리밍: onDelta 있으면 토큰을 흘리며 받음(함수호출 라운드의 preface도 실시간 표시).
      const cand = opts.onDelta
        ? await _postStream(key, model, reqBody, opts.timeout || 120000, opts.onDelta, opts.signal)
        : await _post(key, model, reqBody, opts.timeout || 120000, opts.signal);
      const parts = (cand.content && cand.content.parts) || [];
      const calls = parts.map(p => p.functionCall).filter(Boolean);
      if (calls.length === 0) {
        const text = _text(cand);
        if (text) return text;   // (출처는 web 결과 텍스트에 이미 포함)
        if (라운드말) return 라운드말;   // 도구를 부르며 이미 답을 말해 뒀다 — 그게 사용자에게 갈 말이다
        // ★빈 응답 — **왜 비었는지 버리지 않는다.**
        //   예전엔 여기서 "다시 한번 말씀해 주시겠어요?"로 덮었다. 그러면 사용자는 자기가 잘못 말한 줄 알고
        //   같은 말을 다시 하고, 우리는 원인을 영영 못 본다(실측 2026-08-14: 도구는 정상 호출됐는데 답만 비었다).
        //   같은 파일 비도구 경로(_post 뒤)는 이미 finishReason 을 담아 던지고 있었다 — 두 경로가 어긋나 있었다.
        throw new Error(`Gemini 텍스트 없음 (finishReason=${cand.finishReason || '?'}, round=${round + 1})`);
      }
      { const t = _text(cand); if (t && !라운드말.includes(t)) 라운드말 = 라운드말 ? `${라운드말}\n${t}` : t; }
      contents.push(cand.content); // 모델의 함수호출 턴
      const respParts = [];
      // 한 라운드에 "꺼내기"와 "쓰기"가 같이 오면, 설명을 못 본 채 인자를 지어낸다 → 막고 다시 부르게 한다.
      const 라운드가드 = toolDecls.newRoundGuard();
      for (const call of calls) {
        let result;
        if (라운드가드.blocked(call.name)) {
          result = 라운드가드.message(call.name);
          console.log(`[brain-gemini:tool] ${call.name} — 방금 꺼낸 도구라 이번 라운드에선 실행하지 않음`);
          respParts.push({ functionResponse: { name: call.name, response: { result } } });
          continue;
        }
        try {
          if (call.name === 'web') {
            usedWeb = true;
            const q = (call.args || {}).request || '';
            const w = await _webNative(q, key, model, opts.signal);
            // ④/② 토대: 이번 턴 검색 근거(결과+출처)를 sink 로 engine 에 넘김.
            if (Array.isArray(opts.evidenceSink)) opts.evidenceSink.push({ query: String(q), text: w.text, sources: w.sources || [] });
            result = { text: w.text };
          }
          else if (extraExecute) {
            const r = await extraExecute(call.name, call.args || {});
            result = (r === null || r === undefined) ? await localTools.execute(call.name, call.args || {}) : r;
          }
          else { result = await localTools.execute(call.name, call.args || {}); }
        } catch (e) { result = { error: String(e.message || e) }; }
        라운드가드.note(call.name, result);   // load_tools 로 꺼낸 것들을 이번 라운드 동안 잠근다
        console.log(`[brain-gemini:tool] ${call.name}(${JSON.stringify(call.args || {})}) → ` + (typeof result === 'string' ? result : JSON.stringify(result)).slice(0, 400));
        // L2: 대용량 도구출력 요약 — TOOL_RESULT_MAX 초과 시만 LLM 요약 (작은 결과는 비용 0)
        const rawContent = typeof result === 'string' ? result : JSON.stringify(result);
        const goalHint = opts.goal || '';
        const summaryFn = (sys, usr, sopts = {}) => geminiGenerate(sys, usr, { ...sopts, apiKey: key, model });
        const summarized = await summarizeToolResult(rawContent, summaryFn, { toolName: call.name, goal: goalHint });
        // Gemini functionResponse는 result 객체를 받음: 요약된 텍스트를 result.text로 넣음
        const resultObj = rawContent !== summarized ? { text: summarized } : result;
        respParts.push({ functionResponse: { name: call.name, response: { result: resultObj } } });
      }
      contents.push({ role: 'user', parts: respParts });
    }
    // 라운드 소진 → 도구 없이 마지막 정리 답변
    const cand = await _post(key, model, { contents, generationConfig: genCfg, ...sysPart }, 60000, opts.signal);
    return _text(cand) || '(요청을 끝까지 처리하지 못했어요. 다시 시도해 주실래요?)';
  }

  // ── 단순/네이티브 모드 ─────────────────────────────────────
  const body = { contents: [{ role: 'user', parts: _userParts(userPrompt, opts.attachments) }], generationConfig: genCfg, ...sysPart };
  if (opts.webSearch) body.tools = [{ google_search: {} }, { url_context: {} }];
  const cand = opts.onDelta
    ? await _postStream(key, model, body, opts.timeout || 60000, opts.onDelta, opts.signal)
    : await _post(key, model, body, opts.timeout || 60000, opts.signal);
  const text = _text(cand);
  if (!text) throw new Error(`Gemini 텍스트 없음 (finishReason=${cand.finishReason || '?'})`);
  // ③ 출처를 상시 표시하지 않는다 — 단발 검색 모드도 출처를 답변에 붙이지 않는다.
  return text;
}

/**
 * 대화 응답용 래퍼. 실패해도 사용자향 부드러운 문구 반환(앱이 죽지 않게).
 */
async function askGemini(systemPrompt, userPrompt, opts = {}) {
  try {
    return await geminiGenerate(systemPrompt, userPrompt, opts);
  } catch (e) {
    console.error('[brain-gemini] 오류:', e.message);
    return '지금 생각을 정리하는 데 시간이 좀 걸리고 있어요. 잠시 후 다시 말을 걸어주실래요?';
  }
}

module.exports = {
  geminiGenerate,
  askGemini,
  getApiKey,
  getModel,
  listModels,
};
