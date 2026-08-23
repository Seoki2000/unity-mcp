using System;
using System.Collections.Generic;
using System.IO;
using UnityEditor;
using UnityEngine;

namespace Community.Unity.MCP
{
    /// <summary>
    /// MCP tools for querying Unity project assets.
    /// [OPTIMIZED] Reduced response sizes for token efficiency with AI coding assistants.
    /// </summary>
    [McpToolProvider]
    public class AssetTools
    {
        // [OPTIMIZED] 기존 100 -> 30으로 축소. 이제는 기본값이며 maxResults 로 조절 가능.
        private const int MAX_RESULTS = 30;
        private const int HARD_CAP = 500;

        [McpTool("unity_get_assets", "List assets in a folder. Paginated: pass offset from the previous response's nextOffset to continue.", typeof(GetAssetsArgs), ReadOnly = true)]
        public static object GetAssets(string argsJson)
        {
            var args = JsonUtility.FromJson<GetAssetsArgs>(argsJson);
            var folderPath = string.IsNullOrEmpty(args?.folderPath) ? "Assets" : args.folderPath;
            var filter = args?.filter ?? "";

            if (!AssetDatabase.IsValidFolder(folderPath))
            {
                return new McpToolError { error = $"Invalid folder path: {folderPath}" };
            }

            var guids = AssetDatabase.FindAssets(filter, new[] { folderPath });
            var assets = new List<AssetInfo>();

            int limit = McpPaging.ClampLimit(args?.maxResults ?? 0, MAX_RESULTS, HARD_CAP);
            int offset = McpPaging.ClampOffset(args?.offset ?? 0);

            var count = 0;

            for (int gi = offset; gi < guids.Length; gi++)
            {
                if (count >= limit) break;
                var guid = guids[gi];

                var path = AssetDatabase.GUIDToAssetPath(guid);
                var type = AssetDatabase.GetMainAssetTypeAtPath(path);

                assets.Add(new AssetInfo
                {
                    path = path,
                    name = Path.GetFileName(path),
                    type = type?.Name ?? "Unknown"
                    // [OPTIMIZED] guid 제거 - AI에게 불필요
                });

                count++;
            }

            int next = McpPaging.NextOffset(offset, assets.Count, guids.Length);
            return new AssetsResult
            {
                folderPath = folderPath,
                totalCount = guids.Length,
                returnedCount = assets.Count,
                offset = offset,
                nextOffset = next,
                truncated = next >= 0,
                assets = assets.ToArray()
            };
        }

        [McpTool("unity_get_project_settings", "Get Unity project settings", ReadOnly = true)]
        public static object GetProjectSettings(string argsJson)
        {
            string scriptingBackend = "Unknown";
            string apiCompatibility = "Unknown";

            try
            {
                var buildTarget = UnityEditor.Build.NamedBuildTarget.FromBuildTargetGroup(EditorUserBuildSettings.selectedBuildTargetGroup);
                scriptingBackend = PlayerSettings.GetScriptingBackend(buildTarget).ToString();
                apiCompatibility = PlayerSettings.GetApiCompatibilityLevel(buildTarget).ToString();
            }
            catch
            {
                scriptingBackend = "N/A";
                apiCompatibility = "N/A";
            }

            return new ProjectSettingsResult
            {
                productName = Application.productName,
                unityVersion = Application.unityVersion,
                platform = EditorUserBuildSettings.activeBuildTarget.ToString(),
                scripting = scriptingBackend
                // [OPTIMIZED] companyName, version, apiCompatibility 제거
            };
        }

        #region Data Types

        [Serializable]
        public class GetAssetsArgs
        {
            [McpParam("Folder path (defaults to 'Assets')")] public string folderPath;
            [McpParam("Filter string (e.g., 't:Prefab', 't:Script', 'MyAsset')")] public string filter;
            [McpParam("Maximum results (default 30, max 500)")] public int maxResults;
            [McpParam("Start index. Pass the previous response's nextOffset to continue")] public int offset;
        }

        [Serializable]
        public class AssetsResult
        {
            public string folderPath;
            // [OPTIMIZED] filter 필드 제거
            public int totalCount;
            public int returnedCount;
            public int offset;
            public int nextOffset;   // 더 없으면 -1
            public bool truncated;
            public AssetInfo[] assets;
        }

        [Serializable]
        public class AssetInfo
        {
            public string path;
            public string name;
            public string type;
            // [OPTIMIZED] guid 제거
        }

        [Serializable]
        public class ProjectSettingsResult
        {
            public string productName;
            // [OPTIMIZED] companyName, version 제거
            public string unityVersion;
            public string platform;
            public string scripting;
            // [OPTIMIZED] apiCompatibility 제거
        }

        #endregion
    }
}
