'use strict';
/**
 * audit-dead-files.js — 설치본에 들어간 우리 파일 중 **아무도 안 부르는 것**을 찾는다.
 *
 * 원칙: *"개발 단계에서 필요했던 게 실제 사용자한테 불필요하면
 * 임시로 막는 게 아니라 삭제해야 한다."*
 *
 * verify-package.js 는 "허용 목록에 있나"만 본다 — 내가 목록에 잘못 넣으면 그대로 통과한다
 * (실제로 app-chat.js 를 이름만 보고 넣었다). 그래서 **이름이 아니라 도달 가능성**으로 판정한다.
 *
 * 방법: 진짜 진입점에서 시작해 require 를 따라가며 도달 표시. 안 닿은 파일 = 죽은 파일.
 */
const fs = require('fs');
const path = require('path');

// 실제로 실행되는 진입점만. (electron main / preload / 화면 / 각 채널 프로세스 / 워커)
const ENTRIES = [
  'main.js', 'preload.js', 'renderer/app.js',
  'cli.js', 'bot-telegram.js', 'discord-bot.js', 'auxo-mcp-tools.js',
  'embed-worker.js',
];

const ship = fs.readFileSync(path.join(__dirname, 'package.json'), 'utf8'); // 존재 확인용
const seen = new Set();
const missing = [];

function walk(rel) {
  const norm = rel.replace(/\\/g, '/');
  if (seen.has(norm)) return;
  const abs = path.join(__dirname, norm);
  if (!fs.existsSync(abs)) { missing.push(norm); return; }
  seen.add(norm);
  const txt = fs.readFileSync(abs, 'utf8');
  // require('./x') / require("../x") — 동적 경로는 못 잡는다(아래에서 따로 표시).
  const re = /require\(\s*['"](\.\.?\/[^'"]+)['"]\s*\)/g;
  let m;
  while ((m = re.exec(txt))) {
    let t = path.posix.normalize(path.posix.join(path.posix.dirname(norm), m[1]));
    if (!/\.(js|json)$/.test(t)) t += '.js';
    walk(t);
  }
}
for (const e of ENTRIES) walk(e);

// 설치본에 실제로 들어간 우리 파일 목록(= verify-package 의 허용 목록과 같은 기준).
const vp = fs.readFileSync(path.join(__dirname, 'verify-package.js'), 'utf8');
const allow = [...vp.matchAll(/'([^']+\.(?:js|json|md|txt|ico|png))'/g)].map((x) => x[1]);

// 데이터 파일(.json)은 require 가 아니라 fs.readFileSync 로 읽힌다 —
// 도달한 코드 안에 파일명이 문자열로 나오면 "쓰이는 것"으로 본다.
const reachedText = [...seen].map((f) => {
  try { return fs.readFileSync(path.join(__dirname, f), 'utf8'); } catch (_) { return ''; }
}).join('\n');
const usedAsData = (f) => reachedText.includes(path.basename(f));

const code = allow.filter((f) => /\.(js|json)$/.test(f));
const dead = code.filter((f) => !seen.has(f) && !usedAsData(f));

console.log('\n══ 설치본 안 죽은 파일 검사 ══\n');
console.log(`  진입점 ${ENTRIES.length}개에서 도달한 파일: ${seen.size}개`);
if (missing.length) console.log(`  ⚠ 참조하는데 없는 파일: ${missing.join(', ')}`);
console.log('');
if (!dead.length) {
  console.log('  OK    설치본의 모든 코드 파일이 진입점에서 도달 가능');
} else {
  console.log(`  ★${dead.length}건  아무도 안 부르는데 설치본에 들어감:`);
  for (const f of dead) console.log(`          · ${f}`);
  console.log('');
  console.log('  → 개발용이면 **파일을 지우고** build.files·ALLOW_FILES 에서도 뺀다.');
  console.log('  → 동적 require(경로 조립) 로만 불린다면 여기 예외로 적는다.');
}
console.log('');
process.exit(dead.length ? 1 : 0);
