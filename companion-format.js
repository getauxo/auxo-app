/**
 * companion-format.js — 에이전트 이식 포맷 (표준 직렬화 / 역직렬화)
 *
 * 설계 결정:
 *   결정 A: apiKey 는 절대로 export 파일에 포함되지 않는다.
 *   결정 B: 1층(baseLayer) 내용은 미포함, 버전 참조만.
 *   결정 C: 대화는 최근 N개(기본 20)만 포함. 전체 원본·요약은 향후.
 *
 * 포맷 버전: 1.0
 */

const FORMAT_ID = 'auxo.companion';
const LEGACY_FORMAT_IDS = ['agentlink.companion']; // 제품명 확정(Auxo) 전 내보낸 파일 — 계속 읽어준다
const FORMAT_VERSION = '1.2';            // v1.2: 일화(episodes) + 사실 전체필드 백업. v1.1=완전백업(work+전체대화). v1.0=최근20턴·work없음
const BASE_LAYER_VERSION = '1층-v0.1';  // 결정 B: 버전 참조만
const RECENT_TURNS = 20;                 // (구 v1.0 호환 참조용)

/**
 * 에이전트 + 대화 이력을 표준 에이전트 파일 포맷으로 직렬화.
 * @param {Object} agent  storage에서 로드한 에이전트 객체
 * @param {Array}  messages  전체 대화 이력
 * @param {string} [conversationSummary='']  누적 대화 요약 텍스트 (선택)
 * @returns {Object} 직렬화된 에이전트 파일 객체 (apiKey 미포함 보장)
 */
function serialize(agent, messages, conversationSummary = '', opts = {}) {
  // 내보내기 범위: 기본='개인 인격 레이어'(1층: 인격·기억·관계·지침·요약). includeWork=true면 '완전 백업'(+2층 작업기억 +전체 대화원문).
  const includeWork = opts.includeWork === true;
  // 결정 A: apiKey 절대 미포함 — 명시적 화이트리스트만 사용
  const identity = {
    name: agent.name || '',
    persona: agent.persona || '',
    avatar: agent.avatar || null,  // 프로필 사진 data URL (정체성의 일부, 포함)
  };

  const preferences = {
    speech: agent.speech || 'auto',
    userNickname: agent.userNickname || '',
    auxoMd: agent.auxoMd || '',                 // 사용자 자유 지침(이식 시 함께 따라감, 키 아님)
    disabledSkills: agent.disabledSkills || [], // 이 에이전트에서 끈 스킬 id(구성 선호)
    disabledMcp: agent.disabledMcp || [],       // 이 에이전트에서 끈 MCP id(구성 선호)
    brainMode: agent.brainMode || '',
    baseURL: agent.baseURL || '',               // openai-compatible 제공자 base URL(키 아님, 이식 시 함께)
    // apiKey 는 의도적으로 제외
  };

  // 기억(사실): 전체 필드 보존 → 복원 충실(subject/importance/emotion/sensitive/scope 등).
  //   _emb/_embKey(임베딩 캐시)만 제외 — 모델별·재생성 가능이라 담을 이유 없음.
  const memory = (agent.humanFacts || []).map(f => { const { _emb, _embKey, ...rest } = f || {}; return rest; });
  // 일화(episodes, v3-A): "우리가 함께한 일". 이전 포맷에서 통째 빠져 있던 버그 → 여기서 백업.
  const episodes = Array.isArray(agent.episodes) ? agent.episodes : [];

  const totalMsgs = Array.isArray(messages) ? messages.length : 0;
  // 인격 레이어=대화 원문 제외(요약만), 완전 백업=전체 대화 포함
  const allTurns = includeWork ? (Array.isArray(messages) ? messages : []) : [];

  const doc = {
    format: FORMAT_ID,
    formatVersion: FORMAT_VERSION,
    exportScope: includeWork ? 'full' : 'identity',  // 'identity'=개인 인격 레이어 / 'full'=완전 백업(작업·전체대화 포함)
    exportedAt: new Date().toISOString(),
    meta: {
      id: agent.id || null,
      createdAt: agent.createdAt || null,
      baseLayerVersion: BASE_LAYER_VERSION,   // 결정 B
    },
    identity,
    preferences,
    memory,
    episodes,   // 일화(함께한 일) — v1.2 추가(복원 시 유실 버그 수정)
    // 작업기억(프로젝트·루틴)은 완전 백업일 때만. 인격 레이어 내보내기엔 빈 컨테이너(업무는 성격이 달라 분리).
    work: includeWork ? (agent.work || { activeId: null, projects: [], routines: [] })
                      : { activeId: null, projects: [], routines: [] },
    relationship: {
      firstMet: agent.createdAt || null,
      summary: null,  // 향후 관계 요약 기능에서 채움
    },
    conversationSummary: conversationSummary || null,
    conversation: {
      mode: includeWork ? 'full' : 'summary-only',
      totalTurns: totalMsgs,
      includedTurns: allTurns.length,
      turns: allTurns,
    },
  };

  // 사후 검증: apiKey가 절대 들어가지 않았는지 확인
  _assertNoApiKey(doc);

  return doc;
}

/**
 * 에이전트 파일을 검증하고 역직렬화.
 * @param {any} raw  JSON.parse 된 객체
 * @returns {{ ok: true, data: Object } | { ok: false, error: string }}
 */
function deserialize(raw) {
  if (!raw || typeof raw !== 'object') {
    return { ok: false, error: '파일 형식이 올바르지 않아요. JSON 객체가 아닙니다.' };
  }
  // 옛 이름으로 내보낸 파일도 받아준다(제품명만 바뀌었을 뿐 내용 구조는 동일).
  if (raw.format !== FORMAT_ID && !LEGACY_FORMAT_IDS.includes(raw.format)) {
    return { ok: false, error: `포맷 ID가 맞지 않아요. (기대: "${FORMAT_ID}", 파일: "${raw.format}")` };
  }
  if (!raw.formatVersion) {
    return { ok: false, error: '포맷 버전이 없는 파일이에요.' };
  }
  // 지원 버전: 1.0(구·최근대화·work없음) + 1.1(완전백업) 모두 복원
  const SUPPORTED_VERSIONS = ['1.0', '1.1', '1.2'];
  if (!SUPPORTED_VERSIONS.includes(raw.formatVersion)) {
    return { ok: false, error: `지원하지 않는 포맷 버전이에요. (지원: ${SUPPORTED_VERSIONS.join('/')}, 파일: "${raw.formatVersion}")` };
  }
  if (!raw.identity || !raw.identity.name) {
    return { ok: false, error: '에이전트 이름(identity.name)이 없는 파일이에요.' };
  }
  if (!raw.preferences) {
    return { ok: false, error: 'preferences 구획이 없는 파일이에요.' };
  }

  const data = {
    // 복원 에이전트 객체 (새 id 부여 — import 시 항상 새 에이전트로)
    name: raw.identity.name,
    persona: raw.identity.persona || '',
    avatar: raw.identity.avatar || null,    // 프로필 사진 복원 (없으면 null)
    speech: raw.preferences.speech || 'auto',
    userNickname: raw.preferences.userNickname || '',
    auxoMd: raw.preferences.auxoMd || '',
    disabledSkills: raw.preferences.disabledSkills || [],
    disabledMcp: raw.preferences.disabledMcp || [],
    brainMode: raw.preferences.brainMode || '',
    baseURL: raw.preferences.baseURL || '',     // openai-compatible 제공자 base URL 복원(키 아님)
    // 완전 백업: 작업기억(프로젝트·루틴) 복원. 구 v1.0 파일엔 없으면 빈 컨테이너.
    work: raw.work || { activeId: null, projects: [], routines: [] },
    // apiKey/키 보관함은 의도적으로 복원하지 않음 (결정 A — 파일에 없고 복원도 안 함). 가져온 뒤 사용자가 키 재입력.
    apiKey: '',
    apiKeys: {},
    models: {},
    // 사실: 전체 필드 보존 복원(_emb 캐시만 제외). 옛 v1.0/1.1 파일은 필드가 적지만 로드 시 ensureMemoryShape가 보강.
    humanFacts: (raw.memory || []).map(f => { const { _emb, _embKey, ...rest } = (f || {}); return { label: '', value: '', ...rest }; }),
    // 일화(함께한 일) 복원 — v1.2. (옛 파일엔 없으면 빈 배열)
    episodes: Array.isArray(raw.episodes) ? raw.episodes : [],
    conversationSummary: raw.conversationSummary || '',  // 대화 누적 요약 복원
    // meta 보존 (원본 id 참조용, 새 에이전트 id는 별도 부여)
    originalId: raw.meta?.id || null,
    originalCreatedAt: raw.meta?.createdAt || null,
    baseLayerVersion: raw.meta?.baseLayerVersion || null,
    exportedAt: raw.exportedAt || null,
  };

  // 복원 대화 이력
  const conversation = (raw.conversation?.turns || []);

  return { ok: true, data, conversation };
}

/**
 * export 파일 내에 apiKey 관련 필드가 없는지 재귀 검증.
 * 있으면 즉시 예외 (이 함수가 true 를 반환하면 serialize 버그)
 */
function _assertNoApiKey(obj, path = '') {
  for (const [k, v] of Object.entries(obj)) {
    const fullKey = path ? `${path}.${k}` : k;
    if (/apikey|api_key|token|secret/i.test(k)) {
      throw new Error(`[companion-format] 보안 위반: "${fullKey}" 필드가 export 객체에 포함됐습니다. 즉시 수정 필요.`);
    }
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      _assertNoApiKey(v, fullKey);
    }
  }
}

module.exports = {
  FORMAT_ID,
  LEGACY_FORMAT_IDS,
  FORMAT_VERSION,
  RECENT_TURNS,
  serialize,
  deserialize,
};
