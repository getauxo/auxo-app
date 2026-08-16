/**
 * release.js — 배포본 만들기 (한 명령으로, 빠짐없이)
 *
 * 왜 필요한가:
 *   배포본을 만들려면 여섯 단계를 거쳐야 하는데, 사람이 매번 빠짐없이 하기 어렵다.
 *   "실행해서 정상 기동 확인"이라 보고해놓고 실제로는 프로세스 개수만
 *   세었고, 화면엔 `Cannot find module './discord-bot'` 에러 창이 떠 있었다.
 *   테스터는 앱을 켤 수조차 없었다.
 *
 * 핵심 규칙:
 *   **하나라도 실패하면 zip 을 만들지 않는다.**
 *   → 바탕화면에 zip 이 있다는 것 자체가 "모든 검사를 통과했다"는 증거가 된다.
 *
 * 단계:
 *   1) 클린 빌드 (electron-builder --dir)
 *   2) win-unpacked → Auxo 로 이름 변경
 *   3) 동봉 파일 복사 (사용설명서 / 완전 삭제 스크립트)
 *   4) 정적 검사 (verify-dist.js — require 누락·민감파일·개발부산물)
 *   5) 실제 실행 → 창 제목 확인 (에러 창이면 실패)
 *   6) zip 생성 + 내용 검증 + 바탕화면 복사
 *
 * 실행: npm run release
 *       npm run release -- --skip-launch    (실행 검증 생략: CI 등 GUI 없는 환경)
 *       npm run release -- --no-desktop     (바탕화면 복사 안 함)
 */

const { execFileSync, execSync, spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

const ROOT = __dirname;
const DIST = path.join(ROOT, 'dist');
const APPDIR = path.join(DIST, 'Auxo');
const UNPACKED = path.join(DIST, 'win-unpacked');
const PKG = require('./package.json');

const args = process.argv.slice(2);
const SKIP_LAUNCH = args.includes('--skip-launch');
const NO_DESKTOP = args.includes('--no-desktop');

// ── 출력 ────────────────────────────────────────────────────
let step = 0;
const S = (msg) => console.log(`\n[${++step}/6] ${msg}`);
const ok = (msg) => console.log(`      ✓ ${msg}`);
const info = (msg) => console.log(`      · ${msg}`);
function die(msg, detail) {
  console.error(`\n      ✗ ${msg}`);
  if (detail) console.error(`        ${String(detail).split('\n')[0]}`);
  console.error('\n────────────────────────────────────────────────────────');
  console.error('  배포 중단 — 보낼 수 있는 zip 은 만들어지지 않았습니다.');
  console.error('  이 빌드는 배포하면 안 됩니다.');
  console.error('────────────────────────────────────────────────────────\n');
  process.exit(1);
}

function rmrf(p) {
  if (fs.existsSync(p)) fs.rmSync(p, { recursive: true, force: true });
}

// 날짜 태그: 같은 날 두 번 만들면 b, c … 를 붙인다 (덮어쓰기 사고 방지)
function nextTag() {
  const d = new Date();
  const base = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
  const suffixes = ['', 'b', 'c', 'd', 'e', 'f', 'g', 'h'];
  for (const s of suffixes) {
    const name = `Auxo-v${PKG.version}-${base}${s}-win64.zip`;
    if (!fs.existsSync(path.join(DIST, name))) return { name, tag: base + s };
  }
  die('오늘 만든 zip 이 너무 많습니다. dist/ 를 정리해 주세요.');
}

console.log(`\n════════════════════════════════════════════════════════`);
console.log(`  Auxo 배포본 만들기  —  v${PKG.version}`);
console.log(`════════════════════════════════════════════════════════`);

// ── 1. 클린 빌드 ────────────────────────────────────────────
S('클린 빌드');
rmrf(APPDIR); rmrf(UNPACKED);
try {
  execSync('npx electron-builder --dir', { cwd: ROOT, stdio: 'pipe' });
} catch (e) {
  // electron-builder 는 코드서명 캐시 경고로 비0 종료할 수 있다 → 결과물 유무로 판단한다.
  if (!fs.existsSync(UNPACKED)) die('빌드 실패 — win-unpacked 가 만들어지지 않았습니다.', e.message);
  info('빌드 경고가 있었으나 결과물은 생성됨 (코드서명 캐시 등)');
}
if (!fs.existsSync(UNPACKED)) die('빌드 결과물이 없습니다.');
ok('빌드 완료');

// ── 2. 폴더 이름 ────────────────────────────────────────────
S('폴더 이름 정리 (win-unpacked → Auxo)');
fs.renameSync(UNPACKED, APPDIR);
ok(path.relative(ROOT, APPDIR));

// ── 3. 동봉 파일 ────────────────────────────────────────────
S('동봉 파일 복사');
const BUNDLE = [
  { from: 'dist-readme.txt', to: '사용설명서.txt' },
  { from: 'uninstall-template.bat', to: 'Auxo 완전 삭제.bat' },
];
for (const b of BUNDLE) {
  const src = path.join(ROOT, b.from);
  if (!fs.existsSync(src)) die(`동봉할 파일이 없습니다: ${b.from}`);
  fs.copyFileSync(src, path.join(APPDIR, b.to));
  ok(b.to);
}

// ── 4. 정적 검사 ────────────────────────────────────────────
S('정적 검사 (require 누락 · 민감파일 · 개발부산물)');
try {
  const out = execFileSync(process.execPath, [path.join(ROOT, 'verify-dist.js')], { cwd: ROOT, encoding: 'utf8' });
  out.trim().split('\n').filter(l => l.trim()).forEach(l => info(l.trim()));
} catch (e) {
  const out = (e.stdout || '') + (e.stderr || '');
  out.trim().split('\n').filter(l => l.trim()).forEach(l => console.error(`      ${l.trim()}`));
  die('배포본 검사 실패');
}
ok('검사 통과');

// ── 5. 실제 실행 → 에러 창 감지 ─────────────────────────────
S('실제 실행 확인 (에러 창이 뜨면 실패)');
if (SKIP_LAUNCH) {
  info('--skip-launch 로 생략함 ⚠ 이 빌드는 "실행됨"이 검증되지 않았습니다');
} else if (process.platform !== 'win32') {
  info('Windows 가 아니므로 생략');
} else {
  const exe = path.join(APPDIR, 'Auxo.exe');
  if (!fs.existsSync(exe)) die('Auxo.exe 가 없습니다.');
  const child = spawn(exe, [], { detached: true, stdio: 'ignore' });
  child.unref();
  info('앱을 띄우고 12초 기다립니다…');
  execSync('powershell -NoProfile -Command "Start-Sleep -Seconds 12"', { stdio: 'ignore' });

  // 창 제목을 읽는다. "프로세스가 살아있다"만으로는 부족하다 —
  // Electron 은 에러 대화상자를 띄운 상태에서도 프로세스가 살아있다.
  let titles = '';
  try {
    titles = execSync(
      'powershell -NoProfile -Command "(Get-Process Auxo -EA SilentlyContinue | Where-Object { $_.MainWindowTitle -ne \'\' } | ForEach-Object { $_.MainWindowTitle }) -join \'|\'"',
      { encoding: 'utf8' }
    ).trim();
  } catch (_) {}

  let alive = false;
  try {
    alive = execSync('powershell -NoProfile -Command "if (Get-Process Auxo -EA SilentlyContinue) { \'y\' } else { \'n\' }"', { encoding: 'utf8' }).trim() === 'y';
  } catch (_) {}

  const kill = () => { try { execSync('powershell -NoProfile -Command "Get-Process Auxo -EA SilentlyContinue | Stop-Process -Force"', { stdio: 'ignore' }); } catch (_) {} };

  if (!alive) { kill(); die('앱이 즉시 종료됐습니다 (크래시 추정).'); }
  if (!titles) { kill(); die('창이 뜨지 않았습니다.'); }
  if (/Error|오류|Exception/i.test(titles)) { kill(); die(`에러 창이 떠 있습니다: ${titles}`); }

  info(`창 제목: ${titles}`);
  kill();
  ok('정상 기동 (에러 창 없음)');
}

// ── 6. zip + 검증 + 바탕화면 ────────────────────────────────
S('zip 생성 및 내용 검증');
const { name: zipName } = nextTag();
const zipPath = path.join(DIST, zipName);

// 검증을 통과하기 전까지는 임시 이름으로 둔다.
// 그래야 중간에 실패해도 "쓸 수 있어 보이는 zip"이 남지 않는다.
const tmpZip = path.join(DIST, `.building-${Date.now()}.zip`);
rmrf(tmpZip);
try {
  execSync(
    `powershell -NoProfile -Command "Compress-Archive -Path '${APPDIR}' -DestinationPath '${tmpZip}' -CompressionLevel Optimal"`,
    { stdio: 'ignore' }
  );
} catch (e) { rmrf(tmpZip); die('압축에 실패했습니다.', e.message); }
if (!fs.existsSync(tmpZip)) die('zip 이 만들어지지 않았습니다.');

// zip 을 열어 "정말 들어갔는지" 본다 — 폴더를 봤다고 zip 을 본 것은 아니다.
// PowerShell 로 읽으면 한글 파일명이 콘솔 인코딩에서 깨진다 → Node(yauzl)로 직접 읽는다.
const MUST = ['main.js', 'preload.js', 'discord-bot.js', 'brain-claude.js', 'Auxo.exe', '사용설명서.txt', 'Auxo 완전 삭제.bat'];

function listZipEntries(zip) {
  return new Promise((resolve, reject) => {
    const names = [];
    require('yauzl').open(zip, { lazyEntries: true }, (err, zf) => {
      if (err) return reject(err);
      zf.on('entry', (e) => { names.push(path.basename(e.fileName)); zf.readEntry(); });
      zf.on('end', () => resolve(names));
      zf.on('error', reject);
      zf.readEntry();
    });
  });
}

(async () => {
  let names;
  try { names = await listZipEntries(tmpZip); }
  catch (e) { rmrf(tmpZip); die('zip 내용을 읽지 못했습니다.', e.message); }

  const missing = MUST.filter(m => !names.includes(m));
  if (missing.length) { rmrf(tmpZip); die(`zip 안에 빠진 파일: ${missing.join(', ')}`); }
  ok(`필수 파일 ${MUST.length}개 모두 포함 (전체 ${names.length}개)`);

  // 여기까지 왔으면 검증 통과 → 이제야 진짜 이름을 준다.
  fs.renameSync(tmpZip, zipPath);
  const mb = (fs.statSync(zipPath).size / 1048576).toFixed(1);
  ok(`${zipName} (${mb} MB)`);

  if (!NO_DESKTOP) {
    const desktop = path.join(os.homedir(), 'Desktop');
    if (fs.existsSync(desktop)) {
      fs.copyFileSync(zipPath, path.join(desktop, zipName));
      ok(`바탕화면에 복사: ${zipName}`);
    }
  }

  console.log(`\n════════════════════════════════════════════════════════`);
  console.log(`  배포본 준비 완료`);
  console.log(`  ${zipName}  (${mb} MB)`);
  console.log(`  모든 검사를 통과했습니다. 보내셔도 됩니다.`);
  console.log(`════════════════════════════════════════════════════════\n`);
})();
