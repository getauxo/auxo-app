# 온디맨드 자산 기록 · 릴리스 · 업데이트 관리 (getauxo/auxo-assets)

음성·영상·유튜브 기능은 무거운 자산을 **번들하지 않고** 첫 사용 시 **우리 공개 릴리스에서
자동 다운로드**한다(제3자 rot 방지 + sha256 무결성 검증). 이 문서가 그 자산들의 **단일 기록**이다.

## 온디맨드 자산 목록

| 자산 | 용도 | 크기 | 받는 시점 | 저장 위치 | 갱신 빈도 |
|---|---|---|---|---|---|
| `whisper-small-q8.zip` | 음성 전사(STT) | 158MB(zip) | 첫 음성 파일 | userData/models | 드묾 |
| `ffmpeg-<plat>` | 영상·mp3·m4a 소리 추출 | 79MB | 첫 영상/mp3/m4a | userData/bin | 드묾 |
| `yt-dlp<plat>` | 유튜브 자막·소리 | 18MB | 첫 유튜브 링크 | userData/bin | **잦음(유튜브 변화 대응)** |

정의·URL·sha256 은 코드 `assets-manifest.js` 에 핀 고정. **여기 값과 릴리스 파일이 일치해야 동작.**

### 현재 준비된 파일 (release-staging/, git 제외)
- `whisper-small-q8.zip` — sha256 `79695e08e0e56325062f4b40f949fd1ba177bf8f927772d79dc370808652946d` (전 OS 공용)
- `ffmpeg-win32-x64.exe` — sha256 `04e1307997530f9cf2fe35cba2ca7e8875ca91da02f89d6c7243df819c94ad00`
- `yt-dlp.exe` (win) — sha256 `52fe3c26dcf71fbdc85b528589020bb0b8e383155cfa81b64dd447bbe35e24b8`
- `yt-dlp_macos` — sha256 `498bd0dae17855c599d371d68ec5bafc439a9d8640e838be25c765a9792f261b` ⚠️미검증(윈도우서 받음)
- `yt-dlp_linux` — sha256 `6bbb3d314cde4febe36e5fa1d55462e29c974f63444e707871834f6d8cc210ae` ⚠️미검증
  - (yt-dlp mac/linux 는 manifest 에 이미 등록. 해당 OS 에서 실행 확인 필요.)

## 최초 세팅 (public 전환 시, 한 번)

1. 공개 repo:
   ```
   gh repo create getauxo/auxo-assets --public -d "Auxo on-demand assets (models·binaries)"
   ```
2. 릴리스 업로드 (태그 `media-v1` = manifest TAG 와 일치):
   ```
   cd agentlink-app/release-staging
   gh release create media-v1 whisper-small-q8.zip ffmpeg-win32-x64.exe yt-dlp.exe yt-dlp_macos yt-dlp_linux \
     -R getauxo/auxo-assets -t "media assets v1" -n "whisper-small, ffmpeg, yt-dlp"
   ```
3. 확인 (public 이라 인증 불필요, 200 이면 정상):
   ```
   curl -L -o /dev/null -w "%{http_code}\n" \
     https://github.com/getauxo/auxo-assets/releases/download/media-v1/yt-dlp.exe
   ```
   그 뒤 앱에서 음성/영상/유튜브 → 첫 사용 시 자동 다운로드·검증·동작 확인.

## 업데이트 관리 ★중요

유튜브는 방어를 자주 바꿔 **yt-dlp 를 주기적으로 갱신**해야 한다(안 하면 유튜브 기능이 깨질 수 있음).
갱신 절차(자산 교체 = 새 태그, 옛 태그는 유지):

1. 새 바이너리 준비 + sha256:
   ```
   cd agentlink-app/release-staging
   node -e "require('../asset-store').download('https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp.exe','yt-dlp.exe').then(async()=>console.log(await require('../asset-store').sha256File('yt-dlp.exe')))"
   ```
2. **새 태그**로 올린다(예: `media-v2`). ⚠️ **옛 태그 파일은 지우지 않는다**(옛 버전 앱이 참조).
   ```
   gh release create media-v2 yt-dlp.exe ... -R getauxo/auxo-assets
   ```
3. `assets-manifest.js` 의 `TAG` 를 새 태그로, 해당 자산 `sha256`/`version` 갱신.
4. 앱 업데이트 배포(설치형이라 사용자에게 반영되려면 새 버전 필요).

- **whisper·ffmpeg** 는 안정적이라 거의 안 바꿔도 된다. 바꿀 땐 같은 절차.
- 갱신 주기 점검: 유튜브 기능 오류 신고가 늘면 yt-dlp 먼저 최신화.

## 규칙
- **올린 자산은 지우지 않는다**(옛 앱이 그 URL 참조). 교체는 항상 새 태그.
- 자산은 **공개 오픈소스**(whisper·ffmpeg·yt-dlp)일 뿐 — 우리 소스코드/키는 절대 안 올린다.
- 다른 OS(mac/linux): 각 플랫폼 바이너리를 `<name>-<platform>-<arch>` 로 올리고 manifest 에 키 추가.
  - whisper zip = 플랫폼 무관(공용). yt-dlp mac/linux = **준비·등록 완료**(⚠️미검증, 해당 OS서 실행 확인).
  - ffmpeg mac/linux = 미준비. 절차: `curl -L .../ffmpeg-static/releases/download/b6.0/ffmpeg-darwin-arm64.gz` → `gzip -d` → `chmod +x` → `shasum -a 256` → manifest.ffmpeg 에 키 추가.
  - ⚠️ 타 OS 바이너리는 그 OS 에서 실행 확인 후 배포(크로스플랫폼 검증 원칙).
