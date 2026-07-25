/**
 * brain-gemini.js — "Gemini API" 두뇌 커넥터
 *
 * Google Generative Language REST API(generateContent)를 직접 호출한다.
 * - 순수 API라서 내장 도구가 없음 → claude CLI 같은 도구 누수 위험 없음.
 * - API 키: 환경변수 GEMINI_API_KEY 우선, 없으면 같은 폴더 `gemini-api-key` 파일.
 * - 모델: env GEMINI_MODEL > 파일 `gemini-model` > DEFAULT_MODEL.
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

const GEMINI_ENDPOINT = 'https://generativelanguage.googleapis.com/v1beta/models';
const DEFAULT_MODEL = 'gemini-flash-latest'; // 자동 최신 flash 별칭(노후화 재발 방지). 사용자가 특정 모델 지정 시 그게 우선.
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

/** 모델명: env > 파일 > 기본 */
function getModel() {
  if (process.env.GEMINI_MODEL && process.env.GEMINI_MODEL.trim()) return process.env.GEMINI_MODEL.trim();
  return _readFile('gemini-model') || DEFAULT_MODEL;
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
  const sysPart = (systemPrompt && systemPrompt.trim()) ? { system_instruction: { parts: [{ text: systemPrompt }] } } : {};
  const genCfg = { temperature: opts.temperature != null ? opts.temperature : 0.7 };

  // ── function-calling 루프 모드 ─────────────────────────────
  if (opts.tools) {
    // 기본 도구 + (선택)외부 주입 도구(use_skill 등). extraExecute(name,args)->result|null
    const extraDecls = Array.isArray(opts.extraDecls) ? opts.extraDecls : [];
    const extraExecute = typeof opts.extraExecute === 'function' ? opts.extraExecute : null;
    const contents = [{ role: 'user', parts: _userParts(userPrompt, opts.attachments) }];
    let usedWeb = false;
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
        const text = _text(cand) || '음... 지금 제대로 답을 못 드리겠네요. 다시 한번 말씀해 주시겠어요?';
        return usedWeb ? text : text; // (출처는 web 결과 텍스트에 이미 포함)
      }
      contents.push(cand.content); // 모델의 함수호출 턴
      const respParts = [];
      for (const call of calls) {
        let result;
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
  // ③ 상시 출처표시 제거(마스터 결정) — 단발 검색 모드도 출처를 답변에 붙이지 않는다.
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
  DEFAULT_MODEL,
};
