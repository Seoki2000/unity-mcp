# Unity MCP Server 🚀

[![Unity 2021.3+](https://img.shields.io/badge/Unity-2021.3%2B-blue.svg)](https://unity.com)
[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](LICENSE)
[![MCP](https://img.shields.io/badge/MCP-Compatible-purple.svg)](https://modelcontextprotocol.io)

A **Model Context Protocol (MCP)** server for Unity that enables AI agents to **query and control** the Unity Editor. This local-optimized version is enhanced with additional tools for Behavior Trees, Window Management, and advanced GameObject/Hierarchy manipulation.

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
