using System;
using System.IO;
using System.Collections.Generic;
using UnityEditor;
using UnityEditor.Compilation;
using UnityEngine;

namespace Community.Unity.MCP
{
    /// <summary>
    /// MCP tools for accessing compilation status and errors.
    /// [OPTIMIZED] Warning 상세 정보는 반환하지 않고 개수만 반환하여 응답 크기 대폭 축소.
    /// </summary>
    [McpToolProvider]
    public class CompilationTools
    {
        private static readonly List<CompilationError> _compilationErrors = new List<CompilationError>();
        private static int _warningCount;
        private static bool _isInitialized;

        // 재컴파일이 디스패치됐지만 아직 완료 신호를 못 받은 잡 id (이 도메인에서만 유효 — 리로드 시 소멸).
        // 이 집합으로 "컴파일 시작 전 창(window)"과 "컴파일 완료"를 구분한다:
        //   성공 → 도메인 리로드로 집합 자체가 소멸 → 잡은 에러 없음으로 done 판정.
        //   실패 → 리로드 없음 → OnCompilationFinished 에서 집합 정리 → 잡은 에러 있음으로 failed 판정.
        private static readonly HashSet<string> _pendingRecompileJobs = new HashSet<string>();

        // ── 진단 완결성 (P3-a) ─────────────────────────────────────────────
        //
        // 왜 필요한가 — 실측(2026-08-27): 재컴파일을 걸고 149회 폴링하는 동안 응답이 내내
        // {isCompiling:false, hasErrors:false, errorCount:0, warningCount:0} 이었다.
        // 그런데 Editor.log 는 "2182 evaluated, 1 updated" 였다. 즉 사용자 어셈블리는
        // 하나도 컴파일되지 않았는데 응답은 "깨끗하게 컴파일됨" 과 **구별되지 않았다.**
        // 성공 경로가 도메인 리로드로 static 을 지우기 때문이다.
        //
        // 0 이 "관측했더니 없다" 인지 "관측한 적이 없다" 인지 응답이 말해야 한다.
        // 이 프로젝트가 참조·호출 축에서 없애온 것과 같은 형태의 거짓말이다.
        //
        // SessionState 를 쓰는 이유: 도메인 리로드는 넘고 **에디터 재시작에는 소멸**한다.
        // 그게 맞다 — 새로 켠 에디터는 정말로 이번 세대를 관측한 적이 없다.
        private const string K_GEN   = "mcp.compile.generation";
        private const string K_STATE = "mcp.compile.state";
        private const string K_START = "mcp.compile.startedAt";
        private const string K_END   = "mcp.compile.finishedAt";
        private const string K_ASMS  = "mcp.compile.observedAssemblies";
        private const string K_ERRS  = "mcp.compile.errorsJson";
        private const string K_WARN  = "mcp.compile.warningCount";

        private const string STATE_UNOBSERVED = "unobserved";
        private const string STATE_COLLECTING = "collecting";
        private const string STATE_COMPLETE   = "complete";

        [Serializable]
        private class ErrorEnvelope { public CompilationError[] items; }

        private static string NowIso()
        {
            return DateTime.UtcNow.ToString("yyyy-MM-ddTHH:mm:ssZ");
        }

        /// <summary>수집 결과를 리로드 너머로 남긴다. 호출부는 이미 _compilationErrors 락 안이다.</summary>
        private static void PersistDiagnostics()
        {
            var env = new ErrorEnvelope { items = _compilationErrors.ToArray() };
            SessionState.SetString(K_ERRS, JsonUtility.ToJson(env, false));
            SessionState.SetInt(K_WARN, _warningCount);
        }

        /// <summary>리로드 뒤 첫 접근에서 수집분을 되살린다.</summary>
        private static void RestoreDiagnostics()
        {
            var json = SessionState.GetString(K_ERRS, string.Empty);
            if (string.IsNullOrEmpty(json)) return;
            try
            {
                var env = JsonUtility.FromJson<ErrorEnvelope>(json);
                if (env != null && env.items != null)
                {
                    _compilationErrors.Clear();
                    _compilationErrors.AddRange(env.items);
                }
            }
            catch { /* 손상된 스냅샷은 "관측 없음" 으로 떨어진다 — 조용히 0 을 만들지 않는다 */ }
            _warningCount = SessionState.GetInt(K_WARN, 0);
        }

        /// <summary>
        /// 오류가 난 파일의 출처. 고칠 수 있는지가 여기서 갈린다.
        /// 판정이 아니라 **분류를 그대로 싣는다** — 무엇을 할지는 읽는 쪽이 정한다.
        /// </summary>
        private static string ClassifyOrigin(string file)
        {
            if (string.IsNullOrEmpty(file)) return "unknown";
            var n = file.Replace(Path.DirectorySeparatorChar, '/');
            if (n.IndexOf("/Library/PackageCache/", StringComparison.OrdinalIgnoreCase) >= 0 ||
                n.StartsWith("Library/PackageCache/", StringComparison.OrdinalIgnoreCase))
                return "packageCache";
            if (n.StartsWith("Assets/", StringComparison.OrdinalIgnoreCase) ||
                n.IndexOf("/Assets/", StringComparison.OrdinalIgnoreCase) >= 0)
                return "assets";
            if (n.StartsWith("Packages/", StringComparison.OrdinalIgnoreCase) ||
                n.IndexOf("/Packages/", StringComparison.OrdinalIgnoreCase) >= 0)
                return "embeddedPackage";
            if (Path.IsPathRooted(n)) return "localPackage";
            return "unknown";
        }

        static CompilationTools()
        {
            Initialize();
        }

        private static void Initialize()
        {
            if (_isInitialized) return;
            
            CompilationPipeline.compilationStarted += OnCompilationStarted;
            CompilationPipeline.compilationFinished += OnCompilationFinished;
            CompilationPipeline.assemblyCompilationFinished += OnAssemblyCompilationFinished;
            
            _isInitialized = true;
        }

        private static void OnCompilationStarted(object context)
        {
            lock (_compilationErrors)
            {
                _compilationErrors.Clear();
                _warningCount = 0;
                SessionState.SetInt(K_GEN, SessionState.GetInt(K_GEN, 0) + 1);
                SessionState.SetString(K_STATE, STATE_COLLECTING);
                SessionState.SetString(K_START, NowIso());
                SessionState.SetString(K_END, string.Empty);
                SessionState.SetInt(K_ASMS, 0);
                PersistDiagnostics();
            }
        }

        private static void OnCompilationFinished(object context)
        {
            // 컴파일 사이클 종료. 이 도메인에서 대기 중이던 재컴파일 잡의 "대기" 표시를 해제한다.
            // (성공 시엔 곧 도메인 리로드로 이 집합 자체가 소멸하고, 실패 시엔 리로드가 없으므로 여기서 정리.)
            // 에러 상세는 OnAssemblyCompilationFinished 에서 이미 수집됨.
            lock (_compilationErrors)
            {
                _pendingRecompileJobs.Clear();
                // 이 컴파일 세대의 관측이 끝났다. 여기서부터의 0 은 "관측했더니 없다" 이다.
                SessionState.SetString(K_STATE, STATE_COMPLETE);
                SessionState.SetString(K_END, NowIso());
                PersistDiagnostics();
            }
        }

        private static void OnAssemblyCompilationFinished(string assemblyPath, CompilerMessage[] messages)
        {
            lock (_compilationErrors)
            {
                SessionState.SetInt(K_ASMS, SessionState.GetInt(K_ASMS, 0) + 1);
                foreach (var message in messages)
                {
                    if (message.type == CompilerMessageType.Error)
                    {
                        // [OPTIMIZED] 에러만 상세 정보 저장
                        _compilationErrors.Add(new CompilationError
                        {
                            message = message.message,
                            file = message.file,
                            line = message.line,
                            origin = ClassifyOrigin(message.file)
                        });
                    }
                    else if (message.type == CompilerMessageType.Warning)
                    {
                        // [OPTIMIZED] 경고는 개수만 카운트 (상세 정보 저장 안 함)
                        _warningCount++;
                    }
                }
                PersistDiagnostics();
            }
        }

        [McpTool("unity_get_compilation_status", "Get the current compilation status and any errors", ReadOnly = true)]
        public static object GetCompilationStatus(string argsJson)
        {
            Initialize();

            List<CompilationError> errors;
            int warningCount;
            lock (_compilationErrors)
            {
                if (_compilationErrors.Count == 0) RestoreDiagnostics();
                errors = new List<CompilationError>(_compilationErrors);
                warningCount = _warningCount;
            }

            var isCompiling = EditorApplication.isCompiling;
            var state = SessionState.GetString(K_STATE, STATE_UNOBSERVED);
            // 컴파일 중이면 아직 assemblyCompilationFinished 를 안 보낸 어셈블리가 남아 있다.
            // 그 관측을 "오류 없음" 으로 굳히면 안 된다.
            if (isCompiling) state = STATE_COLLECTING;

            return new CompilationStatusResult
            {
                isCompiling = isCompiling,
                hasErrors = errors.Count > 0,
                errorCount = errors.Count,
                warningCount = warningCount,
                errors = errors.Count > 0 ? errors.ToArray() : null,
                // [OPTIMIZED] warnings 배열 완전 제거, 개수만 반환

                // ── 진단 완결성 (P3-a) ──
                diagnosticsState = state,
                compilationGeneration = SessionState.GetInt(K_GEN, 0),
                observedAssemblyCount = SessionState.GetInt(K_ASMS, 0),
                captureStartedAt = SessionState.GetString(K_START, string.Empty),
                captureFinishedAt = SessionState.GetString(K_END, string.Empty),
                note = BuildStatusNote(state, errors.Count, isCompiling, SessionState.GetInt(K_ASMS, 0))
            };
        }

        /// <summary>
        /// 0 이 무슨 뜻인지 말한다. 이 도구의 0 은 세 가지가 될 수 있고, 대응이 전부 다르다.
        /// </summary>
        private static string BuildStatusNote(string state, int errorCount, bool isCompiling, int observedAssemblies)
        {
            if (errorCount > 0) return string.Empty;
            if (isCompiling)
                return "errorCount is 0 but this compilation is still running (diagnosticsState=collecting). " +
                       "Assemblies that have not reported yet are outside this observation. Not a pass.";
            if (state == STATE_UNOBSERVED)
                return "errorCount is 0 because no compilation has been observed in this editor session " +
                       "(diagnosticsState=unobserved) - not because a compilation succeeded. Unity does not " +
                       "recompile assemblies that are already up to date, and a successful compilation reloads " +
                       "the domain, which clears this capture. Use unity_get_job_status on a recompile jobId " +
                       "for the verdict, and check compilationGeneration to see whether a capture ever started.";
            if (state == STATE_COLLECTING)
                return "errorCount is 0 but the capture for this generation never reported completion " +
                       "(diagnosticsState=collecting). Treat as unknown, not as a pass.";
            // 가장 위험한 자리다. 사이클은 완주했는데 보고한 어셈블리가 0개라는 것은
            // **아무것도 다시 컴파일되지 않았다**는 뜻이다(실측: Unity 가 최신 어셈블리는 건드리지 않는다).
            // 고친 코드가 실제로 컴파일된 적이 없는데 "오류 0" 만 보면 통과로 읽는다.
            if (observedAssemblies == 0)
                return "errorCount is 0 and this compilation cycle completed, but observedAssemblyCount is 0 - " +
                       "no assembly actually reported compiling. Unity skips assemblies that are already up to " +
                       "date, so nothing was verified by this cycle. If you are checking a source edit, confirm " +
                       "the file belongs to a compiled assembly and that the edit reached disk before recompiling.";
            return string.Empty;
        }

        // Idempotent 를 뗀다. 호출마다 새 jobId 를 만들고 도메인 리로드를 유발하므로 같은 인자로
        // 두 번 불러도 결과가 같지 않다. 브릿지는 멱등 도구를 연결 끊김 후 재전송하는데,
        // 그러면 재컴파일이 두 번 제출되고 job 폴링 대상이 어느 것인지 모호해진다.
        [McpTool("unity_recompile_scripts", "Force recompilation of all scripts. Returns immediately with a jobId; poll unity_get_job_status to await completion across the domain reload.")]
        public static object RecompileScripts(string argsJson)
        {
            if (EditorApplication.isCompiling)
            {
                return new McpToolError { error = "Compilation is already in progress" };
            }

            // 잡 생성 → 즉시 accepted 응답. 실제 부작용(Refresh + 재컴파일 요청)은 응답이 POST로 flush된
            // 다음 update 틱에서 실행한다. 그래야 도메인 리로드가 응답 flush 전에 시작돼
            // 브릿지가 연결 리셋을 겪는 일을 피할 수 있다.
            // (delayCall 금지: 미포커스 에디터에서 GUI 업데이트와 함께 무기한 기아 — 실측 2026-07-19)
            string jobId = McpJobStore.CreateJob("unity_recompile_scripts");

            // 완료 판정용 "대기 중" 표시는 디스패치 전에 등록한다 —
            // 디스패치 콜백 안에서 등록하면 그 전 폴링이 "컴파일 없음+에러 0"을 done으로 오판한다(실측).
            MarkRecompileDispatched(jobId);

            McpEditorDispatch.RunOnNextEditorUpdate(() =>
            {
                try
                {
                    McpJobStore.Update(jobId, McpJobStore.StatusRunning, null, null);

                    // Refresh 를 먼저 하는 이유: 신규 파일이 임포트되지 않은 채 RequestScriptCompilation 만 하면
                    // 새 파일이 어셈블리에 안 들어가는 갭이 있다(실측). 임포트 후 강제 재컴파일한다.
                    AssetDatabase.Refresh();
                    CompilationPipeline.RequestScriptCompilation();
                }
                catch (Exception ex)
                {
                    McpJobStore.Update(jobId, McpJobStore.StatusFailed, null, ex.Message);
                }
            });

            return new RecompileAcceptedResult
            {
                success = true,                 // 하위호환: 기존 필드 유지(요청 접수 성공).
                message = "Script recompilation requested",
                accepted = true,
                jobId = jobId,
                note = "poll unity_get_job_status"
            };
        }

        // --- JobTools(동일 어셈블리)에서 재사용하는 컴파일 상태 접근자 ------------------------------

        /// <summary>재컴파일 잡을 "대기 중"으로 표시(잡 생성 직후, 디스패치 전에 호출).</summary>
        internal static void MarkRecompileDispatched(string jobId)
        {
            if (string.IsNullOrEmpty(jobId)) return;
            lock (_compilationErrors)
            {
                _pendingRecompileJobs.Add(jobId);
            }
        }

        /// <summary>해당 재컴파일 잡이 아직 완료 신호를 못 받았는지(이 도메인 기준).</summary>
        internal static bool IsRecompilePending(string jobId)
        {
            if (string.IsNullOrEmpty(jobId)) return false;
            lock (_compilationErrors)
            {
                return _pendingRecompileJobs.Contains(jobId);
            }
        }

        /// <summary>현재 수집된 컴파일 에러 유무와 개수.</summary>
        internal static bool HasCompilationErrors(out int errorCount)
        {
            lock (_compilationErrors)
            {
                errorCount = _compilationErrors.Count;
                return errorCount > 0;
            }
        }

        [McpTool("unity_get_assemblies", "Get information about project assemblies", ReadOnly = true)]
        public static object GetAssemblies(string argsJson)
        {
            var assemblies = CompilationPipeline.GetAssemblies(AssembliesType.Player);
            var assemblyInfos = new List<AssemblyInfo>();
            
            foreach (var asm in assemblies)
            {
                assemblyInfos.Add(new AssemblyInfo
                {
                    name = asm.name,
                    sourceFileCount = asm.sourceFiles.Length
                    // [OPTIMIZED] outputPath, sourceFiles[], flags 제거
                });
            }
            
            return new GetAssembliesResult
            {
                assemblyCount = assemblyInfos.Count,
                assemblies = assemblyInfos.ToArray()
            };
        }

        #region Data Types

        [Serializable]
        public class CompilationError
        {
            // [OPTIMIZED] type, column, assemblyPath 제거
            public string message;
            public string file;
            public int line;
            // 고칠 수 있는 자리인가. assets / packageCache / embeddedPackage / localPackage / unknown
            public string origin;
        }

        [Serializable]
        public class CompilationStatusResult
        {
            public bool isCompiling;
            public bool hasErrors;
            public int errorCount;
            public int warningCount;
            public CompilationError[] errors;
            // [OPTIMIZED] warnings 배열 제거

            // ── 진단 완결성 (P3-a) — 0 이 clean 인지 unknown 인지 구분한다 ──
            public string diagnosticsState;     // unobserved | collecting | complete
            public int compilationGeneration;
            public int observedAssemblyCount;
            public string captureStartedAt;
            public string captureFinishedAt;
            public string note;
        }

        [Serializable]
        public class RecompileResult
        {
            public bool success;
            public string message;
        }

        [Serializable]
        public class RecompileAcceptedResult
        {
            // 하위호환 필드(기존 RecompileResult 형태 유지).
            public bool success;
            public string message;
            // [ADDED] 리로드 생존 폴링용 — 즉시 접수 후 지연 실행.
            public bool accepted;
            public string jobId;
            public string note;
        }

        [Serializable]
        public class AssemblyInfo
        {
            public string name;
            // [OPTIMIZED] outputPath, flags 제거
            public int sourceFileCount;
            // [OPTIMIZED] sourceFiles[] 제거
        }

        [Serializable]
        public class GetAssembliesResult
        {
            public int assemblyCount;
            public AssemblyInfo[] assemblies;
        }

        #endregion
    }

    /// <summary>
    /// 다음 EditorApplication.update 틱에 액션을 1회 실행한다.
    /// EditorApplication.delayCall 은 GUI/인스펙터 업데이트에 묶여 있어 에디터가 미포커스면
    /// 무기한 발화하지 않을 수 있다(실측 2026-07-19: 요청 펌프(update)는 도는데 delayCall 은 수 분째 미발화).
    /// update 는 미포커스에서도 틱하므로 지연 디스패치는 이것을 쓴다.
    /// 등록 시점의 update 순회에는 포함되지 않으므로(멀티캐스트 델리게이트 스냅샷) 최소 다음 틱 실행이 보장된다.
    /// </summary>
    internal static class McpEditorDispatch
    {
        internal static void RunOnNextEditorUpdate(Action action)
        {
            EditorApplication.CallbackFunction wrapper = null;
            wrapper = () =>
            {
                EditorApplication.update -= wrapper;
                try { action(); }
                catch (Exception ex) { Debug.LogError($"[MCP] Deferred editor action failed: {ex.Message}"); }
            };
            EditorApplication.update += wrapper;
        }
    }
}
