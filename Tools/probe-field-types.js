#!/usr/bin/env node
// 필드 타입 서명 인수 프로브 (ECMA-335 II.23.2.4 FieldSig / II.23.2.12 Type).
//
// §4-(22): 구현 전에 쓴다.
// §4-(28): 작업을 집을 때 그 작업이 존재하는 이유부터 다시 잰다. 여기서는 —
//          지금 필드는 이름/접근자만 있고 **타입이 없다**. 그래서 직렬화 값을 보는
//          `unity_get_asset_components` 가 값의 타입을 검증할 수 없고, `objectReference`
//          필드가 무엇을 가리키는 필드인지도 말할 수 없다.
//
// 이 프로브의 핵심은 8번이다 — **디스크의 실제 선언과 대조한다.**
// SequencePoints 때(§4 d0714ad) 같은 방식으로 디코더의 정당성을 확인한다.
//
// 오프라인 전용.

const path = require('path');
const fs = require('fs');
const ROOT = path.join(__dirname, '..');
const tools = require(path.join(ROOT, 'Bridge/index/tools'));

const PORT = 3000;
// 프로젝트 루트는 **브릿지가 실제로 인덱싱한 것**을 쓴다. 하드코딩하면 이 레포를 다른
// 머신에 클론했을 때 검사가 통째로 죽는다. `ensureIndex` 뒤에 호출해야 하므로 함수다.
const projectRoot = () => (tools._projectRoot && tools._projectRoot()) ||
  process.env.UNITY_MCP_PROJECT || 'C:/Unity/MainProject';
let pass = 0, fail = 0;

function check(name, fn) {
  let ok = false, detail = '';
  const t0 = Date.now();
  try { const r = fn(); ok = r === true || (r && r.ok); detail = (r && r.detail) || ''; }
  catch (e) { detail = `threw: ${e && e.message}`; }
  console.log(`  ${ok ? 'pass' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}  (${Date.now() - t0} ms)`);
  ok ? pass++ : fail++;
}

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
const sym = idx.symbols;

function fieldsOf(type) {
  const r = tools.callLocalTool('unity_get_type_symbols', { type, maxMembers: 500 }, PORT);
  const d = JSON.parse(r.content[0].text);
  return d.fields || [];
}
/** 모든 사용자 타입의 필드를 순회한다(응답이 아니라 인덱스에서 — 페이지 상한을 피한다). */
function allFields() {
  const out = [];
  for (const [, info] of sym.typeByFullName) {
    for (const f of (info.fields || [])) out.push({ owner: info, f });
  }
  return out;
}

console.log('\n필드 타입 서명');

// 1. 타입이 실린다.
check('필드에 타입이 실린다', () => {
  const fs2 = fieldsOf('Unit');
  const withType = fs2.filter(f => typeof f.type === 'string' && f.type.length > 0);
  return { ok: withType.length > 0, detail: `${withType.length}/${fs2.length} 개에 type` };
});

// 2. 원시 타입은 C# 이름으로. `System.Int32` 보다 `int` 가 읽는 쪽에 맞다.
check('원시 타입이 C# 이름으로 나온다', () => {
  const all = allFields();
  const names = new Set(all.map(x => x.f.type).filter(Boolean));
  const want = ['int', 'float', 'bool', 'string'];
  const missing = want.filter(w => !names.has(w));
  return { ok: missing.length === 0, detail: missing.length ? `없는 것: ${missing.join(',')}` : want.join(',') + ' 전부 있음' };
});

// 3. 참조 타입(클래스)이 전체 이름으로 나온다.
check('Unity 참조 타입이 나온다', () => {
  const all = allFields();
  const names = new Set(all.map(x => x.f.type).filter(Boolean));
  const hits = [...names].filter(n => /^UnityEngine\./.test(n));
  return { ok: hits.length > 0, detail: `UnityEngine.* 필드 타입 ${hits.length}종, 예: ${hits.slice(0, 3).join(', ')}` };
});

// 4. 배열과 제네릭이 표현된다. 이게 안 되면 리스트 필드를 못 읽는다.
check('배열과 제네릭이 표현된다', () => {
  const all = allFields();
  const names = [...new Set(all.map(x => x.f.type).filter(Boolean))];
  const arr = names.filter(n => n.endsWith('[]'));
  // `<>c` 같은 컴파일러 생성 이름도 '<' 와 '>' 를 갖는다 - 처음에 그걸로 통과해 버렸다(§4-(27)).
  // 진짜 제네릭 인스턴스는 이름 뒤에 `<...>` 가 붙고 인자가 비어 있지 않다.
  const gen = names.filter(n => /^[A-Za-z_][A-Za-z0-9_.]*<[^<>]*[A-Za-z0-9_][^<>]*>$/.test(n));
  return { ok: arr.length > 0 && gen.length > 0,
           detail: `배열 ${arr.length}종(${arr[0] || '-'}), 제네릭 ${gen.length}종(${gen[0] || '-'})` };
});

// 5. 모르는 것은 null 이다. 추측해서 채우면 값 검증이 거짓말을 한다.
check('디코딩 실패는 null 이지 추측이 아니다', () => {
  const all = allFields();
  // 처음엔 placeholder 3종만 거부했다 — 그러면 **모든 type 이 undefined 여도 통과한다**
  // (감사 지적). 값이 실재할 것과, 없을 때는 정확히 null 일 것을 함께 요구한다.
  const bad = all.filter(x => x.f.type === '' || x.f.type === '?' || x.f.type === 'unknown');
  const undef = all.filter(x => x.f.type === undefined).length;
  const nulls = all.filter(x => x.f.type === null).length;
  const typed = all.filter(x => typeof x.f.type === 'string' && x.f.type).length;
  return { ok: bad.length === 0 && undef === 0 && typed > 0,
           detail: `placeholder ${bad.length}, undefined ${undef}, null ${nulls}, 실제 타입 ${typed}/${all.length}` };
});

// 6. 전수 디코딩률. 낮으면 도구가 "모른다" 를 너무 많이 말하게 된다.
check('전수 디코딩률이 90% 이상이다', () => {
  const all = allFields();
  const okc = all.filter(x => typeof x.f.type === 'string' && x.f.type).length;
  const pct = all.length ? (okc / all.length * 100) : 0;
  return { ok: pct >= 90, detail: `${okc}/${all.length} = ${pct.toFixed(1)}%` };
});

// 7. 캐시 왕복 보존. 전례가 있다 — 캐시가 duplicateTypes 를 잃었다(§4-(24)-2).
check('캐시 왕복에서 필드 타입이 보존된다 (경계)', () => {
  tools.ensureIndex(PORT, true, false);
  const a = fieldsOf('Unit').map(f => f.type);
  tools._forceStaleForTest();
  tools.ensureIndex(PORT, false, false, true);
  const b = fieldsOf('Unit').map(f => f.type);
  return { ok: a.length > 0 && a.some(Boolean) && JSON.stringify(a) === JSON.stringify(b),
           detail: `신규빌드 ${a.filter(Boolean).length}개 vs 캐시 ${b.filter(Boolean).length}개` };
});

// 8. ⭐ 디스크 대조. 디코딩한 타입 이름이 실제 소스의 선언과 맞는가.
//    ⚠️ **표본 검사다.** 전수가 아니다 — 소스 파일이 매핑되지 않은 타입의 필드 1,052개는
//    대조 자체가 불가능하고, 여기 쓰는 정규식도 짧은 이름 휴리스틱이다.
//    "모든 선언이 일치한다" 의 근거로 쓰면 안 된다(감사 지적).
//    표본을 손으로 고르지 않는다(§4-(27)) — 인덱스에서 소스가 있는 필드를 순회한다.
check('디코딩한 타입이 디스크의 선언과 맞다 (표본 150, 전수 아님)', () => {
  const seen = [];
  const misses = [];
  for (const [, info] of sym.typeByFullName) {
    if (seen.length >= 150) break;
    // 컴파일러 생성 타입(`<>c__DisplayClass...`)의 '필드' 는 **캡처된 지역변수**다.
    // 소스에는 `var x = ...` 로 적혀 있어 선언 타입이 글자로 나타나지 않는다.
    // 디코더가 틀린 게 아니라 대조 방법이 성립하지 않는 자리라 제외한다(실측으로 확인).
    if (/[<>]/.test(info.name)) continue;
    const src = (info.sourceFiles || [])[0];
    if (!src) continue;
    const abs = path.join(projectRoot(), src);
    if (!fs.existsSync(abs)) continue;
    const text = fs.readFileSync(abs, 'utf8');
    for (const f of (info.fields || [])) {
      if (seen.length >= 150) break;
      if (!f.type || f.name.startsWith('<')) continue;
      // 선언 줄을 찾아 그 줄에 타입의 마지막 조각이 있는지 본다.
      // `UnityEngine.Transform` -> `Transform`, `List<Unit>` -> `List`
      // C# 문법 설탕은 CLR 이름과 글자가 다르다. 확인한 것 하나: 소스의
      // `(string Name, float OpenZ)[]` 는 CLR 에서 `System.ValueTuple<string, float>[]` 이다.
      // 디코더가 맞고 대조가 불가능한 자리이므로 제외한다.
      if (/^System\.ValueTuple/.test(f.type)) continue;
      const short = String(f.type).replace(/\[\]$/, '').split('<')[0].split('.').pop();
      const re = new RegExp('(^|[^A-Za-z0-9_])' + short.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') +
                            '[^;\\n]*\\b' + f.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\b');
      const hit = re.test(text);
      seen.push({ name: f.name, type: f.type, hit });
      if (!hit) misses.push(`${info.name}.${f.name}:${f.type}`);
    }
  }
  return { ok: seen.length >= 10 && misses.length === 0,
           detail: `${seen.length - misses.length}/${seen.length} 일치` +
                   (misses.length ? ` 불일치: ${misses.slice(0, 4).join(', ')}` : '') };
});

console.log(`\n${pass}/${pass + fail}`);
process.exit(fail === 0 ? 0 : 1);
