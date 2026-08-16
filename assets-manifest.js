'use strict';
/**
 * assets-manifest.js — 우리 공개 릴리스(getauxo/auxo-assets)에 올린 on-demand 자산 정의.
 * URL·sha256 을 핀 고정한다(제3자 rot 없음 + 무결성 검증).
 *
 * ⚠️ sha256/size 는 자산을 릴리스에 실제 올릴 때 확정한다. 준비 파일은 release-staging/ 에
 *    만들어 두고 sha256 을 계산해 여기 채운 뒤, 그 파일 그대로 릴리스에 업로드한다(파일이 곧 해시).
 *    repo 는 public 전환 후 다운로드 가능해진다(그전엔 이 URL 이 인증 필요).
 */
const REPO = 'getauxo/auxo-assets';
const TAG = 'media-v1';
const asset = (name) => `https://github.com/${REPO}/releases/download/${TAG}/${name}`;

module.exports = {
  repo: REPO,
  tag: TAG,
  // 음성 인식 모델(whisper-small q8) — zip. destDir(userData/models) 에 풀면 Xenova/whisper-small/…
  whisperSmall: {
    url: asset('whisper-small-q8.zip'),
    sha256: '79695e08e0e56325062f4b40f949fd1ba177bf8f927772d79dc370808652946d',
    sizeMB: 158,       // 압축 zip 크기(원본 241MB)
    sentinel: 'Xenova/whisper-small/onnx/decoder_model_merged_quantized.onnx',
  },
  // ffmpeg 바이너리 — 영상·mp3·m4a 디코딩용. 플랫폼별.
  ffmpeg: {
    'win32-x64': { url: asset('ffmpeg-win32-x64.exe'), sha256: '04e1307997530f9cf2fe35cba2ca7e8875ca91da02f89d6c7243df819c94ad00', sizeMB: 79 },
    // 'darwin-x64','darwin-arm64','linux-x64' 는 각 플랫폼 준비 시 추가
  },
  // yt-dlp — 유튜브 링크에서 자막·소리 추출. 유튜브 변화에 대응해 주기적 갱신 필요(태그 올려 교체).
  ytdlp: {
    'win32-x64': { url: asset('yt-dlp.exe'), sha256: '52fe3c26dcf71fbdc85b528589020bb0b8e383155cfa81b64dd447bbe35e24b8', sizeMB: 18, version: 'latest@2026-07-19' },
    // mac/linux 바이너리 준비됨(release-staging). ⚠️ 윈도우에서 받아 실행검증 미완 — 해당 OS에서 확인 필요.
    'darwin-x64': { url: asset('yt-dlp_macos'), sha256: '498bd0dae17855c599d371d68ec5bafc439a9d8640e838be25c765a9792f261b', sizeMB: 38, version: 'latest@2026-07-19' },
    'darwin-arm64': { url: asset('yt-dlp_macos'), sha256: '498bd0dae17855c599d371d68ec5bafc439a9d8640e838be25c765a9792f261b', sizeMB: 38, version: 'latest@2026-07-19' },
    'linux-x64': { url: asset('yt-dlp_linux'), sha256: '6bbb3d314cde4febe36e5fa1d55462e29c974f63444e707871834f6d8cc210ae', sizeMB: 40, version: 'latest@2026-07-19' },
  },
};
