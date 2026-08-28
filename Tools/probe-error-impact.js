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
// 파일별 메서드 범위를 만드는 자리를 직접 검사한다(프로브 20). 도구 응답만으로는
// "다른 파일의 메서드가 이 파일 뷰에 섞였다" 를 전수로 볼 수 없다.
const ei = require(path.join(ROOT, 'Bridge/index/errorimpact'));

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

// 2. ⭐ 범위 밖의 줄을 **조용히 버리지 않는다.**
//    시퀀스 포인트는 본문부터라 시그니처 줄은 어느 [line, endLine] 에도 없다.
//    처음엔 이 자리를 전부 `inferred` 로 냈고, 나중에 소스에서 선언 줄을 찾아
//    `signature` / `gap` 으로 쪼갰다(프로브 12·13). 여기서 요구하는 것은 그 세부가
//    아니라 **메서드가 null 이 아니고 exact 를 사칭하지 않는다**는 것이다.
check('범위 밖의 줄도 메서드에 귀속되고 exact 를 사칭하지 않는다', () => {
  const d = call({ errors: [{ file: BA, line: 130, message: 'CS0000: signature' }] });
  const e = (d.errors || [])[0];
  const m = e && e.method;
  return { ok: !!m && m.name === 'TryResolveHit' && m.containment !== 'exact' && !!m.containmentNote,
           detail: m ? `${m.name} (${m.containment}), note ${m.containmentNote ? '있음' : '없음'}` : 'method 없음' };
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
  // `!!d.error` 만 보면 **어떤 에러든** 통과한다 - 도구가 아예 없을 때의
  // "Unknown local tool" 로도 초록불이 켜졌다(§4-(27)). 그 에러여야 한다고 요구한다.
  const right = !!d.error && /errors is required/.test(d.error) && /different states/.test(d.error);
  return { ok: right, detail: d.error ? d.error.slice(0, 70) : JSON.stringify(d).slice(0, 70) };
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

// 12. 시그니처 줄을 `signature` 로 승급한다 — 예전엔 전부 `inferred` 였다.
//     실측(표본 276): 본문시작 - 선언줄 거리는 중앙 2 / 최대 5. 위로 8줄 훑으면 덮인다.
check('시그니처 줄이 signature 로 승급된다', () => {
  const e = call({ errors: [{ file: BA, line: 130, message: 'CS0000: sig' }] }).errors[0];
  const m = e.method;
  return { ok: m && m.containment === 'signature' && m.declLine === 130,
           detail: m ? `${m.name} (${m.containment}, decl ${m.declLine}, body ${m.line})` : 'method 없음' };
});

// 13. 메서드와 무관한 줄은 `gap` 이다 — 승급하지 않는다.
//     ⚠️ 예전엔 line 1(= `using`)로 검사했다. 그 줄은 이제 file-level 이라 method 가 null 이다
//     (프로브 15). 그래서 **타입 선언 줄**로 바꿨다 — 여전히 gap 이고 승급하지 않아야 한다.
check('타입 선언 줄은 gap 이고 승급하지 않는다', () => {
  const src = fs.readFileSync(path.join(ROOTDIR, BA), 'utf8').split(String.fromCharCode(10));
  const L = src.findIndex(t => /\b(class|struct)\s+BaseAttack\b/.test(t)) + 1;
  if (!L) return { ok: false, detail: 'BaseAttack 선언 줄을 못 찾았다' };
  const e = call({ errors: [{ file: BA, line: L, message: 'x' }] }).errors[0];
  const m = e.method;
  return { ok: !!m && m.containment === 'gap' && e.lineKind === 'type-declaration',
           detail: m ? `line ${L} -> ${m.name} (${m.containment}), lineKind=${e.lineKind}` : 'method 없음' };
});

// 14. 경계 — 확신도가 네 값 중 하나여야 한다. 새 값이 조용히 새면 읽는 쪽이 모른다.
check('확신도가 exact/signature/gap 중 하나다 (경계)', () => {
  // ⚠️ line 1 이 file-level 이 되면서 이 표본에서 gap 이 사라졌다 — 이름이 gap 을 말하는데
  // 관측하지 않는 검사가 된다(§4-(31) 의 형태). 타입 선언 줄을 표본에 넣어 gap 을 되살린다.
  const decl = fs.readFileSync(path.join(ROOTDIR, BA), 'utf8')
                 .split(String.fromCharCode(10)).findIndex(t => /\b(class|struct)\s+BaseAttack\b/.test(t)) + 1;
  const lines = [140, 130, 128, 1, 45, 200, 9999, decl];
  const seen = new Set();
  for (const L of lines) {
    const m = call({ errors: [{ file: BA, line: L, message: 'x' }] }).errors[0].method;
    if (m) seen.add(m.containment);
  }
  const allowed = new Set(['exact', 'signature', 'gap']);
  const bad = [...seen].filter(x => !allowed.has(x));
  return { ok: bad.length === 0 && seen.size >= 2 && seen.has('gap'),
           detail: `관측된 값: ${[...seen].join(', ')}` + (bad.length ? ` / 허용 밖: ${bad.join(',')}` : '') };
});

// ── gap 줄이기 (2026-08-28) ────────────────────────────────────────────────
// 실측 먼저(구현 전에 쓴다 — §4-(22)): 매핑된 소스 559 파일 45,629 코드 줄을 귀속하니
//   exact 32,995 (72.3%) / signature 3,363 (7.4%) / **gap 8,887 (19.5%)** / 없음 384.
// gap 8,887 의 구성: 필드·문장 2,943(33.1%) · using·namespace 2,095(23.6%) ·
//   속성 1,397(15.7%) · 타입선언 728(8.2%) · 시그니처꼴 692(7.8%) · 기타 652 · 전처리기 380.
// 즉 gap 의 4분의 1 이상은 **메서드와 아무 상관이 없는 파일 수준 줄**인데 "바로 다음
// 메서드" 로 붙고 있었다.

// 15. ⭐ 파일 수준 줄은 메서드에 귀속하지 않는다. 붙이면 거짓 힌트다.
check('using 줄은 메서드에 귀속하지 않는다 (file-level)', () => {
  const src = fs.readFileSync(path.join(ROOTDIR, BA), 'utf8').split(String.fromCharCode(10));
  const L = src.findIndex(t => /^using\s+[A-Za-z_@]/.test(t.trim())) + 1;   // 줄번호를 추측하지 않는다
  if (!L) return { ok: false, detail: 'using 줄을 못 찾았다' };
  const e = call({ errors: [{ file: BA, line: L, message: 'CS0246: 없는 타입' }] }).errors[0];
  return { ok: e.lineKind === 'file-level' && e.method === null && !!e.methodNote,
           detail: `line ${L} -> lineKind=${e.lineKind}, method=${e.method === null ? 'null' : (e.method && e.method.name)}` };
});

// 16. ⭐ 필드 선언 줄은 **인덱스의 필드와 조인**된다. 다른 경로로 구한 답과 맞춘다(§4-(31)).
//     표본은 추측하지 않고 인덱스 -> 소스 순서로 찾는다(§4-(27)).
check('필드 선언 줄이 필드로 조인된다 (타입 심볼과 왕복)', () => {
  const pick = pickFieldDeclLine();
  if (!pick) return { ok: false, detail: '조건에 맞는 (파일, 필드) 를 못 찾았다' };
  const e = call({ errors: [{ file: pick.file, line: pick.line, message: 'CS0246: x' }] }).errors[0];
  const m = e.member;
  return { ok: e.lineKind === 'field-declaration' && !!m && m.kind === 'field' &&
               m.name === pick.field && m.type === pick.type,
           detail: `${pick.file.split('/').pop()}:${pick.line} ${pick.field} -> ` +
                   `lineKind=${e.lineKind}, member=${m ? m.name + ':' + m.type : 'null'} (기대 ${pick.field}:${pick.type})` };
});

// 17. 속성 줄은 **타입 속성**과 **멤버 속성**을 가른다 — 무엇이 깨지는지가 다르다.
check('타입 속성과 멤버 속성을 구분한다', () => {
  const t = pickAttributeLine(true), mm = pickAttributeLine(false);
  if (!t || !mm) return { ok: false, detail: `표본 없음 (타입 ${!!t}, 멤버 ${!!mm})` };
  const a = call({ errors: [{ file: t.file, line: t.line, message: 'x' }] }).errors[0];
  const b = call({ errors: [{ file: mm.file, line: mm.line, message: 'x' }] }).errors[0];
  return { ok: a.lineKind === 'type-attribute' && b.lineKind === 'member-attribute',
           detail: `타입 ${t.file.split('/').pop()}:${t.line} -> ${a.lineKind} / ` +
                   `멤버 ${mm.file.split('/').pop()}:${mm.line} -> ${b.lineKind}` };
});

// 18. 분류가 실제로 gap 을 덮는가. 덮지 못하면 이름만 붙인 것이다.
//     표본은 파일 순서대로 앞 40개 파일에서 exact 가 아닌 줄 전부 — 고르지 않는다.
check('exact 아닌 줄의 절반 이상이 unknown 이 아니다 (모집단 검사)', () => {
  const rows = [];
  const files = [...idx.symbols.typesBySourceFile.keys()].filter(f => f.startsWith('Assets/')).slice(0, 40);
  for (const f of files) {
    let src; try { src = fs.readFileSync(path.join(ROOTDIR, f), 'utf8').split(String.fromCharCode(10)); } catch { continue; }
    for (let i = 1; i <= src.length; i++) {
      const s = src[i - 1].trim();
      if (!s || s.startsWith('//') || s === '{' || s === '}') continue;
      rows.push({ file: f, line: i, message: 'x' });
    }
  }
  let total = 0, unknown = 0;
  for (let k = 0; k < rows.length; k += 50) {
    for (const e of (call({ errors: rows.slice(k, k + 50) }).errors || [])) {
      if (e.method && e.method.containment === 'exact') continue;      // 이미 확실한 자리
      total++;
      if (!e.lineKind || e.lineKind === 'unknown') unknown++;
    }
  }
  const covered = total - unknown;
  return { ok: total > 100 && covered >= total / 2,
           detail: `exact 아닌 줄 ${total} 중 분류됨 ${covered} (${(covered * 100 / (total || 1)).toFixed(1)}%)` };
});

// 19. 경계 — lineKind 값이 조용히 새면 읽는 쪽이 모른다. 그리고 **member 는 인덱스에
//     실제 필드가 있을 때만** 실려야 한다(추측 금지).
check('lineKind 가 허용된 값이고 member 를 지어내지 않는다 (경계)', () => {
  const src = fs.readFileSync(path.join(ROOTDIR, BA), 'utf8').split(String.fromCharCode(10));
  const rows = src.map((_, i) => ({ file: BA, line: i + 1, message: 'x' })).slice(0, 50);
  const allowed = new Set(['in-method-body', 'file-level', 'type-attribute', 'member-attribute',
                           'type-declaration', 'field-declaration', 'blank-or-comment', 'unknown']);
  const fieldNames = new Set();
  for (const fn of (idx.symbols.typesBySourceFile.get(BA) || [])) {
    const info = idx.symbols.typeByFullName.get(fn);
    for (const f of ((info && info.fields) || [])) fieldNames.add(f.name);
  }
  const kinds = new Set();
  let fabricated = 0;
  for (const e of (call({ errors: rows }).errors || [])) {
    if (e.lineKind) kinds.add(e.lineKind);
    if (e.member && !fieldNames.has(e.member.name)) fabricated++;
  }
  const bad = [...kinds].filter(x => !allowed.has(x));
  return { ok: bad.length === 0 && fabricated === 0 && kinds.size >= 2,
           detail: `관측 ${[...kinds].join(', ')}` + (bad.length ? ` / 허용 밖 ${bad.join(',')}` : '') +
                   ` / 지어낸 member ${fabricated}` };
});

// 20. ⭐ 전수 — 같은 메서드가 **두 파일 뷰에 동시에** 나오면 한쪽은 남의 파일 것이다.
//     독립 검증(2026-08-28)이 두 경로를 짚었다: ① Document 컬럼이 0 인 `.ctor` 5개가
//     부분 클래스의 모든 파일 뷰에 나왔다(22 span) ② 전체 이름이 겹쳐 한 레코드만 남은
//     타입(`<>c`·`<>c__DisplayClassN`, 자기 코드의 `PassData`)의 람다 범위가 남의 파일로
//     새어 15건. 둘 다 응답이 "이 줄은 저 메서드다" 라고 **확신 있게 틀리는** 자리다.
check('같은 메서드가 두 파일 뷰에 동시에 나오지 않는다 (전수)', () => {
  const seen = new Map();
  for (const file of idx.symbols.typesBySourceFile.keys()) {
    for (const s of ei.methodSpansForFile(idx, file)) {
      const k = `${s.typeFullName}::${s.name}@${s.line}`;
      if (!seen.has(k)) seen.set(k, new Set());
      seen.get(k).add(file);
    }
  }
  const multi = [...seen].filter(([, f]) => f.size > 1);
  return { ok: seen.size > 1000 && multi.length === 0,
           detail: `범위 ${seen.size}개 중 다중 파일뷰 ${multi.length}` +
                   (multi.length ? ` — 예: ${multi.slice(0, 2).map(([k, f]) => `${k} (${f.size}개 파일)`).join(' / ')}` : '') };
});

// 21. ⭐ 본문 안의 줄은 분류하지 않는다. 처음엔 전부 분류해서 본문의 `damage += 1;` 이
//     `field-declaration` 으로 나갔다 — 독립 검증이 정밀도 18.8% 로 측정했고 오차의
//     거의 전부가 본문 줄이었다(12,534건).
check('본문 안의 줄에 field-declaration 을 붙이지 않는다 (모집단)', () => {
  const rows = [];
  const files = [...idx.symbols.typesBySourceFile.keys()].filter(f => f.startsWith('Assets/')).slice(0, 25);
  for (const f of files) {
    let src; try { src = fs.readFileSync(path.join(ROOTDIR, f), 'utf8').split(String.fromCharCode(10)); } catch { continue; }
    for (let i = 1; i <= src.length; i++) rows.push({ file: f, line: i, message: 'x' });
  }
  let body = 0, bad = 0; const samples = [];
  for (let k = 0; k < rows.length; k += 50) {
    for (const e of (call({ errors: rows.slice(k, k + 50) }).errors || [])) {
      if (!e.method || e.method.containment !== 'exact') continue;
      // 생성자 범위는 예외다 — 필드 초기화자가 그 안에 있으므로 분류를 돌린다(프로브 22).
      if (/^\.c?ctor$/.test(e.method.name)) continue;
      body++;
      if (e.lineKind !== 'in-method-body' || e.member) {
        bad++;
        if (samples.length < 3) samples.push(`${e.file.split('/').pop()}:${e.line} ${e.lineKind}${e.member ? ' +member' : ''}`);
      }
    }
  }
  return { ok: body > 200 && bad === 0,
           detail: `본문 줄 ${body} 중 다른 kind ${bad}` + (samples.length ? ` — ${samples.join(' / ')}` : '') };
});

// ── 독립 검증 2차가 짚은 것 (2026-08-28) ─────────────────────────────────
// `exact` 를 무조건 `in-method-body` 로 처리한 것이 너무 뭉툭했다. 시퀀스 포인트는
// **필드 초기화자**에도 붙는다(`.ctor`/`.cctor` 범위). 그래서 진짜 필드 선언 2,417줄이
// `in-method-body` 로 나가며 필드 정보가 사라졌다. 그리고 필드 이름이 줄에 있는지만
// 봤으므로 **메서드 시그니처의 파라미터 이름**이 필드로 잡혔다(정밀도 83.3%).

// 22. ⭐ 필드 초기화자 줄은 `.cctor` 범위 안이어도 필드로 답해야 한다.
check('정적 필드 초기화자 줄이 field-declaration 으로 나온다 (재현)', () => {
  const f = 'Assets/1.Scripts/Dev/Editor/DevBuildSceneList.cs';
  const src = fs.readFileSync(path.join(ROOTDIR, f), 'utf8').split(String.fromCharCode(10));
  const L = src.findIndex(t => /DevScenes\s*=\s*$/.test(t.trim())) + 1;   // 줄번호를 추측하지 않는다
  if (!L) return { ok: false, detail: 'DevScenes 초기화자 줄을 못 찾았다' };
  const e = call({ errors: [{ file: f, line: L, message: 'CS0246: x' }] }).errors[0];
  return { ok: e.lineKind === 'field-declaration' && e.member && e.member.name === 'DevScenes',
           detail: `line ${L} -> lineKind=${e.lineKind}, member=${e.member ? e.member.name : 'null'}, ` +
                   `containment=${e.method ? e.method.containment + ' in ' + e.method.name : 'null'}` };
});

// 23. ⭐ 메서드 시그니처 줄을 필드로 답하면 안 된다. 파라미터 이름이 다른 타입의 필드와
//     같은 이름일 수 있다(실측 반례: `TryStart(string name, ...)` 가 `Cat.name` 으로 나갔다).
check('메서드 시그니처 줄을 field-declaration 이라고 하지 않는다 (재현)', () => {
  const f = 'Assets/1.Scripts/Dev/Profiler/Editor/ProfilerWindow.cs';
  const src = fs.readFileSync(path.join(ROOTDIR, f), 'utf8').split(String.fromCharCode(10));
  const L = src.findIndex(t => /ProfilerRecorder\s+TryStart\s*\(/.test(t)) + 1;
  if (!L) return { ok: false, detail: 'TryStart 시그니처 줄을 못 찾았다' };
  const e = call({ errors: [{ file: f, line: L, message: 'CS0246: x' }] }).errors[0];
  return { ok: e.lineKind !== 'field-declaration' && !e.member,
           detail: `line ${L} -> lineKind=${e.lineKind}, member=${e.member ? e.member.name : 'null'}` };
});

// 24. ⭐ 여러 문서에 걸친 생성자 — 두 번째 파일의 범위도 그 파일 뷰에 있어야 한다.
//     부분 클래스의 필드 초기화자가 파일마다 있으면 `.ctor` 의 시퀀스 포인트도 문서 둘에
//     걸친다. 주 문서만 남기면 두 번째 파일의 그 줄이 **다음 메서드로** 귀속된다.
check('여러 문서에 걸친 생성자의 두 번째 범위가 그 파일에 있다', () => {
  const sym = idx.symbols;
  let found = null;
  for (const [fn, info] of sym.typeByFullName) {
    if ((info.sourceFiles || []).length < 2) continue;
    for (const m of (info.methods || [])) {
      if (!m.name.startsWith('.') || !Array.isArray(m.extraSpans) || !m.extraSpans.length) continue;
      found = { type: fn, m, files: info.sourceFiles };
      break;
    }
    if (found) break;
  }
  if (!found) return { ok: false, detail: 'extraSpans 를 가진 생성자를 못 찾았다' };
  const ex = found.m.extraSpans[0];
  const file = found.files[ex.fileIndex];
  const spans = ei.methodSpansForFile(idx, file);
  const hit = spans.find(s => s.name === found.m.name && s.line === ex.line);
  return { ok: !!hit && !!file,
           detail: `${found.type}::${found.m.name} 두 번째 범위 ${file ? file.split('/').pop() : '?'}:${ex.line}-${ex.endLine} ` +
                   `-> 파일 뷰에 ${hit ? '있다' : '없다'}` };
});

// 표본 고르기 — 인덱스에서 시작해 소스로 내려간다(§4-(27): 추측으로 고르면 보장이 없다).
function pickFieldDeclLine() {
  const sym = idx.symbols;
  for (const [file, names] of sym.typesBySourceFile) {
    if (!file.startsWith('Assets/')) continue;
    let src;
    try { src = fs.readFileSync(path.join(ROOTDIR, file), 'utf8').split(String.fromCharCode(10)); } catch { continue; }
    for (const fn of names) {
      const info = sym.typeByFullName.get(fn);
      if (!info || !info.fields || !info.methods) continue;
      const bodyStarts = info.methods.filter(m => typeof m.line === 'number').map(m => m.line);
      if (!bodyStarts.length) continue;
      const firstBody = Math.min(...bodyStarts);
      for (const f of info.fields) {
        if (!f.name || f.name.startsWith('<') || !f.type) continue;
        const re = new RegExp('(^|[^A-Za-z0-9_])' + f.name + '([^A-Za-z0-9_]|$)');
        const hits = [];
        for (let i = 1; i < firstBody; i++) if (re.test(src[i - 1] || '')) hits.push(i);
        if (hits.length !== 1) continue;                       // 파일에서 유일하게 나오는 것만 쓴다
        const text = (src[hits[0] - 1] || '').trim();
        if (!text.endsWith(';') || text.startsWith('[') || text.startsWith('//')) continue;
        return { file, line: hits[0], field: f.name, type: f.type };
      }
    }
  }
  return null;
}

function pickAttributeLine(wantType) {
  const TYPE_DECL = /\b(class|struct|interface|enum|record)\s+[A-Za-z_@]/;
  for (const file of idx.symbols.typesBySourceFile.keys()) {
    if (!file.startsWith('Assets/')) continue;
    let src;
    try { src = fs.readFileSync(path.join(ROOTDIR, file), 'utf8').split(String.fromCharCode(10)); } catch { continue; }
    for (let i = 0; i < src.length; i++) {
      const s = src[i].trim();
      if (!s.startsWith('[') || s.startsWith('[]')) continue;
      let k = i + 1;
      while (k < src.length) {
        const n = src[k].trim();
        if (!n || n.startsWith('//') || n.startsWith('[')) { k++; continue; }
        break;
      }
      if (k >= src.length) continue;
      if (TYPE_DECL.test(src[k]) === !!wantType) return { file, line: i + 1 };
    }
  }
  return null;
}

console.log(`\n${pass}/${pass + fail}`);
process.exit(fail === 0 ? 0 : 1);
