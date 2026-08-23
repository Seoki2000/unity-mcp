using System;
using System.IO;
using UnityEngine;

namespace Community.Unity.MCP
{
    /// <summary>
    /// 경로 포함(containment) 검사. 도구가 받은 경로 문자열이 프로젝트 밖을 가리키지 못하게 막는다.
    ///
    /// ⚠️ 왜 필요한가 — 기존 코드는 이런 형태였다:
    ///     string fullPath = Path.Combine(Application.dataPath.Replace("/Assets",""), assetPath);
    ///     File.ReadAllText(fullPath);          // 포함 검사 없음
    /// assetPath 가 "../../../../Users/me/.ssh/id_rsa" 면 그대로 읽힌다.
    /// 쓰기 쪽도 같다. path.StartsWith("Assets") 검사는 "Assets/../../evil.txt" 로 무력화된다.
    /// MCP 서버는 인증이 없고 CORS 가 열려 있었으므로(McpServer 참조) 이건 원격 임의 파일 접근이 된다.
    ///
    /// 정책
    /// - 입력은 프로젝트 루트 기준 상대 경로만 허용한다(절대 경로/드라이브 지정 거부).
    /// - 정규화(Path.GetFullPath) 후 프로젝트 루트 접두사인지 검사한다. ".." 문자열 검사에 의존하지 않는다.
    /// - 디렉터리 경계까지 확인한다("C:/Proj" 가 "C:/ProjEvil" 을 통과시키지 않도록).
    /// - 에셋 경로는 추가로 Assets/ 또는 Packages/ 하위인지 확인한다.
    /// </summary>
    public static class McpPathGuard
    {
        private static string _projectRoot;

        /// <summary>
        /// 프로젝트 루트(Assets 의 부모). 정규화되어 있고 뒤에 구분자가 없다.
        /// Application.dataPath 는 Unity API 이므로 메인 스레드에서 최초 1회 계산된다.
        /// (기존 코드의 dataPath.Replace("/Assets","") 는 경로 중간의 "/Assets" 도 지워버려 취약하다.)
        /// </summary>
        public static string ProjectRoot
        {
            get
            {
                if (string.IsNullOrEmpty(_projectRoot))
                {
                    _projectRoot = Path.GetFullPath(Path.GetDirectoryName(Application.dataPath) ?? ".")
                        .TrimEnd(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar);
                }
                return _projectRoot;
            }
        }

        /// <summary>
        /// 프로젝트 루트 기준 상대 경로를 절대 경로로 해석하고, 결과가 루트 안인지 검증한다.
        /// </summary>
        /// <param name="path">프로젝트 루트 기준 상대 경로 (예: "Assets/Scripts/A.cs")</param>
        /// <param name="fullPath">검증을 통과한 정규화된 절대 경로</param>
        /// <param name="error">실패 이유. 성공 시 null</param>
        /// <returns>프로젝트 안이면 true</returns>
        public static bool TryResolve(string path, out string fullPath, out string error)
        {
            fullPath = null;
            error = null;

            if (string.IsNullOrWhiteSpace(path))
            {
                error = "path is required";
                return false;
            }

            // 절대 경로/UNC/드라이브 지정은 애초에 받지 않는다. 상대 경로 계약을 명시적으로 강제한다.
            if (Path.IsPathRooted(path) || path.StartsWith("\\\\", StringComparison.Ordinal))
            {
                error = $"Absolute paths are not allowed: '{path}'. Use a project-relative path such as 'Assets/...'.";
                return false;
            }

            string candidate;
            try
            {
                candidate = Path.GetFullPath(Path.Combine(ProjectRoot, path));
            }
            catch (Exception ex)
            {
                // 잘못된 문자, 과도한 길이 등. 원인을 감추지 않고 그대로 알린다.
                error = $"Invalid path '{path}': {ex.Message}";
                return false;
            }

            if (!IsInsideProject(candidate))
            {
                error = $"Path escapes the project directory: '{path}'";
                return false;
            }

            fullPath = candidate;
            return true;
        }

        /// <summary>
        /// TryResolve 에 더해 Assets/ 또는 Packages/ 하위임을 요구한다.
        /// ProjectSettings/, Library/, UserSettings/ 등 프로젝트 안이지만 에셋이 아닌 영역을
        /// 에셋 도구가 건드리지 못하게 한다.
        /// </summary>
        public static bool TryResolveAssetPath(string path, out string fullPath, out string error)
        {
            if (!TryResolve(path, out fullPath, out error))
            {
                return false;
            }

            string normalized = Normalize(path);
            if (!normalized.StartsWith("Assets/", StringComparison.OrdinalIgnoreCase)
                && !normalized.Equals("Assets", StringComparison.OrdinalIgnoreCase)
                && !normalized.StartsWith("Packages/", StringComparison.OrdinalIgnoreCase)
                && !normalized.Equals("Packages", StringComparison.OrdinalIgnoreCase))
            {
                fullPath = null;
                error = $"Asset paths must be under 'Assets/' or 'Packages/': '{path}'";
                return false;
            }

            return true;
        }

        /// <summary>
        /// 이미 정규화된 절대 경로가 프로젝트 루트 안인지 확인한다.
        /// 디렉터리 경계를 함께 확인해 "C:/Proj" 가 "C:/ProjEvil" 을 통과시키지 않게 한다.
        /// </summary>
        public static bool IsInsideProject(string fullPath)
        {
            if (string.IsNullOrEmpty(fullPath)) return false;

            string root = ProjectRoot;
            var cmp = StringComparison.OrdinalIgnoreCase; // Windows/macOS 기본 파일시스템은 대소문자 구분 안 함

            if (fullPath.Equals(root, cmp)) return true;

            if (!fullPath.StartsWith(root, cmp)) return false;

            // 루트 바로 뒤가 구분자여야 한다. 아니면 접두사만 같은 다른 디렉터리다.
            char boundary = fullPath[root.Length];
            return boundary == Path.DirectorySeparatorChar || boundary == Path.AltDirectorySeparatorChar;
        }

        /// <summary>
        /// 경로 구분자를 Unity 규약(/)으로 통일하고 중복/선행 구분자를 정리한다. 검증은 하지 않는다.
        /// </summary>
        public static string Normalize(string path)
        {
            if (string.IsNullOrEmpty(path)) return path;
            return path.Replace('\\', '/').TrimStart('/');
        }
    }
}
