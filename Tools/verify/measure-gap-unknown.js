'use strict';
// `lineKind` 의 unknown 이 실제로 무엇인지 전수로 본다.
// ⚠️ 모집단을 도구와 **똑같이** 잡는다 — probe-error-impact 18번과 같은 필터다.
//    (직접 만든 필터로 재다가 12,109 대 1,074 로 11배 어긋났다. 세 번째 같은 실수였다.)
const fs = require('fs');
const path = require('path');
const ROOT = 'C:/dev/unity-mcp';
const tools = require(path.join(ROOT, 'Bridge/index/tools'));
const PROJECT = 'C:/Unity/MainProject';
tools.setLogger(() => {});
const idx = tools.ensureIndex(3000, false, false, true) || tools.ensureIndex(3000, true, false);

function call(args) {
  const r = tools.callLocalTool('unity_explain_compile_errors', args, 3000);
  return JSON.parse(r.content[0].text);
}

const files = [...idx.symbols.typesBySourceFile.keys()].filter(f => f.startsWith('Assets/'));
const srcOf = new Map();
const rows = [];
for (const f of files) {
  let src;
  try { src = fs.readFileSync(path.join(PROJECT, f), 'utf8').split('\n'); } catch { continue; }
  srcOf.set(f, src);
  for (let i = 1; i <= src.length; i++) {
    const s = src[i - 1].trim();
    if (!s || s.startsWith('//') || s === '{' || s === '}') continue;
    rows.push({ file: f, line: i, message: 'x' });
  }
}
console.log(`매핑된 Assets 파일 ${srcOf.size} / 검사 대상 줄 ${rows.length}`);

const t0 = Date.now();
const kinds = {};
let total = 0;
const unk = [];
for (let k = 0; k < rows.length; k += 50) {
  const out = call({ errors: rows.slice(k, k + 50) }).errors || [];
  for (const e of out) {
    // gap = exact 도 signature 도 아닌 줄. 문서의 7,706 이 이 모집단이다.
    const c = e.method && e.method.containment;
    if (c === 'exact' || c === 'signature') continue;
    total++;
    const kind = e.lineKind || 'unknown';
    kinds[kind] = (kinds[kind] || 0) + 1;
    if (kind === 'unknown') unk.push([e.file || rows[0].file, e.line]);
  }
}
console.log(`도구 호출 ${Math.ceil(rows.length / 50)}회 / ${((Date.now() - t0) / 1000).toFixed(1)} s`);
console.log('exact 아닌 줄', total);
console.log('분류:', JSON.stringify(kinds));
const unknown = kinds.unknown || 0;
console.log(`unknown ${unknown} = ${(unknown * 100 / Math.max(1, total)).toFixed(1)}%`);
console.log();

// unknown 을 성격별로 쪼갠다
function depthBefore(lines, i) {
  let par = 0, brk = 0;
  const from = Math.max(0, i - 60);
  for (let k = from; k < i - 1; k++) {
    const l = (lines[k] || '').replace(/\/\/.*$/, '');
    for (const ch of l) {
      if (ch === '(') par++; else if (ch === ')') par--;
      else if (ch === '[') brk++; else if (ch === ']') brk--;
    }
    if (par < 0) par = 0;
    if (brk < 0) brk = 0;
  }
  return { par, brk };
}
const bucket = {};
const samples = {};
for (const [f, ln] of unk) {
  const lines = srcOf.get(f);
  if (!lines) { bucket['소스없음'] = (bucket['소스없음'] || 0) + 1; continue; }
  const s = (lines[ln - 1] || '').trim();
  const d = depthBefore(lines, ln);
  let k;
  if (d.par > 0 || d.brk > 0) k = '여러줄 문장의 연속(괄호 안)';
  else if (/^[)\]}>,;]/.test(s)) k = '닫는 기호로 시작';
  else if (/=>\s*$|,\s*$|\+\s*$|&&\s*$|\|\|\s*$/.test(s)) k = '다음 줄로 이어짐';
  else if (/^\[/.test(s)) k = '속성';
  else if (/^(public|private|protected|internal|static|readonly|const|override|virtual|abstract|sealed|partial|async)\b/.test(s)) k = '선언 수식어로 시작';
  else k = '기타';
  bucket[k] = (bucket[k] || 0) + 1;
  (samples[k] = samples[k] || []).length < 4 && samples[k].push(`${f.split('/').pop()}:${ln}  ${s.slice(0, 60)}`);
}
console.log('=== unknown 을 쪼개면 ===');
for (const [k, v] of Object.entries(bucket).sort((a, b) => b[1] - a[1])) {
  console.log(`  ${k.padEnd(26)} ${String(v).padStart(5)}  ${(v * 100 / Math.max(1, unknown)).toFixed(1)}%`);
  for (const x of (samples[k] || [])) console.log(`        ${x}`);
}
const bracket = bucket['여러줄 문장의 연속(괄호 안)'] || 0;
const cont = bucket['다음 줄로 이어짐'] || 0;
const close = bucket['닫는 기호로 시작'] || 0;
console.log();
console.log(`괄호/이어짐 추적으로 덮일 수 있는 것: ${bracket + cont + close} / ${unknown} = ${((bracket + cont + close) * 100 / Math.max(1, unknown)).toFixed(1)}%`);

// ── 기준선 (2026-08-31 실측) ───────────────────────────────────────────────
// 독립 검증이 짚었다: 이 스크립트가 **아무 값에나 성공으로 끝났다.** 수치를 찍기만 하고
// 단언하지 않으면 그건 회귀 기준이 아니라 그냥 출력이다 — §6 이 이미 그렇게 말하고 있다.
const BASE = { unknown: 691, memberDeclaration: 496, total: 8005 };
const md = kinds['member-declaration'] || 0;
const drift = [];
// unknown 은 **늘면** 문제다(분류가 덜 된 것). member-declaration 은 **줄면** 문제다.
if (unknown > BASE.unknown) drift.push(`unknown ${BASE.unknown} -> ${unknown} (+${unknown - BASE.unknown})`);
if (md < BASE.memberDeclaration) drift.push(`member-declaration ${BASE.memberDeclaration} -> ${md} (${md - BASE.memberDeclaration})`);
console.log();
if (drift.length) {
  console.log('⚠️ 기준선에서 나쁜 쪽으로 어긋났다:');
  for (const d of drift) console.log('  ' + d);
  console.log('  분류기가 덜 답하고 있다는 뜻이다. 프로젝트가 자라 total 이 늘었다면');
  console.log(`  (지금 ${total}, 기준 ${BASE.total}) 비율로 다시 판단하고 이 기준선을 갱신할 것.`);
  process.exit(1);
}
console.log(`기준선 통과 (unknown ${unknown} <= ${BASE.unknown}, member-declaration ${md} >= ${BASE.memberDeclaration}).`);
