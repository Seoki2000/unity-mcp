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

## 덮지 못한 것

- **파일 하나에 MonoBehaviour 가 여럿일 때의 클래스 이름 변경.** E3 은 단일
  MonoBehaviour 파일이었다. 여러 개면 Unity 가 어느 것을 고를지 모호해져 결과가
  달라질 수 있다 — 확인하지 않았으므로 `basis` 에 그렇게 적었다
- **`moveOrReimport`** — 파일 이동 시 `.meta` 가 따라가므로 GUID 는 유지되고 경로 상수만
  깨진다는 것이 현재 주장이다. 실험하지 않았다
- **`delete`** — 삭제는 모든 축을 깨뜨린다는 주장이다. 실험하지 않았다
  (되돌리기 비용이 크고 결과가 자명한 편이다)

## 되돌리기

```bash
rm -rf C:/Unity/MainProject/Assets/_McpEffectProbe C:/Unity/MainProject/Assets/_McpEffectProbe.meta
# 그 다음 unity_recompile_scripts 로 한 번 물리고
cd C:/Unity/MainProject && git status --short   # 실험 전과 같아야 한다
```

2026-08-27 실행 후 확인: 컴파일 `hasErrors: false`, git 변경 1건(기존
`EditorBuildSettings.asset` 만) — 원상복구됐다.
