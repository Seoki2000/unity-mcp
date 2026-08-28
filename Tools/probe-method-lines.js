#!/usr/bin/env node
// 메서드 위치(PDB SequencePoints) 인수 프로브.
//
// §4-(22): 구현보다 먼저 쓴다.
// §4-(25): 소비자 없는 능력을 만들지 않는다. 이 축의 즉시 소비자는
//          "Unit::TakeDamage 는 선언이 둘인데 응답이 그걸 구체적으로 말하지 않는다" 이다.
//          find_callers 의 오버로드 문구는 지금 **정적 상투구**라, 선언이 하나뿐인
//          메서드에도 똑같이 붙어 진짜 경고를 희석시킨다.
//
// 오프라인 전용.

const path = require('path');
const fs = require('fs');
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

function methodsOf(type) {
  const r = tools.callLocalTool('unity_get_type_symbols', { type }, PORT);
  const d = JSON.parse(r.content[0].text);
  const td = (d.types && d.types[0]) || d;
  return { td, methods: td.methods || [] };
}

console.log('\n메서드 위치 — PDB SequencePoints');

// 1. 위치가 인덱스에 실린다.
check('메서드에 소스 위치가 실린다', () => {
  const { methods } = methodsOf('Unit');
  const withLine = methods.filter(m => typeof m.line === 'number');
  return { ok: withLine.length > 0, detail: `${withLine.length}/${methods.length} 개에 line` };
});

// 2. ⭐ 즉시 소비자. 두 선언이 구별돼야 한다.
check('Unit::TakeDamage 두 선언이 서로 다른 줄이다', () => {
  const { methods } = methodsOf('Unit');
  const td = methods.filter(m => m.name === 'TakeDamage');
  if (td.length < 2) return { ok: false, detail: `선언 ${td.length}개 — 표본이 안 맞다` };
  const lines = td.map(m => m.line);
  return { ok: new Set(lines).size === lines.length && lines.every(l => typeof l === 'number'),
           detail: `lines=${JSON.stringify(lines)}` };
});

// 3. 디스크 독립 대조 — 그 줄 근처에 실제로 그 이름이 있는가.
check('줄번호가 디스크의 소스와 맞다 (표본 20)', () => {
  const seen = [];
  for (const name of ['Unit', 'GameManager', 'BombAction']) {
    let m;
    try { m = methodsOf(name); } catch { continue; }
    const file = (m.td.sourceFiles || [])[0];
    if (!file) continue;
    const abs = path.isAbsolute(file) ? file : path.join('C:/Unity/MainProject', file);
    if (!fs.existsSync(abs)) continue;
    const src = fs.readFileSync(abs, 'utf8').split(/\r?\n/);
    for (const mm of m.methods) {
      if (typeof mm.line !== 'number' || seen.length >= 20) continue;
      if (mm.name.startsWith('<') || mm.name.startsWith('.')) continue;
      const bare = mm.name.replace(/^(get_|set_)/, '');
      let found = false;
      for (let k = Math.max(1, mm.line - 6); k <= Math.min(src.length, mm.line); k++)
        if ((src[k - 1] || '').includes(bare)) { found = true; break; }
      seen.push({ name: mm.name, line: mm.line, found });
    }
  }
  const bad = seen.filter(x => !x.found);
  return { ok: seen.length >= 5 && bad.length === 0,
           detail: `${seen.length - bad.length}/${seen.length} 일치` + (bad.length ? ` 불일치 ${JSON.stringify(bad.slice(0,3))}` : '') };
});

// 4. 없는 것은 null 이다. 0 으로 채우면 1번 줄을 가리키는 거짓말이 된다.
check('시퀀스 포인트 없는 메서드는 line 이 null (0 이 아니다)', () => {
  let nulls = 0, zeros = 0, total = 0, withLine = 0;
  for (const t of ['Unit', 'GameManager']) {
    for (const m of methodsOf(t).methods) {
      total++;
      if (m.line === null) nulls++;
      else if (typeof m.line === 'number') withLine++;
      if (m.line === 0) zeros++;
    }
  }
  // 처음엔 `zeros === 0` 만 봤다 — 그러면 **모든 메서드에 line 이 없어도 통과한다**
  // (감사 지적). 실제로 line 이 붙은 것이 있을 것도 함께 요구한다.
  return { ok: zeros === 0 && withLine > 0 && nulls > 0,
           detail: `total=${total}, line 있음=${withLine}, null=${nulls}, zero=${zeros}` };
});

// 5. 오버로드 경고가 구체적이어야 한다.
check('find_callers 가 실제 선언 수를 말한다', () => {
  const r = tools.callLocalTool('unity_find_callers', { method: 'Unit::TakeDamage' }, PORT);
  const d = JSON.parse(r.content[0].text);
  const note = d.note || '';
  return { ok: /2 declaration|선언 2|declarations \(/.test(note) || (d.declarations && d.declarations.length === 2),
           detail: d.declarations ? `declarations=${JSON.stringify(d.declarations)}` : note.slice(0, 90) };
});

// 6. 상투구 제거 - 선언이 하나면 오버로드 경고가 붙으면 안 된다.
//    대상을 추측하지 않고 **인덱스에서 선언이 정확히 1개인 메서드를 찾아** 쓴다.
//    처음엔 `BaseAttack::TryResolveHit` 를 단일 선언이라 가정했는데 디스크로 확인하니
//    실제 오버로드 4개였다(130/153/165/176행). 표본을 손으로 고르면 이런 일이 난다.
check('선언이 하나뿐이면 오버로드 경고가 안 붙는다', () => {
  const sym = idx.symbols;
  let target = null;
  for (const [full, info] of sym.typeByFullName) {
    if (!info || !Array.isArray(info.methods)) continue;
    const counts = new Map();
    for (const m of info.methods) counts.set(m.name, (counts.get(m.name) || 0) + 1);
    for (const m of info.methods) {
      if (counts.get(m.name) !== 1) continue;
      if (m.name.startsWith('<') || m.name.startsWith('.')) continue;
      const key = `${full}::${m.name}`;
      const r = tools.callLocalTool('unity_find_callers', { method: key }, PORT);
      const d = JSON.parse(r.content[0].text);
      if (d.error) continue;
      target = { key, note: d.note || '', declarations: d.declarations };
      break;
    }
    if (target) break;
  }
  if (!target) return { ok: false, detail: '단일 선언 메서드를 못 찾았다' };
  return { ok: !/merges \d+ declarations/.test(target.note) && target.declarations === undefined,
           detail: `${target.key} declarations=${target.declarations ? target.declarations.length : 'none'}` };
});

// 7. 경계 — 캐시 왕복에서 위치를 잃으면 안 된다.
//    전례가 있다: 캐시가 duplicateTypes 123개를 잃어 모호성이 사라졌다 (§4-(24)-2).
check('캐시 왕복에서 line 이 보존된다 (경계)', () => {
  const fresh = tools.ensureIndex(PORT, true, false);           // 신규 빌드 + 캐시 저장
  const a = methodsOf('Unit').methods.filter(m => typeof m.line === 'number').length;
  tools._dropIndexForTest ? tools._dropIndexForTest() : tools._forceStaleForTest();
  tools.ensureIndex(PORT, false, false, true);                   // 캐시에서 다시 로드
  const b = methodsOf('Unit').methods.filter(m => typeof m.line === 'number').length;
  return { ok: a > 0 && a === b, detail: `신규빌드 ${a} -> 캐시로드 ${b}` };
});

console.log(`\n${pass}/${pass + fail}`);
process.exit(fail === 0 ? 0 : 1);
