/**
 * memory-export.js — 기억을 사람·다른 AI가 읽는 "마크다운 폴더"로 내보내기 (읽기·이식용).
 *
 * 설계: memory/agentlink/memory-export-design.md
 *  - 저장 방식(SQLite)은 안 건드린다. 필요할 때만 storage에서 읽어 텍스트로 생성(온디맨드).
 *  - 모든 LLM이 plain text를 읽으므로, 마크다운이 "지금 가능한 가장 이식성 높은 형태".
 *  - 제외: apiKey(보안), 임베딩(_emb·벡터 — 다른 AI엔 무용), 내부 점수필드(읽기용이라 생략).
 *  - 사적 기억(sensitive=true) 토글로 제외 가능.
 */
const fs = require('fs');
const path = require('path');

function _safeName(s) { return String(s || '').replace(/[\\/:*?"<>|\n\r]/g, '_').trim() || '기억'; }
function _fmtDate(ts) { if (!ts) return ''; try { return new Date(ts).toLocaleString('ko-KR', { timeZone: 'Asia/Seoul', dateStyle: 'medium', timeStyle: 'short' }); } catch (_) { return ''; } }
function _monthKey(ts) { if (!ts) return '날짜미상'; try { return new Date(ts).toLocaleDateString('en-CA', { timeZone: 'Asia/Seoul' }).slice(0, 7); } catch (_) { return '날짜미상'; } }

/** storage에서 그 에이전트의 기억 전부를 모은다(공통 수집). */
function gather(agentId, storage) {
  const agent = storage.loadAgent(agentId) || {};
  const active = storage.loadConversation(agentId) || [];
  const archived = storage.loadArchivedMessages(agentId) || [];
  return {
    agent,
    facts: Array.isArray(agent.humanFacts) ? agent.humanFacts : [],
    episodes: Array.isArray(agent.episodes) ? agent.episodes : [],
    summaryHistory: Array.isArray(agent.summaryHistory) ? agent.summaryHistory : [],
    work: agent.work || { projects: [], routines: [] },
    messages: archived.concat(active).filter(m => m && m.content), // 오래된(아카이브)→최근(활성) 순
    summary: storage.loadConversationSummary(agentId) || '',
  };
}

/** 수집물 → [{path, content}] (폴더 구조). opts: {includeSensitive=true} */
function toMarkdown(g, opts = {}) {
  const includeSensitive = opts.includeSensitive !== false;
  const name = g.agent.name || '내 AI';
  const nick = g.agent.userNickname || '사용자';
  const files = [];

  // ── 사실: 사용자(subject!=='reference') vs 참고(reference) ──
  const userFacts = g.facts.filter(f => f && f.subject !== 'reference');
  const refFacts = g.facts.filter(f => f && f.subject === 'reference');
  let excluded = 0;
  const shownUser = userFacts.filter(f => { if (!includeSensitive && f.sensitive === true) { excluded++; return false; } return true; });
  const factLine = f => `- **${f.label || ''}**: ${f.value || ''}` + (f.ts ? `  _(${_fmtDate(f.ts)})_` : '');

  // ── README ──
  let readme = `# ${name} — 기억\n\n`;
  readme += `> 이 폴더는 **${name}**가 당신과 쌓아온 기억을 사람이 읽을 수 있는 형태로 담은 것입니다.\n`;
  readme += `> 어떤 AI에게 보여줘도 읽을 수 있어요. 이 기억은 당신 것입니다.\n\n`;
  readme += `## 나는 누구\n- **이름**: ${name}\n`;
  if (g.agent.persona) readme += `- **성격**: ${g.agent.persona}\n`;
  readme += `- **당신을 부르는 호칭**: ${nick}\n`;
  if (g.agent.speech) readme += `- **말투**: ${g.agent.speech}\n`;
  if (g.agent.auxoMd) readme += `\n### 당신이 준 지침\n${g.agent.auxoMd}\n`;
  const rel = g.summaryHistory.slice(-1)[0] || g.summary;
  readme += `\n## 관계 요약\n${rel || '_(아직 쌓인 요약이 없어요)_'}\n\n`;
  readme += `## 이 폴더 안내\n`;
  readme += `- \`${nick}에-대해.md\` — 당신에 대해 아는 것 (${shownUser.length}개)\n`;
  if (refFacts.length) readme += `- \`참고정보.md\` — 문서·제3자에게서 알게 된 정보 (${refFacts.length}개)\n`;
  readme += `- \`함께한-일.md\` — 함께한 일 (${g.episodes.length}개)\n`;
  readme += `- \`대화/\` — 월별 전체 대화 원문\n`;
  readme += `\n---\n_내보낸 시각: ${_fmtDate(Date.now())}. 비밀번호·API키·내부 수치는 포함하지 않았습니다._\n`;
  files.push({ path: 'README.md', content: readme });

  // ── 사용자에 대해 ──
  let um = `# ${nick}에 대해\n\n`;
  um += shownUser.length ? shownUser.map(factLine).join('\n') : '_(아직 기록된 것이 없어요)_';
  if (excluded) um += `\n\n> _사적인 기억 ${excluded}개는 내보내기에서 제외했습니다._`;
  um += '\n';
  files.push({ path: `${_safeName(nick)}에-대해.md`, content: um });

  // ── 참고 정보(reference) — 사용자 사실과 구분(정체성 오염 차단 컨셉 유지) ──
  if (refFacts.length) {
    let rm = `# 참고 정보\n\n> 문서·자료·제3자에게서 알게 된 정보입니다. **${nick} 본인에 대한 사실과는 구분**합니다.\n\n`;
    rm += refFacts.map(factLine).join('\n') + '\n';
    files.push({ path: '참고정보.md', content: rm });
  }

  // ── 함께한 일(일화) — 날짜순 ──
  let em = `# 함께한 일\n\n`;
  const eps = g.episodes.slice().sort((a, b) => (a.date || 0) - (b.date || 0));
  em += eps.length ? eps.map(e => `- **${_fmtDate(e.date)}** ${e.type ? `[${e.type}] ` : ''}${e.summary || ''}` + ((e.entities && e.entities.length) ? `  _(${e.entities.join(', ')})_` : '')).join('\n') : '_(아직 없어요)_';
  em += '\n';
  files.push({ path: '함께한-일.md', content: em });

  // ── 대화 원문 — 월별 ──
  const byMonth = new Map();
  for (const m of g.messages) { const k = _monthKey(m.ts); if (!byMonth.has(k)) byMonth.set(k, []); byMonth.get(k).push(m); }
  for (const [k, msgs] of byMonth) {
    let cm = `# 대화 — ${k}\n\n`;
    for (const m of msgs) {
      const who = m.role === 'agent' ? name : nick;
      cm += `**${who}** _(${_fmtDate(m.ts)})_\n${String(m.content)}\n\n`;
    }
    files.push({ path: path.join('대화', `${k}.md`), content: cm });
  }

  return files;
}

/** 실제 폴더로 씀. destParent 아래 "<이름>-기억/" 생성. @returns {dir, fileCount} */
function exportToFolder(agentId, storage, destParent, opts = {}) {
  const g = gather(agentId, storage);
  const dir = path.join(destParent, `${_safeName(g.agent.name || '내AI')}-기억`);
  const files = toMarkdown(g, opts);
  for (const f of files) {
    const full = path.join(dir, f.path);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, f.content, 'utf8');
  }
  return { dir, fileCount: files.length };
}

module.exports = { gather, toMarkdown, exportToFolder };
