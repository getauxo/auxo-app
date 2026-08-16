'use strict';
/**
 * media-ffmpeg.js — 영상(mp4 등)·ffmpeg가 필요한 오디오(mp3·m4a 등)에서 **소리를 추출**해
 * 16kHz mono wav 로 만든다. 그 wav 를 audio-transcribe 가 전사한다.
 *
 * ffmpeg 는 번들하지 않고 **첫 필요 시 우리 릴리스에서 자동 다운로드**(on-demand, 검증).
 *   - opus/wav 음성은 ffmpeg 없이 되므로(ogg-opus-decoder) 흔한 케이스는 이미 커버.
 *   - 영상·mp3·m4a 처럼 덜 흔한 것만 이 도구를 그때 받는다.
 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFile } = require('child_process');
const assetStore = require('./asset-store');
const MANIFEST = require('./assets-manifest');

let _userBinDir = null; // ffmpeg 바이너리를 둘 곳(userData/bin). main 이 startup 에 설정.
function setUserBinDir(dir) { _userBinDir = dir; }

const VIDEO_EXT = new Set(['.mp4', '.mov', '.mkv', '.webm', '.avi', '.m4v', '.mpeg', '.mpg', '.3gp']);
const FF_AUDIO_EXT = new Set(['.mp3', '.m4a', '.aac', '.flac', '.wma', '.amr', '.aiff', '.ac3']);

/** opus/wav(=audio-transcribe 직접 처리)를 뺀, ffmpeg 가 필요한 영상·오디오인가? */
function needsFfmpeg(name, mime) {
  const ext = path.extname(String(name || '')).toLowerCase();
  if (VIDEO_EXT.has(ext) || FF_AUDIO_EXT.has(ext)) return true;
  const m = String(mime || '');
  if (/^video\//i.test(m)) return true;
  if (/^audio\/(mpeg|mp3|mp4|aac|flac|x-ms-wma|amr|aiff|ac3|3gpp)/i.test(m)) return true;
  return false;
}

function _platformKey() { return `${process.platform}-${process.arch}`; }
function _ffPath() { return path.join(_userBinDir, process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg'); }

let _ensurePromise = null;
/** ffmpeg 바이너리 확보(없으면 우리 릴리스에서 다운로드+검증). onStatus=안내 콜백. */
async function ensureFfmpeg(onStatus) {
  if (!_userBinDir) throw new Error('도구 저장 위치 미설정(setUserBinDir)');
  const key = _platformKey();
  const entry = MANIFEST.ffmpeg[key];
  if (!entry) throw new Error(`이 시스템(${key})에서 쓸 영상 처리 도구가 아직 준비되지 않았어요.`);
  if (!_ensurePromise) {
    _ensurePromise = assetStore.ensureFile({
      url: entry.url, sha256: entry.sha256, dest: _ffPath(), mode: 0o755,
      onStatus, label: '영상·음악 처리 도구',
    }).catch(e => { _ensurePromise = null; throw e; });
  }
  await _ensurePromise;
  return _ffPath();
}

/** 영상/오디오 buffer → 16kHz mono wav Buffer. */
async function toWav16k(inputBuf, name, onStatus) {
  const ff = await ensureFfmpeg(onStatus);
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'auxo-ff-'));
  const inPath = path.join(tmp, 'in' + (path.extname(String(name || '')) || '.bin'));
  const outPath = path.join(tmp, 'out.wav');
  fs.writeFileSync(inPath, inputBuf);
  try {
    if (onStatus) onStatus('소리를 뽑아내는 중이에요…');
    await new Promise((resolve, reject) => {
      execFile(ff, ['-y', '-i', inPath, '-vn', '-ac', '1', '-ar', '16000', '-f', 'wav', outPath],
        { timeout: 300000, windowsHide: true }, (err) => err ? reject(new Error('소리 추출 실패: ' + err.message)) : resolve());
    });
    if (!fs.existsSync(outPath) || fs.statSync(outPath).size < 64) throw new Error('추출된 소리가 없어(무음이거나 오디오 트랙 없음)');
    return fs.readFileSync(outPath);
  } finally { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (_) {} }
}

module.exports = { needsFfmpeg, ensureFfmpeg, toWav16k, setUserBinDir };
