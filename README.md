# Unity MCP Server 🚀

[![Unity 2021.3+](https://img.shields.io/badge/Unity-2021.3%2B-blue.svg)](https://unity.com)
[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](LICENSE)
[![MCP](https://img.shields.io/badge/MCP-Compatible-purple.svg)](https://modelcontextprotocol.io)

*Read this in other languages: [한국어](README_ko.md)*
A **Model Context Protocol (MCP)** server for Unity that enables AI agents to **query and control** the Unity Editor. This local-optimized version is enhanced with additional tools for Behavior Trees, Window Management, and advanced GameObject/Hierarchy manipulation.

## Fork dev build — dev-0.0.1

This fork (`Seoki2000/unity-mcp`, branch `optimized`) diverges from upstream. Numbers below
are measured against a live Unity editor, not estimated. Full record in Korean:
[README_ko.md](README_ko.md#포크-개발-버전--dev-001).

Package version: `2.3.0-dev.0.0.1` · baseline commit: `5331a34`

**Added since the previously pinned `2ea969e`:** path-escape guard and session-token auth;
tool annotations, pagination and response caps; an out-of-process project index (reverse
reference lookup, assembly symbols with PDB source mapping, IL call graph — 8 bridge-side
tools); 6 Behavior authoring tools reclaimed from the game repo; a bridge launcher that
resolves `PackageCache` at run time. Tools: **67 → 81**, none removed.

**`tools/list` fixed cost went up, not down.**

| State | Bytes | Tools | Per tool |
|---|---|---|---|
| `2ea969e` | 24,968 | 67 | 372.7 |
| dev-0.0.1 before diet | 40,376 | 81 | 498.5 |
| **dev-0.0.1 now** | **37,067** | **81** | **457.6** |

That is **+48.5%** over the old pin — roughly +3,000 tokens per session. dev-0.0.1 claws
back 3,309 B of it losslessly by omitting annotation hints that equal the MCP spec defaults.
Note `destructiveHint` defaults to **true**, so omitting a `false` would flip a safe tool
into a destructive one; only `false` is emitted and `true` is dropped, and the bridge's own
retry logic was fixed to apply spec defaults (verified equivalent across all 8 combinations).

Cutting tools is a weak lever: the average tool costs 497 B, about 1.2% of the payload.
`inputSchema` is 56.7% of it and parameter descriptions are 26.6% — but those are what make
the tools usable, so they were left alone.

**Index coverage bug fixed in dev-0.0.1.** Windows junctions report `isDirectory() == false`
and `isSymbolicLink() == true` from `readdirSync`, so the scanner's two branches both missed
them and skipped entire trees. Unity follows junctions, so those assets are part of the
project. In this project `Assets/50.Art` is a junction holding 35% of the project's `.meta`
files. After the fix: `.meta` 2,037 → 3,142, YAML 783 → 1,131, reference edges 4,355 → 5,586,
and `unity_find_missing_scripts` went from 9 broken GUIDs to 13 (cross-checked against an
independent scan). Unfollowable links are now counted in `skipped` instead of vanishing.

**Known limits:** no incremental index refresh (call `unity_index_rebuild` after asset
changes); `totalReferenceCount` counts (asset, GUID) pairs, not raw occurrences;
`unity_find_callers` indexes project-internal calls only and merges overloads under
`Type::Method`; `tools/list` is still larger than in `2ea969e`.

## What is MCP?
MCP is an open standard by Anthropic that allows AI systems to access external tools and data. This package turns Unity into an MCP server, letting AI assistants like **Antigravity**, **Claude**, and **Cursor** seamlessly query your scenes, modify assets, and execute editor commands.

## Key Features
- 🎮 **Scene & Hierarchy Control**: Create, modify, set parents, and find objects by component.
- 🧩 **Component Management**: Add, remove, and deeply inspect serialized component properties.
- 🌲 **Behavior Tree Tools (New)**: Manage Unity Behavior graphs (add/remove nodes, connect, set properties).
- 🪟 **Window Management (New)**: Directly open Editor windows like Animator or Behavior graph.
- 🎬 **Scene & Prefab Management**: Open, save scenes, instantiate and unpack prefabs.
- 📦 **Asset & Resource Access**: Browse, move, duplicate, and read project assets.
- ▶️ **Play Mode & Input**: Control play mode state and simulate inputs.

---

## Installation (Via Git URL)
1. Open `Window > Package Manager` in Unity.
2. Click the `+` icon in the top left and select `Add package from git URL...`.
3. Enter the repository URL (or local path if you are using a local clone):
   ```text
   https://github.com/usmanbutt-dev/unity-mcp.git
   ```

## Quick Start
1. The server **auto-starts** when the Unity project is loaded.
2. Navigate to `Window > MCP Server` to view the server status.
3. Click **"Copy Config to Clipboard"**.
4. Paste the configuration into your MCP client's configuration file (e.g., `mcp_config.json`).

---

## Available Tools (Expanded)

### 🧩 GameObject & Component Tools
| Tool | Description |
|------|-------------|
| `unity_create_gameobject` | Create new GameObjects (primitives supported). |
| `unity_delete_gameobject` | Delete GameObjects from the scene. |
| `unity_set_transform` | Modify position, rotation, and scale. |
| `unity_add_component` | Add a component to a GameObject. |
| `unity_remove_component` | Remove a component from a GameObject. |
| `unity_set_component_property` | Set a specific component property value. |
| `unity_get_component_properties` | **[NEW]** Get all serialized properties and values of a component. |

### 🌲 Hierarchy Tools
| Tool | Description |
|------|-------------|
| `unity_get_hierarchy` | Retrieve the scene's GameObject hierarchy. |
| `unity_get_gameobject` | Get details of a specific GameObject. |
| `unity_get_components` | List components attached to a GameObject. |
| `unity_find_objects_by_component`| **[NEW]** Find all GameObjects in the active scene that have a specific component. |
| `unity_set_object_parent` | **[NEW]** Reparent a GameObject to another GameObject. |

### 🧠 Behavior Tree Tools (NEW)
| Tool | Description |
|------|-------------|
| `unity_get_bt_graph` | Get details of a Behavior Graph (nodes, edges, blackboard). |
| `unity_add_bt_node` | Add a new node to a Behavior Graph. |
| `unity_remove_bt_node` | Remove a node from a Behavior Graph. |
| `unity_connect_bt_nodes` | Connect two nodes in a Behavior Graph. |
| `unity_set_bt_node_property`| Set a property value on a Behavior Graph node. |

### 🪟 Window Management (NEW)
| Tool | Description |
|------|-------------|
| `unity_open_animator_window`| Open the Animator window in the Unity Editor. |
| `unity_open_bt_window` | Open the Unity Behavior (BT) window. |

### 🏃 Animation Tools
| Tool | Description |
|------|-------------|
| `unity_set_animator_parameter`| Set bool/float/int/trigger parameters. |
| `unity_get_animator_info` | Get animator state, parameters, and layers. |
| `unity_play_animation` | Play animation state by name. |
| `unity_set_animator_culling_mode`| **[NEW]** Set the culling mode of an Animator. |

*(Other standard tools for Play Mode, Scene Management, Physics, Assets, Materials, and Shaders are fully supported as part of the core MCP feature set!)*

---

## Example Prompts for AI
Once connected, try asking your AI assistant:
- *"Find all GameObjects with the `EnemyController` component."*
- *"Open the Behavior Tree window."*
- *"Set the parent of `Weapon` to `Player/RightHand`."*
- *"Get all component properties for the `Rigidbody` on the Player."*
- *"Create a red cube at position (0, 2, 0)."*

## Requirements
- Unity 2021.3 or later
- Node.js (Required for the MCP bridge `mcp-bridge.js`)

## License
MIT License - see [LICENSE](LICENSE)
