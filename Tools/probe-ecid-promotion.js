#!/usr/bin/env node
'use strict';

/**
 * ECID 승격 인수 시험 — **구현 전에 먼저 쓴 것** (HANDOFF §0.5 "프로브를 쓸 때의 규칙" 1).
 *
 * 무엇을 승격하나: 스크립트 GUID 를 컴파일된 타입으로 **해석하지 못했을 때**, 에셋이
 * 스스로 적어 둔 타입 이름(`m_EditorClassIdentifier`)을 답 자리에 올린다.
 * 값은 이미 응답에 실려 있었다 — 바뀌는 것은 **어디에 싣느냐**다. 캐시 0 바이트, 빌드 0 ms.
 *
 * ⚠️ 승격은 "검증된 타입" 이 아니다. 그래서 이 프로브의 절반은 **승격하면 안 되는 자리에서
 *    승격하지 않는지**를 본다 (§4-(27): 아무것도 없을 때도 참이 되는 단언을 피한다).
 *
 * 정답은 2026-08-29 에 원본 YAML 을 직접 돌아 구한 값이다 (다른 경로로 구한 답 — 규칙 3):
 *   스크립트 컴포넌트 7,016 / 해석 864 / 미해석 6,152
 *   미해석 중 ECID 있음 1,213 = 붙은 것 1,090 + 안 붙은 것 123
 *     붙음·스크립트없음·ECID  560  (오클루전 3종 515+33+12 — 프리팹 YAML 직접 집계와 일치)
 *     붙음·패키지·ECID        530  (HANDOFF §0.5-5 가 적던 "530")
 *     붙음·패키지·ECID없음    292  (§0.5-5 의 "순증 292" — 승격으로는 못 답한다)
 *   ⚠️ §0.5-5 의 모집단 822 는 **패키지 미해석만** 셌다. 스크립트가 아예 없는 560 이
 *      빠져 있었고, 그쪽이야말로 ECID 말고는 근거가 없는 자리다.
 *
 * 사용: node Tools/probe-ecid-promotion.js
 * 종료 코드: 통과 수가 EXPECT_PASS 미만이면 1.
 */

const path = require('path');
const fs = require('fs');
const tools = require(path.join(__dirname, '..', 'Bridge', 'index', 'tools'));
const queries = require(path.join(__dirname, '..', 'Bridge', 'index', 'queries'));
const yv = require(path.join(__dirname, '..', 'Bridge', 'index', 'yamlvalues'));

tools.setLogger(() => {});

const PROJECT = process.argv[2] || 'C:/Unity/MainProject';
const EXPECT_PASS = 23;

// 전수 불변식의 기준값. 프로젝트가 자라면 늘 수 있다 — **줄면** 승격이 덜 답한다는 뜻이다.
const SWEEP = {
  unresolvedWithEcid: 1213,
  attachedMissingEcid: 560,
  attachedPackageEcid: 530,
  attachedPackageNoEcid: 292,
};

const A_OCCLUSION = 'Assets/2.Prefabs/Map/LevelDeliveryV3/Dependencies/PropWrappers/PF_Prop_object_alarm_52f66357_V3.prefab';
const A_BOSSSCENE = 'Assets/0.Scenes/BossScene.unity';
const A_ALLMESH = 'Assets/0.Scenes/Art/LevelDeliveryV3/all_mesh.unity';
// ⚠️ 예전 표본은 `50.Art/.../PortalBlueIdle.prefab` 의 컴포넌트였는데 **2026-08-31 정리로
//    지워졌다**(B군). 지금 "미해석 + ECID 없음" 이 남아 있는 곳은 이 VFX 그래프 하나뿐이다 —
//    그래프 노드 목록이 그 fileID 를 참조해서 정리에서 일부러 건너뛴 자리다(§5).
const A_VFX_NOECID = 'Assets/INab Studio/Vfx Assets/Character Effects/Core/Graphs/Character Fire.vfx';
const A_VOLUME = 'Assets/0.Scenes/MainFlow/4.MapScene/Global Volume Profile.asset';
const A_GAMEMGR = 'Assets/2.Prefabs/Managers/GameManager.prefab';

let idx = null;

function rowsOf(asset, extra) {
  const r = queries.getAssetComponents(idx, Object.assign({ asset }, extra || {}));
  if (r.error) throw new Error(r.error);
  return r.components || r.rows || [];
}

function rowOf(asset, fileID) {
  return rowsOf(asset, { fileID: String(fileID) })[0] || null;
}

const PROBES = [
  // ── 승격해야 하는 자리 ──────────────────────────────────────────────
  ['1. 스크립트가 아예 없는데 에셋이 이름을 안다 (오클루전) — 승격한다', () => {
    const row = rowOf(A_OCCLUSION, '6258978777772699510');
    const p = row && row.script && row.script.typeNameFromAsset;
    return !!p && p.fullName === 'VeyTrace.Rendering.Occlusion.OcclusionSection' && p.verified === false;
  }],

  ['2. 승격한 이름이 행의 이름이 된다 — MonoBehaviour 가 아니다', () => {
    const row = rowOf(A_OCCLUSION, '6258978777772699510');
    return !!row && row.displayName === 'VeyTrace.Rendering.Occlusion.OcclusionSection' &&
      row.className === 'MonoBehaviour';
  }],

  ['3. 패키지라 미해석인 것도 승격한다 (Netcode)', () => {
    const row = rowOf(A_BOSSSCENE, '30393466');
    const p = row && row.script && row.script.typeNameFromAsset;
    return !!p && p.fullName === 'Unity.Netcode.NetworkObject' && p.verified === false;
  }],

  ['4. GameObject 에 안 붙은 문서(.asset 서브에셋)도 승격한다', () => {
    const row = rowOf(A_VOLUME, '-8417930920304688920');
    const p = row && row.script && row.script.typeNameFromAsset;
    return !!p && p.fullName === 'UnityEngine.Rendering.Universal.Vignette';
  }],

  ['5. 승격 이유를 구분해 말한다 — 스크립트 없음과 커버리지 한계는 다른 사정이다', () => {
    const missing = rowOf(A_OCCLUSION, '6258978777772699510');
    const pkg = rowOf(A_BOSSSCENE, '30393466');
    const rm = missing.script.typeNameFromAsset.unverifiedReason;
    const rp = pkg.script.typeNameFromAsset.unverifiedReason;
    return rm === 'script-not-in-project' && rp === 'outside-indexed-assemblies' && rm !== rp;
  }],

  ['5b. 사유 설명은 응답에 한 번만 실린다 — 행마다 반복하지 않는다', () => {
    // 처음 구현에서 문단을 행마다 실었더니 승격 필드가 응답의 15.5% 를 먹었다.
    // 설명은 응답 수준으로, 행에는 사유 코드만.
    const r = queries.getAssetComponents(idx, { asset: A_VOLUME });
    const u = r.unverifiedTypeNames;
    if (!u || !Array.isArray(u.byReason) || u.count < 2) return false;
    // 승격 행이 여럿인데 사유 설명은 사유 종류 수만큼만 있어야 한다
    if (u.byReason.length > 3 || u.byReason.length >= u.count) return false;
    if (!u.byReason.every(x => typeof x.note === 'string' && x.note.length > 40 && x.count > 0)) return false;
    // 행 안에는 긴 문단이 없어야 한다. 총 길이가 아니라 **문자열 값 하나의 길이**로 잰다 —
    // 짧은 필드를 여럿 두는 것과 문단을 싣는 것은 다르고, 여기서 막고 싶은 것은 후자다.
    // (실측 2026-08-29: 승격 필드 JSON 245 자, 가장 긴 값은 타입 이름 44 자)
    return (r.components || []).every(row => {
      const p = row.script && row.script.typeNameFromAsset;
      if (!p) return true;
      return Object.values(p).every(v => typeof v !== 'string' || v.length <= 80);
    });
  }],

  ['6. 승격한 이름의 어셈블리도 싣는다 (ECID 앞부분)', () => {
    const row = rowOf(A_BOSSSCENE, '30393466');
    const p = row.script.typeNameFromAsset;
    return !!p && typeof p.assembly === 'string' && p.assembly.length > 0 &&
      p.source === 'm_EditorClassIdentifier';
  }],

  // ── 승격하면 안 되는 자리 (거짓 양성 검사) ──────────────────────────
  ['7. ECID 가 없으면 이름을 지어내지 않는다 (패키지·ECID없음 292군)', () => {
    const row = rowOf(A_ALLMESH, '203844587');
    return !!row && !row.script.typeNameFromAsset && row.displayName === 'MonoBehaviour';
  }],

  ['8. ECID 가 없으면 이름을 지어내지 않는다 (스크립트없음·ECID없음)', () => {
    const row = rowOf(A_VFX_NOECID, '8926484042661621328');
    return !!row && !row.script.typeNameFromAsset && row.displayName === 'MonoBehaviour';
  }],

  ['9. 해석에 성공한 컴포넌트는 승격하지 않는다 — 검증된 타입이 이긴다', () => {
    const row = rowOf(A_BOSSSCENE, '15431009');
    return !!row && row.script.type && row.script.type.fullName === 'AudioManager' &&
      !row.script.typeNameFromAsset && row.displayName === 'AudioManager';
  }],

  ['10. ECID 가 낡아 컴파일 타입과 달라도 승격하지 않는다 (TempGameManager -> GameManager)', () => {
    const row = rowOf(A_GAMEMGR, '8468152987463888396');
    return !!row && row.script.type && row.script.type.fullName === 'GameManager' &&
      row.script.matchesEditorClassIdentifier === false &&
      !row.script.typeNameFromAsset && row.displayName === 'GameManager';
  }],

  ['11. 승격은 검증된 타입 슬롯을 오염시키지 않는다 — script.type 은 여전히 null', () => {
    const row = rowOf(A_OCCLUSION, '6258978777772699510');
    return !!row && row.script.type === null && typeof row.script.resolution === 'string';
  }],

  // ── 승격이 실제로 질문에 답하는가 ────────────────────────────────────
  ['12. 승격한 이름으로 component 필터가 걸린다 (예전에는 0행이었다)', () => {
    const rows = rowsOf(A_OCCLUSION, { component: 'OcclusionSection' });
    return rows.length >= 1 && rows.every(x => /OcclusionSection/.test(x.displayName));
  }],

  ['12b. 승격해도 행이 숨지 않는다 — component:"MonoBehaviour" 로도 걸린다', () => {
    // 독립 검증이 짚은 자리: displayName 만 필터에 쓰면 새로 이름을 얻은 행이
    // 하필 열거용 질의에서 통째로 빠진다. 필터는 두 이름을 다 본다.
    const rows = rowsOf(A_OCCLUSION, { component: 'MonoBehaviour' });
    return rows.some(r => r.script && r.script.typeNameFromAsset &&
      /OcclusionSection/.test(r.displayName));
  }],

  // ── 형태가 깨진 값을 타입 이름으로 올리지 않는다 (독립 검증 지적) ─────
  ['15. 형태가 깨진 ECID 는 승격하지 않는다', () => {
    const bad = ['A::B::C', 'Assembly-CSharp::not a type', '::', 'NoSeparator.Type',
      '::Type', 'Asm::', '', '   ', 'Asm::9Bad', 'Asm::has space'];
    const ok = bad.every(v => queries._promoteFromAsset({ m_EditorClassIdentifier: v }, null, idx) === null);
    // 그리고 표준형은 여전히 읽는다 (아무것도 승격 안 하는 것으로 통과하면 안 된다)
    const good = queries._promoteFromAsset(
      { m_EditorClassIdentifier: 'Assembly-CSharp::Ns.Outer+Inner' }, null, idx);
    return ok && !!good && good.fullName === 'Ns.Outer+Inner' && good.assembly === 'Assembly-CSharp';
  }],

  ['16. 사유는 exists 가 아니라 스크립트 위치로 정한다', () => {
    // Assets 안에 있는데 해석이 안 된 스크립트를 "패키지라서" 로 말하면 안 된다.
    // 이 프로젝트에는 그 경우가 0 건이라 인덱스를 합성해서 물어본다.
    const fake = {
      guidToPath: new Map([['aaaa', 'Assets/Foo.cs'], ['bbbb', 'Packages/x/Bar.cs']]),
      guidCoverage: 'full', symbols: idx.symbols,
    };
    const inAssets = queries._promoteFromAsset(
      { m_Script: { guid: 'aaaa' }, m_EditorClassIdentifier: 'Assembly-CSharp::Foo' }, null, fake);
    const inPkg = queries._promoteFromAsset(
      { m_Script: { guid: 'bbbb' }, m_EditorClassIdentifier: 'X::Bar' }, null, fake);
    const dead = queries._promoteFromAsset(
      { m_Script: { guid: 'cccc' }, m_EditorClassIdentifier: 'X::Gone' }, null, fake);
    return inAssets.unverifiedReason === 'unresolved-in-assets' &&
      inPkg.unverifiedReason === 'outside-indexed-assemblies' &&
      dead.unverifiedReason === 'script-not-in-project';
  }],

  ['17. 끊긴 GUID 와 "그 이름이 안 컴파일된다" 를 가른다', () => {
    // 오클루전은 진짜로 그 이름의 타입이 없다.
    const row = rowOf(A_OCCLUSION, '6258978777772699510');
    if (row.script.typeNameFromAsset.typeWithThisNameCompiles !== false) return false;
    // 스크립트를 지웠다 다시 만든 상황(같은 이름, 새 GUID)은 반대로 나와야 한다.
    const live = [...idx.symbols.typeByFullName.keys()].find(k => /^[A-Za-z_][\w.]*$/.test(k));
    const synth = queries._promoteFromAsset(
      { m_Script: { guid: 'deadbeef' }, m_EditorClassIdentifier: 'Assembly-CSharp::' + live },
      null, idx);
    return !!synth && synth.typeWithThisNameCompiles === true &&
      synth.unverifiedReason === 'script-not-in-project';
  }],

  // ── find_missing_scripts 도 이름으로 답하는가 (2026-08-30) ───────────
  // 승격을 만들고 정작 "무엇이 없어졌나" 를 묻는 주력 도구를 안 고치면 §4-(21) 이다.
  // 예전 이 도구는 GUID 만 답하고 note 로 "이름은 get_asset_components 에서 보라" 고 했다.
  ['18. missing script 가 GUID 만이 아니라 이름을 답한다', () => {
    const r = queries.findMissingScripts(idx, { maxResults: 100 });
    const named = (r.missing || []).filter(m => m.typeNameFromAsset);
    const top = (r.missing || []).find(m => m.referencingAssetCount === 108);
    return named.length >= 3 && !!top && top.typeNameFromAsset &&
      top.typeNameFromAsset.fullName === 'VeyTrace.Rendering.Occlusion.OcclusionSection' &&
      top.typeNameFromAsset.verified === false;
  }],

  ['19. 이름의 근거가 된 에셋을 같이 준다', () => {
    const r = queries.findMissingScripts(idx, { maxResults: 100 });
    const top = (r.missing || []).find(m => m.typeNameFromAsset);
    const ev = top && top.typeNameFromAsset.evidenceAsset;
    return typeof ev === 'string' && /^Assets\//.test(ev) &&
      (top.sampleAssets || []).concat([ev]).includes(ev);
  }],

  ['20. ECID 가 없는 missing 은 이름을 지어내지 않는다', () => {
    const r = queries.findMissingScripts(idx, { maxResults: 100 });
    const named = (r.missing || []).filter(m => m.typeNameFromAsset).length;
    const total = (r.missing || []).length;
    // 실측 2026-08-31: missing **4** 중 이름이 나오는 것은 오클루전 3개.
    // ⚠️ 10 -> 4 는 회귀가 아니라 **정리다** — B군 서드파티·아트 잔여물 6 GUID
    // (문서 28개)를 지웠다(§5). 남은 1개는 VFX 그래프 노드 목록이 참조해서 건너뛴 것.
    // 여기서 **더 줄면** 오클루전(A군, 현상 유지로 종결)이 사라졌다는 뜻이니 먼저 원인을 물을 것.
    return total === 4 && named === 3;
  }],

  ['21. 이름을 붙이는 비용이 예산 안이다', () => {
    // 실측 11 ms (가장 작은 참조 에셋만 읽고 그 문서만 파싱). 순진한 구현은 544 ms 였다.
    // 이 단언이 깨지면 "전 문서를 파싱" 으로 되돌아간 것이다.
    const t0 = Date.now();
    queries.findMissingScripts(idx, { maxResults: 100 });
    return (Date.now() - t0) < 300;
  }],

  // ── 전수 불변식 (다른 경로로 구한 답과 대조 — 규칙 3) ────────────────
  ['13. 전수: 승격 대상 수가 원본 YAML 직접 집계와 같다', () => {
    const s = sweep();
    return s.unresolvedWithEcid === SWEEP.unresolvedWithEcid &&
      s.attachedMissingEcid === SWEEP.attachedMissingEcid &&
      s.attachedPackageEcid === SWEEP.attachedPackageEcid &&
      s.attachedPackageNoEcid === SWEEP.attachedPackageNoEcid;
  }],

  ['14. 전수: 해석에 성공한 컴포넌트에는 승격이 단 한 건도 붙지 않는다', () => {
    const s = sweep();
    return s.promotedOnResolved === 0 && s.promotedTotal === s.unresolvedWithEcid;
  }],
];

let _sweep = null;

function sweep() {
  if (_sweep) return _sweep;
  const n = {
    unresolvedWithEcid: 0, attachedMissingEcid: 0, attachedPackageEcid: 0,
    attachedPackageNoEcid: 0, promotedOnResolved: 0, promotedTotal: 0,
  };
  for (const [rel] of idx.pathToGuid) {
    if (!/^(Assets|ProjectSettings)\//i.test(rel)) continue;
    let text;
    try { text = fs.readFileSync(path.join(PROJECT, rel), 'utf8'); } catch { continue; }
    if (!text.startsWith('%YAML')) continue;
    let sp;
    try { sp = yv.splitDocuments(text); } catch { continue; }
    if (!sp || !Array.isArray(sp.docs)) continue;
    for (const doc of sp.docs) {
      let p;
      try { p = yv.parseDocument(sp.lines, doc, {}); } catch { continue; }
      const b = p && p.body;
      if (!b || !b.m_Script || !b.m_Script.guid) continue;
      const join = queries.resolveScriptType(idx, b.m_Script.guid);
      // 도구와 **같은 코드**로 잰다 — 그래서 이 시임이 있다 (`_checkFields` 와 같은 이유).
      const promoted = queries._promoteFromAsset(b, join, idx);
      if (promoted) n.promotedTotal++;
      if (join && join.type) {
        if (promoted) n.promotedOnResolved++;
        continue;
      }
      const raw = b.m_EditorClassIdentifier;
      const ecid = (typeof raw === 'string' && raw.trim()) ? raw.trim() : null;
      if (ecid) n.unresolvedWithEcid++;
      const go = b.m_GameObject;
      const attached = !!(go && typeof go === 'object' && String(go.fileID) !== '0');
      const csPath = idx.guidToPath.get(b.m_Script.guid);
      const reason = !csPath ? 'missing' : (/^Assets\//i.test(csPath) ? 'inAssets' : 'package');
      if (attached && reason === 'missing' && ecid) n.attachedMissingEcid++;
      if (attached && reason === 'package' && ecid) n.attachedPackageEcid++;
      if (attached && reason === 'package' && !ecid) n.attachedPackageNoEcid++;
    }
  }
  _sweep = n;
  return n;
}

function main() {
  // 전체 커버리지 — "패키지라 미해석" 과 "스크립트가 없다" 를 갈라야 한다.
  idx = tools.ensureIndex(3000, true, true);
  if (!idx) {
    console.error('index unavailable');
    process.exit(2);
  }

  let pass = 0;
  for (const [name, run] of PROBES) {
    let ok = false;
    let err = null;
    const t0 = Date.now();
    try { ok = !!run(); } catch (e) { err = e.message; }
    const ms = Date.now() - t0;
    if (ok) pass++;
    console.log((ok ? 'pass' : 'FAIL') + '  ' + name + '  (' + ms + ' ms)');
    if (!ok && err) console.log('        threw: ' + err);
  }
  console.log('\n' + pass + '/' + PROBES.length);
  if (pass < EXPECT_PASS) process.exit(1);
}

main();
