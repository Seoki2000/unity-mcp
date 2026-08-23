'use strict';
// 인덱스 위의 질의. 전부 맵 조회이므로 sub-ms 다.
// 비교: 인덱스 없는 현재 구현은 역참조 1건에 2,425 ms 이고 에디터 메인 스레드를 점유한다.

const GUID_RE = /^[0-9a-f]{32}$/;

/** 질의 문자열을 GUID 로 해석한다. 경로/GUID 모두 받는다. */
function resolveGuid(index, target) {
  if (!target) return null;
  const t = String(target).trim();
  if (GUID_RE.test(t)) return t;
  // 경로로 들어온 경우
  const norm = t.replace(/\\/g, '/').replace(/^\/+/, '');
  return index.pathToGuid.get(norm) || null;
}

function pageOf(arr, offset, limit) {
  const off = offset > 0 ? offset : 0;
  const lim = limit > 0 ? Math.min(limit, 500) : 50;
  const page = arr.slice(off, off + lim);
  const consumed = off + page.length;
  return {
    items: page,
    total: arr.length,
    offset: off,
    nextOffset: consumed < arr.length ? consumed : -1,
    truncated: consumed < arr.length,
  };
}

/**
 * 이 에셋(경로 또는 GUID)을 참조하는 에셋들.
 * 기존 unity_search_project type=reference 를 대체한다.
 */
function findReferences(index, args) {
  const guid = resolveGuid(index, args.target);
  if (!guid) {
    return {
      error: `Could not resolve '${args.target}' to a GUID. Pass an asset path (e.g. 'Assets/X.prefab') ` +
             `or a 32-character GUID. If it is a real asset, the index may be stale — run unity_index_rebuild.`,
    };
  }

  const set = index.refs.get(guid);
  const referencing = set ? [...set].sort() : [];
  const page = pageOf(referencing, args.offset, args.maxResults);

  return {
    target: args.target,
    guid,
    resolvedPath: index.guidToPath.get(guid) || null,
    totalCount: page.total,
    returnedCount: page.items.length,
    offset: page.offset,
    nextOffset: page.nextOffset,
    truncated: page.truncated,
    references: page.items,
  };
}

/**
 * 이 스크립트를 사용하는 프리팹/씬/에셋.
 * 조인 레이어를 쓴다 — m_Script.guid 로 검색하므로 .cs 텍스트 검색으로는 얻을 수 없는 답이다.
 */
function findComponentUsages(index, args) {
  const guid = resolveGuid(index, args.script);
  if (!guid) {
    return {
      error: `Could not resolve script '${args.script}'. Pass the .cs asset path ` +
             `(e.g. 'Assets/Scripts/Player.cs') or its 32-character GUID.`,
    };
  }

  const set = index.scriptRefs.get(guid);
  const users = set ? [...set].sort() : [];
  const page = pageOf(users, args.offset, args.maxResults);

  return {
    script: args.script,
    guid,
    resolvedPath: index.guidToPath.get(guid) || null,
    // 스크립트 GUID 인데 .meta 가 없으면 그 스크립트는 프로젝트에 존재하지 않는다.
    scriptExists: index.guidToPath.has(guid),
    totalCount: page.total,
    returnedCount: page.items.length,
    offset: page.offset,
    nextOffset: page.nextOffset,
    truncated: page.truncated,
    usedBy: page.items,
  };
}

/**
 * Missing Script 검출 — 에셋이 참조하는 m_Script GUID 중 프로젝트에 .meta 가 없는 것.
 *
 * 이게 조인 레이어의 존재 이유를 가장 잘 보여준다. .cs 를 grep 해서는 절대 찾을 수 없다.
 * Phase 1.5 프로토타입이 MainProject 에서 132건을 찾아냈고, 이 함수가 그것을 재현해야 한다.
 */
/**
 * Unity 내장 어셈블리/리소스를 가리키는 GUID 인가.
 *
 * 에디터 설치본 안의 어셈블리(UnityEditor.dll 등)는 0 으로 채운 특수 GUID 를 쓴다.
 * 예: 0000000000000000e000000000000000 → UnityEditor.dll
 * 프로젝트에 .meta 가 없는 게 정상이므로 Missing Script 로 세면 오보다.
 * (Phase 1.5 §6 에서 "에디터 설치본 내부 리소스는 프로젝트 파일만으로 해석 불가"로 예고한 항목.)
 */
function isUnityBuiltinGuid(guid) {
  return /^0{16}/.test(guid);
}

function findMissingScripts(index, args) {
  const rows = [];
  const builtin = [];
  const affected = new Set();
  let totalRefs = 0;

  for (const [guid, users] of index.scriptRefs) {
    if (index.guidToPath.has(guid)) continue;   // 정상 — 스크립트가 존재한다

    const list = [...users].sort();

    if (isUnityBuiltinGuid(guid)) {
      // 내장 어셈블리 참조 — 정상이다. 따로 보고만 하고 missing 에 세지 않는다.
      builtin.push({ guid, referenceCount: list.length, sampleAssets: list.slice(0, 3) });
      continue;
    }

    totalRefs += list.length;
    for (const u of list) affected.add(u);
    rows.push({ guid, referenceCount: list.length, sampleAssets: list.slice(0, 5) });
  }

  rows.sort((a, b) => b.referenceCount - a.referenceCount || a.guid.localeCompare(b.guid));
  const page = pageOf(rows, args.offset, args.maxResults);

  const notes = [];
  if (index.guidCoverage !== 'full') {
    notes.push('GUID coverage is partial (Library/PackageCache not indexed), so scripts that live in ' +
               'cached packages are misreported here. Run unity_index_rebuild with includePackageCache=true.');
  }
  if (rows.length) {
    notes.push('These GUIDs are referenced by m_Script but have no .meta anywhere in the project. ' +
               'In the Editor the component shows "The associated script can not be loaded". ' +
               'Either the class was deleted/renamed, or its assembly is no longer part of this project.');
  } else {
    notes.push('No missing script references found.');
  }
  if (builtin.length) {
    notes.push(`${builtin.length} reference(s) point at Unity built-in assemblies (all-zero GUID prefix); ` +
               'those are normal and excluded from the counts above.');
  }

  return {
    guidCoverage: index.guidCoverage,
    missingScriptCount: rows.length,
    affectedAssetCount: affected.size,
    totalReferenceCount: totalRefs,
    returnedCount: page.items.length,
    offset: page.offset,
    nextOffset: page.nextOffset,
    truncated: page.truncated,
    note: notes.join(' '),
    missing: page.items,
    unityBuiltinReferences: builtin,
  };
}

/** 인덱스 상태/통계. */
function status(index, meta) {
  return {
    built: !!index,
    projectRoot: index ? index.root : null,
    guidCoverage: index ? index.guidCoverage : null,
    includePackageCache: index ? index.includePackageCache : null,
    builtAt: meta.builtAt || null,
    fromCache: !!meta.fromCache,
    stats: index ? index.stats : null,
    note: index
      ? null
      : 'Index not built yet. It builds automatically on first index query, or call unity_index_rebuild.',
  };
}

module.exports = { findReferences, findComponentUsages, findMissingScripts, status, resolveGuid };
