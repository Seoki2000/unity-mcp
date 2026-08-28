'use strict';

/**
 * `unity_impact_analysis` 인수 시험 — **구현 전에 먼저 쓴 것.**
 *
 * P1 에서 배운 것(HANDOFF §4-(22)): 새 응답을 만들 때 "이 응답으로 답해야 하는 질문" 목록을
 * 먼저 적지 않으면 무엇이 빠졌는지 볼 방법이 없다. 코드 리뷰는 P1 에서 두 번 놓쳤고
 * 프로브는 첫 실행에 잡았다. 그래서 P2 는 이 파일부터 썼다.
 *
 * 정답은 전부 2026-08-26 에 디스크에서 독립적으로 확인한 값이다:
 *   GoToResultButton  코드 호출자 0 / 인스펙터 배선 2 (MapScene 두 변형)
 *   BombAction        Wells.asset 이 타입 이름 문자열로 참조
 *   Hurtbox           에셋 16개에 부착 (rg 로 GUID 직접 확인한 값과 일치)
 *   Unit              직계 파생 5 / 전이 8 (TwentyThreeBoss 포함)
 *   IEffectSystem     구현 목록은 인덱스에 **없다** → "모른다" 로 답해야 한다
 *   MainCamera.prefab 에셋 참조 2 + 코드 경로 상수 로드 1 (RenderingLookAuthoring.cs)
 *   BootStrapScene    ProjectSettings/EditorBuildSettings 가 참조 (빌드 씬 0번)
 *   SkillRange.png    참조 3 중 2건은 셰이더그래프 안 텍스트 일치
 *
 * 사용: node Tools/probe-impact-analysis.js
 * 종료 코드: 통과 수가 기대치(EXPECT_PASS) 미만이면 1.
 */

const path = require('path');
const tools = require(path.join(__dirname, '..', 'Bridge', 'index', 'tools'));

tools.setLogger(() => {});

let impact = null;
try {
  impact = require(path.join(__dirname, '..', 'Bridge', 'index', 'impact'));
} catch (e) {
  console.error('Bridge/index/impact.js 가 아직 없다 (구현 전이면 정상): ' + e.message);
  process.exit(3);
}

const EXPECT_PASS = 11;

const has = (arr, re) => Array.isArray(arr) && arr.some(x => re.test(typeof x === 'string' ? x : JSON.stringify(x)));
const count = arr => (Array.isArray(arr) ? arr.length : 0);

const PROBES = [
  ['method: GoToResultButton 은 죽은 코드가 아니다', { target: 'GameManager::GoToResultButton' }, r =>
    count(r.code && r.code.callers) === 0 &&
    count(r.data && r.data.inspectorWirings) === 2 &&
    has(r.data.inspectorWirings, /4\.MapScene\.unity/) &&
    has(r.data.inspectorWirings, /4\.MapScene-trensparent\.unity/) &&
    r.summary && r.summary.impactedCount > 0],

  ['method: MenuItem 진입점이 호출자 0 의 뜻을 바꾼다', { target: 'DevBuildSceneList::EnableDevScenes' }, r =>
    has(r.entryPoints && r.entryPoints.attributes, /MenuItem/)],

  ['type: BombAction 은 Wells.asset 이 이름으로 쓴다', { target: 'BombAction' }, r =>
    has(r.data && r.data.typeNameRefs, /Wells\.asset/)],

  ['type: Hurtbox 는 에셋 16개에 붙는다', { target: 'Hurtbox' }, r =>
    (r.assets && (count(r.assets.attachedTo) + (r.assets.attachedToOmitted || 0))) === 16],

  // ⭐ PDB 문서가 없는 타입(메서드가 없어 시퀀스 포인트가 안 잡히는 데이터 컴포넌트)도
  //    붙은 에셋을 답해야 한다. 예전에는 `sourceFiles[0]` 하나에 기대서 **축이 통째로
  //    빠진 채 impactedCount 0** 이 나왔다 — 삭제 판단에 쓰이는 거짓 0 이다(§4-(21) 형태).
  //    실측 2026-08-28: 사용자 타입 1,052 중 문서 없음 307, 그중 실제로 붙은 것 4개.
  ['type: PDB 문서 없는 타입도 붙은 에셋을 답한다 (파일명 폴백)', { target: 'TwentyThreeBasicAttackFigure' }, r =>
    (r.assets && (count(r.assets.attachedTo) + (r.assets.attachedToOmitted || 0))) === 3 &&
    r.assets.scriptAssetBasis === 'filename-match' &&
    r.summary.byAxis.attachedAssets === 3],

  ['type: Unit 의 파생 타입 직계 5 / 전이 8', { target: 'Unit' }, r =>
    r.inheritance &&
    count(r.inheritance.directSubclasses) === 5 &&
    (count(r.inheritance.transitiveSubclasses) + (r.inheritance.transitiveOmitted || 0)) === 8 &&
    has(r.inheritance.transitiveSubclasses, /TwentyThreeBoss/)],

  ['type: 인터페이스 구현 목록은 "모른다" 로 답한다', { target: 'IEffectSystem' }, r =>
    r.unknown && /implement/i.test(JSON.stringify(r.unknown))],

  ['asset: MainCamera.prefab — 에셋 2 + 코드 경로 로드 1', { target: 'Assets/2.Prefabs/Camera/MainCamera.prefab' }, r =>
    has(r.assets && r.assets.referencedBy, /PlayerScene\.unity/) &&
    has(r.assets.referencedBy, /CameraSwitcher\.prefab/) &&
    has(r.code && r.code.pathLoads, /RenderingLookAuthoring\.cs/)],

  ['asset: BootStrapScene 은 빌드 설정에 실려 있다', { target: 'Assets/0.Scenes/MainFlow/0.BootStrapScene.unity' }, r =>
    has(r.assets && r.assets.projectSettings, /EditorBuildSettings/) ||
    (r.buildScene && r.buildScene.enabled !== undefined)],

  ['asset: SkillRange.png — 참조 3, 그중 텍스트 일치 2', { target: 'Assets/50.Art/TestAssets/TestPlayerAsset/SkillUI/SkillRange.png' }, r =>
    (count(r.assets && r.assets.referencedBy) + ((r.assets && r.assets.referencedByOmitted) || 0)) === 3 &&
    count(r.assets.textualMatches) === 2],

  ['모든 응답이 불확실성을 싣는다 (동적 로드 44 등)', { target: 'Hurtbox' }, r =>
    r.unknown && r.unknown.dynamicLoadSites === 44 && typeof r.note === 'string' && r.note.length > 40],
];

function main() {
  const idx = tools.ensureIndex(3000, false, false, false);
  if (!idx) { console.error('index unavailable'); process.exit(2); }

  let pass = 0;
  for (const [name, args, check] of PROBES) {
    let r, ok = false, err = null;
    const t0 = Date.now();
    try {
      r = impact.buildImpact(idx, args);
      ok = !!check(r);
    } catch (e) { err = e.message; }
    const ms = Date.now() - t0;
    if (ok) pass++;
    console.log(`${ok ? 'pass' : 'FAIL'}  ${name}  (${ms} ms)`);
    if (!ok) {
      if (err) console.log('        threw: ' + err);
      else if (r && r.error) console.log('        error: ' + r.error);
      else console.log('        got: ' + JSON.stringify(r).slice(0, 400));
    }
  }

  console.log(`\n${pass}/${PROBES.length}`);
  if (pass < EXPECT_PASS) process.exit(1);
}

main();
