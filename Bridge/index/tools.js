'use strict';
// 브릿지가 **로컬에서** 처리하는 인덱스 도구들.
//
// 이 도구들은 Unity 로 전달되지 않는다. 그래서
//   - 에디터가 컴파일/도메인 리로드 중이어도 응답한다
//   - 메인 스레드 30초 캡과 무관하다
//   - 질의가 에디터 UI 를 멈추지 않는다
// Phase 1.5 에서 아웃프로세스로 결정한 이유가 이것이다.

const fs = require('fs');
const path = require('path');
const os = require('os');

const scan = require('./scan');
const symbols = require('./symbols');
const callgraph = require('./callgraph');
const wiring = require('./wiring');
const queries = require('./queries');
const projectmap = require('./projectmap');
const impact = require('./impact');
const errorimpact = require('./errorimpact');

const PREFIX = 'unity_index_';   // 상태/재빌드 도구
const LOCAL_TOOL_NAMES = new Set([
  'unity_index_status',
  'unity_index_rebuild',
  'unity_find_references',
  'unity_find_component_usages',
  'unity_find_missing_scripts',
  'unity_get_type_symbols',
  'unity_find_callers',
  'unity_find_callees',
  'unity_get_asset_components',
  'unity_project_map',
  'unity_impact_analysis',
  'unity_explain_compile_errors',
]);

let _index = null;
let _meta = { builtAt: null, fromCache: false };
let _projectRoot = null;
let _buildError = null;

// ── 신선도 ────────────────────────────────────────────────────────
//
// 여기 있던 `if (_index && !force) return _index;` 는 **한 번 메모리에 올라간 인덱스를
// 세션 내내 다시 검증하지 않았다.** 디스크 지문 대조는 loadCache() 안에 있는데 그건
// _index 가 null 일 때만 실행되므로, 브릿지 프로세스당 딱 한 번 돌았다.
// 결과: 브릿지가 붙은 채로 Unity 에서 재컴파일하면 인덱스 도구 11개 전부가
// **컴파일 이전 그래프**로 답했다. da98185 에서 만든 낡음 감지가 핫패스에서 통째로 건너뛰어졌다.
// §4-(21) 과 같은 형태다 — 장치는 있는데 실제 응답 경로에 안 실려 있었다.
//
// 두 단으로 나눈 이유는 비용이다(실측):
//   어셈블리 서명  378 파일 /  15~18 ms → 매번. 심볼·호출그래프의 출처이고 재컴파일을 잡는다
//   전체 에셋 지문 5,825 파일 / 690 ms → throttle. 안 그러면 웜 48 ms 질의가 죽는다
const ASSET_RECHECK_INTERVAL_MS = Number(process.env.UNITY_MCP_ASSET_RECHECK_MS || 10000);

let _asmSig = null;            // 인덱스를 만들/올릴 때의 어셈블리 서명
let _validatedAt = null;       // 마지막으로 디스크와 대조가 끝난 시각
let _lastAssetCheckAt = 0;     // 마지막 전체 지문 대조 시각
let _revalidations = 0;        // 재검증 횟수(프로브가 본다)
let _staleReason = null;       // 마지막으로 인덱스를 버린 이유

/** 메모리의 인덱스가 아직 디스크와 같은 세대인가. 아니면 버릴 이유를 돌려준다. */
function stalenessReason(root) {
  const nowSig = scan.assemblySignature(root);
  if (!scan.sameAssemblySignature(nowSig, _asmSig)) {
    return `assemblies changed (files ${_asmSig ? _asmSig.files : '?'}->${nowSig.files}, ` +
           `hash ${_asmSig ? _asmSig.hash : '?'}->${nowSig.hash})`;
  }
  const now = Date.now();
  if (now - _lastAssetCheckAt >= ASSET_RECHECK_INTERVAL_MS) {
    _lastAssetCheckAt = now;
    if (_index && _index.fingerprint) {
      const nowFp = scan.fingerprint(root, { includePackageCache: !!_index.includePackageCache });
      const old = _index.fingerprint;
      if (nowFp.metaFiles !== old.metaFiles || nowFp.yamlFiles !== old.yamlFiles ||
          nowFp.totalBytes !== old.totalBytes || nowFp.hash !== old.hash) {
        return `assets changed (yaml ${old.yamlFiles}->${nowFp.yamlFiles}, hash ${old.hash}->${nowFp.hash})`;
      }
    }
  }
  return null;
}

/** 테스트 시임 — 프로브가 "낡은 채로 서빙하지 않는다" 를 재현할 때 쓴다. */
function _forceStaleForTest() {
  _asmSig = { files: -1, maxMtimeMs: 0, totalBytes: 0, hash: 0, missing: false };
}
function _freshness() {
  return {
    validatedAt: _validatedAt,
    revalidations: _revalidations,
    staleReason: _staleReason,
    assembliesMaxMtime: _asmSig ? new Date(_asmSig.maxMtimeMs).toISOString() : null,
    assembliesFiles: _asmSig ? _asmSig.files : null,
    assetCheckIntervalMs: ASSET_RECHECK_INTERVAL_MS,
  };
}
function _projectRootForTest() { return _projectRoot; }

/** 이 이름을 브릿지가 로컬에서 처리하는가. */
function isLocalTool(name) {
  return LOCAL_TOOL_NAMES.has(name);
}

/**
 * 프로젝트 루트 해석.
 * 1) UNITY_MCP_PROJECT 환경변수
 * 2) Unity 가 쓴 auth-token-{port}.json 의 projectRoot
 *
 * ⚠️ 브릿지 스크립트 위치로 역산할 수 없다 — file:/임베디드 패키지에서는 패키지가
 *    프로젝트 밖(C:/dev/unity-mcp)에 있을 수 있다.
 */
function resolveProjectRoot(port) {
  if (process.env.UNITY_MCP_PROJECT) {
    return process.env.UNITY_MCP_PROJECT.replace(/\\/g, '/');
  }
  try {
    const p = path.join(os.homedir(), '.unity-mcp', `auth-token-${port}.json`);
    const parsed = JSON.parse(fs.readFileSync(p, 'utf8'));
    if (parsed && typeof parsed.projectRoot === 'string' && parsed.projectRoot) {
      return parsed.projectRoot.replace(/\\/g, '/');
    }
  } catch { /* 토큰 파일 없음 또는 구버전 — 아래에서 에러로 보고한다 */ }
  return null;
}

function cachePath(root) {
  // 프로젝트별로 분리한다. 경로를 파일명에 쓸 수 없으므로 해시 대신 안전 치환을 쓴다.
  const key = root.replace(/[^A-Za-z0-9]+/g, '_').slice(-80);
  return path.join(os.homedir(), '.unity-mcp', `index-${key}.json`);
}

// 4: YAML_EXT 확장 (2026-08-23). 구 캐시는 6종만 훑은 것이라 참조 커버리지가 부족하다.
//    버전을 올려 자동으로 폐기시킨다 — 안 올리면 수정이 재빌드 전까지 안 먹는다.
// 12: 시그니처 키 호출 그래프 추가 (2026-08-27). 구 캐시에는 callsFromSig 가 없어
//     오버로드 구분이 통째로 빠진다.
// 5: 캐시 지문 추가 (2026-08-23). 이전 캐시에는 fingerprint 가 없어 유효성 검사가 불가능하다.
// 6: 참조 엣지 규칙 변경 (2026-08-24) — 맨 GUID 참조, .meta 참조, 자기 참조 제외.
//    지문은 **디스크 상태**만 보므로 코드가 바뀐 것은 못 잡는다. 버전을 안 올리면
//    기존 캐시가 옛 엣지(6,021)를 계속 서빙하고, 고친 오답이 그대로 남는다.
// 7: 레이어 D 추가 — 인스펙터 배선 + 타입 이름 문자열 참조.
//    캐시에 없으면 캐시로 뜬 세션에서 통째로 사라진다.
// 8: 메서드 속성(CustomAttribute) 수집. 구 캐시에는 없어 진입점이 안 보인다.
// 9: `[Conditional]` 속성 수집(구 캐시에는 없어 조건부 컴파일 증거가 통째로 빠진다).
// 10: ProjectSettings 를 참조 출처로 스캔. 프로젝트 에셋 19개(그중 씬 13)의 참조가 빠져 있었다.
// 11: 전체 이름이 겹쳐 밀린 타입 123개를 캐시에 보존. 이걸 잃으면 짧은 이름이 전부 유일해 보여
//     유일성에 기대는 두 곳이 조용히 하나를 골라 답한다(캐시로 뜬 세션에서만 다르게 동작했다).
// 13: 시퀀스 포인트 디코딩 수정. 구 캐시는 메서드 줄 범위 27.4% 가 틀렸고 음수 줄까지 있다
//     — 안 올리면 고친 코드가 캐시로 뜬 세션에서 안 먹는다(§4-(18) 과 같은 형태).
// 14: 같은 날 독립 검증 후속 — `endLine` 이 마지막 포인트의 **끝 줄**이 됐고(구 캐시는
//     시작 줄의 최댓값: 메서드 133개가 최대 22줄 짧았다), Document 컬럼이 0 인 메서드도
//     주 문서를 갖는다(부분 클래스 누출 22건).
const CACHE_VERSION = 14;

function saveCache(index) {
  try {
    const payload = {
      version: CACHE_VERSION,
      root: index.root,
      includePackageCache: index.includePackageCache,
      builtAt: new Date().toISOString(),
      // 디스크 상태 지문. 로드 시 다시 계산해 대조한다 — 어긋나면 캐시를 버린다.
      fingerprint: index.fingerprint || null,
      guidCoverage: index.guidCoverage,
      stats: index.stats,
      guidToPath: [...index.guidToPath],
      refs: [...index.refs].map(([g, s]) => [g, [...s]]),
      scriptRefs: [...index.scriptRefs].map(([g, s]) => [g, [...s]]),
      weakRefs: index.weakRefs ? [...index.weakRefs].map(([g, s]) => [g, [...s]]) : [],
      callGraph: index.callGraph ? {
        stats: index.callGraph.stats,
        callsFrom: [...index.callGraph.callsFrom].map(([k, v]) => [k, [...v]]),
        // 시그니처 그래프도 저장한다. 안 하면 캐시로 뜬 세션에서 오버로드 구분이
        // 통째로 사라지고, 도구는 "시그니처 키가 없다" 를 조용히 답한다 - 캐시가
        // duplicateTypes 를 잃어 모호성이 사라진 전례와 같은 형태다(§4-(24)-2).
        callsFromSig: index.callGraph.callsFromSig
          ? [...index.callGraph.callsFromSig].map(([k, v]) => [k, [...v]]) : null,
      } : null,
      typeNameRefs: index.typeNameRefs ? {
        stats: index.typeNameRefs.stats,
        byType: [...index.typeNameRefs.byType].map(([t, s2]) => [t, [...s2]]),
      } : null,
      inspectorWiring: index.inspectorWiring ? {
        stats: index.inspectorWiring.stats,
        // byKey 는 byMethod 에서 재구성할 수 있으므로 저장하지 않는다(캐시 크기).
        byMethod: [...index.inspectorWiring.byMethod].map(([m, list]) => [m, list]),
      } : null,
      symbols: index.symbols ? {
        stats: index.symbols.stats,
        assemblies: index.symbols.assemblies,
        types: [...index.symbols.typeByFullName.values()],
        // 전체 이름 충돌로 밀린 것들. 신선 빌드와 캐시 로드가 **같은 맵**을 갖게 하려면 필요하다.
        duplicateTypes: index.symbols.duplicateTypes || [],
      } : null,
    };
    fs.mkdirSync(path.dirname(cachePath(index.root)), { recursive: true });
    fs.writeFileSync(cachePath(index.root), JSON.stringify(payload));
  } catch (e) {
    log(`index cache save failed: ${e.message}`);
  }
}

function loadCache(root) {
  try {
    const raw = JSON.parse(fs.readFileSync(cachePath(root), 'utf8'));
    if (!raw || raw.version !== CACHE_VERSION || raw.root !== root) return null;

    // version 과 root 만 보던 검사에 지문 대조를 더한다. 그것만 보면 에셋이 바뀐 뒤에도
    // 낡은 인덱스를 계속 서빙하고, 질의는 조용히 틀린 답을 낸다 — 쓰는 쪽이 알 방법이 없다.
    // 어긋나면 null 을 돌려 호출부가 전체 재빌드로 넘어가게 한다 (이 프로젝트에서 1.1 초).
    if (!raw.fingerprint) return null;   // 지문 없는 구 캐시
    const nowFp = scan.fingerprint(root, { includePackageCache: !!raw.includePackageCache });
    const oldFp = raw.fingerprint;
    if (oldFp.hash === undefined) return null;   // 해시 없는 구 지문
    if (nowFp.metaFiles !== oldFp.metaFiles || nowFp.yamlFiles !== oldFp.yamlFiles ||
        nowFp.totalBytes !== oldFp.totalBytes || nowFp.hash !== oldFp.hash) {
      log(`cache stale — rebuilding (meta ${oldFp.metaFiles}->${nowFp.metaFiles}, ` +
          `yaml ${oldFp.yamlFiles}->${nowFp.yamlFiles}, bytes ${oldFp.totalBytes}->${nowFp.totalBytes}, ` +
          `hash ${oldFp.hash}->${nowFp.hash})`);
      return null;
    }

    const guidToPath = new Map(raw.guidToPath);
    const pathToGuid = new Map();
    for (const [g, p] of guidToPath) pathToGuid.set(p, g);

    let sym = null;
    if (raw.symbols && Array.isArray(raw.symbols.types)) {
      const typeByFullName = new Map();
      const typeByQualifiedName = new Map();
      const typesByShortName = new Map();
      const typesBySourceFile = new Map();
      for (const t of raw.symbols.types) {
        typeByFullName.set(t.fullName, t);
        if (t.qualifiedName && t.qualifiedName !== t.fullName && !typeByQualifiedName.has(t.qualifiedName))
          typeByQualifiedName.set(t.qualifiedName, t);
        let sl = typesByShortName.get(t.name);
        if (!sl) typesByShortName.set(t.name, sl = []);
        sl.push(t.fullName);
        for (const sf of t.sourceFiles || []) {
          let l = typesBySourceFile.get(sf);
          if (!l) typesBySourceFile.set(sf, l = []);
          if (!l.includes(t.fullName)) l.push(t.fullName);
        }
      }
      // 밀린 중복도 짧은 이름 맵에는 넣는다 — 빌드 경로와 같은 상태여야 한다.
      // typeByFullName 은 건드리지 않는다(빌드도 첫 것만 담는다).
      const dups = Array.isArray(raw.symbols.duplicateTypes) ? raw.symbols.duplicateTypes : [];
      for (const t of dups) {
        if (t.qualifiedName && t.qualifiedName !== t.fullName && !typeByQualifiedName.has(t.qualifiedName))
          typeByQualifiedName.set(t.qualifiedName, t);
        let sl = typesByShortName.get(t.name);
        if (!sl) typesByShortName.set(t.name, sl = []);
        sl.push(t.fullName);
      }
      sym = { typeByFullName, typeByQualifiedName, typesByShortName, typesBySourceFile, duplicateTypes: dups,
              assemblies: raw.symbols.assemblies || [], stats: raw.symbols.stats || {} };
    }

    let cg = null;
    if (raw.callGraph && Array.isArray(raw.callGraph.callsFrom)) {
      const callsFrom = new Map(raw.callGraph.callsFrom.map(([k, v]) => [k, new Set(v)]));
      // 역방향은 저장하지 않고 로드 시 재구성한다(캐시 크기 절반).
      const callersOf = new Map();
      for (const [from, tos] of callsFrom) {
        for (const to of tos) {
          let c = callersOf.get(to);
          if (!c) callersOf.set(to, c = new Set());
          c.add(from);
        }
      }
      // 시그니처 그래프를 역방향까지 복원한다. 저장 형태는 callsFromSig 하나뿐이고
      // callersOfSig 는 빌드 때와 같은 방식으로 뒤집어 만든다.
      let callsFromSig = new Map();
      let callersOfSig = new Map();
      if (Array.isArray(raw.callGraph.callsFromSig)) {
        callsFromSig = new Map(raw.callGraph.callsFromSig.map(([k, v]) => [k, new Set(v)]));
        for (const [from, tos] of callsFromSig) {
          for (const to of tos) {
            let c = callersOfSig.get(to);
            if (!c) callersOfSig.set(to, c = new Set());
            c.add(from);
          }
        }
      }
      cg = { callsFrom, callersOf, callsFromSig, callersOfSig,
             perAssembly: [], stats: raw.callGraph.stats || {} };
    }

    let iw = null;
    if (raw.inspectorWiring && Array.isArray(raw.inspectorWiring.byMethod)) {
      const byMethod = new Map(raw.inspectorWiring.byMethod.map(([m, list]) => [m, list]));
      const byKey = new Map();
      for (const [, list] of byMethod) {
        for (const e of list) {
          if (!e || !e.type) continue;
          const key = `${e.type}::${e.method}`;
          let set = byKey.get(key);
          if (!set) byKey.set(key, set = new Set());
          set.add(e.asset);
        }
      }
      iw = { byKey, byMethod, stats: raw.inspectorWiring.stats || {} };
    }

    let tnr = null;
    if (raw.typeNameRefs && Array.isArray(raw.typeNameRefs.byType)) {
      tnr = {
        byType: new Map(raw.typeNameRefs.byType.map(([t, a]) => [t, new Set(a)])),
        stats: raw.typeNameRefs.stats || {},
      };
    }

    return {
      root,
      includePackageCache: raw.includePackageCache,
      guidCoverage: raw.guidCoverage || 'assets',
      callGraph: cg,
      inspectorWiring: iw,
      typeNameRefs: tnr,
      guidToPath,
      pathToGuid,
      refs: new Map(raw.refs.map(([g, a]) => [g, new Set(a)])),
      scriptRefs: new Map(raw.scriptRefs.map(([g, a]) => [g, new Set(a)])),
      weakRefs: new Map((raw.weakRefs || []).map(([g, a]) => [g, new Set(a)])),
      symbols: sym,
      stats: raw.stats,
      // 지문을 복원해 둔다. 안 하면 캐시에서 올린 인덱스에는 fingerprint 가 없고,
      // 그 상태로 다시 저장될 때(예: PackageCache 병합 후) fingerprint: null 이 기록된다.
      // 다음 세션은 "지문 없는 구 캐시" 로 보고 매번 전체 재빌드를 한다 —
      // 답은 맞지만 캐시가 조용히 죽는다. 실측(2026-08-24): 그래서 3.7초를 매번 다시 썼다.
      fingerprint: raw.fingerprint,
      _builtAt: raw.builtAt,
    };
  } catch {
    return null;   // 캐시 없음/손상 — 안전하게 재빌드한다
  }
}

let _log = () => {};
function setLogger(fn) {
  _log = fn;
  projectmap.setLogger(msg => _log(`[index] ${msg}`));
  impact.setLogger(msg => _log(`[index] ${msg}`));
}
function log(msg) { _log(`[index] ${msg}`); }

/**
 * 인덱스를 확보한다. 캐시가 있으면 쓰고, 없으면 빌드한다.
 * @param {boolean} force 캐시를 무시하고 다시 빌드
 */
function ensureIndex(port, force, includePackageCache, cacheOnly) {
  // 메모리에 있어도 **그냥 돌려주지 않는다.** 디스크와 같은 세대인지 먼저 본다.
  if (_index && !force) {
    const reason = _projectRoot ? stalenessReason(_projectRoot) : null;
    if (!reason) { _validatedAt = new Date().toISOString(); return _index; }
    log(`in-memory index stale — dropping (${reason})`);
    _staleReason = reason;
    _revalidations++;
    _index = null;          // 아래 로드/재빌드 경로로 떨어뜨린다
    _meta = { builtAt: null, fromCache: false };
  }

  if (!_projectRoot) _projectRoot = resolveProjectRoot(port);
  if (!_projectRoot) {
    _buildError =
      'Project root unknown. The Unity MCP server writes it into ' +
      `~/.unity-mcp/auth-token-${port}.json (restart the server in Unity to refresh it), ` +
      'or set the UNITY_MCP_PROJECT environment variable.';
    return null;
  }
  if (!fs.existsSync(path.join(_projectRoot, 'Assets'))) {
    _buildError = `'${_projectRoot}/Assets' not found — projectRoot looks wrong.`;
    return null;
  }

  if (!force) {
    const cached = loadCache(_projectRoot);
    if (cached) {
      _index = cached;
      _meta = { builtAt: cached._builtAt, fromCache: true };
      _asmSig = scan.assemblySignature(_projectRoot);
      _validatedAt = new Date().toISOString();
      _lastAssetCheckAt = Date.now();   // 방금 loadCache 가 전체 지문을 대조했다
      log(`loaded from cache (${cached.stats.yamlFiles} yaml files, built ${cached._builtAt})`);
      return _index;
    }
  }

  if (cacheOnly) {
    // 상태 조회 경로 — 디스크 캐시가 없으면 빌드하지 않는다(수 초가 걸린다).
    return null;
  }

  log(`building index for ${_projectRoot}${includePackageCache ? ' (+PackageCache)' : ''}...`);
  // 서명을 **빌드 전에** 찍는다. 빌드 도중 재컴파일이 나면 우리가 읽은 어셈블리가 섞인
  // 것이므로, 다음 호출에서 낡음으로 잡혀 다시 빌드되는 쪽이 맞다.
  _asmSig = scan.assemblySignature(_projectRoot);
  _index = scan.buildIndex(_projectRoot, { includePackageCache: !!includePackageCache });
  log(`layer A built in ${_index.stats.msTotal}ms — ${_index.stats.guids} guids, ` +
      `${_index.stats.referenceEdges} edges, ${_index.stats.scriptGuids} script guids`);

  // 레이어 B — 컴파일된 어셈블리 심볼 + PDB 소스 매핑. 조인의 다른 한쪽이다.
  const sym = symbols.buildSymbolIndex(_projectRoot);
  if (sym.error) {
    log(`symbol index unavailable: ${sym.error}`);
    _index.symbols = null;
    _index.stats.symbolError = sym.error;
  } else {
    _index.symbols = sym;
    _index.stats.symbols = sym.stats;
    log(`layer B built in ${sym.stats.msTotal}ms — ${sym.stats.userAssemblies} user assemblies, ` +
        `${sym.stats.types} types, ${sym.stats.sourceFilesMapped} source files mapped` +
        (sym.stats.failedAssemblies ? `, ${sym.stats.failedAssemblies} failed` : ''));

    // 레이어 B-2 — IL 본문 디코딩으로 호출 그래프. 심볼 인덱스가 있어야 한다(타입 필터).
    try {
      const cg = callgraph.buildCallGraph(_projectRoot, sym);
      _index.callGraph = cg;
      _index.stats.callGraph = cg.stats;
      log(`call graph built in ${cg.stats.msTotal}ms — ${cg.stats.edges} edges, ` +
          `${cg.stats.methodsDecoded} methods decoded` +
          (cg.stats.methodsFailed ? `, ${cg.stats.methodsFailed} undecodable` : ''));
    } catch (e) {
      log(`call graph unavailable: ${e.message}`);
      _index.callGraph = null;
      _index.stats.callGraphError = e.message;
    }

    // 레이어 D — 인스펙터 배선. 조인이 필요하므로 심볼 인덱스 뒤에 온다.
    try {
      const w = wiring.buildInspectorWiring(_projectRoot, _index.eventFiles || [], _index,
        queries.resolveScriptType);
      _index.inspectorWiring = w;
      _index.stats.inspectorWiring = w.stats;
      log(`inspector wiring built in ${w.stats.msTotal}ms — ${w.stats.calls} calls in ` +
          `${w.stats.files} files, ${w.stats.resolvedByJoin} resolved by join` +
          (w.stats.staleDeclaredNames ? `, ${w.stats.staleDeclaredNames} stale declared names` : ''));
      const tn = wiring.buildTypeNameRefs(_projectRoot, _index.typeRefFiles || [], sym);
      _index.typeNameRefs = tn;
      _index.stats.typeNameRefs = tn.stats;
      log(`type-name refs built in ${tn.stats.msTotal}ms — ${tn.stats.types} types referenced by name ` +
          `in ${tn.stats.files} files (${tn.stats.candidates} candidates scanned)`);
    } catch (e) {
      log(`inspector wiring unavailable: ${e.message}`);
      _index.inspectorWiring = null;
      _index.stats.inspectorWiringError = e.message;
    }
  }

  _meta = { builtAt: new Date().toISOString(), fromCache: false };
  _buildError = null;
  // 신규 빌드 경로에서도 신선도 상태를 남긴다. 안 하면 _asmSig 가 null 로 남아
  // 다음 호출마다 "낡음" 으로 판정돼 **매 호출 재빌드**에 빠진다.
  _validatedAt = new Date().toISOString();
  _lastAssetCheckAt = Date.now();
  saveCache(_index);
  return _index;
}

/** MCP tools/list 에 합쳐질 도구 정의. annotations 는 전부 읽기 전용이다. */
function toolDefinitions() {
  const ro = { readOnlyHint: true, destructiveHint: false, idempotentHint: true };
  const paging = {
    maxResults: { type: 'integer', description: 'Maximum results (default 50, max 500)' },
    offset: { type: 'integer', description: "Start index; pass the previous response's nextOffset to continue" },
  };
  return [
    {
      name: 'unity_index_status',
      description: 'Project index status: whether it is built, when, and its counts. Served by the local bridge, so it works even while Unity is compiling.',
      inputSchema: { type: 'object', properties: {}, required: [] },
      annotations: ro,
    },
    {
      name: 'unity_index_rebuild',
      description: 'Rebuild the project index from disk. Use after large external changes (branch switch, mass import).',
      inputSchema: {
        type: 'object',
        properties: {
          includePackageCache: {
            type: 'boolean',
            description: 'Also index Library/PackageCache .meta files. Roughly 45x slower (measured: 211ms vs 9.6s); only needed to resolve references into cached packages.',
          },
        },
        required: [],
      },
      // 재빌드는 상태를 바꾸지만 프로젝트를 바꾸지 않는다. 반복해도 결과가 같다.
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    },
    {
      name: 'unity_find_references',
      description: 'Find assets that reference the given asset, by GUID reverse-index. Accepts an asset path or a 32-char GUID. O(1) lookup instead of scanning every asset with GetDependencies. Scope: every text file under Assets — serialized assets, .meta importer settings, shader graphs, asmdefs, source. Binary files and run-time path lookups (Resources.Load, Addressables addresses) are invisible to it, and Unity own GetDependencies misses VFX Graph internal references (measured), so a zero from either side is unproven rather than proof of no reference. A zero result carries what was scanned.',
      inputSchema: {
        type: 'object',
        properties: {
          target: { type: 'string', description: "Asset path (e.g. 'Assets/Art/Wall.mat') or 32-character GUID" },
          ...paging,
        },
        required: ['target'],
      },
      annotations: ro,
    },
    {
      name: 'unity_find_component_usages',
      description: 'Find every prefab/scene/asset that has the given script attached, by joining m_Script GUIDs against .meta. Answers "which prefabs use this MonoBehaviour" — which a text search over .cs files cannot.',
      inputSchema: {
        type: 'object',
        properties: {
          script: { type: 'string', description: "Script asset path (e.g. 'Assets/Scripts/Player.cs') or its 32-character GUID" },
          ...paging,
        },
        required: ['script'],
      },
      annotations: ro,
    },
    {
      name: 'unity_get_type_symbols',
      description: 'Get symbols for a compiled type: base type, fields, methods, declaring assembly and source file. Read from the compiled assembly metadata plus its Portable PDB, so it reflects what actually compiled — not a text parse of .cs.',
      inputSchema: {
        type: 'object',
        properties: {
          type: { type: 'string', description: "Full type name (e.g. 'MyGame.Player') or short name if unambiguous" },
          maxMembers: { type: 'integer', description: 'Max fields and methods to return (default 100, max 500)' },
        },
        required: ['type'],
      },
      annotations: ro,
    },
    {
      name: 'unity_find_callers',
      description: "Find every project method that actually calls the given method, decoded from compiled IL. Unlike a text search this excludes comments, declarations and string matches — answers \"can I safely rename this?\". Accepts 'Type::Method', 'Type.Method', or a bare method name if unambiguous.",
      inputSchema: {
        type: 'object',
        properties: {
          method: { type: 'string', description: "e.g. 'BaseAttack::TryResolveHit' or just 'TryResolveHit'" },
          ...paging,
        },
        required: ['method'],
      },
      annotations: ro,
    },
    {
      name: 'unity_find_callees',
      description: 'Find every project method the given method calls, decoded from compiled IL. Calls into UnityEngine/BCL are intentionally excluded to keep the graph focused on project code.',
      inputSchema: {
        type: 'object',
        properties: {
          method: { type: 'string', description: "e.g. 'PlayerDefaultAttack::HitOverlap'" },
          ...paging,
        },
        required: ['method'],
      },
      annotations: ro,
    },
    {
      name: 'unity_get_asset_components',
      description: 'Read the components of a prefab/scene/asset with their serialized field values, resolving each m_Script GUID to the compiled type name. Answers "what is attached here and what is each field set to" — which reading .cs cannot (values live in the asset) and reading the YAML alone cannot (the asset stores a GUID, not a type name). Object references resolve to asset paths; serialized keys are checked against the compiled type, so stale keys left by renamed fields are visible.',
      inputSchema: {
        type: 'object',
        properties: {
          asset: { type: 'string', description: "Asset path (e.g. 'Assets/2.Prefabs/Player.prefab') or its 32-character GUID" },
          component: { type: 'string', description: 'Only components whose type name contains this (case-insensitive)' },
          gameObject: { type: 'string', description: 'Only components on GameObjects whose name contains this' },
          fileID: { type: 'string', description: 'Only the object with this fileID (the &anchor)' },
          includeGameObjects: { type: 'boolean', description: 'Include GameObject documents (default true)' },
          includeUnityKeys: { type: 'boolean', description: 'Include Unity header keys (m_ObjectHideFlags etc; default false)' },
          maxDepth: { type: 'integer', description: 'Value nesting depth (default 8, max 32)' },
          maxArrayItems: { type: 'integer', description: 'Items per array (default 200, max 2000)' },
          maxValueBytes: { type: 'integer', description: 'Value bytes per component (default 16000, max 200000)' },
          ...paging,
        },
        required: ['asset'],
      },
      annotations: ro,
    },
    {
      name: 'unity_find_missing_scripts',
      description: 'Find assets whose components reference a script that no longer exists (Editor shows "The associated script can not be loaded"). Found by joining serialized m_Script GUIDs against .meta files.',
      inputSchema: { type: 'object', properties: { ...paging }, required: [] },
      annotations: ro,
    },
    {
      name: 'unity_impact_analysis',
      description: 'What breaks if you change, rename or delete this type, method or asset. Joins every axis the index has and keeps them separate, because each breaks differently: IL callers, subclasses, assets whose components use the type, assets referencing the asset, UnityEvent Inspector wirings, assembly-qualified type-name strings in Behavior graphs, const-path loads from code, ProjectSettings and build-scene membership, and attribute entry points. Reports what it cannot see in the same response — dynamic load sites, interface implementers (not indexed), skipped binaries — because zero on every axis is not proof that nothing breaks.',
      inputSchema: {
        type: 'object',
        properties: {
          target: { type: 'string', description: "A type name ('Hurtbox'), a 'Type::Method' key, or an asset path / 32-character GUID" },
          depth: { type: 'integer', description: 'Caller levels to follow (default 1, max 3). Level 2+ come back as counts with a sample; the inheritance closure is always complete' },
          maxPerAxis: { type: 'integer', description: 'Items listed per axis (default 25, max 200). Omitted counts are always reported' },
        },
        required: ['target'],
      },
      annotations: ro,
    },
    {
      name: 'unity_project_map',
      description: 'Orientation for an unfamiliar project, within a token budget: which scenes and prefabs each script type is actually placed in, types that no code calls but assets attach (dead to a call graph, alive at run time), entry points from method attributes and Inspector wiring, and source areas ranked by how much of the project data attaches to them. Reads the same index as the other local tools, so no Unity round-trip. Ordering components (attachment, git churn, caller count) ship with every entry, and the response carries the measured hit rate — the map is orientation, not a substitute for search.',
      inputSchema: {
        type: 'object',
        properties: {
          budgetTokens: { type: 'integer', description: 'Approximate token budget for the response (default 6000, min 800, max 20000). Measured: 4000 answers 5 of 7 structural probes, 6000 answers 6, 8000 answers all 7' },
          scope: { type: 'string', description: "Restrict to a source folder prefix (e.g. 'Assets/1.Scripts'); types with no source mapping drop out" },
          include: { type: 'string', description: 'Comma-separated sections: placement, dataOnly, entryPoints, areas, ranked. Default all' },
        },
        required: [],
      },
      annotations: ro,
    },
    {
      name: 'unity_explain_compile_errors',
      description:
        'Join compiler diagnostics you already have to the project index: which method and type each ' +
        'error sits in, who calls that method, which prefabs/scenes carry the type, and whether the ' +
        'file is yours or a package. Pass the errors array from unity_get_compilation_status. Runs ' +
        'entirely in the bridge, so it answers while Unity is compiling or reloading. Reports its own ' +
        'staleness: Unity does not rebuild assemblies when compilation fails, so during a failure the ' +
        'graph describes the last good build and a newly added symbol is absent - pass hadErrors so ' +
        'the response says so instead of implying the join is current.',
      inputSchema: {
        type: 'object',
        properties: {
          errors: {
            type: 'array',
            items: {
              type: 'object',
              properties: { file: { type: 'string' }, line: { type: 'integer' }, message: { type: 'string' } },
              required: ['file'],
            },
          },
          hadErrors: { type: 'boolean', description: 'hasErrors from the status call; sets the freshness label' },
          compilationGeneration: { type: 'integer' },
          maxErrors: { type: 'integer', description: 'Cap on analysed errors (default and max 50); omitted count is reported' },
        },
        required: ['errors'],
      },
      annotations: ro,
    }
  ];
}

/** 로컬 도구 실행. MCP tools/call result 형태로 돌려준다. */
function callLocalTool(name, args, port) {
  const a = args || {};

  if (name === 'unity_index_status') {
    // 상태 조회는 **빌드를 강제하지 않는다** — 다만 디스크 캐시는 읽는다(파일 하나, 싸다).
    // 캐시가 있는데도 "not built" 로 보고하면 AI 가 불필요하게 rebuild(수 초)를 호출한다.
    const idx = ensureIndex(port, false, false, true);
    if (!idx) {
      return ok({
        ...queries.status(null, _meta),
        cacheAvailable: false,
        error: _buildError || undefined,
      });
    }
    // callGraph.perAssembly 는 지금까지 **쓰기 전용**이었다 — 어셈블리 하나가 디코딩에
    // 실패하면 `perAssembly.push({assembly, error})` 에만 남고 어느 응답에도 안 실렸다.
    // 즉 실패한 어셈블리가 통째로 보이지 않았다. 지우는 대신 문제 있는 항목만 싣는다.
    const pa = (idx.callGraph && idx.callGraph.perAssembly) || [];
    const troubled = pa.filter(a => a && (a.error || a.failed > 0));
    return ok({
      ...queries.status(idx, _meta), cacheAvailable: true, freshness: _freshness(),
      ...(troubled.length ? {
        assembliesWithDecodeProblems: troubled,
        assembliesNote: 'These user assemblies failed to open or had methods the IL decoder could ' +
          'not read. Call graph edges from them are missing, so a caller count of zero for a type ' +
          'in one of these is unproven. Empty/omitted means every user assembly decoded cleanly. ' +
          'Note this is in-memory only: a cache-loaded index cannot report it (perAssembly is not persisted).',
      } : {}),
    });
  }

  if (name === 'unity_explain_compile_errors') {
    const idx = ensureIndex(port, false, false);
    if (!idx) return err(_buildError || 'Index unavailable.');
    return ok(errorimpact.explain(idx, a, { ..._meta, projectRoot: _projectRoot }));
  }

  if (name === 'unity_index_rebuild') {
    const idx = ensureIndex(port, true, a.includePackageCache);
    if (!idx) return err(_buildError || 'Index build failed.');
    return ok({ rebuilt: true, ...queries.status(idx, _meta) });
  }

  const idx = ensureIndex(port, false, false);
  if (!idx) return err(_buildError || 'Index unavailable.');

  let result;
  if (name === 'unity_find_references') result = queries.findReferences(idx, a);
  else if (name === 'unity_find_component_usages') result = queries.findComponentUsages(idx, a);
  else if (name === 'unity_get_type_symbols') result = queries.getTypeSymbols(idx, a);
  else if (name === 'unity_find_callers') result = queries.findCallers(idx, a);
  else if (name === 'unity_find_callees') result = queries.findCallees(idx, a);
  else if (name === 'unity_get_asset_components') result = queries.getAssetComponents(idx, a);
  else if (name === 'unity_project_map') result = projectmap.buildProjectMap(idx, a);
  else if (name === 'unity_impact_analysis') result = impact.buildImpact(idx, a);
  else if (name === 'unity_find_missing_scripts') {
    // Missing Script 판정에는 전체 GUID 커버리지가 필수다.
    // Assets/Packages 만으로 판정하면 패키지 스크립트가 전부 'missing' 으로 잡힌다
    // (실측: 89건 중 79건이 오분류). 필요 시 여기서 PackageCache 를 병합한다.
    if (idx.guidCoverage !== 'full') {
      log('missing-script check needs full GUID coverage — merging PackageCache .meta (one time)...');
      scan.mergePackageCacheGuids(idx);
      log(`PackageCache merged in ${idx.stats.msPackageCache}ms ` +
          `(+${idx.stats.packageCacheGuidsAdded} guids from ${idx.stats.packageCacheMetaFiles} meta files)`);
      saveCache(idx);
    }
    result = queries.findMissingScripts(idx, a);
  }
  else return err(`Unknown local tool: ${name}`);

  // 에러 응답도 부가 필드(candidates 등)를 유지해야 한다 — AI 가 후보를 보고 다시 물을 수 있다.
  if (result && result.error) return errWith(result);
  return ok(result);
}

function ok(obj) {
  return { content: [{ type: 'text', text: JSON.stringify(obj) }], isError: false };
}
function err(message) {
  return { content: [{ type: 'text', text: JSON.stringify({ error: message }) }], isError: true };
}
/** error 를 포함한 객체 전체를 그대로 실어 보낸다(candidates 등 부가 정보 보존). */
function errWith(obj) {
  return { content: [{ type: 'text', text: JSON.stringify(obj) }], isError: true };
}

module.exports = { isLocalTool, toolDefinitions, callLocalTool, ensureIndex, setLogger, PREFIX,
  _freshness, _forceStaleForTest, _projectRoot: _projectRootForTest };
