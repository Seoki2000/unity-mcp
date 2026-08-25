using System;
using System.Collections.Generic;
using System.IO;
using UnityEditor;
using UnityEngine;

namespace Community.Unity.MCP.DebugTools
{
    /// <summary>
    /// 대조군 계측기. 우리 인덱스가 주장하는 엣지를 Unity 자체 의존성 DB
    /// (AssetDatabase.GetDependencies)에 같은 질문으로 던져 답을 파일에 남긴다.
    ///
    /// 왜 MCP 도구가 아니라 메뉴인가 — tools/list 는 세션 고정비다(현재 82개 / 39,669 B).
    /// 한 번의 교차검증을 위해 AI 가 영구히 배워야 할 도구를 늘리지 않는다.
    ///
    /// 입력  ~/.unity-mcp/depcheck-in.json   {"pairs":[{"source":..,"target":..,"note":..}],
    ///                                        "reverseTargets":[".."]}
    /// 출력  ~/.unity-mcp/depcheck-out.json
    /// </summary>
    public static class DependencyCrossCheck
    {
        [Serializable]
        public class Pair
        {
            public string source;
            public string target;
            public string note;
        }

        [Serializable]
        public class InputSpec
        {
            public Pair[] pairs;
            public string[] reverseTargets;
        }

        [Serializable]
        public class PairResult
        {
            public string source;
            public string target;
            public string note;
            public bool sourceExists;
            public bool targetExists;
            public int directCount;
            public int recursiveCount;
            public bool directHit;
            public bool recursiveHit;
            public string[] directDeps;
        }

        [Serializable]
        public class ReverseResult
        {
            public string target;
            public bool targetExists;
            public int assetsScanned;
            public int referenceCount;
            public string[] referencedBy;
        }

        [Serializable]
        public class OutputSpec
        {
            public string unityVersion;
            public string generatedAt;
            public int elapsedMs;
            public PairResult[] pairs;
            public ReverseResult[] reverse;
        }

        private static string HomeDir()
        {
            string home = Environment.GetEnvironmentVariable("USERPROFILE");
            if (string.IsNullOrEmpty(home)) home = Environment.GetFolderPath(Environment.SpecialFolder.UserProfile);
            return home;
        }

        private static string InPath() { return Path.Combine(Path.Combine(HomeDir(), ".unity-mcp"), "depcheck-in.json"); }
        private static string OutPath() { return Path.Combine(Path.Combine(HomeDir(), ".unity-mcp"), "depcheck-out.json"); }

        [MenuItem("Window/MCP Dependency Cross-Check")]
        public static void Run()
        {
            var started = DateTime.UtcNow;
            string inPath = InPath();

            if (!File.Exists(inPath))
            {
                Debug.LogError("[DepCheck] input not found: " + inPath);
                return;
            }

            var spec = JsonUtility.FromJson<InputSpec>(File.ReadAllText(inPath));
            if (spec == null)
            {
                Debug.LogError("[DepCheck] input parse failed: " + inPath);
                return;
            }

            var pairResults = new List<PairResult>();
            if (spec.pairs != null)
            {
                foreach (var p in spec.pairs)
                {
                    if (p == null || string.IsNullOrEmpty(p.source)) continue;

                    var r = new PairResult
                    {
                        source = p.source,
                        target = p.target,
                        note = p.note,
                        sourceExists = !string.IsNullOrEmpty(AssetDatabase.AssetPathToGUID(p.source)),
                        targetExists = !string.IsNullOrEmpty(AssetDatabase.AssetPathToGUID(p.target))
                    };

                    var direct = AssetDatabase.GetDependencies(p.source, false);
                    var recursive = AssetDatabase.GetDependencies(p.source, true);
                    r.directCount = direct.Length;
                    r.recursiveCount = recursive.Length;
                    r.directDeps = direct;

                    foreach (var d in direct) { if (d == p.target) { r.directHit = true; break; } }
                    foreach (var d in recursive) { if (d == p.target) { r.recursiveHit = true; break; } }

                    pairResults.Add(r);
                }
            }

            var reverseResults = new List<ReverseResult>();
            if (spec.reverseTargets != null && spec.reverseTargets.Length > 0)
            {
                // Unity 에 "누가 이걸 쓰나" 를 묻는 유일한 방법은 전수 GetDependencies 다.
                // unity_search_project(type=reference) 가 하는 것과 같은 일이며,
                // 브릿지 타임아웃(45s)에 걸리던 그 경로를 에디터 안에서 직접 돌린다.
                string[] all = AssetDatabase.GetAllAssetPaths();

                foreach (var target in spec.reverseTargets)
                {
                    if (string.IsNullOrEmpty(target)) continue;

                    var hits = new List<string>();
                    foreach (var assetPath in all)
                    {
                        if (assetPath == target) continue;
                        var deps = AssetDatabase.GetDependencies(assetPath, false);
                        foreach (var d in deps)
                        {
                            if (d == target) { hits.Add(assetPath); break; }
                        }
                    }

                    reverseResults.Add(new ReverseResult
                    {
                        target = target,
                        targetExists = !string.IsNullOrEmpty(AssetDatabase.AssetPathToGUID(target)),
                        assetsScanned = all.Length,
                        referenceCount = hits.Count,
                        referencedBy = hits.ToArray()
                    });
                }
            }

            var output = new OutputSpec
            {
                unityVersion = Application.unityVersion,
                generatedAt = DateTime.UtcNow.ToString("o"),
                elapsedMs = (int)(DateTime.UtcNow - started).TotalMilliseconds,
                pairs = pairResults.ToArray(),
                reverse = reverseResults.ToArray()
            };

            File.WriteAllText(OutPath(), JsonUtility.ToJson(output, true));
            Debug.Log("[DepCheck] wrote " + OutPath() + " (" + output.elapsedMs + " ms, pairs " +
                      pairResults.Count + ", reverse " + reverseResults.Count + ")");
        }
    }
}
