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
| 파일 목록 수집 | 35 ms (.meta 2,037 / YAML 783) |
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

## 2026-08-27 — 버그 둘을 고쳤고, 그 뒤에야 교차검증이 됐다

지우려다 남겼다. 이 스크립트들은 출하 인덱스와 **다른 경로로 같은 질문에 답한다** —
§4-(31) 이 말한 교차검증이다. 그런데 남기기로 한 뒤 독립 감사(Codex CLI)가
**`index-prototype.js` 가 조용히 깨져 있다**고 지적했고, 재현하니 맞았다.
고치는 과정에서 **둘째 버그**가 하나 더 나왔다.

### 버그 1 — 두 루트를 한 번도 훑지 않았다

```js
(function walkAll(){ for (const r of walkRoots) walk(r); })   // 호출 괄호가 없다
for (const r of walkRoots.slice(1)) { try { walkDir(r); } catch {} }  // walkDir 은 없는 함수
```

`walkAll` 은 함수 표현식으로 만들어졌을 뿐 실행되지 않았고, 그 아래 `walkDir` 는 정의된
적이 없는데 `try{}catch{}` 가 ReferenceError 를 삼켰다. 결과: `Packages` 와
`Library/PackageCache` 를 한 번도 안 봤다.

### 버그 2 — 정션을 안 따라갔다 (이게 더 컸다)

버그 1 을 고쳤는데도 `.meta` 개수가 출하와 안 맞았다(2,037 vs 3,142). `find -type f` 로
세도 2,037 이라 처음엔 출하가 부풀었다고 봤다. 원인은 **`Assets/50.Art` 가 Junction**
이라는 것이다(대상 `C:/svn/GA7thFinal_VeyTrace/4_Resources/Art`).

`Dirent.isDirectory()` 는 정션에 대해 **false** 를 낸다(`isSymbolicLink()` 가 true).
그래서 아트 라이브러리가 통째로 빠졌다 — 그 아래 `.meta` 가 정확히 **1,105개**,
2,037 + 1,105 = **3,142** 로 출하 수치와 딱 맞는다. **출하가 맞았고 이쪽이 틀렸다.**
`find -type f` 도 같은 이유로 정션을 안 따라가므로 대조군으로 쓸 때 주의할 것.

이제 두 스크립트 모두 `isDirEntry()` 로 정션을 따라간다.

### 고친 뒤의 대조 (2026-08-27 실측)

`index-prototype.js` — 기본 스코프를 출하 기본값(`includePackageCache: false`)과 맞췄다.
`--all` 을 주면 PackageCache 까지 훑는다(원래 용도였던 전수 타이밍).

| | 프로토타입 | 출하 | 차이의 이유 |
|---|---|---|---|
| `.meta` | **3,142** | **3,142** | **일치** |
| YAML | 1,131 | 1,171 | 확장자 6종 vs 내용 스니핑, ProjectSettings |
| 역참조 엣지 | 5,586 | 6,305 | 위와 같음 + `.meta` 를 출처로 안 읽는다 |
| 콜드 | 1.6 s | 4.8 s | 심볼·호출그래프·배선을 안 만든다 |

`missing-scripts.js` — **완전히 화해된다**:

| | 프로토타입 | 출하 |
|---|---|---|
| GUID | 14 (Unity 빌트인 1개 포함) | 14 (빌트인은 `unityBuiltinReferences` 로 분리) |
| 참조 | 171 (빌트인 8건 포함) | 164 |

171 − 빌트인 8 = **163**, 출하 164 − `.vfx` 1 = **163**. 남은 차이는 하나뿐이다 —
`081ffb00`(1건)이 `.vfx` 에 있고 `.vfx` 는 확장자 6종에 없다.

빌트인 쪽은 프로토타입이 목록에 섞어 내고 출하는 분리한다 — 출하가 맞다.
삭제 판단에 쓰이는 목록에 고칠 수 없는 항목이 섞이면 안 된다.

### 이 절의 이전 판(같은 날 앞선 커밋)은 틀렸다

"출하만 찾는 5개(22 참조)는 전부 확장자 화이트리스트의 구멍" 이라고 적었다.
**정션 버그가 있는 상태에서 측정한 것이다.** 실제 원인의 대부분은 정션 실명이었고,
화이트리스트 구멍은 `.vfx` 1건이다.

### 인자

둘 다 인자 없이 돌리면 사용법을 안내한다(예전에는 `path.join` 안에서 TypeError).
