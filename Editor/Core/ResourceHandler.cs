using System;
using System.Collections.Generic;
using System.IO;
using UnityEditor;
using UnityEngine;

namespace Community.Unity.MCP
{
    /// <summary>
    /// Handles MCP resource operations (resources/list, resources/read).
    /// [OPTIMIZED] Reduced response sizes for token efficiency with AI coding assistants.
    /// </summary>
    public static class ResourceHandler
    {
        // 기존 500 -> 50으로 대폭 축소. AI가 500개의 에셋 목록을 한번에 읽을 필요는 없음.
        private const int MAX_LIST_RESULTS = 50;

        /// <summary>
        /// Handle resources/list request.
        /// </summary>
        public static object HandleResourcesList(string paramsJson)
        {
            var resources = new List<McpResource>();
            
            // List all C# scripts (user scripts only, exclude packages)
            var scriptGuids = AssetDatabase.FindAssets("t:MonoScript", new[] { "Assets" });
            foreach (var guid in scriptGuids)
            {
                var path = AssetDatabase.GUIDToAssetPath(guid);
                // 패키지 내부 스크립트 제외
                if (path.StartsWith("Packages/")) continue;
                resources.Add(new McpResource
                {
                    uri = $"unity://script/{path}",
                    name = Path.GetFileName(path),
                    mimeType = "text/x-csharp"
                });
            }
            
            // List all scenes
            var sceneGuids = AssetDatabase.FindAssets("t:Scene", new[] { "Assets" });
            foreach (var guid in sceneGuids)
            {
                var path = AssetDatabase.GUIDToAssetPath(guid);
                resources.Add(new McpResource
                {
                    uri = $"unity://scene/{path}",
                    name = Path.GetFileName(path),
                    mimeType = "application/x-unity-scene"
                });
            }
            
            // List all prefabs (user prefabs only, exclude third-party asset packs)
            var prefabGuids = AssetDatabase.FindAssets("t:Prefab", new[] { "Assets" });
            foreach (var guid in prefabGuids)
            {
                var path = AssetDatabase.GUIDToAssetPath(guid);
                resources.Add(new McpResource
                {
                    uri = $"unity://prefab/{path}",
                    name = Path.GetFileName(path),
                    mimeType = "application/x-unity-prefab"
                });
            }
            
            // List ScriptableObjects
            var soGuids = AssetDatabase.FindAssets("t:ScriptableObject", new[] { "Assets" });
            foreach (var guid in soGuids)
            {
                var path = AssetDatabase.GUIDToAssetPath(guid);
                resources.Add(new McpResource
                {
                    uri = $"unity://scriptableobject/{path}",
                    name = Path.GetFileName(path),
                    mimeType = "application/json"
                });
            }
            
            int totalCount = resources.Count;
            
            // Limit results
            if (resources.Count > MAX_LIST_RESULTS)
            {
                resources = resources.GetRange(0, MAX_LIST_RESULTS);
            }
            
            return new McpResourcesListResult
            {
                resources = resources.ToArray(),
                _meta = new ResourcesMeta { totalCount = totalCount, returnedCount = resources.Count }
            };
        }

        /// <summary>
        /// Handle resources/read request.
        /// </summary>
        public static object HandleResourcesRead(string paramsJson)
        {
            string uri = ExtractUri(paramsJson);
            
            if (string.IsNullOrEmpty(uri))
            {
                throw new ArgumentException("uri parameter is required");
            }
            
            if (!uri.StartsWith("unity://"))
            {
                throw new ArgumentException($"Invalid URI scheme. Expected unity://, got: {uri}");
            }
            
            string remainder = uri.Substring(8);
            int slashIndex = remainder.IndexOf('/');
            if (slashIndex < 0)
            {
                throw new ArgumentException($"Invalid URI format: {uri}");
            }
            
            string resourceType = remainder.Substring(0, slashIndex);
            string assetPath = remainder.Substring(slashIndex + 1);
            
            var contents = new List<McpResourceContent>();
            
            switch (resourceType)
            {
                case "script":
                    contents.Add(ReadScriptResource(assetPath));
                    break;
                case "scene":
                    contents.Add(ReadSceneResource(assetPath));
                    break;
                case "prefab":
                    contents.Add(ReadPrefabResource(assetPath));
                    break;
                case "scriptableobject":
                    contents.Add(ReadScriptableObjectResource(assetPath));
                    break;
                case "file":
                    contents.Add(ReadFileResource(assetPath));
                    break;
                default:
                    throw new ArgumentException($"Unknown resource type: {resourceType}");
            }
            
            return new McpResourcesReadResult
            {
                contents = contents.ToArray()
            };
        }

        private static McpResourceContent ReadScriptResource(string assetPath)
        {
            string fullPath = Path.Combine(Application.dataPath.Replace("/Assets", ""), assetPath);
            
            if (!File.Exists(fullPath))
            {
                throw new FileNotFoundException($"Script not found: {assetPath}");
            }
            
            string content = File.ReadAllText(fullPath);
            
            return new McpResourceContent
            {
                uri = $"unity://script/{assetPath}",
                mimeType = "text/x-csharp",
                text = content
            };
        }

        private static McpResourceContent ReadSceneResource(string assetPath)
        {
            var sceneAsset = AssetDatabase.LoadAssetAtPath<SceneAsset>(assetPath);
            if (sceneAsset == null)
            {
                throw new FileNotFoundException($"Scene not found: {assetPath}");
            }
            
            // [OPTIMIZED] guid 제거, 필수 정보만 반환
            var info = new SceneInfo
            {
                name = sceneAsset.name,
                path = assetPath
            };
            
            return new McpResourceContent
            {
                uri = $"unity://scene/{assetPath}",
                mimeType = "application/json",
                text = JsonUtility.ToJson(info, false) // prettyPrint 비활성화로 JSON 크기 축소
            };
        }

        private static McpResourceContent ReadPrefabResource(string assetPath)
        {
            var prefab = AssetDatabase.LoadAssetAtPath<GameObject>(assetPath);
            if (prefab == null)
            {
                throw new FileNotFoundException($"Prefab not found: {assetPath}");
            }
            
            // [OPTIMIZED] 1단계 깊이만 탐색, tag/layer 제거
            var info = BuildGameObjectInfoLite(prefab, 0, 1);
            
            return new McpResourceContent
            {
                uri = $"unity://prefab/{assetPath}",
                mimeType = "application/json",
                text = JsonUtility.ToJson(info, false)
            };
        }

        private static McpResourceContent ReadScriptableObjectResource(string assetPath)
        {
            var so = AssetDatabase.LoadAssetAtPath<ScriptableObject>(assetPath);
            if (so == null)
            {
                throw new FileNotFoundException($"ScriptableObject not found: {assetPath}");
            }
            
            string json = JsonUtility.ToJson(so, false); // prettyPrint 비활성화
            
            return new McpResourceContent
            {
                uri = $"unity://scriptableobject/{assetPath}",
                mimeType = "application/json",
                text = json
            };
        }

        private static McpResourceContent ReadFileResource(string assetPath)
        {
            string fullPath = Path.Combine(Application.dataPath.Replace("/Assets", ""), assetPath);
            
            if (!File.Exists(fullPath))
            {
                throw new FileNotFoundException($"File not found: {assetPath}");
            }
            
            string content = File.ReadAllText(fullPath);
            string mimeType = GetMimeType(assetPath);
            
            return new McpResourceContent
            {
                uri = $"unity://file/{assetPath}",
                mimeType = mimeType,
                text = content
            };
        }

        /// <summary>
        /// [OPTIMIZED] 가벼운 버전의 GameObject 정보 빌더. 
        /// 깊이 제한 적용, tag/layer 등 불필요한 필드 제거.
        /// </summary>
        private static PrefabInfo BuildGameObjectInfoLite(GameObject go, int depth, int maxDepth)
        {
            var components = go.GetComponents<Component>();
            var componentNames = new List<string>();
            foreach (var c in components)
            {
                if (c != null) componentNames.Add(c.GetType().Name);
            }
            
            PrefabInfo[] childInfos = null;
            if (depth < maxDepth && go.transform.childCount > 0)
            {
                var children = new List<PrefabInfo>();
                for (int i = 0; i < go.transform.childCount; i++)
                {
                    children.Add(BuildGameObjectInfoLite(go.transform.GetChild(i).gameObject, depth + 1, maxDepth));
                }
                childInfos = children.ToArray();
            }
            
            return new PrefabInfo
            {
                name = go.name,
                activeSelf = go.activeSelf,
                components = componentNames.ToArray(),
                childCount = go.transform.childCount,
                children = childInfos
            };
        }

        private static string GetMimeType(string path)
        {
            string ext = Path.GetExtension(path).ToLower();
            switch (ext)
            {
                case ".cs": return "text/x-csharp";
                case ".js": return "text/javascript";
                case ".json": return "application/json";
                case ".xml": return "application/xml";
                case ".txt": return "text/plain";
                case ".md": return "text/markdown";
                case ".shader": return "text/x-shader";
                case ".hlsl": return "text/x-hlsl";
                case ".cginc": return "text/x-cginc";
                case ".asmdef": return "application/json";
                default: return "text/plain";
            }
        }

        private static string ExtractUri(string json)
        {
            if (string.IsNullOrEmpty(json)) return null;
            
            var match = System.Text.RegularExpressions.Regex.Match(json, "\"uri\"\\s*:\\s*\"([^\"]*)\"");
            return match.Success ? match.Groups[1].Value : null;
        }

        #region Data Types

        [Serializable]
        public class SceneInfo
        {
            public string name;
            public string path;
        }

        [Serializable]
        public class PrefabInfo
        {
            public string name;
            public bool activeSelf;
            public string[] components;
            public int childCount;
            public PrefabInfo[] children;
        }

        [Serializable]
        public class ResourcesMeta
        {
            public int totalCount;
            public int returnedCount;
        }

        #endregion
    }

    #region MCP Resource Types

    [Serializable]
    public class McpResource
    {
        public string uri;
        public string name;
        // [OPTIMIZED] description, guid 필드 제거 - AI가 uri와 name만으로 충분히 판단 가능
        public string mimeType;
    }

    [Serializable]
    public class McpResourcesListResult
    {
        public McpResource[] resources;
        public ResourceHandler.ResourcesMeta _meta;
    }

    [Serializable]
    public class McpResourceContent
    {
        public string uri;
        public string mimeType;
        public string text;
    }

    [Serializable]
    public class McpResourcesReadResult
    {
        public McpResourceContent[] contents;
    }

    #endregion
}
