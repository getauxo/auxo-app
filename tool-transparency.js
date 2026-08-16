/**
 * tool-transparency.js — 도구 사용 투명성(환각 안전장치 3번) 공용 코어.
 *
 * 한 번의 답변에서 에이전트가 "실제로 어떤 정보 도구를 썼는지"를 사용자에게 보여주기 위한
 * 라벨/배지 생성. 검색·조회·실행처럼 '외부에서 정보를 가져오거나 실제로 실행한' 도구만 표시한다.
 * (remember/write_file 같은 상태변경은 결과로 이미 확인되므로 제외 — 노이즈 방지)
 *
 * 목적: 두뇌가 "검색했다"며 실제로는 안 한 답(환각)을, 표시가 없으면 사용자가 즉시 알아채게.
 * 모든 채널(engine=CLI·텔레그램, main=앱)이 같은 라벨을 쓰도록 단일 소스.
 */
'use strict';

// 추적·표시 대상(정보 취득/실행 도구)과 사용자용 라벨.
const LABELS = {
  web_search: '🔎 웹 검색',
  fetch_url: '🌐 링크 읽기',
  read_file: '📄 파일 읽기',
  list_files: '📁 폴더 보기',
  search_files: '🔍 파일 찾기',
  run_shell: '⌨️ 명령 실행',
  run_code: '💻 코드 실행',
};
const TRACKED = new Set(Object.keys(LABELS));

/** 이 도구를 투명성 표시 대상으로 추적할지. 설치형 MCP 도구(mcp__*)도 외부도구로 표시. */
function isTracked(n) { return TRACKED.has(n) || String(n || '').startsWith('mcp__'); }

/** 도구명 → 사용자 라벨(없으면 null). MCP 도구는 '🧩 외부도구'로 묶음. */
function labelFor(n) {
  if (String(n || '').startsWith('mcp__')) return '🧩 외부도구';
  return LABELS[n] || null;
}

/** 도구명 목록 → "🔎 웹 검색 · 📄 파일 읽기" 배지 문자열(없으면 ''). 중복 제거. */
function badge(names) {
  const labels = [...new Set((names || []).map(labelFor).filter(Boolean))];
  return labels.length ? labels.join(' · ') : '';
}

module.exports = { isTracked, labelFor, badge, LABELS };
