#!/usr/bin/env bash
# Unity 를 열지 않고 이 패키지의 C# 만 컴파일해 보기 위한 csc 응답파일을 만든다.
#
#   bash Tools/verify/make-offline-rsp.sh [Unity Editor Data 경로] [출력 디렉터리]
#
# 기본값은 ProjectVersion.txt 없이도 서게 Unity Hub 의 표준 위치를 훑는다.
# 만들어지는 것: <출력>/bcl.rsp  <출력>/refs.rsp  <출력>/srcs.rsp
#
# 왜 생성하나 — 예전에는 이 세 파일을 어느 머신의 `C:/dev/codex-p3/` 에 만들어 두고
# HANDOFF 가 그 절대경로를 가리켰다. 다른 환경에서는 그 파일이 없고, 있더라도 남의
# Unity 설치 경로가 박혀 있어 안 돈다. **경로가 박힌 산출물 대신 생성기를 커밋한다.**
#
# 쓰는 법 (LOCAL_DEV_SETUP.md 의 "오프라인 컴파일 검증" 과 같다):
#   bash Tools/verify/make-offline-rsp.sh
#   U="/c/Program Files/Unity/Hub/Editor/6000.3.16f1/Editor/Data"
#   dotnet "$U/DotNetSdkRoslyn/csc.dll" -nologo -target:library -nostdlib+ -noconfig \
#     -langversion:9 -define:UNITY_EDITOR -out:out.dll @bcl.rsp @refs.rsp @srcs.rsp
#   dotnet build-server shutdown      # Roslyn 서버가 파일 핸들을 잡는다

set -u

PKG="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
DATA="${1:-}"
OUT="${2:-$PWD}"

if [ -z "$DATA" ]; then
  # ⚠️ "설치된 것 중 최신" 으로 고르면 안 된다. 처음에 그렇게 썼더니 프로젝트가 쓰는
  #    6000.3.16f1 대신 옆에 깔린 6000.4.8f1 을 잡았고(참조 DLL 158 -> 175),
  #    **조용히 다른 Unity 로 컴파일**할 뻔했다. 프로젝트가 요구하는 버전만 쓴다.
  PROJ="${UNITY_MCP_PROJECT:-C:/Unity/MainProject}"
  PV="$PROJ/ProjectSettings/ProjectVersion.txt"
  WANT=""
  [ -f "$PV" ] && WANT=$(sed -n 's/^m_EditorVersion: *//p' "$PV" | tr -d '\r')
  if [ -z "$WANT" ]; then
    echo "프로젝트 버전을 못 읽었다: $PV" >&2
    echo "UNITY_MCP_PROJECT 를 설정하거나 Editor Data 경로를 인자로 줄 것." >&2
    exit 2
  fi
  echo "프로젝트 요구 버전: $WANT"
  for base in "/c/Program Files/Unity/Hub/Editor" "/c/Program Files/Unity/Editor"; do
    [ -d "$base/$WANT/Editor/Data" ] && DATA="$base/$WANT/Editor/Data" && break
  done
  if [ -z "$DATA" ]; then
    echo "$WANT 이 설치돼 있지 않다. 설치된 것:" >&2
    ls -1 "/c/Program Files/Unity/Hub/Editor" 2>/dev/null | sed 's/^/  /' >&2
    echo "다른 버전으로 재려면 Editor Data 경로를 인자로 명시할 것 (의도한 것이어야 한다)." >&2
    exit 2
  fi
fi

if [ ! -d "$DATA" ]; then
  echo "Unity Editor Data 경로가 없다: $DATA" >&2
  exit 2
fi

echo "Unity Data : $DATA"
echo "패키지     : $PKG"
echo "출력       : $OUT"

# 경로에 공백이 있으므로 **반드시 인용**한다. 이걸 빼면 csc 가 조용히 다른 것을 찾는다.
#
# 그리고 **Windows 형식으로 바꾼다.** Git Bash 의 `/c/dev/...` 를 그대로 넘기면 csc 가
# `C:\c/dev/...` 로 읽어 `error CS2001: 소스 파일을 찾을 수 없습니다` 를 낸다
# (2026-08-31 에 실제로 그렇게 30개가 전부 실패했다).
w() {
  if command -v cygpath >/dev/null 2>&1; then cygpath -m "$1"; else printf '%s\n' "$1"; fi
}
q() { printf '%s"%s"\n' "$1" "$(w "$2")"; }

# 1) BCL — netstandard 참조 + 호환 shim 전부
{
  q '-r:' "$DATA/NetStandard/ref/2.1.0/netstandard.dll"
  find "$DATA/NetStandard/compat/2.1.0/shims" -name '*.dll' 2>/dev/null | sort | while read -r f; do
    q '-r:' "$f"
  done
} > "$OUT/bcl.rsp"

# 2) 참조 어셈블리 — Managed 루트와 UnityEngine 트리
{
  find "$DATA/Managed" -maxdepth 1 -name '*.dll' 2>/dev/null | sort | while read -r f; do q '-r:' "$f"; done
  find "$DATA/Managed/UnityEngine" -name '*.dll' 2>/dev/null | sort | while read -r f; do q '-r:' "$f"; done
} > "$OUT/refs.rsp"

# 3) 소스 — 이 패키지의 Editor 트리.
#    ⚠️ InputTools.cs 는 뺀다. Unity.InputSystem 은 소스 배포라 참조할 DLL 이 없다.
find "$PKG/Editor" -name '*.cs' 2>/dev/null | grep -v 'InputTools\.cs$' | sort | while read -r f; do
  printf '"%s"\n' "$(w "$f")"
done > "$OUT/srcs.rsp"

printf 'bcl.rsp  %4d 줄\nrefs.rsp %4d 줄\nsrcs.rsp %4d 줄\n' \
  "$(wc -l < "$OUT/bcl.rsp")" "$(wc -l < "$OUT/refs.rsp")" "$(wc -l < "$OUT/srcs.rsp")"

for f in bcl refs srcs; do
  [ -s "$OUT/$f.rsp" ] || { echo "$f.rsp 가 비었다 - 경로를 확인할 것" >&2; exit 1; }
done
echo "완료."
