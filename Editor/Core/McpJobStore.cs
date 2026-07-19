using System;
using System.Collections.Generic;
using System.IO;
using UnityEditor;
using UnityEngine;

namespace Community.Unity.MCP
{
    /// <summary>
    /// 리로드 유발 도구(재컴파일/플레이모드)가 만드는 잡 1건의 영속 레코드.
    /// status ∈ accepted | running | done | failed.
    /// </summary>
    [Serializable]
    public class JobRecord
    {
        public string id;
        public string tool;
        public string status;
        public string resultJson;
        public string error;
        public long createdTicks;
        public long updatedTicks;
    }

    /// <summary>
    /// 도메인 리로드/재컴파일을 넘어 살아남는 잡 스토어.
    /// 재컴파일·플레이모드 같은 리로드 유발 도구는 즉시 jobId를 반환하고,
    /// 클라이언트는 unity_get_job_status로 폴링해 최종 상태를 확인한다.
    /// Library/McpJobs.json 에 JsonUtility(래퍼 리스트)로 저장하고, 정적 초기화/afterAssemblyReload 에서 로드한다.
    ///
    /// 모든 접근은 에디터 메인 스레드에서 일어난다(도구 호출/리로드 콜백/delayCall).
    /// 그럼에도 파일 IO 중 예외 격리와 미래 변경 대비로 락을 둔다(Monitor는 재진입 가능).
    /// [InitializeOnLoad] 로 도메인 리로드마다 정적 생성자가 돌아 자동으로 로드된다.
    /// </summary>
    [InitializeOnLoad]
    public static class McpJobStore
    {
        [Serializable]
        private class JobStoreData
        {
            public List<JobRecord> jobs = new List<JobRecord>();
        }

        // 상태 상수 (오타 방지).
        public const string StatusAccepted = "accepted";
        public const string StatusRunning = "running";
        public const string StatusDone = "done";
        public const string StatusFailed = "failed";

        // 보존 정책: 최근 50개 & 24시간.
        private const int MaxJobs = 50;
        private static readonly long RetentionTicks = TimeSpan.FromHours(24).Ticks;

        private static readonly Dictionary<string, JobRecord> _jobs = new Dictionary<string, JobRecord>();
        private static readonly object _lock = new object();
        private static bool _loaded;
        private static string _cachedPath;

        static McpJobStore()
        {
            // 정적 초기화(에디터 시작/도메인 리로드마다)에서 로드.
            Load();
        }

        /// <summary>
        /// Library/McpJobs.json 절대 경로. Application.dataPath 는 &lt;project&gt;/Assets 이므로 상위의 Library 를 쓴다.
        /// (메인 스레드에서만 접근되므로 dataPath 사용이 안전하다.)
        /// </summary>
        private static string StorePath
        {
            get
            {
                if (string.IsNullOrEmpty(_cachedPath))
                {
                    _cachedPath = Path.GetFullPath(Path.Combine(Application.dataPath, "..", "Library", "McpJobs.json"));
                }
                return _cachedPath;
            }
        }

        /// <summary>새 잡을 생성하고(accepted) 즉시 저장, 8자리 짧은 id 반환.</summary>
        public static string CreateJob(string tool)
        {
            EnsureLoaded();
            long now = DateTime.UtcNow.Ticks;
            var rec = new JobRecord
            {
                id = Guid.NewGuid().ToString("N").Substring(0, 8),
                tool = tool,
                status = StatusAccepted,
                resultJson = null,
                error = null,
                createdTicks = now,
                updatedTicks = now
            };

            lock (_lock)
            {
                _jobs[rec.id] = rec;
                PruneLocked();
                SaveLocked();
            }
            return rec.id;
        }

        /// <summary>id로 잡 조회(없으면 null).</summary>
        public static JobRecord Get(string id)
        {
            EnsureLoaded();
            if (string.IsNullOrEmpty(id)) return null;
            lock (_lock)
            {
                return _jobs.TryGetValue(id, out var rec) ? rec : null;
            }
        }

        /// <summary>최근 갱신 순으로 count개 반환.</summary>
        public static List<JobRecord> GetRecent(int count)
        {
            EnsureLoaded();
            lock (_lock)
            {
                var list = new List<JobRecord>(_jobs.Values);
                list.Sort((a, b) => b.updatedTicks.CompareTo(a.updatedTicks));
                if (count >= 0 && list.Count > count) list = list.GetRange(0, count);
                return list;
            }
        }

        /// <summary>모든(정리 후) 잡을 갱신 순으로 반환 — 리로드 후 미완 잡 확정용.</summary>
        public static List<JobRecord> GetAll()
        {
            return GetRecent(-1);
        }

        /// <summary>
        /// 잡 상태를 갱신하고 저장. resultJson/error 는 null이면 기존 값을 보존한다.
        /// </summary>
        public static void Update(string id, string status, string resultJson, string error)
        {
            EnsureLoaded();
            if (string.IsNullOrEmpty(id)) return;
            lock (_lock)
            {
                if (!_jobs.TryGetValue(id, out var rec)) return;
                if (!string.IsNullOrEmpty(status)) rec.status = status;
                if (resultJson != null) rec.resultJson = resultJson;
                if (error != null) rec.error = error;
                rec.updatedTicks = DateTime.UtcNow.Ticks;
                SaveLocked();
            }
        }

        /// <summary>디스크에서 강제 재로드(afterAssemblyReload 경로에서 호출).</summary>
        public static void Reload()
        {
            lock (_lock)
            {
                _loaded = false;
            }
            Load();
        }

        private static void EnsureLoaded()
        {
            lock (_lock)
            {
                if (_loaded) return;
            }
            Load();
        }

        private static void Load()
        {
            lock (_lock)
            {
                if (_loaded) return;
                _loaded = true;
                try
                {
                    if (File.Exists(StorePath))
                    {
                        string json = File.ReadAllText(StorePath);
                        var data = JsonUtility.FromJson<JobStoreData>(json);
                        if (data?.jobs != null)
                        {
                            _jobs.Clear();
                            foreach (var j in data.jobs)
                            {
                                if (j != null && !string.IsNullOrEmpty(j.id))
                                    _jobs[j.id] = j;
                            }
                            PruneLocked();
                        }
                    }
                }
                catch (Exception ex)
                {
                    Debug.LogWarning($"[MCP] Job store load failed: {ex.Message}");
                }
            }
        }

        private static void PruneLocked()
        {
            long cutoff = DateTime.UtcNow.Ticks - RetentionTicks;

            // 24시간 초과 제거.
            List<string> stale = null;
            foreach (var kvp in _jobs)
            {
                if (kvp.Value.updatedTicks < cutoff)
                {
                    (stale ??= new List<string>()).Add(kvp.Key);
                }
            }
            if (stale != null)
            {
                foreach (var id in stale) _jobs.Remove(id);
            }

            // 최근 50개만 유지(갱신 순).
            if (_jobs.Count > MaxJobs)
            {
                var list = new List<JobRecord>(_jobs.Values);
                list.Sort((a, b) => b.updatedTicks.CompareTo(a.updatedTicks));
                for (int i = MaxJobs; i < list.Count; i++)
                {
                    _jobs.Remove(list[i].id);
                }
            }
        }

        private static void SaveLocked()
        {
            try
            {
                var data = new JobStoreData { jobs = new List<JobRecord>(_jobs.Values) };
                string json = JsonUtility.ToJson(data);
                string dir = Path.GetDirectoryName(StorePath);
                if (!string.IsNullOrEmpty(dir) && !Directory.Exists(dir))
                {
                    Directory.CreateDirectory(dir);
                }
                File.WriteAllText(StorePath, json);
            }
            catch (Exception ex)
            {
                Debug.LogWarning($"[MCP] Job store save failed: {ex.Message}");
            }
        }
    }
}
