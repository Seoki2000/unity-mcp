# Unity MCP Server 🚀

[![Unity 2021.3+](https://img.shields.io/badge/Unity-2021.3%2B-blue.svg)](https://unity.com)
[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](LICENSE)
[![MCP](https://img.shields.io/badge/MCP-Compatible-purple.svg)](https://modelcontextprotocol.io)

*Read this in other languages: [한국어](README_ko.md)*
A **Model Context Protocol (MCP)** server for Unity that enables AI agents to **query and control** the Unity Editor. This local-optimized version is enhanced with additional tools for Behavior Trees, Window Management, and advanced GameObject/Hierarchy manipulation.

## Fork dev build — dev-0.0.3

This fork (`Seoki2000/unity-mcp`, branch `optimized`) diverges from upstream. Numbers below
are measured against a live Unity editor, not estimated. Full record in Korean:
[README_ko.md](README_ko.md#포크-개발-버전--dev-001).

Package version: `2.3.0-dev.0.0.3` · baseline commit: `5331a34`

**Added since the previously pinned `2ea969e`:** path-escape guard and session-token auth;
tool annotations, pagination and response caps; an out-of-process project index (reverse
reference lookup, assembly symbols with PDB source mapping, IL call graph, serialized
component values — 9 bridge-side tools); 6 Behavior authoring tools reclaimed from the game
repo; a bridge launcher that resolves `PackageCache` at run time. Tools: **67 → 82**, none removed.

**`tools/list` fixed cost went up, not down.**

| State | Bytes | Tools | Per tool |
|---|---|---|---|
| `2ea969e` | 24,968 | 67 | 372.7 |
| dev-0.0.1 before diet | 40,376 | 81 | 498.5 |
| dev-0.0.1 now | 37,067 | 81 | 457.6 |
| **dev-0.0.2** | **39,669** | **82** | **483.8** |

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

**dev-0.0.2 — reading serialized values.** `unity_get_asset_components` reads a prefab,
scene or asset and returns each component with its field values, resolving every
`m_Script` GUID to the type that actually compiles today and every object reference to an
asset path. Reading `.cs` cannot answer this (the values live in the asset) and reading the
YAML cannot either (the asset stores a GUID, not a type name). Serialized keys are checked
against the compiled type, so keys left behind by renamed fields are visible. Measured over
all 1,144 text assets (181 MB, 69,891 documents): 0 unparsed lines, and every GUID the
independent regex scanner finds also appears in the parsed value tree.

**Accuracy fixes in dev-0.0.2.** Assets reported *zero* references in three different ways.
VFX Graph writes object references as JSON inside a YAML string (`"guid":"…"`) and
TMP/Addressables write bare GUIDs — 3 assets, including the `.ttf` behind a TMP font asset.
`.shadergraph` and `.asmdef` were outside the extension whitelist entirely — 19 more assets,
found by an adversarial audit. And `.meta` importer settings reference materials
(`externalObjects`) but were never read as a reference source — 18 more. The extension
whitelist is gone: the scan now picks files by *content* (no NUL in the first 512 bytes),
which costs 357 ms of sniffing and reads 8.7 MB of text while skipping 945 MB of binaries.
Edges 6,021 → 6,244. Self-references (an asset writing its own GUID) no longer count, and
edges found by matching text in source or docs are reported separately as `textualMatches`.

Scripts whose class body is empty (`partial class X : Y { }`) have no method bodies, so the
PDB maps no source file to them and their type went unresolved with a wrong reason; there is
now a guarded filename fallback — the first, unguarded version immediately resolved URP's
`Volume.cs` to a project class of the same short name. The index cache lost its fingerprint
after merging `PackageCache`, silently forcing a full rebuild every session. `tools/list`
served from the disk cache omitted newly added bridge tools — exactly when Unity is down and
they matter most. And the new value tool read any file the caller named: `../../..` escaped
the project root, re-introducing on the JS side what Phase 0-A had guarded in C#.

**dev-0.0.3 — the axis where data calls code.** The index saw code→code (IL call graph) and
data→data (GUID references), but in Unity a large share of calls live *inside assets as data*,
and that axis was missing entirely — so live code was reported dead. Measured:
`GameManager.GoToResultButton` had **zero callers** yet is wired to buttons in two scenes via
UnityEvent, and `BombAction` was reported unused by all three tools while being a node in the
boss behaviour tree (stored as `"BombAction, Assembly-CSharp, Version=…"`). Both read as
"safe to delete". Four axes now close that gap: UnityEvent persistent calls (24 wirings, 22
resolved to a compiled type through the join), type-name string references (48 user types /
52 edges), method attributes from the CustomAttribute table (243 methods — `[MenuItem]` 70,
`[Test]` 59, `[ClientRpc]` 39, so a zero caller count no longer implies dead), and path-based
asset loads (23 edges; literal-only extraction found just 1, because 70 of 71 call sites store
the path in a `const string` — folding those constants is what made it work). **No new tools
were added**: existing responses simply got correct, so the `tools/list` fixed cost is
unchanged at 39,669 B. Inspector wirings are reported *separately* from code callers rather
than summed — they are different things and need different fixes.

**Cross-checked against the live editor (2026-08-25).** Those claims were made without ever
opening Unity, so they were re-measured against `AssetDatabase.GetDependencies`: all five
predictions held — Unity knows the `.fbx` → `.mat` (`.meta externalObjects`) and
`.shadergraph` → `.png` edges, and does *not* know the type-name or const-path edges. The live
`tools/list` merge path returns byte-for-byte what the disk-cache path does (82 tools /
39,669 B). Preparing the control group exposed one defect of its own: the type-name axis had
been wired into `find_component_usages` and `get_type_symbols` but **not** into
`find_references`, so `unity_find_references(BombAction.cs)` still answered `totalCount: 0` —
38 scripts were affected, and Unity's own dependency database answers 0 for them too (24,233
asset paths scanned), which made it an error two independent sources agreed on. Adding an axis
to the index is only accurate once *every* tool that can answer zero knows about it.

**Known limits:** references assembled at run time (`Resources.Load(dir + name)`, Addressables
addresses) stay invisible — 44 such call sites here, and a zero result reports that count; no
incremental index refresh (call `unity_index_rebuild` after asset changes);
`totalReferenceCount` counts (asset, GUID) pairs, not raw occurrences; `unity_find_callers`
indexes project-internal calls only and merges overloads under `Type::Method`; component
values are re-parsed per query (4 ms for a typical prefab, 0.7 s for the largest 17 MB one);
package scripts have no symbols, so 5,554 of 7,019 script components resolve to `null` rather
than a type name; `tools/list` is still larger than in `2ea969e`.

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
   https://github.com/Seoki2000/unity-mcp.git#optimized
   ```

   This is a fork of [usmanbutt-dev/unity-mcp](https://github.com/usmanbutt-dev/unity-mcp).
   `optimized` is this fork's line — see [Fork dev build](#fork-dev-build--dev-001) for what differs.
   Projects consuming this package should pin a commit SHA rather than the branch name.

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
