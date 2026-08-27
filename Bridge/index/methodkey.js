// 메서드 키 파싱의 **단일 출처**.
//
// 이 인덱스에는 메서드 키가 두 형태로 있다:
//
//     Type::Method                이름 키. 오버로드를 합친다. UnityEvent 배선과 속성은
//                                 메서드 이름만 갖고 있으므로 이 롤업이 원리적으로 필요하다
//     Type::Method(int,string)    시그니처 키. 오버로드를 가른다
//
// 왜 모아야 했나 — `typeOfKey` 가 `impact.js` 와 `projectmap.js` 에 **글자 그대로 두 벌**
// 있었고, 그 밖에 `key.indexOf('::')` 수동 자르기가 `queries.js` 4곳, `errorimpact.js` 1곳,
// `impact.js` 2곳에 흩어져 있었다. 그리고 시그니처 키의 `(` 경계 규칙은 `queries.js` 와
// 프로브에 각각 적혀 있었다. 규칙이 여러 자리에 있으면 그중 일부만 고쳐진다 —
// 이 프로젝트가 §4-(21) 에서 배운 형태이고, 실제로 그렇게 됐다:
// `find_callees` 는 시그니처 키를 이름 그래프에 넣어 거짓 0 을 답했고,
// `find_callers` 는 `(params)` 를 이름에 붙인 채로 속성을 조회해 안전 축을 잃었다.
//
// ⚠️ **인자 목록은 마지막 `(` 로 끊는다.** 명시적 인터페이스 구현의 메서드 이름에는
// 괄호가 들어간다(실측 2건):
//     IEnumerable<(System.Type,System.Type)>.GetEnumerator
// 파라미터 타입은 괄호를 만들지 않으므로(튜플은 `System.ValueTuple<>` 로 렌더링된다)
// 마지막 `(` 는 항상 인자 목록의 시작이다. 독립 감사가 이 문법을 확인했고, 실측 어셈블리
// 안에서 이를 깨는 이름은 없었다(비-C# 메타데이터라면 깰 수 있다).

const SEP = '::';

/** 시그니처 키인가. `Type::Method(...)` 처럼 인자 목록으로 끝나면 그렇다. */
function isSignatureKey(key) {
  const k = String(key || '');
  return k.endsWith(')') && k.lastIndexOf('(') > k.indexOf(SEP);
}

/** 키의 타입 부분. `::` 가 없으면 키 전체를 타입으로 본다(호출부가 그렇게 써 왔다). */
function typeOf(key) {
  const k = String(key || '');
  const i = k.indexOf(SEP);
  return i < 0 ? k : k.slice(0, i);
}

/**
 * 키의 메서드 이름. **시그니처 키에서는 `(params)` 를 뗀다.**
 * 안 떼면 메타데이터의 메서드 이름과 절대 같아지지 않아 속성·선언·배선 조회가
 * 조용히 빈 결과가 된다.
 */
function methodOf(key) {
  const k = String(key || '');
  const i = k.indexOf(SEP);
  const raw = i < 0 ? '' : k.slice(i + SEP.length);
  if (!isSignatureKey(k)) return raw;
  const lp = raw.lastIndexOf('(');
  return lp > 0 ? raw.slice(0, lp) : raw;
}

/** 시그니처 키의 인자 부분(`(int,string)`). 이름 키면 null. */
function paramsOf(key) {
  const k = String(key || '');
  if (!isSignatureKey(k)) return null;
  return k.slice(k.lastIndexOf('('));
}

/** 시그니처 키를 이름 키로 투영한다. 이름 키는 그대로 돌려준다. */
function toNameKey(key) {
  const k = String(key || '');
  if (!isSignatureKey(k)) return k;
  return k.slice(0, k.lastIndexOf('('));
}

/** `Type::Method(a,b)` 를 만든다. params 가 없으면 이름 키가 된다. */
function make(typeFull, methodName, params) {
  const base = typeFull + SEP + methodName;
  return Array.isArray(params) ? base + '(' + params.join(',') + ')' : base;
}

module.exports = { SEP, isSignatureKey, typeOf, methodOf, paramsOf, toNameKey, make };
