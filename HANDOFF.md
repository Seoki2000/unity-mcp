# 작업 인수 (다음 세션용)

최종 갱신: 2026-08-24
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
→ 정확도 감사(2026-08-23~24) → **값 해석(2c, 2026-08-24)**.

**2026-08-24 세션 결론.** §3 최우선 항목이던 YAML 컴포넌트 값 해석기를 만들었다
(`unity_get_asset_components`). 만드는 과정에서 기존 레이어의 결함 4개가 더 드러났고 전부 고쳤다 —
그중 하나는 **실제로 참조되는 에셋 3건에 "참조 0" 을 답하던 것**이다(VFX Graph 가 참조를 YAML
문자열 안의 JSON 으로 쓴다). 어제와 같은 종류의 오답이 형태만 바꿔 남아 있었다.
새 도구를 만들 때마다 기존 레이어의 거짓말이 하나씩 드러난다는 것이 이 단계의 패턴이다.

그리고 **그 뒤 독립 감사(Codex CLI)를 한 번 더 돌렸다.** 결함 9개가 더 나왔고(경로 봉쇄 누락,
확장자 화이트리스트, `.meta` 참조, 자기 참조, 조용한 절단 등) 전부 재현 후 고쳤다.
"참조 0" 오답은 이번 세션에서 총 **40건** 사라졌다.

**측정 보고서: `C:/dev/unity-mcp-measurement-report-dev-0.0.1.md`** (토큰·정확도 실측, 근거 커밋 목록).
dev-0.0.2 절(§8)과 독립 감사 절(§9)이 뒤에 붙어 있다. 결론 한 줄은 그대로다: 이 작업은 토큰을 줄인 것이 아니라
**정확도를 산 것**이다(세션 고정비 약 +2,500 토큰, 손익분기는 인덱스 질의 1회/세션).

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
| 2c | (2026-08-24) | YAML 값 파서 + `unity_get_asset_components`, 캐시/목록 수정 |
| 2c-감사 | (2026-08-24) | 경로 봉쇄, 확장자 화이트리스트 폐기, `.meta` 참조, 자기참조 제외 |

### 인덱스 성능 (MainProject, Unity 6000.3.16f1) — 2026-08-24 재측정
```
레이어 A    3,300 ms   수집 0.5s / .meta 3142 0.4s / YAML 1144파일 181MB 1.7s / 기타 텍스트 0.5s
레이어 B      550 ms   DLL → 사용자 어셈블리 14 / 타입 1169 / 소스 560
호출 그래프    70 ms   메서드 7170 디코딩, 실패 0, 엣지 8673
────────────────────
전체        3,900 ms   콜드. 참조 엣지 6,244 (맨GUID 18 / .meta 122 / 기타 텍스트 83)
캐시 로드     750 ms   대부분이 지문 재계산(파일 5,794개 stat)
질의          0~1 ms   find_references
```
⚠️ 위의 옛 표(레이어 A 615 ms)는 **정션 수정 이전** 수치였다(YAML 783파일 115MB).
지금 값이 큰 이유의 대부분은 그때까지 안 보던 35% 이고, 2026-08-24 에 추가된 몫은
맨 GUID 스캔 약 1.3 초다(§4-10).

비교: 인덱스 없는 기존 역참조 질의는 **1건에 2,425 ms**, 그 동안 에디터 메인스레드 점유.

### 로컬 인덱스 도구 9개 (브릿지가 Unity 를 거치지 않고 응답)
`unity_index_status` / `unity_index_rebuild` / `unity_find_references` /
`unity_find_component_usages` / `unity_find_missing_scripts` / `unity_get_type_symbols` /
`unity_find_callers` / `unity_find_callees` / `unity_get_asset_components`
→ `tools/list` 총 82개 (Unity 73 + 로컬 9), 39,669 B

---

## 3. 다음 작업 (Phase 2c) — 우선순위 순

- [x] ~~**YAML 컴포넌트 값 해석기**~~ — 완료(2026-08-24). `Bridge/index/yamlvalues.js` +
      `unity_get_asset_components`. 값은 인덱스에 넣지 않고 **질의 시점에 그 파일 하나만**
      파싱한다(일반 프리팹 3~4 ms, 최대 17 MB 프리팹 0.7 s). 전수 검증: 에셋 1,144개
      181 MB / 문서 69,891개에 **못 읽은 줄 0**, 정규식 스캐너가 찾은 GUID 전부가 값 트리에도 있다.
      필드 검사까지 붙였다 — 이름이 바뀐 필드가 남긴 낡은 키가 751개 중 19개에서 보인다.
- [ ] **Phase 3 — 보이지 않는 엣지 인덱스** (제안서: `C:/dev/unity-mcp-phase3-plan.md`)
      지금까지 고친 것은 전부 **데이터 → 데이터** 참조다. 반대 방향(**데이터 → 코드**)은
      인덱스에 없고, 같은 형태의 오답이 코드 축에 그대로 남아 있다. 실측 재현:
      `BombAction` 은 세 도구가 모두 "아무도 안 쓴다" 고 답하지만 보스 행동트리의 노드이고,
      `GameManager.GoToResultButton` 은 호출자 0 이지만 씬 2개에 인스펙터로 배선돼 있다.
      이 프로젝트의 보이지 않는 엣지: UnityEvent 배선 **24**건 / Behavior 타입 문자열 **32**건 /
      속성 진입점 **112**건 / 경로 기반 로드 **73**건.
      UnityEvent 는 프로토타입으로 **24/24 해석**을 확인했다(기존 모듈만, 1 s).
      JetBrains Rider 가 2018.3 부터 같은 것을 인덱싱한다 — 접근이 검증돼 있다.
- [ ] **필드 타입 서명 디코딩** — 현재 필드는 이름/접근자만. Blob 서명을 디코딩하면
      값 검증과 참조 필드(`objectReference`) 해석이 가능해진다. ECMA-335 II.23.2.12.
- [ ] **오버로드 구분** — 호출 그래프 키가 `Type::Method` 라 오버로드가 합쳐진다.
      메서드 서명 디코딩이 필요하다. "이름 바꿀 수 있나"에는 현재로도 충분.
- [x] ~~**증분 갱신**~~ — 부분 완료(`da98185`). 디스크 지문을 대조해 **낡음을 감지**하고
      전체 재빌드로 넘긴다. 변경 파일만 재파싱하는 진짜 증분은 아니다 — 전체 재빌드가
      1.1 초라 그 편이 단순하고 확실해서 여기서 멈췄다. 지문 계산이 554 ms 이므로 그게
      부담되면 그때 진짜 증분으로 간다.
- [ ] **Missing Script 실제 정리** — 아래 §5. 2026-08-24 재측정: **14개 GUID / 134 에셋 /
      164 참조**. 캐시 인덱스와 PackageCache 포함 전체 재빌드 두 경로가 같은 값을 낸다.
      어제 기록한 13/133/163 과 1씩 다른 이유는 **프로젝트가 그 사이에 늘었기 때문**이다
      (README 표의 YAML 1,131 → 현재 1,144). 도구가 바뀐 게 아니다.
      새 도구로 값까지 볼 수 있게 됐으니 판단 근거가 늘었다:
      `unity_get_asset_components` 로 그 컴포넌트를 보면 `m_EditorClassIdentifier` 에
      사라진 타입의 전체 이름이 남아 있고(`VeyTrace.Rendering.Occlusion.OcclusionSection`),
      `renderers` 같은 필드값도 그대로 보존돼 있다 — 복원할지 지울지 정하는 데 쓸 것.
- [ ] **`unity_search_project` 를 인덱스 기반으로 교체** — `type=reference` 는 이 프로젝트에서
      **45초 브릿지 타임아웃에 걸린다**(`GetAllAssetPaths` 전체에 `GetDependencies` 호출).
      `unity_find_references` 가 이미 그 자리를 메우므로 중복 제거 우선순위가 올라갔다.
- [x] ~~**확장자 허용목록의 구조적 한계**~~ — 버렸다(2026-08-24). 확장자로 고르지 않고
      **내용으로** 고른다: 앞 512바이트에 NUL 이 없으면 텍스트로 보고 훑는다.
      비용은 스니핑 1,508개 357 ms + 텍스트 816개 8.7 MB (바이너리 692개 945 MB 는 안 읽는다).
      이걸로 놓치던 (출처,대상) 쌍 83건과 **"참조 0" 오답 19건**이 사라졌다 — `.shadergraph`,
      `.asmdef`, `.hlsl` 이 목록 밖이었다. `.meta` 도 출처로 넣어 18건이 더 사라졌다.
- [ ] **컴포넌트 값 파싱 결과 메모** — 지금은 질의마다 다시 파싱한다. 17 MB 프리팹을
      페이지로 훑으면 매 호출 0.7 s 를 다시 쓴다. 한 칸짜리 메모(경로+mtime+size 키)면
      충분하지만, 25,449개 문서의 파싱 트리를 상주시키는 메모리 비용을 먼저 재야 한다.
      일반 프리팹이 3~4 ms 라 아직 급하지 않아 넣지 않았다.
- [ ] **패키지 어셈블리 심볼** — 컴포넌트의 81%(5,418개 중 4,397개)가 패키지 스크립트라
      타입 이름이 `null` 이다. 지금은 "모른다" 고 정확히 말하지만, 알면 더 낫다.
      `Library/ScriptAssemblies` 의 비-사용자 어셈블리도 읽으면 되는데 인덱스가 커진다
      (타입 1,169 → 수만). 타입 이름만 얕게 담는 별도 맵이 현실적이다.
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


**(10) 값 해석기를 만들자 레이어 A 가 또 거짓말하고 있었다 (2026-08-24).**

새 파서의 결과를 기존 정규식 스캐너와 대조했더니 **양쪽이 서로 다른 것을 놓치고 있었다.**
- 파서 쪽 누락: GUID `0000000000000000e000000000000000` 을 지수표기 숫자로 읽어 **0 으로 바꿨다**.
  씬 71개에서 그랬다. 값이 사라진 게 아니라 조용히 다른 값이 되는, 더 나쁜 형태다.
- 스캐너 쪽 누락: VFX Graph 는 참조를 **YAML 문자열 안의 JSON** 으로 쓴다
  (`m_SerializableObject: '{"obj":{"fileID":…,"guid":"…"}}'`). TMP 는 `m_SourceFontFileGUID`,
  Addressables 는 `m_GUID` 로 맨 GUID 를 쓴다. `guid:\s*<hex>` 정규식은 셋 다 못 본다.
  **실제로 참조되는 에셋 3건이 "참조 0"** 이었다(자기 SDF 에셋이 쓰는 `NotoSansKR.ttf` 포함).

형태를 하나씩 추가하는 대응은 확장자 화이트리스트에서 이미 실패한 방식이다. 그래서
**32자리 hex 토큰 중 실제 `.meta` GUID 인 것**만 참조로 치는 쪽으로 갔다. 형태를 모른 채로도
맞는다. 비용은 YAML 스캔 515 ms → 1.9 s(정규식 둘을 한 스캔으로 합쳐 2.5 s 에서 줄인 값).

교훈: **대조군은 새 구현을 검증할 때만 쓰는 게 아니다.** 새 구현이 기존 구현의 오류를 드러낸다.
어제 "정확도 감사 완료" 라고 적었지만 같은 종류의 오답이 형태만 바꿔 남아 있었다.

**(11) "짧은 이름이 유일하면 그 타입이다" — 즉시 오답이 났다.**

본문이 빈 클래스(`partial class X : Y { }`)는 메서드가 없어 PDB 가 소스 파일을 안 알려준다.
그래서 파일명으로 되돌아가 찾는 폴백을 넣었는데, 전수 스윕을 돌리자마자 URP 패키지의
`Volume.cs` 가 프로젝트 안 `Ami.BroAudio.Volume` 으로 해석됐다. 인덱스 안에서만 유일했을 뿐이다.
안전장치 둘을 걸어야 했다 — (a) 스크립트가 `Assets/` 안일 것, (b) 후보 타입이 **어떤 소스
파일에도 매핑되지 않을 것**. 폴백을 넣을 때는 그 폴백이 틀릴 수 있는 경우를 먼저 세어 볼 것.
**전수 스윕이 아니었으면 못 봤다.** 단위 테스트 몇 개로는 안 나온다.

**(12) 부분 커버리지에서 `exists: false` 를 쓰면 안 된다 — §4-4 와 같은 함정을 새 도구에서 반복했다.**

`Assets`/`Packages` 만 인덱싱한 상태로 스윕을 돌렸더니 **4,667건이 "없는 스크립트"** 로 잡혔다.
실제는 270건이다(17배). PackageCache 안의 스크립트가 전부 없는 것으로 보인 것 —
`find_missing_scripts` 가 이미 겪었던 그 함정을 새 도구에서 그대로 반복했다.
`exists` 를 `true/false/null` 3상태로 바꿨다. **모를 때 false 를 내면 안 된다**는 원칙은
도구를 새로 만들 때마다 다시 적용해야 한다 — 자동으로 상속되지 않는다.

**(13) 캐시와 도구 목록이 조용히 죽어 있었다.**

`find_missing_scripts` 가 PackageCache 를 병합한 뒤 캐시를 저장할 때 지문이 `null` 로 기록됐다
(캐시에서 올린 인덱스에 `fingerprint` 를 복원하지 않아서다). 다음 세션은 그걸 "구 캐시" 로 보고
버렸다 — 답은 계속 맞았고, 매번 3.9 초를 다시 썼을 뿐이라 아무도 눈치채지 못한다.
그리고 Unity 가 꺼져 있을 때 `tools/list` 를 디스크 캐시로 답하는 경로가 **로컬 도구까지
캐시 그대로** 냈다. 이번에 추가한 도구가 목록에서 통째로 빠졌다. 로컬 도구는 Unity 없이
동작하는 것이 존재 이유인데 하필 Unity 가 없을 때 사라진다.
**"틀린 답" 만 결함이 아니다. 맞는 답을 비싸게 내거나, 있어야 할 것이 안 보이는 것도 결함이다.**


**(14) 새 도구가 Phase 0-A 에서 막은 구멍을 다시 뚫었다 (2026-08-24).**

`getAssetComponents` 는 호출자가 준 경로를 봉쇄 없이 `path.join(root, asset)` 해서 읽었다.
`../../..` 로 프로젝트 밖 `.prefab` 을 만들어 부르니 내용이 그대로 응답에 실렸다.
이 파일(`queries.js`)의 다른 질의는 전부 맵 조회라 파일을 열지 않았고, 그래서 여기엔
봉쇄가 없었다 — **파일을 여는 첫 로컬 도구**를 만들면서 그 사실을 놓쳤다.
독립 감사(Codex)도 같은 것을 찾아 PoC 를 만들었다.

교훈: 보안 조치는 레이어에 붙는 게 아니라 **동작에 붙는다.** C# 쪽에 `McpPathGuard` 가
있다는 것이 JS 쪽에서 파일을 여는 것을 막아 주지 않는다. 새 도구가 새 종류의 부작용
(파일 읽기/쓰기/네트워크)을 처음 하는 것이라면 그 부작용의 가드가 이 레이어에 있는지 본다.

**(15) 화이트리스트는 세 번째로 실패했고, 이번엔 버렸다.**

확장자 목록 6종 → 24종으로 늘려도 `.shadergraph`(텍스처를 JSON 안 GUID 로 참조)와
`.asmdef`(어셈블리를 "GUID:…" 로 참조)는 여전히 밖이었다. **에셋 19개가 "참조 0"** 이었다.
`.meta` 는 아예 출처로 보지도 않았다(FBX 임포터의 `externalObjects`) — 18개가 더 있었다.

이제 확장자로 고르지 않는다. 앞 512바이트에 NUL 이 없으면 텍스트로 보고 훑는다.
**판정이 틀리는 방향을 고른 것이 핵심이다** — 바이너리를 텍스트로 오인하면 비용만 들고,
텍스트를 놓치면 답이 틀린다. 비용이 틀리는 쪽으로 실패하게 둔다.
비용은 스니핑 357 ms + 텍스트 8.7 MB(바이너리 945 MB 는 안 읽는다).

원리적으로 남는 한 축은 **GUID 로 저장되지 않는 참조**다(`Resources.Load("path")`,
Addressables 주소, 런타임 조립 경로). 어떤 정적 인덱스도 못 본다 — 0 응답에 그렇게 적었다.

**(16) 내 측정 자체가 페이지 상한에 걸려 있었다.**

전수 스윕을 도구 호출로 돌렸는데 파일당 500개 페이지 상한에 걸려 **컴포넌트 39,921개를
안 보고** 있었다. 스크립트 컴포넌트를 5,418개로 적었지만 실제는 7,019개다.
출력에 "not examined due to cap" 을 찍어 놓고도 그 아래 숫자를 문서에 그대로 옮겼다.
Codex 의 독립 집계(7,019 / 864)가 어긋나서 알았다.

교훈: **도구로 도구를 측정하면 도구의 한계가 측정에 들어온다.** 전수 수치는 상한이 없는
경로로 재고, 재는 코드가 도구와 같은 함수를 쓰는지 확인한다(그래서 `_checkFields` 를
측정용 시임으로 내보냈다).

**(17) 조용히 잘리는 것은 계속 새 형태로 나온다.**

파서 상한(배열 200개)에 걸려 자른 사실이 응답에 없었다 — 자식 710개인 Transform 이
200개로 보였고 문서 24개가 그랬다. `ScriptableObject` 의 `m_Name` 은 통째로 버려지고 있었다
(컴포넌트의 빈 `m_Name` 만 감추려던 것인데 구분을 안 했다). 중첩 시퀀스(`- - a`)는 문자열이
됐다. 셋 다 "틀린 값" 이 아니라 **없는 값**이라 눈에 띄지 않는다.
자를 때는 자른 사실을, 못 읽을 때는 못 읽은 줄을 반드시 함께 낸다.

**(18) 캐시 버전을 안 올리면 고친 것이 안 먹는다 — 또 그럴 뻔했다.**

지문은 **디스크 상태**만 본다. 코드가 바뀐 것은 못 잡는다. 엣지 규칙을 바꾼 커밋에서
버전을 안 올렸고, 그대로 뒀으면 기존 캐시가 옛 엣지를 계속 서빙했을 것이다(5 → 6).
`CACHE_VERSION` 주석에 이미 적혀 있던 함정을 그대로 밟았다.

---

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

2026-08-24 추가: 이제 값까지 볼 수 있다. 예 —
`unity_get_asset_components { asset: "Assets/2.Prefabs/Map/LevelDeliveryV3/Stage/PF_Stage_01_V3.prefab",
component: "MonoBehaviour" }` 는 `WallSection_63` 에 붙은 그 컴포넌트의 `renderers` 배열
(MeshRenderer 참조들)이 **그대로 보존돼 있음**을 보여준다. 클래스를 복원하면 값이 살아난다는 뜻이다.

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

### 회귀 기준 (2026-08-24 감사 후 재측정)
- Missing Script: `coverage=full`, missing **14**, 영향 에셋 **134**, refs **164**, 상위 3건 합계 **132**
  (부분 커버리지에서는 missing 0 / `exists: null` 이 정상이다 — §4-12)
- 호출 그래프: `BaseAttack::TryResolveHit` → 호출자 **8개**
- IL 디코딩 실패 **0**, 엣지 **8,673**
- 참조 엣지 **6,244** = `guid:` 형태 + 맨 GUID **18** + `.meta` **122** + 기타 텍스트 **83**
  - 자기 참조 **0** (에셋이 자기 GUID 를 적어둔 것은 참조가 아니다)
  - 텍스트 일치로만 얻은 대상(`weakRefs`) **58**
- 값 파서 전수: 문서 **69,891**, 못 읽은 줄 **0**, 상한에 걸린 문서 **24**, 정규식 대조군 누락 **0**
- 전수 집계(상한 없이, 전체 커버리지): 스크립트 컴포넌트 **7,019** /
  타입 해석 **864** / 패키지라 미해석 **5,554** / Assets 안 미해석 **0** / 없는 스크립트 **601**
  - 필드 검사 864, 베이스 체인 미완 242, 낡은 키 가진 컴포넌트 **19**
  - `m_EditorClassIdentifier` 대조 **511**, 불일치 **11** (전부 클래스 이름 변경 — §4-10)
- 경로 봉쇄: 12케이스(절대/UNC/상대탈출/Assets 경유/역슬래시/접두사 유사/디렉터리 등) 전부 거부,
  프로젝트 밖 내용 유출 **0**
- `tools/list` **82개 / 39,669 B**
- `Tools/prototype/` 의 프로토타입과 수치가 일치해야 한다

⚠️ 이 수치를 다시 잴 때 **도구를 파일마다 1회 호출하는 방식으로 재지 말 것.**
`getAssetComponents` 는 파일당 500개 페이지 상한이 있어 컴포넌트 39,921개가 빠진다(§4-16).
`Bridge/index/*.js` 를 직접 require 해서 문서를 전부 도는 방식으로 잰다. 필드 검사는
`queries._checkFields`(측정용 시임)를 쓰면 도구와 같은 코드로 잴 수 있다.

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
    queries.js             질의 + 조인(resolveScriptType) + 페이지네이션 + 컴포넌트 값 조립
    yamlvalues.js          Unity YAML 값 파서 (문서 분할, 블록/플로우, 접힌 줄 이어붙이기)
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
