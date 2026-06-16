# Unity MCP Server (최적화 포크)

> **포크 안내** — 이 저장소는 [usmanbutt-dev/unity-mcp](https://github.com/usmanbutt-dev/unity-mcp) (MIT)의 최적화 포크입니다.
> 원본 대비 변경점:
> - **토큰 절감**: 도구 응답 prettyPrint 제거(compact JSON), `resources/list` 50개·`unity_get_assets` 30개 상한, `unity_get_hierarchy` depth 2 + 루트 50개 + 전체 노드 300개 상한, guid/description/tag/layer 등 불필요 필드 제거 (조회당 약 60~90% 절감).
> - **스레딩 안정화**(`McpServer.cs`): 도메인 리로드(재컴파일) 직전 서버 정상 종료, 메인스레드 큐 락 밖 실행, 컴파일 중엔 즉시 busy 응답, 리스너 무한 스핀 방지.
> - **브릿지 견고화**(`mcp-bridge.js`): 모든 실패에 JSON-RPC 에러 응답 반환(클라 무한 대기 방지), 요청 타임아웃 + 연결거부 재시도.
>
> 라이선스(MIT)는 원본을 따릅니다 — `LICENSE` 참조.

[![Unity 2021.3+](https://img.shields.io/badge/Unity-2021.3%2B-blue.svg)](https://unity.com)
[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](LICENSE)
[![MCP](https://img.shields.io/badge/MCP-Compatible-purple.svg)](https://modelcontextprotocol.io)
[![Version](https://img.shields.io/badge/Version-2.2.3-orange.svg)](CHANGELOG.md)

AI 에이전트가 Unity 에디터를 **조회·제어**할 수 있게 해주는 **MCP(Model Context Protocol)** 서버입니다.

## MCP란?

MCP는 Anthropic이 만든 개방형 표준으로, AI가 외부 도구·데이터에 접근할 수 있게 합니다. 이 패키지는 Unity를 MCP 서버로 만들어 **Claude / Cursor / Antigravity** 같은 AI가 씬·에셋을 조회하고 에디터 명령을 실행하게 해줍니다.

## 기능

- 🎮 **씬 계층** — 게임오브젝트/컴포넌트/구조 조회
- ✏️ **쓰기 작업** — 게임오브젝트 생성/삭제/수정 (실시간)
- 🧩 **컴포넌트 제어** — 추가/제거/속성 설정
- 🎬 **씬 관리** — 열기/저장/생성/관리
- 🏷️ **프리팹 도구** — 인스턴스화/생성/검사
- 📦 **에셋 브라우저** — 프로젝트 에셋 목록/검색
- 📁 **리소스 접근** — 스크립트/프리팹/ScriptableObject 읽기
- 📋 **콘솔 접근** — 콘솔 로그 읽기/지우기
- ⚙️ **에디터 제어** — 메뉴 실행, 오브젝트 선택
- 🔧 **컴파일 상태** — 빌드 에러/경고 확인
- 📷 **스크린샷** — Game/Scene 뷰 캡처
- 🔍 **프로젝트 검색** — 이름/내용/참조로 검색
- ▶️ **플레이 모드 제어** — 진입/종료/일시정지
- 🎮 **입력 시뮬레이션** — 키보드/마우스/UI 조작
- 🔒 **보안** — localhost 전용, 외부 접근 없음

## 설치 → 사용 한 번에 🚀

> 요구 사항: Unity 2021.3+ / Node.js (브릿지 실행용, LTS 권장). 제공 도구 55개. 서버는 `localhost:3000` **단일 포트**를 점유하므로, 같은 포트를 쓰는 다른 프로세스나 다중 에디터가 없어야 합니다.

처음이라도 아래 6단계만 따라오면 Unity와 AI를 연결해 "씬 보여줘"를 바로 해볼 수 있습니다.

### 1단계 — C# 패키지 설치 (도구 + 자동 서버)

둘 중 하나를 고르세요.

**방법 A — Git URL (간편)**
`Window > Package Manager > + > Add package from git URL...`에 붙여넣기:
```
https://github.com/Seoki2000/unity-mcp.git
```
또는 `Packages/manifest.json`에 직접:
```json
"com.community.unity-mcp": "https://github.com/Seoki2000/unity-mcp.git"
```

**방법 B — 임베드 (경로가 안 변해서 안정적, 권장)**
프로젝트의 `Packages/` 아래로 직접 받습니다:
```bash
git clone https://github.com/Seoki2000/unity-mcp.git Packages/com.community.unity-mcp
```

설치가 끝나면 에디터에 55개의 Unity 제어 도구가 등록되고, **Unity가 로드될 때 MCP 서버가 자동으로 켜집니다** (기본 포트 `3000`, `localhost` 전용). 별도의 "서버 시작" 동작은 필요 없습니다.

> ⚠️ Git URL(방법 A)로 설치하면 패키지가 `Library/PackageCache/com.community.unity-mcp@<해시>/`에 캐싱되고, 이 `<해시>`는 갱신할 때마다 바뀝니다. **MCP 서버 창의 "Copy Config to Clipboard"가 복사하는 경로도 이 `@<해시>` 캐시 경로**이므로, 그대로 쓰면 패키지 갱신 시 연결이 끊깁니다. 다음 2~3단계처럼 **임베드 상대경로 또는 고정 경로**로 브릿지를 가리키세요.

### 2단계 — 브릿지가 무엇인지 (한 번만 두면 됨)

AI 클라이언트(Claude 등)는 Unity와 직접 말하지 않고, 중간의 작은 **브릿지** 파일(`Bridge/mcp-bridge.js`)을 거칩니다.

- **의존성 0개, 단일 Node 파일** — Node 내장 모듈(`http`, `readline`)만 사용합니다. `npm install` 과정이 없습니다.
- **하는 일은 프록시뿐** — stdin의 JSON-RPC를 `localhost:3000`(에디터 안의 서버)으로 전달하고, 응답(SSE 포함)을 돌려줍니다. 연결 거부 시 자동 재시도도 들어 있습니다.
- **프로젝트와 무관** — 어떤 Unity 프로젝트가 열려 있든 동일하게 동작하므로, **고정 위치에 한 번만 두면 모든 프로젝트가 공유**할 수 있습니다.

브릿지를 `@<해시>`가 붙지 않는 고정 위치(임베드 경로 또는 별도 폴더)에 두면, 패키지 캐시 경로가 갱신돼도 연결이 깨지지 않습니다.

공유용으로 한 번 복사해 두려면:
```bash
# 홈 디렉터리 아래 고정 경로로 복사 (한 번만)
mkdir -p ~/.unity-mcp
cp Packages/com.community.unity-mcp/Bridge/mcp-bridge.js ~/.unity-mcp/mcp-bridge.js
```

### 3단계 — 클라이언트가 브릿지를 가리키게 설정

프로젝트 루트에 `.mcp.json`을 만들고 붙여넣으세요. **임베드 설치**라면 상대경로를 그대로 쓰는 것이 가장 안정적입니다(`@<해시>` 없음, 프로젝트와 함께 이동):
```json
{
  "mcpServers": {
    "unity": {
      "command": "node",
      "args": ["Packages/com.community.unity-mcp/Bridge/mcp-bridge.js"]
    }
  }
}
```

공유 브릿지를 고정 경로에 복사해 뒀다면 그 경로(예: `~/.unity-mcp/mcp-bridge.js`)를 가리켜도 됩니다.

**Claude Code CLI 사용자**는 파일을 만드는 대신 한 줄로 전역(user 스코프) 등록할 수 있습니다:
```bash
claude mcp add --scope user unity -- node "~/.unity-mcp/mcp-bridge.js"
```

> 🔧 **포트를 바꿨다면 두 곳을 같은 값으로 맞추세요.** 에디터 서버 포트와 브릿지 포트는 서로 독립적이라, 한쪽만 바꾸면 연결이 끊깁니다. 브릿지 쪽은 `.mcp.json`에 `"env": { "UNITY_MCP_PORT": "3000" }`(기본 3000)을 추가합니다. 다른 호스트를 쓸 경우 `"UNITY_MCP_HOST": "localhost"`(기본값)도 같은 방식으로 지정할 수 있습니다.

### 4단계 — Unity 켜기 (서버 자동 시작 확인)

해당 Unity 프로젝트를 엽니다. 에디터가 로드될 때(`InitializeOnLoad` + 자동 시작) 서버가 `localhost:3000`에서 대기합니다.
- `Window > MCP Server`를 열어 상태가 실행 중인지 확인하세요.
- 별도 실행 명령은 없습니다 — 에디터를 열면 끝입니다.

> 브릿지는 프록시일 뿐이라, **도구가 실제로 동작하려면 대상 Unity 에디터가 켜져 있어야** 합니다.

### 5단계 — AI 클라이언트에서 연결하고 바로 사용

1. MCP 클라이언트(Claude / Cursor / Antigravity 등)에서 `.mcp.json`이 있는 **프로젝트 폴더를 엽니다** (전역 등록을 했다면 아무 폴더).
2. `unity` 서버 사용 승인 창이 뜨면 **최초 1회 승인**합니다.
3. 연결되면 끝입니다. 자연어로 바로 시켜보세요:
   - "씬 계층 보여줘"
   - "(0, 2, 0)에 빨간 큐브 만들어줘"
   - "Player에 Rigidbody 붙여줘"
   - "지금 컴파일 에러 있어?"

### 6단계 — 주의할 점

- **포트는 한 번에 Unity 하나.** 서버가 `localhost:3000`을 점유하므로, 한 시점에 이 포트로 연결되는 에디터는 하나만 가능합니다. 여러 프로젝트를 동시에 열면 먼저 켜진 에디터가 포트를 잡고 나머지는 서버 시작에 실패합니다. 작업을 옮길 때는 이전 에디터를 닫거나, 에디터마다 다른 포트를 쓰고 그에 맞춰 브릿지 포트(`UNITY_MCP_PORT`)도 함께 바꾸세요.
- 🔒 **보안.** 서버는 `localhost`에만 바인딩되어 외부 네트워크에 노출되지 않지만, 응답 헤더가 CORS 와일드카드(`Access-Control-Allow-Origin: *`)이고 인증 토큰이 없습니다. 따라서 같은 PC의 브라우저 등 로컬 오리진에서 `localhost:3000`으로 요청이 닿을 수 있는 표면이 존재합니다. 신뢰할 수 없는 페이지를 띄운 상태에서 작업하지 마세요.

## 제공 도구 (총 55개)

### 게임오브젝트
| 도구 | 설명 |
|------|------|
| `unity_create_gameobject` | 게임오브젝트 생성 (기본 도형 지원) |
| `unity_delete_gameobject` | 씬에서 게임오브젝트 삭제 |
| `unity_set_transform` | 위치/회전/스케일 설정 |
| `unity_add_component` | 컴포넌트 추가 |
| `unity_remove_component` | 컴포넌트 제거 |
| `unity_set_component_property` | 컴포넌트 속성 값 설정 |

### 계층(Hierarchy)
| 도구 | 설명 |
|------|------|
| `unity_get_hierarchy` | 씬 게임오브젝트 계층 조회 |
| `unity_get_gameobject` | 특정 게임오브젝트 상세 조회 |
| `unity_get_components` | 게임오브젝트의 컴포넌트 목록 |

### 프리팹
| 도구 | 설명 |
|------|------|
| `unity_instantiate_prefab` | 씬에 프리팹 인스턴스화 |
| `unity_get_prefab_info` | 프리팹 구조 조회 |
| `unity_create_prefab` | 게임오브젝트로 프리팹 생성 |
| `unity_unpack_prefab` | 프리팹 인스턴스 언팩 |

### 씬
| 도구 | 설명 |
|------|------|
| `unity_get_scenes` | 프로젝트 씬 목록 |
| `unity_open_scene` | 씬 열기 |
| `unity_save_scene` | 현재 씬 저장 |
| `unity_new_scene` | 새 씬 생성 |
| `unity_close_scene` | 씬 닫기 |
| `unity_set_active_scene` | 활성 씬 설정 |

### 에셋 & 에디터
| 도구 | 설명 |
|------|------|
| `unity_get_assets` | 폴더 내 에셋 목록 |
| `unity_get_project_settings` | 프로젝트 설정 조회 |
| `unity_get_console_logs` | 최근 콘솔 로그 |
| `unity_clear_console` | 콘솔 지우기 |
| `unity_execute_menu` | 메뉴 항목 실행 |
| `unity_select_object` | 게임오브젝트 선택 |
| `unity_get_selection` | 현재 선택 조회 |
| `unity_get_editor_state` | 에디터 재생/일시정지 상태 |

### 컴파일
| 도구 | 설명 |
|------|------|
| `unity_get_compilation_status` | 컴파일 에러/경고 조회 |
| `unity_recompile_scripts` | 강제 재컴파일 |
| `unity_get_assemblies` | 프로젝트 어셈블리 목록 |

### 스크린샷 & 검색
| 도구 | 설명 |
|------|------|
| `unity_take_screenshot` | Game/Scene 뷰를 base64 PNG로 캡처 |
| `unity_search_project` | 이름/내용/참조로 검색 |

### 플레이 모드 & 입력
| 도구 | 설명 |
|------|------|
| `unity_enter_play_mode` | 플레이 모드 진입 |
| `unity_exit_play_mode` | 플레이 모드 종료 |
| `unity_pause_play_mode` | 플레이 모드 일시정지/해제 |
| `unity_simulate_key` | 키보드 입력 시뮬레이션 |
| `unity_simulate_mouse` | 마우스 클릭 시뮬레이션 |
| `unity_click_ui_element` | 이름으로 UI 버튼/토글 클릭 |

### 애니메이션
| 도구 | 설명 |
|------|------|
| `unity_set_animator_parameter` | bool/float/int/trigger 파라미터 설정 |
| `unity_get_animator_info` | 애니메이터 상태/파라미터/레이어 조회 |
| `unity_play_animation` | 이름으로 애니메이션 상태 재생 |

### 머티리얼 & 셰이더
| 도구 | 설명 |
|------|------|
| `unity_get_material_info` | 머티리얼 속성/셰이더 조회 |
| `unity_set_material_property` | color/float/int/vector 속성 설정 |
| `unity_set_material` | 렌더러에 머티리얼 할당 |

### 물리
| 도구 | 설명 |
|------|------|
| `unity_raycast` | 레이캐스트 + 히트 정보 |
| `unity_overlap_sphere` | 반경 내 콜라이더 탐색 |
| `unity_add_force` | Rigidbody에 힘 적용 |

### 에셋 생성
| 도구 | 설명 |
|------|------|
| `unity_create_folder` | 프로젝트 폴더 생성 |
| `unity_create_material` | 머티리얼 에셋 생성 |
| `unity_create_script` | 템플릿 기반 C# 스크립트 생성 |
| `unity_move_asset` | 에셋 이동/이름 변경 |
| `unity_duplicate_asset` | 에셋 복제 |

### AI 컨텍스트
| 도구 | 설명 |
|------|------|
| `unity_get_scene_summary` | AI용 압축 씬 개요 |
| `unity_get_component_schema` | 컴포넌트 속성 스키마 |
| `unity_get_type_info` | Unity 컴포넌트 타입 탐색 |

## MCP 리소스

MCP 리소스 프로토콜로도 접근 가능합니다:
- **Scripts** — C# 소스 읽기
- **Scenes** — 씬 메타데이터
- **Prefabs** — 프리팹 구조
- **ScriptableObjects** — SO 데이터를 JSON으로

## 라이선스

MIT License — [LICENSE](LICENSE) 참조. 원본: [usmanbutt-dev/unity-mcp](https://github.com/usmanbutt-dev/unity-mcp)
