# Changelog

All notable changes to this project will be documented in this file.

## [2.2.2] - 2026-06-16

### Changed
- **문서(README)**: 안정적 MCP 연결 설정 안내 추가. Git URL 설치 시 `Library/PackageCache/...@<해시>` 경로가 갱신마다 바뀌어 연결이 끊기는 함정을 경고하고, 권장 설정을 재정리(임베드 + 프로젝트 `.mcp.json`, 또는 공유 브릿지 + 전역 등록). 설치에 임베드(방법 2) 추가, 도구 수 52 → 55 정정.

---

## [2.2.1] - 2026-06-13

### Changed
- **토큰 절감**: 도구 응답 compact JSON, `resources/list` 50개·`unity_get_assets` 30개 상한, `unity_get_hierarchy` depth 2 + 루트 50개 + 전체 노드 300개 상한, guid/description/tag/layer 등 불필요 필드 제거 (조회당 약 60~90% 절감).
- **스레딩 안정화**(`McpServer.cs`): 도메인 리로드(재컴파일) 직전 서버 정상 종료, 메인스레드 큐 락 밖 실행, 컴파일 중 즉시 busy 응답, 리스너 무한 스핀 방지.
- **브릿지 견고화**(`mcp-bridge.js`): 모든 실패에 JSON-RPC 에러 응답 반환(클라 무한 대기 방지), 요청 타임아웃 + 연결거부 재시도.

---

## [2.2.0] - 2024-12-12

### Added
- **Animation Tools**
  - `unity_set_animator_parameter` - Set bool/float/int/trigger parameters
  - `unity_get_animator_info` - Get animator state, parameters, layers
  - `unity_play_animation` - Play animation state by name

- **Material & Shader Tools**
  - `unity_get_material_info` - Get material properties and shader
  - `unity_set_material_property` - Set color/float/int/vector properties
  - `unity_set_material` - Assign material to renderer

- **Physics Tools**
  - `unity_raycast` - Cast ray and get hit info
  - `unity_overlap_sphere` - Find colliders in radius
  - `unity_add_force` - Apply force to Rigidbody (play mode)

- **Asset Creation Tools**
  - `unity_create_folder` - Create project folders
  - `unity_create_material` - Create material assets
  - `unity_create_script` - Create C# scripts with templates
  - `unity_move_asset` - Move/rename assets
  - `unity_duplicate_asset` - Duplicate assets

- **AI Context Tools**
  - `unity_get_scene_summary` - Compact scene overview
  - `unity_get_component_schema` - Get component properties schema
  - `unity_get_type_info` - Discover Unity component types

---

## [2.1.0] - 2024-12-12

### Added
- **Dynamic Schema Generation**: Tools now include full JSON Schema in `tools/list` response
  - LLMs can now see parameter names, types, descriptions, and valid enum values
  - Uses `[McpParam]` attribute for field documentation
  
- **Screenshot Tools** (Phase 2A)
  - `unity_take_screenshot` - Capture Game View or Scene View as base64 PNG

- **Search Tools** (Phase 2B)
  - `unity_search_project` - Search by name, content (grep), or asset references

- **Play Mode Controls** (Phase 3A)
  - `unity_enter_play_mode` - Enter play mode
  - `unity_exit_play_mode` - Exit play mode
  - `unity_pause_play_mode` - Pause/unpause with toggle support

- **Input Simulation** (Phase 3B)
  - `unity_simulate_key` - Simulate keyboard input
  - `unity_simulate_mouse` - Simulate mouse clicks
  - `unity_click_ui_element` - Click UI Buttons/Toggles by name

### Changed
- All tool definitions now include complete input schemas
- Added `[McpParam]` attribute for parameter documentation

---

## [2.0.0] - 2024-12-11

### Added
- **6 GameObject Write Tools**
  - `unity_create_gameobject` - Create new GameObjects with optional primitive types
  - `unity_delete_gameobject` - Delete GameObjects with undo support
  - `unity_set_transform` - Set position, rotation, scale (world or local)
  - `unity_add_component` - Add components to GameObjects
  - `unity_remove_component` - Remove components
  - `unity_set_component_property` - Set serialized properties on components

- **4 Prefab Tools**
  - `unity_instantiate_prefab` - Spawn prefabs in scene
  - `unity_get_prefab_info` - Get prefab structure
  - `unity_create_prefab` - Create prefab from scene GameObject
  - `unity_unpack_prefab` - Unpack prefab instances

- **6 Scene Tools**
  - `unity_get_scenes` - List all scenes in project
  - `unity_open_scene` - Open scenes (single or additive)
  - `unity_save_scene` - Save current or specific scene
  - `unity_new_scene` - Create new empty scene
  - `unity_close_scene` - Close scenes (multi-scene editing)
  - `unity_set_active_scene` - Set active scene

- **3 Compilation Tools**
  - `unity_get_compilation_status` - Get compile errors and warnings
  - `unity_recompile_scripts` - Force script recompilation
  - `unity_get_assemblies` - List project assemblies

- **MCP Resource Support**
  - `resources/list` - List scripts, scenes, prefabs, ScriptableObjects
  - `resources/read` - Read resource content by URI

- **Server Enhancements**
  - Auto-start on Unity load
  - SSE (Server-Sent Events) support
  - Bundled Node.js bridge (`Bridge/mcp-bridge.js`)
  - Improved editor window with config copy button

### Fixed
- JSON parsing for nested params (manual parsing for tools/call)
- Scale defaulting to (0,0,0) when not specified

### Changed
- Protocol version updated to `2024-11-05`
- Server version now `2.0.0`

---

## [1.0.0] - 2024-12-11

### Added
- Initial release
- HTTP server with JSON-RPC 2.0 protocol
- MCP capability negotiation
- Editor window for server control
- 11 MCP tools:
  - `unity_get_hierarchy` - Scene hierarchy
  - `unity_get_gameobject` - GameObject details
  - `unity_get_components` - Component listing
  - `unity_get_assets` - Asset browsing
  - `unity_get_project_settings` - Project config
  - `unity_get_console_logs` - Console access
  - `unity_clear_console` - Clear console
  - `unity_execute_menu` - Menu execution
  - `unity_select_object` - Object selection
  - `unity_get_selection` - Selection query
  - `unity_get_editor_state` - Editor state
