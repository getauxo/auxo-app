/**
 * verify-updatable.js — 만든 설치본이 **앞으로 업데이트를 받을 수 있는가**를 검사한다.
 *
 * 왜 필요한가 (2026-08-16 실제 사고):
 *   7za 문제를 피하려고 빌드를 두 단계로 나눴다 —
 *     npm run pack (electron-builder --dir)  →  electron-builder --prepackaged dist/win-unpacked
 *   그런데 `--dir` 단계는 **app-update.yml 을 만들지 않는다.** `--prepackaged` 는 이미 있는 폴더를
 *   그대로 포장하므로 그 파일이 없는 채로 설치본이 나온다.
 *   빌드는 "성공"하고, 설치도 되고, 앱도 잘 뜬다. **자동 업데이트만 조용히 죽는다.**
 *   → 그 판을 받은 사용자는 **영원히 다음 버전을 못 받는다.** 우리가 고쳐도 전달할 길이 없다.
 *   v0.2.1·0.2.2·0.2.3 이 그렇게 나갔다(로그에 ENOENT app-update.yml 로 남아 있었다).
 *
 * 무엇을 보나:
 *   1) resources/app-update.yml 이 있는가
 *   2) 그 안의 provider/owner/repo 가 package.json 의 publish 설정과 같은가
 *   3) 함께 올릴 latest.yml 이 있고 버전이 package.json 과 같은가
 *
 * 실행: node verify-updatable.js [win-unpacked 경로]
 */
'use strict';
const fs = require('fs');
const path = require('path');

const UNPACKED = process.argv[2] || path.join(__dirname, 'dist', 'win-unpacked');
const YML = path.join(UNPACKED, 'resources', 'app-update.yml');
const LATEST = path.join(__dirname, 'dist', 'latest.yml');
const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, 'package.json'), 'utf8'));

let bad = 0;
const ok = (m) => console.log(`[OK]   ${m}`);
const fail = (m, 힌트) => { console.error(`[FAIL] ${m}`); if (힌트) console.error(`       → ${힌트}`); bad++; };

console.log('\n══ 이 설치본이 앞으로 업데이트를 받을 수 있나 ══\n');

// ① 파일 존재 — 이게 없으면 자동 업데이트가 시작조차 못 한다
if (!fs.existsSync(YML)) {
  fail('resources/app-update.yml 이 없다 — 이 설치본은 자동 업데이트를 영영 못 받는다',
       'electron-builder 를 --dir/--prepackaged 로 나눠 돌리면 안 만들어진다. `npx electron-builder --win` 으로 한 번에 빌드할 것.');
} else {
  const txt = fs.readFileSync(YML, 'utf8');
  ok(`app-update.yml 있음 (${txt.trim().split('\n').length}줄)`);

  // ② 내용이 우리 배포처를 가리키나
  const 읽기 = (k) => { const m = new RegExp('^' + k + ':\\s*(\\S+)', 'm').exec(txt); return m ? m[1] : ''; };
  const pub = (Array.isArray(pkg.build && pkg.build.publish) ? pkg.build.publish[0] : (pkg.build || {}).publish) || {};
  for (const k of ['provider', 'owner', 'repo']) {
    const 실제 = 읽기(k), 기대 = pub[k];
    if (!기대) continue;
    if (실제 === 기대) ok(`${k} = ${실제}`);
    else fail(`${k} 가 다르다 — 설치본 "${실제}" vs package.json "${기대}"`);
  }
}

// ③ 서버에 올릴 latest.yml — 이게 없거나 버전이 어긋나면 아무도 새 버전을 못 본다
if (!fs.existsSync(LATEST)) {
  fail('dist/latest.yml 이 없다 — 릴리스에 올릴 게 없다', '릴리스 자산에 latest.yml 을 반드시 함께 올린다.');
} else {
  const v = (/^version:\s*(\S+)/m.exec(fs.readFileSync(LATEST, 'utf8')) || [])[1];
  if (v === pkg.version) ok(`latest.yml 버전 = ${v} (package.json 과 같음)`);
  else fail(`latest.yml 버전이 다르다 — "${v}" vs package.json "${pkg.version}"`, '옛 빌드의 latest.yml 이 남아 있다. 다시 빌드할 것.');
}

console.log('');
if (bad) { console.error(`업데이트 가능성 검사 실패 — ${bad}건.\n`); process.exit(1); }
console.log('업데이트 가능성 검사 통과.\n');
