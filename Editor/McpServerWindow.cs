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
        private const string PackageName = "com.community.unity-mcp";

        private int _port = 3000;
        private Vector2 _scrollPosition;
        private string _bridgePath;
        private bool _usingLauncher;
        private string _packageSource;
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
            
            ResolveBridgePath();
        }

        /// <summary>
        /// 설정에 넣을 경로를 찾는다. **런처를 우선한다.**
        ///
        /// 예전 구현은 두 가지로 깨져 있었다(2026-08-30 정적 확인):
        ///   1. `FindAssets("mcp-bridge t:TextAsset")` — `.js` 는 `DefaultImporter` 라
        ///      `DefaultAsset` 으로 임포트된다. `t:TextAsset` 필터는 **원리적으로 못 맞춘다.**
        ///   2. 폴백의 `Packages/com.community.unity-mcp/Bridge/mcp-bridge.js` 는 Unity 의
        ///      **가상 경로**다. `File.Exists` 는 디스크를 보므로 git URL 로 받은 패키지
        ///      (실체는 `Library/PackageCache/...@해시/`)에서도, 로컬 `file:` 참조에서도 false 다.
        /// 그래서 둘 다 실패해 `_bridgePath` 가 null 로 남고, 설정 문자열에
        /// `[BRIDGE_PATH]` 플레이스홀더가 나갔다 — 처음 셋업하는 사람이 손으로 경로를 찾아야 했다.
        ///
        /// 실체 경로는 `PackageInfo.resolvedPath` 가 알고 있다. 로컬·임베디드·git 캐시를
        /// 모두 같은 방식으로 답한다.
        /// </summary>
        private void ResolveBridgePath()
        {
            _bridgePath = null;
            _usingLauncher = false;
            _packageSource = null;

            var pkg = UnityEditor.PackageManager.PackageInfo.FindForAssetPath(
                "Packages/" + PackageName + "/package.json");
            if (pkg == null || string.IsNullOrEmpty(pkg.resolvedPath))
            {
                return;
            }

            _packageSource = DescribeSource(pkg);

            // 런처가 정본이다. 런처는 실행 시점에 브릿지를 다시 찾으므로, 패키지 핀을 올려
            // `PackageCache` 폴더 이름이 바뀌어도 등록해 둔 경로가 안 깨진다. 브릿지를 직접
            // 등록하면 핀을 올릴 때마다 조용히 낡은 사본을 돌리거나 사라진 경로를 가리킨다.
            var launcher = Path.Combine(pkg.resolvedPath, "Bridge", "mcp-bridge-launcher.js");
            if (File.Exists(launcher))
            {
                _bridgePath = launcher.Replace('\\', '/');
                _usingLauncher = true;
                return;
            }

            // 런처가 없는 옛 핀에서만 여기로 온다. 동작은 하지만 핀을 올리면 깨진다.
            var bridge = Path.Combine(pkg.resolvedPath, "Bridge", "mcp-bridge.js");
            if (File.Exists(bridge))
            {
                _bridgePath = bridge.Replace('\\', '/');
            }
        }

        /// <summary>
        /// 지금 **실제로 돌고 있는** 패키지가 어디서 왔는지. git 핀이면 해시까지 보여준다 —
        /// `manifest.json` 에 `skip-worktree` 가 걸려 있으면 커밋된 핀과 실제로 도는 것이
        /// 다를 수 있고, 그 차이는 `git status` 에 나오지 않는다.
        /// </summary>
        private static string DescribeSource(UnityEditor.PackageManager.PackageInfo pkg)
        {
            if (pkg.source == UnityEditor.PackageManager.PackageSource.Git)
            {
                var hash = pkg.git != null ? pkg.git.hash : null;
                return "git  " + (string.IsNullOrEmpty(hash) ? pkg.packageId : hash);
            }

            return pkg.source + "  " + pkg.resolvedPath.Replace('\\', '/');
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
            EditorGUILayout.LabelField(
                _usingLauncher ? "Launcher Path (register this):" : "Bridge Path:", EditorStyles.miniLabel);
            EditorGUILayout.SelectableLabel(_bridgePath ?? "(not found)", EditorStyles.miniTextField, GUILayout.Height(18));

            // 지금 실제로 도는 패키지의 출처. 커밋된 핀과 다를 수 있고 git status 에는 안 나온다.
            EditorGUILayout.LabelField("Resolved Package:", EditorStyles.miniLabel);
            EditorGUILayout.SelectableLabel(_packageSource ?? "(package not resolved)",
                EditorStyles.miniTextField, GUILayout.Height(18));

            if (_bridgePath == null)
            {
                EditorGUILayout.HelpBox(
                    "Could not resolve the package on disk, so the config above has a placeholder instead of a " +
                    "path. Check that " + PackageName + " is listed in Packages/manifest.json and that Unity " +
                    "finished importing it.",
                    MessageType.Warning);
            }
            else if (!_usingLauncher)
            {
                EditorGUILayout.HelpBox(
                    "This package has no Bridge/mcp-bridge-launcher.js, so the config points straight at the " +
                    "bridge. That path contains the package hash and will break the next time the pin changes. " +
                    "Update to a package version that ships the launcher and re-copy this config.",
                    MessageType.Warning);
            }
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
