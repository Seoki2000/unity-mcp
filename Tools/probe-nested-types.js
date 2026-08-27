#!/usr/bin/env node
// 중첩 타입 신원 인수 프로브.
//
// 문제: 전체 이름이 `namespace.name` 이라 **선언 타입이 빠진다.** 그래서 서로 다른
// 클래스 안의 같은 이름이 한 이름으로 겹치고, 도구는 조용히 하나를 고르거나 거절한다.
//
// 실측(2026-08-27): 중복 레코드 123개 / 고유 이름 29개. 그중 19개가 컴파일러 생성이고,
// 사용자가 실제로 질의할 만한 것은 PassData(3) · Segment(2) · Tab(2) ·
// FactorySettings(2) · EffectState(2) 다섯이다. 이름 체계를 통째로 바꿔
// **호출 그래프 키까지 흔들 규모가 아니다.**
//
// 그래서 계약은 이렇다: 키는 그대로 두고, **모호성을 해소할 방법을 준다.**
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

const idx = tools.ensureIndex(PORT, false, false, true);
if (!idx) { console.error('인덱스 캐시가 없다.'); process.exit(2); }
const sym = idx.symbols;

function allNamed(full) {
  const out = [];
  if (sym.typeByFullName.has(full)) out.push(sym.typeByFullName.get(full));
  for (const d of (sym.duplicateTypes || [])) if (d.fullName === full) out.push(d);
  return out;
}

console.log('\n중첩 타입 신원');

// 1. 선언 타입을 인덱스가 안다.
check('중첩 타입에 declaringType 이 실린다', () => {
  const pd = allNamed('PassData');
  if (pd.length < 2) return { ok: false, detail: `PassData 표본 ${pd.length}개` };
  const dts = pd.map(t => t.declaringType);
  return { ok: dts.every(d => typeof d === 'string' && d.length > 0),
           detail: JSON.stringify(dts) };
});

// 2. 최상위 타입은 null 이다. 빈 문자열로 채우면 "선언 타입이 있다" 로 읽힌다.
check('최상위 타입은 declaringType 이 null (빈 문자열 아님)', () => {
  const u = sym.typeByFullName.get('Unit');
  if (!u) return { ok: false, detail: 'Unit 을 못 찾았다' };
  return { ok: u.declaringType === null, detail: `declaringType=${JSON.stringify(u.declaringType)}` };
});

// 3. ⭐ 모호성이 **해소 가능**해야 한다. 셋이 서로 다른 이름을 가져야 한다.
check('PassData 셋이 qualifiedName 으로 유일해진다', () => {
  const pd = allNamed('PassData');
  const qs = pd.map(t => t.qualifiedName);
  return { ok: qs.length >= 2 && qs.every(Boolean) && new Set(qs).size === qs.length,
           detail: JSON.stringify(qs) };
});

// 4. 그 이름으로 실제 질의가 된다.
check('get_type_symbols 가 Outer/Inner 를 받는다', () => {
  const pd = allNamed('PassData').filter(t => t.qualifiedName);
  if (!pd.length) return { ok: false, detail: 'qualifiedName 없음' };
  const q = pd[0].qualifiedName;
  const d = call('unity_get_type_symbols', { type: q });
  return { ok: !d.error && !d.ambiguousFullName, detail: `${q} -> ${d.error ? d.error.slice(0,60) : 'fullName=' + d.fullName} ` };
});

// 5. 거절할 때 **무엇을 대신 쓸지** 말해야 한다. 거절만 하면 막다른 길이다.
check('모호한 이름을 거절할 때 대안 이름을 제시한다', () => {
  const d = call('unity_impact_analysis', { target: 'PassData' });
  const s = JSON.stringify(d);
  const pd = allNamed('PassData').map(t => t.qualifiedName).filter(Boolean);
  const named = pd.filter(q => s.includes(q));
  return { ok: named.length >= 2, detail: `응답이 제시한 후보 ${named.length}/${pd.length}` };
});

// 6. ⭐ 회귀 — 호출 그래프 키가 바뀌면 안 된다. 이 작업의 전제다.
check('호출 그래프 키가 그대로다 (회귀)', () => {
  const a = call('unity_find_callers', { method: 'BaseAttack::TryResolveHit' });
  const b = call('unity_get_type_symbols', { type: 'Unit' });
  return { ok: a.totalCount === 8 && !a.error && b.fullName === 'Unit',
           detail: `TryResolveHit 호출자 ${a.totalCount} (기준선 8), Unit 해석 ${b.fullName}` };
});

// 7. 경계 — 캐시 왕복에서 신원을 잃으면 안 된다(전례: duplicateTypes 를 잃었다, §4-(24)-2).
check('캐시 왕복에서 declaringType/qualifiedName 이 보존된다 (경계)', () => {
  tools.ensureIndex(PORT, true, false);
  const a = allNamed('PassData').map(t => t.qualifiedName).sort();
  tools._forceStaleForTest();
  tools.ensureIndex(PORT, false, false, true);
  const idx2 = tools.ensureIndex(PORT, false, false, true);
  const s2 = idx2.symbols;
  const b = [s2.typeByFullName.get('PassData'), ...(s2.duplicateTypes || []).filter(d => d.fullName === 'PassData')]
    .filter(Boolean).map(t => t.qualifiedName).sort();
  // a 가 [null,null,null] 이어도 b 와 같으면 통과해 버린다 - 퇴화 케이스로 초록불이 켜진다(§4-(27)).
  // 값이 실재할 것을 함께 요구한다.
  return { ok: a.length > 0 && a.every(Boolean) && JSON.stringify(a) === JSON.stringify(b),
           detail: `신규빌드 ${JSON.stringify(a)} vs 캐시 ${JSON.stringify(b)}` };
});

// 8. 경계 — ⭐ 제시한 후보가 **실제로 통하는가**.
//    5번은 "후보가 응답에 실리는가" 만 봤고 7/7 이 떴다. 그런데 그 후보를 그대로 넣으면
//    `impact_analysis` 가 "인덱스에 없다" 로 거절했다 — `/` 를 보고 에셋 경로로 판정하는
//    분기가 타입 분기보다 앞에 있었다. **제시한 길이 막다른 길이면 거절만도 못하다.**
//    프로브가 "제시했는가" 까지만 검사하면 이 왕복이 검사되지 않는다(§4-(24)).
check('제시한 후보를 그대로 넣으면 답이 나온다 (왕복)', () => {
  const amb = call('unity_impact_analysis', { target: 'PassData' });
  const cands = amb.candidates || [];
  if (!cands.length) return { ok: false, detail: '후보가 없다' };
  const bad = [];
  for (const c of cands) {
    const r = call('unity_impact_analysis', { target: c });
    if (r.error) bad.push(`${c}: ${r.error.slice(0, 40)}`);
  }
  return { ok: bad.length === 0, detail: bad.length ? bad.join(' | ') : `${cands.length}개 후보 전부 해석됨` };
});

console.log(`\n${pass}/${pass + fail}`);
process.exit(fail === 0 ? 0 : 1);
