# 로컬 개발 셋업 (팀 프로젝트와 분리)

이 레포는 `github.com/Seoki2000/unity-mcp` 의 로컬 클론이다.
게임 프로젝트(`Fujino-Tatsuya/MainProject`)와 **완전히 분리**되어 있다.

```
C:\dev\unity-mcp                     ← 이 레포. MCP 작업은 여기서 한다
C:\Unity\MainProject                 ← 게임 레포. MCP 소스가 들어가지 않는다
```

## 왜 이렇게 했나

처음엔 `MainProject/Packages/com.community.unity-mcp` 에 클론했는데, MainProject 자체가 git 레포라
**게임 레포 안에 git 레포가 중첩**됐다. 그 상태로 `git add .` 하면 `.gitmodules` 없는 gitlink 가
생기거나 MCP 소스가 게임 레포에 커밋된다. 둘 다 나쁘다.

## Unity 가 이 레포를 어떻게 읽나

`MainProject/Packages/manifest.json` 의 로컬 상태:

```json
"com.community.unity-mcp": "file:../../../dev/unity-mcp"
```

UPM 의 `file:` 경로는 **`Packages` 폴더 기준 상대경로**다.
`..`→MainProject, `../..`→C:\Unity, `../../..`→C:\ → `dev/unity-mcp`

Unity 는 이 경로를 실시간으로 읽는다. 여기서 `.cs` 를 수정하면 에디터가 바로 재컴파일한다
(임베디드 패키지와 동일한 동작).

## 팀에 영향이 없는 이유 — skip-worktree

`manifest.json` 의 **커밋된 내용은 git URL 그대로**다:

```json
"com.community.unity-mcp": "https://github.com/Seoki2000/unity-mcp.git#<commit>"
```

로컬 `file:` 변경이 커밋되지 않도록 두 파일에 `skip-worktree` 를 걸어 뒀다:

```
S Packages/manifest.json
S Packages/packages-lock.json
```

그래서 `git status` 에 안 뜨고, `git add .` 로도 안 들어간다.

확인:
```bash
cd C:/Unity/MainProject && git ls-files -v Packages/ | grep "^S "
```

## ⚠️ 주의 — pull 이 막힐 때

skip-worktree 가 걸린 파일을 원격에서 누군가 수정했으면 `git pull` 이 거부된다
(팀원이 패키지를 추가/제거한 경우). 그때 절차:

```bash
cd C:/Unity/MainProject

# 1) 플래그 해제
git update-index --no-skip-worktree Packages/manifest.json Packages/packages-lock.json

# 2) 내 로컬 file: 참조를 잠시 치우고 pull
git stash push Packages/manifest.json Packages/packages-lock.json
git pull

# 3) 새 manifest 에 file: 참조만 다시 적용 (stash 를 그대로 pop 하면 팀원 변경을 덮어쓴다)
#    Packages/manifest.json 의 com.community.unity-mcp 값을
#    "file:../../../dev/unity-mcp" 로 손수 바꾼다
git stash drop        # stash 는 버린다 — 위에서 손수 반영했으므로

# 4) 플래그 재적용
git update-index --skip-worktree Packages/manifest.json Packages/packages-lock.json
```

3번에서 `git stash pop` 을 쓰지 말 것. 내 옛 manifest 로 팀원 변경을 되돌려 버린다.

## 워크플로

1. 여기서 작업 → 커밋 → `Seoki2000/unity-mcp` 에 push
2. 팀에 배포할 준비가 되면 MainProject 의 `manifest.json` **커밋된 값**의 커밋 해시를
   새 해시로 올려서 게임 레포에 커밋한다 (그때는 skip-worktree 를 잠시 해제해야 한다)
3. 내 로컬은 계속 `file:` 참조를 쓰므로 push 하지 않은 작업도 즉시 테스트된다

## 현재 브랜치

- `main` — 업스트림 계보. **McpJobStore / McpToolError 가 없다.** 쓰지 말 것
- `optimized` — 실제 작업 브랜치. 토큰 최적화 + 스레딩/리로드 안정화. 프로젝트가 핀으로 쓰던 `2ea969e`
- `security/phase0a` — 현재 작업. `optimized` 기반, 경로 탈출·CORS·인증·메뉴 게이팅·요청 크기 상한

## 오프라인 컴파일 검증

Unity 를 열지 않고 컴파일만 확인하는 방법 (Unity 의 Roslyn 사용):

```bash
U="/c/Program Files/Unity/Hub/Editor/6000.3.16f1/Editor/Data"
dotnet "$U/DotNetSdkRoslyn/csc.dll" -nologo -target:library -nostdlib+ -noconfig -langversion:9 \
  -define:UNITY_EDITOR -out:out.dll \
  @bcl.rsp @refs.rsp @srcs.rsp
```
- `bcl.rsp` — `$U/NetStandard/ref/2.1.0/netstandard.dll` + `$U/NetStandard/compat/2.1.0/shims/**/*.dll`
- `refs.rsp` — `$U/Managed/*.dll` + `$U/Managed/UnityEngine/*.dll` + Newtonsoft.Json.dll
- `srcs.rsp` — `Editor/**/*.cs` **단 `InputTools.cs` 제외** (Unity.InputSystem 은 소스 배포라 DLL 참조 불가)
- rsp 안의 경로는 공백 때문에 **반드시 인용부호로 감쌀 것**
- 끝나면 `dotnet build-server shutdown` — Roslyn 서버가 파일 핸들을 잡고 있어 디렉터리 이동이 막힌다
