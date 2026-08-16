/**
 * verify-branding.js — 배포본 exe 브랜딩(아이콘·버전정보) 검사
 *
 * 왜 필요한가:
 *   winCodeSign 압축 해제 실패를 우회하려고 한때
 *   build.win.signAndEditExecutable 을 false 로 껐다. 이 옵션은 코드서명뿐 아니라
 *   **exe 리소스 편집(아이콘·버전정보) 까지 함께** 끈다.
 *   그 뒤 7-27 에 새 로고로 icon.ico 를 교체(70faf15)했지만 주입 단계가 꺼져 있어
 *   배포본 exe 는 계속 electron 순정(아이콘=원자 심볼, ProductName=Electron)이었다.
 *   빌드는 "성공"으로 끝나 아무도 알아채지 못했고, 사용자에게는 옛 아이콘이 나갔다.
 *
 * 무엇을 하나:
 *   dist/win-unpacked/Auxo.exe 의
 *     1. 버전정보가 우리 것인가 (ProductName=Auxo, FileVersion=package.json 의 version)
 *     2. 아이콘이 electron 순정 아이콘이 아닌가
 *     3. 아이콘이 icon.ico 와 픽셀 단위로 같은가
 *   하나라도 어긋나면 exit 1. 이 검사가 통과해야 배포한다.
 *
 * 실행: node verify-branding.js [exe_경로]
 */

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const EXE = process.argv[2] || path.join(__dirname, 'dist', 'win-unpacked', 'Auxo.exe');
const ICO = path.join(__dirname, 'icon.ico');
const STOCK = path.join(__dirname, 'node_modules', 'electron', 'dist', 'electron.exe');
const EXPECTED_VERSION = require('./package.json').version;
const EXPECTED_PRODUCT = require('./package.json').build.productName;

function fail(msg) { console.error(`[FAIL] ${msg}`); process.exitCode = 1; }
function ok(msg) { console.log(`[OK]   ${msg}`); }

if (process.platform !== 'win32') {
  console.log('[SKIP] Windows 전용 검사입니다.');
  process.exit(0);
}
if (!fs.existsSync(EXE)) {
  console.error(`배포본 exe 를 찾을 수 없습니다: ${EXE}`);
  console.error('먼저 `npm run pack` 을 실행하세요.');
  process.exit(1);
}

// ── exe/ico 에서 버전정보와 아이콘 픽셀 해시를 뽑는다 ────────
// 아이콘은 PNG 로 인코딩한 뒤 SHA-256 을 낸다. 같은 원본이면 같은 해시가 나온다.
const PS = `
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing

function Get-BitmapHash($bmp) {
  $ms = New-Object System.IO.MemoryStream
  $bmp.Save($ms, [System.Drawing.Imaging.ImageFormat]::Png)
  $sha = [System.Security.Cryptography.SHA256]::Create()
  ($sha.ComputeHash($ms.ToArray()) | ForEach-Object { $_.ToString('x2') }) -join ''
}
function Get-ExeIconHash($p) {
  $i = [System.Drawing.Icon]::ExtractAssociatedIcon($p)
  @{ hash = (Get-BitmapHash $i.ToBitmap()); size = $i.Width }
}

$exeIcon = Get-ExeIconHash '${EXE.replace(/\\/g, '/')}'
$info = (Get-Item '${EXE.replace(/\\/g, '/')}').VersionInfo

# icon.ico 에서 exe 아이콘과 같은 크기의 프레임을 꺼내 비교한다
$fsIco = [System.IO.File]::OpenRead('${ICO.replace(/\\/g, '/')}')
$ico = New-Object System.Drawing.Icon($fsIco, $exeIcon.size, $exeIcon.size)
$icoHash = Get-BitmapHash $ico.ToBitmap()
$fsIco.Close()

$stockHash = ''
if (Test-Path '${STOCK.replace(/\\/g, '/')}') {
  $stockHash = (Get-ExeIconHash '${STOCK.replace(/\\/g, '/')}').hash
}

@{
  productName = [string]$info.ProductName
  companyName = [string]$info.CompanyName
  fileVersion = [string]$info.FileVersion
  iconSize    = $exeIcon.size
  exeIcon     = $exeIcon.hash
  icoIcon     = $icoHash
  stockIcon   = $stockHash
} | ConvertTo-Json -Compress
`;

const res = spawnSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', PS], {
  encoding: 'utf8',
  maxBuffer: 10 * 1024 * 1024,
});

if (res.status !== 0) {
  console.error(res.stderr || res.stdout);
  fail('exe 정보를 읽지 못했습니다.');
  process.exit(1);
}

let info;
try {
  info = JSON.parse(res.stdout.trim());
} catch {
  console.error(res.stdout);
  fail('exe 정보 파싱 실패.');
  process.exit(1);
}

// ── 1. 버전정보가 우리 것인가 ───────────────────────────────
if (info.productName === EXPECTED_PRODUCT) {
  ok(`ProductName = ${info.productName}`);
} else {
  fail(`ProductName 이 "${info.productName}" 입니다 (기대: "${EXPECTED_PRODUCT}").`);
  if (info.productName === 'Electron') {
    fail('→ exe 리소스 편집이 실행되지 않았습니다. build.win.signAndEditExecutable 이 false 인지 확인하세요.');
  }
}

if (info.fileVersion.startsWith(EXPECTED_VERSION)) {
  ok(`FileVersion = ${info.fileVersion}`);
} else {
  fail(`FileVersion 이 "${info.fileVersion}" 입니다 (기대: "${EXPECTED_VERSION}").`);
}

// ── 2. 아이콘이 electron 순정이 아닌가 ──────────────────────
if (!info.stockIcon) {
  console.log('[WARN] electron 순정 exe 가 없어 순정 아이콘 대조는 건너뜁니다.');
} else if (info.exeIcon === info.stockIcon) {
  fail('아이콘이 electron 순정 아이콘 그대로입니다 — 아이콘 주입이 안 됐습니다.');
} else {
  ok('아이콘이 electron 순정이 아님');
}

// ── 3. 아이콘이 icon.ico 와 같은가 ──────────────────────────
if (info.exeIcon === info.icoIcon) {
  ok(`아이콘이 icon.ico 와 일치 (${info.iconSize}x${info.iconSize})`);
} else {
  fail(`아이콘이 icon.ico 와 다릅니다 (${info.iconSize}x${info.iconSize}). exe=${info.exeIcon.slice(0, 12)} ico=${info.icoIcon.slice(0, 12)}`);
  fail('→ icon.ico 를 바꾼 뒤 재빌드했는지 확인하세요.');
}

// ── 결과 ────────────────────────────────────────────────────
console.log('');
if (process.exitCode) console.error('브랜딩 검사 실패 — 이 빌드는 배포하면 안 됩니다.');
else console.log('브랜딩 검사 통과.');
