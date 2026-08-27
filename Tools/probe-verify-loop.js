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

const idx = tools.ensureIndex(PORT, false, false, true);
if (!idx) {
  console.error('인덱스 캐시가 없다. 먼저 질의를 한 번 돌려 캐시를 만들 것.');
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

console.log(`\n${pass}/${pass + fail}`);
process.exit(fail === 0 ? 0 : 1);
