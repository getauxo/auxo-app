/**
 * web-search.js — 공통 웹검색 코어(두뇌 무관 단일 소스).
 *
 * 하이브리드 전략: 네이티브 검색 있는 두뇌(Gemini·Claude)는 커넥터가 알아서,
 * 없는 두뇌(GPT·Codex·범용)는 이 공통검색을 쓴다.
 *  - 기본: DuckDuckGo (키 없음, 품질 보통)
 *  - 업그레이드(선택): 네이버(한국)·Tavily(글로벌) — 키 있을 때. 실패 시 DuckDuckGo 폴백.
 * 외부 검색 서비스에 HTTP 요청만 보내는 "다리". 결과=[{title,url,snippet}].
 */
'use strict';
const https = require('https');

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36';

// 환각 차단: 검색 결과를 두뇌에게 줄 때 함께 전달하는 지침. 요약에 없는 수치·사실을 지어내지 않게.
const GUIDE_OK = '아래 검색 결과(제목·링크·요약)에 실제로 적힌 내용만 근거로 답해. 요약에 없는 구체 수치·사실(기온·가격·날짜 등)은 절대 지어내지 마. 정확한 값이 결과에 없으면 "정확한 ○○는 결과에 안 나와서 확실하지 않다"고 솔직히 말하고, 필요하면 링크를 안내해.';
const GUIDE_FAIL = '검색이 실패했어(결과 없음). 아는 척하지 말고, 사용자에게 "지금 검색이 잘 안 된다"고 솔직히 말해. 기온·가격 같은 실시간 수치나 최신 사실을 추측해서 답하지 마.';

function _request(urlStr, { method = 'GET', headers = {}, body = null, timeout = 12000 } = {}) {
  return new Promise((resolve, reject) => {
    let u; try { u = new URL(urlStr); } catch (e) { return reject(e); }
    const req = https.request({ hostname: u.hostname, path: u.pathname + u.search, method, headers, timeout }, res => {
      let data = ''; res.on('data', c => (data += c)); res.on('end', () => resolve({ status: res.statusCode, body: data }));
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('검색 요청 시간 초과')); });
    if (body) req.write(body);
    req.end();
  });
}

function _decode(s) { return String(s || '').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#x27;|&#39;/g, "'").replace(/&nbsp;/g, ' '); }
function _strip(s) { return _decode(String(s || '').replace(/<[^>]*>/g, '')).replace(/\s+/g, ' ').trim(); }

function _parseDDG(body, max) {
  const out = [];
  const snippets = [];
  const snipRe = /class="result__snippet"[^>]*>([\s\S]*?)<\/a>/g;
  let sm; while ((sm = snipRe.exec(body))) snippets.push(_strip(sm[1]));
  const blockRe = /<a[^>]*class="result__a"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g;
  let m, i = 0;
  while ((m = blockRe.exec(body)) && out.length < max) {
    let url = m[1];
    const uddg = url.match(/[?&]uddg=([^&]+)/);
    if (uddg) url = decodeURIComponent(uddg[1]);
    else if (url.startsWith('//')) url = 'https:' + url;
    out.push({ title: _strip(m[2]), url, snippet: snippets[i] || '' });
    i++;
  }
  return out;
}

async function searchDuckDuckGo(query, max = 5) {
  // POST 방식 + 언어 헤더 → GET보다 봇 탐지에 덜 걸려 0건 실패가 줄어든다. 비면 GET 1회 재시도.
  const headers = { 'User-Agent': UA, 'Accept': 'text/html', 'Accept-Language': 'ko,en;q=0.8', 'Content-Type': 'application/x-www-form-urlencoded' };
  let res = await _request('https://html.duckduckgo.com/html/', { method: 'POST', headers, body: 'q=' + encodeURIComponent(query) });
  if (res.status < 400) {
    const r = _parseDDG(res.body, max);
    if (r.length) return r;
  }
  // 폴백: GET 재시도
  res = await _request('https://html.duckduckgo.com/html/?q=' + encodeURIComponent(query), { headers: { 'User-Agent': UA, 'Accept': 'text/html', 'Accept-Language': 'ko,en;q=0.8' } });
  if (res.status >= 400) throw new Error('DuckDuckGo HTTP ' + res.status);
  return _parseDDG(res.body, max);
}

async function searchNaver(query, max, { clientId, clientSecret }) {
  const { status, body } = await _request('https://openapi.naver.com/v1/search/webkr.json?display=' + max + '&query=' + encodeURIComponent(query), { headers: { 'X-Naver-Client-Id': clientId, 'X-Naver-Client-Secret': clientSecret } });
  if (status >= 400) throw new Error('네이버 HTTP ' + status);
  const j = JSON.parse(body);
  return (j.items || []).slice(0, max).map(it => ({ title: _strip(it.title), url: it.link, snippet: _strip(it.description) }));
}

async function searchTavily(query, max, { apiKey }) {
  const payload = JSON.stringify({ api_key: apiKey, query, max_results: max });
  const { status, body } = await _request('https://api.tavily.com/search', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: payload });
  if (status >= 400) throw new Error('Tavily HTTP ' + status);
  const j = JSON.parse(body);
  return (j.results || []).slice(0, max).map(it => ({ title: it.title, url: it.url, snippet: it.content }));
}

/**
 * 통합 웹검색. 선택한 provider 시도 → 실패 시 DuckDuckGo 폴백.
 * @param {object} opts { provider, max, naver:{clientId,clientSecret}, tavily:{apiKey} }
 */
async function webSearch(query, opts = {}) {
  const q = String(query || '').trim();
  if (!q) return { error: '검색어가 비어 있어.' };
  const max = Math.min(Math.max(opts.max || 5, 1), 10);
  const provider = opts.provider || 'duckduckgo';
  const hasNaver = !!(opts.naver && opts.naver.clientId && opts.naver.clientSecret);
  const hasTavily = !!(opts.tavily && opts.tavily.apiKey);
  try {
    let results, used;
    if (provider === 'naver' && hasNaver) { results = await searchNaver(q, max, opts.naver); used = 'naver'; }
    else if (provider === 'tavily' && hasTavily) { results = await searchTavily(q, max, opts.tavily); used = 'tavily'; }
    else { results = await searchDuckDuckGo(q, max); used = 'duckduckgo'; }
    if (!results || !results.length) throw new Error('결과 없음');
    return { provider: used, query: q, results, guidance: GUIDE_OK };
  } catch (e) {
    if (provider !== 'duckduckgo') {
      try { const r = await searchDuckDuckGo(q, max); if (r && r.length) return { provider: 'duckduckgo(폴백)', query: q, results: r, note: `${provider} 실패로 폴백: ${e.message}`, guidance: GUIDE_OK }; }
      catch (_) {}
    }
    return { error: '검색 실패: ' + e.message, guidance: GUIDE_FAIL };
  }
}

module.exports = { webSearch, searchDuckDuckGo, searchNaver, searchTavily };
