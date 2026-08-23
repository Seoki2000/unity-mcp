# Unity MCP Server 🚀

[![Unity 2021.3+](https://img.shields.io/badge/Unity-2021.3%2B-blue.svg)](https://unity.com)
[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](LICENSE)
[![MCP](https://img.shields.io/badge/MCP-Compatible-purple.svg)](https://modelcontextprotocol.io)

*Read this in other languages: [English](README.md)*

AI 에이전트가 Unity 에디터를 **조회하고 제어**할 수 있게 해주는 Unity용 **MCP(Model Context Protocol)** 서버입니다. 이 버전은 로컬 최적화 버전으로, Behavior Tree(행동 트리), 창(Window) 관리, 고급 GameObject/계층(Hierarchy) 조작 기능이 추가로 확장되었습니다.

## 포크 개발 버전 — dev-0.0.1

이 포크(`Seoki2000/unity-mcp`, 브랜치 `optimized`)의 개발 기록. 업스트림과, 게임
프로젝트가 이전에 핀으로 쓰던 `2ea969e` 와 **무엇이 어떻게 다른지 실측값으로** 적는다.
추정이 아니라 살아있는 Unity 에 붙여 JSON-RPC 를 직접 넣고 잰 값이다.

패키지 버전: `2.3.0-dev.0.0.1` · 기준 커밋: `5331a34`

### 들어온 것 (2ea969e → dev-0.0.1)

- **보안** — 경로 탈출 차단(`McpPathGuard`), 세션 토큰 인증(`McpAuthToken`). 둘 다 신규 파일
- **컨텍스트 위생** — 툴 annotations, 페이지네이션(`McpPaging`), 검색 랭킹, 응답 상한
- **아웃프로세스 프로젝트 인덱스** — 참조 역방향 조회, 어셈블리 심볼 + PDB 소스 매핑,
  IL 호출 그래프. 브릿지 쪽 툴 8개(`unity_find_*`, `unity_get_type_symbols`, `unity_index_*`)
- **Behavior 저작 툴 6개** — 게임 레포 `Assets/` 에 흩어져 있던 것을 패키지로 회수
- **브릿지 런처** — `PackageCache` 해시 폴더를 실행 시점에 탐색

도구 수: **67 → 81** (Editor 73 + 브릿지 8). 제거된 도구는 없다.

annotations 선언: **0 → 52건** (ReadOnly 26 / Destructive 10 / Idempotent 16).
라이브 `tools/list` 에서 81개 전부 힌트를 달고 나온다 — `readOnlyHint` 33, `destructiveHint` 10.
구버전에는 `annotations` 필드 자체가 없었다.

응답 상한: `ResourceHandler` 372 → 517줄, `MAX_TEXT_LINES = 2000` / `MAX_TEXT_CHARS = 200000` 신규.
페이지네이션(`nextOffset`/`truncated`) 언급 5곳 → 32곳.

### tools/list 고정비 — 줄지 않았다, 늘었다

`tools/list` 는 세션마다 통째로 오가는 고정비다.

| 상태 | 바이트 | 도구 | 도구당 |
|---|---|---|---|
| `2ea969e` (이전 핀) | 24,968 | 67 | 372.7 |
| dev-0.0.1 (다이어트 전) | 40,376 | 81 | 498.5 |
| **dev-0.0.1 (현재)** | **37,067** | **81** | **457.6** |

이전 핀 대비 **+48.5%**. 3.5~4 B/토큰으로 환산하면 세션당 **+3,000~3,500 토큰**이다.
도구를 14개 늘렸고, annotations 를 새로 달았고, 공통 도구 4개의 설명이 +345자 늘어난 결과다.
dev-0.0.1 에서 그중 3,309 B(약 900 토큰)를 무손실로 되돌렸다.

측정 방법: 현재 값은 라이브 `tools/list` 응답 실측. 구버전 값은 소스에서 도구·설명·
파라미터를 추출해 재구성했고, **같은 추출기로 현재 리비전을 재구성해 라이브와 대조**해
신뢰도를 확인했다(73개 중 55개 정확 일치, 잔차는 중첩객체·enum 미구현 탓이며 두 리비전에서
동일하므로 차분에서 상쇄된다).

### 페이로드가 어디로 가는가 (다이어트 판단 근거)

| 항목 | 바이트 | 비중 |
|---|---|---|
| `inputSchema` | 22,872 | **56.7%** |
| `description` | 5,638 | 14.0% |
| `annotations` | 5,496 | 13.6% |
| `name` | 1,929 | 4.8% |

설명이 아니라 스키마가 절반 이상이다. 여섯 가지 다이어트를 라이브 페이로드에 직접
적용해 본 결과:

| 전략 | 절감 | 도구 수 |
|---|---|---|
| 파라미터 설명 전부 제거 | −26.6% | 81 |
| 스펙 기본값 힌트 생략 | −9.3% | 81 |
| `*_bt_*` 6개 제거 | −6.9% | 75 |
| 입력 시뮬레이션 3개 제거 | −5.2% | 78 |
| 도구 설명 100자 절단 | −3.1% | 81 |
| 파라미터 설명 60자 절단 | −1.9% | 81 |

**도구를 지우는 것은 도구당 1.2% 밖에 못 줄인다**(평균 497 B). 가장 큰 덩어리인 파라미터
설명은 −26.6% 지만 그건 도구를 맞게 쓰기 위한 정보다. 그래서 도구를 지우지 않고,
무손실인 것만 골라 구현했다.

### 구현한 다이어트 — 스펙 기본값 생략 (무손실)

MCP 스펙이 정한 기본값과 같은 힌트는 실어도 정보가 없다. 기본값은
`readOnlyHint=false` / `destructiveHint=`**`true`** / `idempotentHint=false` 다.

`destructiveHint` 가 함정이다. 기본이 true 라서 **false 를 생략하면 안전한 도구가
파괴적으로 뒤집힌다.** 그래서 false 일 때만 명시하고 true 를 생략한다. 대가로 읽는 쪽이
기본값을 적용해야 하는데, 브릿지 자신의 재시도 판단(`isIdempotentTool`)이 그 필드를
그대로 읽고 있었으므로 함께 고쳤다. 서버가 만들 수 있는 8개 조합 전부에서 구/신 판단이
일치함을 확인했다.

실측: **40,376 → 37,067 B (−3,309, −8.2%)**. annotations 5,496 → 2,763 B,
`JsonUtility` 가 남긴 빈 `required:[]` 29개 → 0. 설명과 스키마는 건드리지 않았다.

### 질의당 비용 — 실측

| 질문 | 인덱스 | 대안 |
|---|---|---|
| 이 스크립트가 붙은 에셋은? | 1회 **1,133 B** → 9개 경로 | 프리팹 9개 직접 읽기 **3.8 MB** · GUID grep 2단계 **1,391 B** |
| 이 메서드를 호출하는 곳은? | **412 B** | `grep` **290 B** |

정직하게 적는다. **단순하고 유일한 이름의 호출자 찾기는 grep 이 더 싸다.**
`unity_find_callers` 의 가치는 바이트가 아니라 IL 디코딩 정확성이다 — 주석·문자열 오탐이
없고, 오버로드가 한 키로 병합된다는 사실을 응답에 명시한다.

### 정정 — 응답 상한 30은 구버전에도 있었다

`MAX_RESULTS = 30` 은 `2ea969e` 에도 있었다. **응답이 작아진 것이 아니다.** 달라진 것은
`nextOffset`/`truncated` 로 **상한 너머에 도달할 수 있게** 된 점이다. 구버전은 30개에서
막히고 나머지(예: 에셋 3,142개 중 3,112개)에 접근할 방법이 없었다.

### dev-0.0.1 에서 잡은 인덱스 커버리지 버그

Windows 정션은 `readdirSync` 의 `Dirent` 에서 `isDirectory()` 거짓 / `isSymbolicLink()` 참으로
보고된다. 스캐너는 `isDirectory()` 와 `isFile()` 두 분기만 보고 있었으므로 정션 항목은
어느 쪽에도 걸리지 않고 **통째로 사라졌다.** Unity 는 정션을 따라가므로 그 안의 에셋은
엄연히 프로젝트의 일부인데 인덱스에만 없었다.

이 프로젝트는 `Assets/50.Art` 가 외부 폴더를 가리키는 정션이고, 그 아래 `.meta` 1,105개와
YAML 348개가 빠져 있었다 — 프로젝트 `.meta` 의 **35%**. 게다가 `filesFailed: 0` 이 계속
떠서 빠진 것을 알 방법이 없었다.

| 인덱스 (Assets 기준) | 수정 전 | 수정 후 |
|---|---|---|
| `.meta` | 2,037 | **3,142** |
| YAML | 783 | 1,131 |
| 참조 엣지 | 4,355 | 5,586 |
| 스크립트 GUID | 276 | 287 |
| 빌드 시간 | 615 ms | 1,170 ms |

수정 후 값은 `find`·PowerShell·독립 스캔 세 가지와 교차 확인했다. 결과 정확도도 함께 바뀐다:

| `unity_find_missing_scripts` | 깨진 GUID | 영향 에셋 | 참조 |
|---|---|---|---|
| 수정 전 | 9 | 117 | 142 |
| **수정 후** | **13** | **133** | **163** |
| 독립 실측(대조군) | 12 | 128 | 158 |

새로 드러난 4건은 전부 `50.Art` 안이다(VFX 포탈 프리팹, MapGen 메시 에셋 등).
따라갈 수 없는 링크는 이제 `skipped` 로 세어 되돌려 준다 — 조용히 사라지지 않게.

### 알려진 한계

- **인덱스 증분 갱신 미구현.** 에셋이 바뀌면 `unity_index_rebuild` 를 직접 불러야 한다.
  캐시는 `fromCache: true` 로 표시되지만 무엇이 낡았는지는 알려주지 않는다
- **`totalReferenceCount` 는 (에셋, GUID) 쌍을 센다.** 원시 등장 횟수가 아니다. 실측 예:
  같은 GUID 가 원시 515회 등장하지만 108개 에셋에 걸쳐 있으면 108로 보고된다
- **`unity_find_callers` 는 프로젝트 어셈블리 내부 호출만** 인덱스한다. UnityEngine/BCL 로
  들어가는 호출은 제외되고, 오버로드는 `Type::Method` 한 키로 병합된다
- **`tools/list` 고정비가 여전히 `2ea969e` 보다 크다.** 다이어트로 −8.2% 를 되돌렸지만
  순증가는 남아 있다. 도구를 더 줄이려면 기능을 포기해야 한다
- **런처는 고정 경로에서 실행돼야 한다.** git URL 핀으로 소비하면 런처가 `PackageCache`
  안에 놓여 경로가 핀마다 바뀐다. `LOCAL_DEV_SETUP.md` 참조

### 실측 재현 방법

브릿지에 JSON-RPC 를 직접 넣으면 위 숫자를 다시 잴 수 있다. Unity 에디터가 켜져 있어야 한다.

```bash
cd <UnityProject>
node <package>/Bridge/mcp-bridge-launcher.js <<'EOF'
{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"probe","version":"1"}}}
{"jsonrpc":"2.0","method":"notifications/initialized"}
{"jsonrpc":"2.0","id":2,"method":"tools/list"}
{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"unity_index_status","arguments":{}}}
EOF
```

`id=2` 응답의 바이트 수가 세션 고정비다. `id=3` 은 인덱스 커버리지(`metaFiles`/`yamlFiles`)를
보여준다 — 프로젝트의 실제 파일 수와 어긋나면 정션이나 낡은 캐시를 의심한다.

## MCP란?
MCP는 AI 시스템이 외부 도구와 데이터에 접근할 수 있도록 앤스로픽(Anthropic)이 만든 개방형 표준입니다. 이 패키지를 사용하면 Unity를 MCP 서버로 변환하여 **Antigravity**, **Claude**, **Cursor**와 같은 AI 어시스턴트가 씬을 조회하고, 에셋을 수정하며, 에디터 명령을 실행할 수 있게 됩니다.

## 주요 기능
- 🎮 **씬 & 계층 제어**: GameObject 생성/수정, 부모 설정, 특정 컴포넌트를 가진 오브젝트 찾기.
- 🧩 **컴포넌트 관리**: 컴포넌트 추가/제거 및 직렬화된 속성(Property) 깊은 탐색.
- 🌲 **Behavior Tree 도구 (신규)**: Unity Behavior 그래프 관리 (노드 추가/삭제/연결, 속성 설정).
- 🪟 **창 관리 (신규)**: Animator 또는 Behavior 그래프와 같은 에디터 창 열기.
- 🎬 **씬 & 프리팹 관리**: 씬 열기/저장, 프리팹 생성 및 해제.
- 📦 **에셋 & 리소스 접근**: 프로젝트 에셋 탐색, 이동, 복제, 읽기.
- ▶️ **플레이 모드 & 입력**: 플레이 모드 상태 제어 및 키보드/마우스 입력 시뮬레이션.

---

## 설치 방법 (Git URL 방식)
1. Unity에서 `Window > Package Manager`를 엽니다.
2. 좌측 상단의 `+` 아이콘을 클릭하고 `Add package from git URL...`을 선택합니다.
3. 아래의 저장소 URL을 입력합니다 (또는 로컬 클론 경로 사용):
   ```text
   https://github.com/usmanbutt-dev/unity-mcp.git
   ```

## 빠른 시작
1. Unity 프로젝트를 로드하면 서버가 **자동으로 시작**됩니다.
2. `Window > MCP Server`로 이동하여 서버 상태를 확인합니다.
3. **"Copy Config to Clipboard"** 버튼을 클릭합니다.
4. 복사한 설정값을 사용 중인 MCP 클라이언트의 설정 파일(예: `mcp_config.json`)에 붙여넣습니다.

---

## 사용 가능한 도구 (도구 확장됨)

### 🧩 GameObject & 컴포넌트 도구
| 도구 이름 | 설명 |
|------|-------------|
| `unity_create_gameobject` | 새로운 GameObject 생성 (기본 도형 지원). |
| `unity_delete_gameobject` | 씬에서 GameObject 삭제. |
| `unity_set_transform` | 위치(Position), 회전(Rotation), 크기(Scale) 수정. |
| `unity_add_component` | GameObject에 컴포넌트 추가. |
| `unity_remove_component` | GameObject에서 컴포넌트 제거. |
| `unity_set_component_property` | 특정 컴포넌트 속성 값 설정. |
| `unity_get_component_properties` | **[신규]** 컴포넌트의 모든 직렬화된 속성(Property)과 값을 가져옵니다. |

### 🌲 계층(Hierarchy) 도구
| 도구 이름 | 설명 |
|------|-------------|
| `unity_get_hierarchy` | 현재 씬의 GameObject 계층 구조를 가져옵니다. |
| `unity_get_gameobject` | 특정 GameObject의 세부 정보를 가져옵니다. |
| `unity_get_components` | GameObject에 부착된 컴포넌트 목록을 가져옵니다. |
| `unity_find_objects_by_component`| **[신규]** 활성 씬에서 특정 컴포넌트를 가진 모든 GameObject를 찾습니다. |
| `unity_set_object_parent` | **[신규]** GameObject의 부모를 다른 GameObject로 변경(Reparent)합니다. |

### 🧠 Behavior Tree 도구 (신규)
| 도구 이름 | 설명 |
|------|-------------|
| `unity_get_bt_graph` | Behavior 그래프의 세부 정보(노드, 엣지, 블랙보드)를 가져옵니다. |
| `unity_add_bt_node` | Behavior 그래프에 새 노드를 추가합니다. |
| `unity_remove_bt_node` | Behavior 그래프에서 노드를 제거합니다. |
| `unity_connect_bt_nodes` | Behavior 그래프 안의 두 노드를 연결합니다. |
| `unity_set_bt_node_property`| Behavior 그래프 노드의 속성 값을 설정합니다. |

### 🪟 창(Window) 관리 도구 (신규)
| 도구 이름 | 설명 |
|------|-------------|
| `unity_open_animator_window`| Unity 에디터에서 Animator 창을 엽니다. |
| `unity_open_bt_window` | Unity Behavior (BT) 창을 엽니다. |

### 🏃 애니메이션 도구
| 도구 이름 | 설명 |
|------|-------------|
| `unity_set_animator_parameter`| bool/float/int/trigger 파라미터를 설정합니다. |
| `unity_get_animator_info` | Animator 상태, 파라미터, 레이어 정보를 가져옵니다. |
| `unity_play_animation` | 이름으로 애니메이션 상태를 재생합니다. |
| `unity_set_animator_culling_mode`| **[신규]** Animator의 컬링 모드(Culling Mode)를 설정합니다. |

*(플레이 모드, 씬 관리, 물리, 에셋, 머티리얼, 쉐이더와 관련된 기타 표준 도구들도 핵심 MCP 기능으로 완벽히 지원됩니다!)*

---

## AI 프롬프트 예시
서버가 연결되면 AI 어시스턴트에게 다음과 같이 요청해 보세요:
- *"활성 씬에서 `EnemyController` 컴포넌트를 가진 모든 게임 오브젝트를 찾아줘."*
- *"Behavior Tree 창을 열어줘."*
- *"`Weapon` 오브젝트의 부모를 `Player/RightHand`로 설정해줘."*
- *"플레이어의 `Rigidbody`에 있는 모든 컴포넌트 속성값들을 가져와줘."*
- *"위치 (0, 2, 0)에 빨간색 큐브를 생성해줘."*

## 요구 사항
- Unity 2021.3 이상
- Node.js (`mcp-bridge.js` 브릿지 실행에 필요)

## 라이선스
MIT License - 자세한 내용은 [LICENSE](LICENSE)를 참조하세요.
