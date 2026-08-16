/**
 * bot-telegram.js — 텔레그램 봇 커넥터 (의존성 0, https 직접)
 *
 * 앱·CLI 와 같은 engine.js 를 재사용한다. 봇은 "어느 에이전트(데이터폴더+id)에 연결"만 가리키면
 * 그 에이전트로서 텔레그램에서 대화한다. 대화·기억은 그 에이전트에 그대로 쌓인다(같은 정체성의 또 다른 창구).
 *
 * 1봇 = 1에이전트. PC 가 켜져 있을 때만 동작(로컬 polling). 주인(allowlist)만 응답.
 *
 * 두 가지로 쓴다:
 *  (a) standalone:  node bot-telegram.js   (telegram-bot.json / env 설정 읽어 실행)
 *  (b) CLI 내장:     cli.js 가 startBot(cfg) 를 백그라운드로 호출 → 대화하면서 텔레그램도 동시
 *
 * 설정: telegram-bot.json { token, dataPath, agentId, ownerId? }  (env: AUXO_BOT_TOKEN/DATA/AGENT/CONFIG)
 */
'use strict';
const https = require('https');
const fs = require('fs');
const path = require('path');
const os = require('os');
const storage = require('./storage');
const attachStore = require('./attachment-store'); // 받은 첨부 원본을 download 폴더에 보관(에이전트 접근 가능)
const engine = require('./engine');
const { intakeFile, buildPromptParts } = require('./file-intake'); // 파일 첨부 공통 코어

// standalone 실행 때만 내부 디버그 로그 숨김(CLI 내장 시엔 CLI 가 이미 처리).
if (require.main === module && !process.env.AUXO_DEBUG) {
  const hide = (orig) => (...a) => {
    const s = (a.length && typeof a[0] === 'string') ? a[0] : '';
    if (/^\s*\[[a-zA-Z]/.test(s)) return;
    orig.apply(console, a);
  };
  console.log = hide(console.log); console.warn = hide(console.warn); console.error = hide(console.error);
}

// ── 설정 ────────────────────────────────────────────────────────────────
function configPath() {
  return process.env.AUXO_BOT_CONFIG || path.join(os.homedir(), '.auxo-cli', 'telegram-bot.json');
}
function loadConfig() {
  let cfg = {};
  try { cfg = JSON.parse(fs.readFileSync(configPath(), 'utf8')); } catch (_) {}
  cfg.token = process.env.AUXO_BOT_TOKEN || cfg.token;
  cfg.dataPath = process.env.AUXO_BOT_DATA || cfg.dataPath;
  cfg.agentId = process.env.AUXO_BOT_AGENT || cfg.agentId;
  return cfg;
}
function saveConfig(cfg) {
  try {
    const out = { token: cfg.token, dataPath: cfg.dataPath, agentId: cfg.agentId };
    if (cfg.ownerId) out.ownerId = cfg.ownerId;
    fs.writeFileSync(cfg.configPath || configPath(), JSON.stringify(out, null, 2), 'utf8'); // 앱은 cfg.configPath 로 별도 저장
  } catch (_) {}
}
/** 지정 경로(또는 기본)의 봇 설정 읽기. 앱이 상태 복원용으로 사용. */
function readConfig(p) {
  try { return JSON.parse(fs.readFileSync(p || configPath(), 'utf8')); } catch (_) { return {}; }
}

// ── 텔레그램 Bot API (https 직접) ───────────────────────────────────────
function tgGet(token, method, query) {
  const qs = query ? '?' + new URLSearchParams(query).toString() : '';
  return new Promise((res, rej) => {
    https.get(`https://api.telegram.org/bot${token}/${method}${qs}`, r => {
      let d = ''; r.on('data', c => d += c); r.on('end', () => { try { res(JSON.parse(d)); } catch (e) { rej(e); } });
    }).on('error', rej);
  });
}
function tgPost(token, method, body) {
  const data = JSON.stringify(body);
  return new Promise((res, rej) => {
    const req = https.request(`https://api.telegram.org/bot${token}/${method}`,
      { method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } },
      r => { let d = ''; r.on('data', c => d += c); r.on('end', () => { try { res(JSON.parse(d)); } catch (e) { rej(e); } }); });
    req.on('error', rej); req.write(data); req.end();
  });
}
const send = (token, chatId, text) => tgPost(token, 'sendMessage', { chat_id: chatId, text: String(text || '').slice(0, 4000) });

// 실행 중인 봇으로 주인에게 먼저 보내기(예약 결과 push 등). startBot 시 _active 설정.
let _active = null;
// 텔레그램 파일 다운로드: file_id → getFile → 실제 바이트(Buffer)
function tgDownload(token, filePath) {
  return new Promise((resolve, reject) => {
    https.get(`https://api.telegram.org/file/bot${token}/${filePath}`, r => {
      if (r.statusCode !== 200) { r.resume(); reject(new Error('다운로드 실패 HTTP ' + r.statusCode)); return; }
      const chunks = [];
      r.on('data', d => chunks.push(d));
      r.on('end', () => resolve(Buffer.concat(chunks)));
      r.on('error', reject);
    }).on('error', reject);
  });
}
async function tgFileBuffer(token, fileId) {
  const info = await tgGet(token, 'getFile', { file_id: fileId });
  if (!info || !info.ok || !info.result || !info.result.file_path) throw new Error('파일 정보를 못 받음');
  return tgDownload(token, info.result.file_path);
}
// 파일 전송(sendDocument) — multipart/form-data 수동 조립(의존성 0)
function tgSendDocument(token, chatId, filePath, caption) {
  return new Promise((resolve, reject) => {
    let fileData;
    try { fileData = fs.readFileSync(filePath); } catch (e) { reject(e); return; }
    const boundary = '----auxo' + Date.now() + Math.floor(Math.random() * 1e6);
    const fileName = path.basename(filePath);
    const pre = [];
    pre.push(`--${boundary}\r\nContent-Disposition: form-data; name="chat_id"\r\n\r\n${chatId}\r\n`);
    if (caption) pre.push(`--${boundary}\r\nContent-Disposition: form-data; name="caption"\r\n\r\n${caption}\r\n`);
    pre.push(`--${boundary}\r\nContent-Disposition: form-data; name="document"; filename="${fileName}"\r\nContent-Type: application/octet-stream\r\n\r\n`);
    const body = Buffer.concat([Buffer.from(pre.join(''), 'utf8'), fileData, Buffer.from(`\r\n--${boundary}--\r\n`, 'utf8')]);
    const req = https.request(`https://api.telegram.org/bot${token}/sendDocument`, {
      method: 'POST',
      headers: { 'Content-Type': `multipart/form-data; boundary=${boundary}`, 'Content-Length': body.length },
    }, r => {
      let d = ''; r.on('data', c => d += c);
      r.on('end', () => { try { const j = JSON.parse(d); j.ok ? resolve(j) : reject(new Error(j.description || ('HTTP ' + r.statusCode))); } catch (e) { reject(e); } });
    });
    req.on('error', reject);
    req.write(body); req.end();
  });
}

async function sendToOwner(text) {
  if (!_active || !_active.token || !_active.ownerId) return { ok: false, error: '봇이 연결 안 됐거나 주인이 없어요' };
  try { const r = await send(_active.token, _active.ownerId, text); return { ok: !!(r && r.ok), result: r }; }
  catch (e) { return { ok: false, error: e.message }; }
}

/** 토큰 유효성 확인. 유효하면 봇 정보(result), 아니면 null. */
async function verifyToken(token) {
  const me = await tgGet(token, 'getMe').catch(() => null);
  return (me && me.ok) ? me.result : null;
}

/**
 * long polling 루프. CLI 내장 시 await 하지 말고 백그라운드로 띄운다(무한 루프).
 * @param {object} cfg  { token, dataPath, agentId, ownerId? }
 * @param {object} [opts] { log, stop:()=>boolean }
 */
async function startBot(cfg, opts = {}) {
  const log = opts.log || (() => {});
  storage.init(cfg.dataPath);
  _active = cfg; // 예약 결과 등을 이 봇으로 push (cfg.ownerId는 첫 메시지 때 채워짐)
  const agent = storage.loadAgent(cfg.agentId);
  if (!agent) throw new Error('에이전트를 찾을 수 없어요: ' + cfg.agentId);

  let offset = 0;
  while (!(opts.stop && opts.stop())) {
    let updates;
    try { updates = await tgGet(cfg.token, 'getUpdates', { offset, timeout: 30 }); }
    catch (_) { await new Promise(r => setTimeout(r, 2000)); continue; }
    if (!updates || !updates.ok) { await new Promise(r => setTimeout(r, 2000)); continue; }

    for (const u of updates.result) {
      offset = u.update_id + 1;
      const msg = u.message;
      if (!msg) continue; // 텍스트 없어도 사진·문서면 처리(아래)
      const fromId = String(msg.from && msg.from.id);
      const chatId = msg.chat.id;

      // 주인 자동 등록(첫 메시지 보낸 사람) — 비개발자 친화: 코드 입력 없이 등록.
      if (!cfg.ownerId) {
        cfg.ownerId = fromId; saveConfig(cfg);
        log('  텔레그램 주인 등록됨: ' + fromId);
        await send(cfg.token, chatId, `안녕하세요! 이제부터 제가 "${agent.name}"로서 함께할게요. 무엇이든 편하게 말씀해 주세요.`);
        if (msg.text === '/start') continue;
      }
      if (cfg.ownerId !== fromId) continue; // 주인 아니면 무시(보안)

      if (msg.text === '/start') { await send(cfg.token, chatId, `${agent.name}예요. 무엇이든 말씀해 주세요.`); continue; }

      // 파일 첨부(사진·문서) 수신 → file-intake 공통 코어로 처리
      let userMessage = msg.text || '';
      let attachments, userFiles;
      // 음성/영상/유튜브 도구 다운로드 등 "받는 중" 안내 — 스팸 방지로 첫 1회만.
      let _statusSent = false;
      const notifyStatus = (m) => { if (_statusSent || !m) return; _statusSent = true; send(cfg.token, chatId, '⏳ ' + m).catch(() => {}); };
      const fileObj = msg.document || (Array.isArray(msg.photo) && msg.photo.length ? msg.photo[msg.photo.length - 1] : null);
      if (fileObj && fileObj.file_id) {
        tgPost(cfg.token, 'sendChatAction', { chat_id: chatId, action: 'upload_document' }).catch(() => {});
        let buf;
        try { buf = await tgFileBuffer(cfg.token, fileObj.file_id); }
        catch (e) { await send(cfg.token, chatId, '파일을 받는 데 문제가 있었어요: ' + e.message); continue; }
        const name = msg.document ? (msg.document.file_name || 'file') : `photo_${Date.now()}.jpg`;
        const mimeType = msg.document ? msg.document.mime_type : 'image/jpeg';
        const intake = await intakeFile({ name, mimeType, buffer: buf }, { onStatus: notifyStatus }); // 두뇌 입력 변환(원본 저장은 아래 download가 담당)
        if (intake.error) { await send(cfg.token, chatId, intake.error); continue; }
        // 받은 파일 원본을 download 폴더에 종류 무관 보관 → 허용경계 포함이라 에이전트가 read_file/send_file로 다룰 수 있음
        const dlDir = path.join(path.dirname(storage.getDataPath()), 'download');
        const saved = attachStore.saveAttachment(dlDir, name, buf);
        const parts = buildPromptParts([intake]);
        attachments = parts.attachments;
        const cap = msg.caption || msg.text || '';
        userMessage = cap + (parts.noteText ? (cap ? '\n\n' : '') + parts.noteText : '');
        if (saved && !saved.error) {
          userMessage += (userMessage ? '\n\n' : '') + `[받은 파일 "${saved.name}"을 ${saved.path} 에 저장함 — 필요하면 read_file/send_file로 다룰 수 있어]`;
          userFiles = [{ path: saved.path, name: saved.name, size: saved.size, isImage: /^image\//.test(mimeType) || /\.(png|jpe?g|gif|webp)$/i.test(saved.name) }]; // 구독두뇌 비전(경로로 이미지 보기) — 앱과 동등
        }
        else if (saved && saved.error) userMessage += (userMessage ? '\n\n' : '') + `(시스템 안내: ${saved.error})`;
      }
      if (!userMessage && !(attachments && attachments.length)) continue; // 텍스트도 파일도 없음

      // ★"입력 중" 표시를 **응답이 끝날 때까지 유지**한다.
      //   텔레그램의 chat action 은 **5초만** 살아 있다(공식 규격). 그런데 우리는 턴 시작에
      //   딱 한 번만 보내고 있었다. 실측: 응답이 **14~24초** 걸리므로 5초 뒤 표시가 사라지고
      //   나머지 10~20초는 **아무 표시 없이 조용**했다 — 사용자는 답이 오는지 모른 채 기다린다.
      //   (없으면 사용자는 *"작성중 같은 게 안 뜬다"*고 느낀다)
      //   → 4초마다 다시 보내 끊기지 않게 한다. 파일 전송 중엔 그쪽 action 이 따로 나간다.
      const 타이핑유지 = (() => {
        const tick = () => tgPost(cfg.token, 'sendChatAction', { chat_id: chatId, action: 'typing' }).catch(() => {});
        tick();
        const id = setInterval(tick, 4000);
        if (id.unref) id.unref();          // 이 타이머 때문에 프로세스가 안 죽는 일 없게
        return () => clearInterval(id);
      })();
      let r;
      try {
        r = await engine.runTurn({
          agentId: cfg.agentId, userMessage, attachments, userFiles,
          emit: (ch, p) => { if (ch === 'status' && p && p.text) notifyStatus(p.text); }, // 유튜브 등 "받는 중"
          deliverFile: async ({ path: fp, name, note }) => {
            tgPost(cfg.token, 'sendChatAction', { chat_id: chatId, action: 'upload_document' }).catch(() => {});
            try { await tgSendDocument(cfg.token, chatId, fp, note); }
            catch (e) { return { error: `파일 "${name}"을 보내려다 실패했어: ${e.message}` }; }
          },
        });
      }
      catch (e) { await send(cfg.token, chatId, '잠시 문제가 있었어요. 다시 한번 말씀해 주실래요?'); continue; }
      finally { 타이핑유지(); }   // ★성공·실패·예외 어느 쪽이든 반드시 멈춘다(타이머가 남으면 계속 "입력 중")
                                  //   (catch 의 continue 보다 finally 가 먼저 돈다 — 여기 한 곳이면 충분)
      const body = r.response || r.error || '...'; await send(cfg.token, chatId, body); // 정직 계층 ③: 도구 배지를 상시 표시하지 않는다
      // 앱이 켜져 있으면 그 대화를 앱 채팅창에도 실시간 반영(같은 프로세스, "통합 홈")
      if (opts.onExchange) { try { opts.onExchange({ agentId: cfg.agentId, userMessage, response: body }); } catch (_) {} }
      if (r.generate) {
        engine.processMemory({ agentId: cfg.agentId, userMessage, response: r.response, generate: r.generate, rememberedAny: r.rememberedAny, emit: () => {} }).catch(() => {});
      }
    }
  }
}

// ── standalone 실행 (node bot-telegram.js) ──────────────────────────────
async function main() {
  const cfg = loadConfig();
  if (!cfg.token) { console.error('❌ 텔레그램 봇 토큰이 없어요. telegram-bot.json 의 token 또는 AUXO_BOT_TOKEN 을 설정해 주세요.'); process.exit(1); }
  if (!cfg.dataPath || !cfg.agentId) { console.error('❌ 연결할 에이전트가 없어요. dataPath 와 agentId 를 설정해 주세요.'); process.exit(1); }
  storage.initOrExit(cfg.dataPath);
  const agent = storage.loadAgent(cfg.agentId);
  if (!agent) { console.error('❌ 에이전트를 찾을 수 없어요: ' + cfg.agentId); process.exit(1); }
  const me = await verifyToken(cfg.token);
  if (!me) { console.error('❌ 봇 토큰이 올바르지 않아요. BotFather 에서 받은 토큰을 다시 확인해 주세요.'); process.exit(1); }
  console.log(`✓ 텔레그램 봇 @${me.username} ↔ 에이전트 "${agent.name}" 연결됨.`);
  if (!cfg.ownerId) console.log('  아직 주인이 없어요 — 텔레그램에서 이 봇에게 아무 메시지나 보내면 그 사람이 주인이 됩니다.');
  console.log('  (PC 가 켜져 있는 동안만 응답해요. 종료: Ctrl+C)');
  await startBot(cfg, { log: console.log });
}

module.exports = { startBot, verifyToken, saveConfig, loadConfig, readConfig, configPath, sendToOwner };

if (require.main === module) main().catch(e => { console.error('봇 오류:', e && e.message); process.exit(1); });
