/**
 * tools.js — Auxo 에이전트용 keyless 로컬 도구 레지스트리
 *
 * 외부 API 키 없이 도는 도구들. LLM이 function calling으로 호출하면
 * 앱이 로컬에서 실행해 결과를 돌려준다. (실행은 우리가 통제 → 누수 차단)
 *
 * 각 도구: 선언(LLM에 알려줄 스키마) + 실행기.
 * (web 검색/URL읽기는 제공자 네이티브라 brain-gemini에서 별도 주입)
 */
'use strict';

// ── 1) 현재 시각 ──────────────────────────────────────────────
function getCurrentTime() {
  const now = new Date();
  let kst;
  try {
    kst = new Intl.DateTimeFormat('ko-KR', {
      timeZone: 'Asia/Seoul', dateStyle: 'full', timeStyle: 'short',
    }).format(now);
  } catch (_) { kst = now.toString(); }
  return { iso: now.toISOString(), korea_time: kst };
}

// ── 2) 계산기 (안전한 산술만) ─────────────────────────────────
function calculate(expression) {
  const expr = String(expression || '').trim();
  if (!expr) return { error: '식이 비어 있음' };
  // 숫자·연산자·괄호·소수점·퍼센트·공백만 허용 (코드 실행 차단)
  if (!/^[0-9+\-*/().%\s]+$/.test(expr)) {
    return { error: '허용되지 않은 문자 (숫자와 + - * / ( ) . % 만 가능)' };
  }
  if (expr.length > 200) return { error: '식이 너무 김' };
  try {
    // % 를 /100 로 치환하지 않고 단순 산술만; eval 대신 Function + 엄격 화이트리스트
    // eslint-disable-next-line no-new-func
    const val = Function('"use strict"; return (' + expr.replace(/%/g, '/100') + ')')();
    if (typeof val !== 'number' || !Number.isFinite(val)) return { error: '계산 결과가 숫자가 아님' };
    return { expression: expr, result: val };
  } catch (e) {
    return { error: '계산 실패: ' + e.message };
  }
}

// ── 3) 범용 fetch (HTTP GET, 키 없음) ─────────────────────────
async function fetchUrl(url, maxChars = 6000) {
  const u = String(url || '').trim();
  if (!/^https?:\/\//i.test(u)) return { error: 'http(s) URL만 가능' };
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 20000);
  try {
    const res = await fetch(u, { signal: ctrl.signal, headers: { 'User-Agent': 'Auxo/0.1' } });
    const ct = res.headers.get('content-type') || '';
    let body = await res.text();
    // HTML이면 태그 대충 제거(가독성)
    if (/html/i.test(ct)) {
      body = body.replace(/<script[\s\S]*?<\/script>/gi, ' ')
                 .replace(/<style[\s\S]*?<\/style>/gi, ' ')
                 .replace(/<[^>]+>/g, ' ')
                 .replace(/\s+/g, ' ').trim();
    }
    const truncated = body.length > maxChars;
    return { status: res.status, contentType: ct, truncated, content: body.slice(0, maxChars) };
  } catch (e) {
    return { error: 'fetch 실패: ' + e.message };
  } finally {
    clearTimeout(timer);
  }
}

// ── 선언 (Gemini function_declarations 형식) ──────────────────
const DECLS = [
  {
    name: 'get_current_time',
    description: '현재 날짜와 시각을 반환한다. "지금 몇 시", "오늘 며칠" 등 현재 시점이 필요할 때 사용.',
    parameters: { type: 'object', properties: {} },
  },
  {
    name: 'calculator',
    description: '정확한 산술 계산. 사칙연산·괄호·퍼센트(%) 지원. 숫자 계산이 필요하면 추측하지 말고 이 도구를 써.',
    parameters: {
      type: 'object',
      properties: { expression: { type: 'string', description: '예: "1250000 * 13.5%" 또는 "(3+4)*2"' } },
      required: ['expression'],
    },
  },
  {
    name: 'fetch_url',
    description: '주어진 URL(웹페이지/API)을 직접 GET 요청으로 가져와 내용을 반환. 원본 데이터·API·RSS 등 특정 주소의 내용이 필요할 때.',
    parameters: {
      type: 'object',
      properties: { url: { type: 'string', description: 'http(s) 주소' } },
      required: ['url'],
    },
  },
];

/** 도구 실행 디스패치. 결과 객체 반환(실패해도 {error} 로). */
async function execute(name, args = {}) {
  switch (name) {
    case 'get_current_time': return getCurrentTime();
    case 'calculator':       return calculate(args.expression);
    case 'fetch_url':        return await fetchUrl(args.url);
    default:                 return { error: '알 수 없는 도구: ' + name };
  }
}

module.exports = { DECLS, execute, getCurrentTime, calculate, fetchUrl };
