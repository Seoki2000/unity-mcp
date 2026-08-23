using System;
using System.Collections.Generic;
using System.IO;
using System.Text;
using Newtonsoft.Json;
using Newtonsoft.Json.Linq;
using UnityEngine;

namespace Community.Unity.MCP
{
    /// <summary>
    /// Handles JSON-RPC 2.0 protocol for MCP.
    /// </summary>
    public static class JsonRpcHandler
    {
        /// <summary>
        /// Process a JSON-RPC request and return a response.
        /// </summary>
        public static string ProcessRequest(string requestJson)
        {
            JToken idToken = null;
            try
            {
                // Newtonsoft로 파싱(정규식 추출 대체). id는 JToken으로 유지해 응답에 원문 타입 그대로 에코한다.
                var root = JObject.Parse(requestJson);

                idToken = root["id"]; // 숫자/문자열/null (키 부재면 C# null)
                string method = root["method"]?.ToString();
                JToken paramsToken = root["params"];

                if (string.IsNullOrEmpty(method))
                {
                    return CreateErrorResponse(idToken, -32600, "Invalid Request: method is required");
                }

                // Route to appropriate handler
                object result;
                switch (method)
                {
                    case "initialize":
                        result = HandleInitialize(paramsToken);
                        break;
                    case "tools/list":
                        result = HandleToolsList();
                        break;
                    case "tools/call":
                        result = HandleToolsCall(paramsToken);
                        break;
                    case "resources/list":
                        // ResourceHandler는 기존대로 문자열 params를 받는다(내부에서 uri 파싱). 압축 JSON 문자열로 전달.
                        result = ResourceHandler.HandleResourcesList(paramsToken?.ToString(Formatting.None));
                        break;
                    case "resources/read":
                        // JToken 을 그대로 넘긴다 — 문자열로 되직렬화 후 정규식 재파싱하던 경로 제거.
                        result = ResourceHandler.HandleResourcesRead(paramsToken);
                        break;
                    case "ping":
                        result = new McpPingResult { pong = true };
                        break;
                    default:
                        // 알 수 없는 메서드(notifications/* 포함) — 기존과 동일하게 -32601 에러 응답.
                        // (id 없는 notification이면 id:null로 에코되며 클라이언트/브릿지가 이를 무시한다.)
                        return CreateErrorResponse(idToken, -32601, $"Method not found: {method}");
                }

                return CreateSuccessResponse(idToken, result);
            }
            catch (UnauthorizedAccessException ex)
            {
                // 경로 포함 검사(McpPathGuard) 거부. 파싱 실패가 아니므로 -32700 로 뭉개면
                // 클라이언트/AI 가 "JSON 이 깨졌다"고 오해한다. 잘못된 인자로 보고한다.
                Debug.LogWarning($"[MCP] Rejected request: {ex.Message}");
                return CreateErrorResponse(idToken, -32602, ex.Message);
            }
            catch (FileNotFoundException ex)
            {
                // 존재하지 않는 리소스 — 이것도 파싱 오류가 아니다.
                return CreateErrorResponse(idToken, -32602, ex.Message);
            }
            catch (Exception ex)
            {
                Debug.LogError($"[MCP] JSON-RPC Error: {ex.Message}");
                return CreateErrorResponse(idToken, -32700, "Parse error: " + ex.Message);
            }
        }

        private static object HandleInitialize(JToken paramsToken)
        {
            return new McpInitializeResult
            {
                protocolVersion = "2024-11-05",
                capabilities = new McpCapabilities
                {
                    tools = new McpToolsCapability { listChanged = false },
                    resources = new McpResourcesCapability { subscribe = false, listChanged = false }
                },
                serverInfo = new McpServerInfo
                {
                    name = "unity-mcp",
                    version = "1.1.0"
                }
            };
        }

        private static object HandleToolsList()
        {
            return new McpToolsListResult
            {
                tools = ToolRegistry.GetToolDefinitions()
            };
        }

        private static object HandleToolsCall(JToken paramsToken)
        {
            if (paramsToken == null || paramsToken.Type != JTokenType.Object)
            {
                throw new ArgumentException("Tool call requires parameters");
            }

            var p = (JObject)paramsToken;
            string toolName = p["name"]?.ToString();

            if (string.IsNullOrEmpty(toolName))
            {
                throw new ArgumentException("Tool name is required");
            }

            // arguments(JObject)를 압축 JSON 문자열로 도구에 전달 — argsJson 문자열 계약 불변
            // (각 도구는 이 문자열을 JsonUtility로 재파싱한다). arguments 부재 시 빈 객체.
            JToken argsToken = p["arguments"];
            string argumentsJson;
            if (argsToken == null || argsToken.Type == JTokenType.Null)
            {
                argumentsJson = "{}";
            }
            else if (argsToken.Type == JTokenType.Object)
            {
                argumentsJson = argsToken.ToString(Formatting.None);
            }
            else
            {
                // arguments가 객체가 아니면(비정상) 빈 객체로 방어.
                argumentsJson = "{}";
            }

            var result = ToolRegistry.ExecuteTool(toolName, argumentsJson);

            // 도구가 McpToolError 를 반환하면 isError 를 세운다.
            // 이전에는 항상 false 라, AI 가 응답 본문의 "error" 키를 눈으로 찾아야만 실패를 알 수 있었다.
            bool isError = result is McpToolError;

            return new McpToolResult
            {
                content = new[]
                {
                    new McpContent
                    {
                        type = "text",
                        text = JsonUtility.ToJson(result, false) // [OPTIMIZED] prettyPrint 끄기 — 모든 도구 응답 ~30% 감소
                    }
                },
                isError = isError
            };
        }

        /// <summary>
        /// 성공 응답. id는 요청 원문 타입을 보존한다(숫자→숫자, 문자열→"문자열", null/부재→null).
        /// result는 기존과 동일하게 JsonUtility로 직렬화한다(도구 결과 JSON 형태 불변 — 이미 직렬화된 문자열을 이중 인코딩하지 않음).
        /// id 파라미터는 JToken이며, McpServer의 CreateErrorResponse(null, ...) 호출은 null이 JToken으로 바인딩돼 그대로 컴파일된다.
        /// </summary>
        public static string CreateSuccessResponse(JToken id, object result)
        {
            var sb = new StringBuilder();
            sb.Append("{\"jsonrpc\":\"2.0\",");
            sb.Append("\"id\":").Append(SerializeId(id)).Append(",");
            sb.Append("\"result\":");
            sb.Append(JsonUtility.ToJson(result));
            sb.Append("}");
            return sb.ToString();
        }

        /// <summary>
        /// 에러 응답. id는 요청 원문 타입을 보존한다. message는 Newtonsoft로 안전하게 이스케이프/인용한다.
        /// </summary>
        public static string CreateErrorResponse(JToken id, int code, string message)
        {
            var sb = new StringBuilder();
            sb.Append("{\"jsonrpc\":\"2.0\",");
            sb.Append("\"id\":").Append(SerializeId(id)).Append(",");
            sb.Append("\"error\":{\"code\":").Append(code).Append(",\"message\":")
              .Append(JsonConvert.SerializeObject(message ?? string.Empty)).Append("}}");
            return sb.ToString();
        }

        /// <summary>
        /// JSON-RPC id를 원문 타입 그대로 직렬화한다. 부재/null → "null", 숫자 → 숫자, 문자열 → 인용 문자열.
        /// (Newtonsoft JValue.ToString()은 문자열을 인용부호 없이 반환하므로 JsonConvert.SerializeObject를 사용.)
        /// </summary>
        private static string SerializeId(JToken id)
        {
            if (id == null || id.Type == JTokenType.Null) return "null";
            return JsonConvert.SerializeObject(id);
        }
    }

    #region MCP Protocol Types

    [Serializable]
    public class McpInitializeResult
    {
        public string protocolVersion;
        public McpCapabilities capabilities;
        public McpServerInfo serverInfo;
    }

    [Serializable]
    public class McpCapabilities
    {
        public McpToolsCapability tools;
        public McpResourcesCapability resources;
    }

    [Serializable]
    public class McpToolsCapability
    {
        public bool listChanged;
    }

    [Serializable]
    public class McpResourcesCapability
    {
        public bool subscribe;
        public bool listChanged;
    }

    [Serializable]
    public class McpServerInfo
    {
        public string name;
        public string version;
    }

    [Serializable]
    public class McpToolsListResult
    {
        public McpToolDefinition[] tools;
    }

    [Serializable]
    public class McpToolDefinition
    {
        public string name;
        public string description;
        public McpInputSchema inputSchema;
        public McpToolAnnotations annotations;
    }

    /// <summary>
    /// MCP tool annotations. AI 가 읽기/쓰기/파괴적 도구를 구분할 근거가 된다.
    /// 이전에는 이 정보가 전혀 없어 브릿지가 도구 이름 프리픽스로 추측했다.
    /// </summary>
    [Serializable]
    public class McpToolAnnotations
    {
        public bool readOnlyHint;
        public bool destructiveHint;
        public bool idempotentHint;
    }

    /// <summary>
    /// 도구가 null 을 반환했을 때의 기본 성공 응답.
    /// 익명 타입(new { success = true })은 JsonUtility 가 "{}" 로 직렬화해 정보가 사라진다.
    /// </summary>
    [Serializable]
    public class McpToolOk
    {
        public bool success;
        public string tool;
    }

    /// <summary>
    /// ping 응답. 역시 익명 타입을 쓰면 "{}" 가 된다.
    /// </summary>
    [Serializable]
    public class McpPingResult
    {
        public bool pong;
    }

    [Serializable]
    public class McpInputSchema
    {
        public string type = "object";
        public string properties; // JSON string for flexibility
        public string[] required;
    }

    [Serializable]
    public class McpToolResult
    {
        public McpContent[] content;
        public bool isError;
    }

    [Serializable]
    public class McpContent
    {
        public string type;
        public string text;
    }

    #endregion
}
