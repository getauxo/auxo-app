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
        const srv = new Server({ name: 'auxo-gw-' + server.id, version: '0.1.0' }, { capabilities: { tools: {} } });
        srv.setRequestHandler(ListToolsRequestSchema, async () => {
          // 실서버 도구를 그대로 노출(늦게 뜨는 도구 대비 재조회, 실패 시 최초 캐시).
          try { const t = await entry.client.listTools(); return { tools: (t && t.tools) || entry.tools }; }
          catch (_) { return { tools: entry.tools }; }
        });
        srv.setRequestHandler(CallToolRequestSchema, async (r) => {
          // claude/codex의 호출을 실서버로 그대로 전달.
          return await entry.client.callTool({ name: r.params.name, arguments: r.params.arguments || {} });
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

/** 앱 종료 시 정리. */
function shutdown() {
  for (const g of gateways.values()) { try { g.httpServer.close(); } catch (_) {} }
  gateways.clear();
}

module.exports = { ensureGateways, ensureAuxoGateway, shutdown };
