/**
 * preload.js — contextBridge로 렌더러에 안전한 API 노출
 */
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('agentAPI', {
  saveAgent: (data) => ipcRenderer.invoke('agent:save', data),
  updateAgent: (agentId, updates) => ipcRenderer.invoke('agent:update', { agentId, updates }),
  listAgents: () => ipcRenderer.invoke('agent:list'),
  appInfo: () => ipcRenderer.invoke('app:info'),          // { version } — 화면 구석 버전 표시

  loadAgent: (id) => ipcRenderer.invoke('agent:load', id),
  sendMessage: (agentId, userMessage, attachments) => ipcRenderer.invoke('chat:send', { agentId, userMessage, attachments }),
  stopChat: (agentId) => ipcRenderer.invoke('chat:stop', { agentId }), // 생성 중 정지(정지 버튼/ESC) — 진행 중 두뇌 호출 취소
  openFile: (filePath) => ipcRenderer.invoke('file:open', { path: filePath }), // 에이전트가 보낸 파일 열기
  downloadFile: (filePath, name) => ipcRenderer.invoke('file:download', { path: filePath, name }), // 다른 위치로 저장
  getFilePreview: (filePath) => ipcRenderer.invoke('file:preview', { path: filePath }), // 저장된 이미지 → dataUrl(재실행 후 썸네일 복원)
  loadConversation: (agentId) => ipcRenderer.invoke('chat:load', agentId),
  loadArchive: (agentId, opts) => ipcRenderer.invoke('chat:loadArchive', agentId, opts), // 압축으로 접힌 옛 대화(opts={offset,limit} 면 페이지 단위)
  // 내보내기는 항상 전부 담는다 — 범위·민감기억 옵션을 두지 않는다
  exportAgent: (agentId) => ipcRenderer.invoke('agent:export', { agentId }),
  exportMarkdown: (agentId) => ipcRenderer.invoke('agent:export-markdown', { agentId }),
  importAgent: () => ipcRenderer.invoke('agent:import'),
  skillsList: (agentId) => ipcRenderer.invoke('skills:list', agentId),
  skillsImport: (agentId) => ipcRenderer.invoke('skills:import', agentId),
  skillsRemove: (agentId, id) => ipcRenderer.invoke('skills:remove', { agentId, id }),
  mcpList: (agentId) => ipcRenderer.invoke('mcp:list', agentId),
  mcpRemove: (agentId, id) => ipcRenderer.invoke('mcp:remove', { agentId, id }),
  mcpSetEnabled: (agentId, id, enabled) => ipcRenderer.invoke('mcp:setEnabled', { agentId, id, enabled }),
  mcpSetAutoApprove: (agentId, id, val) => ipcRenderer.invoke('mcp:setAutoApprove', { agentId, id, val }),
  mcpCatalog: () => ipcRenderer.invoke('mcp:catalog'),
  mcpAddFromCatalog: (agentId, id, params) => ipcRenderer.invoke('mcp:addFromCatalog', { agentId, id, params }),
  cliCheck: (brainMode) => ipcRenderer.invoke('cli:check', brainMode),
  noticeGetOff: () => ipcRenderer.invoke('notice:getOff'),
  noticeSetOff: (off) => ipcRenderer.invoke('notice:setOff', off),
  telegramStatus: () => ipcRenderer.invoke('telegram:status'),
  telegramConnect: (token, agentId) => ipcRenderer.invoke('telegram:connect', { token, agentId }),
  telegramDisconnect: () => ipcRenderer.invoke('telegram:disconnect'),
  discordStatus: () => ipcRenderer.invoke('discord:status'),
  discordConnect: (token, agentId) => ipcRenderer.invoke('discord:connect', { token, agentId }),
  discordDisconnect: () => ipcRenderer.invoke('discord:disconnect'),
  cliInstall: (brainMode) => ipcRenderer.invoke('cli:install', brainMode),
  cliLogin: (brainMode) => ipcRenderer.invoke('cli:login', brainMode),
  apiTest: (cfg) => ipcRenderer.invoke('api:test', cfg),
  apiModels: (cfg) => ipcRenderer.invoke('api:models', cfg), // 키로 모델 목록 조회(키 검증 겸함)
  onCliInstallProgress: (cb) => { const h = (_, d) => cb(d); ipcRenderer.on('cli:install-progress', h); return () => ipcRenderer.removeListener('cli:install-progress', h); },
  onCliLoginProgress: (cb) => { const h = (_, d) => cb(d); ipcRenderer.on('cli:login-progress', h); return () => ipcRenderer.removeListener('cli:login-progress', h); },
  envCheck: () => ipcRenderer.invoke('env:check'),
  envRunSetup: (command, args) => ipcRenderer.invoke('env:runSetup', { command, args }),
  envOpenUrl: (url) => ipcRenderer.invoke('env:openUrl', url),
  // 문제 기록 파일로 저장 — **자동 전송이 아니다.** 사용자가 열어 보고 보낼지 정한다.
  saveErrorLog: () => ipcRenderer.invoke('errorlog:save'),
  setOverlayTheme: (theme) => ipcRenderer.invoke('window:setOverlayTheme', theme),
  mcpTest: (agentId, id) => ipcRenderer.invoke('mcp:test', { agentId, id }),
  smokeReady: () => ipcRenderer.send('smoke:ready'),
  getSmokeAgentId: () => ipcRenderer.invoke('smoke:get-agent-id'),
  getSmokeScreenTarget: () => ipcRenderer.invoke('smoke:get-screen-target'),
  // 기억 추출 완료 이벤트 수신 (비차단 b 방식)
  onFactsUpdated: (callback) => ipcRenderer.on('facts:updated', (_, data) => callback(data)),
  // 응답 스트리밍: 토큰 청크 수신 (지원 두뇌만). on/off 쌍으로 한 전송당 등록·해제.
  onChatStream: (callback) => {
    const h = (_, data) => callback(data);
    ipcRenderer.on('chat:stream', h);
    return () => ipcRenderer.removeListener('chat:stream', h);
  },
  // 공지·업데이트 안테나: 새 소식 수신
  onNoticeUpdate: (callback) => ipcRenderer.on('notice:update', (_, data) => callback(data)),
  // 새 버전을 다 받아뒀을 때 — main 이 예전부터 보내고 있었는데 **받는 쪽이 없어서 버려지고 있었다**.
  // 그래서 사용자는 업데이트가 되는지 안 되는지 알 방법이 하나도 없었다(2026-08-16).
  onUpdateReady: (callback) => ipcRenderer.on('update:ready', (_, data) => callback(data)),
  // L1: 작업 기억
  getWork: (agentId) => ipcRenderer.invoke('work:get', agentId),
  setWorkActive: (agentId, id) => ipcRenderer.invoke('work:setActive', { agentId, id }),
  onWorkUpdated: (cb) => ipcRenderer.on('work:updated', (e, data) => cb(data)),
  // 예약·하트비트 실행 결과를 채팅창에 흘려보내기
  onScheduleResult: (cb) => ipcRenderer.on('schedule:result', (_, data) => cb(data)),
  onChatIncoming: (cb) => ipcRenderer.on('chat:incoming', (_, data) => cb(data)),
  // 음성/영상/유튜브 처리 중 "받는 중" 안내(모델·도구 다운로드 등)
  onChatStatus: (cb) => ipcRenderer.on('chat:status', (_, data) => cb(data)),
});
