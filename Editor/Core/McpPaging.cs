using System;

namespace Community.Unity.MCP
{
    /// <summary>
    /// 목록 응답의 페이지네이션 공통 규약.
    ///
    /// ⚠️ 이 패키지의 실제 문제는 "응답이 무제한"이 아니었다. 대부분의 목록 도구는 이미
    /// 하드코딩 상한을 갖고 있다(unity_get_assets 30, unity_get_hierarchy 루트 50/노드 300).
    /// 문제는 **잘린 뒤를 가져올 방법이 없다**는 것이다. AI 는 500개 중 30개만 받고
    /// 나머지 470개를 영원히 볼 수 없다. 이건 컨텍스트 문제가 아니라 정답 누락 문제다.
    ///
    /// 그래서 상한을 없애는 게 아니라, 상한을 유지하면서
    ///   - 호출자가 조절할 수 있게 하고 (maxResults)
    ///   - 이어서 가져올 수 있게 한다 (offset → nextOffset)
    ///
    /// 응답 규약 (도구별 결과 타입에 아래 필드를 둔다):
    ///   totalCount    전체 개수 (필터 적용 후, 페이지 적용 전)
    ///   returnedCount 이번 응답에 담긴 개수
    ///   offset        이번 응답이 시작한 위치
    ///   nextOffset    다음 호출에 쓸 offset. 더 없으면 -1
    ///   truncated     nextOffset >= 0 과 동일. AI 가 놓치지 않도록 명시적으로 둔다
    /// </summary>
    public static class McpPaging
    {
        /// <summary>
        /// 요청된 maxResults 를 [1, hardCap] 로 클램프한다. 0/미지정이면 defaultValue.
        /// hardCap 을 두는 이유: 호출자가 int.MaxValue 를 넣어 컨텍스트를 날리는 걸 막는다.
        /// </summary>
        public static int ClampLimit(int requested, int defaultValue, int hardCap)
        {
            if (requested <= 0) return Math.Min(defaultValue, hardCap);
            return Math.Min(requested, hardCap);
        }

        /// <summary>
        /// 음수 offset 을 0 으로 정규화한다.
        /// </summary>
        public static int ClampOffset(int requested)
        {
            return requested < 0 ? 0 : requested;
        }

        /// <summary>
        /// 다음 offset. 더 가져올 게 없으면 -1.
        /// </summary>
        public static int NextOffset(int offset, int returnedCount, int totalCount)
        {
            int consumed = offset + returnedCount;
            return consumed < totalCount ? consumed : -1;
        }
    }
}
