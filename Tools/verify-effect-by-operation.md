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

## 2026-08-31 — 남은 둘을 돌렸다. **`effectByOperation` 은 이제 전부 실검증됐다** (Unity 라이브)

픽스처를 셋 늘렸다: `McpProbeResLoad.cs`(상수 키 + `Resources.Load<GameObject>` — Resources
키 축), `Assets/_McpEffectProbe/Resources/McpProbeRes.prefab`, `McpProbeScene.unity`
(`McpProbeWiring` + `McpProbeTarget` 을 붙이고 `onProbe` 를 이름으로 배선한 **씬**).

씬의 배선 두 줄은 프리팹과 같다:
```yaml
m_TargetAssemblyTypeName: McpProbeTarget, Assembly-CSharp
m_MethodName: ProbeTargetMethod
```
⚠️ 씬 YAML 을 손으로 고칠 때는 **그 씬을 Unity 에서 닫고** 해야 한다. 열어 둔 채 고치면
에디터가 먼저 쓰면서 편집이 사라진다(에셋 편집과 같은 함정).

### E7 — Resources 키 축의 이동

키는 **가장 가까운 `/Resources/` 이후의 확장자 없는 경로**다. 그래서 무엇을 옮기느냐로
결과가 갈린다. 둘을 나눠 돌렸다.

**E7a — `Resources/` 폴더를 통째로 옮겼다** (`_McpEffectProbe/Resources` → `.../Moved/Resources`)

| | 이동 전 | 이동 후 |
|---|---|---|
| `pathLoadEdges` / `resolved` / `unresolved` | 25 / 27 / 2 | **25 / 27 / 2** |
| 프리팹의 `code.pathLoads` | 로더 1건 | **로더 1건 그대로** |
| 콘솔 · 컴파일러 | — | 침묵 |

**판정: 살아남는다.** 폴더째 옮기면 키가 안 바뀌므로 아무 일도 없다.
`asset-path` 형태(E4)가 **깨졌던 것과 정반대**다 — 같은 "이동" 인데 축에 따라 결과가 다르다.

**E7b — 에셋을 `Resources/` 아래 하위 폴더로 옮겼다** (`Resources/McpProbeRes` → `Resources/Sub/McpProbeRes`)

| | 이동 전 | 이동 후 |
|---|---|---|
| `pathLoadEdges` / `resolved` / `unresolved` | 25 / 27 / 2 | **24 / 26 / 3** |
| 프리팹의 `code.pathLoads` | 로더 1건 | **빈 배열** |
| `danglingLoads` | 2 | **3** |
| 콘솔 · 컴파일러 | — | **침묵** |

새로 잡힌 dangling 항목:
```json
{ "file": "Assets/_McpEffectProbe/McpProbeResLoad.cs", "path": "McpProbeRes", "kind": "resources-key" }
```

**판정: 조용히 깨진다 — 그리고 도구가 잡는다.** 키가 `McpProbeRes` → `Sub/McpProbeRes` 로
바뀌었으므로 `Resources.Load("McpProbeRes")` 는 런타임에 null 을 받는다. 컴파일러도 콘솔도
아무 말이 없다. 2026-08-28 에 넣은 `danglingLoads` 가 **Resources 키 축에도 동작한다**는
것을 여기서 확인했다(`kind: "resources-key"`).

> 실무 교훈: `Resources/` **폴더 이름과 위치는 옮겨도 안전하지만, 그 안의 구조를 바꾸면
> 키가 바뀐다.** 아트가 Resources 안을 정리하면 로드가 조용히 죽는다.

### E8 — 씬 안의 배선에 대한 move / delete

**기준선** (`McpProbeTarget::ProbeTargetMethod`)
```
inspectorWirings: ["Assets/_McpEffectProbe/McpProbeScene.unity"]
byAxis: {codeCallers: 0, subclasses: 0, attachedAssets: 1, inspectorWirings: 1}
```

**E8a — 스크립트 이동** (`McpProbeTarget.cs` → `Moved/`)
- `newGuid` 가 이동 전과 **같다**(`9e9b0992…`)
- `inspectorWirings` 그대로, `attachedAssets` 그대로, 콘솔·컴파일러 침묵

**판정: 살아남는다.** 프리팹(E4)과 같다 — **씬이라고 다르지 않다.**

**E8b — 스크립트 삭제** (호출하는 코드가 없으므로 컴파일은 통과한다)
- 컴파일 `errorCount: 0` (경고 3은 이 프로젝트의 기존 것), 콘솔 경고·에러 **0**
- 씬의 그 컴포넌트: `className: MonoBehaviour` 로 떨어지고
  **`displayName: McpProbeTarget` / `verified: false`** 로 나온다(ECID 승격, 2026-08-29)
- `unity_find_missing_scripts` 가 잡는다 — 그리고 **GUID 만이 아니라 이름으로 답한다**:
  `McpProbeTarget [script-not-in-project, compiles=false]`,
  근거 `evidenceAsset: Assets/_McpEffectProbe/McpProbeScene.unity` (2026-08-31 기능)
- ⚠️ **`inspectorWirings` 는 그대로 1 이다.** 배선 인덱스는 씬 YAML 의
  `m_TargetAssemblyTypeName` + `m_MethodName` 을 읽으므로 타입이 사라져도 레코드는 남는다.
  이건 오답이 아니라 **데이터를 정확히 말하는 것**이다 — 클래스를 되살리면 그 배선은 다시 산다.
  반면 `attachedAssets` 축은 사라진다(타입이 해석 안 되므로 답할 수 없다)

**판정: 주장대로다.** 그리고 씬은 프리팹과 **형태가 같다** — 하네스가 "형태가 같아 보이지만
실험은 프리팹으로만 했다" 고 남겨 둔 항목을 여기서 닫는다.

### 되돌린 상태 (검증됨)

`Assets/_McpEffectProbe/` 를 통째로 지우고 재컴파일한 뒤 전부 기준선으로 돌아왔다:
`referenceEdges` **6,275** · `pathLoadEdges/resolved/unresolved` **24/26/2** ·
`danglingLoads` **2** · `missingScriptCount` **4**.

⚠️ **곁가지 — 열려 있던 씬이 더럽혀졌다.** 픽스처 프리팹을 만들려고 `unity_create_gameobject`
로 씬에 오브젝트를 만들었다 지웠는데, 그 씬(`0.BootStrapScene.unity`)이 `M` 로 떴다.
내용 diff 는 **비어 있었다**(Unity 가 같은 내용으로 다시 썼다) — `git checkout --` 한 줄로
정리했다. **씬을 건드리는 도구는 그 씬을 더럽힌다.** 픽스처는 새 씬(additive)에서 만들 것.


## 덮지 못한 것

~~Resources 키 축의 이동~~ · ~~씬 안의 배선에 대한 delete/move~~ —
**둘 다 2026-08-31 에 돌렸다(위 E7·E8). 지금은 덮지 못한 것이 없다.**

다음에 이 하네스를 다시 쓴다면 안 해 본 것은 이런 것들이다(필요해지면):
- `Addressables` 축 (이 프로젝트는 그룹이 비어 있어 걸 대상이 없다)
- 어셈블리 정의(`.asmdef`) 이동·이름 변경
- 여러 씬이 additive 로 열려 있을 때의 배선

## 되돌리기

```bash
rm -rf C:/Unity/MainProject/Assets/_McpEffectProbe C:/Unity/MainProject/Assets/_McpEffectProbe.meta
# 그 다음 unity_recompile_scripts 로 한 번 물리고
cd C:/Unity/MainProject && git status --short   # 실험 전과 같아야 한다
```

2026-08-27 실행 후 확인: 컴파일 `hasErrors: false`, git 변경 1건(기존
`EditorBuildSettings.asset` 만) — 원상복구됐다.
