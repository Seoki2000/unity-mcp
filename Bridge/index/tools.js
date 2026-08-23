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
const queries = require('./queries');

const PREFIX = 'unity_index_';   // 상태/재빌드 도구
const LOCAL_TOOL_NAMES = new Set([
  'unity_index_status',
  'unity_index_rebuild',
  'unity_find_references',
  'unity_find_component_usages',
  'unity_find_missing_scripts',
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

const CACHE_VERSION = 1;

function saveCache(index) {
  try {
    const payload = {
      version: CACHE_VERSION,
      root: index.root,
      includePackageCache: index.includePackageCache,
      builtAt: new Date().toISOString(),
      guidCoverage: index.guidCoverage,
      stats: index.stats,
      guidToPath: [...index.guidToPath],
      refs: [...index.refs].map(([g, s]) => [g, [...s]]),
      scriptRefs: [...index.scriptRefs].map(([g, s]) => [g, [...s]]),
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

    const guidToPath = new Map(raw.guidToPath);
    const pathToGuid = new Map();
    for (const [g, p] of guidToPath) pathToGuid.set(p, g);

    return {
      root,
      includePackageCache: raw.includePackageCache,
      guidCoverage: raw.guidCoverage || 'assets',
      guidToPath,
      pathToGuid,
      refs: new Map(raw.refs.map(([g, a]) => [g, new Set(a)])),
      scriptRefs: new Map(raw.scriptRefs.map(([g, a]) => [g, new Set(a)])),
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
  _meta = { builtAt: new Date().toISOString(), fromCache: false };
  _buildError = null;
  log(`built in ${_index.stats.msTotal}ms — ${_index.stats.guids} guids, ` +
      `${_index.stats.referenceEdges} edges, ${_index.stats.scriptGuids} script guids`);
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
      description: 'Find every asset that references the given asset. Accepts an asset path or a 32-char GUID. Index-backed: O(1) lookup instead of scanning every asset with GetDependencies.',
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

  if (result && result.error) return err(result.error);
  return ok(result);
}

function ok(obj) {
  return { content: [{ type: 'text', text: JSON.stringify(obj) }], isError: false };
}
function err(message) {
  return { content: [{ type: 'text', text: JSON.stringify({ error: message }) }], isError: true };
}

module.exports = { isLocalTool, toolDefinitions, callLocalTool, ensureIndex, setLogger, PREFIX };
