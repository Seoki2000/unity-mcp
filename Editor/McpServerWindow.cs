using System.IO;
using UnityEditor;
using UnityEngine;

namespace Community.Unity.MCP
{
    /// <summary>
    /// Editor window for controlling the MCP server.
    /// </summary>
    public class McpServerWindow : EditorWindow
    {
        private int _port = 3000;
        private Vector2 _scrollPosition;
        private string _bridgePath;
        private bool _showAllTools;

        [MenuItem("Window/MCP Server")]
        public static void ShowWindow()
        {
            var window = GetWindow<McpServerWindow>("MCP Server");
            window.minSize = new Vector2(350, 400);
        }

        private void OnEnable()
        {
            _port = EditorPrefs.GetInt("MCP_Port", 3000);
            McpServer.OnServerStateChanged += OnServerStateChanged;
            
            // Find bridge path
            var guids = AssetDatabase.FindAssets("mcp-bridge t:TextAsset");
            if (guids.Length > 0)
            {
                var assetPath = AssetDatabase.GUIDToAssetPath(guids[0]);
                _bridgePath = Path.GetFullPath(assetPath);
            }
            else
            {
                // Fallback: look in package folder
                var packagePath = "Packages/com.community.unity-mcp/Bridge/mcp-bridge.js";
                if (File.Exists(packagePath))
                {
                    _bridgePath = Path.GetFullPath(packagePath);
                }
            }
        }

        private void OnDisable()
        {
            McpServer.OnServerStateChanged -= OnServerStateChanged;
        }

        private void OnServerStateChanged(bool isRunning)
        {
            Repaint();
        }

        private void OnGUI()
        {
            _scrollPosition = EditorGUILayout.BeginScrollView(_scrollPosition);

            EditorGUILayout.Space(10);

            // Header
            EditorGUILayout.LabelField("Unity MCP Server", EditorStyles.boldLabel);
            EditorGUILayout.HelpBox(
                "Model Context Protocol server for AI agent integration. " +
                "Connect AI tools like Antigravity, Claude, or Cursor to control Unity.",
                MessageType.Info);

            EditorGUILayout.Space(10);

            // Server Status
            DrawServerStatus();

            EditorGUILayout.Space(10);

            // Port Configuration
            DrawConfiguration();

            EditorGUILayout.Space(10);

            // Control Buttons
            DrawControlButtons();

            EditorGUILayout.Space(10);

            // Connection Info
            DrawConnectionInfo();

            EditorGUILayout.Space(10);

            // Available Tools
            DrawToolsList();

            EditorGUILayout.EndScrollView();
        }

        private void DrawServerStatus()
        {
            EditorGUILayout.LabelField("Status", EditorStyles.boldLabel);
            
            var isRunning = McpServer.Instance.IsRunning;
            var statusColor = isRunning ? Color.green : Color.gray;
            var statusText = isRunning ? "● Running" : "○ Stopped";

            using (new EditorGUILayout.HorizontalScope())
            {
                var originalColor = GUI.color;
                GUI.color = statusColor;
                EditorGUILayout.LabelField(statusText, EditorStyles.boldLabel, GUILayout.Width(100));
                GUI.color = originalColor;

                if (isRunning)
                {
                    EditorGUILayout.LabelField($"http://localhost:{McpServer.Instance.Port}/");
                }
            }
        }

        private void DrawConfiguration()
        {
            EditorGUILayout.LabelField("Configuration", EditorStyles.boldLabel);
            
            var isRunning = McpServer.Instance.IsRunning;
            
            using (new EditorGUI.DisabledGroupScope(isRunning))
            {
                var newPort = EditorGUILayout.IntField("Port", _port);
                if (newPort != _port && newPort > 0 && newPort < 65536)
                {
                    _port = newPort;
                    EditorPrefs.SetInt("MCP_Port", _port);
                }
            }

            EditorGUILayout.Space(6);
            EditorGUILayout.LabelField("Security", EditorStyles.boldLabel);

            // 세션 토큰 상태 — 브릿지만 서버를 호출할 수 있는지 한눈에 보여준다.
            if (isRunning)
            {
                if (McpAuthToken.IsEnforced)
                {
                    EditorGUILayout.HelpBox(
                        "Session token active. Only the local bridge (which reads " +
                        "~/.unity-mcp/auth-token-" + McpServer.Instance.Port + ".json) can call this server. " +
                        "Browser-origin requests are rejected.",
                        MessageType.Info);
                }
                else
                {
                    EditorGUILayout.HelpBox(
                        "Session token could NOT be written, so requests are not authenticated. " +
                        "Browser-origin requests are still rejected, but any local process can call this server. " +
                        "Check write access to your user profile's .unity-mcp folder.",
                        MessageType.Warning);
                }
            }

            bool menuEnabled = EditorPrefs.GetBool(EditorTools.ExecuteMenuEnabledPref, true);
            bool newMenuEnabled = EditorGUILayout.ToggleLeft(
                "Allow unity_execute_menu (arbitrary Editor menu execution)", menuEnabled);
            if (newMenuEnabled != menuEnabled)
            {
                EditorPrefs.SetBool(EditorTools.ExecuteMenuEnabledPref, newMenuEnabled);
            }

            EditorGUILayout.LabelField(
                newMenuEnabled
                    ? "Destructive menu paths (Delete, Build, Quit, Clear Cache, ...) are always blocked."
                    : "unity_execute_menu will return an error for every call.",
                EditorStyles.miniLabel);
        }

        private void DrawControlButtons()
        {
            var isRunning = McpServer.Instance.IsRunning;
            
            using (new EditorGUILayout.HorizontalScope())
            {
                if (!isRunning)
                {
                    if (GUILayout.Button("Start Server", GUILayout.Height(30)))
                    {
                        ToolRegistry.Initialize();
                        McpServer.Instance.Start(_port);
                    }
                }
                else
                {
                    if (GUILayout.Button("Stop Server", GUILayout.Height(30)))
                    {
                        // 사용자가 명시적으로 정지 — 자동 재시작 억제 플래그를 세운다.
                        McpServer.Instance.StopUser();
                    }
                }
            }
        }

        private void DrawConnectionInfo()
        {
            EditorGUILayout.LabelField("MCP Client Configuration", EditorStyles.boldLabel);
            
            // Generate proper config with bridge
            string bridgePathEscaped = _bridgePath?.Replace("\\", "\\\\") ?? "[BRIDGE_PATH]";
            
            string config = "{\n" +
                "  \"mcpServers\": {\n" +
                "    \"unity\": {\n" +
                "      \"command\": \"node\",\n" +
                $"      \"args\": [\"{bridgePathEscaped}\"],\n" +
                "      \"timeout\": 120000\n" +
                "    }\n" +
                "  }\n" +
                "}";
            
            EditorGUILayout.HelpBox(
                "Add this to your MCP client configuration (e.g., mcp_config.json):\n\n" + config,
                MessageType.None);

            using (new EditorGUILayout.HorizontalScope())
            {
                if (GUILayout.Button("Copy Config to Clipboard"))
                {
                    EditorGUIUtility.systemCopyBuffer = config;
                    Debug.Log("[MCP] Configuration copied to clipboard.");
                }
                
                if (GUILayout.Button("Open Bridge Folder"))
                {
                    if (!string.IsNullOrEmpty(_bridgePath))
                    {
                        EditorUtility.RevealInFinder(_bridgePath);
                    }
                }
            }
            
            // Bridge path info
            EditorGUILayout.Space(5);
            EditorGUILayout.LabelField("Bridge Path:", EditorStyles.miniLabel);
            EditorGUILayout.SelectableLabel(_bridgePath ?? "(not found)", EditorStyles.miniTextField, GUILayout.Height(18));
        }

        private void DrawToolsList()
        {
            EditorGUILayout.LabelField("Available Tools", EditorStyles.boldLabel);
            
            var tools = ToolRegistry.GetToolDefinitions();
            
            if (tools.Length == 0)
            {
                EditorGUILayout.LabelField("(Start server to load tools)", EditorStyles.miniLabel);
                return;
            }

            EditorGUILayout.LabelField($"{tools.Length} tools registered", EditorStyles.miniLabel);
            
            _showAllTools = EditorGUILayout.Foldout(_showAllTools, "Show All Tools");
            
            if (_showAllTools)
            {
                EditorGUI.indentLevel++;
                foreach (var tool in tools)
                {
                    EditorGUILayout.LabelField($"• {tool.name}", EditorStyles.miniLabel);
                }
                EditorGUI.indentLevel--;
            }
        }
    }
}
