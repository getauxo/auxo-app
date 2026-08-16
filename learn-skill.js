/**
 * learn-skill.js — P3.2 자가학습(자동) reflection 코어.
 *
 * 트리거(결정 b): "복잡 작업(도구 2개+ 조합) + 성공" 한 턴 뒤에만 호출(일상 대화엔 안 낀다).
 * 동작: 방금 작업을 두뇌에게 다시 보여주고 "재사용할 만한 비자명한 방법이면 스킬로 남겨라"라고 판단시킨다.
 *       남길 가치 없으면 skip. 이미 비슷한 스킬 있으면 skip. → 과생성 방지.
 * 안전: 스킬은 "방법 설명서"라 실행 아님(위험 동작은 실제 실행 시 별도 승인). 생성 결과는 emit으로 투명 통지.
 */
'use strict';

const SYS = `너는 에이전트의 "자가학습" 모듈이야. 방금 처리한 작업을 돌아보고, 앞으로 또 마주칠 만한 "비자명한 방법·절차"라면 재사용 스킬로 남긴다.

남기는 기준(모두 충족해야):
- 여러 단계나 도구를 엮어야 하는, 한 번에 떠올리기 어려운 방법이다.
- 다음에 비슷한 일에서 그대로 따라 하면 도움이 된다.
- [이미 있는 스킬]에 같은 게 없다.

남기지 않는 경우: 단순 질답, 일회성/사소한 일, 일반 상식, 개인적 잡담.

출력은 JSON 한 줄만:
- 남길 가치 있으면: {"name":"짧은 이름","description":"언제 쓰는지 한 줄","body":"단계별 방법(다음에 이대로 따라 하면 되게 구체적으로)"}
- 아니면: {"skip":true}
JSON 외 다른 말 금지.`;

async function reflectAndLearn({ agentId, userMessage, response, generate, skillsRegistry, existing = [] }) {
  if (typeof generate !== 'function' || !skillsRegistry) return null;
  const usr = `[사용자 요청]\n${String(userMessage || '').slice(0, 1500)}\n\n[내 응답/결과]\n${String(response || '').slice(0, 2000)}\n\n[이미 있는 스킬]\n${existing.length ? existing.join(', ') : '(없음)'}`;
  let out;
  try { out = await generate(SYS, usr, { tools: false, timeout: 30000 }); } catch (_) { return null; }
  const m = String(out || '').match(/\{[\s\S]*\}/);
  if (!m) return null;
  let j; try { j = JSON.parse(m[0]); } catch (_) { return null; }
  if (!j || j.skip || !String(j.name || '').trim() || !String(j.body || '').trim()) return null;
  const r = skillsRegistry.saveSkill(agentId, { name: j.name, description: j.description, body: j.body, source: 'auto-reflect' });
  return (r && !r.error) ? { learned: true, name: j.name, id: r.id } : null;
}

// 자가학습 트리거 카운트에서 제외할 도구(기억·위임·예약·스킬생성·승인류 — "작업 도구"가 아님).
const _SKIP = new Set(['remember', 'forget', 'delegate_to_workers', 'create_skill', 'schedule_task', 'list_schedules', 'cancel_schedule', 'set_trust', 'set_heartbeat', 'grant_dir', 'grant_shell']);
function isWorkTool(n) { return !_SKIP.has(n); }

module.exports = { reflectAndLearn, isWorkTool };
