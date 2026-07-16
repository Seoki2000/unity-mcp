using System;
using System.Collections.Concurrent;
using System.Collections.Generic;
using System.IO;
using System.Net;
using System.Text;
using System.Threading;
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
            EditorApplication.delayCall += () =>
            {
                if (!Instance.IsRunning)
                {
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

            Port = port;
            _shutdownEvent.Reset();

            try
            {
                _listener = new HttpListener();
                _listener.Prefixes.Add($"http://localhost:{port}/");
                _listener.Start();

                _isRunning = true;
                _listenerThread = new Thread(ListenLoop) { IsBackground = true };
                _listenerThread.Start();

                Debug.Log($"[MCP] Server started on http://localhost:{port}/");
                OnServerStateChanged?.Invoke(true);
            }
            catch (Exception ex)
            {
                Debug.LogError($"[MCP] Failed to start server: {ex.Message}");
                _isRunning = false;
            }
        }

        /// <summary>
        /// Stops the MCP server and closes all connections.
        /// </summary>
        public void Stop()
        {
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
            using (var reader = new StreamReader(request.InputStream, request.ContentEncoding))
            {
                requestBody = reader.ReadToEnd();
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

                EnqueueMainThread(() =>
                {
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
                    responseBody = JsonRpcHandler.CreateErrorResponse(null, -32001,
                        "Server stopping (domain reload) - retry shortly");
                }
                else if (signaled == WaitHandle.WaitTimeout)
                {
                    responseBody = JsonRpcHandler.CreateErrorResponse(null, -32603, "Request timeout");
                }
            }

            // Send response direct in POST reply — 어떤 경우에도 응답을 닫아
            // 클라이언트가 매달리지 않게 한다.
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
