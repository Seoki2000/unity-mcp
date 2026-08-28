#!/usr/bin/env node
// P3-a 인수 프로브 — 인덱스 신선도와 진단 정직성.
//
// §4-(22): 새 응답을 만들 때 "이 응답으로 답할 수 있어야 하는 질문" 을 먼저 적는다.
// §4-(24): 프로브는 내가 생각한 질문만 덮는다. 경계 조건은 따로 훑는다.
//
// 이 프로브가 지키는 계약:
//   한 번 메모리에 올라간 인덱스가 디스크와 어긋난 채 계속 서빙되면 안 된다.
//   그리고 얼마나 신선한지를 응답이 말해야 한다 — "모르는 것을 싣는다".
//
// 오프라인 전용. Unity 가 꺼져 있어도 전부 돈다.

const path = require('path');
const ROOT = path.join(__dirname, '..');
const scan = require(path.join(ROOT, 'Bridge/index/scan'));
const tools = require(path.join(ROOT, 'Bridge/index/tools'));

const PORT = 3000;
let pass = 0, fail = 0;
function check(name, fn) {
  let ok = false, detail = '';
  const t0 = Date.now();
  try { const r = fn(); ok = r === true || (r && r.ok); detail = (r && r.detail) || ''; }
  catch (e) { detail = `threw: ${e && e.message}`; }
  const ms = Date.now() - t0;
  console.log(`  ${ok ? 'pass' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}  (${ms} ms)`);
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
const root = tools._projectRoot ? tools._projectRoot() : 'C:/Unity/MainProject';

console.log('\nP3-a — 인덱스 신선도');

// 1. 컴파일 산출물의 지문을 낼 수 있어야 한다. 심볼·호출그래프가 여기서 나오기 때문이다.
check('어셈블리 서명을 낸다 (심볼 레이어의 출처)', () => {
  const sig = scan.assemblySignature(root);
  if (!sig || !sig.files) return { ok: false, detail: '서명이 비었다' };
  return { ok: sig.files > 0 && sig.totalBytes > 0,
           detail: `files=${sig.files}, bytes=${sig.totalBytes}` };
});

// 2. 같은 디스크 상태에서 두 번 재면 같아야 한다. 아니면 매 호출 재빌드가 된다.
check('어셈블리 서명이 결정적이다', () => {
  const a = scan.assemblySignature(root);
  const b = scan.assemblySignature(root);
  return { ok: a.hash === b.hash && a.files === b.files,
           detail: `hash ${a.hash} == ${b.hash}` };
});

// 3. 싸야 한다. 웜 질의가 48 ms 이므로 여기에 690 ms 를 붙일 수 없다.
check('어셈블리 서명이 100 ms 미만이다', () => {
  const t = Date.now(); scan.assemblySignature(root); const ms = Date.now() - t;
  return { ok: ms < 100, detail: `${ms} ms` };
});

// 4. ⭐ 이번에 고친 버그의 직접 재현.
//    tools.js 는 `if (_index && !force) return _index;` 로 한 번 올린 인덱스를
//    세션 내내 다시 검증하지 않았다. 재컴파일해도 컴파일 이전 그래프로 답했다.
check('낡은 인덱스를 그대로 서빙하지 않는다 (회귀 방지)', () => {
  const before = tools._freshness();
  if (!before) return { ok: false, detail: '_freshness() 시임이 없다' };
  tools._forceStaleForTest();          // 어셈블리 서명이 어긋난 상태를 만든다
  tools.ensureIndex(PORT, false, false, true);
  const after = tools._freshness();
  return { ok: after.revalidations > before.revalidations,
           detail: `revalidations ${before.revalidations} -> ${after.revalidations}` };
});

// 5. 신선도를 응답이 말해야 한다. 조용히 낡는 것이 이 프로젝트가 없애온 형태다.
check('unity_index_status 가 신선도를 싣는다', () => {
  const r = tools.callLocalTool('unity_index_status', {}, PORT);
  const d = JSON.parse(r.content[0].text);
  const f = d.freshness;
  if (!f) return { ok: false, detail: 'freshness 필드가 없다' };
  const need = ['validatedAt', 'assembliesMaxMtime', 'assetCheckIntervalMs'];
  const miss = need.filter(k => !(k in f));
  return { ok: miss.length === 0, detail: miss.length ? `누락: ${miss.join(',')}` : Object.keys(f).join(',') };
});

// 6. 검증 자체가 질의를 느리게 만들면 안 된다.
check('검증을 붙여도 웜 질의가 200 ms 미만이다', () => {
  tools.callLocalTool('unity_find_references', { target: 'Assets' }, PORT); // 워밍
  const t = Date.now();
  tools.callLocalTool('unity_get_type_symbols', { type: 'BombAction' }, PORT);
  const ms = Date.now() - t;
  return { ok: ms < 200, detail: `${ms} ms` };
});

// 7. 경계 조건 — 프로브 4가 못 잡은 것.
//    4 는 **캐시 로드** 경로만 밟는다. 캐시 없이 신규 빌드하면 _asmSig 를 안 남겨
//    다음 호출마다 낡음으로 판정돼 매 호출 재빌드에 빠졌다. §4-(21) 을 읽은 직후
//    같은 실수를 그대로 저질렀고, 프로브가 아니라 손검사가 잡았다. 그래서 박아 둔다.
check('신규 빌드 뒤에 재빌드 루프에 빠지지 않는다 (경계)', () => {
  tools.ensureIndex(PORT, true, false);          // 캐시를 건너뛰고 실제로 빌드
  const a = tools._freshness();
  const i1 = tools.ensureIndex(PORT, false, false, true);
  const i2 = tools.ensureIndex(PORT, false, false, true);
  const b = tools._freshness();
  return { ok: a.revalidations === b.revalidations && i1 === i2,
           detail: `revalidations ${a.revalidations} -> ${b.revalidations}, reuse ${i1 === i2}` };
});

// 8. ⭐ 가리키는 것이 없는 로드 경로를 **이름까지** 답해야 한다.
//    실측(2026-08-28, 라이브 Unity): 에셋 하나를 옮기니 컴파일러도 콘솔도 침묵하고
//    `pathLoadUnresolved` 만 2 -> 3 이 됐다. 개수만 있으면 어느 파일이 깨졌는지 알 수 없다.
//    이 프로젝트에는 실제로 2건 있다(`EffectSystemSetup.cs` 가 없어진 VFX 프리팹 둘을 부른다).
check('깨진 로드 경로를 개수가 아니라 목록으로 낸다', () => {
  const d = JSON.parse(tools.callLocalTool('unity_index_status', {}, PORT).content[0].text);
  const unresolved = (d.stats && d.stats.pathLoadUnresolved) || 0;
  const list = d.danglingLoads || [];
  if (!unresolved) return { ok: false, detail: 'pathLoadUnresolved 가 0 이다 — 표본이 없다' };
  const shaped = list.every(x => x && typeof x.file === 'string' && typeof x.path === 'string' && x.kind);
  const counted = list.length + (d.danglingLoadsOmitted || 0);
  return { ok: shaped && counted === unresolved && !!d.danglingLoadsNote,
           detail: `unresolved ${unresolved} / 목록 ${list.length}(+생략 ${d.danglingLoadsOmitted || 0}) / 형태 ${shaped}` };
});

// 9. 상수가 상수로 만들어지는 로드 경로도 해석돼야 한다.
//    `const string CatalogPath = CatalogFolder + "/EffectCatalog.asset";` 형태를 못 접으면
//    그 호출이 "동적" 으로 과대 분류되고, 그 에셋의 영향 분석에서 로더가 사라진다.
//    독립 검증 3차가 `EffectSystemSetup.cs:62` 로 짚었다.
check('상수로 조립된 로드 경로가 해석된다', () => {
  const d = JSON.parse(tools.callLocalTool(
    'unity_impact_analysis', { target: 'Assets/9.ScriptableObject/Effects/EffectCatalog.asset' }, PORT).content[0].text);
  const loads = (d.code && d.code.pathLoads) || [];
  return { ok: loads.some(x => /EffectSystemSetup[.]cs$/.test(x)),
           detail: 'pathLoads=' + JSON.stringify(loads) };
});

// 10. ⭐ GUID 가 아예 없는 컴포넌트(`m_Script: {fileID: 0}`)를 개수로라도 답해야 한다.
//     Missing Script 조인은 GUID 를 찾으므로 이 형태를 **원리적으로** 못 본다.
//     2026-08-28 에 정리 작업을 하다가 발견했다: `DefaultVolumeProfile.asset` 에 5건 있는데
//     도구는 "Missing Script 14건" 만 말하고 있었다.
//     기대값을 박지 않는다 — 소스를 직접 다시 세서 도구와 맞춘다(다른 경로로 구한 답, §4-(31)).
check('GUID 없는 컴포넌트를 세어 답한다 (독립 재집계와 일치)', () => {
  const fs2 = require('fs');
  const idx2 = tools.ensureIndex(PORT, false, false, true);
  const RE = /m_Script:\s*\{fileID:\s*0\s*\}/g;
  let mine = 0;
  for (const p of idx2.guidToPath.values()) {
    if (!/[.](asset|prefab|unity|mat|controller|playable|vfx)$/i.test(p)) continue;
    let text;
    try { text = fs2.readFileSync('C:/Unity/MainProject/' + p, 'latin1'); } catch { continue; }
    RE.lastIndex = 0;
    while (RE.exec(text) !== null) mine++;
  }
  const d = JSON.parse(tools.callLocalTool('unity_find_missing_scripts', {}, PORT).content[0].text);
  const told = d.scriptlessComponentCount || 0;
  // 0 이면 이 프로젝트에 그 형태가 없다는 뜻이다 — 그때도 두 수가 같아야 한다.
  return { ok: told === mine, detail: `도구 ${told} vs 독립 재집계 ${mine}` };
});

console.log(`\n${pass}/${pass + fail}`);
process.exit(fail === 0 ? 0 : 1);
