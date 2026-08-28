# `effectByOperation` 실검증 하네스

`unity_impact_analysis` 의 `effectByOperation` 은 "이 대상을 이름 변경 / 이동 / 삭제 /
본문 변경 하면 무엇이 깨지나" 를 축별로 답한다. 그 값은 원래 **직렬화 형태에서 도출한
것**이었고 Unity 동작을 실험한 결과가 아니었다. 이 문서는 2026-08-27 에 실제로 돌린
절차와 관측 결과다. 재현하려면 그대로 따라가면 된다.

⚠️ **게임 프로젝트를 건드린다.** `C:/Unity/MainProject` 는 git 레포이므로
시작 전에 `git status` 를 찍어 두고, 끝나면 그 상태로 돌아왔는지 확인할 것.
2026-08-27 기준 실험 전에도 `M ProjectSettings/EditorBuildSettings.asset` 1건이
있었다 — 그건 이 실험과 무관한 기존 변경이다.

## 왜 워크트리 복사가 아닌가

§3 원안은 "워크트리 복사본에 변형을 적용" 이었다. 프로젝트가 약 1.2 GB 이고 두 번째
Unity 인스턴스를 띄우는 비용이 크다. 대신 **자체 픽스처를 만들어 그것만 변형**한다 —
기존 코드를 건드리지 않으므로 되돌리기가 `rm -rf` 한 번이고, git 이 증인이 된다.

## 픽스처

`Assets/_McpEffectProbe/` 에 넷을 만든다. 세 축이 동시에 걸리도록 구성한다.

| 파일 | 역할 | 걸리는 축 |
|---|---|---|
| `McpProbeTarget.cs` | `McpProbeTarget : MonoBehaviour`, `public void ProbeTargetMethod()` | 대상 |
| `McpProbeCaller.cs` | `target.ProbeTargetMethod()` 를 호출 | `codeCallers` (byCompiler) |
| `McpProbeWiring.cs` | `public UnityEvent onProbe;` | 배선을 담을 그릇 |
| `McpProbePathLoad.cs` | 상수 경로 + `AssetDatabase.LoadAssetAtPath` | `code.pathLoads` (2026-08-28 추가) |
| `McpProbeTwo.cs` | MonoBehaviour 둘(파일명과 같은 것 + 다른 것) | 다중 MonoBehaviour 파일 (2026-08-28 추가) |
| `McpProbePrefab.prefab` | 위 둘을 부착 + `onProbe` 를 `ProbeTargetMethod` 에 이름으로 배선 | `attachedAssets` (byGuid), `inspectorWirings` (byName) |

프리팹은 YAML 로 직접 쓴다. `m_Script` 의 guid 는 각 `.cs.meta` 에서 읽어 채운다
(`.meta` 는 Unity 가 만들므로 스크립트를 먼저 넣고 `unity_recompile_scripts` 로 한 번 물린다).
배선 레코드의 핵심 두 줄:

```yaml
m_TargetAssemblyTypeName: McpProbeTarget, Assembly-CSharp
m_MethodName: ProbeTargetMethod
```

기준선 확인 — 세 축이 다 잡혀야 실험이 의미가 있다:

```
byAxis: {codeCallers: 1, subclasses: 0, attachedAssets: 1, inspectorWirings: 1}
rename: { breaksSilently: [inspectorWirings], caughtByCompiler: [codeCallers], survives: [attachedTo] }
```

## 실험과 관측 결과

### E1 — 메서드 이름 변경, 호출자는 그대로 → `caughtByCompiler` 검증

`McpProbeTarget.cs` 의 메서드만 `ProbeTargetMethodRenamed` 로 바꾸고 재컴파일.

**관측**: `errorCount: 1`, `diagnosticsState: complete`, `observedAssemblyCount: 1`
```
Assets\_McpEffectProbe\McpProbeCaller.cs(10,36): error CS1061:
  'McpProbeTarget' does not contain a definition for 'ProbeTargetMethod'
```
**판정: 주장대로다.** 컴파일러가 호출자 위치를 정확히 짚는다.

부수 확인: 이 실제 진단을 `unity_explain_compile_errors` 에 먹이니
`McpProbeCaller::Start` 를 `exact` 로 귀속하고 `freshness: last-good` 을 냈다.

### E2 — 호출자까지 같이 이름 변경 → `breaksSilently` 검증

호출자도 새 이름으로 고쳐 **컴파일이 통과하게** 만든다. 프리팹 YAML 은 건드리지 않는다.

**관측**:
- 컴파일 `hasErrors: false`, `observedAssemblyCount: 2` — 성공
- Unity 콘솔: `totalReceived: 52`, 그중 Log 아닌 것 **0건**, 픽스처 언급 **0건**
- `Editor.log`: 픽스처 관련 매치 12건이 전부 **E1 의 컴파일 오류와 임포트 라인**이고,
  끊어진 배선에 대한 경고는 **0건**
- 프리팹은 여전히 `m_MethodName: ProbeTargetMethod` (존재하지 않는 메서드)
- `unity_find_callers('McpProbeTarget::ProbeTargetMethod')` → **코드 호출자 0, 배선 1건**

**판정: 주장대로다.** 컴파일러도 콘솔도 Editor.log 도 침묵한다. 배선은 죽었고
그것을 말해주는 것은 이 인덱스뿐이다.

### E3 — 클래스 이름만 변경(파일명 유지) → `survives` 검증

`class McpProbeTarget` 을 `class McpProbeTargetRenamedClass` 로 바꾼다. 파일명은
`McpProbeTarget.cs` 그대로 두어 **Unity 의 파일명=클래스명 관례를 깬다.**
프리팹의 `m_Script` guid 는 당연히 그대로다.

**예상(작성자)**: Unity 가 MonoBehaviour 를 못 찾아 Missing Script 가 된다 →
`survives` 가 너무 넓은 주장이다.

**관측**: 예상이 **틀렸다.**
- 컴파일 성공, 콘솔에 missing 언급 0건
- `unity_get_prefab_info` 가 컴포넌트를 **`McpProbeTargetRenamedClass` 로 정상 보고**
- 우리 인덱스: 부착 에셋 1건 유지, 단 `typeResolution` 이
  `filename-match` → **`unity-derived`** 로 강등

**판정: 주장대로다.** 클래스만 바꿔도 부착은 살아남는다. 그리고 우리 도구의
`typeResolution` 강등이 "이름이 더 이상 일치하지 않는다" 는 관측 가능한 신호다.

## 2026-08-28 — 남은 세 가지를 전부 돌렸다 (Unity 라이브)

픽스처를 둘 늘렸다: `McpProbePathLoad.cs`(상수 경로 + `AssetDatabase.LoadAssetAtPath` —
경로 로드 축을 걸려면 **로드 호출이 있어야 한다**. 상수만 두면 인덱스가 안 잡는다),
`McpProbeTwo.cs`(MonoBehaviour 둘 — 파일명과 같은 클래스 + 다른 클래스).

### E4 — `moveOrReimport`

`unity_move_asset` 으로 스크립트를 `Moved/` 로, 그 다음 프리팹을 `Moved/` 로 옮겼다.

**관측**
- 스크립트 이동: `newGuid` 가 이동 전과 **같다**(`0ac69ffc…`). 컴파일 성공,
  프리팹의 컴포넌트 그대로, 배선 그대로
- 프리팹 이동: GUID 동일, 컴포넌트 3개 그대로, **콘솔에 경고·오류 0건**
- 인덱스: `pathLoadEdges` 24 -> 23, `pathLoadResolved` 26 -> 25,
  **`pathLoadUnresolved` 2 -> 3**. 이동 후 그 프리팹에 영향 분석을 물으면
  `code.pathLoads` 가 **빈 배열**이다 — 경로가 안 풀리므로 엣지 자체가 사라진다

**판정: 주장대로다**(`breaksSilently: [code.pathLoads]`). 그리고 **도구가 이동 후에는
그 사실을 말하지 못하고 있었다** — 유일한 흔적이 집계 숫자 하나였다. 그래서 이 세션에
`danglingLoads`(파일 + 경로 + kind)를 인덱스에 남기고 `unity_index_status` 와
영향 분석(`assets.danglingLoadPaths`, 파일명이 같은 것만)에 실었다.
부수 발견: **이 프로젝트에 실제로 2건 있다** — `Assets/1.Scripts/Effects/Editor/EffectSystemSetup.cs`
가 `Assets/5.VFX/Common/FX_Hit_Spark.prefab` 과 `…/FX_Hit_Blunt Variant.prefab` 을 부르는데
그 폴더가 **아예 없다**(독립 확인: `find` 로 후보 0건).

### E5 — `delete`

`Moved/McpProbeTarget.cs` 와 그 `.cs.meta` 를 지웠다(백업 후).

**관측 1 — 컴파일이 깨진 동안**
- `errorCount: 1` — `McpProbeCaller.cs(6,12): error CS0246: The type or namespace name
  'McpProbeTarget' could not be found`. **오류 위치가 호출 줄이 아니라 필드 선언 줄이다**
- 그 진단을 `unity_explain_compile_errors` 에 그대로 먹이니
  `lineKind: field-declaration`, `member: {name: target, type: McpProbeTarget}`,
  `freshness.state: last-good` 로 답했다 — 이 세션에 만든 분류가 **실제 오류에서** 맞았다
- 프리팹은 이 동안 여전히 `McpProbeTarget` 을 컴포넌트로 보고한다.
  컴파일이 실패해 Unity 가 **직전 성공 어셈블리**를 들고 있기 때문이다

**관측 2 — 컴파일이 통과하게 만든 뒤**(호출자에서 참조를 뗐다)
- `get_prefab_info` 의 컴포넌트가 4개 -> **3개**. 없어진 컴포넌트에 대한
  "Missing Script" 표시도, 콘솔 경고도 **없다** — 그냥 사라진다
- `unity_find_missing_scripts` 는 그 GUID 를 잡았다(missing 14 -> 15,
  `referencingAssetCount: 1`, 그 프리팹)

**판정: 주장대로다**(`delete.breaks` 세 축). 단서를 더 적자면 — **컴파일러는
"아직 그 타입을 부르는 코드가 있을 때만" 잡는다.** 코드가 통과하면 Unity 쪽 신호는 0 이고
남는 것은 직렬화 데이터 안의 고아 GUID뿐이다.

### E6 — 파일 하나에 MonoBehaviour 가 여럿일 때의 클래스 이름 변경

`McpProbeTwo.cs` 안의 `McpProbeTwo` 를 `McpProbeTwoRenamedClass` 로 바꿨다.
이제 그 파일의 MonoBehaviour 둘 중 **어느 것도 파일명과 같지 않다.**

**관측**
- 컴파일 성공, 콘솔 경고 0건
- `get_prefab_info` 가 컴포넌트를 **`McpProbeTwoRenamedClass`** 로 보고 — 살아남았다
- 우리 도구(`unity_get_asset_components`)는 그 GUID 에
  `type: null, resolution: "no compiled type maps to this file…"` 로 답했다

**E6b — 그러면 둘 중 어느 것을 고르나.** 파일 안에서 두 클래스의 **선언 순서를 바꿨다**
(다른 변경 없음).
- `get_prefab_info` 가 이번엔 **`McpProbeTwoExtra`** 로 보고했다

**판정: Unity 는 파일에서 처음 선언된 MonoBehaviour 에 묶는다.** 즉 이름 변경뿐 아니라
**클래스 순서를 바꾸는 것만으로도 프리팹 컴포넌트가 다른 클래스로 조용히 재바인딩된다.**
직렬화된 필드 값(`first: 7`)은 따라가지 않는다. 경고는 어디에도 없다.

### 되돌린 상태

폴더째 삭제 -> 재컴파일 -> `hasErrors: false`, 게임 레포 `git status` 는 실험 전과 동일
(기존 `M ProjectSettings/EditorBuildSettings.asset` 1건뿐).
인덱스도 기준선 복귀: missing 14 / 영향 에셋 134 / 쌍 164, pathLoad 23·25·2.

### 이 세션에 알게 된 곁가지

- **이 프로젝트의 CS 경고는 0건이 아니다.** 이전 기록("Editor.log 전체에 `warning CS` 0건")은
  **컴파일이 일어나지 않은 상태**를 본 것이다. 실제로 재컴파일하면 3건이 나온다:
  `BossTeleportManager.cs(287,16) CS0618` · `ZoneBridgeGateManager.cs(261,16) CS0618` ·
  `BossBomb.cs(152,10) CS0114`
- 진단을 도구에 먹일 때 **셸에서 백슬래시 경로를 직접 쓰지 말 것.** 이스케이프가 한 겹
  줄어 `Assets\_McpEffectProbe\…` 가 깨지고 도구가 `resolution: unresolved` 를 답한다
  (도구 버그가 아니다). JSON 파일로 넘겨서 확인했다

## 덮지 못한 것 (2026-08-28 기준)

- **Resources.Load 키 축의 이동 실험** — `asset-path` 형태만 옮겨 봤다.
  `Resources/` 폴더를 옮기면 키 해석이 어떻게 되는지는 확인하지 않았다
- **씬 안의 배선**(프리팹이 아닌 `.unity`)에 대한 delete/move — 형태가 같아 보이지만
  실험은 프리팹으로만 했다

## 되돌리기

```bash
rm -rf C:/Unity/MainProject/Assets/_McpEffectProbe C:/Unity/MainProject/Assets/_McpEffectProbe.meta
# 그 다음 unity_recompile_scripts 로 한 번 물리고
cd C:/Unity/MainProject && git status --short   # 실험 전과 같아야 한다
```

2026-08-27 실행 후 확인: 컴파일 `hasErrors: false`, git 변경 1건(기존
`EditorBuildSettings.asset` 만) — 원상복구됐다.
