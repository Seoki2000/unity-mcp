# 작업 인수 (다음 세션용)

최종 갱신: 2026-08-23
브랜치: `optimized` — 정본. 지난 작업 브랜치들을 fast-forward 머지해 합치고 지웠다.
게임 프로젝트의 핀은 `9d420e6`(이 브랜치의 조상)을 가리킨다.
**`main` 이 아니다. §1 주의사항 참조**

---

## 0. 30초 요약

Unity MCP 포크를 "에디터 원격조작"에서 "프로젝트 이해"로 옮기는 작업.
Unreal Fest 의 NarshaADK 세션(강현우, 넥스트스테이지)에서 출발했다.
핵심 명제: **"문제는 AI 의 능력이 아니라 컨텍스트. 로직의 절반은 바이너리 안에 있다."**

Unity 로 번역하면 — `.cs` 는 AI 가 이미 읽는다. 못 읽는 절반은
`.prefab`/`.unity`/`.asset` 의 직렬화 데이터다. 그리고 **차별점은 둘 중 하나가 아니라
둘의 조인**이다(`m_Script.guid`).

완료: 보안 차단(0-A) → 컨텍스트 위생(1) → 아키텍처 결정(1.5) → 인덱스 3레이어 + 조인(2a/2b)
→ **정확도 감사(2026-08-23~24)**. 마지막 단계에서 인덱스가 프로젝트의 35% 를 못 보고 있었고,
참조 질의가 실제로 참조되는 에셋에 "0건" 을 답하고 있었다. 둘 다 고쳤다 — 상세는 §4.

**측정 보고서: `C:/dev/unity-mcp-measurement-report-dev-0.0.1.md`** (토큰·정확도 실측, 근거 커밋 목록).
이 세션의 결론 한 줄: 이 작업은 토큰을 줄인 것이 아니라 **정확도를 산 것**이다
(세션 고정비 약 +2,500 토큰, 손익분기는 인덱스 질의 1회/세션).

---

## 1. ⚠️ 먼저 알아야 할 함정 4개

**(1) `main` 브랜치를 쓰지 마라.**
프로젝트가 쓰던 커밋 `2ea969e` 는 `main` 의 조상이 **아니다**. 실제 작업 브랜치는
`optimized` 다. `main` 에는 `Editor/Core/McpJobStore.cs`(리로드 생존, 253줄)와
`McpToolError.cs` 가 없고 `Bridge/mcp-bridge.js` 가 269줄 적다.
`main` 기준으로 작업하면 큰 회귀가 난다.

**(2) 이 레포는 게임 프로젝트 밖에 있다.**
```
C:\dev\unity-mcp        ← 이 레포 (Seoki2000/unity-mcp)
C:\Unity\MainProject    ← 게임 레포 (Fujino-Tatsuya/MainProject, feature/Boss23)
```
게임 레포의 `Packages/manifest.json` 은 **커밋된 값은 git URL 그대로**이고,
로컬 워킹트리만 `file:../../../dev/unity-mcp` 다. `skip-worktree` 로 고정돼 있어
`git status` 에 뜨지 않는다. 자세한 내용과 pull 복구 절차는 `LOCAL_DEV_SETUP.md`.

**(3) Unity 는 `file:` 패키지 변경을 자동으로 안 문다.**
에디터가 포커스를 잃은 상태면 스크립트를 고쳐도 구 어셈블리를 계속 쓴다.
스키마에 새 파라미터가 안 보인다고 코드를 의심하기 전에:
```
unity_execute_menu { "menuPath": "Assets/Refresh" }
```
그 다음 `unity_get_compilation_status` 로 완료를 기다린다.

**(4) 오프라인 컴파일 검증 후 빌드 서버를 끄라.**
Roslyn 컴파일 서버가 파일 핸들을 잡아 디렉터리 이동이 `Device or resource busy` 로 막힌다.
```bash
dotnet build-server shutdown
```

---

## 2. 완료 상태

| Phase | 커밋 | 내용 |
|---|---|---|
| 0-A | `2bb84de` | 경로 탈출 차단, 세션 토큰, CORS 제거, 메뉴 게이팅, 요청 상한 |
| 1 | `6698ddc` | 툴 annotations, 페이지네이션, 검색 랭킹, isError, SSE 캐리버퍼 |
| 1 | `1424e30` | 리소스 페이지네이션·라인범위, TypeCache, 응답 상한, 에러코드 |
| 1.5 | `9b39f93` | 아키텍처 결정(아웃프로세스) + 프로토타입 근거 |
| 2a | `26f353f` | 레이어 A(직렬화 데이터) + 조인 + 로컬 도구 5개 |
| 2b-1 | `d374773` | 레이어 B(어셈블리 심볼 + PDB 소스 매핑), 조인 완성 |
| 2b-2 | `a8d2b68` | IL 호출 그래프, find_callers/find_callees |

### 인덱스 성능 (MainProject, Unity 6000.3.16f1)
```
레이어 A     615 ms   .meta 2039 / YAML 783파일 115.4MB / edges 4355
레이어 B     276 ms   DLL 189 → 사용자 어셈블리 14 / 타입 1189 / 소스 561
호출 그래프   56 ms   메서드 7219 디코딩, 실패 0, 엣지 8735
────────────────────
전체         947 ms   웜 시작은 디스크 캐시 파일 1개 읽기
```
비교: 인덱스 없는 기존 역참조 질의는 **1건에 2,425 ms**, 그 동안 에디터 메인스레드 점유.

### 로컬 인덱스 도구 8개 (브릿지가 Unity 를 거치지 않고 응답)
`unity_index_status` / `unity_index_rebuild` / `unity_find_references` /
`unity_find_component_usages` / `unity_find_missing_scripts` / `unity_get_type_symbols` /
`unity_find_callers` / `unity_find_callees`
→ `tools/list` 총 81개 (Unity 73 + 로컬 8)

---

## 3. 다음 작업 (Phase 2c) — 우선순위 순

- [ ] **YAML 컴포넌트 값 해석기** — §2-2 목표의 마지막 조각.
      프리팹의 컴포넌트 블록(`--- !u!114 &id` ~ 다음 구분자)을 읽어
      `m_Script.guid` → 타입명으로 바꾸고 필드값을 함께 낸다.
      지금은 조인으로 "어느 타입인지"까지 가능하고, 값 해석만 남았다.
      필드 **이름**은 이미 레이어 B 에 있어 YAML 키와 바로 맞출 수 있다.
- [ ] **필드 타입 서명 디코딩** — 현재 필드는 이름/접근자만. Blob 서명을 디코딩하면
      값 검증과 참조 필드(`objectReference`) 해석이 가능해진다. ECMA-335 II.23.2.12.
- [ ] **오버로드 구분** — 호출 그래프 키가 `Type::Method` 라 오버로드가 합쳐진다.
      메서드 서명 디코딩이 필요하다. "이름 바꿀 수 있나"에는 현재로도 충분.
- [x] ~~**증분 갱신**~~ — 부분 완료(`da98185`). 디스크 지문을 대조해 **낡음을 감지**하고
      전체 재빌드로 넘긴다. 변경 파일만 재파싱하는 진짜 증분은 아니다 — 전체 재빌드가
      1.1 초라 그 편이 단순하고 확실해서 여기서 멈췄다. 지문 계산이 554 ms 이므로 그게
      부담되면 그때 진짜 증분으로 간다.
- [ ] **Missing Script 실제 정리** — 아래 §5. 수치가 갱신됐다: **13개 GUID / 133 에셋 /
      163 참조**(정션 수정 후). 이전 "132건" 은 정션 밖만 본 수치였다.
- [ ] **`unity_search_project` 를 인덱스 기반으로 교체** — `type=reference` 는 이 프로젝트에서
      **45초 브릿지 타임아웃에 걸린다**(`GetAllAssetPaths` 전체에 `GetDependencies` 호출).
      `unity_find_references` 가 이미 그 자리를 메우므로 중복 제거 우선순위가 올라갔다.
- [ ] **확장자 허용목록의 구조적 한계** — `YAML_EXT` 를 24종으로 늘렸지만 서드파티 자산
      타입은 원리적으로 못 덮는다. 지금은 결과가 0 일 때 `scannedExtensions` 를 실어 판단만
      가능하게 했다. 근본 해결은 화이트리스트를 버리고 "텍스트로 읽히고 `guid:` 패턴이 있으면
      인덱스" 로 가는 것인데, 대용량 바이너리를 읽는 비용을 먼저 재야 한다
      (현재 `.asset` 중 3건이 바이너리다).
- [ ] **`totalReferenceCount` 이름 정정 검토** — 실제로는 (에셋, GUID) 쌍 수다. 원시 등장
      횟수로 오해된다. `affectedAssetCount` 가 맞는 이름이지만 호출부 호환을 봐야 한다.

---

## 4. 내가 작업 중 **틀렸다가 정정한 것** (다시 재현하지 말 것)

다음 세션이 같은 함정에 빠지지 않도록 남긴다.

**(1) "심볼 인덱스는 부가가치가 낮다" — 틀렸다.**
초기에 "Claude Code 가 이미 `.cs` 를 읽으니 Roslyn 인덱스는 낮은 우선순위"라고 판단했다.
Fab 페이지가 반증했다. NarshaADK 의 PDB 레이어 존재 이유가 정확히 그 반대다
("not just text matching", "call graphs with minimal false positives").
**"읽을 수 있다"와 "이해한다"는 다르다.** 실측으로 확인됐다 — `TryResolveHit` 를 grep 하면
20건 중 4건이 주석이고, 호출 그래프는 실제 호출자 8개를 준다.

**(2) "무제한 응답이 문제" — 부정확했다.**
대부분 도구엔 이미 하드코딩 상한이 있었다. 진짜 문제는 **잘린 뒤를 가져올 방법이 없다**는 것.
`unity_get_assets` 가 에셋 3144개 중 30개만 주고 나머지 3114개는 조회 불가였다.

**(3) "전수 스캔이 30초 메인스레드 캡을 넘는다" — 틀렸다.**
30,072ms 를 측정했지만 그건 도메인 리로드 중 `-32001 busy` 응답이었다. 참값은 2.4초다.
또 `maxResults` 가 작으면 조기 break 해서 빠르게 보인다(3건 요청 시 62ms).
최악 케이스를 재려면 참조가 적은 대상을 골라야 한다.

**(4) Missing Script 89건 — 79건이 오분류였다.**
Assets/Packages 만 스캔한 상태로 판정하면 패키지 스크립트가 전부 "없다"고 잡힌다.
`find_missing_scripts` 는 반드시 전체 GUID 커버리지(PackageCache 포함)를 먼저 확보해야 한다.
또 `0` 으로 시작하는 GUID(`0000000000000000e000000000000000` = UnityEditor.dll)는
Unity 내장 어셈블리로 정상이다.

**(5) 타입 해석에 base-type 만 보면 안 된다.**
`WallOcclusionMaterialBinder.cs` 가 같은 파일의 보조 struct 로 해석됐다.
정적 유틸 클래스(`base=System.Object`)는 MonoBehaviour 필터에 걸리지 않는다.
Unity 규칙인 **파일명 == 타입명**을 1순위로 써야 한다.

**(6) `08_NARSHAADK_COMPARISON.md` 의 주장은 추측이 아니었다.**
Rust 단일 바이너리, PDB 인덱스, shared daemon 전부 Fab 페이지에서 확인됐다.
내가 한동안 "검증 안 됨"으로 깎아뒀던 것이 잘못이었다.

---

**(7) 정확도 감사(2026-08-23~24)에서 드러난 것 — 이게 가장 중요하다.**

인덱스가 **프로젝트의 35% 를 못 보고 있었다.** Windows 정션은 `readdirSync` 의 Dirent 에서
`isDirectory()` 거짓 / `isSymbolicLink()` 참이라, `isDirectory` 와 `isFile` 두 분기만 보던
워커가 통째로 건너뛰었다. `Assets/50.Art` 가 그 정션이고 `.meta` 1,105개가 빠졌다.
그런데 통계는 `filesFailed: 0` 을 계속 보고했다 — **건너뛴 것은 실패로 세지 않는다.**
수치 근거를 볼 때 "실패 0" 을 커버리지의 증거로 쓰지 말 것.

그리고 `unity_find_references` 가 **실제로 참조되는 에셋에 `totalCount: 0` 을 오류도 경고도
없이 답하고 있었다.** `YAML_EXT` 가 6종뿐이라 `.vfx` 등에서만 참조되는 에셋이 인덱스에
없었다. 삭제 판단에 쓰이는 도구에서 가장 나쁜 형태의 답이다.

**(8) "Unity 자체 의존성 DB 가 더 권위 있다" — 틀렸다. 확인했다.**

0건 응답에 "권위 있는 `unity_search_project` 로 확인하라" 는 안내를 넣었다가 정정했다.
Unity 를 열어 재보니 `AssetDatabase.GetDependencies` 는 **VFX Graph 의 그래프 구조 참조를
모른다.** `recursive` 양쪽 모두 그렇다. 확장자별 전수 비교 결과 `.prefab`/`.unity`/`.mat`/
`.asset`/`.controller` 는 누락 0건이고 맹점은 VFX 계열에만 있다(프로젝트 자산 기준 18건).
즉 이 인덱스가 그 축에서는 Unity 보다 완전하다. **어느 한쪽도 완전하지 않다 —
0 은 어느 쪽에서 나와도 참조 없음의 증거가 아니다.**

**(9) 내 구현을 검증이 두 번 고쳤다. 검증 없이 넘기지 말 것.**

캐시 지문을 `(파일 수, 총 바이트, 최대 mtime)` 으로 만들었는데, 가장 새로운 파일보다
오래된 파일의 mtime 변경이 **감지되지 않았다**(최댓값이 그대로다). 파일별 (mtime, size) 를
접어 **합산**하는 방식으로 바꿨다. 그리고 상속 판정의 간접 상속을 고쳤더니 대조군에서
`MonsterSpawner` 가 여전히 `false` 였다 — 체인이 패키지 어셈블리에서 끊기는데 그걸 false 로
단정했다. **프리팹 9개에 붙어 있는데도** 그랬다. `true/false/null` 3상태로 바꿨다.

교훈: 대조군 없는 음성 결과를 믿지 말 것. 두 번 다 대조군이 문제를 드러냈다.

## 5. 부수 발견 — 실제 프로젝트 문제

`unity_find_missing_scripts` 가 찾은 것. **인덱스와 무관하게 처리 필요.**

| 참조 | 스크립트 |
|---|---|
| 108건 | `VeyTrace.Rendering.Occlusion.OcclusionSection` |
| 12건 | `VeyTrace.Rendering.Occlusion.ElevationLevel` |
| 12건 | `VeyTrace.Rendering.Occlusion.ElevationStack` |

세 클래스의 `.cs` 가 프로젝트에 없다. `VeyTrace.Rendering.Occlusion` asmdef 은 살아 있고
`WallOcclusionGlobals`/`WallOcclusionMaterialBinder`/`WallOcclusionSettings` 만 남아 있다.
오클루전 리팩터 때 프리팹 정리가 안 된 것으로 보인다.
**프리팹 125개 / 참조 132건.** 인스펙터에서 "The associated script can not be loaded" 상태.

판단 필요: 의도된 삭제면 프리팹 쪽 컴포넌트 정리, 아니면 클래스 복원.

---

## 6. 검증 방법

### 오프라인 C# 컴파일 (Unity 안 열고)
```bash
U="/c/Program Files/Unity/Hub/Editor/6000.3.16f1/Editor/Data"
dotnet "$U/DotNetSdkRoslyn/csc.dll" -nologo -target:library -nostdlib+ -noconfig -langversion:9 \
  -define:UNITY_EDITOR -out:out.dll @bcl.rsp @refs.rsp @srcs.rsp
dotnet build-server shutdown
```
- `bcl.rsp` = `$U/NetStandard/ref/2.1.0/netstandard.dll` + `$U/NetStandard/compat/2.1.0/shims/**/*.dll`
- `refs.rsp` = `$U/Managed/*.dll` + `$U/Managed/UnityEngine/*.dll` + Newtonsoft.Json.dll
- `srcs.rsp` = `Editor/**/*.cs` **단 `InputTools.cs` 제외** (Unity.InputSystem 은 소스 배포)
- rsp 안의 경로는 공백 때문에 **반드시 인용부호로 감쌀 것**

### 브릿지 인덱스 도구 단독 테스트
브릿지는 SSE 로 계속 살아있으니 백그라운드로 띄우고 kill 해야 한다.
```bash
( cat requests.txt; sleep 20 ) | node Bridge/mcp-bridge.js > out.txt 2> err.txt &
BPID=$!; sleep 25; kill $BPID
```
`requests.txt` 는 JSON-RPC 한 줄씩. `initialize` 를 먼저 보낼 것.
⚠️ `unity_index_status` 는 빌드를 강제하지 않으니 **다른 질의 뒤에** 두어야 통계가 나온다.

### 라이브 서버 직접 호출
```bash
TOK=$(python -c "import json,io;print(json.load(io.open(r'C:/Users/u5519/.unity-mcp/auth-token-3000.json',encoding='utf-8'))['token'])")
curl -s -X POST http://127.0.0.1:3000/message \
  -H "Content-Type: application/json" -H "X-Unity-MCP-Token: $TOK" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
```

### 회귀 기준
- Missing Script: `coverage=full`, missing **9**, refs **142**, 상위 3건 합계 **132**
- 호출 그래프: `BaseAttack::TryResolveHit` → 호출자 **8개**
- IL 디코딩 실패 **0**
- `Tools/prototype/` 의 프로토타입과 수치가 일치해야 한다

---

## 7. 파일 지도

```
Bridge/
  mcp-bridge.js            토큰 헤더, SSE 캐리버퍼, 로컬 도구 가로채기, tools/list 병합
  index/
    scan.js                레이어 A — .meta GUID, YAML 역참조, PackageCache 지연 병합
    symbols.js             레이어 B — TypeDef/Field/MethodDef + Portable PDB 소스 매핑
    callgraph.js           레이어 B-2 — IL 옵코드 테이블, 호출 엣지 추출
    clrmeta.js             ECMA-335 컨테이너/테이블 파서 (DLL + Portable PDB 공용)
    queries.js             질의 + 조인(resolveScriptType) + 페이지네이션
    tools.js               로컬 도구 정의/디스패치, 디스크 캐시(버전 3)
Editor/Core/
  McpPathGuard.cs          경로 포함 검사
  McpAuthToken.cs          세션 토큰 + projectRoot 기록
  McpPaging.cs             페이지네이션 규약
Tools/prototype/           Phase 1.5 측정 스크립트 (프로덕션 아님, 회귀 기준)
LOCAL_DEV_SETUP.md         레포 분리 / manifest skip-worktree / pull 복구
```

기획 문서는 게임 프로젝트 밖 별도 위치:
`C:\Users\u5519\Downloads\unity-mcp-ai-improvement-plan\`
- `11_UNREAL_FEST_FINDINGS_AND_WORKCHECK.md` — 근거·번복 기록·작업체크
- `12_PHASE1_5_INDEX_ARCHITECTURE.md` — 아키텍처 결정과 실측
- `evidence/` — 슬라이드 전사 전문, codex 소스 감사 전문
