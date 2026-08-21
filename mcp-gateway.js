'use strict';
/**
 * mcp-gateway.js — 구독 두뇌(claude·codex)용 MCP 상시연결 게이트웨이.
 *
 * 문제: claude/codex 구독은 매 턴 MCP를 stdio로 새로 spawn하고, 느린 서버(npx·무거운 것)가
 *       준비되기 전(pending)에 턴을 진행 → 도구가 세션에 안 붙음(구글 캘린더 등 외부 MCP 전반).
 * 해법: 설치 MCP를 앱 main 프로세스에서 **미리 한 번 띄워 상시 유지**하고(warm), 로컬 HTTP MCP
 *       엔드포인트로 노출. 구독 두뇌엔 spawn 명령 대신 이 URL을 준다 → 이미 준비된 서버에 즉시
 *       접속(connected), pending 레이스 소멸. (REST 두뇌용 mcpManager 상시연결과 같은 철학)
 *
 * 구현: 저수준 Server로 **투명 프록시**(ListTools/CallTool을 실서버 client로 위임 — JSON스키마→Zod
 *       변환 불필요). 실서버 stdio 연결은 mcpManager.connect(env 포함)를 재사용·캐시. HTTP는 요청마다
 *       새 Server+StreamableHTTPServerTransport(stateless)지만 핸들러는 상주 client에 위임.
 */

const http = require('http');
const path = require('path');
const mcpManager = require('./mcp-manager');
const storage = require('./storage');   // 설치 MCP 호출을 장부에 남긴다(2026-08-20)

// key: `${agentId}::${serverId}` → { httpServer, port, url }
const gateways = new Map();

async function _startGateway(agentId, server) {
  // 1) 실서버(stdio) 상시 연결 + 도구 목록. mcpManager가 clients를 캐시하고 env(자격증명)를 넘긴다.
  const entry = await mcpManager.connect(agentId, server); // { client, tools }
  // 2) HTTP MCP 프록시 서버(저수준 Server). SDK는 ESM → 동적 import.
  const { Server } = await import('@modelcontextprotocol/sdk/server/index.js');
  const { StreamableHTTPServerTransport } = await import('@modelcontextprotocol/sdk/server/streamableHttp.js');
  const { ListToolsRequestSchema, CallToolRequestSchema } = await import('@modelcontextprotocol/sdk/types.js');

  const httpServer = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', async () => {
      try {
        const parsed = body ? JSON.parse(body) : undefined;
        // 진단용: 두뇌가 **실제로 붙어서 무엇을 요청했는지** 본다(토큰을 안 쓰고 연결을 확인한다).
        //   "도구가 안 열려 있다"는 두뇌의 말이 연결 실패인지 두뇌가 안 부른 건지 이걸로 갈린다.
        if (process.env.AUXO_GW_LOG) {
          try { console.error(`[gw:${server.id}] ${new Date().toISOString().slice(11, 23)} ${req.method} ${parsed && parsed.method ? parsed.method : '(본문없음)'}`); } catch (_) {}
        }
        const srv = new Server({ name: 'auxo-gw-' + server.id, version: '0.1.0' }, { capabilities: { tools: {} } });
        srv.setRequestHandler(ListToolsRequestSchema, async () => {
          // 실서버 도구를 그대로 노출(늦게 뜨는 도구 대비 재조회, 실패 시 최초 캐시).
          try { const t = await entry.client.listTools(); return { tools: (t && t.tools) || entry.tools }; }
          catch (_) { return { tools: entry.tools }; }
        });
        srv.setRequestHandler(CallToolRequestSchema, async (r) => {
          // claude/codex의 호출을 실서버로 그대로 전달.
          //
          // ★2026-08-20: 여기를 **장부에도 남긴다.**
          //   구독 두뇌(codex·claude)가 설치 MCP(playwright·구글 등)를 부르면 그 호출은
          //   이 프록시만 지나고 **우리 장부엔 아무것도 안 남았다.** 우리 기본 도구는
          //   auxo-mcp-tools 가 남기는데 설치 MCP 만 비어 있었다.
          //   → 정직 계층이 "도구 0회"로 읽어 **멀쩡히 한 일을 안 했다고 판정**할 수 있다(오탐).
          //   업계 원칙 = "런타임이 진실의 원천". 우리가 이미 길목에 서 있는데 적지를 않고 있었다.
          //
          //   ⚠️ 기록은 **곁다리다.** 실패해도 도구 호출은 그대로 나가야 한다 —
          //      장부 때문에 사용자의 작업이 깨지면 그게 더 나쁘다.
          const _이름 = r.params.name;
          let _ok = true;
          try {
            const out = await entry.client.callTool({ name: _이름, arguments: r.params.arguments || {} });
            // MCP 규약: 실패는 예외가 아니라 isError 로 온다. 둘 다 실패로 친다.
            _ok = !(out && out.isError);
            return out;
          } catch (e) {
            _ok = false;
            throw e;
          } finally {
            try { storage.recordToolCall(agentId, _이름, _ok); } catch (_) {}
          }
        });
        const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
        res.on('close', () => { try { transport.close(); srv.close(); } catch (_) {} });
        await srv.connect(transport);
        await transport.handleRequest(req, res, parsed);
      } catch (e) {
        try { res.writeHead(500); res.end(String((e && e.message) || e)); } catch (_) {}
      }
    });
  });
  await new Promise((resolve, reject) => {
    httpServer.once('error', reject);
    httpServer.listen(0, '127.0.0.1', resolve); // 자유 포트, 로컬 전용
  });
  const port = httpServer.address().port;
  return { httpServer, port, url: `http://127.0.0.1:${port}/mcp` };
}

/**
 * 에이전트의 설치 MCP 각각을 상시 HTTP 게이트웨이로 보장. 이미 있으면 재사용.
 * @returns {Promise<Array<{id, name, url}>>} 구독 두뇌 config에 넣을 URL 목록. 실패 서버는 건너뜀.
 */
async function ensureGateways(agentId, dataDir) {
  if (dataDir) { try { mcpManager.setConfigRoot(path.join(dataDir, 'mcp')); } catch (_) {} }
  let servers = [];
  try { servers = mcpManager.listServers(agentId).filter((s) => s.enabled !== false); } catch (_) {}
  const out = [];
  for (const s of servers) {
    const key = `${agentId}::${s.id}`;
    let g = gateways.get(key);
    if (!g) {
      try { g = await _startGateway(agentId, s); gateways.set(key, g); }
      catch (e) { console.error(`[mcp-gateway] '${s.name || s.id}' 시작 실패:`, (e && e.message) || e); continue; }
    }
    out.push({ id: s.id, name: s.name, url: g.url });
  }
  return out;
}

/**
 * 내장 auxo 도구(파일·기억·전송 등)도 상시 HTTP 게이트웨이로 보장.
 * 기존엔 구독 두뇌가 매 턴 auxo를 stdio로 새로 spawn → sqlite 초기화가 느리면 준비 전 턴이 지나가
 * 도구가 안 붙음(=거짓무능). 여기서 한 번 warm 해두고 URL을 주면 즉시 connected.
 * @param {object} auxoServer { id:'auxo', command, args, env }
 * @returns {Promise<string>} 로컬 HTTP MCP URL. (실패 시 throw → 호출부가 stdio 폴백)
 */
async function ensureAuxoGateway(agentId, auxoServer) {
  const key = `${agentId}::${auxoServer.id}`;
  let g = gateways.get(key);
  if (!g) { g = await _startGateway(agentId, auxoServer); gateways.set(key, g); }
  return g.url;
}

/**
 * 앱·CLI 종료 시 정리.
 *
 * ★예전엔 httpServer 만 닫았다. 그런데 **자식 프로세스는 그쪽에 없다** —
 *   실서버는 mcpManager.connect 가 stdio 로 띄우고, 여기 gateways 맵엔 { httpServer, port, url } 만 있다.
 *   그래서 껍데기만 닫히고 `node auxo-mcp-tools.js` 는 계속 살아 있었다(실측 2026-08-14: 15분+).
 *   남은 자식이 부모까지 붙잡아 CLI 가 아예 안 죽었고, 앱이었다면 **자동 업데이트가
 *   업데이트 설치 직전 종료 때 자식이 남아 파일 잠금으로 실패**했을 자리다.
 */
function shutdown() {
  for (const g of gateways.values()) { try { g.httpServer.close(); } catch (_) {} }
  gateways.clear();
  try { return require('./mcp-manager').disconnectAll(); } catch (_) { return 0; }
}

module.exports = { ensureGateways, ensureAuxoGateway, shutdown };
