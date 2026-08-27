using System;
using System.Collections.Generic;
using System.IO;
using System.Text.RegularExpressions;
using UnityEditor;
using UnityEngine;

namespace Community.Unity.MCP
{
    /// <summary>
    /// MCP tools for searching the Unity project.
    /// </summary>
    [McpToolProvider]
    public class SearchTools
    {
        [McpTool("unity_search_project", "Search for assets, scripts, or content in the project", typeof(SearchProjectArgs), ReadOnly = true)]
        public static object SearchProject(string argsJson)
        {
            var args = JsonUtility.FromJson<SearchProjectArgs>(argsJson);
            
            if (string.IsNullOrEmpty(args?.query))
            {
                return new McpToolError { error = "query parameter is required" };
            }
            
            var results = new List<SearchResult>();
            int maxResults = args.maxResults > 0 ? args.maxResults : 50;
            string searchPath = string.IsNullOrEmpty(args.folder) ? "Assets" : args.folder;
            
            // Determine search type
            string searchType = string.IsNullOrEmpty(args.type) ? "name" : args.type.ToLower();
            string ambiguityNote = null;
            
            switch (searchType)
            {
                case "name":
                    SearchByName(args.query, searchPath, args.assetType, results, maxResults);
                    break;
                case "content":
                    try
                    {
                        SearchByContent(args.query, searchPath, results, maxResults,
                                        args.caseSensitive, args.regex,
                                        args.maxMatchesPerFile > 0 ? Math.Min(args.maxMatchesPerFile, 20) : 3);
                    }
                    catch (ArgumentException ex)
                    {
                        // 잘못된 정규식 — 0건으로 뭉개면 AI 가 "없다"고 결론낸다.
                        return new McpToolError { error = $"Invalid regex pattern: {ex.Message}" };
                    }
                    break;
                case "reference":
                {
                    string refusal;
                    ambiguityNote = SearchByReference(args.query, searchPath, results, maxResults, out refusal);
                    // 스코프가 너무 넓으면 30초를 태우고 -32603 으로 죽는 대신 즉시 대안을 말한다.
                    if (refusal != null) return new McpToolError { error = refusal };
                    break;
                }
                default:
                    return new McpToolError { error = $"Unknown search type: {searchType}. Valid types: name, content, reference" };
            }
            
            return new SearchProjectResult
            {
                query = args.query,
                searchType = searchType,
                folder = searchPath,
                // 0 건일 때 무엇을 훑고 0 인지 말한다. folder 는 이제 실제로 지켜진다.
                scannedAssetCount = _lastScannedCount,
                resultCount = results.Count,
                truncated = results.Count >= maxResults,
                // reference 검색에는 **왜 두 경로가 있는지**를 항상 말한다. 거절 경로에서만
                // unity_find_references 를 언급하고 있었어서, 정상 경로의 호출자는 96배 빠른
                // 대안이 있다는 것도, 두 답이 갈릴 수 있다는 것도 알 방법이 없었다.
                note = searchType == "reference"
                    ? ((ambiguityNote == null ? "" : ambiguityNote + " ") + ReferencePathNote)
                    : ambiguityNote,
                results = results.ToArray()
            };
        }

        private static void SearchByName(string query, string folder, string assetType, List<SearchResult> results, int maxResults)
        {
            // Build filter string
            string filter = query;
            if (!string.IsNullOrEmpty(assetType))
            {
                filter = $"t:{assetType} {query}";
            }
            
            var guids = AssetDatabase.FindAssets(filter, new[] { folder });
            
            foreach (var guid in guids)
            {
                if (results.Count >= maxResults) break;
                
                var path = AssetDatabase.GUIDToAssetPath(guid);
                var type = AssetDatabase.GetMainAssetTypeAtPath(path);
                
                results.Add(new SearchResult
                {
                    path = path,
                    name = Path.GetFileName(path),
                    type = type?.Name ?? "Unknown",
                    guid = guid,
                    matchType = "name"
                });
            }
        }

        private static void SearchByContent(string query, string folder, List<SearchResult> results,
                                            int maxResults, bool caseSensitive, bool useRegex, int maxMatchesPerFile)
        {
            // 경로 포함 검사 — folder 는 호출자 입력이고 아래에서 SearchOption.AllDirectories 로 재귀 순회한다.
            // 검사가 없으면 folder="../.." 로 프로젝트 밖 디스크를 훑어 파일 내용을 반환할 수 있다.
            if (!McpPathGuard.TryResolveAssetPath(folder, out string fullFolderPath, out string pathError))
            {
                throw new UnauthorizedAccessException(pathError);
            }

            string projectPath = McpPathGuard.ProjectRoot;

            if (!Directory.Exists(fullFolderPath))
            {
                return;
            }

            Regex regex = null;
            if (useRegex)
            {
                var opts = RegexOptions.CultureInvariant;
                if (!caseSensitive) opts |= RegexOptions.IgnoreCase;
                // 잘못된 패턴은 호출자에게 알린다(조용히 0건으로 끝내면 AI 가 "없다"고 결론낸다).
                regex = new Regex(query, opts);
            }

            // ⚠️ 기존 버그: 확장자 배열을 순차로 돌면서 results.Count >= maxResults 에 걸리면 break 했다.
            //    .cs 가 첫 번째라 스크립트가 많은 프로젝트에서는 shader/hlsl/asmdef 매치가
            //    사실상 절대 반환되지 않았다. 전체 후보를 모은 뒤 랭킹으로 정렬하고 그 다음에 자른다.
            string[] extensions = { "*.cs", "*.shader", "*.cginc", "*.hlsl", "*.json", "*.txt", "*.xml", "*.asmdef" };

            var candidates = new List<ScoredResult>();

            foreach (var ext in extensions)
            {
                string[] files;
                try { files = Directory.GetFiles(fullFolderPath, ext, SearchOption.AllDirectories); }
                catch { continue; }

                foreach (var file in files)
                {
                    try
                    {
                        string content = File.ReadAllText(file);

                        var matchingLines = FindMatchingLines(content, query, caseSensitive, regex, maxMatchesPerFile,
                                                              out int firstLine, out int matchCount);
                        if (matchCount == 0) continue;

                        string relativePath = file.Replace(projectPath + Path.DirectorySeparatorChar, "").Replace('\\', '/');
                        string fileName = Path.GetFileName(file);

                        candidates.Add(new ScoredResult
                        {
                            score = ScoreContentMatch(query, fileName, relativePath, matchCount),
                            result = new SearchResult
                            {
                                path = relativePath,
                                name = fileName,
                                type = Path.GetExtension(file).TrimStart('.').ToUpper(),
                                guid = AssetDatabase.AssetPathToGUID(relativePath),
                                matchType = "content",
                                matchContext = matchingLines.Count > 0 ? matchingLines[0] : null,
                                matchLines = matchingLines.ToArray(),
                                matchCount = matchCount,
                                lineNumber = firstLine
                            }
                        });
                    }
                    catch
                    {
                        // Skip files that can't be read
                    }
                }
            }

            // 결정적 랭킹: 점수 내림차순 → 경로 오름차순(동점 시 순서가 호출마다 흔들리지 않게).
            candidates.Sort((a, b) =>
            {
                int c = b.score.CompareTo(a.score);
                return c != 0 ? c : string.Compare(a.result.path, b.result.path, StringComparison.OrdinalIgnoreCase);
            });

            for (int i = 0; i < candidates.Count && results.Count < maxResults; i++)
            {
                results.Add(candidates[i].result);
            }
        }

        private struct ScoredResult
        {
            public int score;
            public SearchResult result;
        }

        /// <summary>
        /// 내용 검색 랭킹. 문서화된 결정적 규칙만 쓴다(설명 없는 휴리스틱 금지).
        ///   +100 파일명이 질의와 완전히 일치 (확장자 제외)
        ///   +50  파일명이 질의를 포함
        ///   +20  Assets/ 직속 스크립트 폴더처럼 경로가 짧을수록 (깊이 페널티의 역)
        ///   +매치 수 (최대 +25)
        /// </summary>
        private static int ScoreContentMatch(string query, string fileName, string relativePath, int matchCount)
        {
            int score = 0;
            string stem = Path.GetFileNameWithoutExtension(fileName);

            if (string.Equals(stem, query, StringComparison.OrdinalIgnoreCase)) score += 100;
            else if (fileName.IndexOf(query, StringComparison.OrdinalIgnoreCase) >= 0) score += 50;

            int depth = 0;
            for (int i = 0; i < relativePath.Length; i++) if (relativePath[i] == '/') depth++;
            score += Math.Max(0, 20 - depth * 2);

            score += Math.Min(matchCount, 25);
            return score;
        }

        /// <summary>
        /// 역참조 검색. 반환값은 모호성 경고(있으면) 문자열.
        ///
        /// ⚠️ 기존 버그: FindAssets(query) 의 guids[0] 만 대상으로 삼았다.
        ///    동명 에셋이 둘 이상이면 어느 것을 봤는지 알리지도 않고 엉뚱한 답을 냈다.
        ///    이제 정확한 경로/GUID 를 우선 해석하고, 여전히 모호하면 후보를 돌려줘 호출자가 고르게 한다.
        /// </summary>
        // 이 프로젝트 실측(2026-08-25 / 재확인 2026-08-27): 전수 대상 에셋 24,233 경로,
        // 콜드 41초. 에디터 큐 캡이 30초라 **먼저 끊기는 것은 브릿지가 아니라 큐**이고
        // `-32603 Request timeout` 이 올라온다(작업 자체는 백그라운드에서 완주한다).
        // 그래서 상한을 넘는 스코프는 시도하지 않고 대안을 말한다.
        private const int ReferenceScanLimit = 8000;

        // 두 경로가 남아 있는 이유. 지우지 않은 것은 **서로를 검증하기 때문**이다.
        // 실측(2026-08-27, 같은 대상 AudioManager.cs): 이쪽은 에셋 3,143개를 훑어 1,344 ms,
        // unity_find_references 는 14 ms - 96배. 답은 둘 다 2건으로 같았다.
        // 그런데 항상 같지는 않다: Unity 의 GetDependencies 는 VFX Graph 의 내부 참조를
        // 놓치고(측정됨) 역 GUID 인덱스는 그것을 찾는다. 반대로 이쪽은 Unity 자신의 답이다.
        private const string ReferencePathNote =
            "This walks AssetDatabase.GetDependencies over the scoped assets, so it is Unity's own " +
            "answer but it needs a live editor and costs a full scan (measured on this project: 3,143 " +
            "assets, 1,344 ms). unity_find_references answers the same question from the bridge's " +
            "reverse GUID index in O(1) with no editor round-trip (14 ms on the same target) and keeps " +
            "working while Unity compiles or reloads. Both are kept on purpose because they disagree at " +
            "the edges: GetDependencies misses VFX Graph internal references (measured), while the index " +
            "cannot see runtime path lookups. When a zero matters, ask both.";

        // 마지막 reference 스캔이 실제로 훑은 에셋 수. 0 건 응답의 근거로 싣는다.
        [ThreadStatic] private static int _lastScannedCount;

        private static string SearchByReference(string query, string folder, List<SearchResult> results,
                                                int maxResults, out string refusal)
        {
            refusal = null;
            string targetPath = null;
            string ambiguity = null;

            // 1) 질의가 에셋 경로면 그대로 쓴다.
            if (query.IndexOf('/') >= 0 && !string.IsNullOrEmpty(AssetDatabase.AssetPathToGUID(query)))
            {
                targetPath = query;
            }
            // 2) 질의가 32자 hex GUID 면 경로로 변환한다.
            else if (query.Length == 32 && IsHex(query))
            {
                string p = AssetDatabase.GUIDToAssetPath(query);
                if (!string.IsNullOrEmpty(p)) targetPath = p;
            }

            if (targetPath == null)
            {
                string[] guids = AssetDatabase.FindAssets(query);
                if (guids.Length == 0) return null;

                var paths = new List<string>();
                foreach (var g in guids)
                {
                    var p = AssetDatabase.GUIDToAssetPath(g);
                    if (!string.IsNullOrEmpty(p)) paths.Add(p);
                }

                if (paths.Count == 0) return null;

                if (paths.Count > 1)
                {
                    // 조용히 하나를 고르지 않는다. 무엇을 봤는지, 무엇이 후보였는지 알린다.
                    paths.Sort(StringComparer.OrdinalIgnoreCase);
                    targetPath = paths[0];
                    int shown = Math.Min(paths.Count, 10);
                    // 여기서 return 하면 아래 의존성 루프를 건너뛰어 결과가 0건이 된다.
                    // 그런데 note 는 "searched references to X" 라고 말한다 — 검색했다고 하면서
                    // 아무것도 안 찾은 답이 나가고, 읽는 쪽은 "참조가 없다" 로 읽는다. 기록만 남기고 계속한다.
                    ambiguity = $"'{query}' matched {paths.Count} assets; searched references to '{targetPath}' only. " +
                                $"Pass an exact asset path or GUID to disambiguate. Candidates: {string.Join(", ", paths.GetRange(0, shown))}" +
                                (paths.Count > shown ? ", ..." : "");
                }

                targetPath = paths[0];
            }
            
            // Search for references to this asset.
            //
            // ⚠️ 여기가 `folder` 파라미터를 무시하던 자리다. `GetAllAssetPaths()` 를 그대로 돌면서
            // 응답에는 `folder` 를 echo 해서, 스코프를 좁힌 줄 알고 읽게 만들었다.
            // 실측(2026-08-27): folder=Assets/50.Art, maxResults=5 로 불러도 전체를 훑고 31초에 타임아웃.
            // 무시되는 파라미터가 곧 타임아웃의 원인이었다.
            var scoped = new List<string>();
            var prefix = string.IsNullOrEmpty(folder) ? "Assets" : folder.Replace(Path.DirectorySeparatorChar, '/').TrimEnd('/');
            foreach (var p in AssetDatabase.GetAllAssetPaths())
            {
                if (p == null) continue;
                if (p.Length == prefix.Length ? string.Equals(p, prefix, StringComparison.OrdinalIgnoreCase)
                                              : p.StartsWith(prefix + "/", StringComparison.OrdinalIgnoreCase))
                    scoped.Add(p);
            }

            // 스코프가 아무것도 안 잡으면 그건 "참조 0" 이 아니라 **folder 가 틀린 것**이다.
            // 0 을 돌려주면 "아무도 안 쓴다" 로 읽힌다 — §4-(24)-1 과 같은 형태다.
            // 실측으로 걸렸다: folder='Library/PackageCache' 가 0건을 답했는데,
            // GetAllAssetPaths() 는 패키지 에셋을 **`Packages/...`** 로 내지 Library 경로로 내지 않는다.
            if (scoped.Count == 0)
            {
                refusal = $"folder '{prefix}' matched no assets in the AssetDatabase, so this is not a " +
                          $"'no references' answer - nothing was scanned. Note that package assets appear " +
                          $"under 'Packages/<id>/...', not 'Library/PackageCache/...'. Pass a folder that " +
                          $"exists in the AssetDatabase, or omit it to scan all of Assets.";
                return null;
            }

            if (scoped.Count > ReferenceScanLimit)
            {
                refusal = $"Refusing to scan {scoped.Count} assets under '{prefix}' — this calls " +
                          $"AssetDatabase.GetDependencies on every one of them and exceeds the editor's " +
                          $"30-second main-thread queue (measured: 24,233 assets, 41s cold, request dies " +
                          $"with -32603 while the work keeps running). Two ways forward: narrow 'folder' to " +
                          $"under {ReferenceScanLimit} assets, or use unity_find_references, which answers the " +
                          $"same question from the bridge's reverse GUID index in O(1), needs no editor " +
                          $"round-trip, and reports what it could not scan.";
                return null;
            }

            _lastScannedCount = scoped.Count;
            string[] allAssets = scoped.ToArray();

            foreach (var assetPath in allAssets)
            {
                if (results.Count >= maxResults) break;
                
                // Skip the target itself
                if (assetPath == targetPath) continue;
                
                // Check dependencies
                var dependencies = AssetDatabase.GetDependencies(assetPath, false);
                
                foreach (var dep in dependencies)
                {
                    if (dep == targetPath)
                    {
                        string guid = AssetDatabase.AssetPathToGUID(assetPath);
                        var type = AssetDatabase.GetMainAssetTypeAtPath(assetPath);
                        
                        results.Add(new SearchResult
                        {
                            path = assetPath,
                            name = Path.GetFileName(assetPath),
                            type = type?.Name ?? "Unknown",
                            guid = guid,
                            matchType = "reference",
                            matchContext = $"References: {targetPath}"
                        });
                        break;
                    }
                }
            }

            return ambiguity;   // 모호했으면 그 사실, 아니면 null
        }

        /// <summary>
        /// 매칭 라인을 모으고, 첫 매치 줄번호와 총 매치 라인 수를 함께 돌려준다.
        /// 기존 구현은 라인 목록을 만든 뒤 GetLineNumber 로 내용을 한 번 더 전수 스캔했고,
        /// 반환은 matchingLines[0] 하나뿐이라 파일당 매치가 여러 개여도 AI 가 볼 수 없었다.
        /// </summary>
        private static List<string> FindMatchingLines(string content, string query, bool caseSensitive,
                                                      Regex regex, int maxLines,
                                                      out int firstLineNumber, out int matchCount)
        {
            var lines = new List<string>();
            firstLineNumber = 0;
            matchCount = 0;

            var allLines = content.Split('\n');

            for (int i = 0; i < allLines.Length; i++)
            {
                string line = allLines[i];
                bool matches = regex != null
                    ? regex.IsMatch(line)
                    : (caseSensitive
                        ? line.Contains(query)
                        : line.IndexOf(query, StringComparison.OrdinalIgnoreCase) >= 0);

                if (!matches) continue;

                matchCount++;
                if (firstLineNumber == 0) firstLineNumber = i + 1;

                if (lines.Count < maxLines)
                {
                    string trimmed = line.Trim();
                    // 한 줄이 지나치게 길면(미니파이된 json 등) 컨텍스트를 잘라 응답을 보호한다.
                    if (trimmed.Length > 300) trimmed = trimmed.Substring(0, 300) + "…";
                    lines.Add($"L{i + 1}: {trimmed}");
                }
            }

            return lines;
        }

        #region Data Types

        [Serializable]
        public class SearchProjectArgs
        {
            [McpParam("Search query", Required = true)] public string query;
            [McpParam("Search type", EnumValues = new[] { "name", "content", "reference" })] public string type;
            [McpParam("Folder to search (default 'Assets')")] public string folder;
            [McpParam("Filter by asset type (e.g., 'Script', 'Prefab', 'Scene')")] public string assetType;
            [McpParam("Case sensitive search (for content search)")] public bool caseSensitive;
            [McpParam("Treat query as a .NET regular expression (content search only)")] public bool regex;
            [McpParam("Max matching lines returned per file (default 3, max 20)")] public int maxMatchesPerFile;
            [McpParam("Maximum results (default 50)")] public int maxResults;
        }

        [Serializable]
        public class SearchResult
        {
            public string path;
            public string name;
            public string type;
            public string guid;
            public string matchType;
            public string matchContext;
            public string[] matchLines;   // 파일당 여러 매치 (기존은 첫 줄만 노출)
            public int matchCount;       // 이 파일의 총 매치 라인 수
            public int lineNumber;
        }

        [Serializable]
        public class SearchProjectResult
        {
            public string query;
            public string searchType;
            public string folder;
            public int scannedAssetCount;
            public int resultCount;
            public bool truncated;
            public string note;          // 모호한 reference 질의 등에 대한 경고
            public SearchResult[] results;
        }

        private static bool IsHex(string v)
        {
            foreach (char c in v)
            {
                bool hex = (c >= '0' && c <= '9') || (c >= 'a' && c <= 'f') || (c >= 'A' && c <= 'F');
                if (!hex) return false;
            }
            return true;
        }

        #endregion
    }
}
