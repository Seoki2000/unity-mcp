using System;
using System.IO;
using System.Net;
using System.Security.Cryptography;
using System.Text;
using UnityEngine;

namespace Community.Unity.MCP
{
    /// <summary>
    /// 로컬 세션 토큰. 브릿지만 서버를 호출할 수 있게 한다.
    ///
    /// ⚠️ 왜 필요한가 — 서버는 루프백에만 바인딩하지만, 루프백은 브라우저에서도 접근 가능하다.
    /// 인증이 없고 CORS 가 '*' 였으므로, 사용자가 아무 웹페이지를 열어 두면 그 페이지의 JS 가
    /// http://127.0.0.1:{port}/message 로 POST 해서 도구를 실행할 수 있었다.
    /// (경로 탈출까지 합치면 임의 파일 읽기/쓰기가 됐다 — McpPathGuard 참조.)
    ///
    /// 방식
    /// - 서버 시작 시 토큰을 만들어 ~/.unity-mcp/auth-token-{port}.json 에 기록한다.
    ///   브릿지가 이미 같은 디렉터리(tools-cache.json)를 쓰고 있어 배선이 단순하다.
    /// - 브릿지는 그 파일을 읽어 X-Unity-MCP-Token 헤더로 보낸다.
    /// - 브라우저는 이 파일을 읽을 수 없으므로 헤더를 만들 수 없다.
    /// - 토큰은 파일에 있으면 재사용한다. 도메인 리로드마다 회전시키면 브릿지가 매번 깨진다.
    /// </summary>
    public static class McpAuthToken
    {
        public const string HeaderName = "X-Unity-MCP-Token";

        private static string _token;
        private static int _tokenPort = -1;

        /// <summary>
        /// 현재 프로세스가 사용하는 토큰. EnsureToken 이 먼저 호출돼야 한다.
        /// </summary>
        public static string Current => _token;

        private static string TokenPath(int port)
        {
            string home = Environment.GetFolderPath(Environment.SpecialFolder.UserProfile);
            return Path.Combine(home, ".unity-mcp", $"auth-token-{port}.json");
        }

        /// <summary>
        /// 토큰을 확보한다. 기존 파일이 유효하면 재사용하고, 없으면 새로 만들어 기록한다.
        /// 파일을 쓸 수 없으면(권한 등) null 을 돌려준다 — 이 경우 호출측이 인증을 강제하면
        /// 브릿지가 접속할 방법이 없으므로, IsEnforced 로 판단해 인증을 끄고 경고를 남긴다.
        /// </summary>
        public static string EnsureToken(int port)
        {
            if (_token != null && _tokenPort == port)
            {
                return _token;
            }

            string path = TokenPath(port);

            // 기존 토큰 재사용 — 도메인 리로드로 서버가 재시작될 때마다 회전하면 브릿지가 매번 401 을 맞는다.
            try
            {
                if (File.Exists(path))
                {
                    string raw = File.ReadAllText(path);
                    string existing = ExtractToken(raw);
                    // projectRoot 가 없는 구버전 파일이면 토큰은 살리고 파일은 다시 쓴다
                    // (브릿지 인덱스가 projectRoot 를 필요로 한다).
                    bool hasProjectRoot = !string.IsNullOrEmpty(ExtractField(raw, "projectRoot"));
                    if (IsWellFormed(existing) && hasProjectRoot)
                    {
                        _token = existing;
                        _tokenPort = port;
                        return _token;
                    }
                    if (IsWellFormed(existing) && !hasProjectRoot)
                    {
                        _token = existing;
                        _tokenPort = port;
                        WriteTokenFile(path, existing, port);
                        return _token;
                    }
                }
            }
            catch (Exception ex)
            {
                Debug.LogWarning($"[MCP] Could not read existing auth token ({ex.Message}); generating a new one.");
            }

            string generated = Generate();

            try
            {
                WriteTokenFile(path, generated, port);
            }
            catch (Exception ex)
            {
                Debug.LogError($"[MCP] Failed to write auth token to '{path}': {ex.Message}. " +
                               "Authentication will be disabled for this session.");
                _token = null;
                _tokenPort = port;
                return null;
            }

            _token = generated;
            _tokenPort = port;
            return _token;
        }

        /// <summary>
        /// 서버 정지 시 토큰 파일을 지운다. 실패는 무시한다(다음 시작 때 덮어쓴다).
        /// </summary>
        public static void Clear(int port)
        {
            try
            {
                string path = TokenPath(port);
                if (File.Exists(path)) File.Delete(path);
            }
            catch { /* best-effort */ }

            _token = null;
            _tokenPort = -1;
        }

        /// <summary>
        /// 인증을 강제할 수 있는 상태인가. 토큰 파일을 못 만든 경우 false — 그때 강제하면 브릿지가 붙을 수 없다.
        /// </summary>
        public static bool IsEnforced => !string.IsNullOrEmpty(_token);

        /// <summary>
        /// 요청이 유효한 토큰을 제시했는지 검사한다.
        /// Origin 헤더가 있으면 거부한다 — 정상 브릿지(Node http 클라이언트)는 Origin 을 보내지 않고,
        /// Origin 이 붙어 있다는 건 브라우저에서 온 요청이라는 뜻이다.
        /// </summary>
        public static bool IsAuthorized(HttpListenerRequest request, out string reason)
        {
            reason = null;

            string origin = request.Headers["Origin"];
            if (!string.IsNullOrEmpty(origin))
            {
                reason = "Browser-originated requests are not accepted";
                return false;
            }

            if (!IsEnforced)
            {
                // 토큰을 만들 수 없었던 세션 — 인증 없이 통과시키되 호출측이 경고를 남긴다.
                return true;
            }

            string presented = request.Headers[HeaderName];
            if (string.IsNullOrEmpty(presented))
            {
                reason = $"Missing {HeaderName} header";
                return false;
            }

            if (!FixedTimeEquals(presented, _token))
            {
                reason = "Invalid session token";
                return false;
            }

            return true;
        }

        /// <summary>
        /// 토큰 파일을 쓴다.
        ///
        /// projectRoot 를 함께 기록한다 — 브릿지가 아웃프로세스 인덱스를 만들려면 프로젝트 루트를
        /// 알아야 하는데, file:/임베디드 패키지에서는 브릿지 스크립트 위치(__dirname)로 프로젝트를
        /// 역산할 수 없다(패키지가 프로젝트 밖에 있을 수 있다).
        /// 이 파일은 서버가 이미 쓰고 브릿지가 이미 읽으므로 추가 배선이 필요 없다.
        /// </summary>
        private static void WriteTokenFile(string path, string token, int port)
        {
            Directory.CreateDirectory(Path.GetDirectoryName(path));

            // JsonUtility 는 익명 타입을 "{}" 로 날려버리므로 직접 만든다.
            var sb = new StringBuilder();
            sb.Append("{");
            sb.Append("\"token\":").Append(Newtonsoft.Json.JsonConvert.SerializeObject(token)).Append(',');
            sb.Append("\"port\":").Append(port).Append(',');
            sb.Append("\"projectRoot\":")
              .Append(Newtonsoft.Json.JsonConvert.SerializeObject(
                  McpPathGuard.ProjectRoot.Replace('\\', '/'))).Append(',');
            sb.Append("\"createdAt\":").Append(Newtonsoft.Json.JsonConvert.SerializeObject(DateTime.UtcNow.ToString("o")));
            sb.Append("}");
            File.WriteAllText(path, sb.ToString());
        }

        /// <summary>토큰 파일에서 임의 문자열 필드를 읽는다.</summary>
        private static string ExtractField(string json, string field)
        {
            try
            {
                return Newtonsoft.Json.Linq.JObject.Parse(json)[field]?.ToString();
            }
            catch
            {
                return null;
            }
        }

        private static string Generate()
        {
            var bytes = new byte[32];
            using (var rng = RandomNumberGenerator.Create())
            {
                rng.GetBytes(bytes);
            }

            var sb = new StringBuilder(bytes.Length * 2);
            foreach (byte b in bytes) sb.Append(b.ToString("x2"));
            return sb.ToString();
        }

        private static bool IsWellFormed(string token)
        {
            if (string.IsNullOrEmpty(token) || token.Length != 64) return false;
            foreach (char c in token)
            {
                bool hex = (c >= '0' && c <= '9') || (c >= 'a' && c <= 'f');
                if (!hex) return false;
            }
            return true;
        }

        /// <summary>
        /// 길이 차이로 조기 반환하지 않는 비교. 로컬 토큰이라 타이밍 공격 현실성은 낮지만 비용이 없다.
        /// </summary>
        private static bool FixedTimeEquals(string a, string b)
        {
            if (a == null || b == null) return false;
            if (a.Length != b.Length) return false;

            int diff = 0;
            for (int i = 0; i < a.Length; i++) diff |= a[i] ^ b[i];
            return diff == 0;
        }

        /// <summary>
        /// 토큰 파일에서 token 값만 뽑는다. Newtonsoft 가 이미 패키지 의존성에 있다.
        /// </summary>
        private static string ExtractToken(string json)
        {
            try
            {
                var obj = Newtonsoft.Json.Linq.JObject.Parse(json);
                return obj["token"]?.ToString();
            }
            catch
            {
                return null;
            }
        }
    }
}
