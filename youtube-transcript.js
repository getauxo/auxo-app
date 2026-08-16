'use strict';
/**
 * youtube-transcript.js — 유튜브 URL → 내용(자막 또는 소리 전사).
 *
 * 방식: yt-dlp(온디맨드 자산)로 처리.
 *   1) 자막이 있으면 → 자막(vtt)을 받아 텍스트로. 빠름(영상 안 받음).
 *   2) 자막이 없으면 → 소리만 받아(ffmpeg로 16k wav) → whisper 전사. 느리지만 됨.
 * 왜 yt-dlp: 유튜브가 서버측 자막 접근을 막아(HTTP 직접 스크래핑은 빈 응답) yt-dlp만 견고.
 * 한계(정직): 유튜브가 계속 방어를 바꿔 100%는 아니며, yt-dlp 주기적 갱신이 필요하다.
 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFile } = require('child_process');
const assetStore = require('./asset-store');
const MANIFEST = require('./assets-manifest');

let _userBinDir = null; // yt-dlp 바이너리 위치(userData/bin). main 이 startup 에 설정.
function setUserBinDir(dir) { _userBinDir = dir; }

const YT_RE = /(?:youtube\.com\/(?:watch\?[^\s]*?v=|shorts\/|embed\/|live\/)|youtu\.be\/)([A-Za-z0-9_-]{11})/;
function extractVideoId(text) { const m = String(text || '').match(YT_RE); return m ? m[1] : null; }
function hasYoutube(text) { return YT_RE.test(String(text || '')); }
function _url(text) {
  const m = String(text || '').match(/https?:\/\/[^\s]*(?:youtube\.com|youtu\.be)[^\s]*/i);
  if (m) return m[0];
  const id = extractVideoId(text);
  return id ? `https://www.youtube.com/watch?v=${id}` : null;
}

function _platformKey() { return `${process.platform}-${process.arch}`; }
function _ytPath() { return path.join(_userBinDir, process.platform === 'win32' ? 'yt-dlp.exe' : 'yt-dlp'); }

let _ensure = null;
async function ensureYtdlp(onStatus) {
  if (!_userBinDir) throw new Error('도구 저장 위치 미설정(setUserBinDir)');
  const e = MANIFEST.ytdlp[_platformKey()];
  if (!e) throw new Error(`이 시스템(${_platformKey()})에서 쓸 유튜브 도구가 아직 준비되지 않았어요.`);
  if (!_ensure) _ensure = assetStore.ensureFile({ url: e.url, sha256: e.sha256, dest: _ytPath(), mode: 0o755, onStatus, label: '유튜브 도구' }).catch(err => { _ensure = null; throw err; });
  await _ensure;
  return _ytPath();
}

function _run(bin, args, timeout) {
  return new Promise((resolve, reject) => {
    execFile(bin, args, { timeout: timeout || 90000, windowsHide: true, maxBuffer: 8 * 1024 * 1024 },
      (err, stdout, stderr) => err ? reject(new Error((stderr || err.message || '').slice(0, 200))) : resolve({ stdout, stderr }));
  });
}

// VTT → 순수 텍스트(타임스탬프·태그·중복 제거). 자동자막의 롤링 중복도 정리.
function _parseVtt(vtt) {
  const out = [];
  for (let ln of String(vtt || '').split(/\r?\n/)) {
    const t = ln.trim();
    if (!t) continue;
    if (t.startsWith('WEBVTT') || /^(Kind|Language|NOTE|STYLE|::cue)/.test(t)) continue;
    if (t.includes('-->') || /^\d+$/.test(t)) continue;
    const clean = t.replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/\s+/g, ' ').trim();
    if (!clean) continue;
    if (out.length && out[out.length - 1] === clean) continue;        // 연속 완전중복
    if (out.length && clean.startsWith(out[out.length - 1])) { out[out.length - 1] = clean; continue; } // 롤링(앞줄 확장)
    out.push(clean);
  }
  return out.join(' ').replace(/\s+/g, ' ').trim();
}

function _pickVtt(files) {
  const score = (f) => {
    let s = 0;
    if (/\.ko(\b|[.-])/.test(f)) s += 100; else if (/\.en(\b|[.-])/.test(f)) s += 50;
    if (!/auto|orig/.test(f)) s += 10; // 수동 자막 우선
    return s;
  };
  return files.filter(f => f.endsWith('.vtt')).sort((a, b) => score(b) - score(a))[0] || null;
}

/**
 * 유튜브 링크 텍스트 → { title, text, source }.  실패 시 throw.
 * @param {string} text 유튜브 링크가 든 문자열
 * @param {Object} opts { onStatus, allowAudio=true }  allowAudio: 자막 없을 때 소리 전사 폴백 허용
 */
async function fetchTranscript(text, opts = {}) {
  const url = _url(text);
  if (!url) throw new Error('유튜브 주소를 못 찾았어');
  const yt = await ensureYtdlp(opts.onStatus);
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'auxo-yt-'));
  try {
    if (opts.onStatus) opts.onStatus('유튜브에서 내용을 가져오는 중…');
    let title = '', durationSec = 0;
    try {
      const { stdout } = await _run(yt, ['--skip-download', '--print', '%(title)s\n%(duration)s', url], 40000);
      const parts = String(stdout || '').trim().split('\n');
      title = parts[0] || '';
      durationSec = parseInt(parts[1], 10) || 0;
    } catch (_) {}
    // 1) 자막 시도
    await _run(yt, ['--skip-download', '--write-subs', '--write-auto-subs', '--sub-langs', 'ko.*,en.*', '--sub-format', 'vtt', '-o', path.join(tmp, '%(id)s.%(ext)s'), url], 60000).catch(() => {});
    const vtt = _pickVtt(fs.readdirSync(tmp));
    if (vtt) {
      const t = _parseVtt(fs.readFileSync(path.join(tmp, vtt), 'utf8'));
      if (t) return { title, text: t, source: '자막' };
    }
    // 2) 자막 없음 → 소리 받아 whisper 전사(폴백)
    const MAX_AUDIO_SEC = 1800; // 30분 초과 영상은 소리 다운로드+전사가 너무 오래 걸려 막는다
    if (opts.allowAudio !== false && durationSec > MAX_AUDIO_SEC) {
      throw new Error(`이 영상은 자막이 없고 길이가 길어(${Math.round(durationSec / 60)}분) 소리로 옮기기엔 너무 오래 걸려. 자막 있는 영상이면 바로 돼.`);
    }
    if (opts.allowAudio !== false) {
      if (opts.onStatus) opts.onStatus('자막이 없어 소리를 받아 옮기는 중… (조금 더 걸려요)');
      await _run(yt, ['-f', 'bestaudio/best', '-o', path.join(tmp, 'a.%(ext)s'), url], 180000);
      const af = fs.readdirSync(tmp).find(f => /^a\./.test(f));
      if (af) {
        const mediaFfmpeg = require('./media-ffmpeg');
        const audioTranscribe = require('./audio-transcribe');
        const wav = await mediaFfmpeg.toWav16k(fs.readFileSync(path.join(tmp, af)), af, opts.onStatus);
        const r = await audioTranscribe.transcribeAudio(wav, 'extracted.wav', { onStatus: opts.onStatus });
        if (r.text) return { title, text: r.text, source: '소리 전사' };
      }
    }
    throw new Error('자막도 없고 소리도 가져오지 못했어');
  } finally { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (_) {} }
}

module.exports = { fetchTranscript, extractVideoId, hasYoutube, setUserBinDir, ensureYtdlp };
