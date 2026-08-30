#!/usr/bin/env node
// 오버로드 분리 인수 프로브.
//
// §4-(28) 대로 먼저 쟀다(2026-08-27):
//   선언 2개 이상인 키 146개 / 호출자 있는 키 4,350개 / 총 엣지 8,673개
//   **오버로드된 키를 향하는 엣지 366개 = 4.2%**, 영향받는 키 101개
//   상위 대부분이 벤더(Ami.BroAudio.*, Ami.Extension.*). 자기 코드는
//   Unit::TakeDamage(2/9), MonsterTargeting::IsAttackable(2/9), BaseAttack::TryResolveHit(4/8)
//
// 그래서 **키를 교체하지 않고 시그니처 키 그래프를 병렬로 얹는다.** 이유 둘:
//   1) UnityEvent 배선과 속성은 메서드 **이름만** 갖고 있다 - 시그니처로 구분할 방법이
//      원리적으로 없다. 키를 바꿔도 이름 단위 롤업을 다시 만들어야 한다
//   2) 4.2% 를 위해 소비자 6곳(find_callers/find_callees/impact/projectmap/errorimpact/
//      inspectorWiring)의 키를 흔드는 것은 대가가 이득보다 크다
//
// 오프라인 전용.

const path = require('path');
const ROOT = path.join(__dirname, '..');
const tools = require(path.join(ROOT, 'Bridge/index/tools'));

const PORT = 3000;
let pass = 0, fail = 0;
function check(name, fn) {
  let ok = false, detail = '';
  const t0 = Date.now();
  try { const r = fn(); ok = r === true || (r && r.ok); detail = (r && r.detail) || ''; }
  catch (e) { detail = `threw: ${e && e.message}`; }
  console.log(`  ${ok ? 'pass' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}  (${Date.now() - t0} ms)`);
  ok ? pass++ : fail++;
}
const call = (n, a) => JSON.parse(tools.callLocalTool(n, a, PORT).content[0].text);

// 인수 스위트는 스스로 선다 — 캐시가 없으면 여기서 죽지 말고 한 번 빌드한다.
// (2026-08-28 인수 때 프로브 8개 중 6개가 이 줄에서 exit 2 했다. §4-(33))
let idx = tools.ensureIndex(PORT, false, false, true);
if (!idx) {
  const t0 = Date.now();
  idx = tools.ensureIndex(PORT, false, false, false);
  if (idx) console.log(`  note  인덱스 캐시가 없어 콜드 빌드했다 (${Date.now() - t0} ms)`);
}
if (!idx) {
  console.error('인덱스를 만들 수 없다 — 프로젝트 루트 해석 실패일 수 있다. unity_index_status 를 먼저 볼 것.');
  process.exit(2);
}
const cg = idx.callGraph;

console.log('\n오버로드 분리');

// 1. 시그니처 키 그래프가 존재한다.
check('시그니처 키 호출 그래프가 있다', () => {
  const m = cg.callersOfSig;
  // "0보다 크다" 는 존재 확인에 그친다. 이름 그래프와 나란히 놓고 관계를 요구한다 —
  // 시그니처 타깃은 이름 타깃보다 적을 수 없다(한 이름이 여러 시그니처로 갈리므로).
  return { ok: m && m.size > 0 && m.size >= cg.callersOf.size,
           detail: m ? `시그 타깃 ${m.size} >= 이름 타깃 ${cg.callersOf.size}` : 'callersOfSig 없음' };
});

// 2. 키 형태가 `Type::Method(인자)` 다.
check('시그니처 키가 Type::Method(인자) 형태다', () => {
  const keys = [...(cg.callersOfSig || new Map()).keys()];
  // 명시적 인터페이스 구현의 이름에는 괄호가 들어간다(실측 2건). 그래서 "이름에 괄호가
  // 없다" 를 요구하면 안 된다. 요구할 것은 **끝이 인자 목록**이라는 것뿐이다.
  const shaped = keys.filter(k => k.includes('::') && /\([^()]*\)$/.test(k));
  return { ok: keys.length > 0 && shaped.length === keys.length,
           detail: `${shaped.length}/${keys.length} 형태 일치, 예: ${keys[0]}` };
});

// 3. ⭐ 오버로드가 실제로 갈린다.
//    이름이 "4개 오버로드가 각각 키를 갖는다" 였는데 단언은 `>= 2` 였다 — 실측 3개로 통과했다
//    (감사 지적). **호출자가 없는 오버로드는 그래프에 키가 없는 것이 정상**이므로 4개를
//    요구하면 안 된다. 대신 선언 수를 심볼에서 독립적으로 세어 **키 수 + 호출자 없는 수**가
//    선언 수와 맞는지 본다 — 그게 실제로 검사할 수 있는 관계다.
check('TryResolveHit 의 선언 수와 시그니처 키 수가 화해된다', () => {
  const keys = [...(cg.callersOfSig || new Map()).keys()]
    .filter(k => k.startsWith('BaseAttack::TryResolveHit('));
  const info = idx.symbols.typeByFullName.get('BaseAttack');
  const decls = (info ? info.methods : []).filter(m => m.name === 'TryResolveHit').length;
  return { ok: keys.length >= 2 && decls >= keys.length,
           detail: `선언 ${decls}개, 그래프 키 ${keys.length}개(호출자 없는 ${decls - keys.length}개는 키가 없다): ` +
                   keys.map(k => k.slice(k.lastIndexOf('('))).join(' ') };
});

// 4. 시그니처 키의 호출자 합이 이름 키의 호출자와 어긋나지 않는다.
//    (합이 같아야 하는 것은 아니다 - 해석 못 한 엣지는 이름 키에만 남는다.
//     그래서 시그니처 쪽이 **더 클 수는 없다**.)
check('시그니처 키 호출자가 이름 키를 넘지 않는다', () => {
  let bad = [];
  for (const [k, set] of (cg.callersOfSig || new Map())) {
    const nameKey = k.slice(0, k.lastIndexOf('('));
    const nameSet = cg.callersOf.get(nameKey);
    if (!nameSet) { bad.push(`${k}: 이름 키 없음`); continue; }
    for (const c of set) {
      const cn = c.includes('(') ? c.slice(0, c.lastIndexOf('(')) : c;
      if (!nameSet.has(cn)) { bad.push(`${k} <- ${c}`); break; }
    }
    if (bad.length > 3) break;
  }
  return { ok: bad.length === 0, detail: bad.length ? bad.slice(0, 3).join(' | ') : '모든 시그니처 엣지가 이름 그래프에도 있다' };
});

// 5. 해석 못 한 엣지를 센다. 조용히 버리면 시그니처 그래프가 완전해 보인다.
check('오버로드를 해석 못 한 엣지 수를 보고한다', () => {
  const st = cg.stats || {};
  return { ok: typeof st.sigEdges === 'number' && typeof st.sigUnresolvedEdges === 'number',
           detail: `sigEdges=${st.sigEdges}, sigUnresolved=${st.sigUnresolvedEdges}, 이름엣지=${st.edges}` };
});

// 6. ⭐⭐ 회귀 — 기존 이름 키가 안 바뀌어야 한다. 이 설계의 전제다.
//    ⚠️ 이 검사는 **바이트 동일까지 증명하지 않는다.** 고정 호출자 수 둘과 참조 엣지 수를
//    본다. 진짜 바이트 대조는 독립 감사가 했다(2026-08-27): 오버로드 추가 전(`d4c853d^`)의
//    빌더와 현재 빌더를 같은 심볼로 돌려 `callsFrom` 545,403 B / `callersOf` 611,698 B 가
//    양쪽 바이트 동일. 그 절차는 이 프로브에 없으므로 이름에 '표본' 임을 밝힌다.
check('기존 이름 키가 그대로다 (표본 회귀)', () => {
  const a = call('unity_find_callers', { method: 'BaseAttack::TryResolveHit' });
  const b = call('unity_find_callers', { method: 'Unit::TakeDamage' });
  const st = call('unity_index_status', {});
  // ⚠️ 참조 엣지 기준선의 이력 — **두 번 다 회귀가 아니다.**
  //   6,305 -> 6,306 : 상수로 조립된 로드 경로 한 건을 접게 되면서 경로 로드 엣지가 늘었다
  //   6,306 -> 6,302 : `DefaultVolumeProfile.asset` 의 고아 컴포넌트 4개를 지웠다(§5).
  //                    죽은 스크립트 GUID 도 `refs` 에 엣지로 세어지므로 4가 줄었다
  //                    (실측 확인: 그 4개는 실재 에셋을 가리키지 않았다).
  //   6,302 -> 6,275 : B군(서드파티·아트 잔여물) 정리로 문서 28개를 지웠다(2026-08-31, §5).
  //                    27 만 줄어든 것이 맞다 — 엣지는 (에셋, GUID) 쌍이고
  //                    `URP Renderer.asset` 하나가 같은 GUID 를 2번 갖고 있었다.
  //                    같은 정리로 `missingScript` 597->569, `scriptComponents` 7016->6988.
  // 여기서 **더** 줄면 그때는 도구 문제로 볼 것.
  //
  // ⚠️ 이 기준은 **기본 커버리지(assets)** 의 값이다. `sweep-field-checks` 나
  //    `probe-ecid-promotion` 은 전체 커버리지로 강제 재빌드하고 그 캐시를 디스크에 남긴다.
  //    그 뒤에 이 프로브를 다시 돌리면 refEdges 가 7,392 로 나와 **정리를 회귀로 오독한다**
  //    (2026-08-31 에 실제로 두 번 그랬다). 커버리지가 다르면 그 항목은 재지 않는다.
  const cov = st.guidCoverage || (st.stats && st.stats.guidCoverage);
  const edgesOk = cov === 'assets' ? st.stats.referenceEdges === 6275 : true;
  const edgeNote = cov === 'assets'
    ? `refEdges ${st.stats.referenceEdges}(기준 6275)`
    : `refEdges 건너뜀 — 커버리지가 '${cov}' 다(기준은 assets 값)`;
  return { ok: a.totalCount === 8 && b.totalCount === 9 && edgesOk,
           detail: `TryResolveHit ${a.totalCount}(기준 8), TakeDamage ${b.totalCount}(기준 9), ${edgeNote}` };
});

// 7. ⭐ 특정 오버로드를 물을 수 있다 — 사용자가 요청한 능력 자체다.
check('find_callers 가 특정 오버로드를 받는다', () => {
  const keys = [...(cg.callersOfSig || new Map()).keys()]
    .filter(k => k.startsWith('BaseAttack::TryResolveHit('));
  if (!keys.length) return { ok: false, detail: '시그니처 키가 없다' };
  const one = keys[0];
  const d = call('unity_find_callers', { method: one });
  const expect = cg.callersOfSig.get(one).size;
  return { ok: !d.error && d.totalCount === expect,
           detail: `${one} -> ${d.totalCount} (인덱스 ${expect})` };
});

// 8. 이름으로 물으면 오버로드별 분해를 함께 준다.
check('이름 질의에 오버로드별 분해가 실린다', () => {
  const d = call('unity_find_callers', { method: 'BaseAttack::TryResolveHit' });
  const po = d.perOverload;
  return { ok: Array.isArray(po) && po.length >= 2 && po.every(x => typeof x.callerCount === 'number'),
           detail: po ? JSON.stringify(po.map(x => [x.signature, x.callerCount])) : 'perOverload 없음' };
});

// 9. 경계 — 없는 오버로드에 조용한 0 을 답하면 안 된다 (§4-(24)-1).
check('없는 오버로드는 에러다 (0 이 아니다)', () => {
  const d = call('unity_find_callers', { method: 'BaseAttack::TryResolveHit(int,int,int,int,int)' });
  // `!!d.error` 만 보면 어떤 에러든 통과한다(§4-(27)). 이 자리에서 요구할 것은
  // **"그 오버로드가 없다" 는 에러이고 실재하는 후보를 함께 준다**는 것이다.
  const right = !!d.error && /No overload/.test(d.error) &&
                Array.isArray(d.candidates) && d.candidates.length >= 2 &&
                d.candidates.every(c => c.startsWith('BaseAttack::TryResolveHit('));
  return { ok: right,
           detail: d.error ? `${d.error.slice(0, 46)}... candidates ${d.candidates ? d.candidates.length : 0}`
                           : `totalCount=${d.totalCount}` };
});

// 10. 경계 — 캐시 왕복에서 시그니처 그래프가 보존된다 (전례: §4-(24)-2).
check('캐시 왕복에서 시그니처 그래프가 보존된다 (경계)', () => {
  tools.ensureIndex(PORT, true, false);
  const a = tools.ensureIndex(PORT, false, false, true).callGraph.callersOfSig.size;
  tools._forceStaleForTest();
  tools.ensureIndex(PORT, false, false, true);
  const b = tools.ensureIndex(PORT, false, false, true).callGraph.callersOfSig.size;
  return { ok: a > 0 && a === b, detail: `신규빌드 ${a} vs 캐시 ${b}` };
});

console.log(`\n${pass}/${pass + fail}`);
process.exit(fail === 0 ? 0 : 1);
