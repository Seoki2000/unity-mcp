using System;
using System.Collections.Concurrent;
using System.Collections.Generic;
using System.IO;
using System.Net;
using System.Text;
using System.Threading;
using System.Threading.Tasks;
using UnityEditor;
using UnityEngine;

namespace Community.Unity.MCP
{
    /// <summary>
    /// HTTP server that handles MCP JSON-RPC requests via HTTP POST and pushes events via SSE.
    /// Runs on a background thread and dispatches to the main thread for Unity API calls.
    /// </summary>
    [InitializeOnLoad]
    public class McpServer
    {
        private static McpServer _instance;
        private HttpListener _listener;
        private Thread _listenerThread;
        private bool _isRunning;
        private readonly Queue<Action> _mainThreadQueue = new Queue<Action>();
        private readonly ConcurrentDictionary<Guid, HttpListenerResponse> _sseClients = new ConcurrentDictionary<Guid, HttpListenerResponse>();

        // 셧다운(도메인 리로드) 시 대기 중인 요청 스레드를 즉시 깨워 에러 응답을 보내게 한다.
        private static readonly ManualResetEvent _shutdownEvent = new ManualResetEvent(false);
        // 메인 스레드 하트비트 — 컴파일/리로드로 update가 안 돌면 요청을 즉시 busy 처리.
        private static volatile int _lastMainThreadPump = Environment.TickCount;

        // Start() 실패 시 지수 백오프 재시도 상태.
        private int _startRetryCount;
        private bool _retryPending;
        private int _retryPort;
        private double _nextRetryTime;
        private bool _userStopped; // 사용자가 창에서 명시적으로 Stop — 자동 재시도 억제
        private static readonly double[] _startRetryDelaysSec = { 0.25, 0.5, 1, 2, 4, 5, 5, 5, 5, 5 };
        private const int MaxStartRetries = 10;

        /// <summary>
        /// 요청 1건의 생존 상태. 타임아웃/셧다운으로 워커가 대기를 포기하면 Abandoned를 세워
        /// 큐에 남아있던 액션이 뒤늦게 실행되며 부작용을 내는 것을 막는다.
        /// </summary>
        private sealed class PendingRequestContext
        {
            public volatile bool Abandoned;
        }

        public static McpServer Instance => _instance ??= new McpServer();

        public bool IsRunning => _isRunning;
        public int Port { get; private set; } = 3000;

        public static event Action<bool> OnServerStateChanged;

        static McpServer()
        {
            EditorApplication.update += ProcessMainThreadQueue;

            // 도메인 리로드(재컴파일)·에디터 종료 직전에 서버를 깨끗이 정지한다.
            // 안 하면 리스너 스레드가 ThreadAbortException("Thread was being aborted")으로 죽으면서
            // 진행 중이던 요청이 응답을 못 받고 클라이언트가 무한 대기에 빠진다.
            AssemblyReloadEvents.beforeAssemblyReload += StopInstance;
            EditorApplication.quitting += StopInstance;
        }

        private static void StopInstance()
        {
            try { _instance?.Stop(); } catch { }
        }

        [InitializeOnLoadMethod]
        private static void AutoStart()
        {
            if (Application.isBatchMode) return; // CI/배치 모드에서는 서버를 띄우지 않는다.

            // MPPM 가상 플레이어는 서버를 띄우지 않는다 — 메인 에디터가 MCP를 호스트한다.
            if (Application.dataPath.Replace('\\', '/').Contains("/Library/VP/"))
            {
                Debug.Log("[MCP] MPPM virtual player detected — server start skipped (main editor hosts MCP)");
                return;
            }

            EditorApplication.delayCall += () =>
            {
                if (!Instance.IsRunning)
                {
                    Instance._userStopped = false; // AutoStart 경로 — 이전 정지 플래그 해제
                    int port = EditorPrefs.GetInt("MCP_Port", 3000);
                    Instance.Start(port);
                }
            };
        }

        /// <summary>
        /// Starts the MCP server on the specified port.
        /// </summary>
        public void Start(int port = 3000)
        {
            if (_isRunning)
            {
                Debug.LogWarning("[MCP] Server is already running.");
                return;
            }

            // 대기 중이던 백오프 재시도가 있다면 이 즉시 시도로 대체한다.
            _retryPending = false;
            EditorApplication.update -= CheckStartRetry;

            Port = port;
            _shutdownEvent.Reset();

            try
            {
                _listener = new HttpListener();
                _listener.Prefixes.Add($"http://localhost:{port}/");
                _listener.Start();

                _isRunning = true;
                _startRetryCount = 0; // 성공 — 재시도 카운터 리셋
                _listenerThread = new Thread(ListenLoop) { IsBackground = true };
                _listenerThread.Start();

                Debug.Log($"[MCP] Server started on http://localhost:{port}/");
                OnServerStateChanged?.Invoke(true);
            }
            catch (Exception ex)
            {
                Debug.LogError($"[MCP] Failed to start server: {ex.Message}");
                _isRunning = false;
                ScheduleStartRetry(port);
            }
        }

        /// <summary>
        /// Start() 실패 시 지수 백오프로 재시도를 예약한다 (0.25→0.5→1→2→4→5...초, 최대 MaxStartRetries회).
        /// </summary>
        private void ScheduleStartRetry(int port)
        {
            if (_userStopped) return; // 사용자가 명시적으로 정지 — 자동 재시도 안 함
            if (_startRetryCount >= MaxStartRetries) return;

            double delay = _startRetryDelaysSec[Math.Min(_startRetryCount, _startRetryDelaysSec.Length - 1)];
            _startRetryCount++;
            _retryPort = port;
            _nextRetryTime = EditorApplication.timeSinceStartup + delay;
            _retryPending = true;

            Debug.Log($"[MCP] Start retry {_startRetryCount}/{MaxStartRetries} in {delay}s (port busy?)");

            // 도메인 리로드 후에도 재등록되도록 update 콜백으로 경과 시간을 폴링한다(중복 구독 방지를 위해 먼저 해제 후 등록).
            EditorApplication.update -= CheckStartRetry;
            EditorApplication.update += CheckStartRetry;
        }

        private void CheckStartRetry()
        {
            if (!_retryPending || _isRunning || _userStopped)
            {
                _retryPending = false;
                EditorApplication.update -= CheckStartRetry;
                return;
            }

            if (EditorApplication.timeSinceStartup >= _nextRetryTime)
            {
                _retryPending = false;
                EditorApplication.update -= CheckStartRetry;
                Start(_retryPort);
            }
        }

        /// <summary>
        /// 사용자가 McpServerWindow에서 명시적으로 정지시킬 때 호출 — 이후 자동 재시작을 막는다.
        /// </summary>
        public void StopUser()
        {
            _userStopped = true;
            Stop();
        }

        /// <summary>
        /// Stops the MCP server and closes all connections.
        /// </summary>
        public void Stop()
        {
            // 대기 중이던 백오프 재시도가 있으면 서버 실행 여부와 무관하게 취소한다.
            _retryPending = false;
            EditorApplication.update -= CheckStartRetry;

            if (!_isRunning) return;

            _isRunning = false;
            _shutdownEvent.Set(); // 대기 중인 HandleMessage들을 깨워 에러 응답 후 종료하게 함

            // Close all SSE connections
            foreach (var client in _sseClients)
            {
                try { client.Value.Close(); } catch { }
            }
            _sseClients.Clear();

            try
            {
                _listener?.Stop();
                _listener?.Close();
                _listenerThread?.Join(1000);
            }
            catch (Exception ex)
            {
                Debug.LogWarning($"[MCP] Error stopping server: {ex.Message}");
            }

            Debug.Log("[MCP] Server stopped.");
            OnServerStateChanged?.Invoke(false);
        }

        /// <summary>
        /// Sends a JSON-RPC notification/response to all connected SSE clients.
        /// </summary>
        public void SendNotification(string jsonMessage)
        {
            if (!_isRunning || _sseClients.IsEmpty) return;

            // Format as SSE data
            string sseData = $"data: {jsonMessage}\n\n";
            byte[] bytes = Encoding.UTF8.GetBytes(sseData);

            foreach (var kvp in _sseClients)
            {
                try
                {
                    kvp.Value.OutputStream.Write(bytes, 0, bytes.Length);
                    kvp.Value.OutputStream.Flush();
                }
                catch
                {
                    // If write fails, client usually disconnected
                    _sseClients.TryRemove(kvp.Key, out _);
                }
            }
        }

        private void ListenLoop()
        {
            while (_isRunning)
            {
                try
                {
                    var context = _listener.GetContext();
                    ThreadPool.QueueUserWorkItem(_ => HandleRequest(context));
                }
                catch (HttpListenerException)
                {
                    break; // 리스너 정지(Stop) 시 정상 종료
                }
                catch (ObjectDisposedException)
                {
                    break; // 리스너 Dispose됨 — 계속 호출하면 매번 던지므로 종료(무한 스핀 방지)
                }
                catch (ThreadAbortException)
                {
                    break; // 도메인 리로드 — 조용히 종료 (에러 로그 남기지 않음)
                }
                catch (Exception ex)
                {
                    if (_isRunning)
                    {
                        Debug.LogError($"[MCP] Listener error: {ex.Message}");
                    }
                    break; // 알 수 없는 오류로 무한 루프 도는 것 방지 — 종료 후 재시작에 맡김
                }
            }
        }

        private void HandleRequest(HttpListenerContext context)
        {
            var request = context.Request;
            var response = context.Response;

            // CORS headers
            response.Headers.Add("Access-Control-Allow-Origin", "*");
            response.Headers.Add("Access-Control-Allow-Methods", "POST, GET, OPTIONS");
            response.Headers.Add("Access-Control-Allow-Headers", "Content-Type");

            try
            {
                if (request.HttpMethod == "OPTIONS")
                {
                    response.StatusCode = 200;
                    response.Close();
                    return;
                }

                // Route based on path
                if (request.Url.AbsolutePath == "/sse" && request.HttpMethod == "GET")
                {
                    HandleSseConnection(context);
                }
                else if ((request.Url.AbsolutePath == "/message" || request.Url.AbsolutePath == "/") && request.HttpMethod == "POST")
                {
                    HandleMessage(context);
                }
                else
                {
                    SendError(response, 404, "Not Found");
                    response.Close();
                }
            }
            catch (Exception ex)
            {
                Debug.LogError($"[MCP] Request handling error: {ex.Message}");
                try { SendError(response, 500, "Internal Server Error"); response.Close(); } catch { }
            }
        }

        private void HandleSseConnection(HttpListenerContext context)
        {
            var response = context.Response;
            response.ContentType = "text/event-stream";
            response.Headers.Add("Cache-Control", "no-cache");
            response.Headers.Add("Connection", "keep-alive");
            response.StatusCode = 200;

            var result = Guid.NewGuid();
            _sseClients.TryAdd(result, response);

            Debug.Log($"[MCP] Client connected via SSE: {result}");

            // Send initial connection message to keep it alive or handshake?
            // Optional, but good practice to flush headers
            try
            {
                string init = ": connected\n\n";
                byte[] bytes = Encoding.UTF8.GetBytes(init);
                response.OutputStream.Write(bytes, 0, bytes.Length);
                response.OutputStream.Flush();
            }
            catch
            {
                _sseClients.TryRemove(result, out _);
                response.Close();
                return;
            }
            
            // Keep the connection open indefinitely until client disconnects or server stops
            // The ListenLoop thread actually handed this off to ThreadPool, so blocking here blocks one pool thread.
            // For a simple server this is okay. Ideally we'd use async IO but HttpListener synchronous API is simpler.
            while (_isRunning && _sseClients.ContainsKey(result))
            {
                Thread.Sleep(1000); // Check every second
            }

            try { response.Close(); } catch { }
        }

        private void HandleMessage(HttpListenerContext context)
        {
            var request = context.Request;
            var response = context.Response;

            string requestBody;
            try
            {
                // ReadToEnd()가 느리거나 불완전한 요청에서 워커를 무한정 막지 않도록 5초 상한을 둔다.
                var readTask = Task.Run(() =>
                {
                    using (var reader = new StreamReader(request.InputStream, request.ContentEncoding))
                    {
                        return reader.ReadToEnd();
                    }
                });

                if (!readTask.Wait(5000))
                {
                    WriteJsonResponse(response, JsonRpcHandler.CreateErrorResponse(null, -32600, "Request body read timeout"));
                    return;
                }

                requestBody = readTask.Result;
            }
            catch (Exception ex)
            {
                WriteJsonResponse(response, JsonRpcHandler.CreateErrorResponse(null, -32600, $"Request body read error: {ex.Message}"));
                return;
            }

            string responseBody = null;

            // 메인 스레드가 최근에 안 돌았으면(컴파일/도메인 리로드 중) 30초 기다리지 말고 즉시 busy 응답.
            if (unchecked(Environment.TickCount - _lastMainThreadPump) > 3000)
            {
                responseBody = JsonRpcHandler.CreateErrorResponse(null, -32001,
                    "Editor busy (compiling or reloading) - retry shortly");
            }
            else
            {
                var waitHandle = new ManualResetEvent(false);
                var ctx = new PendingRequestContext();

                EnqueueMainThread(() =>
                {
                    if (ctx.Abandoned)
                    {
                        // 타임아웃/셧다운으로 이미 포기된 요청 — 지금 실행하면 호출자가 모르는 부작용만 남긴다.
                        waitHandle.Set();
                        Debug.LogWarning("[MCP] Skipping abandoned request action");
                        return;
                    }

                    try
                    {
                        responseBody = JsonRpcHandler.ProcessRequest(requestBody);
                    }
                    catch (Exception ex)
                    {
                        responseBody = JsonRpcHandler.CreateErrorResponse(null, -32603, ex.Message);
                    }
                    finally
                    {
                        waitHandle.Set();
                    }
                });

                // 완료 / 셧다운(리로드) / 30초 타임아웃 중 먼저 오는 것
                int signaled = WaitHandle.WaitAny(new WaitHandle[] { waitHandle, _shutdownEvent }, 30000);
                if (signaled == 1)
                {
                    ctx.Abandoned = true; // 큐에 아직 남아있다면 나중에 실행되지 않게 표시(에러 응답 생성 전에 세운다)
                    responseBody = JsonRpcHandler.CreateErrorResponse(null, -32001,
                        "Server stopping (domain reload) - retry shortly");
                }
                else if (signaled == WaitHandle.WaitTimeout)
                {
                    ctx.Abandoned = true;
                    responseBody = JsonRpcHandler.CreateErrorResponse(null, -32603, "Request timeout");
                }
            }

            WriteJsonResponse(response, responseBody);
        }

        /// <summary>
        /// 어떤 경우에도 응답을 닫아 클라이언트가 매달리지 않게 한다.
        /// </summary>
        private void WriteJsonResponse(HttpListenerResponse response, string responseBody)
        {
            try
            {
                response.ContentType = "application/json";
                response.StatusCode = 200;
                var buffer = Encoding.UTF8.GetBytes(responseBody ?? "{}");
                response.ContentLength64 = buffer.Length;
                response.OutputStream.Write(buffer, 0, buffer.Length);
            }
            finally
            {
                try { response.Close(); } catch { }
            }
        }

        private void SendError(HttpListenerResponse response, int statusCode, string message)
        {
            response.StatusCode = statusCode;
            var buffer = Encoding.UTF8.GetBytes(message);
            response.ContentLength64 = buffer.Length;
            response.OutputStream.Write(buffer, 0, buffer.Length);
        }

        private void EnqueueMainThread(Action action)
        {
            lock (_mainThreadQueue)
            {
                _mainThreadQueue.Enqueue(action);
            }
        }

        private static void ProcessMainThreadQueue()
        {
            _lastMainThreadPump = Environment.TickCount; // 하트비트 (인스턴스 없어도 갱신)

            if (_instance == null) return;

            // 액션은 반드시 락 밖에서 실행한다.
            // 락을 쥔 채 Invoke하면 오래 걸리는(또는 재컴파일을 유발하는) 핸들러가
            // 요청 스레드의 EnqueueMainThread를 막아 서버 전체가 멈춘다.
            while (true)
            {
                Action action;
                lock (_instance._mainThreadQueue)
                {
                    if (_instance._mainThreadQueue.Count == 0) break;
                    action = _instance._mainThreadQueue.Dequeue();
                }

                try
                {
                    action?.Invoke();
                }
                catch (Exception ex)
                {
                    Debug.LogError($"[MCP] Main thread action error: {ex.Message}");
                }
            }
        }
    }
}
