using System;
using System.Collections.Generic;
using System.IO;
using System.Text;
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
        // 텍스트 리소스 1건의 상한. 정상 스크립트는 수백 줄이므로 넉넉하고,
        // 자동생성 대형 파일이 컨텍스트를 삼키는 것은 막는다.
        private const int MAX_TEXT_LINES = 2000;
        private const int MAX_TEXT_CHARS = 200000;

        /// <summary>
        /// Handle resources/list request.
        /// </summary>
        /// <summary>
        /// resources/list.
        ///
        /// ⚠️ 기존 버그: 스크립트를 먼저 전부 담고 그 다음 씬/프리팹/SO 를 이어 붙인 뒤
        ///    앞 50개만 잘라 반환했다. 스크립트가 50개를 넘는 프로젝트(즉 거의 모든 프로젝트)에서는
        ///    씬·프리팹·ScriptableObject 가 **단 하나도 목록에 나오지 않았다.**
        ///    MainProject 실측으로도 스크립트만 수백 개다.
        ///
        /// 수정: 타입 필터 + offset 커서 + 타입별 전체 개수 보고.
        ///   params: { "type": "script|scene|prefab|scriptableobject|all", "offset": N, "maxResults": N }
        /// </summary>
        public static object HandleResourcesList(Newtonsoft.Json.Linq.JToken paramsToken)
        {
            var p = paramsToken as Newtonsoft.Json.Linq.JObject;
            string type = p?["type"]?.ToString();
            int offset = McpPaging.ClampOffset((int?)p?["offset"] ?? 0);
            int limit = McpPaging.ClampLimit((int?)p?["maxResults"] ?? 0, MAX_LIST_RESULTS, 500);
            return ListResources(type, offset, limit);
        }

        /// <summary>문자열 params 를 받는 구 경로. 정규식 없이 Newtonsoft 로 파싱한다.</summary>
        public static object HandleResourcesList(string paramsJson)
        {
            Newtonsoft.Json.Linq.JObject p = null;
            if (!string.IsNullOrEmpty(paramsJson))
            {
                try { p = Newtonsoft.Json.Linq.JObject.Parse(paramsJson); } catch (Exception) { }
            }
            string type = p?["type"]?.ToString();
            int offset = McpPaging.ClampOffset((int?)p?["offset"] ?? 0);
            int limit = McpPaging.ClampLimit((int?)p?["maxResults"] ?? 0, MAX_LIST_RESULTS, 500);
            return ListResources(type, offset, limit);
        }

        /// <summary>
        /// 텍스트 리소스의 라인 범위 절단.
        ///
        /// ⚠️ 기존에는 파일 전체를 그대로 반환했다. 생성된 대형 파일(수만 줄 asmdef/json,
        ///    자동생성 스크립트) 하나로 모델 컨텍스트가 날아갈 수 있었고, 잘렸는지 여부도
        ///    알 수 없었다. 이제 범위와 절단 사실을 함께 돌려준다.
        /// </summary>
        private static string SliceText(string content, int startLine, int maxLines, int maxChars,
                                        out int totalLines, out int returnedLines, out bool truncated)
        {
            var all = content.Split('\n');
            totalLines = all.Length;

            int start = startLine > 0 ? startLine - 1 : 0;   // startLine 은 1-based
            if (start >= totalLines) start = Math.Max(0, totalLines - 1);

            int take = maxLines > 0 ? Math.Min(maxLines, MAX_TEXT_LINES) : MAX_TEXT_LINES;
            int end = Math.Min(totalLines, start + take);

            var sb = new StringBuilder();
            int charCap = maxChars > 0 ? Math.Min(maxChars, MAX_TEXT_CHARS) : MAX_TEXT_CHARS;
            int i = start;
            for (; i < end; i++)
            {
                if (sb.Length + all[i].Length + 1 > charCap) break;
                sb.Append(all[i]);
                if (i + 1 < end) sb.Append('\n');
            }

            returnedLines = i - start;
            truncated = start > 0 || i < totalLines;
            return sb.ToString();
        }

        private struct ResourceKind
        {
            public string name;      // uri 접두사 및 필터 키
            public string filter;    // AssetDatabase.FindAssets 필터
            public string mimeType;
        }

        private static readonly ResourceKind[] Kinds =
        {
            new ResourceKind { name = "script",           filter = "t:MonoScript",        mimeType = "text/x-csharp" },
            new ResourceKind { name = "scene",            filter = "t:Scene",             mimeType = "application/x-unity-scene" },
            new ResourceKind { name = "prefab",           filter = "t:Prefab",            mimeType = "application/x-unity-prefab" },
            new ResourceKind { name = "scriptableobject", filter = "t:ScriptableObject",  mimeType = "application/json" },
        };

        private static object ListResources(string typeFilter, int offset, int limit)
        {
            bool all = string.IsNullOrEmpty(typeFilter) ||
                       typeFilter.Equals("all", StringComparison.OrdinalIgnoreCase);

            if (!all)
            {
                bool known = false;
                foreach (var k in Kinds)
                    if (k.name.Equals(typeFilter, StringComparison.OrdinalIgnoreCase)) { known = true; break; }
                if (!known)
                {
                    var names = new List<string>();
                    foreach (var k in Kinds) names.Add(k.name);
                    throw new ArgumentException(
                        $"Unknown resource type '{typeFilter}'. Valid values: {string.Join(", ", names)}, all");
                }
            }

            // 타입별 전체 개수를 먼저 센다 — 필터를 안 걸어도 AI 가 "씬이 27개 있구나"를 알 수 있다.
            var counts = new List<TypeCount>();
            var selected = new List<McpResource>();

            foreach (var kind in Kinds)
            {
                bool include = all || kind.name.Equals(typeFilter, StringComparison.OrdinalIgnoreCase);

                var guids = AssetDatabase.FindAssets(kind.filter, new[] { "Assets" });
                int kindCount = 0;

                foreach (var guid in guids)
                {
                    var path = AssetDatabase.GUIDToAssetPath(guid);
                    if (string.IsNullOrEmpty(path)) continue;
                    // 패키지 내부는 제외(기존 동작 유지)
                    if (path.StartsWith("Packages/", StringComparison.Ordinal)) continue;

                    kindCount++;
                    if (!include) continue;

                    selected.Add(new McpResource
                    {
                        uri = $"unity://{kind.name}/{path}",
                        name = Path.GetFileName(path),
                        mimeType = kind.mimeType
                    });
                }

                counts.Add(new TypeCount { type = kind.name, totalCount = kindCount });
            }

            // 결정적 순서 — 같은 offset 이 항상 같은 항목을 가리켜야 커서가 의미를 갖는다.
            selected.Sort((x, y) => string.Compare(x.uri, y.uri, StringComparison.OrdinalIgnoreCase));

            int total = selected.Count;
            var page = new List<McpResource>();
            for (int i = offset; i < total && page.Count < limit; i++) page.Add(selected[i]);

            int next = McpPaging.NextOffset(offset, page.Count, total);

            return new McpResourcesListResult
            {
                resources = page.ToArray(),
                _meta = new ResourcesMeta
                {
                    totalCount = total,
                    returnedCount = page.Count,
                    offset = offset,
                    nextOffset = next,
                    truncated = next >= 0,
                    appliedTypeFilter = all ? "all" : typeFilter,
                    countsByType = counts.ToArray()
                }
            };
        }

        /// <summary>
        /// Handle resources/read request.
        /// </summary>
        /// <summary>
        /// JsonRpcHandler 가 이미 파싱해 둔 params 를 그대로 받는다.
        /// 예전 경로는 JToken 을 문자열로 되직렬화한 뒤 정규식으로 uri 를 다시 뽑았다 —
        /// 파싱을 두 번 하면서 이스케이프된 인용부호에서 깨지고, JSON 어디에 있든
        /// 첫 번째 "uri" 를 집어 엉뚱한 값을 읽을 수 있었다.
        /// </summary>
        public static object HandleResourcesRead(Newtonsoft.Json.Linq.JToken paramsToken)
        {
            var p = paramsToken as Newtonsoft.Json.Linq.JObject;
            string uri = p?["uri"]?.ToString();
            return ReadByUri(uri, (int?)p?["startLine"] ?? 0, (int?)p?["maxLines"] ?? 0, (int?)p?["maxChars"] ?? 0);
        }

        /// <summary>
        /// 문자열 params 를 받는 구 경로. Newtonsoft 로 정직하게 파싱한다(정규식 제거).
        /// </summary>
        public static object HandleResourcesRead(string paramsJson)
        {
            string uri = null;
            if (!string.IsNullOrEmpty(paramsJson))
            {
                try { uri = Newtonsoft.Json.Linq.JObject.Parse(paramsJson)["uri"]?.ToString(); }
                catch (Exception) { uri = null; }
            }
            return ReadByUri(uri, 0, 0, 0);
        }

        private static object ReadByUri(string uri, int startLine, int maxLines, int maxChars)
        {
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
                    contents.Add(ReadScriptResource(assetPath, startLine, maxLines, maxChars));
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
                    contents.Add(ReadFileResource(assetPath, startLine, maxLines, maxChars));
                    break;
                default:
                    throw new ArgumentException($"Unknown resource type: {resourceType}");
            }
            
            return new McpResourcesReadResult
            {
                contents = contents.ToArray()
            };
        }

        private static McpResourceContent ReadScriptResource(string assetPath, int startLine, int maxLines, int maxChars)
        {
            // 경로 포함 검사 — 없으면 "../../.." 로 프로젝트 밖 임의 파일을 읽을 수 있다.
            if (!McpPathGuard.TryResolveAssetPath(assetPath, out string fullPath, out string pathError))
            {
                throw new UnauthorizedAccessException(pathError);
            }

            if (!File.Exists(fullPath))
            {
                throw new FileNotFoundException($"Script not found: {assetPath}");
            }

            string raw = File.ReadAllText(fullPath);
            string content = SliceText(raw, startLine, maxLines, maxChars,
                                       out int totalLines, out int returnedLines, out bool truncated);

            return new McpResourceContent
            {
                uri = $"unity://script/{assetPath}",
                mimeType = "text/x-csharp",
                text = content,
                startLine = startLine > 0 ? startLine : 1,
                returnedLines = returnedLines,
                totalLines = totalLines,
                truncated = truncated
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

        private static McpResourceContent ReadFileResource(string assetPath, int startLine, int maxLines, int maxChars)
        {
            // 가장 위험했던 지점 — unity://file/{임의경로} 로 디스크 어디든 읽혔다.
            if (!McpPathGuard.TryResolveAssetPath(assetPath, out string fullPath, out string pathError))
            {
                throw new UnauthorizedAccessException(pathError);
            }

            if (!File.Exists(fullPath))
            {
                throw new FileNotFoundException($"File not found: {assetPath}");
            }

            string raw = File.ReadAllText(fullPath);
            string content = SliceText(raw, startLine, maxLines, maxChars,
                                       out int totalLines, out int returnedLines, out bool truncated);
            string mimeType = GetMimeType(assetPath);

            return new McpResourceContent
            {
                uri = $"unity://file/{assetPath}",
                mimeType = mimeType,
                text = content,
                startLine = startLine > 0 ? startLine : 1,
                returnedLines = returnedLines,
                totalLines = totalLines,
                truncated = truncated
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
            public int offset;
            public int nextOffset;      // 더 없으면 -1
            public bool truncated;
            public string appliedTypeFilter;
            public TypeCount[] countsByType;   // 필터를 안 걸어도 무엇이 몇 개 있는지 알 수 있다
        }

        [Serializable]
        public class TypeCount
        {
            public string type;
            public int totalCount;
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
        // 텍스트 리소스의 라인 범위. 잘렸는지 AI 가 알 수 있어야 한다.
        public int startLine;
        public int returnedLines;
        public int totalLines;
        public bool truncated;
    }

    [Serializable]
    public class McpResourcesReadResult
    {
        public McpResourceContent[] contents;
    }

    #endregion
}
