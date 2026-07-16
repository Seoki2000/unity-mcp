using System;
using UnityEditor;
using UnityEngine;

namespace Community.Unity.MCP
{
    /// <summary>
    /// MCP tools for general Unity Editor operations.
    /// </summary>
    [McpToolProvider]
    public class EditorTools
    {
        [McpTool("unity_execute_menu", "Execute a Unity menu item", typeof(ExecuteMenuArgs))]
        public static object ExecuteMenu(string argsJson)
        {
            var args = JsonUtility.FromJson<ExecuteMenuArgs>(argsJson);
            
            if (string.IsNullOrEmpty(args?.menuPath))
            {
                return new McpToolError { error = "menuPath parameter is required" };
            }

            var result = EditorApplication.ExecuteMenuItem(args.menuPath);
            
            return new ExecuteMenuResult
            {
                menuPath = args.menuPath,
                success = result
            };
        }

        [McpTool("unity_select_object", "Select a GameObject in the Editor", typeof(SelectObjectArgs))]
        public static object SelectObject(string argsJson)
        {
            var args = JsonUtility.FromJson<SelectObjectArgs>(argsJson);

            if (string.IsNullOrEmpty(args?.path))
            {
                return new McpToolError { error = "path parameter is required" };
            }

            var go = GameObject.Find(args.path);
            if (go == null)
            {
                return new SelectObjectErrorResult { error = $"GameObject not found: {args.path}", success = false };
            }

            Selection.activeGameObject = go;
            EditorGUIUtility.PingObject(go);

            return new SelectObjectResult
            {
                path = args.path,
                success = true
            };
        }

        [McpTool("unity_get_selection", "Get the currently selected objects in the Editor")]
        public static object GetSelection(string argsJson)
        {
            var selection = Selection.gameObjects;
            var paths = new string[selection.Length];
            
            for (int i = 0; i < selection.Length; i++)
            {
                paths[i] = GetGameObjectPath(selection[i]);
            }

            return new SelectionResult
            {
                count = selection.Length,
                paths = paths
            };
        }

        [McpTool("unity_get_editor_state", "Get the current state of the Unity Editor")]
        public static object GetEditorState(string argsJson)
        {
            return new EditorStateResult
            {
                isPlaying = EditorApplication.isPlaying,
                isPaused = EditorApplication.isPaused,
                isCompiling = EditorApplication.isCompiling,
                currentScene = UnityEngine.SceneManagement.SceneManager.GetActiveScene().name,
                currentScenePath = UnityEngine.SceneManagement.SceneManager.GetActiveScene().path,
                platform = EditorUserBuildSettings.activeBuildTarget.ToString()
            };
        }

        private const string DomainReloadNote = "Domain reload will briefly disconnect the bridge; poll unity_get_editor_state to confirm.";

        [McpTool("unity_enter_play_mode", "Enter play mode")]
        public static object EnterPlayMode(string argsJson)
        {
            if (EditorApplication.isPlaying)
            {
                return new PlayModeErrorResult { error = "Already in play mode", isPlaying = true };
            }

            if (EditorApplication.isCompiling)
            {
                return new McpToolError { error = "Cannot enter play mode while compiling" };
            }

            EditorApplication.isPlaying = true;

            // 도메인 리로드로 곧 끊기며, 이 시점의 isPlaying은 전환 중일 뿐 확정된 상태가 아니다.
            // 조기에 true로 단정하지 않고 실제 값을 그대로 보고한다.
            return new PlayModeResult
            {
                success = true,
                action = "enter",
                isPlaying = EditorApplication.isPlaying,
                isPaused = false,
                accepted = true,
                transition = "starting",
                note = DomainReloadNote
            };
        }

        [McpTool("unity_exit_play_mode", "Exit play mode")]
        public static object ExitPlayMode(string argsJson)
        {
            if (!EditorApplication.isPlaying)
            {
                return new PlayModeErrorResult { error = "Not in play mode", isPlaying = false };
            }

            EditorApplication.isPlaying = false;

            return new PlayModeResult
            {
                success = true,
                action = "exit",
                isPlaying = EditorApplication.isPlaying,
                isPaused = false,
                accepted = true,
                transition = "stopping",
                note = DomainReloadNote
            };
        }

        [McpTool("unity_pause_play_mode", "Pause or unpause play mode", typeof(PausePlayModeArgs))]
        public static object PausePlayMode(string argsJson)
        {
            var args = JsonUtility.FromJson<PausePlayModeArgs>(argsJson);

            if (!EditorApplication.isPlaying)
            {
                return new PlayModeErrorResult { error = "Not in play mode", isPlaying = false };
            }

            // Toggle or set specific state
            bool newState = args?.pause ?? !EditorApplication.isPaused;
            EditorApplication.isPaused = newState;

            // Pause/unpause는 도메인 리로드가 없는 동기 처리라 isPlaying은 항상 true로 확정적이다.
            return new PlayModeResult
            {
                success = true,
                action = newState ? "pause" : "unpause",
                isPlaying = true,
                isPaused = newState,
                accepted = true
            };
        }

        private static string GetGameObjectPath(GameObject go)
        {
            string path = go.name;
            var parent = go.transform.parent;
            while (parent != null)
            {
                path = parent.name + "/" + path;
                parent = parent.parent;
            }
            return path;
        }

        #region Data Types

        [Serializable]
        public class ExecuteMenuArgs
        {
            [McpParam("Menu path (e.g., 'Edit/Play')", Required = true)] public string menuPath;
        }

        [Serializable]
        public class ExecuteMenuResult
        {
            public string menuPath;
            public bool success;
        }

        [Serializable]
        public class SelectObjectArgs
        {
            [McpParam("Path to the GameObject", Required = true)] public string path;
        }

        [Serializable]
        public class SelectObjectResult
        {
            public string path;
            public bool success;
        }

        [Serializable]
        public class SelectObjectErrorResult : McpToolError
        {
            public bool success;
        }

        [Serializable]
        public class SelectionResult
        {
            public int count;
            public string[] paths;
        }

        [Serializable]
        public class EditorStateResult
        {
            public bool isPlaying;
            public bool isPaused;
            public bool isCompiling;
            public string currentScene;
            public string currentScenePath;
            public string platform;
        }

        [Serializable]
        public class PlayModeResult
        {
            public bool success;
            public string action;
            public bool isPlaying;
            public bool isPaused;
            // [ADDED] enter/exit 응답을 정직하게 만들기 위한 필드 — 전환 중임을 명시.
            public bool accepted;
            public string transition;
            public string note;
        }

        [Serializable]
        public class PlayModeErrorResult : McpToolError
        {
            public bool isPlaying;
        }

        [Serializable]
        public class PausePlayModeArgs
        {
            [McpParam("Set to true to pause, false to unpause. If omitted, toggles current state.")] public bool pause;
        }

        #endregion
    }
}
