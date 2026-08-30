#!/usr/bin/env node
// §6 의 전수 집계를 다시 재는 스크립트.
//
// 왜 있나 — §6 회귀 기준에 이런 줄이 있다:
//
//     전수 집계(상한 없이, 전체 커버리지): 스크립트 컴포넌트 7,019 / 타입 해석 864 /
//     패키지라 미해석 5,554 / Assets 안 미해석 0 / 없는 스크립트 601
//       필드 검사 864, 베이스 체인 미완 242, 낡은 키 가진 컴포넌트 19
//       m_EditorClassIdentifier 대조 511, 불일치 11
//
// 그리고 그 아래 이렇게 적혀 있다: "이 수치를 다시 잴 때 **도구를 파일마다 1회 호출하는
// 방식으로 재지 말 것.** getAssetComponents 는 파일당 500개 페이지 상한이 있어 컴포넌트
// 39,921개가 빠진다(§4-16). `Bridge/index/*.js` 를 직접 require 해서 문서를 전부 도는
// 방식으로 잰다. 필드 검사는 `queries._checkFields`(측정용 시임)를 쓰면 도구와 같은
// 코드로 잴 수 있다."
//
// **그런데 그 방법을 수행하는 스크립트가 없었다.** `_checkFields` 는 그것을 위해 export
// 됐는데 체크인된 어느 스크립트도 부르지 않았다(독립 감사가 지적). 문서에 방법이 적혀
// 있고 아무도 실행하지 않으면, 그 수치는 회귀 기준이 아니라 그냥 옛 기록이다.
//
// 사용법: node Tools/sweep-field-checks.js [프로젝트경로]
// 종료코드: 0 = 기준과 같음 / 1 = 어긋남(무엇이 어긋났는지 출력) / 2 = 인덱스 캐시 없음

const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');
const tools = require(path.join(ROOT, 'Bridge/index/tools'));
const queries = require(path.join(ROOT, 'Bridge/index/queries'));
const yv = require(path.join(ROOT, 'Bridge/index/yamlvalues'));

const PROJECT = process.argv[2] || 'C:/Unity/MainProject';


// §6 이 기록한 값 (2026-08-24 감사 후 재측정).
// ⚠️ 2026-08-28 에 둘을 내렸다 — **도구가 덜 보게 된 것이 아니라 프로젝트를 정리했다.**
// `Assets/99.Settings/DefaultVolumeProfile.asset` 의 고아 컴포넌트 9개를 지웠다
// (죽은 GUID 4 + `m_Script: {fileID: 0}` 5). 그래서:
//   scriptComponents 7019 -> 7016 (지운 4 + 프로젝트 증가 1)
//   missingScript    601  -> 597 (지운 4)
// 이 수치가 **더** 줄면 그때는 도구 문제로 볼 것.
// ⚠️ 2026-08-31 에 둘을 또 내렸다 — **도구가 덜 보게 된 것이 아니라 프로젝트를 또 정리했다.**
// B군(서드파티·아트 잔여물) Missing Script 6 GUID 의 문서 28개를 지웠다(§5):
// `50.Art` 의 포탈·존 프리팹 17 · MapGen 메시 캐시 3 · KMK 테스트 1 · INab 데모 `.mat` 5 ·
// INab URP Renderer 의 고아 SSAO 2. m_Component 항목 18개도 같이 지웠다(안 지우면 dangling).
//   scriptComponents 7016 -> 6988 (-28)
//   missingScript     597 -> 569  (-28)
// 남은 missing 은 4다: 오클루전 A군 3(현상 유지로 종결) + VFX 그래프가 참조해서 건너뛴 1.
// 이 수가 **더** 줄면 그때는 도구 문제이거나, A군이 지워진 것이니 먼저 원인을 물을 것.
const BASELINE = {
  scriptComponents: 6988,
  resolved: 864,
  unresolvedPackage: 5554,
  unresolvedInAssets: 0,
  missingScript: 569,
  fieldChecks: 864,
  baseChainIncomplete: 242,
  // ⚠️ §6 의 "낡은 키 가진 컴포넌트 19" 는 **확신 케이스**다 — 베이스 체인이 사용자
  // 어셈블리 안에서 끝나서 "이 키에는 필드가 없다" 고 단정할 수 있는 것.
  // 확신/불확실을 뭉개서 세면 145 가 나오고 회귀처럼 보인다(2026-08-28 에 그렇게 착각했다).
  // 나머지 126 은 베이스가 패키지로 나가 도구가 이미 note 로 inconclusive 라고 말한다 —
  // 예: `ShowTopMostFoldoutHeaderGroup` 은 Unity.Netcode 의 NetworkTransform 필드다.
  staleKeysConfident: 19,
  staleKeysInconclusive: null,   // 기준 없음 — 프로젝트의 Netcode 채택도에 따라 변한다
  ecidCompared: 511,
  ecidMismatch: 11,
};

// §6 은 "전수 집계(상한 없이, **전체 커버리지**)" 라고 적었다. 전체 커버리지란
// `includePackageCache: true` 다 — 그래야 패키지 스크립트의 GUID 가 인덱스에 들어와
// "패키지라 미해석" 과 "없는 스크립트" 를 가를 수 있다. 기본 인덱스(3,142 GUID)로 재면
// 패키지 컴포넌트가 전부 "없는 스크립트" 로 떨어진다(2026-08-28 에 그렇게 착각했다).
// 비용: 빌드 약 18 s, GUID 3,142 -> 27,321.
const FULL = !process.argv.includes('--assets-only');
const idx = tools.ensureIndex(3000, true, FULL);
if (!idx) {
  console.error('인덱스를 만들 수 없다.');
  process.exit(2);
}
console.log(`인덱스: ${FULL ? '전체 커버리지(PackageCache 포함)' : 'Assets 전용'} — GUID ${idx.guidToPath.size}`);
const sym = idx.symbols;

const now = {
  scriptComponents: 0, resolved: 0, unresolvedPackage: 0, unresolvedInAssets: 0,
  missingScript: 0, fieldChecks: 0, baseChainIncomplete: 0,
  staleKeysConfident: 0, staleKeysInconclusive: 0,
  ecidCompared: 0, ecidMismatch: 0,
};
const staleKeySamples = [];
const ecidMismatchSamples = [];

const t0 = Date.now();
for (const [rel, guid] of idx.pathToGuid) {
  // 문서 스캔은 **Assets(+ProjectSettings)** 만 한다. "전체 커버리지" 는 GUID **해석** 범위를
  // 뜻하고(패키지 스크립트를 패키지로 알아보기 위한 것) 스캔 대상까지 넓히는 말이 아니다.
  // PackageCache 에셋까지 훑으면 컴포넌트가 28,319 로 뛴다(2026-08-28 실측) — 그건 이
  // 프로젝트의 오소링이 아니라 남의 패키지 내용이다.
  if (!/^(Assets|ProjectSettings)\//i.test(rel)) continue;

  // 확장자로 고르지 않는다. 출하 인덱스가 2026-08-24 에 확장자 화이트리스트를 버린 것과
  // 같은 이유다 — `.mat`/`.controller`/`.anim` 에도 스크립트 컴포넌트가 있다.
  // 여기서는 **파일이 실제로 Unity YAML 인지**를 앞 다섯 바이트로 본다.
  let text;
  try { text = fs.readFileSync(path.join(PROJECT, rel), 'utf8'); } catch { continue; }
  if (!text.startsWith('%YAML')) continue;

  // ⚠️ `splitDocuments(text)` 는 **`{ lines, docs }`** 를 돌려준다 — text 를 받아서
  // 자기가 쪼갠 lines 를 같이 준다. 여기서 두 번 틀렸다:
  //   1) lines 를 넘겼다 -> 전 항목이 0 으로 나왔다
  //   2) 반환을 배열로 봤다 -> "docs is not iterable"
  // 0 이 나오면 "없다" 가 아니라 **"재는 방법이 틀렸다"** 를 먼저 의심할 것.
  let split;
  try { split = yv.splitDocuments(text); } catch { continue; }
  if (!split || !Array.isArray(split.docs)) continue;
  const { lines, docs } = split;

  for (const doc of docs) {
    let parsed;
    try { parsed = yv.parseDocument(lines, doc, {}); } catch { continue; }
    const body = parsed && parsed.body;
    if (!body || !body.m_Script || !body.m_Script.guid) continue;

    now.scriptComponents++;
    const scriptGuid = body.m_Script.guid;
    const join = queries.resolveScriptType(idx, scriptGuid);

    if (!join || !join.type) {
      const csPath = idx.guidToPath.get(scriptGuid);
      if (!csPath) now.missingScript++;
      else if (/^Assets\//i.test(csPath)) now.unresolvedInAssets++;
      else now.unresolvedPackage++;
      continue;
    }

    now.resolved++;
    const info = sym.typeByFullName.get(join.type.fullName);
    if (!info) continue;

    // 도구 응답과 **같은 코드**로 잰다 — 그래서 이 시임이 있다.
    const fc = queries._checkFields(sym, info, body);
    now.fieldChecks++;
    if (!fc.baseChainComplete) now.baseChainIncomplete++;
    if (fc.unknownKeys && fc.unknownKeys.length) {
      // 확신과 불확실을 **가른다.** 베이스 체인이 패키지로 나가면 그 키가 베이스의
      // 필드일 수 있으므로 "낡았다" 고 말할 수 없다 — 도구의 note 도 그렇게 말한다.
      if (fc.baseChainComplete) {
        now.staleKeysConfident++;
        if (staleKeySamples.length < 8) {
          staleKeySamples.push(`${info.fullName} @ ${rel.split('/').pop()}: ${fc.unknownKeys.slice(0, 3).join(', ')}`);
        }
      } else {
        now.staleKeysInconclusive++;
      }
    }

    const ecid = body.m_EditorClassIdentifier;
    if (ecid && String(ecid).trim()) {
      now.ecidCompared++;
      // `Assembly::Namespace.Type` 형태. 뒤쪽만 타입 전체 이름과 비교한다.
      const tail = String(ecid).split('::').pop().trim();
      if (tail && tail !== info.fullName) {
        now.ecidMismatch++;
        if (ecidMismatchSamples.length < 6) {
          ecidMismatchSamples.push(`${tail} -> ${info.fullName}`);
        }
      }
    }
  }
}
const ms = Date.now() - t0;

// 어느 지표가 **도구 불변**이고 어느 것이 프로젝트 크기에 따라 자라는가.
// 등식으로 검사하면 컴포넌트가 하나 늘 때마다 빨간불이 켜져서 아무도 안 돌리게 된다.
// 자라는 지표는 **줄어들 때만** 문제로 본다 — 줄면 도구가 덜 보고 있다는 뜻이다.
const INVARIANT = new Set([
  'unresolvedInAssets',   // Assets 안의 스크립트가 해석 안 되면 도구 문제다. 반드시 0
]);
const GROWS = new Set([
  'scriptComponents', 'resolved', 'unresolvedPackage', 'missingScript',
  'fieldChecks', 'baseChainIncomplete', 'staleKeysConfident', 'ecidCompared', 'ecidMismatch',
]);

const keys = Object.keys(BASELINE);
const pad = Math.max(...keys.map(k => k.length));
console.log(`\n§6 전수 집계 대조  (${ms} ms, 프로젝트 ${PROJECT})\n`);
console.log('  ' + '항목'.padEnd(pad) + '  §6 기준     현재     차이');
const drift = [];
const grew = [];
for (const k of keys) {
  if (BASELINE[k] === null) {
    console.log('  ' + k.padEnd(pad) + '     (기준없음)' + String(now[k]).padStart(9));
    continue;
  }
  const d = now[k] - BASELINE[k];
  if (d !== 0) {
    const bad = INVARIANT.has(k) || (GROWS.has(k) && d < 0) || (!INVARIANT.has(k) && !GROWS.has(k));
    if (bad) drift.push(`${k}: ${BASELINE[k]} -> ${now[k]} (${d > 0 ? '+' : ''}${d})`);
    else grew.push(`${k}: ${BASELINE[k]} -> ${now[k]} (+${d})`);
  }
  console.log('  ' + k.padEnd(pad) +
              String(BASELINE[k]).padStart(9) + String(now[k]).padStart(9) +
              (d === 0 ? '        —' : String(d > 0 ? '+' + d : d).padStart(9)));
}

if (staleKeySamples.length) {
  console.log('\n  낡은 키 표본:');
  for (const x of staleKeySamples) console.log('    ' + x);
}
if (ecidMismatchSamples.length) {
  console.log('\n  m_EditorClassIdentifier 불일치 표본 (클래스 이름 변경의 흔적):');
  for (const x of ecidMismatchSamples) console.log('    ' + x);
}

if (grew.length) {
  console.log('\n프로젝트가 자란 것으로 보이는 증가 ' + grew.length + '개 (실패 아님):');
  for (const g of grew) console.log('  ' + g);
  console.log('  이 지표들은 컴포넌트 수에 비례한다. §3 의 전례 — YAML 1,131 -> 1,144 는');
  console.log('  도구가 아니라 프로젝트가 바뀐 것이었다. **감소**만 문제로 본다.');
}

if (!drift.length) {
  console.log('\n기준과 일치(또는 증가만). 통과.');
  process.exit(0);
}
console.log('\n⚠️ 문제로 보이는 어긋남 ' + drift.length + '개:');
for (const d of drift) console.log('  ' + d);
console.log('\n  감소는 "도구가 덜 보고 있다" 는 뜻이고, unresolvedInAssets 가 0 이 아니면');
console.log('  Assets 안의 스크립트를 타입으로 해석하지 못한 것이다 — 둘 다 도구 문제다.');
process.exit(1);
