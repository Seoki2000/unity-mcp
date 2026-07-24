# Unity MCP Server 🚀

[![Unity 2021.3+](https://img.shields.io/badge/Unity-2021.3%2B-blue.svg)](https://unity.com)
[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](LICENSE)
[![MCP](https://img.shields.io/badge/MCP-Compatible-purple.svg)](https://modelcontextprotocol.io)

*Read this in other languages: [English](README.md)*

AI 에이전트가 Unity 에디터를 **조회하고 제어**할 수 있게 해주는 Unity용 **MCP(Model Context Protocol)** 서버입니다. 이 버전은 로컬 최적화 버전으로, Behavior Tree(행동 트리), 창(Window) 관리, 고급 GameObject/계층(Hierarchy) 조작 기능이 추가로 확장되었습니다.

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
