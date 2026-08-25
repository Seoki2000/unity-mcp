'use strict';

/**
 * unity_project_map — 예산 안에서 이 프로젝트의 구조를 낸다.
 *
 * ⚠️ 로드맵 원안(`unity-mcp-phase3-plan.md` §4-P1)은 "호출/참조 그래프에 중심성 랭킹을
 * 얹는다" 였다. 그 전제를 실측으로 반박한 뒤 설계를 바꿨다(2026-08-25, 설계 문서
 * `C:/dev/unity-mcp-p1-design.md`).
 *
 * 채점 방법: 게임 레포의 최근 30일 커밋 188건이 건드린 타입을 정답지로 두고, 랭킹은
 * **30일 전까지의 데이터로만** 만들어 채점했다(누수 차단).
 *
 *   랭킹              hit@50   recall@50
 *   균등추출 기준선     19.1%      7.5%
 *   callIn(중심성)     28.2%     12.2%
 *   attach(에셋 부착)  33.0%     13.6%
 *   churn(git)        33.5%     23.0%
 *   gitRecency        29.8%     25.1%
 *   attachThenChurn   35.1%     22.1%   <- 채택
 *
 * PageRank 는 상위 20이 컴파일러 생성 타입(`<>c` 는 어셈블리 14개가 한 키로 병합된다),
 * 유틸 클래스, 벤더 오디오 라이브러리로 채워져 기각했다. 축 간 top20 Jaccard 가
 * callIn↔attach 0.03 이라 **단일 합성 점수도 만들지 않는다** — 접으면 한 축이 사라진다.
 *
 * 그래서 이 도구의 주역은 랭킹이 아니라 **코드를 읽어서는 알 수 없는 것**이다:
 * 씬/프리팹 배치, 호출자 0인데 에셋에 붙는 타입, 속성 진입점, 인스펙터 배선.
 */

const { spawnSync } = require('child_process');
const path = require('path');

let log = () => {};
function setLogger(fn) { log = fn; }

// 컴파일러가 만든 타입. 실측(MainProject): 1,046개 중 171개가 여기 걸린다.
// 랭킹을 만들면 바로 상위권에 올라오므로(`<>c` callIn 43) 노드 집합에서 뺀다.
const GENERATED_TYPE = /[<>]|^__|^UnitySourceGeneratedAssembly|(^|\.)MonoScriptData$|(^|\.)NameOf$|^__GEN\./;

// 응답 기본값. 실측: 컴팩트 엔트리 평균 154 B(약 42 토큰), 영역 표 28행 2,619 B.
// 2,000 토큰은 영역 표만으로 35%를 쓴다. 기본값은 인수 프로브(Tools/probe-project-map.js)로 정했다:
// 4,000 → 5/7, 6,000 → 6/7, 8,000 → 7/7. 6,000 을 기본으로 두고 필요하면 호출자가 올린다.
const DEFAULT_BUDGET_TOKENS = 6000;
const MAX_BUDGET_TOKENS = 20000;
const BYTES_PER_TOKEN = 3.7;   // 보고서 환산값(3.5~4)

// 섹션별 예산 배분. 한 섹션이 예산을 다 먹지 않게 상한을 두고, 남은 몫은 뒤 섹션으로 넘긴다.
// 상한 없이 우선순위대로만 채우면 마지막 섹션이 굶는다(초기 구현 실측: ranked 가 0개였다).
const SECTION_SHARE = {
  placement: 0.25,
  dataOnly: 0.15,
  entryPoints: 0.15,
  areas: 0.20,
  ranked: 0.25,
};

// MCP 는 도구 결과를 **문자열 안에** 담아 보내므로 따옴표마다 이스케이프가 붙는다.
// 실측(2026-08-25, 이 응답 3종): 전송 바이트 / 페이로드 바이트 = 1.10~1.12.
// 이걸 무시하면 "2,000 토큰" 이라고 적어 놓고 실제로는 2,400 토큰을 보낸다.
const WIRE_OVERHEAD = 1.11;

const SECTIONS = ['placement', 'dataOnly', 'entryPoints', 'areas', 'ranked'];

// ---------------------------------------------------------------------------
// git 이력 — churn / 마지막 커밋
// ---------------------------------------------------------------------------

// 프로세스 안 메모. 키는 (root, HEAD sha) — 커밋이 쌓이면 자동으로 무효화된다.
// 실측: 전체 이력에 pathspec 'Assets/**/*.cs' 를 걸면 212 ms. pathspec 을 폴더로 주면
// 684 ms~1.1 s 로 뛴다(파일 목록이 커진다) — 확장자까지 좁히는 것이 이 비용의 이유다.
const _gitCache = new Map();

function gitHead(root) {
  const r = spawnSync('git', ['-C', root, 'rev-parse', 'HEAD'], { encoding: 'utf8', timeout: 10000 });
  if (r.error || r.status !== 0) return null;
  return (r.stdout || '').trim() || null;
}

function readGitFileHistory(root) {
  const head = gitHead(root);
  if (!head) {
    // git 이 없거나 레포가 아니다. 랭킹은 attach 단독으로 내려가고 응답이 그 사실을 말한다.
    return { available: false, reason: 'not a git repository, or git is not on PATH' };
  }

  const key = root + '@' + head;
  const hit = _gitCache.get(key);
  if (hit) return hit;

  const t0 = Date.now();
  const r = spawnSync('git', [
    '-C', root, 'log', '--name-only', '--pretty=format:@@%ct', '--', 'Assets/**/*.cs',
  ], { encoding: 'utf8', timeout: 60000, maxBuffer: 128 * 1024 * 1024 });

  if (r.error || r.status !== 0) {
    const out = { available: false, reason: 'git log failed: ' + ((r.error && r.error.message) || r.stderr || 'unknown') };
    _gitCache.set(key, out);
    return out;
  }

  const lastCommit = new Map();   // 프로젝트 상대 .cs 경로 -> epoch seconds
  const churn = new Map();        // 프로젝트 상대 .cs 경로 -> 커밋 수
  let commits = 0;
  let ts = 0;
  for (const line of (r.stdout || '').split(/\r?\n/)) {
    if (line.startsWith('@@')) {
      ts = parseInt(line.slice(2), 10) || 0;
      commits++;
      continue;
    }
    const f = line.trim();
    if (!f || !/\.cs$/i.test(f)) continue;
    if (!lastCommit.has(f) || lastCommit.get(f) < ts) lastCommit.set(f, ts);
    churn.set(f, (churn.get(f) || 0) + 1);
  }

  const out = {
    available: true, head, commits, files: lastCommit.size,
    lastCommit, churn, ms: Date.now() - t0,
  };
  _gitCache.set(key, out);
  log(`project map: git history ${commits} commits / ${lastCommit.size} files in ${out.ms} ms`);
  return out;
}

// ---------------------------------------------------------------------------
// 축 계산
// ---------------------------------------------------------------------------

function typeOfKey(key) {
  const i = key.indexOf('::');
  return i < 0 ? key : key.slice(0, i);
}

function buildAxes(index) {
  const sym = index.symbols;
  const cg = index.callGraph;

  const fileOfType = new Map();
  for (const [n, i] of sym.typeByFullName) {
    if (i.sourceFiles && i.sourceFiles[0]) fileOfType.set(n, i.sourceFiles[0]);
  }

  // 호출 in-degree 는 **서로 다른 소스 파일** 단위로 센다. 타입 단위로만 자기 호출을 빼면
  // 같은 파일 안의 보조 타입끼리 부르는 것이 남아 큰 파일이 유리해진다.
  // 실측(2026-08-26): 엣지 8,673 중 같은 타입 4,119 / **같은 파일 다른 타입 451** / 파일 간 3,834.
  // `TwentyThreeBoss.cs` 는 들어오는 메서드 엣지 233개 중 232개가 같은 파일이고,
  // 실제로 이 파일을 부르는 다른 파일은 **1개**다. 타입 단위로 세면 프로젝트 최대 의존 대상으로 보인다.
  // (독립 감사가 같은 것을 지적했고 여기서 재현했다.)
  // 두 지표를 따로 둔다. 하나로 합치면 라벨이 거짓말을 한다:
  //  - callerFiles: **다른 소스 파일**에서 들어오는 호출. 랭킹·중심성용.
  //  - callerTypes: 자기 타입을 뺀 모든 호출자 타입. "호출자 0" 판정용.
  // 파일 단위 하나만 쓰면 "같은 파일 안에서만 불리는 타입" 이 호출자 0 으로 라벨돼
  // dataOnly 목록이 69 → 96 으로 부풀었다(실측). 그건 데이터 구동이 아니라 파일 내부 호출이다.
  const callInFiles = new Map();
  const callInTypes = new Map();
  if (cg && cg.callersOf) {
    for (const [callee, callers] of cg.callersOf) {
      const ct = typeOfKey(callee);
      const cf = fileOfType.get(ct);
      for (const caller of callers) {
        const st = typeOfKey(caller);
        if (st === ct) continue;
        let t = callInTypes.get(ct);
        if (!t) callInTypes.set(ct, t = new Set());
        t.add(st);

        const sf = fileOfType.get(st);
        // 양쪽 파일을 아는데 같은 파일이면 파일 단위에서는 세지 않는다. 한쪽이라도 모르면
        // 타입으로 센다(파일 미매핑 엣지 269개 — 버리면 그 축이 통째로 사라진다).
        if (sf && cf && sf === cf) continue;
        let s = callInFiles.get(ct);
        if (!s) callInFiles.set(ct, s = new Set());
        s.add(sf || st);
      }
    }
  }

  // 스크립트 GUID -> 타입, 그리고 타입 -> 붙어 있는 에셋
  const scriptTypes = new Map();
  for (const [guid, p] of index.guidToPath) {
    if (!/\.cs$/i.test(p)) continue;
    const ts = sym && sym.typesBySourceFile.get(p);
    if (ts && ts.length) scriptTypes.set(guid, ts);
  }
  const attach = new Map();       // fullName -> Set(asset path)
  const assetTypes = new Map();   // asset path -> Set(fullName)
  for (const [guid, users] of index.scriptRefs) {
    const ts = scriptTypes.get(guid);
    if (!ts) continue;
    for (const ty of ts) {
      let s = attach.get(ty);
      if (!s) attach.set(ty, s = new Set());
      for (const u of users) {
        s.add(u);
        let a = assetTypes.get(u);
        if (!a) assetTypes.set(u, a = new Set());
        a.add(ty);
      }
    }
  }

  const wiredTypes = new Set();
  if (index.inspectorWiring && index.inspectorWiring.byKey) {
    for (const key of index.inspectorWiring.byKey.keys()) wiredTypes.add(typeOfKey(key));
  }
  const typeNamed = new Set(index.typeNameRefs ? index.typeNameRefs.byType.keys() : []);

  // `[Conditional]` 이 붙은 메서드를 가진 타입. 이 타입으로 들어오는 호출은 해당 심볼이 없는
  // 빌드에서 사라지므로, 호출자 수를 "런타임 중요도" 로 읽으면 틀린다(§ Edit.cs).
  const conditional = new Set();
  for (const [n, i] of sym.typeByFullName) {
    for (const m of (i.methods || [])) {
      if ((m.attributes || []).indexOf('System.Diagnostics.ConditionalAttribute') >= 0) { conditional.add(n); break; }
    }
  }

  // 참조 엣지 중 대상 GUID 가 인덱스에 없는 것(패키지·빌트인). 실측: 6,267 중 1,846.
  // 총계만 싣고 이 구분을 빼면 그래프 지표가 조용히 부풀거나 줄어든다.
  let refEdges = 0, refResolved = 0;
  const outDegree = new Map();   // 에셋 경로 -> 이 에셋이 참조하는 대상 수
  for (const [guid, srcs] of index.refs) {
    const known = index.guidToPath.has(guid);
    for (const s of srcs) {
      refEdges++;
      if (known) refResolved++;
      outDegree.set(s, (outDegree.get(s) || 0) + 1);
    }
  }

  // 레지스트리·카탈로그 찾기. 무엇을 "레지스트리" 로 부를지 이름으로 정하지 않고
  // **out-degree** 로 정한다 — 카탈로그는 많은 것을 가리키는 에셋이다.
  // 실측 상위: UniversalRenderPipelineGlobalSettings 154, MapPrefabCatalog 26,
  // DefaultNetworkPrefabs 20, ZoneLayoutCatalog 12. 이름 목록을 하드코딩하면 이 프로젝트
  // 밖에서 바로 틀린다.
  const registries = [...outDegree]
    .filter(([p]) => /\.asset$/i.test(p))
    .map(([asset, references]) => ({ asset, references }))
    .sort((x, y) => (y.references - x.references) || (x.asset < y.asset ? -1 : 1));

  return { callInFiles, callInTypes, attach, assetTypes, wiredTypes, typeNamed, conditional, fileOfType,
           refEdges, refResolved, registries };
}

// ProjectSettings/EditorBuildSettings.asset 의 씬 목록.
//
// 씬을 "타입이 많은 순" 으로만 내면 저자의 의도가 안 보인다 — 빌드 목록은 사람이 적은 순서다.
// 다만 **"프로덕션" 이라고 부르면 안 된다**: 이 프로젝트는 활성 13개 중에 `Dev_Boot`,
// `PlayerDashTest`, `MonsterScene` 같은 개발/테스트 씬이 섞여 있다. enabled 플래그를 그대로 싣는다.
function readBuildScenes(root) {
  const fs = require('fs');
  const p = path.join(root, 'ProjectSettings', 'EditorBuildSettings.asset');
  let text;
  try { text = fs.readFileSync(p, 'utf8'); } catch (e) { return null; }

  const out = [];
  let enabled = null;
  for (const line of text.split(/\r?\n/)) {
    let m = /^\s*-\s*enabled:\s*(\d)/.exec(line);
    if (m) { enabled = m[1] === '1'; continue; }
    m = /^\s*path:\s*(.+?)\s*$/.exec(line);
    if (m && enabled !== null) {
      if (m[1]) out.push({ index: out.length, path: m[1], enabled });
      enabled = null;
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// 본체
// ---------------------------------------------------------------------------

function bytesOf(v) { return Buffer.byteLength(JSON.stringify(v), 'utf8'); }

function buildProjectMap(index, args) {
  const sym = index.symbols;
  if (!sym || !sym.typeByFullName || !sym.typeByFullName.size) {
    return {
      error: 'Symbol index is empty — Library/ScriptAssemblies has no readable user assembly. ' +
             'Let Unity finish compiling, then run unity_index_rebuild.',
    };
  }

  const a = args || {};
  let budgetTokens = Number.isFinite(a.budgetTokens) ? Math.floor(a.budgetTokens) : DEFAULT_BUDGET_TOKENS;
  if (budgetTokens < 800) budgetTokens = 800;   // 그 아래는 고정 문구(캐비어트)만으로 예산을 넘긴다(실측 약 555 토큰)
  if (budgetTokens > MAX_BUDGET_TOKENS) budgetTokens = MAX_BUDGET_TOKENS;
  const cap = Math.floor(budgetTokens * BYTES_PER_TOKEN);

  const scope = typeof a.scope === 'string' && a.scope.trim() ? a.scope.trim().replace(/\\/g, '/').replace(/\/+$/, '') : null;
  const include = typeof a.include === 'string' && a.include.trim()
    ? new Set(a.include.split(',').map(s => s.trim()).filter(Boolean))
    : new Set(SECTIONS);
  const unknownSections = [...include].filter(s => !SECTIONS.includes(s));

  const axes = buildAxes(index);
  const git = readGitFileHistory(index.root);

  const fileOf = n => {
    const i = sym.typeByFullName.get(n);
    return (i && i.sourceFiles && i.sourceFiles[0]) || null;
  };
  const inScope = n => {
    if (!scope) return true;
    const f = fileOf(n);
    // scope 를 주면 소스 경로를 모르는 타입은 빠진다. 몇 개가 빠졌는지 totals 에 적는다.
    return !!f && (f === scope || f.startsWith(scope + '/'));
  };

  const allTypes = [...sym.typeByFullName.keys()];
  const generated = allTypes.filter(n => GENERATED_TYPE.test(n));
  const nodes = allTypes.filter(n => !GENERATED_TYPE.test(n) && inScope(n)).sort();
  const unmapped = nodes.filter(n => !fileOf(n));

  const cInFiles = n => { const s = axes.callInFiles.get(n); return s ? s.size : 0; };
  const cInTypes = n => { const s = axes.callInTypes.get(n); return s ? s.size : 0; };
  const att = n => { const s = axes.attach.get(n); return s ? s.size : 0; };
  const churnOf = n => { const f = fileOf(n); return (git.available && f && git.churn.get(f)) || 0; };
  const lastOf = n => { const f = fileOf(n); return (git.available && f && git.lastCommit.get(f)) || 0; };

  const kindOf = n => {
    const i = sym.typeByFullName.get(n);
    const b = (i && i.baseType) || '';
    if (/MonoBehaviour$/.test(b)) return 'MonoBehaviour';
    if (/NetworkBehaviour$/.test(b)) return 'NetworkBehaviour';
    if (/ScriptableObject$/.test(b)) return 'ScriptableObject';
    if (/(^|\.)Editor$|EditorWindow$/.test(b)) return 'Editor';
    if (b === 'System.ValueType') return 'struct';
    if (b === 'System.Enum') return 'enum';
    if (b === 'System.MulticastDelegate') return 'delegate';
    if (!b) return 'interface';
    if (b === 'System.Object') return 'class';
    return b.split('.').pop();
  };

  const entryOf = n => {
    const e = { type: n, kind: kindOf(n), callerFiles: cInFiles(n), callerTypes: cInTypes(n), assets: att(n) };
    const f = fileOf(n);
    if (f) e.file = f;
    if (git.available) {
      const c = churnOf(n);
      if (c) e.commits = c;
      const l = lastOf(n);
      if (l) e.lastCommit = new Date(l * 1000).toISOString().slice(0, 10);
    }
    const via = [];
    if (axes.wiredTypes.has(n)) via.push('inspectorWired');
    if (axes.typeNamed.has(n)) via.push('typeNameRef');
    if (via.length) e.via = via;
    // 런타임에 없는 것들을 표시한다. 이 표시가 없으면 호출자 수가 "중요도" 로 읽힌다.
    const asmName = (sym.typeByFullName.get(n) || {}).assembly || '';
    if (/Editor$/.test(asmName) || /\/Editor\//.test(f || '')) e.editorOnly = true;
    if (/Tests?$/.test(asmName)) e.test = true;
    if (axes.conditional.has(n)) e.conditional = 'System.Diagnostics.ConditionalAttribute';
    return e;
  };

  // --- 후보 목록 (전부 결정적 정렬: 동점은 이름순)
  const byName = (x, y) => (x < y ? -1 : x > y ? 1 : 0);

  // 1) 배치 — 씬과 프리팹. 코드를 읽어서는 알 수 없는 유일한 정보.
  const sceneRows = [], prefabRows = [];
  for (const [asset, types] of axes.assetTypes) {
    const list = [...types].filter(n => !GENERATED_TYPE.test(n) && inScope(n)).sort();
    if (!list.length) continue;
    // 이름은 6개만 보여주되 **몇 개를 접었는지 적는다.** 조용히 자르면 읽는 쪽은
    // 그 씬에 6개만 있다고 읽는다 — 이 프로젝트에서 반복해 고쳐 온 형태의 오답이다.
    const SAMPLE = 6;
    const row = { asset, types: list.length, top: list.slice(0, SAMPLE) };
    if (list.length > SAMPLE) row.topOmitted = list.length - SAMPLE;
    if (/\.unity$/i.test(asset)) sceneRows.push(row);
    else if (/\.prefab$/i.test(asset)) prefabRows.push(row);
  }
  sceneRows.sort((x, y) => (y.types - x.types) || byName(x.asset, y.asset));
  prefabRows.sort((x, y) => (y.types - x.types) || byName(x.asset, y.asset));

  // 2) 호출자 0인데 에셋에 붙는 타입 — 호출 그래프만 보면 죽은 코드로 보인다.
  // 판정은 callerTypes 로 한다 — 같은 파일 안에서 불리는 것은 데이터 구동이 아니다.
  const dataOnly = nodes.filter(n => cInTypes(n) === 0 && att(n) > 0)
    .sort((x, y) => (att(y) - att(x)) || byName(x, y));

  // 3) 진입점 — 속성과 인스펙터 배선. "호출자 0" 의 뜻을 바꾼다.
  const attrGroups = new Map();
  for (const n of nodes) {
    const i = sym.typeByFullName.get(n);
    for (const m of (i.methods || [])) {
      for (const attr of (m.attributes || [])) {
        let g = attrGroups.get(attr);
        if (!g) attrGroups.set(attr, g = []);
        g.push(n + '::' + m.name);
      }
    }
  }
  // 그룹 하나가 메서드 전체를 실으면 행이 커져서(MenuItem 70개 ≈ 3 kB) 예산 안에
  // **한 그룹도** 못 들어간다(실측: 4,000 토큰에서 attributes 0개). 개수는 항상 남기고
  // 예시만 자른다 — "MenuItem 이 70개 있다" 는 사실이 먼저다.
  const ATTR_METHOD_SAMPLE = 8;
  const attributeRows = [...attrGroups.entries()]
    .map(([attribute, methods]) => {
      const sorted = methods.sort();
      const row = { attribute, count: sorted.length, methods: sorted.slice(0, ATTR_METHOD_SAMPLE) };
      if (sorted.length > ATTR_METHOD_SAMPLE) row.methodsOmitted = sorted.length - ATTR_METHOD_SAMPLE;
      return row;
    })
    .sort((x, y) => (y.count - x.count) || byName(x.attribute, y.attribute));

  const wiredRows = [];
  if (index.inspectorWiring && index.inspectorWiring.byMethod) {
    for (const [, list] of index.inspectorWiring.byMethod) {
      for (const w of list) {
        if (w && w.type && !inScope(w.type)) continue;
        wiredRows.push({ method: (w.type ? w.type + '::' : '') + w.method, asset: w.asset });
      }
    }
  }
  wiredRows.sort((x, y) => byName(x.method, y.method) || byName(x.asset, y.asset));

  // 타입 이름 문자열로만 참조되는 타입 → 어느 에셋이 그렇게 부르는지.
  // 이 축은 부착 0 / 호출자 0 이라 다른 어떤 목록에도 올라오지 않는다. 별도로 싣지 않으면
  // 지도에서 통째로 사라진다(초기 구현 실측: 프로브 "Wells.asset → BombAction" 실패).
  const typeNameRows = [];
  if (index.typeNameRefs && index.typeNameRefs.byType) {
    for (const [ty, assets] of index.typeNameRefs.byType) {
      if (!inScope(ty)) continue;
      const list = [...assets].sort();
      const row = { type: ty, assets: list.slice(0, 3) };
      if (list.length > 3) row.assetsOmitted = list.length - 3;
      typeNameRows.push(row);
    }
  }
  // 이름순으로 두면 잘릴 때 무엇이 남는지가 알파벳 운에 달린다. 참조 에셋이 많은 것부터.
  typeNameRows.sort((x, y) =>
    ((y.assets.length + (y.assetsOmitted || 0)) - (x.assets.length + (x.assetsOmitted || 0))) || byName(x.type, y.type));

  // `[Conditional]` 이 붙은 타입 — 호출자 수가 빌드에서 사라지는 종류.
  const conditionalRows = nodes.filter(n => axes.conditional.has(n))
    .map(n => ({ type: n, file: fileOf(n) || null, callerFiles: cInFiles(n) }))
    .sort((x, y) => (y.callerFiles - x.callerFiles) || byName(x.type, y.type));

  // 4) 영역 — 폴더 행. 정렬을 **조인 밀도**(부착 에셋/타입)로 한다.
  //    타입 수로 정렬하면 벤더 라이브러리가 위로 온다(실측: Assets/BroAudio 208 타입,
  //    부착 에셋 2개). 서드파티 폴더 이름을 하드코딩하는 것은 확장자 화이트리스트에서
  //    이미 실패한 방식이므로, 이름이 아니라 데이터가 가르게 한다.
  const areaMap = new Map();
  for (const n of nodes) {
    const f = fileOf(n);
    const key = f ? f.split('/').slice(0, 3).join('/') : '(no source mapping)';
    let r = areaMap.get(key);
    if (!r) areaMap.set(key, r = { area: key, types: 0, assets: new Set(), callerFiles: 0, wired: 0, typeNamed: 0 });
    r.types++;
    r.callerFiles += cInFiles(n);
    if (axes.wiredTypes.has(n)) r.wired++;
    if (axes.typeNamed.has(n)) r.typeNamed++;
    for (const asset of (axes.attach.get(n) || [])) r.assets.add(asset);
  }
  const areaRows = [...areaMap.values()]
    .map(r => ({
      area: r.area, types: r.types, assets: r.assets.size, callerFiles: r.callerFiles,
      wired: r.wired, typeNamed: r.typeNamed,
      joinDensity: Math.round((r.assets.size / r.types) * 100) / 100,
    }))
    .sort((x, y) => (y.joinDensity - x.joinDensity) || (y.assets - x.assets) || byName(x.area, y.area));

  // 5) 랭킹 — attachThenChurn. 합성 점수를 만들지 않고 성분을 그대로 싣는다.
  const ranked = nodes.slice().sort((x, y) =>
    (att(y) - att(x)) || (churnOf(y) - churnOf(x)) || (cInFiles(y) - cInFiles(x)) || byName(x, y));

  // --- 예산 채우기
  const out = {
    project: index.root,
    budgetTokens,
    scope: scope || null,
    totals: {
      typesIndexed: allTypes.length,
      typesInMap: nodes.length,
      generatedExcluded: generated.length,
      noSourceMapping: unmapped.length,
      attachableTypes: nodes.filter(n => /MonoBehaviour|NetworkBehaviour|ScriptableObject/.test(kindOf(n))).length,
      userAssemblies: sym.assemblies ? sym.assemblies.filter(x => x.isUserAssembly).length : null,
      serializedAssets: index.stats ? index.stats.yamlFiles : null,
      assetGuids: index.stats ? index.stats.metaFiles : null,
      callEdges: index.stats && index.stats.callGraph ? index.stats.callGraph.edges : null,
      referenceEdges: axes.refEdges,
      // 대상이 인덱스 안(프로젝트 에셋)인 엣지와, 패키지·빌트인으로 나가는 엣지를 나눈다.
      // 실측: 6,267 중 1,846 이 인덱스 밖으로 나간다. 총계만 보면 그래프 크기를 오해한다.
      referenceEdgesResolved: axes.refResolved,
      referenceEdgesToUnindexed: axes.refEdges - axes.refResolved,
      // 런타임에 없는 것과 코드가 부르지 않는 축의 크기. 상위 목록에 안 올라와도 존재는 알려야 한다 —
      // 이 프로젝트에서 가장 공들인 축(타입 이름 참조)이 부착 0 이라 랭킹 밑으로 밀렸던 자리다.
      typeNameRefTypes: axes.typeNamed.size,
      conditionalTypes: nodes.filter(n => axes.conditional.has(n)).length,
      editorOnlyTypes: nodes.filter(n => /Editor$/.test((sym.typeByFullName.get(n) || {}).assembly || '') || /\/Editor\//.test(fileOf(n) || '')).length,
      testTypes: nodes.filter(n => /Tests?$/.test((sym.typeByFullName.get(n) || {}).assembly || '')).length,
    },
    git: git.available
      ? { available: true, head: git.head.slice(0, 7), commits: git.commits, files: git.files, ms: git.ms }
      : { available: false, reason: git.reason, effect: 'ranking falls back to asset attachment only; commits and lastCommit are absent' },
    truncated: {},
  };

  // 예산 회계. 두 번 틀렸던 자리다(초기 구현 실측):
  //  (1) 고정 문구(note 들)를 채운 뒤에 붙여서 예산 2,000 이 2,379 토큰으로 나갔다.
  //  (2) 섹션 상한과 전체 상한을 같이 걸어 마지막 섹션(ranked)이 0개가 됐다.
  // 그래서 고정 비용을 **먼저 예약**하고, 남은 몫을 섹션 지분으로 나누고, 안 쓴 지분은 뒤로 넘긴다.
  const NOTES = {
    dataOnly: 'callerTypes is 0 for these types — no other type calls them anywhere in the IL call graph — ' +
      'yet assets attach them, so they run. A call-graph-only view reports them as dead code. ' +
      'callerFiles counts calls from other source files only, which is the ranking signal; ' +
      'a type called solely from its own file has callerFiles 0 but is not data-driven.',
    areas: 'Sorted by joinDensity (assets attached per type), not by type count: ' +
      'a vendored library can hold the most types while nothing in the project instantiates it.',
    ranked: 'Order is asset attachment, then git churn, then calling-file count. No composite score ' +
      'is computed: measured top-20 Jaccard between those axes is 0.03, so folding them into one number ' +
      'hides an axis. Components are included so the order can be audited.',
    // 회수율 캐비어트. 예산이 아무리 작아도 이건 자른다 — 지도의 한계를 지도 안에 적는다.
    map: 'This map is orientation, not a substitute for search. Measured 2026-08-25 against 188 commits ' +
      'from the consuming project (ranking built only from data older than those commits): the top 50 ' +
      'types contain at least one type touched by a given commit 35% of the time and cover 22% of the ' +
      'touched types; a uniform sample of the same size scores 19% / 7.5%. Centrality (PageRank, caller ' +
      'count) measured worse than attachment and git churn, which is why it is not the ordering here. ' +
      'Types with no PDB source mapping (' + unmapped.length + ' here: enums, interfaces, structs, and ' +
      'classes whose bodies compile away) carry no file and no area.',
  };

  // 예산은 **전송 바이트** 기준으로 잡는다(WIRE_OVERHEAD 참조).
  const capPayload = Math.floor(cap / WIRE_OVERHEAD);
  let reserved = bytesOf(out) + 80;   // 80 = bytes/tokensEstimate/truncated 마무리 필드
  reserved += bytesOf(NOTES.map) + 12;
  // entryPointsNote / buildScenesNote 도 고정 비용이다. 빼먹으면 예산을 4% 넘긴다(실측).
  if (include.has('entryPoints')) reserved += 460;
  if (include.has('placement')) reserved += 280;
  for (const s of ['dataOnly', 'areas', 'ranked']) if (include.has(s)) reserved += bytesOf(NOTES[s]) + 16;
  let available = Math.max(0, capPayload - reserved);

  // 지분은 포함된 섹션들 사이에서만 나눈다. 안 쓴 몫은 carry 로 다음 섹션에 넘긴다.
  const activeShare = SECTIONS.filter(s => include.has(s)).reduce((a, s) => a + SECTION_SHARE[s], 0) || 1;
  let carry = 0;
  const allowanceOf = section => Math.floor(available * (SECTION_SHARE[section] / activeShare)) + carry;

  const fill = (section, target, items, mapper, allowance) => {
    let spent = 0, n = 0;
    for (const item of items) {
      const v = mapper(item);
      const size = bytesOf(v) + 1;
      if (spent + size > allowance) break;
      target.push(v); spent += size; n++;
    }
    return { spent, left: items.length - n };
  };

  for (const section of SECTIONS) {
    if (!include.has(section)) { out.truncated[section] = 'excluded by include'; continue; }
    const allowance = allowanceOf(section);

    if (section === 'placement') {
      out.placement = { buildScenes: [], scenes: [], prefabs: [] };
      // 빌드 씬 목록이 먼저다 — 타입 수 순서가 아니라 **사람이 적은 순서**이고, 14행 약 900 B 로 싸다.
      const bs = readBuildScenes(index.root);
      let bsSpent = 0;
      if (bs && bs.length) {
        const r = fill(section, out.placement.buildScenes, bs, x => x, Math.floor(allowance * 0.3));
        if (r.left) out.truncated.buildScenes = r.left;
        out.placement.buildScenesNote =
          'Order and enabled flags come from ProjectSettings/EditorBuildSettings.asset. ' +
          'Enabled does NOT mean production: the enabled list here includes dev and test scenes. ' +
          'Do not treat it as the shipped flow.';
        bsSpent = r.spent + bytesOf(out.placement.buildScenesNote);
      } else {
        out.placement.buildScenes = null;
        out.placement.buildScenesNote = 'ProjectSettings/EditorBuildSettings.asset not readable.';
        bsSpent = bytesOf(out.placement.buildScenesNote);
      }
      // 씬이 프리팹보다 먼저다 — 씬은 21개뿐이고 게임의 진입면이다(실측: 프리팹은 145개).
      // 씬에 60%, 프리팹에 나머지. 씬이 다 먹으면 프리팹이 0개가 된다(실측: 4,000 토큰).
      // 레지스트리(카탈로그) — out-degree 상위 .asset. 씬/프리팹만 보면 "무엇이 무엇을 스폰하나" 를
      // 쥔 에셋이 안 보인다(실측: MapPrefabCatalog, DefaultNetworkPrefabs, ZoneLayoutCatalog).
      out.placement.registries = [];
      const rest0 = Math.max(0, allowance - bsSpent);
      const g = fill(section, out.placement.registries, axes.registries, x => x, Math.floor(rest0 * 0.18));
      if (g.left) out.truncated.registries = g.left;

      const rest = Math.max(0, rest0 - g.spent);
      const s = fill(section, out.placement.scenes, sceneRows, r => r, Math.floor(rest * 0.6));
      const p = fill(section, out.placement.prefabs, prefabRows, r => r, rest - s.spent);
      out.truncated.placement = { scenes: s.left, prefabs: p.left };
      carry = rest - s.spent - p.spent;
    } else if (section === 'dataOnly') {
      out.dataOnly = [];
      const r = fill(section, out.dataOnly, dataOnly, entryOf, allowance);
      if (r.left) out.truncated.dataOnly = r.left;
      out.dataOnlyNote = NOTES.dataOnly;
      carry = allowance - r.spent;
    } else if (section === 'entryPoints') {
      out.entryPoints = { attributes: [], inspectorWired: [], typeNameRefs: [], conditional: [] };
      // 네 축을 각각 배정한다. 하나에 몰아주면 나머지가 0개가 된다(실측: 속성이 다 먹어 wired 0,
      // 그리고 타입이름 축은 애초에 어느 목록에도 없어 지도에서 통째로 빠져 있었다).
      const a2 = fill(section, out.entryPoints.attributes, attributeRows, r => r, Math.floor(allowance * 0.35));
      const w = fill(section, out.entryPoints.inspectorWired, wiredRows, r => r, Math.floor(allowance * 0.20));
      const tn = fill(section, out.entryPoints.typeNameRefs, typeNameRows, r => r, Math.floor(allowance * 0.35));
      const cd = fill(section, out.entryPoints.conditional, conditionalRows, r => r,
                      allowance - a2.spent - w.spent - tn.spent);
      out.truncated.entryPoints = {
        attributes: a2.left, inspectorWired: w.left, typeNameRefs: tn.left, conditional: cd.left,
      };
      out.entryPointsNote =
        'Four axes, each of which makes a zero caller count mean something different: method attributes ' +
        '(the framework calls it), Inspector wiring (an asset calls it), type-name references (a graph ' +
        'instantiates it by string), and [Conditional] methods (the call is removed from builds without ' +
        'that symbol). Ask unity_find_callers for one method, or unity_get_type_symbols for one type.';
      carry = allowance - a2.spent - w.spent - tn.spent - cd.spent;
    } else if (section === 'areas') {
      out.areas = [];
      const r = fill(section, out.areas, areaRows, x => x, allowance);
      if (r.left) out.truncated.areas = r.left;
      out.areasNote = NOTES.areas;
      carry = allowance - r.spent;
    } else if (section === 'ranked') {
      out.ranked = [];
      const r = fill(section, out.ranked, ranked, entryOf, allowance);
      if (r.left) out.truncated.ranked = r.left;
      out.rankedNote = NOTES.ranked;
      carry = allowance - r.spent;
    }
  }

  if (unknownSections.length) {
    out.unknownSections = unknownSections;
    out.unknownSectionsNote = 'Valid sections: ' + SECTIONS.join(', ');
  }

  out.note = NOTES.map;
  out.bytes = bytesOf(out);
  out.tokensEstimate = Math.round((out.bytes * WIRE_OVERHEAD) / BYTES_PER_TOKEN);
  return out;
}

module.exports = { buildProjectMap, setLogger, GENERATED_TYPE, DEFAULT_BUDGET_TOKENS, MAX_BUDGET_TOKENS };
