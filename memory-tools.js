/**
 * memory-tools.js — Auxo 기억 도구(remember/forget)의 순수 로직 (공유)
 *
 * engine(REST 두뇌의 extraExecute) 과 auxo-mcp-tools(claude 구독용 MCP 서버)가
 * 같은 구현을 쓰도록 추출. storage 는 호출 측이 init 해둔 상태를 사용.
 */
'use strict';
const storage = require('./storage');
const brainClaude = require('./brain-claude');

const FORGET_STOP = new Set(['기억', '내', '나', '그거', '그건', '그것', '방금', '관련', '부분', '정보', '것', '거', '얘기', '이야기']);

/** 사용자에 관한 사실을 장기 기억에 저장. */
function rememberFact(agentId, { label, value, importance } = {}) {
  label = String(label || '').trim();
  value = String(value || '').trim();
  if (!label || !value) return { error: 'label과 value가 필요해' };
  const imp = Math.max(1, Math.min(3, Number(importance) || 1));
  const fresh = storage.loadAgent(agentId);
  if (!fresh) return { error: '저장 실패(에이전트 없음)' };
  brainClaude.ensureMemoryShape(fresh.humanFacts || []);
  const fact = { label, value, importance: imp, ts: new Date().toISOString(), source: 'remember' };
  const activeId = fresh.work && fresh.work.activeId;
  if (activeId) { const wt = activeId.startsWith('rt-') ? 'routine' : 'project'; fact.scope = `${wt}:${activeId}`; }
  const { merged, added, updated, mergedCount } = brainClaude.integrateMemory(fresh.humanFacts || [], [fact], {});
  if (added || updated || mergedCount) {
    brainClaude.ensureMemoryShape(merged);
    fresh.humanFacts = merged;
    storage.saveAgent(fresh);
    return { saved: true, humanFacts: merged, message: `'${label}' 기억함. 다시 저장하지 마.` };
  }
  return { saved: false, message: '이미 알고 있는 내용이야.' };
}

/** 사용자가 명시적으로 요청한 기억을 삭제. */
function forgetFact(agentId, { query } = {}) {
  query = String(query || '').trim();
  if (!query) return { error: '무엇을 잊을지 알려줘' };
  const fresh = storage.loadAgent(agentId);
  if (!fresh) return { error: '저장 실패(에이전트 없음)' };
  const facts = fresh.humanFacts || [];
  const q = query.toLowerCase().trim();
  const qWords = q.split(/[\s,.]+/).filter(w => w.length >= 2 && !FORGET_STOP.has(w));
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
  fresh.humanFacts = kept;
  storage.saveAgent(fresh);
  return { forgotten: true, count: matches.length, humanFacts: kept, items: matches.map(m => `${m.label}: ${m.value}`), message: `${matches.length}개 기억을 지웠어: ${matches.map(m => m.label).join(', ')}` };
}

/** function-calling decl (REST 두뇌·MCP 공용) */
const DECLS = [
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

module.exports = { rememberFact, forgetFact, DECLS };
