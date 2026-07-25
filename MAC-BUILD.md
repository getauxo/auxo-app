# Auxo macOS 빌드 작업 지시서

> 대상: **맥 담당 AI** (Mac 실기에서 작업). 이 프로젝트를 처음 보는 사람도 이 문서만으로 끝까지 갈 수 있게 씀.
> 갱신: 2026-07-22 / 기준 버전: v0.1.0 / Electron 31 / node 22
> 전제: 이 작업은 **반드시 macOS 장비(또는 macOS CI 러너)에서** 수행한다. Windows·Linux에선 `.dmg` 산출·서명·공증·실행 검증이 불가능하다.

---

## 0. 이 앱이 뭔지 (30초 요약)
- **Auxo** = 설치형 데스크톱 **AI 친구/에이전트**. Electron 앱. 대화·기억이 **내 컴퓨터에만** 저장된다.
- 스택: **Electron(메인=Node) + 순수 HTML/CSS/JS 렌더러**. 프레임워크·번들러 없음. `main.js`가 진입점.
- AI 모델은 사용자가 고른다: Gemini·Claude·GPT·Codex(구독 CLI 또는 API 키) + OpenAI 호환.
- 채널: 앱(Electron) · CLI(`cli.js`) · 텔레그램/디스코드 봇.

### ★가장 중요한 사실 — **네이티브 모듈이 없다**
이 앱은 **컴파일이 필요한 네이티브 애드온을 하나도 쓰지 않는다.** 전부 JS 또는 WASM이다.
- **DB**: `node-sqlite3-wasm` — SQLite를 **WASM**으로 구동(파일: `auxo.db`). 아키텍처/OS 무관, 리빌드 불필요.
- **기억 의미검색 임베딩 + 음성 전사(whisper)**: `@huggingface/transformers` v4 — **onnxruntime-web(WASM) 내장**으로 돈다. 별도 `onnxruntime-node`(네이티브) **없음**.
- 따라서 **맥용으로 `npm rebuild`·node-gyp·아키텍처별 네이티브 바이너리 걱정이 전혀 없다.** arm64든 x64든 **같은 JS/WASM**이 그대로 돈다. 빌드가 그만큼 단순하다.

> (참고: 이전 버전 문서엔 "onnxruntime-node 네이티브를 쓰니 WASM은 제외하라"는 지시가 있었으나 **그건 옛 정보다.** 지금 코드엔 onnxruntime-node도, 분리된 onnxruntime-web 패키지도 없다. WASM 수동 제거 단계도 필요 없다.)

---

## 1. 완료의 정의 (DoD)
"코드/설정 작성"이 아니라 **"맥에서 `Auxo.dmg`를 만들어, 실제로 설치·실행하고 첫 대화까지 도는 것을 스크린샷/로그로 증명"** 하면 완료다. **증거 없는 완료 보고 금지.**

산출물(택1): `dist/Auxo-0.1.0-arm64.dmg` + `dist/Auxo-0.1.0-x64.dmg` (아키텍처별 2개) **또는** `Auxo-0.1.0-universal.dmg` (합본 1개).
- 네이티브 모듈이 없어 **어느 쪽이든 쉽다.** 배포 단순화를 원하면 universal, 용량을 줄이려면 아키텍처별. → 마스터 결정(6번).

---

## 2. 현재 상태 (Windows 담당이 확인해 둔 것)
앱 코드는 대체로 크로스플랫폼 대응이 되어 있다(아래는 **실제 코드로 확인함**):
- **데이터 경로**: 전부 `app.getPath('userData')` 사용 → 맥에서 자동으로 `~/Library/Application Support/Auxo`로 잡힌다. **하드코딩 경로 없음.** 저장 파일은 **`auxo.db`**(SQLite).
- **구독형 두뇌 실행기**(`brain-claude.js`·`brain-codex.js`·`brain-antigravity.js`)에 이미 `process.platform` 분기가 있다(맥=비-win32 경로, `which`/`~/.local/bin` 탐색, `.exe` 아님). **단, 이 분기들은 실제 맥에서 한 번도 실행 검증된 적이 없다.**
- **렌더러**: `app.js`가 `document.body.classList.add('platform-darwin')` 부여, `style.css`가 신호등(트래픽 라이트) 여백 처리(`body.platform-darwin .titlebar-menu`).
- **빠진 것 = `package.json`의 `build.mac`/`dmg` 설정, entitlements, 아이콘 `.icns`, ffmpeg 맥 바이너리, 그리고 맥 실기 검증.**

---

## 3. 해야 할 일

### 3-1. `package.json`에 mac 빌드 설정 추가
`build` 블록에 아래를 추가한다(기존 `win`/`nsis`는 그대로 둔다). `build.icon`은 이미 루트 `icon.png`(1024px)로 설정돼 있어 electron-builder가 맥에서 `.icns`를 자동 생성한다 — 별도 `.icns`를 만들지 않아도 된다(원하면 3-2로 명시 가능).

```json
"mac": {
  "target": [{ "target": "dmg", "arch": ["arm64", "x64"] }],
  "category": "public.app-category.productivity",
  "hardenedRuntime": true,
  "gatekeeperAssess": false,
  "entitlements": "build/entitlements.mac.plist",
  "entitlementsInherit": "build/entitlements.mac.plist"
},
"dmg": {
  "title": "Auxo ${version}",
  "contents": [
    { "x": 130, "y": 220 },
    { "x": 410, "y": 220, "type": "link", "path": "/Applications" }
  ]
}
```
- universal 1파일을 원하면 `"arch": ["universal"]`로 바꾼다.
- `files` 제외 목록의 Windows 전용 항목(`uninstall-template.bat` 등)은 맥에 무해하므로 그대로 둬도 된다.

### 3-2. (선택) 아이콘 `.icns` 명시
- 루트에 `icon.png`(1024px, 이미 있음)가 있어 자동 변환된다. **명시하고 싶으면** `iconutil` 또는 `electron-icon-builder`로 `build/icon.icns`를 만들고 `build.mac.icon: "build/icon.icns"`를 추가.
- 로고는 A 모노그램(그라디언트 사각 + 흰 A + 기억 점). 원본은 `../auxo-website/favicon.svg` 및 루트 `icon.png` 참조.

### 3-3. entitlements 파일 생성
`build/entitlements.mac.plist`. 이 앱은 외부 CLI(claude/codex/agy)를 **자식 프로세스로 실행**하고 네트워크를 쓰며, WASM(JIT)을 돌리므로 최소 아래가 필요:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>com.apple.security.cs.allow-jit</key><true/>
  <key>com.apple.security.cs.allow-unsigned-executable-memory</key><true/>
  <key>com.apple.security.cs.allow-dyld-environment-variables</key><true/>
  <key>com.apple.security.cs.disable-library-validation</key><true/>
  <key>com.apple.security.network.client</key><true/>
</dict></plist>
```
(`allow-jit`/`unsigned-executable-memory`는 WASM·V8, `disable-library-validation`은 자식 CLI 실행에 필요.)

### 3-4. 빌드
```bash
npm install
npm run prepare-model     # 임베딩 모델(EmbeddingGemma ~200MB)을 models/ 로 준비. 최초 1회 다운로드.
npx electron-builder --mac
```
서명 없이 먼저 빌드해 `.dmg`가 나오는지부터 확인한다(서명은 4번).

> Windows에서 겪던 winCodeSign 심볼릭링크 문제는 맥에선 발생하지 않는다(그건 Windows에서 mac용 도구를 풀 때 나던 문제). 맥에선 무시.

---

## 4. 서명·공증 (Gatekeeper)
서명하지 않으면 맥에서 **"확인되지 않은 개발자 / 손상되어 열 수 없음"**으로 실행이 막히거나 사용자가 매번 우회해야 한다.

### 4-1. 정식 배포용 (권장, 마스터 결정 필요)
- **Apple Developer Program 가입 필요(연 $99).** → 마스터 확인/승인 요청.
- "Developer ID Application" 인증서로 서명 + `notarytool`로 공증(notarize).
- electron-builder는 환경변수만 주면 서명·공증을 자동 처리:
  `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`, `APPLE_TEAM_ID`.

### 4-2. 임시(계정 없이 테스트만)
- 서명 없이 빌드한 `.dmg`는 실행 시 **우클릭 → 열기**, 또는 `xattr -cr /Applications/Auxo.app`로 격리 속성 제거해야 열린다.
- **이 상태를 "배포 가능"으로 보고하지 말 것.** 홈페이지 배포에는 4-1이 전제다.

### 4-3. 완전 삭제 안내(맥용)
맥엔 `.bat`이 안 도니 사용자 안내는 다음으로 충분:
1. `Auxo.app`을 휴지통으로
2. `~/Library/Application Support/Auxo` 폴더 삭제
→ 홈페이지(privacy.html/download.html)의 맥 안내에 반영 예정.

---

## 5. on-demand 자산 (음성·영상·유튜브) — 맥 바이너리 필요
음성/영상/유튜브 이해 기능은 첫 사용 시 우리 공개 릴리스(**`getauxo/auxo-assets`**)에서 도구를 내려받는다(`assets-manifest.js`에 URL·sha256 핀 고정). 플랫폼 키 = `${process.platform}-${process.arch}` (예: `darwin-arm64`, `darwin-x64`).

현재 매니페스트 상태:
- **whisper 모델**(음성 전사): zip 1개, WASM/onnx라 **플랫폼 무관** → 맥도 그대로 동작. ✅
- **yt-dlp**(유튜브): `darwin-x64`·`darwin-arm64` 엔트리 **이미 있음**. ⚠️ **맥에서 실행 검증 미완**(윈도우에서 받아 넣은 것).
- **ffmpeg**(영상·mp3·m4a 디코딩): **`win32-x64`만 있고 `darwin-*`가 없다.** → 맥에서 영상/오디오 파일 디코딩이 안 된다.

**맥 담당이 할 일:**
1. macOS용 ffmpeg 정적 바이너리(arm64, x64)를 구해 `getauxo/auxo-assets` 릴리스(`media-v1` 태그)에 업로드.
2. 각 파일 `sha256`·크기를 재고 `assets-manifest.js`의 `ffmpeg`에 `darwin-x64`·`darwin-arm64` 엔트리 추가.
3. 맥에서 yt-dlp·ffmpeg가 실제로 실행되는지 검증(권한/격리속성 `xattr` 이슈 있을 수 있음).

> ⚠️ **`getauxo/auxo-assets` repo는 현재 private다.** private면 이 다운로드 URL이 인증을 요구해 **일반 사용자에게서 실패**한다. **public 전환이 필요**(마스터 결정, 6번). 이건 맥·윈도우 공통 선결 조건.

---

## 6. 마스터 결정이 필요한 것 (막히면 여기부터)
- [ ] **Apple Developer Program 가입 여부($99/년)** — 정식 서명·공증 필수.
- [ ] **`getauxo/auxo-assets` public 전환** — 음성/영상/유튜브 on-demand 다운로드 동작 전제(맥·윈 공통).
- [ ] **universal(1파일) vs 아키텍처별(2파일)** — 네이티브가 없어 둘 다 쉬움. 단순 배포=universal, 용량=아키텍처별.
- [ ] (선택) `.icns` 명시 여부 — 안 하면 `icon.png`에서 자동 생성됨.

---

## 7. 반드시 실기 검증할 런타임 항목 (Windows에서 검증 못 한 부분)
맥에서 앱을 띄운 뒤 **실제로 눌러 보며** 확인하고 결과를 기록한다. **눌러 확인 못 한 항목은 "미검증"으로 명확히 표시**하고 완료처럼 보고하지 않는다(크로스플랫폼 정직 원칙).

1. **첫 실행 온보딩** — 모델 선택 → 키 입력/구독 로그인 → 이름 짓기 → 첫 인사까지 왕복.
2. **Gemini(API키) 대화** — 가장 단순한 경로. 한 번 왕복 되는지.
3. **구독형 두뇌** — `brain-claude.js`/`brain-codex.js`/`brain-antigravity.js`의 darwin 분기가 실제로 CLI를 찾아 실행하는지(설치돼 있다면). 특히 맥은 `.exe`가 아니라 shell 없이 직접 실행 경로.
4. **기억(SQLite)** — 대화 후 `~/Library/Application Support/Auxo/auxo.db`가 생기고 사실/대화가 쌓이는지. (WASM sqlite가 맥에서 정상 로드되는지 = 이 앱의 핵심)
5. **기억 의미검색·이전 대화 스크롤** — 대화 화면에서 위로 스크롤 시 옛 대화 자동 로드, 검색 정상.
6. **음성/영상/유튜브** — 5번 자산 준비 후: 음성파일 전사(whisper WASM), 영상/오디오(ffmpeg), 유튜브 링크(yt-dlp) 각각 1회.
7. **파일 송수신** — `app.getPath('desktop')` 저장/첨부 정상.
8. **텔레그램/디스코드 연결** — 봇 토큰 저장 경로(`userData`) 정상.
9. **공지 확인** — 앱 켤 때 GitHub `notice.json` fetch 정상, 끄기 동작.
10. **트래픽 라이트 겹침** — 창 좌상단 신호등과 UI(햄버거 메뉴)가 겹치지 않는지.

---

## 8. 배포 스크립트 (선택, 나중)
Windows엔 `release.js`(빌드+검증+Desktop 복사 자동화)가 있다. 맥도 안정화되면 `release-mac.js`를 만들되, 우선은 수동 `electron-builder --mac` + 7번 체크리스트로 충분하다.

---

## 요약 (맥 담당 AI에게 한 줄)
"**네이티브 모듈이 없다**(sqlite·onnx 전부 WASM) — 아키텍처 걱정 없이 `package.json`에 `mac`/`dmg` + entitlements 넣고 `npm run prepare-model && npx electron-builder --mac`로 `.dmg`를 뽑아라. 그다음 **실제 맥에서 설치→첫 대화→`auxo.db` 생성까지 돌려 스크린샷으로 증명**하라. 서명은 Apple 계정 마련되면 붙인다. ffmpeg 맥 바이너리는 `auxo-assets`에 올려 `assets-manifest.js`에 추가해야 영상·오디오가 된다. darwin 코드 분기는 실기 검증이 안 됐으니 7번 목록을 눌러 확인하라."
