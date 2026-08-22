'use strict';
/**
 * tool-decls.js — **모든 도구 선언의 유일한 원본.**
 *
 * 왜 한 곳인가:
 *   도구 설명을 두 벌로 두면 — 구독 두뇌(MCP)용과 API 키 두뇌(function-calling)용 —
 *   설명문이 서로 갈라지고, 그중엔 알맹이가 다른 것도 생긴다.
 *     예: remember 의 "끝나는 시점이 정해져 있지 않은 것만" 기준이 한쪽에만 있는 식
 *     forget   : 후보 확인 절차와 "도구 안 부르고 지웠다고 하지 마"가 **구독 쪽에만** 있었다
 *   → Gemini·GPT 사용자는 다른 규칙으로 동작하고 있었다.
 *
 * 두뇌가 뭐든 **같은 설명을 봐야 한다.** 전달 형식만 다르다.
 *   구독(MCP)          : { name, description, inputSchema }
 *   API 키(function-calling) : { name, description, parameters }
 *   → 키 이름만 바꿔 넘긴다. 내용은 여기 한 곳뿐이다.
 *
 * ★새 도구를 만들거나 설명을 고칠 땐 **여기만** 고친다.
 *   갈라졌는지는 audit-tool-parity.js 가 잡는다.
 */

const DECLS = [
  {
    name: 'cancel_schedule',
    description: '등록된 정기 작업을 취소한다. id 또는 제목으로.',
    parameters: { type: 'object', properties: { id: { type: 'string', description: '취소할 작업 id 또는 제목' } }, required: ['id'] },
  },
  {
    name: 'close_project',
    description: '프로젝트를 완료 처리한다. 작업기억은 archived 보관, 관계요약 1줄을 1층 기억에 승격.',
    parameters: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
  },
  {
    name: 'create_skill',
    description: '재사용 가능한 방법·절차를 "스킬"로 저장한다(자가학습). 어려운 작업을 성공적으로 해냈고 앞으로 또 쓸 것 같을 때, 또는 사용자가 "이 방법 기억해둬/스킬로 만들어"라고 할 때 호출. 다음엔 find_skill→use_skill로 펼쳐 빠르게 처리. 사소하거나 한 번뿐인 일은 만들지 마.',
    parameters: { type: 'object', properties: {
          name: { type: 'string', description: '스킬 이름(짧게, 예: "PDF 여러 개 합치기")' },
          description: { type: 'string', description: '언제 쓰는 스킬인지 한 줄' },
          body: { type: 'string', description: '방법·절차를 단계별로 자세히 — 다음에 이대로 따라 하면 되게.' },
        }, required: ['name', 'body'] },
  },
  {
    name: 'delegate_to_workers',
    description: '규모가 크거나 여러 갈래로 나눌 수 있는 작업을, 여러 임시 일꾼에게 나눠 동시에 처리시킨다. 각 일꾼은 독립적으로 한 부분을 맡아 결과를 돌려준다(최대 5명, 너와 같은 두뇌). 사용자가 "각각 / 나눠서 / 동시에 / 세 가지를 / 여러 개를" 처럼 여러 항목을 병렬로 처리해 달라고 하면, 그 항목 수만큼(최대 5) 한 번에 tasks 에 담아 위임해. ⚠️ 일부만 위임하고 나머지는 직접 답하는 식으로 쪼개지 마 — 위임하기로 했으면 해당 항목 "전부"를 tasks 에 넣어. 일꾼은 너의 기억·도구를 쓰지 못하고 받은 작업 설명만 보고 일하니, 각 작업을 자세하고 독립적으로 적어줘. 결과가 오면 네가 종합해서 사용자에게 답해. 한두 마디로 끝낼 간단한 일은 위임하지 말고 직접 해.',
    parameters: { type: 'object', properties: {
          tasks: { type: 'array', items: { type: 'string' },
            description: '각 일꾼에게 맡길 작업 설명 배열(최대 5개). 각 항목은 독립적으로 처리 가능해야 함.' },
        }, required: ['tasks'] },
  },
  {
    name: 'find_mcp',
    description: '필요한 능력(브라우저 자동화·파일·메모리 등)의 MCP 서버를 신뢰 카탈로그에서 검색(읽기전용). 설치는 사용자 승인 후 install_mcp로.',
    parameters: { type: 'object', properties: { need: { type: 'string', description: '필요한 능력/작업 키워드' } }, required: ['need'] },
  },
  {
    name: 'find_skill',
    description: '필요한 능력이 설치된 스킬에 없을 때, 신뢰 카탈로그에서 새 스킬 후보를 검색한다(읽기 전용). 설치는 사용자 승인 후 install_skill로.',
    parameters: { type: 'object', properties: { need: { type: 'string', description: '필요한 능력/작업 키워드' } }, required: ['need'] },
  },
  {
    name: 'forget',
    description: '사용자가 특정 기억을 지워달라고 명시적으로 요청할 때만 호출. 임의로 지우지 마.\n'
      + '★사용자가 지워달라고 하지 않았으면 **지울지 먼저 묻지도 마.** 기억이 좀 어긋나거나 겹쳐 보여도 네가 정리할 일이 아니야 — 최신 것을 기준으로 답하면 그만이야. 사용자는 그런 걸 신경 쓰려고 너를 쓰는 게 아니다.\n'
      + '정정(내용이 바뀐 것)은 이걸 쓰지 말고 remember 의 replaces 를 써라.\n'
      + '삭제는 되돌릴 수 없어서, 여러 줄이 걸리면 지우지 않고 후보를 돌려준다(needsPick). 그때는 — **사용자가 지워달라고 한 경우에 한해** — 어느 것인지 확인한 뒤, 그 줄의 내용을 그대로 query 에 넣어 다시 불러.\n'
      + '★도구를 부르지 않고 "지웠다"고 말하면 안 된다 — 실제로 이 도구를 불러야 지워진다.',
    parameters: { type: 'object', properties: {
        query: { type: 'string', description: '지울 기억을 가리키는 말. 하나로 특정되게 구체적으로(가능하면 그 줄 내용 그대로).' },
      }, required: ['query'] },
  },
  {
    name: 'install_mcp',
    description: 'MCP 도구(서버)를 설치·연결한다. 사용자에게 확인받은 뒤 호출. 두 가지를 다 할 수 있어: ①설치형 — find_mcp 후보의 id로(필요한 입력이 있으면 params). ②원격형 — 사용자가 준 인터넷 주소(url)로. 카카오 PlayMCP처럼 주소로 접속하는 MCP는 url에 그 주소를 넣어. 인증 토큰이 필요하면 token에 넣으면 Authorization 헤더로 붙고, 특수한 헤더가 필요하면 headers에 직접 넣어. 원격은 이 컴퓨터에 아무것도 설치하지 않아 Node.js도 필요 없어.',
    parameters: { type: 'object', properties: {
          id: { type: 'string', description: '설치형 MCP의 id (원격이면 생략 가능, 이름 대용으로 써도 됨)' },
          params: { type: 'object', description: '설치형이 요구하는 입력(폴더 경로·API 키 등)' },
          url: { type: 'string', description: '원격 MCP 주소(예: https://playmcp.kakao.com/mcp)' },
          token: { type: 'string', description: '원격 MCP 인증 토큰(있을 때만). Bearer 로 붙는다.' },
          refreshToken: { type: 'string', description: '토큰을 교환해서 받았고 리프레시 토큰이 함께 왔다면 꼭 같이 넘겨. 만료되면 앱이 알아서 갱신해서 사용자가 다시 발급받지 않아도 된다.' },
          headers: { type: 'object', description: '원격 MCP에 보낼 추가 HTTP 헤더(특수한 경우만)' },
          confirm: { type: 'boolean', description: '사전 점검에서 경고가 나와 needsConfirm 을 받았을 때, 그 내용을 사용자에게 알리고 승인받은 뒤에만 true 로 다시 호출. 네 판단으로 임의로 true 를 넣지 마.' },
        } },
  },
  {
    name: 'install_skill',
    description: '카탈로그의 스킬을 설치한다. 사용자 승인 후 호출. find_skill 후보의 id로.',
    parameters: { type: 'object', properties: { id: { type: 'string', description: '카탈로그 스킬 id' } }, required: ['id'] },
  },
  {
    name: 'install_skill_web',
    description: '카탈로그·신뢰 레지스트리에도 없을 때, 웹에서 찾은 공개 스킬(GitHub의 SKILL.md 링크)을 설치한다. 반드시 web_search 등으로 찾은 출처(URL)를 사용자에게 보여주고 승인받은 뒤 호출. 보안 검수(패턴+AI 판정)를 통과해야만 설치되며 위험하면 자동 차단된다. GitHub raw/blob 링크만 가능.',
    parameters: { type: 'object', properties: { url: { type: 'string', description: '공개 SKILL.md 링크(github.com/.../blob/... 또는 raw.githubusercontent.com/...)' } }, required: ['url'] },
  },
  {
    name: 'list_files',
    description: '폴더 안의 파일·하위폴더 목록을 본다. 허용된 폴더 안에서만.',
    parameters: { type: 'object', properties: { dir: { type: 'string', description: '폴더 경로' } }, required: ['dir'] },
  },
  {
    name: 'list_schedules',
    description: '등록된 정기 작업 목록을 본다.',
    parameters: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'make_dir',
    description: '폴더를 만든다. 허용된 폴더 안에서만.',
    parameters: { type: 'object', properties: { dir: { type: 'string', description: '만들 폴더 경로' } }, required: ['dir'] },
  },
  {
    name: 'move_file',
    description: '파일·폴더를 옮기거나 이름을 바꾼다. 허용된 폴더 안에서만. 이름만 바꿀 때도 이걸 써라 — 셸로 하지 마라. 그 이름이 이미 있으면 실패한다(덮어쓰지 않는다).',
    parameters: { type: 'object', properties: { from: { type: 'string', description: '지금 경로' }, to: { type: 'string', description: '바꿀 경로(이름만 바꾸려면 같은 폴더에 새 이름)' } }, required: ['from', 'to'] },
  },
  {
    name: 'copy_file',
    description: '파일·폴더를 복사한다. 폴더면 안의 것까지 함께. 허용된 폴더 안에서만. 그 이름이 이미 있으면 실패한다(덮어쓰지 않는다).',
    parameters: { type: 'object', properties: { from: { type: 'string', description: '복사할 것' }, to: { type: 'string', description: '복사해 넣을 곳' } }, required: ['from', 'to'] },
  },
  {
    name: 'remove_file',
    description: '파일·폴더를 지운다. 되돌릴 수 없으므로 **사용자에게 먼저 확인하고** 불러라. 폴더를 지우면 안에 든 것도 함께 사라진다. 허용된 폴더 안에서만.',
    parameters: { type: 'object', properties: { path: { type: 'string', description: '지울 것' }, confirmed: { type: 'boolean', description: '사용자가 지워도 된다고 분명히 말했으면 true. 안 물어봤으면 넣지 마라' } }, required: ['path'] },
  },
  {
    name: 'plan_task',
    description: '큰 작업을 단계별로 분해하고 순차 실행한다(L3). 여러 단계가 필요한 복잡한 작업에. 실행 전 계획을 먼저 제시하고 승인받는다.',
    parameters: { type: 'object', properties: { task: { type: 'string' }, projectId: { type: 'string' }, autoApprove: { type: 'boolean' } }, required: ['task'] },
  },
  {
    name: 'read_file',
    description: '파일 내용을 읽는다(텍스트). 허용된 폴더 안에서만.',
    parameters: { type: 'object', properties: { path: { type: 'string', description: '파일 경로' } }, required: ['path'] },
  },
  {
    name: 'remember',
    description: '사용자에 관해 새로 알게 된 것을 장기 기억에 저장한다. **끝나는 시점이 정해져 있지 않은 것**만 — 건강·가족·직업·습관·취향처럼 이 사람이 어떤 사람인지. "다음 주 회의", "이직 준비 중"처럼 끝나면 사라질 일은 저장하지 마(그건 따로 기록된다).\\n★이미 기억에 있는 내용이 바뀐 거라면(정정·번복·수치 변경) **새로 추가하지 말고** replaces 에 지금 기억에 적혀 있는 그 줄을 **글자 그대로** 옮겨 적어라. 그래야 그 줄이 갈아끼워진다. replaces 없이 부르면 옛 줄이 그대로 남아 새 줄과 어긋난 채 둘 다 남는다. 지운다고 forget 을 먼저 부를 필요 없다 — 정정은 replaces 하나로 끝난다.',
    parameters: { type: 'object', properties: {
          text: { type: 'string', description: '기억할 내용을 한 문장으로(예: "커피를 하루 두 잔 마심")' },
          replaces: { type: 'string', description: '정정일 때만. 갈아끼울 기존 줄을 지금 기억에 적힌 그대로 옮겨 적는다. 새 내용이면 비워 둔다.' },
        }, required: ['text'] },
  },
  {
    name: 'remove_mcp',
    description: '설치된 MCP 도구(서버)를 삭제한다. **사용자가 지워달라고 했을 때만** 호출 — 네 판단으로 먼저 지우지 마. 지우면 그 서버의 도구를 더는 못 쓴다. id를 모르면 아무거나 넣어봐, 설치 목록을 알려줄게.',
    parameters: { type: 'object', properties: { id: { type: 'string', description: '지울 MCP의 id 또는 이름' } }, required: ['id'] },
  },
  {
    name: 'resume_task',
    description: '중단된 프로젝트의 작업을 이어서 실행한다(done 단계는 건너뜀).',
    parameters: { type: 'object', properties: { projectId: { type: 'string' } }, required: ['projectId'] },
  },
  {
    name: 'run_code',
    description: '코드를 작성해 실행한다(python/node/bash). 긴 코드나 따옴표가 많은 코드엔 run_shell보다 편하다. 허용 폴더에서 실행하고 stdout을 돌려준다. 셸/코드 실행은 사용자 허락이 필요(허락은 사용자만).',
    parameters: { type: 'object', properties: { language: { type: 'string', description: 'python | node | bash' }, code: { type: 'string', description: '실행할 코드 전체' }, cwd: { type: 'string', description: '작업 폴더(생략 시 허용폴더 기본)' } }, required: ['language', 'code'] },
  },
  {
    name: 'run_shell',
    description: '터미널/셸 명령을 실행한다(허용된 폴더를 작업위치로). 파괴적·위험 명령은 자동 차단됨. 이 컴퓨터 OS에 맞는 명령을 써. 셸 사용이 아직 허용 안 됐으면 결과 안내대로 사용자 허락을 구해.',
    parameters: { type: 'object', properties: { command: { type: 'string', description: '실행할 명령' }, cwd: { type: 'string', description: '작업 폴더(생략 시 허용폴더 기본)' } }, required: ['command'] },
  },
  {
    name: 'schedule_task',
    description: '특정 시각 한 번(리마인더) 또는 반복(매일/**매주**/**매월**/**매년**/매시/N분마다) 자동 실행할 일을 등록한다. "11시 41분에 알려줘"·"내일 3시에 리마인드"는 kind=once, "매일 9시 뉴스"는 daily, **"매주 화요일 아침"은 weekly(dow)**, **"매월 25일 월세"·"말일에 정산"은 monthly(dom)**, **"매년 3월 5일 어머니 생신"은 yearly(month+dom)**. **"다음 주 화요일"·"8월 13일"처럼 한 번뿐인 날짜는 kind=once — date 에 그 날짜(YYYY-MM-DD), at 에 시각(HH:MM)을 넣어라.** 생일·기념일처럼 **해마다 돌아오는 것은 once 가 아니라 yearly 다** — once 로 걸면 내년엔 안 온다. PC가 켜져 있는 동안 그 시각에 실행돼 결과를 전한다. 실제로 등록됐을 때만(scheduled:true) "예약했다"고 답해 — 지어내지 마.',
    parameters: { type: 'object', properties: {
          title: { type: 'string', description: '짧은 이름(예: 이메일 알림)' },
          kind: { type: 'string', enum: ['once', 'daily', 'weekly', 'monthly', 'yearly', 'hourly', 'interval'], description: 'once=특정 시각에 한 번(리마인더), daily=매일 특정시각, **weekly=매주 특정 요일(dow 필수)**, **monthly=매월 특정일(dom 필수)**, **yearly=매년 특정 월·일(month+dom 필수)**, hourly=매시 정각, interval=N분마다' },
          // ★주·월·년 주기가 없으면 흔한 생활 주기를 담을 수 없다.
          //   주: "매주 화요일 원두 받고 재고 세기" / 월: 월세·카드값·월 정산 / 년: 생일·기념일.
          //   daily 로 걸고 그날만 뜨게 하는 우회는 나머지 날에 두뇌를 헛되이 부르고
          //   "조용히 종료" 응답이 대화에 매일 쌓인다.
          dow: { type: 'string', description: 'weekly 일 때 **요일**. "화"·"화요일"·"tue"·숫자(0=일 … 6=토) 다 된다. weekly 면 반드시 넣어라 — 없으면 등록이 거부되고 사용자에게 되물어야 한다.' },
          dom: { type: 'string', description: 'monthly/yearly 일 때 **날짜**. "25"·"25일"·**"말일"**(그 달 마지막 날) 다 된다. 없는 날(2월 31일 등)이면 **그 달 마지막 날로 당겨서** 실행된다. 반드시 넣어라.' },
          month: { type: 'string', description: 'yearly 일 때 **달**. "3"·"3월"·"mar" 다 된다. yearly 면 반드시 넣어라.' },
          at: { type: 'string', description: 'once/daily/**weekly/monthly/yearly**일 때 HH:MM (예: 11:41). once 에서 date 없이 at 만 주면 오늘 그 시각(이미 지났으면 내일).' },
          // ★엔진(scheduler._onceAtMs)이 지원해도 이 선언에 안 적으면 두뇌는 쓸 방법이 없다.
          //   그러면 "다음 주 화요일" 요청에 kind=daily 로 우회해(매일 깨워 "오늘이 그날인가"를 판단) 매일 헛돈다.
          // ★예전엔 여기서 atMs(epoch 밀리초)를 두뇌에게 계산시켰다. **그게 틀린 설계였다** —
          //   실측(2026-08-14) gemini 는 같은 요청에서 4/4 빗나갔다(-13.3시간·+9.7시간·-6.3시간…).
          //   "8월 21일 오후 2시"라고 **말은 정확히 하면서** 13자리 산술에서만 어긋난다. codex 는 3/3 맞혔지만,
          //   되는 두뇌가 있다는 게 설계가 맞다는 뜻은 아니다 — 사용자는 두뇌를 고를 뿐인데 알림이 엉뚱한 때 온다.
          //   → 두뇌는 사람이 읽는 날짜만 대고 **변환은 코드가 한다**(scheduler._onceAtMs).
          //   atMs 는 엔진이 아직 받지만(옛 예약 호환) **여기서는 일부러 뺐다.** 보이면 또 쓰려 든다.
          date: { type: 'string', description: 'once 일 때 **그 날짜**를 YYYY-MM-DD 로 (예: 2026-08-21). "다음 주 금요일"·"모레"처럼 오늘·내일이 아닌 날은 **반드시 이걸 써라.** 시스템 프롬프트의 [현재 시각]을 기준으로 날짜를 세면 된다 — 시각으로 바꾸는 계산은 하지 마라. 시각은 at 에 HH:MM 으로 따로 넣어라.' },
          everyMin: { type: 'number', description: 'interval일 때 분 간격(예: 30)' },
          prompt: { type: 'string', description: '그 시각에 너 자신에게 줄 지시(예: "오늘 주요 뉴스 5개를 한국어로 요약해줘")' },
          channel: { type: 'string', enum: ['telegram', 'app', 'cli'], description: '결과를 보낼 곳. 사용자가 정한 대로 채워(예: "텔레그램으로 보내줘"→telegram). 사용자가 안 정했으면 등록 전에 "결과를 어디로 받으실래요?(텔레그램/여기)"라고 물어보고 채워.' },
        }, required: ['title', 'kind', 'prompt'] },
  },
  {
    name: 'search_files',
    description: '폴더 하위에서 이름에 키워드가 든 **파일과 폴더**를 찾는다. 허용된 폴더 안에서만. 결과의 folders 에는 그중 폴더만 따로 담긴다 — 이름을 바꾸거나 지울 대상이 폴더인지 파일인지 여기서 가려라.',
    parameters: { type: 'object', properties: { dir: { type: 'string', description: '검색 시작 폴더' }, query: { type: 'string', description: '이름 키워드(빈 값이면 전체). 폴더 이름도 찾는다' } }, required: ['dir'] },
  },
  {
    name: 'search_memory',
    description: '예전 대화·기억·아카이브를 검색한다. 사용자가 "저번에/그때/지난주에 ~한 거", "그 식당·그 사람·그거 뭐였지"처럼 지금 대화창에 없는 과거를 물으면, 지어내지 말고 이 도구로 먼저 찾아봐. query엔 핵심 키워드(장소·주제·이름 등)를 넣어. 결과가 없으면 솔직히 "기록에 없다"고 해.',
    parameters: { type: 'object', properties: { query: { type: 'string', description: '찾을 핵심 키워드' } }, required: ['query'] },
  },
  {
    name: 'send_file',
    description: '허용된 폴더 안의 파일을 사용자에게 채팅으로 보낸다(전달). 사용자가 "그 파일 줘/보내줘"라고 하거나 네가 만든 결과 파일을 건넬 때 호출. 허용폴더 안 파일만. 링크·버튼을 글로 지어내지 말고 반드시 이 도구를 호출해.',
    parameters: { type: 'object', properties: { path: { type: 'string', description: '보낼 파일 경로(허용 폴더 안)' }, note: { type: 'string', description: '함께 전할 짧은 설명(선택)' } }, required: ['path'] },
  },
  {
    name: 'set_heartbeat',
    description: '"먼저 안부 묻기(하트비트)" 설정을 바꾼다. 하트비트는 아침·저녁 하루 2번 네가 먼저 다정하게 안부를 건네는 기능이야. 사용자가 "먼저 말 걸지 마/그만"→enabled=false, "다시 챙겨줘/먼저 말 걸어줘"→enabled=true, "아침 인사 8시로"→morning, "저녁 인사 6시로"→evening 으로 바꿔달라 할 때 호출.',
    parameters: { type: 'object', properties: {
          enabled: { type: 'boolean', description: '켜기(true)/끄기(false)' },
          morning: { type: 'string', description: '아침 인사 시각 HH:MM' },
          evening: { type: 'string', description: '저녁 인사 시각 HH:MM' },
        } },
  },
  {
    name: 'set_trust',
    description: '도구 사용 "승인 정도(자율도)"를 바꾼다. 사용자가 앞으로의 방침을 바꿔달라고 할 때만 호출 — 예: "앞으로 묻지 말고 알아서 해"·"매번 안 물어봐도 돼"·"항상 허용" → autonomous, "위험한 것만 물어봐"·"중요한 건 확인해" → ask_risky, "뭐든 일일이 물어봐"·"항상 확인받아" → ask_all. 단발성 "승인/그래"(이번 한 번만 허락)와는 구분해 — 그건 set_trust를 부르지 말고 그냥 작업해.',
    parameters: { type: 'object', properties: { level: { type: 'string', enum: ['ask_all', 'ask_risky', 'autonomous'], description: 'autonomous=확인 없이 진행, ask_risky=위험 작업만 확인(기본), ask_all=모든 변경 작업 확인' } }, required: ['level'] },
  },
  {
    // ★호칭은 **대화 그 자리에서** 정한다.
    //   그릇 편집에 얹으면 압축 시점까지 여러 턴이 밀리는데,
    //   호칭은 **사용자가 바로 알아채는 자리**라 그건 안 된다 → 즉시 경로를 도구로 뚫는다.
    //   판정 주체는 그대로 LLM 이고, 자리만 대화 호출이다.
    name: 'set_nickname',
    description: '사용자가 "나를 ○○라고 불러"처럼 **자기를 어떻게 부를지 정해줄 때만** 호출한다. 정한 즉시 그렇게 부르기 시작해. 호칭 문자열만 넣어(예: "형", "대장"). 사용자가 자기 이름을 알려준 것뿐이면(예: "나 민수야") 부르는 방식을 정한 게 아니니 호출하지 말고 remember 로 기억해. 제3자 호칭("우리 형이 …")도 아니다.',
    parameters: { type: 'object', properties: { nickname: { type: 'string', description: '부를 말 하나. 문장·복수후보 금지(예: "형" O / "형 또는 형님" X)' } }, required: ['nickname'] },
  },
  {
    name: 'start_project',
    description: '새 프로젝트를 시작한다(시작과 끝이 있는 일). 사용자가 새 프로젝트를 언급하거나 "프로젝트로 진행"을 원할 때.',
    parameters: { type: 'object', properties: { title: { type: 'string' }, goal: { type: 'string' } }, required: ['title', 'goal'] },
  },
  {
    name: 'start_routine',
    description: '반복 루틴을 등록한다(끝없이 반복되는 일). 정기 반복 작업을 언급할 때.',
    parameters: { type: 'object', properties: { title: { type: 'string' }, rhythm: { type: 'string' } }, required: ['title'] },
  },
  {
    name: 'switch_work',
    description: '현재 활성 작업을 전환한다. id는 start_project/start_routine이 반환한 id.',
    parameters: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
  },
  {
    name: 'uninstall_skill',
    description: '설치된 스킬을 삭제한다. **사용자가 지워달라고 했을 때만** 호출 — 네 판단으로 먼저 지우지 마. id를 모르면 아무거나 넣어봐, 설치 목록을 알려줄게.',
    parameters: { type: 'object', properties: { name: { type: 'string', description: '지울 스킬의 id 또는 이름' } }, required: ['name'] },
  },
  {
    name: 'use_skill',
    description: '설치된 스킬의 전체 사용법을 펼쳐 읽는다. [사용 가능한 스킬] 목록의 이름으로 호출.',
    parameters: { type: 'object', properties: { name: { type: 'string', description: '스킬 이름 또는 id' } }, required: ['name'] },
  },
  {
    name: 'web_search',
    description: '인터넷을 검색해 관련 페이지(제목·링크·요약)를 찾는다. 실시간 정보·최신 사실·모르는 것을 알아볼 때 적극 사용. 결과의 링크는 링크 읽기 도구로 더 자세히 읽을 수 있어. (읽기 전용, 승인 불필요)',
    parameters: { type: 'object', properties: { query: { type: 'string', description: '검색어' }, max: { type: 'number', description: '결과 개수(기본 5, 최대 10)' } }, required: ['query'] },
  },
  {
    name: 'write_file',
    description: '파일을 만들거나 내용을 쓴다(덮어씀). 허용된 폴더 안에서만. 폴더가 허용 안 됐으면 결과의 needGrant 경로를 사용자에게 알리고 허용을 구해.',
    parameters: { type: 'object', properties: { path: { type: 'string', description: '파일 경로' }, content: { type: 'string', description: '쓸 내용' } }, required: ['path', 'content'] },
  },
];

const byName = new Map(DECLS.map((d) => [d.name, d]));

/** 이름으로 고른다. 없는 이름은 조용히 건너뛴다(선언 누락이 도구 전멸로 번지지 않게). */
function pick(names) {
  return names.map((n) => byName.get(n)).filter(Boolean);
}

/** MCP 형식으로 변환 — parameters → inputSchema. 내용은 그대로. */
function toMcp(decls) {
  return decls.map((d) => ({ name: d.name, description: d.description, inputSchema: d.parameters }));
}

module.exports = { DECLS, byName, pick, toMcp };

// ── 지연 로딩 ──────────────────────────────────────────────────────────
//   왜: 도구 설명은 통틀어 만 자가 넘는다. **매 턴 통째로** 들어가고, 사용자가 MCP 를 깔면
//       거기에 그대로 더해진다(서버 하나만 깔아도 수십 개가 붙는다).
//       → 그대로 두면 능력을 갖출수록 비싸진다. 능력 획득이 제품 핵심인데 벌점이 되는 셈이다.
//
//   ★가르는 기준은 "우리 것 vs MCP"가 아니라 **못 썼을 때 티가 나느냐**다.
//     · 기억 도구는 조용히 실패한다 — 안 지워도 사용자는 모른다. → 항상 싣는다
//     · 파일·셸·설치는 결과가 눈에 보인다. 안 되면 티가 난다.       → 미뤄도 된다
//
//   ※ 구독 두뇌(claude/codex)는 **CLI 가 이미 지연 로드**한다.
//     여기 지연은 API 키 두뇌(function-calling)에만 적용한다. 이중 지연은 위험하다.
//   ※ 안전망: 못 꺼내고 "했다"고 하면 claim-check 가 잡는다. 그게 먼저 있어야 이걸 켠다.
// set_nickname 을 항상 싣는 이유: 미뤄두면 두뇌가 호칭 하나 때문에 load_tools 를 부르지 않는다.
//   비용은 API 키 두뇌에만 ~250토큰/턴(구독은 MCP 라 사실상 0), 대신 그릇 편집 호출을
//   압축 시점으로 옮겨 평균 −2,800토큰/턴을 얻는다.
const ALWAYS = ['remember', 'forget', 'search_memory', 'web_search', 'set_nickname'];

/** 미루는 도구를 두뇌가 꺼내 쓰는 통로. 이름은 목록에서 그대로 고른다(키워드 검색보다 정확). */
const LOAD_TOOLS = {
  name: 'load_tools',
  description: '지금 필요한 도구를 꺼내 온다. [지금 꺼내 쓸 수 있는 도구] 목록의 이름을 그대로 넣어라.\n'
    + '꺼내면 **이번 턴 안에서 바로** 쓸 수 있다. 여러 개를 한 번에 꺼내도 된다.\n'
    + '★파일·설치·실행·예약처럼 실제로 무언가를 바꾸는 일은 **반드시 먼저 꺼내서 그 도구를 불러라.**\n'
    + '꺼내지 않고 "했다"고 말하면 안 된다. 못 꺼냈으면 못 한다고 솔직히 말해.',
  parameters: { type: 'object', properties: {
    names: { type: 'array', items: { type: 'string' }, description: '꺼낼 도구 이름들(목록에 있는 그대로)' },
  }, required: ['names'] },
};

/** 항상 싣는 것 / 미루는 것으로 가른다. */
function splitForDeferred(allNames) {
  return {
    always: allNames.filter((n) => ALWAYS.includes(n)),
    deferred: allNames.filter((n) => !ALWAYS.includes(n)),
  };
}

/** 미룬 도구를 1층에 보여줄 "이름(한 줄)" 목록. 두뇌가 여기서 골라 load_tools 로 꺼낸다. */
function deferredIndex(names, extra = []) {
  const out = [];
  for (const n of names) {
    const d = byName.get(n) || extra.find((x) => x && x.name === n);
    if (!d) continue;
    const first = String(d.description || '').split(/[.。\n]/)[0].trim().slice(0, 44);
    out.push(first ? (n + '(' + first + ')') : n);
  }
  return out.join(', ');
}

// ── 꺼내기와 쓰기를 같은 라운드에 못 하게 ────────────────────────────────
/**
 * 지연 로딩은 **꺼낸다 → (설명을 받는다) → 쓴다** 순서를 전제로 한다.
 * 그런데 두뇌는 한 라운드에 여러 도구를 **한꺼번에** 낼 수 있다.
 * 그러면 `load_tools` 와 대상 도구가 같이 나와, **설명이 도착하기 전에 인자가 이미 정해진다.**
 *
 * 실측(gemini): `load_tools(["schedule_task"])` 와 `schedule_task({when,task})` 가 한 라운드에 왔고,
 *   실제 인자는 `title·kind·prompt` 라 실패했다. 다른 회차에선 라운드가 나뉘어 정확히 불렀다 —
 *   **되고 안 되고가 운에 달려 있었다.**
 *   1층에는 도구 **이름과 한 줄 설명만** 나가고 인자 정보는 없다(그게 지연 로딩의 목적).
 *   그러니 설명을 못 본 채 부르면 인자를 지어낼 수밖에 없다.
 *
 * 그래서 **방금 꺼낸 도구는 그 라운드에서 실행하지 않고** 다시 부르게 한다.
 * 새 규칙을 만드는 게 아니라 **원래 정한 순서를 코드로 지키게 하는 것**이다.
 *
 * 두뇌마다 따로 구현하면 갈라지므로 여기 한 곳에 둔다(gemini·openai·anthropic 공용).
 * 라운드마다 새로 만들어 쓴다 — 라운드가 끝나면 버려지므로 다음 라운드는 정상 통과한다.
 */
function newRoundGuard() {
  const 방금꺼냄 = new Set();
  return {
    /** 이번 라운드에 방금 꺼낸 도구인가(=설명을 아직 못 본 채 부르는 것인가). */
    blocked(name) { return 방금꺼냄.has(String(name)); },
    /** load_tools 결과를 보고 "방금 꺼낸 것" 목록을 채운다. */
    note(name, result) {
      if (String(name) !== LOAD_TOOLS.name) return;   // LOAD_TOOLS 는 이름이 아니라 선언 객체다
      // ★`newly`(이번에 처음 꺼낸 것)만 잠근다. `loaded` 는 이미 실려 있던 것도 포함하므로
      //   그걸 쓰면 remember 처럼 늘 실려 있는 도구까지 막힌다(검증에서 실제로 걸렸다).
      const 새로 = result && result.newly;
      if (Array.isArray(새로)) for (const n of 새로) 방금꺼냄.add(String(n));
    },
    /** 막을 때 두뇌에게 돌려줄 말. **왜 안 됐는지와 무엇을 하면 되는지**를 함께 준다. */
    message(name) {
      return {
        error: `'${name}' 는 방금 꺼낸 도구야. 설명이 이제 막 도착했으니 **그 설명을 보고 다시 불러줘.**`,
        hint: '이번 호출은 실행하지 않았어. 지어낸 인자로 부르면 실패하니, 설명에 적힌 인자 이름을 그대로 써.',
        executed: false,
      };
    },
  };
}

module.exports.ALWAYS = ALWAYS;
module.exports.LOAD_TOOLS = LOAD_TOOLS;
module.exports.splitForDeferred = splitForDeferred;
module.exports.deferredIndex = deferredIndex;
module.exports.newRoundGuard = newRoundGuard;

