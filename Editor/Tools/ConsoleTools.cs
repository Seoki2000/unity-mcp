using System;
using System.Collections.Generic;
using System.Reflection;
using UnityEditor;
using UnityEngine;

namespace Community.Unity.MCP
{
    /// <summary>
    /// MCP tools for accessing Unity console logs.
    /// </summary>
    [McpToolProvider]
    public class ConsoleTools
    {
        private static readonly List<LogEntry> _logBuffer = new List<LogEntry>();
        private static bool _isCapturing;
        private const int MaxLogEntries = 100;

        // ── 조용한 절단을 드러낸다 (P3-a) ────────────────────────────────
        //
        // 버퍼는 100개에서 RemoveAt(0) 으로 오래된 것을 버리는데, 지금까지 **버린 개수를
        // 아무도 세지 않았다.** 가득 차면 totalBuffered 는 늘 100 이라, 100개를 받은 것과
        // 100,000개를 받은 것이 응답에서 구별되지 않는다. 컴파일 오류를 콘솔에서 찾으려는
        // 쪽에게는 원인 로그가 사라진 사실 자체가 안 보인다.
        //
        // 도메인 리로드도 버퍼를 비우므로, 카운터도 리로드를 넘어야 뜻이 있다.
        private const string K_RECV = "mcp.console.totalReceived";
        private const string K_DROP = "mcp.console.droppedCount";
        private const string K_EPOCH = "mcp.console.captureStartedAt";

        static ConsoleTools()
        {
            Application.logMessageReceived += OnLogMessageReceived;
            _isCapturing = true;
            // 이 도메인에서 캡처가 시작된 시각. 이 이전의 로그는 이 버퍼에 없다.
            if (string.IsNullOrEmpty(SessionState.GetString(K_EPOCH, string.Empty)))
                SessionState.SetString(K_EPOCH, DateTime.UtcNow.ToString("yyyy-MM-ddTHH:mm:ssZ"));
        }

        private static void OnLogMessageReceived(string condition, string stackTrace, LogType type)
        {
            if (!_isCapturing) return;

            lock (_logBuffer)
            {
                _logBuffer.Add(new LogEntry
                {
                    message = condition,
                    stackTrace = stackTrace,
                    type = type.ToString(),
                    timestamp = DateTime.Now.ToString("HH:mm:ss.fff")
                });

                SessionState.SetInt(K_RECV, SessionState.GetInt(K_RECV, 0) + 1);

                // Keep buffer size limited
                var dropped = 0;
                while (_logBuffer.Count > MaxLogEntries)
                {
                    _logBuffer.RemoveAt(0);
                    dropped++;
                }
                if (dropped > 0)
                    SessionState.SetInt(K_DROP, SessionState.GetInt(K_DROP, 0) + dropped);
            }
        }

        [McpTool("unity_get_console_logs", "Get recent Unity console logs", typeof(GetLogsArgs), ReadOnly = true)]
        public static object GetConsoleLogs(string argsJson)
        {
            var args = JsonUtility.FromJson<GetLogsArgs>(argsJson);
            // count defaults to 0 in JsonUtility, so we need to check for <= 0
            var count = (args?.count ?? 0) <= 0 ? 50 : args.count;
            var typeFilter = args?.type;

            List<LogEntry> results;

            lock (_logBuffer)
            {
                results = new List<LogEntry>();
                
                for (int i = _logBuffer.Count - 1; i >= 0 && results.Count < count; i--)
                {
                    var entry = _logBuffer[i];
                    
                    if (string.IsNullOrEmpty(typeFilter) || 
                        entry.type.Equals(typeFilter, StringComparison.OrdinalIgnoreCase))
                    {
                        results.Add(entry);
                    }
                }
            }

            results.Reverse(); // Oldest first

            var dropped = SessionState.GetInt(K_DROP, 0);
            return new ConsoleLogsResult
            {
                totalBuffered = _logBuffer.Count,
                returnedCount = results.Count,
                logs = results.ToArray(),

                // ── 무엇을 못 보고 있는지 (P3-a) ──
                totalReceived = SessionState.GetInt(K_RECV, 0),
                droppedCount = dropped,
                bufferCapacity = MaxLogEntries,
                captureStartedAt = SessionState.GetString(K_EPOCH, string.Empty),
                note = dropped > 0
                    ? "This buffer holds only the most recent " + MaxLogEntries + " entries; " + dropped +
                      " older entry(ies) were evicted and cannot be recovered. Absence of a log here is not " +
                      "evidence it never happened. For compilation errors use unity_get_compilation_status, " +
                      "which is authoritative and carries its own completeness state."
                    : string.Empty
            };
        }

        [McpTool("unity_clear_console", "Clear the Unity console", Destructive = true)]
        public static object ClearConsole(string argsJson)
        {
            // Use reflection to access the internal Console clear method
            var logEntries = Type.GetType("UnityEditor.LogEntries, UnityEditor.dll");
            if (logEntries != null)
            {
                var clearMethod = logEntries.GetMethod("Clear", BindingFlags.Static | BindingFlags.Public);
                clearMethod?.Invoke(null, null);
            }

            lock (_logBuffer)
            {
                _logBuffer.Clear();
                // 지운 것도 사실이다. 카운터를 그대로 두면 droppedCount 가 "버려졌다" 와
                // "사용자가 지웠다" 를 섞어 말하게 된다.
                SessionState.SetInt(K_RECV, 0);
                SessionState.SetInt(K_DROP, 0);
                SessionState.SetString(K_EPOCH, DateTime.UtcNow.ToString("yyyy-MM-ddTHH:mm:ssZ"));
            }

            return new { success = true, message = "Console cleared" };
        }

        #region Data Types

        [Serializable]
        public class GetLogsArgs
        {
            [McpParam("Number of logs to return (default 50)")] public int count;
            [McpParam("Filter by type", EnumValues = new[] { "Log", "Warning", "Error" })] public string type;
        }

        [Serializable]
        public class ConsoleLogsResult
        {
            public int totalBuffered;
            public int returnedCount;
            public LogEntry[] logs;

            // ── 조용한 절단을 드러낸다 (P3-a) ──
            public int totalReceived;
            public int droppedCount;
            public int bufferCapacity;
            public string captureStartedAt;
            public string note;
        }

        [Serializable]
        public class LogEntry
        {
            public string message;
            public string stackTrace;
            public string type;
            public string timestamp;
        }

        #endregion
    }
}
