using System;

namespace Community.Unity.MCP
{
    /// <summary>
    /// JsonUtility는 익명 타입을 "{}"로 직렬화해 에러 메시지가 유실된다.
    /// 모든 도구의 에러 반환은 이 타입(또는 이를 상속한 파생 타입)을 사용해
    /// error/detail 필드가 실제로 직렬화되게 한다.
    /// </summary>
    [Serializable]
    public class McpToolError
    {
        public string error;
        public string detail;
    }
}
