'use strict';
// 인덱스 위의 질의. 전부 맵 조회이므로 sub-ms 다.
// 비교: 인덱스 없는 현재 구현은 역참조 1건에 2,425 ms 이고 에디터 메인 스레드를 점유한다.

const { YAML_EXT } = require('./scan');

const GUID_RE = /^[0-9a-f]{32}$/;

// 인덱스가 훑은 확장자. 캐시에서 복원된 인덱스에도 값이 있어야 하므로 index 객체가 아니라
// 모듈 상수에서 읽는다.
function scannedExtensions() { return [...YAML_EXT].sort(); }

/** 질의 문자열을 GUID 로 해석한다. 경로/GUID 모두 받는다. */
function resolveGuid(index, target) {
  if (!target) return null;
  const t = String(target).trim();
  if (GUID_RE.test(t)) return t;
  // 경로로 들어온 경우
  const norm = t.replace(/\\/g, '/').replace(/^\/+/, '');
  return index.pathToGuid.get(norm) || null;
}

// 타입의 베이스 체인. 프로젝트 어셈블리 밖(예: 패키지/BCL) 타입에 닿으면 그 이름까지만 담고 멈춘다.
function baseChainOf(sym, info, maxDepth) {
  const limit = maxDepth > 0 ? maxDepth : 12;
  const chain = [];
  let cur = info;
  const seen = new Set();
  while (cur && cur.baseType && chain.length < limit) {
    if (seen.has(cur.fullName)) break;   // 순환 방어
    seen.add(cur.fullName);
    chain.push(cur.baseType);
    const next = sym.typeByFullName.get(cur.baseType);
    if (!next) break;                    // 인덱스 밖 타입 — 여기서 끝
    cur = next;
  }
  return chain;
}

const UNITY_ATTACHABLE = new Set(['UnityEngine.MonoBehaviour', 'UnityEngine.ScriptableObject']);

// 체인이 여기에 닿으면 "확실히 아니다" 로 판정할 수 있다. 완전히 해석된 종점이다.
const NON_UNITY_ROOTS = new Set([
  'System.Object', 'System.ValueType', 'System.Enum', 'System.Attribute',
  'System.Exception', 'System.MulticastDelegate', 'System.Delegate',
]);

// true / false / null 을 돌려준다. null 은 "모른다" 다.
// 심볼 인덱스는 사용자 어셈블리만 담는다. 그래서 체인이 패키지 어셈블리로 나가면 거기서 끊긴다.
// 실측(2026-08-23): MonsterSpawner 는 Unity.Netcode.NetworkBehaviour -> MonoBehaviour 인데
// NetworkBehaviour 가 인덱스 밖이라 체인이 끊겼다. 그때 false 를 돌려주면 프리팹 9개에
// 실제로 붙어 있는 컴포넌트를 "붙을 수 없다" 고 단정하는 것이 된다.
// 모르는 것은 모른다고 해야 한다 — false 는 해석이 끝났을 때만 쓴다.
function isUnityAttachable(sym, info) {
  if (!info) return null;
  if (UNITY_ATTACHABLE.has(info.baseType)) return true;
  const chain = baseChainOf(sym, info);
  for (const b of chain) if (UNITY_ATTACHABLE.has(b)) return true;
  if (chain.length === 0) return null;
  const last = chain[chain.length - 1];
  if (NON_UNITY_ROOTS.has(last)) return false;   // 끝까지 해석됐고 Unity 타입이 아니다
  return null;                                   // 인덱스 밖에서 끊겼다 — 알 수 없다
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
 * 조인 레이어 — 스크립트 GUID 를 실제 컴파일된 타입으로 해석한다.
 *
 * 경로: m_Script.guid → (.meta) .cs 경로 → (PDB) 그 파일에 선언된 타입 → (DLL) 타입 정보
 * 이 세 단계를 잇는 것이 Phase 2 의 핵심이다. 한쪽만으로는 답이 나오지 않는다.
 */
function resolveScriptType(index, guid) {
  const csPath = index.guidToPath.get(guid);
  if (!csPath) return { resolved: false, reason: 'no .meta for this GUID' };

  const sym = index.symbols;
  if (!sym) return { resolved: false, csPath, reason: 'symbol index not built' };

  const candidates = sym.typesBySourceFile.get(csPath) || [];
  if (!candidates.length) {
    return {
      resolved: false, csPath,
      reason: 'no compiled type maps to this file (script may not compile, or its assembly was not built)',
    };
  }

  // 한 파일에 여러 타입이 있을 수 있다(보조 struct, 중첩 타입, 정적 유틸 등).
  // 선택 순서:
  //   1) 짧은 이름이 파일명과 같은 타입 — Unity 는 MonoScript 로 쓰이는 타입의 이름이
  //      파일명과 일치할 것을 요구한다. 가장 확실한 기준이다.
  //   2) MonoBehaviour/ScriptableObject 파생
  //   3) 그 외 첫 번째 (이 경우 확신할 수 없으므로 confidence 를 낮게 보고한다)
  const infos = candidates.map(fn => sym.typeByFullName.get(fn)).filter(Boolean);
  const stem = csPath.slice(csPath.lastIndexOf('/') + 1).replace(/\.cs$/i, '');

  const byName = infos.find(t => t.name === stem);
  const unityDerived = infos.find(t =>
    t.baseType === 'UnityEngine.MonoBehaviour' || t.baseType === 'UnityEngine.ScriptableObject');

  const pick = byName || unityDerived || infos[0] || null;
  const confidence = byName ? 'filename-match' : (unityDerived ? 'unity-derived' : 'ambiguous');

  return {
    resolved: !!pick,
    csPath,
    confidence,
    type: pick ? {
      fullName: pick.fullName,
      assembly: pick.assembly,
      baseType: pick.baseType,
      fieldCount: pick.fields.length,
      methodCount: pick.methods.length,
      // MonoBehaviour/ScriptableObject 가 아니면 컴포넌트로 붙을 수 없다 — AI 가 오해하지 않게 명시한다.
      // 직상위만 보면 안 된다: PlayerDefaultAttack -> BaseAttack -> MonoBehaviour 처럼 한 단계
      // 건너뛰면 false 가 되고, 실제로 프리팹에 붙어 있는 컴포넌트를 "붙을 수 없는 타입" 으로
      // 잘못 알린다. 프로젝트 어셈블리 안에서 베이스 체인을 따라 올라가 판정한다.
      // true / false / null(모름). null 은 베이스 체인이 인덱스 밖 어셈블리로 나가 끊긴 경우다.
      isUnityScriptableType: isUnityAttachable(sym, pick),
      // 체인을 어디까지 따라갔는지. 마지막 항목이 System.Object 류가 아니면 거기서 끊긴 것이다.
      baseChain: baseChainOf(sym, pick),
    } : null,
    otherTypesInFile: candidates.filter(c => !pick || c !== pick.fullName),
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
    // 0 은 두 가지 뜻이 될 수 있다 — 정말 참조가 없거나, 참조하는 파일 종류를 안 봤거나.
    // 구분이 안 되면 "미사용이니 지워도 된다" 로 잘못 읽힌다. 그래서 0 일 때만 근거를 싣는다.
    ...(page.total === 0 ? {
      scannedExtensions: scannedExtensions(),
      note: 'totalCount is 0. This index reads GUID references only from the file types listed in ' +
            'scannedExtensions; a third-party asset type outside that list would not be seen. ' +
            'Cross-check with unity_search_project (searchType=reference) before concluding an asset ' +
            'is unreferenced — but note that neither source is complete on its own. Measured 2026-08-23: ' +
            'Unity AssetDatabase.GetDependencies does NOT report VFX Graph internal references, so it ' +
            'returns 0 for .shadergraph and .vfxblock assets that .vfx files do reference, where this ' +
            'index finds them. Treat a zero from either side as unproven, not as proof of no reference.',
    } : {}),
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

  const join = resolveScriptType(index, guid);

  return {
    script: args.script,
    guid,
    resolvedPath: index.guidToPath.get(guid) || null,
    // 스크립트 GUID 인데 .meta 가 없으면 그 스크립트는 프로젝트에 존재하지 않는다.
    scriptExists: index.guidToPath.has(guid),
    // 조인 결과 — 실제 컴파일된 타입
    resolvedType: join.resolved ? join.type : null,
    typeResolution: join.resolved ? join.confidence : join.reason,
    otherTypesInFile: join.otherTypesInFile || [],
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


/**
 * 메서드 키를 해석한다. "Type::Method" / "Type.Method" / "Method" 를 모두 받는다.
 * 후보가 여러 개면 고르지 않고 돌려준다.
 */
function resolveMethodKey(index, query) {
  const cg = index.callGraph;
  if (!cg) return { error: 'Call graph not built. Run unity_index_rebuild.' };

  const q = String(query || '').trim();
  if (!q) return { error: 'method is required' };

  const allKeys = new Set([...cg.callsFrom.keys(), ...cg.callersOf.keys()]);

  if (allKeys.has(q)) return { key: q };

  // "Type.Method" 형태 → 마지막 점을 :: 로
  const dot = q.lastIndexOf('.');
  if (dot > 0) {
    const alt = q.slice(0, dot) + '::' + q.slice(dot + 1);
    if (allKeys.has(alt)) return { key: alt };
  }

  // 메서드 이름만 준 경우 — 끝이 ::name 인 키를 모은다
  const suffix = '::' + q;
  const matches = [...allKeys].filter(k => k.endsWith(suffix));
  if (matches.length === 1) return { key: matches[0] };
  if (matches.length > 1) {
    return {
      error: `'${q}' matches ${matches.length} methods. Pass 'Type::Method'.`,
      candidates: matches.sort().slice(0, 25),
    };
  }

  return { error: `Method '${q}' not found in the call graph (project code only; calls into UnityEngine/BCL are not indexed).` };
}

/**
 * 이 메서드를 호출하는 메서드들.
 *
 * grep 과의 차이 — 실측 예: BaseAttack::TryResolveHit 을 grep 하면 20건이 나오는데
 * 그중 4건은 주석이고 나머지에는 선언과 오버로드 내부 연쇄가 섞여 있다.
 * 호출 그래프는 실제 호출자 8개만 준다.
 */
function findCallers(index, args) {
  const r = resolveMethodKey(index, args.method);
  if (r.error) return r;

  const set = index.callGraph.callersOf.get(r.key);
  const callers = set ? [...set].sort() : [];
  const page = pageOf(callers, args.offset, args.maxResults);

  return {
    method: r.key,
    totalCount: page.total,
    returnedCount: page.items.length,
    offset: page.offset,
    nextOffset: page.nextOffset,
    truncated: page.truncated,
    callers: page.items,
    note: 'Overloads share one key (Type::Method), so callers of all overloads are merged. ' +
          'Only calls from project (user assembly) code are indexed.',
  };
}

/** 이 메서드가 호출하는 메서드들. */
function findCallees(index, args) {
  const r = resolveMethodKey(index, args.method);
  if (r.error) return r;

  const set = index.callGraph.callsFrom.get(r.key);
  const callees = set ? [...set].sort() : [];
  const page = pageOf(callees, args.offset, args.maxResults);

  return {
    method: r.key,
    totalCount: page.total,
    returnedCount: page.items.length,
    offset: page.offset,
    nextOffset: page.nextOffset,
    truncated: page.truncated,
    callees: page.items,
    note: 'Calls into UnityEngine/BCL are intentionally not indexed — only project-internal targets.',
  };
}

/** 인덱스 상태/통계. */
function status(index, meta) {
  return {
    built: !!index,
    projectRoot: index ? index.root : null,
    guidCoverage: index ? index.guidCoverage : null,
    includePackageCache: index ? index.includePackageCache : null,
    scannedExtensions: scannedExtensions(),
    builtAt: meta.builtAt || null,
    fromCache: !!meta.fromCache,
    stats: index ? index.stats : null,
    note: index
      ? null
      : 'Index not built yet. It builds automatically on first index query, or call unity_index_rebuild.',
  };
}

/**
 * 타입 심볼 조회. 전체 이름 또는 짧은 이름을 받는다.
 * 짧은 이름이 여러 타입과 겹치면 후보를 돌려주고 하나를 고르지 않는다.
 */
function getTypeSymbols(index, args) {
  const sym = index.symbols;
  if (!sym) return { error: 'Symbol index not built. Run unity_index_rebuild.' };

  const q = String(args.type || '').trim();
  if (!q) return { error: 'type is required' };

  let info = sym.typeByFullName.get(q);
  let candidates = null;

  if (!info) {
    const shortMatches = sym.typesByShortName.get(q) || [];
    if (shortMatches.length === 1) {
      info = sym.typeByFullName.get(shortMatches[0]);
    } else if (shortMatches.length > 1) {
      candidates = shortMatches.slice(0, 20);
    }
  }

  if (!info) {
    return {
      error: candidates
        ? `'${q}' matches ${candidates.length} types. Pass the full name.`
        : `Type '${q}' not found in the symbol index (user assemblies only).`,
      candidates: candidates || undefined,
    };
  }

  // 이 타입이 붙어 있는 에셋 — 조인의 반대 방향
  let attachedTo = null;
  for (const sf of info.sourceFiles) {
    const guid = index.pathToGuid.get(sf);
    if (!guid) continue;
    const users = index.scriptRefs.get(guid);
    if (users) attachedTo = { scriptGuid: guid, assetCount: users.size, sampleAssets: [...users].sort().slice(0, 5) };
    break;
  }

  const maxMembers = args.maxMembers > 0 ? Math.min(args.maxMembers, 500) : 100;
  return {
    fullName: info.fullName,
    name: info.name,
    namespace: info.namespace || null,
    assembly: info.assembly,
    baseType: info.baseType,
    isPublic: info.isPublic,
    isAbstract: info.isAbstract,
    isSealed: info.isSealed,
    isInterface: info.isInterface,
    sourceFiles: info.sourceFiles,
    fieldCount: info.fields.length,
    methodCount: info.methods.length,
    fields: info.fields.slice(0, maxMembers),
    methods: info.methods.slice(0, maxMembers).map(m => ({
      name: m.name, isPublic: m.isPublic, isStatic: m.isStatic, isVirtual: m.isVirtual, isAbstract: m.isAbstract,
    })),
    truncatedMembers: info.fields.length > maxMembers || info.methods.length > maxMembers,
    attachedTo,
    note: 'Field/method names come from the compiled assembly; source file mapping comes from the Portable PDB. ' +
          'Field type signatures are not decoded yet (Phase 2b-2).',
  };
}

module.exports = { findReferences, findComponentUsages, findMissingScripts, getTypeSymbols,
                   findCallers, findCallees, status, resolveGuid, resolveScriptType };
