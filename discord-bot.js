/**
 * discord-bot.js — 디스코드 봇 커넥터 (discord.js v14)
 *
 * 앱·CLI·텔레그램과 같은 engine.js 를 재사용한다(같은 정체성의 또 다른 창구).
 * 1봇 = 1에이전트. PC 가 켜져 있을 때만 동작. 주인(첫 DM 사용자)만 응답. DM 1:1 전용.
 *
 * 두 가지로 쓴다:
 *  (a) standalone:  node discord-bot.js   (discord-bot.json / env 설정 읽어 실행)
 *  (b) CLI/앱 내장:  startBot(cfg) 를 백그라운드로 호출
 *
 * 설정: discord-bot.json { token, dataPath, agentId, ownerId? }
 *   (env: AUXO_DISCORD_TOKEN / AUXO_DISCORD_DATA / AUXO_DISCORD_AGENT / AUXO_DISCORD_CONFIG)
 */
'use strict';
const https = require('https');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { Client, GatewayIntentBits, Partials, Events } = require('discord.js');
const storage = require('./storage');
const attachStore = require('./attachment-store');
const engine = require('./engine');
const { intakeFile, buildPromptParts } = require('./file-intake');

// standalone 실행 때만 내부 디버그 로그 숨김(내장 시엔 호출측이 처리).
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
  return process.env.AUXO_DISCORD_CONFIG || path.join(os.homedir(), '.auxo-cli', 'discord-bot.json');
}
function loadConfig() {
  let cfg = {};
  try { cfg = JSON.parse(fs.readFileSync(configPath(), 'utf8')); } catch (_) {}
  cfg.token = process.env.AUXO_DISCORD_TOKEN || cfg.token;
  cfg.dataPath = process.env.AUXO_DISCORD_DATA || cfg.dataPath;
  cfg.agentId = process.env.AUXO_DISCORD_AGENT || cfg.agentId;
  return cfg;
}
function saveConfig(cfg) {
  try {
    const out = { token: cfg.token, dataPath: cfg.dataPath, agentId: cfg.agentId };
    if (cfg.ownerId) out.ownerId = cfg.ownerId;
    fs.writeFileSync(cfg.configPath || configPath(), JSON.stringify(out, null, 2), 'utf8');
  } catch (_) {}
}
function readConfig(p) {
  try { return JSON.parse(fs.readFileSync(p || configPath(), 'utf8')); } catch (_) { return {}; }
}

// ── 디스코드 REST (토큰 검증) ───────────────────────────────────────────
/** 토큰 유효성 확인. 유효하면 봇 정보(username 등), 아니면 null. */
function verifyToken(token) {
  return new Promise((resolve) => {
    const req = https.request('https://discord.com/api/v10/users/@me',
      { headers: { Authorization: `Bot ${token}` } },
      r => { let d = ''; r.on('data', c => d += c); r.on('end', () => { try { const j = JSON.parse(d); resolve(r.statusCode === 200 ? j : null); } catch (_) { resolve(null); } }); });
    req.on('error', () => resolve(null)); req.end();
  });
}
// 디스코드 첨부(https URL) → Buffer 다운로드
function dlUrl(url) {
  return new Promise((resolve, reject) => {
    https.get(url, r => {
      if (r.statusCode !== 200) { r.resume(); reject(new Error('다운로드 실패 HTTP ' + r.statusCode)); return; }
      const chunks = []; r.on('data', d => chunks.push(d)); r.on('end', () => resolve(Buffer.concat(chunks))); r.on('error', reject);
    }).on('error', reject);
  });
}
// 디스코드 메시지 2000자 제한 분할
function splitMessage(text, max = 1900) {
  const chunks = []; let t = String(text || '');
  while (t.length > max) {
    let i = t.lastIndexOf('\n', max); if (i < max * 0.5) i = max;
    chunks.push(t.slice(0, i)); t = t.slice(i);
  }
  if (t.length) chunks.push(t);
  return chunks.length ? chunks : ['...'];
}

// 실행 중인 봇으로 주인에게 먼저 보내기(예약 결과 push 등).
let _active = null, _client = null;
async function sendToOwner(text) {
  if (!_client || !_active || !_active.ownerId) return { ok: false, error: '봇이 연결 안 됐거나 주인이 없어요' };
  try { const u = await _client.users.fetch(_active.ownerId); for (const c of splitMessage(text)) await u.send(c); return { ok: true }; }
  catch (e) { return { ok: false, error: e.message }; }
}

/**
 * 봇 시작. 이벤트 기반이라 login 후 유지된다(내장 시 await 하지 말고 백그라운드로).
 * @param {object} cfg  { token, dataPath, agentId, ownerId? }
 * @param {object} [opts] { log, stop:()=>boolean }
 */
async function startBot(cfg, opts = {}) {
  const log = opts.log || (() => {});
  storage.init(cfg.dataPath);
  _active = cfg;
  const agent = storage.loadAgent(cfg.agentId);
  if (!agent) throw new Error('에이전트를 찾을 수 없어요: ' + cfg.agentId);

  const client = new Client({
    intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent, GatewayIntentBits.DirectMessages],
    partials: [Partials.Channel], // DM 수신용
  });
  _client = client;

  client.once(Events.ClientReady, (c) => {
    log(`✓ 디스코드 봇 @${c.user.tag} ↔ 에이전트 "${agent.name}" 연결됨.`);
    if (!cfg.ownerId) log('  아직 주인이 없어요 — 디스코드에서 이 봇에게 DM 을 보내면 그 사람이 주인이 됩니다.');
  });

  client.on(Events.MessageCreate, async (msg) => {
    if (msg.author.bot) return;
    const isDM = !msg.guild;
    const mentioned = msg.mentions && msg.mentions.has(client.user);
    // 전용 채널(채널 이름에 에이전트 이름 또는 'auxo' 포함)에선 @멘션 없이 그냥 대화.
    // 그 외 서버 채널은 @멘션 시에만 반응(노이즈·프라이버시 방지). DM 은 항상 응답.
    const chName = (!isDM && msg.channel && msg.channel.name) ? String(msg.channel.name).toLowerCase() : '';
    const dedicated = !!chName && (chName.includes(String(agent.name).toLowerCase()) || chName.includes('auxo'));
    if (!isDM && !mentioned && !dedicated) return;

    const fromId = msg.author.id;
    // 주인 자동 등록(첫 DM 보낸 사람) — 비개발자 친화
    if (!cfg.ownerId) {
      cfg.ownerId = fromId; saveConfig(cfg);
      log('  디스코드 주인 등록됨: ' + fromId);
      await msg.channel.send(`안녕하세요! 이제부터 제가 "${agent.name}"로서 함께할게요. 무엇이든 편하게 말씀해 주세요.`).catch(() => {});
      if (!msg.content && !(msg.attachments && msg.attachments.size)) return;
    }
    if (cfg.ownerId !== fromId) return; // 주인 아니면 무시(보안)

    // 파일 첨부 수신 → file-intake 공통 코어
    let userMessage = (msg.content || '').replace(/<@!?\d+>/g, '').trim(); // 봇 멘션 태그(<@id>)는 제거
    let attachments, userFiles;
    // 음성/영상/유튜브 도구 다운로드 등 "받는 중" 안내 — 스팸 방지로 첫 1회만.
    let _statusSent = false;
    const notifyStatus = (m) => { if (_statusSent || !m) return; _statusSent = true; msg.channel.send('⏳ ' + m).catch(() => {}); };
    if (msg.attachments && msg.attachments.size) {
      await msg.channel.sendTyping().catch(() => {});
      const att = msg.attachments.first();
      let buf;
      try { buf = await dlUrl(att.url); }
      catch (e) { await msg.channel.send('파일을 받는 데 문제가 있었어요: ' + e.message).catch(() => {}); return; }
      const name = att.name || `file_${Date.now()}`;
      const mimeType = att.contentType || 'application/octet-stream';
      const intake = await intakeFile({ name, mimeType, buffer: buf }, { onStatus: notifyStatus });
      if (intake.error) { await msg.channel.send(intake.error).catch(() => {}); return; }
      const dlDir = path.join(path.dirname(storage.getDataPath()), 'download');
      const saved = attachStore.saveAttachment(dlDir, name, buf);
      const parts = buildPromptParts([intake]);
      attachments = parts.attachments;
      const cap = msg.content || '';
      userMessage = cap + (parts.noteText ? (cap ? '\n\n' : '') + parts.noteText : '');
      if (saved && !saved.error) {
        userMessage += (userMessage ? '\n\n' : '') + `[받은 파일 "${saved.name}"을 ${saved.path} 에 저장함 — 필요하면 read_file/send_file로 다룰 수 있어]`;
        userFiles = [{ path: saved.path, name: saved.name, size: saved.size, isImage: /^image\//.test(mimeType) || /\.(png|jpe?g|gif|webp)$/i.test(saved.name) }]; // 구독두뇌 비전(경로로 이미지 보기) — 앱과 동등
      }
      else if (saved && saved.error) userMessage += (userMessage ? '\n\n' : '') + `(시스템 안내: ${saved.error})`;
    }
    if (!userMessage && !(attachments && attachments.length)) return;

    await msg.channel.sendTyping().catch(() => {});
    const typing = setInterval(() => msg.channel.sendTyping().catch(() => {}), 8000);
    let r;
    try {
      r = await engine.runTurn({
        agentId: cfg.agentId, userMessage, attachments, userFiles,
        emit: (ch, p) => { if (ch === 'status' && p && p.text) notifyStatus(p.text); }, // 유튜브 등 "받는 중"
        deliverFile: async ({ path: fp, name, note }) => {
          try { await msg.channel.send({ content: note || undefined, files: [{ attachment: fp, name }] }); }
          catch (e) { return { error: `파일 "${name}"을 보내려다 실패했어: ${e.message}` }; }
        },
      });
    } catch (e) {
      clearInterval(typing);
      await msg.channel.send('잠시 문제가 있었어요. 다시 한번 말씀해 주실래요?').catch(() => {});
      return;
    }
    clearInterval(typing);
    const body = r.response || r.error || '...';
    for (const chunk of splitMessage(body)) await msg.channel.send(chunk).catch(() => {});
    // 앱이 켜져 있으면 그 대화를 앱 채팅창에도 실시간 반영(같은 프로세스, "통합 홈")
    if (opts.onExchange) { try { opts.onExchange({ agentId: cfg.agentId, userMessage, response: body }); } catch (_) {} }
    if (r.generate) {
      engine.processMemory({ agentId: cfg.agentId, userMessage, response: r.response, generate: r.generate, rememberedAny: r.rememberedAny, emit: () => {} }).catch(() => {});
    }
  });

  await client.login(cfg.token);
  // stop 지원: 주기적으로 확인해 종료 시 클라이언트 정리
  if (opts.stop) {
    const iv = setInterval(() => { if (opts.stop()) { clearInterval(iv); try { client.destroy(); } catch (_) {} } }, 1000);
  }
  return client;
}

// ── standalone 실행 (node discord-bot.js) ───────────────────────────────
async function main() {
  const cfg = loadConfig();
  if (!cfg.token) { console.error('❌ 디스코드 봇 토큰이 없어요. discord-bot.json 의 token 또는 AUXO_DISCORD_TOKEN 을 설정해 주세요.'); process.exit(1); }
  if (!cfg.dataPath || !cfg.agentId) { console.error('❌ 연결할 에이전트가 없어요. dataPath 와 agentId 를 설정해 주세요.'); process.exit(1); }
  storage.init(cfg.dataPath);
  const agent = storage.loadAgent(cfg.agentId);
  if (!agent) { console.error('❌ 에이전트를 찾을 수 없어요: ' + cfg.agentId); process.exit(1); }
  const me = await verifyToken(cfg.token);
  if (!me) { console.error('❌ 봇 토큰이 올바르지 않아요. Discord Developer Portal 의 Bot 토큰을 다시 확인해 주세요.'); process.exit(1); }
  console.log(`✓ 디스코드 봇 @${me.username} ↔ 에이전트 "${agent.name}" 준비됨.`);
  console.log('  디스코드에서 이 봇에게 DM 을 보내면 그 사람이 주인이 됩니다. (PC 가 켜져 있는 동안만 응답, 종료: Ctrl+C)');
  await startBot(cfg, { log: console.log });
}

module.exports = { startBot, verifyToken, saveConfig, loadConfig, readConfig, configPath, sendToOwner };

if (require.main === module) main().catch(e => { console.error('봇 오류:', e && e.message); process.exit(1); });
