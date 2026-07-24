using System;
using System.Collections.Generic;
using UnityEditor;
using UnityEngine;

namespace Community.Unity.MCP
{
    /// <summary>
    /// 리로드 유발 도구(재컴파일/플레이모드)가 만든 잡의 상태를 조회하는 MCP 도구.
    /// 저장된 레코드(McpJobStore) + 라이브 에디터 상태를 결합해 최종 상태를 판정하고,
    /// 판정 결과를 스토어에도 반영해 다음 폴링의 일관성을 보장한다.
    /// </summary>
    [McpToolProvider]
    public class JobTools
    {
        // 플레이모드 전환이 이 시간 안에 목표에 도달하지 못하면 failed 처리.
        private const double PlayModeTimeoutSec = 60.0;
        // 재컴파일 디스패치 후 이 시간까지 컴파일이 시작조차 안 하면(변경 없음 등) settled로 폴백.
        private const double RecompileNoCompileBackstopSec = 10.0;

        [McpTool("unity_get_job_status",
            "Get the status of a deferred job (script recompile or play-mode transition) by jobId. Omit jobId to list the 10 most recent jobs. Status is one of accepted/running/done/failed.",
            typeof(JobStatusArgs))]
        public static object GetJobStatus(string argsJson)
        {
            var args = JsonUtility.FromJson<JobStatusArgs>(argsJson);

            if (args != null && !string.IsNullOrEmpty(args.jobId))
            {
                var rec = McpJobStore.Get(args.jobId);
                if (rec == null)
                {
                    return new McpToolError { error = $"Job not found: {args.jobId}" };
                }
                return ToView(ResolveJob(rec, false));
            }

            // jobId 없으면 최근 10개 요약(각각 라이브 상태로 확정).
            var recent = McpJobStore.GetRecent(10);
            var views = new List<JobView>(recent.Count);
            foreach (var r in recent)
            {
                views.Add(ToView(ResolveJob(r, false)));
            }
            return new JobListResult { count = views.Count, jobs = views.ToArray() };
        }

        /// <summary>
        /// afterAssemblyReload 직후 호출 — 리로드를 넘긴 accepted/running 잡을 라이브 상태로 확정한다.
        /// (성공 컴파일은 리로드로 도착하므로 여기서 done 확정, 실패는 리로드가 없어 이 경로를 안 탄다.)
        /// </summary>
        internal static void ConfirmPendingAfterReload()
        {
            var all = McpJobStore.GetAll();
            foreach (var rec in all)
            {
                if (rec == null) continue;
                if (rec.status == McpJobStore.StatusDone || rec.status == McpJobStore.StatusFailed) continue;
                ResolveJob(rec, true);
            }
        }

        /// <summary>
        /// 저장 레코드 + 라이브 상태 결합 판정. 종료 상태로 확정되면 스토어에 반영한다.
        /// postReload=true 는 도메인 리로드 직후 확정 경로(대기 백스톱을 건너뛰고 즉시 판정).
        /// </summary>
        private static JobRecord ResolveJob(JobRecord rec, bool postReload)
        {
            if (rec == null) return null;

            // 이미 종료 상태면 그대로.
            if (rec.status == McpJobStore.StatusDone || rec.status == McpJobStore.StatusFailed)
                return rec;

            switch (rec.tool)
            {
                case "unity_recompile_scripts":
                    return ResolveRecompile(rec, postReload);
                case "unity_enter_play_mode":
                case "unity_exit_play_mode":
                    return ResolvePlayMode(rec);
                default:
                    return rec; // 알 수 없는 잡 — 손대지 않음.
            }
        }

        private static JobRecord ResolveRecompile(JobRecord rec, bool postReload)
        {
            // 컴파일 진행 중 → running.
            if (EditorApplication.isCompiling)
            {
                if (rec.status != McpJobStore.StatusRunning)
                    McpJobStore.Update(rec.id, McpJobStore.StatusRunning, null, null);
                return McpJobStore.Get(rec.id) ?? rec;
            }

            // 컴파일이 디스패치됐으나 아직 완료 신호가 없는 상태(시작 전 창).
            // 리로드 직후(postReload)엔 대기 집합이 비어 있으므로 곧장 판정으로 내려간다.
            if (!postReload && CompilationTools.IsRecompilePending(rec.id))
            {
                long elapsed = DateTime.UtcNow.Ticks - rec.createdTicks;
                if (elapsed < SecToTicks(RecompileNoCompileBackstopSec))
                {
                    // 아직 컴파일이 시작 안 함 — running 유지(조기 종료 판정 방지).
                    if (rec.status != McpJobStore.StatusRunning)
                        McpJobStore.Update(rec.id, McpJobStore.StatusRunning, null, null);
                    return McpJobStore.Get(rec.id) ?? rec;
                }
                // 백스톱 초과: RequestScriptCompilation 후에도 컴파일이 안 붙음(변경 없음으로 간주) → 아래에서 확정.
            }

            // 확정: 컴파일 에러 유무로 done/failed.
            //   성공(리로드) → 이 도메인의 에러 목록은 비어 있음 → done.
            //   실패(리로드 없음) → 에러 목록에 남아 있음 → failed.
            if (CompilationTools.HasCompilationErrors(out int errorCount))
            {
                McpJobStore.Update(rec.id, McpJobStore.StatusFailed, null, $"{errorCount} compilation error(s)");
            }
            else
            {
                McpJobStore.Update(rec.id, McpJobStore.StatusDone, null, null);
            }
            return McpJobStore.Get(rec.id) ?? rec;
        }

        private static JobRecord ResolvePlayMode(JobRecord rec)
        {
            bool target = rec.tool == "unity_enter_play_mode"; // true=플레이 진입 목표
            if (EditorApplication.isPlaying == target)
            {
                McpJobStore.Update(rec.id, McpJobStore.StatusDone, null, null);
                return McpJobStore.Get(rec.id) ?? rec;
            }

            long elapsed = DateTime.UtcNow.Ticks - rec.createdTicks;
            if (elapsed > SecToTicks(PlayModeTimeoutSec))
            {
                McpJobStore.Update(rec.id, McpJobStore.StatusFailed, null, "play mode transition timed out");
                return McpJobStore.Get(rec.id) ?? rec;
            }

            // 전환 진행 중.
            if (rec.status != McpJobStore.StatusRunning)
                McpJobStore.Update(rec.id, McpJobStore.StatusRunning, null, null);
            return McpJobStore.Get(rec.id) ?? rec;
        }

        private static long SecToTicks(double seconds)
        {
            return (long)(seconds * TimeSpan.TicksPerSecond);
        }

        private static JobView ToView(JobRecord rec)
        {
            if (rec == null) return null;
            long ageTicks = DateTime.UtcNow.Ticks - rec.updatedTicks;
            bool finished = rec.status == McpJobStore.StatusDone || rec.status == McpJobStore.StatusFailed;
            return new JobView
            {
                jobId = rec.id,
                tool = rec.tool,
                status = rec.status,
                error = rec.error,
                ageSeconds = (int)(ageTicks / TimeSpan.TicksPerSecond),
                done = finished
            };
        }

        #region Data Types

        [Serializable]
        public class JobStatusArgs
        {
            [McpParam("Job id returned by unity_recompile_scripts / unity_enter_play_mode / unity_exit_play_mode. Omit to list the 10 most recent jobs.")]
            public string jobId;
        }

        [Serializable]
        public class JobView
        {
            public string jobId;
            public string tool;
            public string status;   // accepted | running | done | failed
            public string error;
            public int ageSeconds;  // 마지막 상태 갱신 이후 경과(초)
            public bool done;       // status가 done 또는 failed 이면 true (폴링 종료 판단 편의)
        }

        [Serializable]
        public class JobListResult
        {
            public int count;
            public JobView[] jobs;
        }

        #endregion
    }
}
