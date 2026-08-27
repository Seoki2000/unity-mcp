# Phase 1.5 프로토타입 (측정용, 프로덕션 코드 아님)

에디터 밖에서 Unity 직렬화 데이터를 인덱싱할 수 있는지, 얼마나 걸리는지 재기 위한 스크립트다.
**Unity API 를 전혀 쓰지 않는다** — `.meta` 와 YAML 텍스트만 읽는다.

```bash
node index-prototype.js   C:/Unity/MainProject
node missing-scripts.js   C:/Unity/MainProject
```

## MainProject 실측 (2026-08-23, Unity 6000.3.16f1)

| 항목 | 값 |
|---|---|
| 파일 목록 수집 | 35 ms (.meta 2039 / YAML 783) |
| .meta GUID 인덱스 | 211 ms |
| YAML 역참조 인덱스 | 173 ms (115.4 MB) |
| **콜드 빌드 총계** | **~420 ms**, 힙 22.3 MB |
| 역참조 엣지 | 4,355 |
| 비교: 인에디터 역참조 질의 1건 | **2,425 ms** (메인스레드 점유) |

`Library/PackageCache` 를 스캔 범위에 넣으면 211 ms → **9,614 ms** (45배). 지연 인덱싱 필수.

## 이 프로토타입이 찾아낸 실제 버그

`m_Script.guid` ↔ `.meta` 조인으로 Missing Script 132건 발견:

- `VeyTrace.Rendering.Occlusion.OcclusionSection` — 108 참조
- `VeyTrace.Rendering.Occlusion.ElevationLevel` — 12 참조
- `VeyTrace.Rendering.Occlusion.ElevationStack` — 12 참조

세 클래스의 `.cs` 가 프로젝트에 없다. `.cs` grep 으로는 찾을 수 없는 종류의 문제다.

**Phase 2 의 첫 회귀 테스트는 이 132건을 정확히 재현하는 것이다.**

## 알려진 부실함 (프로덕션에서 고칠 것)

- `m_EditorClassIdentifier` 추출 정규식이 `m_Script` 블록 밖까지 읽어 노이즈가 섞인다
  (`version: 13`, `active: 1` 같은 값이 식별자로 잡힘). 블록 경계를 지켜 파싱해야 한다.
- `fileID: 0`(null 참조)을 Missing Script 와 구분하지 않는다.
- 텍스트 직렬화 모드만 가정한다. Force Binary 프로젝트에서는 동작하지 않는다.

## 2026-08-27 — 아직 왜 남겨두는가

지우려다 남겼다. 이 스크립트는 출하 인덱스와 **다른 경로로 같은 질문에 답한다** —
§4-(31) 이 말한 교차검증이고, 이번 세션에서 실제로 버그를 잡은 프로브는 전부 그 형태였다.

두 수치가 다르고, **그 차이가 곧 각자의 한계다.**

| | 프로토타입 | 출하 `unity_find_missing_scripts` |
|---|---|---|
| GUID | 10 | **14** |
| 영향 에셋 | 125 | 134 |
| 참조 | 150 | 164 |
| 파일 선택 | 확장자 화이트리스트 6종 | **내용 스니핑**(앞 512B 에 NUL 없으면 텍스트) |
| Unity 빌트인 | 목록에 섞어 낸다 (`00000000…` 8건) | `unityBuiltinReferences` 로 분리 (10건) |

**출하만 찾는 5개(22 참조)** — 전부 확장자 화이트리스트의 구멍이다:

| GUID | 참조 | 에셋 |
|---|---|---|
| `338e9578` | 12 | `.prefab` |
| `22e815ce` | 5 | `.prefab` |
| `5b71ad40` | 3 | `.asset` |
| `081ffb00` | 1 | `.vfx` ← 화이트리스트에 없다 |
| `547a3a58` | 1 | `.prefab` |

`.prefab` 은 화이트리스트에 있는데도 놓친 것이 3개다 — 이쪽은 GUID 추출 방식 차이로
보이지만 규명하지 않았다. **프로토타입 쪽이 덜 찾는다는 방향만 확인됐다.**

빌트인 쪽은 프로토타입이 더 낸다(8 vs 출하의 분리된 10). 출하는 `0000…e000…` 를
Unity 내장으로 알아보고 missing 목록에서 뺀다 — 그게 맞다. 삭제 판단에 쓰이는 목록에
고칠 수 없는 항목이 섞이면 안 된다.

인자를 빼고 돌리면 이제 사용법을 안내한다(예전에는 `path.join` 안에서 TypeError).
