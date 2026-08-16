/**
 * memory-export.js — 기억을 사람·다른 AI가 읽는 "마크다운 폴더"로 내보내기 (읽기·이식용).
 *
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
// 그릇을 통짜 글로 꺼낸다. 옛 낱개(humanFacts)가 남아 있으면 여기서 글로 풀어 준다(원본 불변).
function _grabMemory(agent) {
  const um = require('./user-memory');
  const snap = { userMemory: agent.userMemory || '', refMemory: agent.refMemory || '', humanFacts: agent.humanFacts || [] };
  um.absorbLegacyFacts(snap);
  return { userMemory: snap.userMemory, refMemory: snap.refMemory };
}
function _lines(t) { return require('./user-memory').toLines(t); }

function gather(agentId, storage) {
  const agent = storage.loadAgent(agentId) || {};
  const active = storage.loadConversation(agentId) || [];
  const archived = storage.loadArchivedMessages(agentId) || [];
  return {
    agent,
    // 기억 그릇(통짜 글). 옛 낱개 데이터가 남아 있으면 글로 풀어 담는다(유실 방지).
    ..._grabMemory(agent),
    episodes: Array.isArray(agent.episodes) ? agent.episodes : [],
    summaryHistory: Array.isArray(agent.summaryHistory) ? agent.summaryHistory : [],
    work: agent.work || { projects: [], routines: [] },
    messages: archived.concat(active).filter(m => m && m.content), // 오래된(아카이브)→최근(활성) 순
    summary: storage.loadConversationSummary(agentId) || '',
  };
}

/**
 * 수집물 → [{path, content}] (폴더 구조).
 *
 * '사적인 기억 빼기' 옵션은 두지 않는다. 지킬 수 없는 약속이기 때문이다 —
 *   건강 정보는 추출 규칙상 sensitive=false 로 강제돼 애초에 걸러지지 않고(실측: '당뇨'가
 *   그대로 남음), 대화 원문은 아예 필터를 타지 않는다. "빼줬다"는 화면만 보고 남에게 보내면
 *   그게 더 위험하다. 지금은 전부 담고, 무엇이 담기는지 화면에서 알린다.
 */
function toMarkdown(g, opts = {}) {
  const name = g.agent.name || '내 AI';
  const nick = g.agent.userNickname || '사용자';
  const files = [];

  // ── 사실: 사용자(subject!=='reference') vs 참고(reference) ──
  // 통짜 그릇: 낱개 목록이 아니라 글 한 덩어리라 줄 단위로 그대로 옮긴다.
  const shownUser = _lines(g.userMemory);
  const refFacts = _lines(g.refMemory);
  const factLine = (l) => `- ${l}`;

  // ── README ──
  let readme = `# ${name} — 기억\n\n`;
  readme += `> 이 폴더는 **${name}**가 당신과 쌓아온 기억을 사람이 읽을 수 있는 형태로 담은 것입니다.\n`;
  readme += `> 어떤 AI에게 보여줘도 읽을 수 있어요. 이 기억은 당신 것입니다.\n\n`;
  readme += `## 나는 누구\n- **이름**: ${name}\n`;
  if (g.agent.persona) readme += `- **성격**: ${g.agent.persona}\n`;
  readme += `- **당신을 부르는 호칭**: ${nick}\n`;
  if (g.agent.speech) readme += `- **말투**: ${g.agent.speech}\n`;
  if (g.agent.auxoMd) readme += `\n### 당신이 준 지침\n${g.agent.auxoMd}\n`;
  // 요약 이력의 항목이 문자열일 수도, {text}·{summary} 형태의 객체일 수도 있다 →
  // 그대로 넣으면 '[object Object]' 가 박히므로 문자열만 꺼낸다.
  const _asText = (v) => (typeof v === 'string' ? v : (v && (v.text || v.summary || v.content)) || '');
  const rel = _asText(g.summaryHistory.slice(-1)[0]) || _asText(g.summary);
  readme += `\n## 관계 요약\n${rel || '_(아직 쌓인 요약이 없어요)_'}\n\n`;
  readme += `## 이 폴더 안내\n`;
  readme += `- \`${nick}에-대해.md\` — 당신에 대해 아는 것 (${shownUser.length}줄)\n`;
  if (refFacts.length) readme += `- \`참고정보.md\` — 문서·제3자에게서 알게 된 정보 (${refFacts.length}줄)\n`;
  readme += `- \`함께한-일.md\` — 함께한 일 (${g.episodes.length}개)\n`;
  {
    const pj = (g.work && Array.isArray(g.work.projects)) ? g.work.projects.length : 0;
    const rt = (g.work && Array.isArray(g.work.routines)) ? g.work.routines.length : 0;
    if (pj || rt) readme += `- \`하고-있는-일.md\` — 프로젝트 ${pj}개 · 반복하는 일 ${rt}개\n`;
  }
  readme += `- \`대화/\` — 월별 전체 대화 원문\n`;
  readme += `\n---\n_내보낸 시각: ${_fmtDate(Date.now())}. 비밀번호·API키·내부 수치는 포함하지 않았습니다._\n`;
  files.push({ path: 'README.md', content: readme });

  // ── 사용자에 대해 ──
  let um = `# ${nick}에 대해\n\n`;
  um += shownUser.length ? shownUser.map(factLine).join('\n') : '_(아직 기록된 것이 없어요)_';
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

  // ── 하고 있는 일(프로젝트·루틴) ──
  // ⚠️ gather() 가 work 를 모아와도 파일로 쓰지 않으면 통째로 빠진다
  // (설계 문서의 수집 대상엔 '작업기억'이 있었다 — 구현이 덜 된 상태였다).
  const projects = (g.work && Array.isArray(g.work.projects)) ? g.work.projects : [];
  const routines = (g.work && Array.isArray(g.work.routines)) ? g.work.routines : [];
  if (projects.length || routines.length) {
    let wm = `# 하고 있는 일\n\n`;
    if (projects.length) {
      wm += `## 프로젝트\n`;
      wm += projects.map(p => {
        const done = p.status && p.status !== 'active';
        let line = `- **${p.title || '(제목 없음)'}**`;
        if (p.goal) line += ` — 목표: ${p.goal}`;
        if (done) line += `  _(마무리됨)_`;
        else if (g.work.activeId && g.work.activeId === p.id) line += `  _(지금 하는 일)_`;
        if (Array.isArray(p.steps) && p.steps.length) {
          const doneN = p.steps.filter(s => s && s.done).length;
          line += `\n${p.steps.map(s => `  - ${s && s.done ? '[x]' : '[ ]'} ${(s && s.title) || ''}`).join('\n')}`;
          line += `\n  _(${doneN}/${p.steps.length} 완료)_`;
        }
        return line;
      }).join('\n');
      wm += '\n\n';
    }
    if (routines.length) {
      wm += `## 반복하는 일\n`;
      wm += routines.map(r => `- **${r.title || '(제목 없음)'}**` + (r.rhythm ? ` — ${r.rhythm}` : '')
        + (r.runCount ? `  _(${r.runCount}번 했어요)_` : '')).join('\n');
      wm += '\n';
    }
    files.push({ path: '하고-있는-일.md', content: wm });
  }

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
/**
 * 마크다운 폴더로 내보낸다.
 * @param dest  기본은 "부모 폴더"(그 아래 <이름>-기억 을 만든다).
 *              opts.asFinalDir=true 면 dest 자체를 결과 폴더로 쓴다 — 사용자가 폴더 이름을
 *              직접 정한 경우(폴더 위치뿐 아니라 이름도 사용자가 정한다).
 */
function exportToFolder(agentId, storage, dest, opts = {}) {
  const g = gather(agentId, storage);
  const dir = opts.asFinalDir ? dest : path.join(dest, `${_safeName(g.agent.name || '내AI')}-기억`);
  const files = toMarkdown(g, opts);
  for (const f of files) {
    const full = path.join(dir, f.path);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, f.content, 'utf8');
  }
  return { dir, fileCount: files.length };
}

module.exports = { gather, toMarkdown, exportToFolder };
