/**
 * env.js — 스킬/MCP 사전 필요 프로그램(런타임) 점검 + 안전한 패키지 설치
 *
 * 정직한 범위:
 *  - 점검: node/npx/python/uv 가 PATH에 있는지 확인(버전 표시).
 *  - 시스템 런타임 자동설치는 안 함(위험) → 없으면 공식 설치 링크 안내.
 *  - 패키지 단위 setup(예: playwright chromium 다운로드)은 사용자 버튼으로 실행.
 */
'use strict';
const { exec } = require('child_process');

const RUNTIMES = [
  { name: 'node', label: 'Node.js', cmd: 'node --version', installUrl: 'https://nodejs.org/', why: 'npx 기반 MCP/스킬 실행에 필요' },
  { name: 'npx', label: 'npx', cmd: 'npx --version', installUrl: 'https://nodejs.org/', why: 'MCP 서버를 받아 실행(Node에 포함)' },
  { name: 'python', label: 'Python', cmd: 'python --version', installUrl: 'https://www.python.org/downloads/', why: '일부 파이썬 기반 MCP/스킬에 필요' },
  { name: 'uv', label: 'uv (uvx)', cmd: 'uv --version', installUrl: 'https://docs.astral.sh/uv/getting-started/installation/', why: '파이썬 MCP를 uvx로 실행할 때' },
];

function run(cmd, timeout = 8000) {
  return new Promise((resolve) => {
    exec(cmd, { timeout, windowsHide: true }, (err, stdout, stderr) => {
      if (err) resolve({ ok: false });
      else resolve({ ok: true, out: String(stdout || stderr || '').trim() });
    });
  });
}

/** 런타임 설치 상태 점검. [{name,label,ok,version,installUrl,why}] */
async function checkRuntimes() {
  const out = [];
  for (const r of RUNTIMES) {
    const res = await run(r.cmd);
    out.push({ name: r.name, label: r.label, ok: res.ok, version: res.ok ? res.out.split('\n')[0] : '', installUrl: r.installUrl, why: r.why });
  }
  return out;
}

/** 패키지 단위 setup 실행(예: playwright install chromium). 결과 텍스트 반환. */
function runSetup(command, args, timeout = 180000) {
  const full = `${command} ${(args || []).join(' ')}`;
  return new Promise((resolve) => {
    exec(full, { timeout, windowsHide: true, maxBuffer: 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) resolve({ ok: false, error: String(err.message || ''), out: String(stdout || stderr || '').slice(-600) });
      else resolve({ ok: true, out: String(stdout || stderr || '').slice(-600) });
    });
  });
}

module.exports = { checkRuntimes, runSetup };
