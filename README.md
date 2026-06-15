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
[![Version](https://img.shields.io/badge/Version-2.2.1-orange.svg)](CHANGELOG.md)

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

## 설치 (Unity Package Manager)

### Git URL로 추가 (권장)
1. `Window > Package Manager` 열기
2. `+` > `Add package from git URL...` 클릭
3. 아래 입력:
   ```
   https://github.com/Seoki2000/unity-mcp.git
   ```

또는 `Packages/manifest.json`의 `dependencies`에 직접 추가:
```json
"com.community.unity-mcp": "https://github.com/Seoki2000/unity-mcp.git"
```

## 빠른 시작

1. Unity가 로드되면 서버가 **자동 시작**됩니다
2. `Window > MCP Server`로 상태 확인
3. **"Copy Config to Clipboard"** 클릭
4. 사용하는 MCP 클라이언트 설정 파일에 붙여넣기

## 제공 도구 (총 52개)

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

## MCP 클라이언트 설정

클라이언트 설정(예: `mcp_config.json` 또는 `.mcp.json`)에 추가:
```json
{
  "mcpServers": {
    "unity": {
      "command": "node",
      "args": ["여기에/Packages/com.community.unity-mcp/Bridge/mcp-bridge.js"]
    }
  }
}
```

> **팁**: `Window > MCP Server`의 "Copy Config to Clipboard" 버튼을 쓰면 올바른 경로가 자동으로 들어갑니다.
> **주의**: 패키지를 업데이트하거나 이동하면 위 경로가 바뀔 수 있으니, MCP 연결이 끊기면 이 경로부터 확인하세요.

## 예시 명령

연결 후 AI에게:
- "(0, 2, 0)에 빨간 큐브 만들어줘"
- "Player 오브젝트에 Rigidbody 붙여줘"
- "지금 씬에 어떤 게임오브젝트들 있어?"
- "Player의 컴포넌트 보여줘"
- "MainMenu 씬 열어줘"
- "지금 컴파일 에러 있어?"

## 요구 사항

- Unity 2021.3 이상
- Node.js (MCP 브릿지 실행용)

## 라이선스

MIT License — [LICENSE](LICENSE) 참조. 원본: [usmanbutt-dev/unity-mcp](https://github.com/usmanbutt-dev/unity-mcp)
