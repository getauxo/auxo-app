'use strict';
/**
 * verify-package.js — **설치본에 사용자가 볼 필요 없는 것이 섞였나** 검사.
 *
 * 왜 만들었나: 재빌드한 설치본을 열어 보니 아래가 그대로 들어 있었다.
 *   · 내 테스트 하니스 14개(app-run-*.js) — 개발 과정 주석·사고 기록이 그대로
 *   · 감사 스크립트 3개(audit-*.js), 진단·빌드 스크립트
 *   · 스킬 E2E 때 나온 스크린샷(.playwright-mcp/), 랜딩 PNG
 *   · **테스트 중 만들어진 대화 파일**(~/Desktop/어쿠테스트/일기.txt 등)
 * 빌드는 "성공"으로 끝나고 아무도 못 알아챈다 — 아이콘이 빠졌던 것과 같은 모양이다.
 * 그때 verify-branding.js 를 붙여 막았듯, 여기도 **코드가 세게** 만든다.
 *
 * 파일이 늘어나는 건 정상이고, 늘어난 걸 아무도 안 세는 게 문제다.
 * 그래서 이름 패턴이 아니라 **"이 목록에 없으면 실패"** 로 한다(허용 목록).
 */
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const ASAR = path.join(__dirname, 'dist', 'win-unpacked', 'resources', 'app.asar');

if (!fs.existsSync(ASAR)) {
  console.error(`[verify-package] app.asar 없음: ${ASAR}\n  먼저 npm run pack 을 돌려야 한다.`);
  process.exit(1);
}

// 설치본에 들어가도 되는 최상위 항목. **여기 없는 게 나오면 실패**한다.
// 새 파일을 앱에 추가했으면 여기에도 적는다 — 그 한 줄이 "사용자에게 나가도 되나"를 한 번 묻게 한다.
const ALLOW_FILES = new Set([
  // LICENSE·package.json 은 electron/배포 규약상 필요. README·사용설명서는 asar 안에선 아무도 못 보는
  // 죽은 무게라 뺀다(dist-readme.txt 는 zip 배포용으로 release.js 가 따로 쓴다)
  'LICENSE', 'package.json',
  'icon.ico', 'icon.png',
  'mcp-catalog.json', 'skills-catalog.json',
  // 앱 코드
  'main.js', 'preload.js', 'engine.js', 'storage.js', 'constants.js', 'env.js',
  'agent-queue.js', 'agent-tools.js', 'attachment-store.js',
  'asset-store.js', 'assets-manifest.js', 'audio-transcribe.js',
  // ★discord-bot.js 는 빼면 안 된다. 개인 도구처럼 보이지만
  //   **제품의 채널**이다 — cli.js 가 `require('./discord-bot')` 하고 사용자에게 `/discord` 를 준다.
  //   빼면 설치본에서 **CLI 가 시작조차 못 한다.** (내 오판, 같은 날 되돌림)
  'auxo-mcp-tools.js', 'bot-telegram.js', 'discord-bot.js', 'cli.js',
  'brain-anthropic.js', 'brain-claude.js', 'brain-codex.js', 'brain-gemini.js', 'brain-openai.js',
  'claim-check.js', 'companion-format.js', 'embed-worker.js', 'embeddings.js',
  'episode-memory.js', 'file-intake.js', 'fs-tools.js', 'learn-skill.js',
  'mcp-gateway.js', 'mcp-manager.js', 'media-ffmpeg.js',
  'memory-export.js', 'memory-post.js', 'memory-search.js', 'memory-tools.js',
  'notice.js', 'proc-tools.js', 'scheduler.js', 'skills-registry.js',
  'subagents.js', 'tool-decls.js', 'tool-transparency.js', 'tools.js',
  'user-memory.js', 'web-search.js', 'youtube-transcript.js',
]);
// 통째로 들어가도 되는 폴더
// skills/ 는 앱 폴더에 두지 않는다 — 실제 스킬은 userData/skills/<agentId>/ 에만 있다
// (앱 루트에 두면 규칙에 안 맞는 구조가 된다)
const ALLOW_DIRS = ['renderer', 'models', 'node_modules'];

let list;
try {
  list = execFileSync('npx', ['asar', 'list', ASAR], { encoding: 'utf8', shell: true })
    .split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
} catch (e) {
  console.error('[verify-package] asar list 실패:', e.message);
  process.exit(1);
}

// 최상위 항목만 본다(하위는 폴더 허용으로 커버).
const top = new Set();
for (const raw of list) {
  const p = raw.replace(/\\/g, '/').replace(/^\/+/, '');
  if (!p) continue;
  top.add(p.split('/')[0]);
}

const stray = [...top].filter((n) => !ALLOW_FILES.has(n) && !ALLOW_DIRS.includes(n)).sort();

console.log('');
if (stray.length) {
  console.log(`[FAIL] 설치본에 있으면 안 되는 항목 ${stray.length}개:`);
  for (const s of stray) console.log(`         · ${s}`);
  console.log('');
  console.log('  → 개발용이면 package.json 의 build.files 에 "!<이름>" 을 추가하고 다시 빌드한다.');
  console.log('  → 앱에 정말 필요한 파일이면 verify-package.js 의 ALLOW_FILES 에 추가한다.');
  console.log('');
  process.exit(1);
}

console.log(`[OK]   설치본 최상위 ${top.size}개 항목 전부 허용 목록 안에 있음`);
console.log('');
console.log('설치본 내용물 검사 통과.');
