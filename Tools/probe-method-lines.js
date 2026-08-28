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

// ── 전수 불변식 (2026-08-28) ───────────────────────────────────────────────
// 왜 추가하나 — 프로브 3은 **타입 3개에서 앞 20개**를 봤고 전부 통과했다. 그런데
// 매핑된 560 파일 7,691개 메서드를 전수로 대조하니 **27.4% 가 선언 줄과 안 맞고**,
// 겹치는 범위 3,036쌍, **음수 줄번호**까지 있었다(`ProfilerWindow::LinkBtn -8043`).
// 표본이 통과했다는 것이 전수의 증거가 아니다. 그래서 전수 불변식을 박는다.
// 재현 스크립트: scratchpad/measure-span-sanity.js

function allSpans() {
  const sym = idx.symbols;
  const out = [];
  for (const [file, names] of sym.typesBySourceFile) {
    for (const fn of names) {
      const info = sym.typeByFullName.get(fn);
      const files = (info && info.sourceFiles) || [];
      for (const m of ((info && info.methods) || [])) {
        if (typeof m.line !== 'number') continue;
        // 부분 클래스는 파일이 여럿이다. 다른 파일의 메서드를 이 파일에 세면 안 된다.
        if (typeof m.fileIndex === 'number' && files[m.fileIndex] && files[m.fileIndex] !== file) continue;
        out.push({ file, type: fn, name: m.name, line: m.line,
                   endLine: typeof m.endLine === 'number' ? m.endLine : m.line });
      }
    }
  }
  return out;
}
// 컴파일러가 만든 것(`<...>`, `.ctor`)은 소스에 선언이 없으므로 대조 대상이 아니다.
const isSourceDeclared = (s) => !s.name.startsWith('<') && !s.name.startsWith('.') && !s.type.includes('<');

// 8. 줄번호는 1 이상이다. 음수·0 은 디코딩이 깨졌다는 증거다.
check('모든 줄번호가 1 이상이다 (전수)', () => {
  const spans = allSpans();
  const bad = spans.filter(s => s.line < 1 || s.endLine < s.line);
  return { ok: spans.length > 1000 && bad.length === 0,
           detail: `${spans.length}개 중 이상 ${bad.length}` +
                   (bad.length ? ` — 예: ${bad.slice(0, 3).map(b => `${b.type}::${b.name} ${b.line}-${b.endLine}`).join(' / ')}` : '') };
});

// 9. 같은 파일의 서로 다른 메서드 범위가 겹치면 둘 중 하나는 틀렸다.
//    같은 줄에서 시작하는 것(자동 프로퍼티의 get_/set_)은 정상이므로 뺀다.
check('메서드 범위가 겹치지 않는다 (전수)', () => {
  const byFile = new Map();
  for (const s of allSpans().filter(isSourceDeclared)) {
    if (!byFile.has(s.file)) byFile.set(s.file, []);
    byFile.get(s.file).push(s);
  }
  let pairs = 0; const samples = [];
  for (const [file, list] of byFile) {
    list.sort((a, b) => a.line - b.line);
    for (let i = 0; i < list.length; i++) for (let j = i + 1; j < list.length; j++) {
      if (list[j].line === list[i].line) continue;               // 같은 줄 시작은 정상
      if (list[j].line > list[i].endLine) break;
      pairs++;
      if (samples.length < 3) samples.push(`${file.split('/').pop()} ${list[i].name} ${list[i].line}-${list[i].endLine} x ${list[j].name} ${list[j].line}-${list[j].endLine}`);
    }
  }
  return { ok: pairs === 0, detail: `겹친 쌍 ${pairs}` + (samples.length ? ` — ${samples.join(' / ')}` : '') };
});

/**
 * 본문 시작에서 위로 올라가며 그 멤버의 선언을 찾는다.
 *
 * 8줄 고정으로 재면 **데이터가 아니라 이 검사가 틀린다** — 실측으로 139건이 그랬다:
 * 여러 줄에 걸친 시그니처(`PlayerMotionSweep::Resolve` 는 파라미터가 4줄) ·
 * 선언 위의 긴 주석 블록 · `op_Addition` 처럼 소스에 `operator +` 로 적히는 이름 ·
 * `private set { }` 처럼 접근자 키워드만 있는 줄. 전부 줄 범위는 맞았다.
 * 그리고 로컬 함수를 품은 메서드는 **자기 첫 문장이 로컬 함수 뒤**에 온다
 * (`SlotAuthoringModel::LayoutsForRole` 은 선언 98 / 첫 시퀀스 포인트 108, 사이가 로컬 함수).
 * 그래서 위로 40줄을 훑고 닫는 괄호에서 멈추지 않는다. 명시적 인터페이스 구현은 이름에
 * 인터페이스가 붙으므로(`Ami.BroAudio.IMusicDecoratable.AsBGM`) 마지막 마디만 쓴다.
 *
 * ⚠️ 이 검사의 한계: 40줄 안에 같은 이름의 **호출**이 있으면 통과할 수 있다. 즉
 * ±몇 줄 오차는 못 잡는다. 디코딩 붕괴(수십 줄·음수)를 잡는 것이 목적이고, 더 날카로운
 * 것은 프로브 8(음수)과 9(겹침)다.
 */
function declFoundNear(src, name, bodyLine) {
  if (/^op_/.test(name)) return true;          // 소스에 `operator +` 로 적힌다 — 이름 대조 불가
  // 마지막 마디를 먼저 떼고(명시적 인터페이스 구현) 그 다음 접근자 접두사를 뗀다 —
  // 순서를 바꾸면 `IAudioPlayer.get_AudioSource` 가 `get_AudioSource` 로 남아 안 맞는다.
  const last = name.split('.').pop();
  const acc = last.match(/^(get|set|add|remove)_/);
  const bare = last.replace(/^(get_|set_|add_|remove_)/, '');
  for (let k = bodyLine, n = 0; k >= 1 && n < 40; k--, n++) {
    const t = src[k - 1] || '';
    if (t.includes(bare)) return true;
    const tt = t.trim();
    if (acc && new RegExp('(^|[^A-Za-z_])' + acc[1] + '\\s*(\\{|=>|;)').test(tt)) return true;
  }
  return false;
}

// 10. ⭐ 전수 디스크 대조. 본문 시작 위에 그 멤버의 선언이 실제로 있어야 한다.
check('본문 시작 위에 선언이 있다 (전수 디스크 대조)', () => {
  const bySrc = new Map();
  let ok = 0, ng = 0; const samples = [];
  for (const s of allSpans().filter(isSourceDeclared)) {
    if (!bySrc.has(s.file)) {
      let src = null;
      try { src = fs.readFileSync(path.join('C:/Unity/MainProject', s.file), 'utf8').split(/\r?\n/); } catch { src = null; }
      bySrc.set(s.file, src);
    }
    const src = bySrc.get(s.file);
    if (!src) continue;
    if (declFoundNear(src, s.name, s.line)) ok++;
    else { ng++; if (samples.length < 3) samples.push(`${s.file.split('/').pop()}:${s.line} ${s.type}::${s.name}`); }
  }
  const rate = ng * 100 / (ok + ng || 1);
  return { ok: ok + ng > 1000 && rate < 1,
           detail: `${ok}/${ok + ng} 일치, 불일치 ${ng} (${rate.toFixed(2)}%)` + (samples.length ? ` — ${samples.join(' / ')}` : '') };
});

// 11. 재현 — 이 버그를 처음 드러낸 자리. 람다를 품은 메서드의 범위가 밀렸다.
check('람다를 품은 메서드의 범위가 선언 뒤에 온다 (재현)', () => {
  const file = 'Assets/1.Scripts/Editor/BuildWindowsPlayer.cs';
  const names = idx.symbols.typesBySourceFile.get(file);
  if (!names) return { ok: false, detail: '인덱스에 그 파일이 없다' };
  let span = null;
  for (const fn of names) {
    const info = idx.symbols.typeByFullName.get(fn);
    for (const m of ((info && info.methods) || [])) if (m.name === 'Validate' && typeof m.line === 'number') span = m;
  }
  if (!span) return { ok: false, detail: 'Validate 의 줄 정보가 없다' };
  const src = fs.readFileSync(path.join('C:/Unity/MainProject', file), 'utf8').split(/\r?\n/);
  const decl = src.findIndex(t => /\bbool\s+Validate\s*\(/.test(t)) + 1;
  return { ok: decl > 0 && span.line >= decl && span.line <= decl + 3,
           detail: `선언 ${decl} / 인덱스 본문 ${span.line}-${span.endLine}` };
});

console.log(`\n${pass}/${pass + fail}`);
process.exit(fail === 0 ? 0 : 1);
