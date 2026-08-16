'use strict';
/**
 * audio-transcribe.js — 음성 파일을 글(transcript)로 바꾸는 공통 코어.
 *
 * 전 채널 공용(앱·CLI·텔레그램·디스코드). 헤드리스 채널(봇)엔 브라우저 Web Audio 가 없어
 * Node 안에서 디코딩까지 직접 한다: ogg/opus = ogg-opus-decoder(WASM), wav = 직접 파싱.
 * 그다음 16kHz 로 리샘플해 로컬 Whisper(small)로 전사한다.
 *
 * 모델 정책: 번들하지 않고 **첫 음성 때 자동 다운로드**(on-demand).
 *   - 근거: 두뇌가 전부 클라우드라 대화 자체가 이미 온라인 → "첫 음성에 모델 받기"는 오프라인 배신 아님.
 *   - 성능 낮은 base 를 기본으로 둘 이유가 없어 처음부터 small(정확)로 간다.
 *   - 저장 위치 = userData/models (설치본 app 폴더는 읽기전용). setUserModelsDir 로 주입.
 * 지원 포맷: OGG/Opus(텔레그램·디스코드 voice), WAV. mp3/m4a/영상은 ffmpeg 경유(별도).
 */
const fs = require('fs');
const path = require('path');
const assetStore = require('./asset-store');
const MANIFEST = require('./assets-manifest');

const MODEL = { id: 'Xenova/whisper-small', dtype: 'q8', sentinel: path.join('onnx', 'decoder_model_merged_quantized.onnx') };
let _userModelsDir = null; // main 이 startup 에 설정(userData/models)

const OGG_EXT = new Set(['.ogg', '.oga', '.opus']);
const WAV_EXT = new Set(['.wav', '.wave']);
const AUDIO_EXT = new Set([...OGG_EXT, ...WAV_EXT]);
const AUDIO_MIME = /^audio\/(ogg|opus|x-opus|wav|wave|x-wav|vnd\.wave)$/i;

function isAudio(name, mime) {
  const ext = path.extname(String(name || '')).toLowerCase();
  return AUDIO_EXT.has(ext) || AUDIO_MIME.test(String(mime || ''));
}

/** main 프로세스가 startup에 호출: 다운로드한 whisper 모델을 둘 userData 하위 폴더. */
function setUserModelsDir(dir) {
  if (dir && dir !== _userModelsDir) { _userModelsDir = dir; _asrPromise = null; }
}

function _modelPresent() {
  try { return !!_userModelsDir && fs.existsSync(path.join(_userModelsDir, ...MODEL.id.split('/'), MODEL.sentinel)); }
  catch (_) { return false; }
}

/* ── 디코딩 ────────────────────────────────────────────── */

// WAV(PCM 16-bit / 32-bit float) → { data:Float32(mono), rate }
function decodeWav(buf) {
  if (buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WAVE') throw new Error('WAV 형식이 아니야');
  let off = 12, rate = 16000, bits = 16, ch = 1, fmt = 1, dataOff = -1, dataLen = 0;
  while (off + 8 <= buf.length) {
    const id = buf.toString('ascii', off, off + 4);
    const sz = buf.readUInt32LE(off + 4);
    if (id === 'fmt ') { fmt = buf.readUInt16LE(off + 8); ch = buf.readUInt16LE(off + 10); rate = buf.readUInt32LE(off + 12); bits = buf.readUInt16LE(off + 22); }
    else if (id === 'data') { dataOff = off + 8; dataLen = sz; break; }
    off += 8 + sz + (sz % 2);
  }
  if (dataOff < 0) throw new Error('WAV data 청크 없음');
  const bytesPer = bits / 8, frames = Math.floor(dataLen / (bytesPer * ch)), out = new Float32Array(frames);
  for (let i = 0; i < frames; i++) {
    const p = dataOff + i * bytesPer * ch;
    let v;
    if (fmt === 3 && bits === 32) v = buf.readFloatLE(p);
    else if (bits === 16) v = buf.readInt16LE(p) / 32768;
    else if (bits === 8) v = (buf.readUInt8(p) - 128) / 128;
    else if (bits === 32) v = buf.readInt32LE(p) / 2147483648;
    else v = 0;
    out[i] = v;
  }
  return { data: out, rate };
}

// OGG/Opus → { data:Float32(mono), rate(48000) }
async function decodeOggOpus(buf) {
  const { OggOpusDecoder } = await import('ogg-opus-decoder');
  const dec = new OggOpusDecoder();
  await dec.ready;
  try {
    const { channelData, sampleRate } = await dec.decode(new Uint8Array(buf));
    if (!channelData || !channelData.length) throw new Error('opus 디코딩 결과 없음');
    return { data: channelData[0], rate: sampleRate };
  } finally { try { dec.free(); } catch (_) {} }
}

/* ── 16kHz 리샘플(안티앨리어싱) + 정규화 ──────────────────── */

function _lowpass(x, srcRate, cutoff) {
  const N = 48, fc = cutoff / srcRate;
  const h = new Float32Array(2 * N + 1); let hs = 0;
  for (let k = -N; k <= N; k++) {
    const s = k === 0 ? 2 * fc : Math.sin(2 * Math.PI * fc * k) / (Math.PI * k);
    const w = 0.54 - 0.46 * Math.cos(2 * Math.PI * (k + N) / (2 * N));
    h[k + N] = s * w; hs += h[k + N];
  }
  for (let k = 0; k < h.length; k++) h[k] /= hs;
  const out = new Float32Array(x.length);
  for (let i = 0; i < x.length; i++) {
    let acc = 0;
    for (let k = -N; k <= N; k++) { const idx = i + k; if (idx >= 0 && idx < x.length) acc += x[idx] * h[k + N]; }
    out[i] = acc;
  }
  return out;
}

function resampleTo16k(x, srcRate) {
  if (srcRate === 16000) return x;
  const src = srcRate > 16000 ? _lowpass(x, srcRate, 7200) : x;
  const ratio = 16000 / srcRate, outLen = Math.max(1, Math.floor(src.length * ratio)), out = new Float32Array(outLen);
  for (let i = 0; i < outLen; i++) {
    const t = i / ratio, i0 = Math.floor(t), frac = t - i0;
    const a = src[i0] || 0, b = (i0 + 1 < src.length) ? src[i0 + 1] : a;
    out[i] = a + (b - a) * frac;
  }
  return out;
}

function normalize(x) {
  let pk = 0;
  for (let i = 0; i < x.length; i++) { const a = Math.abs(x[i]); if (a > pk) pk = a; }
  if (pk > 0 && pk < 0.99) { const g = 0.95 / pk; for (let i = 0; i < x.length; i++) x[i] *= g; }
  return x;
}

/* ── 모델 확보(자동 다운로드) + Whisper 파이프라인 ──────────── */

let _dlPromise = null; // 동시 여러 음성이 와도 다운로드는 1회만
/** 모델이 없으면 우리 릴리스에서 자동 다운로드(검증). onStatus(msg) = "받는 중" 안내. */
async function ensureModel(onStatus) {
  if (_modelPresent()) return;
  if (!_userModelsDir) throw new Error('모델 저장 위치 미설정(setUserModelsDir)');
  if (!_dlPromise) {
    _dlPromise = assetStore.ensureZipDir({
      url: MANIFEST.whisperSmall.url,
      sha256: MANIFEST.whisperSmall.sha256,
      destDir: _userModelsDir,
      sentinel: MANIFEST.whisperSmall.sentinel,
      onStatus,
      label: '음성 인식 도구',
    }).then(() => { _asrPromise = null; }).catch(e => { _dlPromise = null; throw e; });
  }
  return _dlPromise;
}

let _asrPromise = null;
function _getAsr() {
  if (!_asrPromise) {
    _asrPromise = import('@huggingface/transformers').then(m => {
      try { if (_modelPresent()) { m.env.localModelPath = _userModelsDir; m.env.allowLocalModels = true; } } catch (_) {}
      return m.pipeline('automatic-speech-recognition', MODEL.id, { dtype: MODEL.dtype });
    }).catch(e => { _asrPromise = null; throw e; });
  }
  return _asrPromise;
}

/**
 * 음성 buffer → transcript 문자열.
 * @param {Buffer} buf  오디오 바이트
 * @param {string} name 파일명(포맷 판별)
 * @param {Object} opts { language, onStatus }  language 기본 'korean'. onStatus=모델 다운로드 안내 콜백.
 * @returns {Promise<{ text:string, durationSec:number }>}
 */
async function transcribeAudio(buf, name, opts = {}) {
  const language = opts.language || 'korean';
  const ext = path.extname(String(name || '')).toLowerCase();
  let decoded;
  if (OGG_EXT.has(ext)) decoded = await decodeOggOpus(buf);
  else if (WAV_EXT.has(ext)) decoded = decodeWav(buf);
  else { try { decoded = await decodeOggOpus(buf); } catch (_) { decoded = decodeWav(buf); } }
  const durationSec = decoded.data.length / decoded.rate;
  const audio = normalize(resampleTo16k(decoded.data, decoded.rate));
  await ensureModel(opts.onStatus); // 없으면 자동 다운로드(첫 음성)
  const asr = await _getAsr();
  const r = await asr(audio, {
    language, task: 'transcribe', chunk_length_s: 30,
    no_repeat_ngram_size: 3, condition_on_previous_text: false, temperature: 0, do_sample: false,
  });
  return { text: String(r && r.text || '').trim(), durationSec };
}

module.exports = { transcribeAudio, isAudio, setUserModelsDir };
