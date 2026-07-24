using System;
using System.Reflection;
using UnityEditor;
using UnityEngine;

namespace Community.Unity.MCP
{
    /// <summary>
    /// MCP tools for opening specific Editor windows.
    /// </summary>
    [McpToolProvider]
    public class WindowTools
    {
        [Serializable]
        public class OpenWindowArgs
        {
            [McpParam("Optional GameObject path to select before opening the window")] 
            public string path;
            
            [McpParam("Optional Asset path to open (e.g. Assets/MyGraph.asset)")] 
            public string assetPath;
        }

        [McpTool("unity_open_animator_window", "Open the Animator window in Unity Editor", typeof(OpenWindowArgs))]
        public static object OpenAnimatorWindow(string argsJson)
        {
            var args = string.IsNullOrEmpty(argsJson) ? null : JsonUtility.FromJson<OpenWindowArgs>(argsJson);
            
            try
            {
                SelectTargetIfNeeded(args);

                EditorApplication.ExecuteMenuItem("Window/Animation/Animator");
                
                return new { 
                    success = true, 
                    window = "Animator",
                    message = "Animator window opened" 
                };
            }
            catch (Exception ex)
            {
                return new McpToolError { error = $"Failed to open Animator window: {ex.Message}" };
            }
        }

        [McpTool("unity_open_bt_window", "Open the Unity Behavior (BT) window", typeof(OpenWindowArgs))]
        public static object OpenBehaviorWindow(string argsJson)
        {
            var args = string.IsNullOrEmpty(argsJson) ? null : JsonUtility.FromJson<OpenWindowArgs>(argsJson);
            
            try
            {
                SelectTargetIfNeeded(args);

                if (!string.IsNullOrEmpty(args?.assetPath))
                {
                    var asset = AssetDatabase.LoadMainAssetAtPath(args.assetPath);
                    if (asset != null)
                    {
                        AssetDatabase.OpenAsset(asset);
                        return new { success = true, window = "Behavior", message = $"Behavior window opened for asset: {args.assetPath}" };
                    }
                }

                var type = Type.GetType("Unity.Behavior.Editor.BehaviorWindow, Unity.Behavior.Editor");
                if (type != null)
                {
                    EditorWindow.GetWindow(type, false, "Behavior", true);
                    return new { success = true, window = "Behavior", message = "Behavior window opened" };
                }
                
                return new McpToolError { error = "Behavior window type not found. Is the com.unity.behavior package installed?" };
            }
            catch (Exception ex)
            {
                return new McpToolError { error = $"Failed to open Behavior window: {ex.Message}" };
            }
        }

        private static void SelectTargetIfNeeded(OpenWindowArgs args)
        {
            if (args == null) return;

            if (!string.IsNullOrEmpty(args.assetPath))
            {
                var asset = AssetDatabase.LoadMainAssetAtPath(args.assetPath);
                if (asset != null)
                {
                    Selection.activeObject = asset;
                    EditorGUIUtility.PingObject(asset);
                }
            }
            else if (!string.IsNullOrEmpty(args.path))
            {
                var go = GameObject.Find(args.path);
                if (go != null)
                {
                    Selection.activeGameObject = go;
                    EditorGUIUtility.PingObject(go);
                }
            }
        }
    }
}
