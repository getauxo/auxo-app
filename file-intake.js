'use strict';
/**
 * file-intake.js — 사용자가 보낸 파일을 "에이전트 입력"으로 변환하는 공통 코어.
 * 앱·텔레그램·CLI 세 채널이 공유한다(채널 동등성). 채널은 파일 바이트만 넘기고,
 * 여기서 종류를 판별해 처리 방식을 결정한다:
 *   - 이미지·PDF   → 멀티모달 attachment(두뇌가 직접 봄)
 *   - 텍스트/코드류 → 내용을 추출해 프롬프트에 인라인
 *   - 기타 바이너리 → 허용폴더에 저장(가능하면) 후 경로 안내
 */
const fs = require('fs');
const path = require('path');
const yauzl = require('yauzl'); // docx·xlsx·pptx = zip 컨테이너 → 내부 XML에서 텍스트 추출
const audioTranscribe = require('./audio-transcribe'); // 음성(ogg/opus/wav) → 로컬 Whisper 전사(전 채널 공용)
const mediaFfmpeg = require('./media-ffmpeg'); // 영상·mp3·m4a → ffmpeg 로 소리 추출(on-demand)

const MAX_BYTES = 20 * 1024 * 1024; // 20MB (텔레그램 봇 수신 한계에 맞춤, 전 채널 공통)
const TEXT_MAX_CHARS = 100000;      // 내용 인라인 상한(초과 시 앞부분만)

// Office 문서(내용 추출 대상). 완벽한 서식이 아니라 "글/표 텍스트" 추출.
const OFFICE_EXT = new Set(['.docx', '.xlsx', '.pptx']);

/** zip buffer에서 wantFn(파일명)이 true인 엔트리들을 {이름: utf8텍스트}로 읽는다. (yauzl, Promise) */
function _readZipEntries(buf, wantFn) {
  return new Promise((resolve, reject) => {
    yauzl.fromBuffer(buf, { lazyEntries: true }, (err, zip) => {
      if (err || !zip) return reject(err || new Error('zip 열기 실패'));
      const out = {};
      zip.on('entry', (entry) => {
        if (!wantFn(entry.fileName)) { zip.readEntry(); return; }
        zip.openReadStream(entry, (e, rs) => {
          if (e || !rs) { zip.readEntry(); return; }
          const chunks = [];
          rs.on('data', c => chunks.push(c));
          rs.on('end', () => { out[entry.fileName] = Buffer.concat(chunks).toString('utf8'); zip.readEntry(); });
          rs.on('error', () => zip.readEntry());
        });
      });
      zip.on('end', () => resolve(out));
      zip.on('error', reject);
      zip.readEntry();
    });
  });
}

/** OOXML 조각에서 태그 제거 + 엔티티 복원. docx 단락(</w:p>)은 개행으로. */
function _xmlToText(xml) {
  return String(xml || '')
    .replace(/<\/w:p>/g, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&apos;/g, "'")
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** docx/xlsx/pptx buffer에서 텍스트를 추출한다. 실패·빈내용이면 ''. */
async function _extractOfficeText(buf, ext) {
  if (ext === '.docx') {
    const e = await _readZipEntries(buf, n => n === 'word/document.xml');
    return _xmlToText(e['word/document.xml'] || '');
  }
  if (ext === '.pptx') {
    const e = await _readZipEntries(buf, n => /^ppt\/slides\/slide\d+\.xml$/.test(n));
    const names = Object.keys(e).sort((a, b) => {
      const na = parseInt((a.match(/(\d+)/) || [])[1] || '0', 10);
      const nb = parseInt((b.match(/(\d+)/) || [])[1] || '0', 10);
      return na - nb;
    });
    return names.map(n => _xmlToText(e[n])).filter(Boolean).join('\n\n');
  }
  if (ext === '.xlsx') {
    const e = await _readZipEntries(buf, n => n === 'xl/sharedStrings.xml' || /^xl\/worksheets\/sheet\d+\.xml$/.test(n));
    // 공유 문자열 테이블
    const shared = [];
    const ss = e['xl/sharedStrings.xml'];
    if (ss) {
      const items = ss.match(/<si>[\s\S]*?<\/si>/g) || [];
      for (const si of items) shared.push(_xmlToText(si));
    }
    // 시트별 행·셀 → 탭 구분 표
    const sheetNames = Object.keys(e).filter(n => /sheet\d+\.xml$/.test(n)).sort();
    const lines = [];
    for (const sn of sheetNames) {
      const rows = (e[sn] || '').match(/<row[\s\S]*?<\/row>/g) || [];
      for (const row of rows) {
        const cells = row.match(/<c[^>]*\/>|<c[^>]*>[\s\S]*?<\/c>/g) || [];
        const vals = [];
        for (const c of cells) {
          const inline = c.match(/<t[^>]*>([\s\S]*?)<\/t>/);
          const vm = c.match(/<v>([\s\S]*?)<\/v>/);
          if (inline) vals.push(_xmlToText(inline[1]));
          else if (vm) {
            const raw = _xmlToText(vm[1]);
            if (/t="s"/.test(c)) { const idx = parseInt(raw, 10); vals.push(shared[idx] != null ? shared[idx] : ''); }
            else vals.push(raw);
          } else vals.push('');
        }
        if (vals.some(v => v !== '')) lines.push(vals.join('\t'));
      }
    }
    if (lines.length) return lines.join('\n');
    return shared.join(' '); // 폴백: 표 복원 실패 시 문자열이라도
  }
  return '';
}

const IMAGE_MIME = /^image\/(png|jpe?g|gif|webp|heic|heif)$/i;
const PDF_MIME = /^application\/pdf$/i;
// 내용을 그대로 읽을 수 있는 텍스트/코드 확장자
const TEXT_EXT = new Set([
  '.txt', '.md', '.markdown', '.csv', '.tsv', '.json', '.jsonl', '.log', '.xml',
  '.yml', '.yaml', '.ini', '.toml', '.env', '.sql', '.sh', '.bat', '.ps1',
  '.js', '.ts', '.jsx', '.tsx', '.py', '.java', '.c', '.cpp', '.h', '.hpp',
  '.cs', '.go', '.rb', '.php', '.rs', '.kt', '.swift', '.css', '.scss', '.html', '.htm',
]);

function _extOf(name) { return path.extname(String(name || '')).toLowerCase(); }

/** 확장자·주어진 값으로 mime 추정 */
function _guessMime(name, given) {
  if (given && given !== 'application/octet-stream') return given;
  if (/\.png$/i.test(name)) return 'image/png';
  if (/\.jpe?g$/i.test(name)) return 'image/jpeg';
  if (/\.gif$/i.test(name)) return 'image/gif';
  if (/\.webp$/i.test(name)) return 'image/webp';
  if (/\.(heic|heif)$/i.test(name)) return 'image/heic';
  if (/\.pdf$/i.test(name)) return 'application/pdf';
  return given || 'application/octet-stream';
}

/**
 * 파일 하나를 에이전트 입력으로 분류·변환.
 * @param {Object} input { name, mimeType?, buffer(Buffer) }
 * @param {Object} opts  { saveDir? }  // 기타 바이너리를 저장할 허용폴더(없으면 안내만)
 * @returns {Object}
 *   { kind:'multimodal', attachment:{ name, mimeType, data(base64) } }
 *   { kind:'text', name, text }
 *   { kind:'saved', name, savedPath }
 *   { kind:'note', name, note }
 *   { error }
 */
async function intakeFile(input, opts = {}) {
  const name = (String(input && input.name || '').trim()) || 'file';
  const buf = input && input.buffer;
  if (!Buffer.isBuffer(buf)) return { error: '파일 데이터가 없어.' };
  if (buf.length === 0) return { error: '빈 파일이야.' };
  if (buf.length > MAX_BYTES) {
    return { error: `파일이 너무 커 (${Math.round(buf.length / 1048576)}MB). 지금은 20MB까지만 받을 수 있어.` };
  }
  const mime = _guessMime(name, input.mimeType);

  // 1) 이미지·PDF → 멀티모달(두뇌가 직접 봄)
  if (IMAGE_MIME.test(mime) || PDF_MIME.test(mime)) {
    return { kind: 'multimodal', attachment: { name, mimeType: mime, data: buf.toString('base64') } };
  }
  // 1.4) 음성(ogg/opus/wav) → 로컬 Whisper 로 전사해 인라인. 전 채널 공용(텔레그램·디스코드 voice 포함).
  if (audioTranscribe.isAudio(name, mime)) {
    try {
      const { text, durationSec } = await audioTranscribe.transcribeAudio(buf, name, { onStatus: opts.onStatus });
      if (text && text.trim()) return { kind: 'transcript', name, durationSec, text };
      return { kind: 'note', name, note: `음성 파일 "${name}"을 받았는데 말소리를 알아듣지 못했어(무음이거나 잡음일 수 있어).` };
    } catch (e) {
      return { kind: 'note', name, note: `음성 파일 "${name}"을 받았지만 전사에 실패했어(${e.message}).` };
    }
  }
  // 1.45) 영상(mp4 등)·mp3·m4a → ffmpeg 로 소리 추출 → 전사. ffmpeg 는 첫 필요 시 자동 다운로드.
  if (mediaFfmpeg.needsFfmpeg(name, mime)) {
    try {
      const wav = await mediaFfmpeg.toWav16k(buf, name, opts.onStatus);
      const { text, durationSec } = await audioTranscribe.transcribeAudio(wav, 'extracted.wav', { onStatus: opts.onStatus });
      if (text && text.trim()) return { kind: 'transcript', name, durationSec, text };
      return { kind: 'note', name, note: `"${name}"에서 말소리를 찾지 못했어(음성이 없거나 무음일 수 있어).` };
    } catch (e) {
      return { kind: 'note', name, note: `"${name}"을 받았지만 처리에 실패했어(${e.message}).` };
    }
  }
  // 1.5) Office 문서(docx·xlsx·pptx) → zip 풀어 텍스트 추출해 인라인. 실패 시 아래 저장 폴백.
  if (OFFICE_EXT.has(_extOf(name))) {
    try {
      let text = await _extractOfficeText(buf, _extOf(name));
      if (text && text.trim()) {
        let truncated = false;
        if (text.length > TEXT_MAX_CHARS) { text = text.slice(0, TEXT_MAX_CHARS); truncated = true; }
        return { kind: 'text', name, text, truncated };
      }
    } catch (_) { /* 추출 실패 → 아래 기타 바이너리 저장 폴백 */ }
  }
  // 2) 텍스트/코드류 → 내용 추출해 인라인
  if (TEXT_EXT.has(_extOf(name)) || /^text\//i.test(mime)) {
    let text = buf.toString('utf8');
    let truncated = false;
    if (text.length > TEXT_MAX_CHARS) { text = text.slice(0, TEXT_MAX_CHARS); truncated = true; }
    return { kind: 'text', name, text, truncated };
  }
  // 3) 기타 바이너리 → 허용폴더 저장(가능하면), 아니면 안내
  if (opts.saveDir) {
    try {
      // 경로탈출 차단: basename 으로 디렉토리부분 제거 + 금지문자·선행점 정화
      const safe = (path.basename(name).replace(/[\\/:*?"<>|]/g, '_').replace(/^\.+/, '')) || 'file';
      const dest = path.join(opts.saveDir, safe);
      fs.writeFileSync(dest, buf);
      return { kind: 'saved', name, savedPath: dest };
    } catch (e) {
      return { kind: 'note', name, note: `파일 "${name}"을 받았는데 저장에 실패했어(${e.message}).` };
    }
  }
  return { kind: 'note', name, note: `파일 "${name}"(${mime})을 받았어. 지금은 이 형식을 직접 열어보진 못해 — 이미지·PDF나 텍스트/코드 파일이면 내용을 볼 수 있어.` };
}

/** intake 결과를 "userPrompt에 덧붙일 문구 + 멀티모달 attachments"로 조립(채널 공통 헬퍼). */
function buildPromptParts(results) {
  const attachments = [];
  const notes = [];
  for (const r of (results || [])) {
    if (!r || r.error) { if (r && r.error) notes.push(`(첨부 처리 실패: ${r.error})`); continue; }
    if (r.kind === 'multimodal') { attachments.push(r.attachment); notes.push(`[첨부: ${r.attachment.name} — 이미지/문서로 첨부됨]`); }
    else if (r.kind === 'text') { notes.push(`[첨부파일 "${r.name}" 내용${r.truncated ? '(앞부분만)' : ''}]\n${r.text}`); }
    else if (r.kind === 'transcript') { notes.push(`[사용자가 보낸 "${r.name}"(${Math.round(r.durationSec)}초)의 말소리를 글로 옮김. 아래가 그 내용이야]\n${r.text}`); }
    else if (r.kind === 'saved') { notes.push(`[첨부파일 "${r.name}"을 받아서 ${r.savedPath} 에 저장함]`); }
    else if (r.kind === 'note') { notes.push(`[${r.note}]`); }
  }
  return { attachments, noteText: notes.join('\n\n') };
}

module.exports = { intakeFile, buildPromptParts, MAX_BYTES };
