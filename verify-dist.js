/**
 * verify-dist.js — 배포본 무결성 검사 (빌드 직후 필수)
 *
 * 왜 필요한가:
 *   package.json build.files 의 제외 목록(`!discord-bot.js` 등)과 소스의 require() 가
 *   어긋나면, 배포본은 빌드에 "성공"하지만 실행 즉시 죽는다.
 *   실제로 2026-07-09 배포본이 `Cannot find module './discord-bot'` 로 깨졌다.
 *   (main.js 가 discord-bot 을 require 하게 된 뒤에도 제외 목록이 그대로였다.)
 *
 * 무엇을 하나:
 *   dist/Auxo/resources/app 안의 모든 .js 를 훑어 로컬 require('./x') 대상을 모으고,
 *   그 파일이 배포본에 실제로 있는지 확인한다. 하나라도 없으면 exit 1.
 *   추가로 민감 파일이 섞여 들어갔는지도 본다.
 *
 * 실행: node verify-dist.js [배포본_app_경로]
 */

const fs = require('fs');
const path = require('path');

const APP_DIR = process.argv[2] || path.join(__dirname, 'dist', 'Auxo', 'resources', 'app');

const SECRET_PATTERNS = [
  /api-key/i, /-key$/i, /-token$/i, /^\.env$/i, /\.분신\.json$/i,
  /telegram-bot\.json$/i, /office-token/i,
];

function fail(msg) { console.error(`[FAIL] ${msg}`); process.exitCode = 1; }
function ok(msg) { console.log(`[OK]   ${msg}`); }

if (!fs.existsSync(APP_DIR)) {
  console.error(`배포본을 찾을 수 없습니다: ${APP_DIR}`);
  console.error('먼저 `npm run pack` 후 dist/win-unpacked → dist/Auxo 로 이름을 바꾸세요.');
  process.exit(1);
}

// ── 1. 로컬 require 대상이 전부 존재하는가 ──────────────────
// 검사기 자신은 건너뛴다(주석 속 예시 require 를 오탐한다)
const jsFiles = fs.readdirSync(APP_DIR).filter(f => f.endsWith('.js') && f !== 'verify-dist.js');
const missing = new Set();
let requireCount = 0;

for (const file of jsFiles) {
  const src = fs.readFileSync(path.join(APP_DIR, file), 'utf8');
  const re = /require\(\s*['"](\.\/[^'"]+)['"]\s*\)/g;
  let m;
  while ((m = re.exec(src)) !== null) {
    requireCount++;
    const target = m[1].replace(/^\.\//, '');
    const base = path.join(APP_DIR, target);
    const found = ['', '.js', '.json'].some(ext => fs.existsSync(base + ext))
      || fs.existsSync(path.join(base, 'index.js'));
    if (!found) missing.add(`${target}  (${file} 에서 require)`);
  }
}

if (missing.size) {
  for (const m of missing) fail(`배포본에 없는 모듈: ${m}`);
  fail('→ package.json 의 build.files 제외 목록을 확인하세요.');
} else {
  ok(`로컬 require ${requireCount}건 — 대상 모듈 모두 존재`);
}

// ── 2. 진입점이 존재하는가 ──────────────────────────────────
for (const entry of ['main.js', 'preload.js', 'renderer/index.html']) {
  if (fs.existsSync(path.join(APP_DIR, entry))) ok(`진입점 존재: ${entry}`);
  else fail(`진입점 누락: ${entry}`);
}

// ── 3. 민감 파일이 섞이지 않았는가 ──────────────────────────
const leaked = fs.readdirSync(APP_DIR).filter(f => SECRET_PATTERNS.some(p => p.test(f)));
if (leaked.length) fail(`민감 파일이 배포본에 포함됨: ${leaked.join(', ')}`);
else ok('민감 파일 없음');

// ── 4. 개발 부산물이 섞이지 않았는가 ────────────────────────
// 2026-07-10: .patch-backup-20260708/(옛 main.js 사본 284KB)가 배포본에 딸려 들어가 있었다.
// build.files 제외는 "적어둔 것만" 막으므로, 결과물을 직접 본다.
const JUNK_PATTERNS = [
  /^\.patch-backup/i, /\.bak(-|$)/i, /^_.*test/i, /^evidence$/i,
  /^smoke-data$/i, /^dist$/i, /-test\.js$/i, /^test-/i,
];
const junk = fs.readdirSync(APP_DIR).filter(f => JUNK_PATTERNS.some(p => p.test(f)));
if (junk.length) fail(`개발 부산물이 배포본에 포함됨: ${junk.join(', ')}`);
else ok('개발 부산물 없음');

// ── 결과 ────────────────────────────────────────────────────
console.log('');
if (process.exitCode) console.error('배포본 검사 실패 — 이 빌드는 배포하면 안 됩니다.');
else console.log('배포본 검사 통과.');
