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
const queries = require('./queries');

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
]);

let _index = null;
let _meta = { builtAt: null, fromCache: false };
let _projectRoot = null;
let _buildError = null;

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
// 5: 캐시 지문 추가 (2026-08-23). 이전 캐시에는 fingerprint 가 없어 유효성 검사가 불가능하다.
const CACHE_VERSION = 5;

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
      callGraph: index.callGraph ? {
        stats: index.callGraph.stats,
        callsFrom: [...index.callGraph.callsFrom].map(([k, v]) => [k, [...v]]),
      } : null,
      symbols: index.symbols ? {
        stats: index.symbols.stats,
        assemblies: index.symbols.assemblies,
        types: [...index.symbols.typeByFullName.values()],
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
      const typesByShortName = new Map();
      const typesBySourceFile = new Map();
      for (const t of raw.symbols.types) {
        typeByFullName.set(t.fullName, t);
        let sl = typesByShortName.get(t.name);
        if (!sl) typesByShortName.set(t.name, sl = []);
        sl.push(t.fullName);
        for (const sf of t.sourceFiles || []) {
          let l = typesBySourceFile.get(sf);
          if (!l) typesBySourceFile.set(sf, l = []);
          if (!l.includes(t.fullName)) l.push(t.fullName);
        }
      }
      sym = { typeByFullName, typesByShortName, typesBySourceFile,
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
      cg = { callsFrom, callersOf, perAssembly: [], stats: raw.callGraph.stats || {} };
    }

    return {
      root,
      includePackageCache: raw.includePackageCache,
      guidCoverage: raw.guidCoverage || 'assets',
      callGraph: cg,
      guidToPath,
      pathToGuid,
      refs: new Map(raw.refs.map(([g, a]) => [g, new Set(a)])),
      scriptRefs: new Map(raw.scriptRefs.map(([g, a]) => [g, new Set(a)])),
      symbols: sym,
      stats: raw.stats,
      _builtAt: raw.builtAt,
    };
  } catch {
    return null;   // 캐시 없음/손상 — 안전하게 재빌드한다
  }
}

let _log = () => {};
function setLogger(fn) { _log = fn; }
function log(msg) { _log(`[index] ${msg}`); }

/**
 * 인덱스를 확보한다. 캐시가 있으면 쓰고, 없으면 빌드한다.
 * @param {boolean} force 캐시를 무시하고 다시 빌드
 */
function ensureIndex(port, force, includePackageCache, cacheOnly) {
  if (_index && !force) return _index;

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
      log(`loaded from cache (${cached.stats.yamlFiles} yaml files, built ${cached._builtAt})`);
      return _index;
    }
  }

  if (cacheOnly) {
    // 상태 조회 경로 — 디스크 캐시가 없으면 빌드하지 않는다(수 초가 걸린다).
    return null;
  }

  log(`building index for ${_projectRoot}${includePackageCache ? ' (+PackageCache)' : ''}...`);
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
  }

  _meta = { builtAt: new Date().toISOString(), fromCache: false };
  _buildError = null;
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
      description: 'Find assets that reference the given asset, by GUID reverse-index over text-serialized Unity assets. Accepts an asset path or a 32-char GUID. O(1) lookup instead of scanning every asset with GetDependencies. Scope: only the file types in scannedExtensions, reported when the result is 0. No single source is complete — this index misses asset types outside that list, while Unity own GetDependencies misses VFX Graph internal references (measured). Cross-check both before deciding an asset is unused.',
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
    return ok({ ...queries.status(idx, _meta), cacheAvailable: true });
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

module.exports = { isLocalTool, toolDefinitions, callLocalTool, ensureIndex, setLogger, PREFIX };
