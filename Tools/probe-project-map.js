'use strict';

/**
 * `unity_project_map` 인수 시험 — 구조 프로브 스위트.
 *
 * 왜 이게 필요한가: "지도가 좋은가" 는 예쁜 샘플이나 랭킹 일치도로 잴 수 없다.
 * 그래서 **디스크에서 독립적으로 확인 가능한 질문 7개**를 두고, 지도 페이로드만 보고
 * 답할 수 있는지 센다. 프로브 목록은 독립 감사(Codex CLI, 2026-08-26)가 제안한 것이다.
 *
 * 실측(MainProject, 2026-08-26): 4,000 토큰 5/7 · 6,000 토큰 6/7 · 8,000 토큰 7/7.
 * 기본 예산 6,000 은 이 표로 정했다.
 *
 * 사용:
 *   node Tools/probe-project-map.js            # 기본 예산들로 스윕
 *   node Tools/probe-project-map.js 6000       # 예산 하나만
 *   UNITY_MCP_PROJECT=C:/Unity/MainProject node Tools/probe-project-map.js
 *
 * 종료 코드: 기본 예산(6,000)에서 통과 수가 6 미만이면 1. 회귀 감지용이다.
 *
 * ⚠️ 프로브 내용은 이 프로젝트(MainProject)에 맞춰져 있다. 다른 프로젝트에서 돌리면
 *    이름이 안 맞아 실패한다 — 그건 지도의 결함이 아니다. 프로젝트별로 고쳐 쓸 것.
 */

const path = require('path');
const tools = require(path.join(__dirname, '..', 'Bridge', 'index', 'tools'));
const projectmap = require(path.join(__dirname, '..', 'Bridge', 'index', 'projectmap'));

tools.setLogger(() => {});

const PROBES = [
  ['bootstrap/main-flow scenes', j =>
    (j.placement && j.placement.buildScenes || []).some(s => /BootStrap/i.test(s.path)) &&
    (j.placement && j.placement.buildScenes || []).filter(s => /MainFlow/.test(s.path)).length >= 4],

  ['scripts on the player and boss prefabs', j => {
    const ps = (j.placement && j.placement.prefabs) || [];
    return ps.some(p => /player/i.test(p.asset)) && ps.some(p => /boss|TwentyThree|23/i.test(p.asset));
  }],

  ['type-name axis reaches BombAction', j =>
    ((j.entryPoints && j.entryPoints.typeNameRefs) || []).some(r => r.type === 'BombAction')],

  ['Inspector wiring reaches GoToResultButton', j =>
    ((j.entryPoints && j.entryPoints.inspectorWired) || []).some(w => /GoToResultButton/.test(w.method))],

  ['network prefab registry is visible', j =>
    ((j.placement && j.placement.registries) || []).some(r => /NetworkPrefabs/i.test(r.asset))],

  ['conditional / editor-only helpers are distinguishable', j =>
    ((j.entryPoints && j.entryPoints.conditional) || []).length > 0],

  ['enabled dev/test scenes are not called production', j => {
    const bs = (j.placement && j.placement.buildScenes) || [];
    return bs.some(s => /Test|Dev_/i.test(s.path)) &&
           /does NOT mean production/i.test((j.placement && j.placement.buildScenesNote) || '');
  }],
];

const BYTES_PER_TOKEN = 3.7;
const WIRE_OVERHEAD = 1.11;   // MCP 는 결과를 문자열 안에 담아 보낸다(실측 1.10~1.12)

function main() {
  const arg = process.argv[2];
  const budgets = arg ? [parseInt(arg, 10)] : [2000, 4000, 6000, 8000, 10000];

  const idx = tools.ensureIndex(3000, false, false, false);
  if (!idx) {
    console.error('index unavailable — set UNITY_MCP_PROJECT or start Unity once so the token file exists');
    process.exit(2);
  }

  let defaultPass = null;
  for (const budgetTokens of budgets) {
    const t0 = Date.now();
    const map = projectmap.buildProjectMap(idx, { budgetTokens });
    const ms = Date.now() - t0;
    if (map.error) { console.error('error:', map.error); process.exit(2); }

    const wire = Math.round(map.bytes * WIRE_OVERHEAD);
    const actual = Math.round(wire / BYTES_PER_TOKEN);
    const results = PROBES.map(([name, fn]) => {
      let ok = false;
      try { ok = !!fn(map); } catch (e) { ok = false; }
      return [name, ok];
    });
    const pass = results.filter(([, ok]) => ok).length;
    if (budgetTokens === projectmap.DEFAULT_BUDGET_TOKENS) defaultPass = pass;

    const drift = ((actual / budgetTokens - 1) * 100).toFixed(1);
    console.log(`budget ${String(budgetTokens).padStart(6)}  actual ${String(actual).padStart(6)} tok ` +
                `(${drift > 0 ? '+' : ''}${drift}%)  ${ms} ms  probes ${pass}/${PROBES.length}`);
    for (const [name, ok] of results) console.log(`   ${ok ? 'pass' : 'FAIL'}  ${name}`);
  }

  if (defaultPass !== null && defaultPass < 6) {
    console.error(`\nregression: default budget ${projectmap.DEFAULT_BUDGET_TOKENS} answers only ${defaultPass}/7 probes (expected >= 6)`);
    process.exit(1);
  }
}

main();
