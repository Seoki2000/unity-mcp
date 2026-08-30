# 검증 오라클 — HANDOFF 의 수치를 다른 머신에서 다시 재는 것들

여기 있는 것은 **출하 코드가 아니다.** HANDOFF.md 가 근거로 인용하는 수치를
**출하 인덱스와 다른 경로로** 다시 구하는 도구들이다.

## 왜 여기로 옮겼나

2026-08-30 독립 감사가 짚었다: HANDOFF 가 `C:/dev/codex-round3/measure.js`,
`C:/dev/codex-p3/{bcl,refs,srcs}.rsp` 같은 **어느 머신의 절대경로**를 "재는 방법" 으로
가리키고 있었다. 그 경로는 어느 레포에도 없다. 다른 사람은 문서의 수치를 **믿는 것 말고
할 수 있는 게 없었다** — 이 레포가 가장 싫어하는 상태다.

옮긴 것은 소스뿐이다. 빌드 산출물(34 MB)과 실행 결과(JSON 1.8 MB)는 `.gitignore` 로 뺐다.
경로가 박혀 있던 `.rsp` 세 개는 **파일 대신 생성기**로 바꿨다 — 남의 Unity 설치 경로가
박힌 산출물을 커밋하면 같은 함정을 다시 만드는 것이다.

## 무엇이 무엇을 재나

| 파일 | 무엇을 답하나 | HANDOFF 의 어느 수치 |
|---|---|---|
| `roslyn-oracle~/` | Roslyn 구문 트리로 "이 줄이 진짜 필드 선언인가" 의 **정답지**를 만든다 | 필드 분류 정밀도 **99.18%** / 재현율 **97.01%** (§0.5) |
| `measure.js` | 출하 인덱스의 답을 위 정답지와 대조한다 | 같은 위 수치, 거짓 양성 32 / 가려진 것 120 |
| `counterexamples.js` | 합성 반례로 경계 동작을 확인한다 | 파일명 폴백의 네임스페이스 미검증 (§0.5 "남은 한계 셋") |
| `verify-results.js` | 위 결과 JSON 을 읽어 요약한다 | — |
| `missing-evidence.json` | Missing Script 14개 GUID 의 전수 분류 근거 (`m_EditorClassIdentifier` / 보존 필드) | §5 의 A군·B군 분류표 |
| `make-offline-rsp.sh` | Unity 없이 이 패키지의 C# 만 컴파일할 응답파일을 만든다 | §0.5 "오프라인 C# 컴파일 rsp" |

⚠️ **`roslyn-oracle~` 의 `~` 는 오타가 아니다.** Unity 는 `~` 로 끝나는 폴더를 임포트하지
않는다. 그 안에 `.cs` 가 있는데 Unity 가 가져가면 `Microsoft.CodeAnalysis` 를 못 찾아
프로젝트가 컴파일 에러를 낸다.

## 쓰는 법

경로는 전부 `UNITY_MCP_PROJECT` 환경변수와 이 파일 위치에서 온다. 기본값은
`C:/Unity/MainProject` 다.

```bash
# 1) 정답지 만들기 (Roslyn)
cd Tools/verify/roslyn-oracle~
dotnet build                       # SDK 가 다르면: dotnet build -p:RoslynBinCore="<sdk>/Roslyn/bincore"
dotnet run -- <프로젝트경로> > ../roslyn-ground-truth.json

# 2) 출하 인덱스와 대조
cd ..
node measure.js                    # -> measurement-results.json
node verify-results.js

# 3) 오프라인 C# 컴파일용 응답파일
bash make-offline-rsp.sh           # 프로젝트의 ProjectVersion.txt 를 읽어 그 Unity 를 쓴다
U="/c/Program Files/Unity/Hub/Editor/6000.3.16f1/Editor/Data"
dotnet "$U/DotNetSdkRoslyn/csc.dll" -nologo -target:library -nostdlib+ -noconfig \
  -langversion:9 -define:UNITY_EDITOR -out:out.dll @bcl.rsp @refs.rsp @srcs.rsp
dotnet build-server shutdown       # Roslyn 서버가 파일 핸들을 잡는다
```

## 이 세션(2026-08-31)에 실제로 확인한 것

- `roslyn-oracle~` 은 **빌드된다**(경고 0 / 오류 0). SDK 경로를 박지 않고
  `$(NetCoreRoot)`·`$(NETCoreSdkVersion)` 로 풀게 고쳤다.
- `make-offline-rsp.sh` 가 만든 세 파일이 2026-08-27 판 원본과 **줄 수까지 같고**
  (121 / 158 / 30), 그것으로 **컴파일이 통과한다**(종료코드 0).
- ⚠️ `measure.js` / `counterexamples.js` 는 **이 세션에서 다시 돌리지 않았다.**
  절대경로만 걷어내고 구문 검사까지만 했다. 정답지 생성에 시간이 걸려서다 —
  다음에 필드 분류를 건드리면 그때 전체를 한 번 돌려 볼 것.

## 만들 때 밟은 함정 둘 (같은 것을 또 밟지 말 것)

- **"설치된 Unity 중 최신" 으로 고르면 안 된다.** 처음 생성기가 그렇게 해서 프로젝트가
  쓰는 6000.3.16f1 대신 옆에 깔린 6000.4.8f1 을 잡았다(참조 DLL 158 → 175).
  **조용히 다른 Unity 로 컴파일**하는 것이라 실패가 안 보인다. 지금은
  `ProjectSettings/ProjectVersion.txt` 를 읽고, 그 버전이 없으면 **거절**한다.
- **Git Bash 경로를 csc 에 그대로 주면 안 된다.** `/c/dev/...` 를 csc 가 `C:\c/dev/...` 로
  읽어 소스 30개가 전부 `CS2001` 로 죽었다. 생성기가 `cygpath -m` 으로 바꾼다.
