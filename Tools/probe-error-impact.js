#!/usr/bin/env node
// P3-b — 컴파일 진단을 인덱스와 조인한다 (`unity_explain_compile_errors`).
//
// §4-(22): 구현 전에 쓴다.
// §4-(25): A(기존 도구 응답 가공)가 아니라 별도 도구다. "컴파일 상태가 뭔가" 와
//          "이 오류들이 무엇을 건드리나" 는 다른 질문이고 실패 양상이 다르다.
//
// 형태: 진단을 **입력으로 받는 순수 로컬 조인.** Unity 로 왕복하지 않는다.
//   - 전송 계층 리팩터링이 필요 없다(독립 감사가 지목한 최대 위험)
//   - 도메인 리로드·30초 큐에 노출되지 않는다
//   - 대신 신선도를 **호출자가 넘긴 세대**와 인덱스 세대로 대조해 말해야 한다
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
const call = (a) => JSON.parse(tools.callLocalTool('unity_explain_compile_errors', a, PORT).content[0].text);

const idx = tools.ensureIndex(PORT, false, false, true);
if (!idx) { console.error('인덱스 캐시가 없다.'); process.exit(2); }

const ROOTDIR = 'C:/Unity/MainProject';
const BA = 'Assets/1.Scripts/Unit/Weapon/BaseAttack.cs';

console.log('\nP3-b — 진단 x 인덱스 조인');

// 1. 본문 안의 줄은 그 메서드로 정확히 귀속된다.
check('본문 안의 줄이 메서드로 정확히 귀속된다 (exact)', () => {
  const d = call({ errors: [{ file: BA, line: 140, message: 'CS0000: test' }] });
  const e = (d.errors || [])[0];
  return { ok: e && e.method && e.method.name === 'TryResolveHit' && e.method.containment === 'exact',
           detail: e && e.method ? `${e.method.name} (${e.method.containment}, line ${e.method.line})` : JSON.stringify(d).slice(0,120) };
});

// 2. ⭐ 시그니처 줄. 시퀀스 포인트는 본문부터라 130 은 어느 범위에도 안 들어간다.
//    조용히 못 찾았다고 하지 말고 **추정임을 밝히고** 다음 메서드로 귀속한다.
check('시그니처 줄이 inferred 로 귀속된다 (범위 밖)', () => {
  const d = call({ errors: [{ file: BA, line: 130, message: 'CS0000: signature' }] });
  const e = (d.errors || [])[0];
  return { ok: e && e.method && e.method.name === 'TryResolveHit' && e.method.containment === 'inferred',
           detail: e && e.method ? `${e.method.name} (${e.method.containment})` : 'method 없음' };
});

// 3. 오버로드가 있으면 어느 것인지 말해야 한다 — 이제 줄로 구분된다.
check('오버로드 중 어느 선언인지 지목한다', () => {
  const a = call({ errors: [{ file: BA, line: 140, message: 'x' }] }).errors[0];
  const b = call({ errors: [{ file: BA, line: 158, message: 'x' }] }).errors[0];
  return { ok: a.method && b.method && a.method.line !== b.method.line,
           detail: `140 -> line ${a.method && a.method.line} / 158 -> line ${b.method && b.method.line}` };
});

// 4. 타입과 호출자까지 조인된다 — 이게 이 도구의 존재 이유다.
check('타입과 호출자가 조인된다', () => {
  const e = call({ errors: [{ file: BA, line: 140, message: 'x' }] }).errors[0];
  return { ok: e.type && e.type.fullName === 'BaseAttack' && typeof e.callerCount === 'number',
           detail: `type=${e.type && e.type.fullName}, callers=${e.callerCount}` };
});

// 5. 인덱스에 없는 파일에 조용한 0 을 답하면 안 된다 (§4-(24)-1).
check('인덱스 밖 파일은 unresolved 다 (영향 0 이 아니다)', () => {
  const e = call({ errors: [{ file: 'Assets/Nope/DoesNotExist.cs', line: 1, message: 'x' }] }).errors[0];
  return { ok: e && e.resolution === 'unresolved' && !e.type,
           detail: `resolution=${e && e.resolution}` };
});

// 6. 출처를 분류한다 — 고칠 수 있는 자리인지가 갈린다.
check('패키지 경로를 출처로 분류한다', () => {
  const e = call({ errors: [{ file: 'Packages/com.unity.render-pipelines.universal/Runtime/X.cs', line: 5, message: 'x' }] }).errors[0];
  return { ok: e && e.origin && e.origin !== 'assets', detail: `origin=${e && e.origin}` };
});

// 7. ⭐ 신선도. 인덱스가 컴파일보다 낡았으면 **조인하지 말고 말해야 한다.**
//    컴파일 실패 시 Unity 는 ScriptAssemblies 를 갱신하지 않으므로, 인덱스는 직전 성공
//    빌드를 설명한다 — 정확히 필요한 순간에 낡는다(§4-(25)).
check('신선도를 응답이 싣는다', () => {
  const d = call({ errors: [{ file: BA, line: 140, message: 'x' }] });
  const f = d.freshness;
  return { ok: f && typeof f.indexBuiltAt !== 'undefined' && typeof f.state === 'string',
           detail: f ? JSON.stringify(f) : 'freshness 없음' };
});

// 8. 경계 — 빈 입력에 그럴듯한 답을 만들면 안 된다.
check('빈 errors 는 에러다 (0건 답이 아니다)', () => {
  const d = call({ errors: [] });
  return { ok: !!d.error, detail: d.error ? d.error.slice(0, 70) : JSON.stringify(d).slice(0, 70) };
});

// 9. 경계 — 상한. 오류 수백 건에 무한정 답하면 응답이 터진다.
check('상한을 넘으면 자르고 몇 개를 버렸는지 말한다', () => {
  const many = Array.from({ length: 300 }, (_, i) => ({ file: BA, line: 140, message: 'e' + i }));
  const d = call({ errors: many });
  return { ok: d.errors && d.errors.length < 300 && typeof d.omittedCount === 'number' && d.omittedCount > 0,
           detail: `returned=${d.errors && d.errors.length}, omitted=${d.omittedCount}` };
});

// 10. 절대 경로도 받아야 한다. 컴파일러는 절대 경로를 낸다.
check('컴파일러가 내는 절대 경로를 정규화한다', () => {
  const e = call({ errors: [{ file: ROOTDIR + '/' + BA, line: 140, message: 'x' }] }).errors[0];
  return { ok: e && e.type && e.type.fullName === 'BaseAttack',
           detail: `resolution=${e && e.resolution}, type=${e && e.type && e.type.fullName}` };
});

// 11. 경계 — ⭐ 붙은 에셋 수가 실제와 맞는가.
//     처음 구현은 `index.scriptUsers` 를 읽었는데 그런 맵은 없다(이름은 `scriptRefs`).
//     그래서 붙은 에셋이 몇 개든 **조용히 0 을 답했다.** 4번이 type/callerCount 만
//     검사해서 통과시켰다 — 축을 하나 더 실었으면 그 축도 검사해야 한다(§4-(21)).
check('붙은 에셋 수가 인덱스와 일치한다 (왕복)', () => {
  // 붙은 에셋이 실제로 있는 .cs 를 인덱스에서 찾는다(표본을 추측하지 않는다).
  let picked = null;
  for (const [guid, users] of (idx.scriptRefs || new Map())) {
    const p = idx.guidToPath.get(guid);
    if (!p || !p.endsWith('.cs')) continue;
    if (!idx.symbols.typesBySourceFile.get(p)) continue;
    if (users.size > 0) { picked = { path: p, expect: users.size }; break; }
  }
  if (!picked) return { ok: false, detail: '붙은 에셋이 있는 .cs 를 못 찾았다' };
  const e = call({ errors: [{ file: picked.path, line: 1, message: 'x' }] }).errors[0];
  return { ok: e.attachedAssetCount === picked.expect,
           detail: `${picked.path.split('/').pop()}: 응답 ${e.attachedAssetCount} vs 인덱스 ${picked.expect}` };
});

console.log(`\n${pass}/${pass + fail}`);
process.exit(fail === 0 ? 0 : 1);
