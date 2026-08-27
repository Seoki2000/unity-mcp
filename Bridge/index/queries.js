'use strict';
// 인덱스 위의 질의. 전부 맵 조회이므로 sub-ms 다.
// 비교: 인덱스 없는 현재 구현은 역참조 1건에 2,425 ms 이고 에디터 메인 스레드를 점유한다.

const fs = require('fs');
const path = require('path');
const { YAML_EXT } = require('./scan');
const yaml = require('./yamlvalues');

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

  const stemOf = p => p.slice(p.lastIndexOf('/') + 1).replace(/\.cs$/i, '');
  let candidates = sym.typesBySourceFile.get(csPath) || [];
  let viaFilename = false;

  if (!candidates.length) {
    // PDB 소스 매핑은 **메서드 본문**에서 나온다(MethodDebugInformation → Document).
    // 그래서 본문이 없는 타입은 어느 파일에서 왔는지 PDB 가 말해주지 않는다:
    //   public sealed partial class BossStateChanged : EventChannel<TwentyThreeState> { }
    // 실측(2026-08-24, MainProject): Assets 안 스크립트 GUID 4개가 이 형태로 해석에 실패했고
    // 이유는 "컴파일 안 됐거나 어셈블리가 안 빌드됐다" 로 **틀리게** 보고됐다. 실제로는 잘 컴파일된다.
    //
    // Unity 는 MonoScript 로 쓰이는 타입의 이름이 파일명과 같을 것을 요구하므로,
    // 파일명으로 되돌아가 찾는다. 짧은 이름이 유일할 때만 쓴다 — 여러 개면 고르지 않는다.
    //
    // ⚠️ 이 폴백에는 안전장치가 둘 필요하다. 처음엔 "짧은 이름이 유일하면 채택" 만 두었는데
    //    전수 스윕에서 즉시 오답이 나왔다: URP 패키지의 Volume.cs 가 프로젝트 안의
    //    Ami.BroAudio.Volume 으로 해석됐다(짧은 이름이 인덱스 안에서는 유일했으므로).
    //    조용히 틀린 타입을 확신 있게 답하는 것이 이 도구에서 최악이다.
    //      (1) 스크립트가 Assets 안에 있어야 한다 — 패키지 스크립트는 애초에 인덱스 밖이다.
    //      (2) 후보 타입이 **어떤 소스 파일에도 매핑되지 않아야** 한다. 매핑이 있다면
    //          그 타입은 다른 파일에서 온 것이고, 이 파일의 타입이 아니다.
    const inAssets = /^Assets\//i.test(csPath);
    const byStem = inAssets ? (sym.typesByShortName.get(stemOf(csPath)) || []) : [];
    const stemInfo = byStem.length === 1 ? sym.typeByFullName.get(byStem[0]) : null;
    if (stemInfo && (!stemInfo.sourceFiles || stemInfo.sourceFiles.length === 0)) {
      candidates = byStem;
      viaFilename = true;
    } else {
      return {
        resolved: false, csPath,
        reason: byStem.length > 1
          ? `no PDB source mapping for this file and its name matches ${byStem.length} types — ambiguous`
          : (inAssets
            ? 'no compiled type maps to this file. Either it did not compile, its assembly was not built, ' +
              'or the type name differs from the file name.'
            : 'this script lives outside Assets (a package), and only user assemblies are indexed, so its ' +
              'type cannot be resolved here. The component is still real — this is a coverage limit, not a defect in the asset.'),
        ...(byStem.length > 1 ? { candidates: byStem.slice(0, 10) } : {}),
      };
    }
  }

  // 한 파일에 여러 타입이 있을 수 있다(보조 struct, 중첩 타입, 정적 유틸 등).
  // 선택 순서:
  //   1) 짧은 이름이 파일명과 같은 타입 — Unity 는 MonoScript 로 쓰이는 타입의 이름이
  //      파일명과 일치할 것을 요구한다. 가장 확실한 기준이다.
  //   2) MonoBehaviour/ScriptableObject 파생
  //   3) 그 외 첫 번째 (이 경우 확신할 수 없으므로 confidence 를 낮게 보고한다)
  const infos = candidates.map(fn => sym.typeByFullName.get(fn)).filter(Boolean);
  const stem = stemOf(csPath);

  const byName = infos.find(t => t.name === stem);
  const unityDerived = infos.find(t =>
    t.baseType === 'UnityEngine.MonoBehaviour' || t.baseType === 'UnityEngine.ScriptableObject');

  const pick = byName || unityDerived || infos[0] || null;
  const confidence = viaFilename
    // PDB 매핑이 없어 파일명으로 찾은 경우. 근거가 한 단계 약하므로 그렇게 말한다.
    ? 'filename-fallback (type has no method bodies, so the PDB maps no source file to it)'
    : (byName ? 'filename-match' : (unityDerived ? 'unity-derived' : 'ambiguous'));

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
 * 이 타입을 **이름 문자열로** 참조하는 에셋(Behavior 그래프 노드 등).
 * 프리팹에 붙는 것도 아니고 코드가 부르는 것도 아니라, 이 축이 없으면 통째로 안 보인다.
 */
function typeNameRefsFor(index, fullName) {
  if (!index.typeNameRefs || !fullName) return [];
  const set = index.typeNameRefs.byType.get(fullName);
  return set ? [...set].sort() : [];
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

  // 대상이 `.cs` 면 GUID 역참조만으로는 반쪽이다. 타입을 **이름 문자열로** 부르는 에셋
  // (Behavior 그래프 노드 등)은 `m_Script` GUID 를 쓰지 않으므로 이 인덱스에 안 걸린다.
  //
  // 실측(2026-08-25, 교차검증): `BombAction.cs` 가 여기서 `totalCount: 0` 을 받았다.
  // 그런데 같은 인덱스가 `Wells.asset` → `BombAction` 엣지를 이미 갖고 있었고, 그것이
  // `unity_get_type_symbols` / `unity_find_component_usages` 에만 실려 있었다.
  // 이 도구는 "지워도 되나" 에 가장 먼저 쓰이는 이름이다. 여기서 0 이 나오면 그 0 이
  // 결론이 된다 — 게다가 아래 note 가 대조군으로 권하는 Unity 쪽도 같이 0 을 답한다
  // (실측: 에셋 24,233개 전수, 참조 0). 두 출처가 합창하는 오답이 가장 나쁜 형태다.
  const targetPath = index.guidToPath.get(guid) || '';
  const typeNameHits = /\.cs$/i.test(targetPath)
    ? (() => {
        const join = resolveScriptType(index, guid);
        return join && join.resolved && join.type ? typeNameRefsFor(index, join.type.fullName) : [];
      })()
    : [];

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
    // 이 중 어느 것이 **텍스트 일치**로만 얻은 것인지 구분해 준다.
    // 직렬화 구조(프리팹의 참조 필드, .meta 임포터 설정)가 아니라 소스코드·문서·그래프 JSON
    // 안에서 32자리 hex 를 찾은 경우다. 대부분 진짜 참조지만(셰이더그래프의 텍스처,
    // asmdef 의 어셈블리 의존), GUID 를 단순히 적어둔 문자열일 수도 있다.
    // 구분 없이 합쳐 내면 "참조 1건" 이 어느 쪽인지 알 수 없어 삭제 판단이 흐려진다.
    ...(() => {
      const weak = index.weakRefs ? index.weakRefs.get(guid) : null;
      if (!weak || !weak.size) return {};
      const inPage = page.items.filter(p => weak.has(p));
      if (!inPage.length) return {};
      return {
        textualMatches: inPage,
        textualMatchNote: 'These came from matching the GUID as text in a non-serialized file ' +
          '(shader graph, asmdef, source, docs), not from a serialized reference field. Usually real, ' +
          'but verify before treating them as the only thing keeping this asset alive.',
      };
    })(),
    // 이름 문자열로 이 타입을 부르는 에셋. `references` 에 합치지 않는다 — 출처가 다르고
    // (직렬화 참조 필드가 아니라 문자열) 페이지네이션 대상도 아니다. 대신 별도 필드로 싣고,
    // 0 일 때는 아래 note 를 이쪽으로 바꿔 "없다" 로 읽히지 않게 한다.
    ...(typeNameHits.length ? {
      referencedByTypeName: typeNameHits,
      typeNameNote: 'These assets reference the type by its assembly-qualified name (for example a ' +
        'Unity Behavior graph node), not by m_Script GUID, so they are not in the reference count above. ' +
        'The class is instantiated by that framework at run time — deleting or renaming it breaks those ' +
        'assets, and neither this GUID index nor Unity own GetDependencies reports the edge.',
    } : {}),
    // 0 은 두 가지 뜻이 될 수 있다 — 정말 참조가 없거나, 참조하는 파일 종류를 안 봤거나.
    // 구분이 안 되면 "미사용이니 지워도 된다" 로 잘못 읽힌다. 그래서 0 일 때만 근거를 싣는다.
    ...(page.total === 0 && typeNameHits.length ? {
      note: `totalCount is 0, but this script is NOT unused: ${typeNameHits.length} asset(s) reference ` +
            'the type by name — see referencedByTypeName. No serialized m_Script GUID reference exists, ' +
            'which is why the count is 0. Use unity_find_component_usages for the component/type view and ' +
            'unity_find_callers for code callers and Inspector-wired methods before deleting anything.',
    } : {}),
    ...(page.total === 0 && !typeNameHits.length ? {
      // 0 일 때만 근거를 싣는다. 무엇을 봤고 무엇을 못 봤는지 없이 "0" 만 주면
      // "미사용이니 지워도 된다" 로 읽힌다.
      scanned: index.stats ? {
        yamlFiles: index.stats.yamlFiles,
        metaFiles: index.stats.metaFiles,
        otherTextFiles: index.stats.otherTextFiles,
        binaryFilesSkipped: index.stats.otherBinarySkipped,
        largeTextFilesSkipped: index.stats.otherLargeSkipped,
        // 코드가 경로로 부르는 것 중 정적으로 못 푼 호출 수. 이 에셋이 그중 하나일 수 있다.
        unresolvableDynamicLoadSites: index.stats.dynamicLoadSites,
      } : null,
      note: 'totalCount is 0. This index scans every *text* file under Assets for GUID references — ' +
            'the serialized asset types, .meta importer settings, and any other file whose first bytes ' +
            'contain no NUL (shader graphs, asmdefs, source, docs). What it still cannot see: references ' +
            'inside binary files (skipped by content sniffing), text files over 16 MB, and references ' +
            'assembled at run time. Literal and const-folded paths ARE resolved (Resources.Load and ' +
            'AssetDatabase.LoadAssetAtPath), but a path built from a variable is not — ' +
            'unresolvableDynamicLoadSites says how many such call sites exist in this project. ' +
            'Addressables addresses are also not mapped yet. ' +
            (/\.cs$/i.test(targetPath)
              ? 'This target is a script, so the type-name axis was checked too (assets naming the type ' +
                'as a string) and it is empty as well; Inspector-wired methods are per-method, ask ' +
                'unity_find_callers. '
              : '') +
            'Cross-check with unity_search_project (searchType=reference) as a second opinion, but note ' +
            'that neither source is complete: measured 2026-08-23, Unity AssetDatabase.GetDependencies ' +
            'does NOT report VFX Graph internal references, nor type-name or path-based references ' +
            '(re-measured 2026-08-25 against the live editor). In this project that search also scans ' +
            '24,233 asset paths and needs about 41 s cold, which exceeds the 30 s editor queue timeout. ' +
            'Treat a zero from either side as unproven, not as proof of no reference.',
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
    // m_Script 로 붙어 있지 않지만 **타입 이름 문자열로** 쓰이는 곳.
    // 이게 없으면 Behavior 그래프 노드처럼 "아무 데도 안 붙은" 클래스가 죽은 것처럼 보인다.
    ...(() => {
      const byName = join.resolved && join.type ? typeNameRefsFor(index, join.type.fullName) : [];
      if (!byName.length) return {};
      return {
        referencedByTypeName: byName,
        typeNameNote: 'These assets reference the type by its assembly-qualified name (for example a Unity ' +
          'Behavior graph node), not by m_Script. The class is instantiated by that framework at run time, ' +
          'so it has no component attachment and no IL caller — deleting or renaming it breaks those assets.',
      };
    })(),
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

  // 시그니처 키(`Type::Method(int,string)`)를 **먼저** 본다. 그걸로 물으면 오버로드가
  // 정확히 하나로 지목되므로 병합 경고가 필요 없다.
  //
  // ⚠️ 키를 쪼갤 때는 **마지막** '(' 를 쓴다. 명시적 인터페이스 구현의 메서드 이름에는
  // 괄호가 들어간다(실측: `IEnumerable<(System.Type,System.Type)>.GetEnumerator`).
  // 파라미터 타입에는 괄호가 안 나오므로(튜플은 System.ValueTuple<> 로 렌더링)
  // 마지막 '(' 는 항상 인자 목록의 시작이다.
  if (q.endsWith(')')) {
    const sigKeys = new Set([...(cg.callsFromSig || new Map()).keys(),
                             ...(cg.callersOfSig || new Map()).keys()]);
    if (sigKeys.has(q)) return { key: q, isSignatureKey: true };
    // 괄호를 붙였는데 없는 오버로드다. 이름 키로 조용히 떨어뜨리면 **다른 오버로드의
    // 답**이 나간다 - 물어본 것과 다른 것에 답하는 형태다. 여기서 끊고 후보를 준다.
    const nameKey = q.slice(0, q.lastIndexOf('('));
    const cands = [...sigKeys].filter(k => k.startsWith(nameKey + '('));
    return {
      error: `No overload '${q}' in the call graph.` +
             (cands.length
               ? ` Existing overloads: ${cands.slice(0, 8).join(', ')}` +
                 (cands.length > 8 ? `, ... (${cands.length} total)` : '')
               : ` No signature-keyed overload of '${nameKey}' is in the graph either — the graph only ` +
                 'covers calls between user-assembly types, and an overload nobody calls has no key.'),
      candidates: cands.slice(0, 25),
    };
  }

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

  // 호출 그래프에 키가 없다고 끝내면 안 된다. **IL 엣지가 하나도 없는 메서드**는
  // 여기서 에러가 되고, 그래서 속성 진입점과 인스펙터 배선 축에 도달하지 못한다.
  //
  // 실측(2026-08-26, 독립 감사 지적 후 재현): 속성이 붙은 메서드 20개가 호출 그래프 키 집합에
  // 없다 — `ProfilerWindow::Open`([MenuItem]), `EffectHitPoint::ResetWarnings`
  // ([RuntimeInitializeOnLoadMethod]), NUnit `SetUp`/`TearDown` 등. 엔진이나 러너만 부르는
  // 메서드라 IL 호출자가 0 인 것이 정상인데, **물어볼 수조차 없었다.** 배선 키 3개도 같다.
  // §4-(21) 과 같은 형태다: 데이터는 인덱스에 있고 이 응답만 몰랐다.
  //
  // 그래서 심볼 인덱스에서 선언을 찾아 키를 만든다. 호출자는 0 이지만 다른 축은 답한다.
  const sym = index.symbols;
  if (sym) {
    const sep = q.indexOf('::');
    if (sep > 0) {
      const ty = q.slice(0, sep), mn = q.slice(sep + 2);
      const info = sym.typeByFullName.get(ty);
      if (info && (info.methods || []).some(m => m.name === mn)) {
        return { key: q, declaredOnly: true };
      }
    } else {
      // 이름만 준 경우 — 선언에서 찾는다.
      const hits = [];
      for (const [ty, info] of sym.typeByFullName) {
        for (const m of (info.methods || [])) if (m.name === q) hits.push(ty + '::' + m.name);
      }
      const uniq = [...new Set(hits)].sort();
      if (uniq.length === 1) return { key: uniq[0], declaredOnly: true };
      if (uniq.length > 1) {
        return {
          error: `'${q}' matches ${uniq.length} declared methods with no IL edges. Pass 'Type::Method'.`,
          candidates: uniq.slice(0, 25),
        };
      }
    }
  }

  // 마지막 축: 인스펙터 배선이 그 키를 알고 있으면 답할 수 있다. Unity 내장 메서드에
  // 배선된 경우가 그렇다(실측: `UnityEngine.GameObject::SetActive` — 심볼 인덱스는
  // 사용자 어셈블리만 담으므로 선언을 못 찾지만, 배선은 우리가 인덱스했다).
  if (index.inspectorWiring && index.inspectorWiring.byKey && index.inspectorWiring.byKey.has(q)) {
    return { key: q, declaredOnly: 'inspector wiring only (method is outside the user assemblies)' };
  }

  return { error: `Method '${q}' not found — neither the call graph nor the symbol index has it ` +
                  `(user assemblies only; calls into UnityEngine/BCL are not indexed). ` +
                  `Check the spelling, or the type may live in a package.` };
}

/**
 * 이 메서드를 호출하는 메서드들.
 *
 * grep 과의 차이 — 실측 예: BaseAttack::TryResolveHit 을 grep 하면 20건이 나오는데
 * 그중 4건은 주석이고 나머지에는 선언과 오버로드 내부 연쇄가 섞여 있다.
 * 호출 그래프는 실제 호출자 8개만 준다.
 */
/**
 * 이 메서드를 **인스펙터에서** 부르는 배선(UnityEvent 퍼시스턴트 콜).
 *
 * IL 호출 그래프에는 절대 나타나지 않는다 — 호출이 코드가 아니라 에셋 안의 데이터이기 때문이다.
 * 이걸 합치지 않으면 "호출자 0" 이 "죽은 코드" 로 읽힌다(실측: GameManager.GoToResultButton).
 */
function inspectorWiringsFor(index, key, methodName) {
  const w = index.inspectorWiring;
  if (!w) return [];

  const out = [];
  const seen = new Set();
  const byKey = w.byKey.get(key);
  if (byKey) {
    // 직렬화된 배선이 적어둔 타입 이름이 지금 이름과 다를 수 있다. 실측(2026-08-26,
    // 독립 감사 지적): 3건이 `TempGameManager` 를 적어두고 조인으로 `GameManager` 에 붙었다.
    // 이름 변경을 판단할 때 알아야 하는 사실이라 응답에 남긴다 — 그 행들은 이미 낡았다.
    const declaredBy = new Map();
    const mName = key.slice(key.indexOf('::') + 2);
    for (const e of (w.byMethod.get(mName) || [])) {
      if (e && e.declaredType && e.type && e.declaredType !== e.type) declaredBy.set(e.asset, e.declaredType);
    }
    for (const a of byKey) {
      if (seen.has(a)) continue;
      seen.add(a);
      const stale = declaredBy.get(a);
      out.push(stale ? { asset: a, match: 'type', staleDeclaredType: stale } : { asset: a, match: 'type' });
    }
  }

  // 타입이 해석되지 않은 배선은 메서드 이름으로만 걸린다. 근거가 약하므로 그렇게 표시한다.
  const list = w.byMethod.get(methodName) || [];
  for (const e of list) {
    if (e.type) continue;                       // 타입이 있으면 위에서 이미 정확히 걸린다
    if (seen.has(e.asset)) continue;
    seen.add(e.asset);
    out.push({ asset: e.asset, match: 'method-name-only', declaredType: e.declaredType || null });
  }
  return out;
}

/**
 * 이 메서드에 붙은 속성. `[MenuItem]`/`[ClientRpc]`/`[Test]` 처럼 **코드 호출자 없이도
 * 불리는** 진입점을 드러낸다 — 그 경우 "호출자 0" 은 죽었다는 뜻이 아니다.
 * 어떤 속성이 진입점인지 판정하지 않는다. 붙어 있는 것을 그대로 낸다.
 */
function methodAttributesFor(index, typeName, methodName) {
  const sym = index.symbols;
  if (!sym) return [];
  const info = sym.typeByFullName.get(typeName);
  if (!info || !info.methods) return [];
  const out = [];
  for (const m of info.methods) {
    if (m.name !== methodName || !m.attributes) continue;
    for (const a of m.attributes) if (!out.includes(a)) out.push(a);
  }
  return out;
}

/**
 * `Type::Method` 키가 덮는 선언 목록. 오버로드는 한 키로 합쳐지므로(시그니처 미디코딩)
 * **몇 개를 합쳤는지와 어디인지**를 응답이 말해야 한다. 위치는 PDB SequencePoints 에서 온다.
 */
function declarationsFor(index, typeName, methodName) {
  const sym = index.symbols;
  if (!sym || !sym.typeByFullName) return [];
  const info = sym.typeByFullName.get(typeName);
  if (!info || !Array.isArray(info.methods)) return [];
  return info.methods
    .filter(m => m.name === methodName)
    .map(m => ({
      line: m.line ?? null,
      endLine: m.endLine ?? null,
      isPublic: m.isPublic, isStatic: m.isStatic, isVirtual: m.isVirtual, isAbstract: m.isAbstract,
    }))
    .sort((a, b) => (a.line ?? 0) - (b.line ?? 0));
}

function findCallers(index, args) {
  const r = resolveMethodKey(index, args.method);
  if (r.error) return r;

  const cgx = index.callGraph;
  const set = r.isSignatureKey
    ? (cgx.callersOfSig ? cgx.callersOfSig.get(r.key) : null)
    : cgx.callersOf.get(r.key);
  const callers = set ? [...set].sort() : [];
  const page = pageOf(callers, args.offset, args.maxResults);

  // 이름으로 물었을 때 **오버로드별 분해**를 함께 준다. 예전에는 합계만 나가서
  // `BaseAttack::TryResolveHit` 의 호출자 8개가 선언 4개에 어떻게 흩어져 있는지
  // 알 방법이 없었다.
  const perOverload = [];
  if (!r.isSignatureKey && cgx.callersOfSig) {
    const prefix = r.key + '(';
    for (const [k, v] of cgx.callersOfSig) {
      if (!k.startsWith(prefix)) continue;
      perOverload.push({ key: k, signature: k.slice(k.lastIndexOf('(')), callerCount: v.size });
    }
    perOverload.sort((a, b) => b.callerCount - a.callerCount || a.signature.localeCompare(b.signature));
  }

  const methodName = r.key.slice(r.key.indexOf('::') + 2);
  const typeName = r.key.slice(0, r.key.indexOf('::'));
  const wirings = inspectorWiringsFor(index, r.key, methodName);
  const attributes = methodAttributesFor(index, typeName, methodName);
  // 이 키가 실제로 선언 몇 개를 덮는가. 지금까지 오버로드 경고는 **정적 상투구**여서
  // 선언이 하나뿐인 메서드에도 똑같이 붙었고, 그래서 진짜 병합을 희석시켰다.
  const declarations = declarationsFor(index, typeName, methodName);

  return {
    method: r.key,
    ...(r.isSignatureKey ? { resolvedBy: 'signature key — exactly one overload' } : {}),
    ...(perOverload.length > 1 ? {
      perOverload,
      perOverloadNote:
        'Callers above are the union across these overloads. Each key is queryable — pass it as method ' +
        'to get that overload alone. Sums can exceed the union: one caller can call several overloads, ' +
        'and an overloaded caller appears once per its own signature.',
    } : {}),
    // 호출 그래프에 엣지가 없어 **선언에서** 해석한 경우. 호출자 0 의 뜻이 다르다 —
    // "호출자를 찾았고 0" 이 아니라 "이 메서드는 IL 그래프에 아예 없다" 다.
    ...(r.declaredOnly ? {
      resolvedFrom: typeof r.declaredOnly === 'string'
        ? r.declaredOnly
        : 'symbol declaration (no IL edges for this method)',
    } : {}),
    totalCount: page.total,
    returnedCount: page.items.length,
    offset: page.offset,
    nextOffset: page.nextOffset,
    truncated: page.truncated,
    callers: page.items,
    // 인스펙터 배선. 코드 호출자와 **합치지 않고 따로** 낸다 — 성격이 다르다
    // (하나는 IL 에서 디코딩한 호출, 하나는 에셋에 저장된 배선).
    ...(wirings.length ? {
      inspectorWiringCount: wirings.length,
      inspectorWirings: wirings.slice(0, 50),
      inspectorNote: 'This method is also wired in the Inspector (UnityEvent persistent call) from the ' +
        'assets listed. Those calls exist in serialized data, not in code, so they never appear in the IL ' +
        'call graph. Renaming or removing this method breaks them silently — the Editor shows the row as ' +
        '<Missing> only when someone opens that object.',
    } : {}),
    // 이 메서드에 붙은 속성. 진입점 여부를 판정하지 않고 그대로 낸다.
    ...(attributes.length ? {
      attributes,
      attributeNote: 'Attributes can make a method reachable with no code caller — the Editor calls ' +
        '[MenuItem]/[ContextMenu], the runtime calls [RuntimeInitializeOnLoadMethod], the test runner ' +
        'calls [Test], and Netcode generates the call for [ServerRpc]/[ClientRpc]. Read the list before ' +
        'concluding anything from a caller count of zero.',
    } : {}),
    // 선언이 둘 이상일 때만 싣는다. 하나뿐이면 모호성이 없다.
    ...(declarations.length > 1 ? { declarations } : {}),
    note: (declarations.length > 1
            ? `This key merges ${declarations.length} declarations (` +
              declarations.map(d => d.line === null ? 'line unknown' : `line ${d.line}`).join(', ') +
              '), so the callers below are the union across all of them - see declarations. ' +
              'Overloads share one key (Type::Method) because method signatures are not decoded yet. '
            : '') +
          'Only calls from project (user assembly) code are indexed.' +
          (page.total === 0 && !wirings.length && !attributes.length && index.inspectorWiring
            ? ' No code callers, no Inspector wiring and no attributes were found — but a method can still ' +
              'be reached by reflection, or by a framework that instantiates its declaring type by name. ' +
              'Zero is not proof it is dead.'
            : ''),
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
/**
 * 같은 전체 이름을 공유하는 타입들의 **유일한** 이름 목록.
 * 모호하다고 거절할 때 이걸 같이 줘야 호출자가 다음 수를 둘 수 있다.
 */
function qualifiedNamesFor(sym, fullName) {
  const out = [];
  const winner = sym.typeByFullName.get(fullName);
  if (winner) out.push({ qualifiedName: winner.qualifiedName || winner.fullName,
                         declaringType: winner.declaringType ?? null, assembly: winner.assembly });
  for (const d of (sym.duplicateTypes || [])) {
    if (d.fullName !== fullName) continue;
    out.push({ qualifiedName: d.qualifiedName || d.fullName,
               declaringType: d.declaringType ?? null, assembly: d.assembly });
  }
  return out.sort((a, b) => a.qualifiedName.localeCompare(b.qualifiedName));
}

function getTypeSymbols(index, args) {
  const sym = index.symbols;
  if (!sym) return { error: 'Symbol index not built. Run unity_index_rebuild.' };

  const q = String(args.type || '').trim();
  if (!q) return { error: 'type is required' };

  // 중첩 타입의 유일한 이름(`Outer/Inner`)을 먼저 본다. 이걸로 물으면 모호성이 없다.
  let info = (sym.typeByQualifiedName && sym.typeByQualifiedName.get(q)) || sym.typeByFullName.get(q);
  const resolvedByQualified = !!(sym.typeByQualifiedName && sym.typeByQualifiedName.has(q));
  let candidates = null;
  let sameFullName = null;

  // 전체 이름이 맞아도 그 이름을 여러 타입이 공유할 수 있다. 이 인덱스의 전체 이름은
  // `namespace.name` 이고 **중첩 타입의 선언 타입을 담지 않는다.** 그래서 서로 다른 클래스
  // 안의 `PassData` 셋이 한 이름으로 겹친다(실측 2026-08-26: 사용자 어셈블리 전체에서
  // 겹쳐 밀린 타입 123개, 전부 중첩 타입. Assembly-CSharp 안에서는 `<>c` 11 / `PassData` 3 /
  // `Segment` 2). 맵은 첫 것만 담으므로 나머지에 대한 질문에도 첫 것의 답이 나간다.
  // 이름을 고쳐 구분하는 것은 호출 그래프 키까지 바꾸는 일이라 별건으로 남기고,
  // 여기서는 **겹친다는 사실을 응답에 싣는다.**
  {
    const all = sym.typesByShortName.get(q) || [];
    const dupCount = all.filter(fn => fn === q).length;
    // qualifiedName 으로 물었으면 모호하지 않다 - 정확히 하나를 지목한 것이다.
    if (dupCount > 1 && !resolvedByQualified) sameFullName = dupCount;
  }

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
    ...(sameFullName ? {
      ambiguousFullName: sameFullName,
      // 거절만 하면 막다른 길이다. **무엇을 대신 물으면 되는지** 같이 준다.
      ambiguousCandidates: qualifiedNamesFor(sym, q),
      ambiguousFullNameNote:
        `${sameFullName} types in the user assemblies carry the full name '${q}'. This index keys ` +
        'types by namespace.name, which drops the declaring type of a nested type, so nested types ' +
        'with the same name collide. The members below are from ONE of them. Pass one of ' +
        'ambiguousCandidates (Outer/Inner form) to address a specific one - those names are unique.',
    } : {}),
    declaringType: info.declaringType ?? null,
    qualifiedName: info.qualifiedName || info.fullName,
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
    // 필드 타입은 FieldSig 에서 디코딩한 것이다. null 은 "모른다" 다(함수 포인터,
    // 런타임 내부 표현, 손상된 서명). 추측하지 않는다.
    fields: info.fields.slice(0, maxMembers).map(f => ({
      name: f.name, type: f.type ?? null,
      isPublic: f.isPublic, isStatic: f.isStatic, notSerialized: f.notSerialized,
    })),
    methods: info.methods.slice(0, maxMembers).map(m => ({
      name: m.name, isPublic: m.isPublic, isStatic: m.isStatic, isVirtual: m.isVirtual, isAbstract: m.isAbstract,
      // PDB SequencePoints 에서 나온 소스 위치. 첫 시퀀스 포인트라 시그니처 줄이 아니라
      // 본문 시작에 가깝다. 없으면 null 이다(추상·인터페이스·컴파일러 생성).
      // 이게 있어야 같은 이름의 오버로드 둘이 응답에서 구별된다.
      line: m.line ?? null, endLine: m.endLine ?? null,
    })),
    truncatedMembers: info.fields.length > maxMembers || info.methods.length > maxMembers,
    attachedTo,
    ...(() => {
      const byName = typeNameRefsFor(index, info.fullName);
      return byName.length ? { referencedByTypeName: byName } : {};
    })(),
    note: 'Field/method names come from the compiled assembly; source file mapping comes from the Portable PDB. ' +
          'Field type signatures are not decoded yet (Phase 2b-2). ' +
          'method.line/endLine come from PDB sequence points and span the method BODY, not its signature: ' +
          'the first sequence point sits just past the opening brace, so the declaration and any attributes ' +
          'are a line or two ABOVE line. Do not treat the span as a containment test for a compiler error ' +
          'location. null means the method has no sequence points (abstract, interface, or compiler-generated).',
  };
}

// ---------------------------------------------------------------------------
// Phase 2c — 컴포넌트 값 해석
//
// 여기까지 오면 조인의 세 축이 모두 쓰인다:
//   YAML 값(레이어 A 원문) × m_Script.guid→.meta(레이어 A) × 컴파일된 타입/필드(레이어 B)
// "이 프리팹에 뭐가 붙어 있고 각 필드에 뭐가 들어 있나"는 .cs 를 읽어서는 답할 수 없고,
// YAML 만 읽어서도 답할 수 없다(GUID 는 타입명이 아니다). 둘을 이어야 나온다.

// Unity 가 모든 컴포넌트에 공통으로 내는 헤더 키. 사용자 필드가 아니다.
// 기본적으로 감춘다 — AI 가 읽을 때 신호 대 잡음이 나빠지고, 어차피 대부분 0 이다.
const COMPONENT_NOISE_KEYS = new Set([
  'm_ObjectHideFlags', 'm_CorrespondingSourceObject', 'm_PrefabInstance', 'm_PrefabAsset',
  'm_GameObject', 'm_EditorHideFlags', 'm_Script', 'm_EditorClassIdentifier',
]);

const MAX_ASSET_BYTES = 32 * 1024 * 1024;
// 경로 봉쇄. `Editor/Core/McpPathGuard.cs` 와 **같은 정책을 JS 쪽에도** 둔다.
//
// 왜 여기 필요한가 — 이 파일의 다른 질의는 전부 맵 조회라 파일을 열지 않는다.
// getAssetComponents 는 호출자가 준 경로로 **파일을 직접 읽는 첫 로컬 도구**다.
// 봉쇄 없이 path.join(root, asset) 을 하면 `../../..` 로 프로젝트 밖 파일이 읽힌다.
// 실측(2026-08-24): 프로젝트 밖 .prefab 을 만들어 상대 경로로 부르니 내용이 그대로 응답에 실렸다.
// Phase 0-A(2bb84de)에서 C# 쪽에 막아 둔 것을 JS 쪽에 다시 들여온 셈이었다.
//
// 정책(C# 쪽과 동일):
//   - 절대 경로/드라이브 지정/UNC 거부. 프로젝트 루트 기준 상대 경로만 받는다
//   - `..` 문자열 검사가 아니라 정규화 후 접두사 검사. 디렉터리 경계까지 본다
//   - 에셋 루트(Assets / Packages / Library/PackageCache) 아래일 것
// 알려진 한계도 동일하다: 검사는 어휘적이라 프로젝트 안의 정션은 통과한다.
// 그 정션(Assets/50.Art)은 의도된 구조라 막지 않는다 — McpPathGuard 주석의 판단 근거 참조.
// ProjectSettings 를 넣은 이유: 이 인덱스 전체가 **텍스트 직렬화**를 전제로 하는데,
// 그걸 확인할 수 있는 곳이 `ProjectSettings/EditorSettings.asset` 이다(Force Binary 면 전부 무의미하다).
// 프로젝트 루트 안이므로 봉쇄는 그대로 유지된다.
const ASSET_ROOTS_RE = /^(Assets|Packages|ProjectSettings|Library\/PackageCache)(\/|$)/i;

function containedAssetPath(root, input) {
  const raw = String(input == null ? '' : input).replace(/\\/g, '/').trim();
  if (!raw) return { error: "asset is required — pass an asset path (e.g. 'Assets/X.prefab') or a 32-character GUID." };
  if (/^[a-zA-Z]:/.test(raw) || raw.startsWith('/')) {
    return { error: `'${raw}' is absolute. Pass a path relative to the project root (e.g. 'Assets/X.prefab').` };
  }

  const norm = path.posix.normalize(raw);
  if (norm === '..' || norm.startsWith('../')) {
    return { error: `'${raw}' resolves outside the project root.` };
  }
  if (!ASSET_ROOTS_RE.test(norm)) {
    return { error: `'${raw}' is not under Assets/, Packages/, ProjectSettings/ or Library/PackageCache/.` };
  }

  const rootAbs = path.resolve(root);
  const abs = path.resolve(rootAbs, norm);
  if (abs !== rootAbs && !abs.startsWith(rootAbs + path.sep)) {
    return { error: `'${raw}' resolves outside the project root.` };
  }
  return { rel: norm, abs };
}


/** 값 트리를 걸으며 참조를 해석해 넣는다. 원본 객체를 직접 고친다(방금 파싱한 것이라 안전하다). */
function annotateReferences(index, node, localDocs, depth) {
  if (!node || typeof node !== 'object' || depth > 12) return;

  if (Array.isArray(node)) {
    for (const v of node) annotateReferences(index, v, localDocs, depth + 1);
    return;
  }

  const hasFileID = Object.prototype.hasOwnProperty.call(node, 'fileID');
  if (hasFileID) {
    const g = typeof node.guid === 'string' ? node.guid : null;
    if (g) {
      // 다른 에셋으로 나가는 참조 — GUID 를 경로로 바꾼다. 이게 조인의 값이다.
      const p = index.guidToPath.get(g);
      if (p) node.assetPath = p;
      else node.assetPath = null;   // .meta 가 없다 = 프로젝트 밖이거나 사라진 에셋
    } else {
      // 같은 파일 안의 객체 참조 — 무엇을 가리키는지 이름을 붙인다.
      const fid = String(node.fileID);
      if (fid !== '0') {
        const d = localDocs.get(fid);
        if (d) node.localRef = d.label;
      }
    }
  }

  for (const k of Object.keys(node)) {
    if (k === 'assetPath' || k === 'localRef') continue;
    annotateReferences(index, node[k], localDocs, depth + 1);
  }
}

/** 타입과 그 베이스 체인의 필드 이름을 모은다. 인덱스 밖에서 끊기면 complete=false. */
function collectFieldNames(sym, info) {
  const names = new Set();
  const types = new Map();
  let cur = info;
  let complete = false;
  const seen = new Set();

  while (cur) {
    for (const f of cur.fields || []) {
      names.add(f.name);
      // 선언 타입도 같이 모은다. 파생 클래스가 먼저 오므로 이미 있는 이름은 덮지 않는다
      // (섀도잉된 필드는 파생 쪽이 직렬화된다).
      if (!types.has(f.name)) types.set(f.name, f.type ?? null);
    }
    if (seen.has(cur.fullName)) break;
    seen.add(cur.fullName);

    const base = cur.baseType;
    if (!base) { complete = true; break; }
    if (UNITY_ATTACHABLE.has(base) || NON_UNITY_ROOTS.has(base)) { complete = true; break; }
    const next = sym.typeByFullName.get(base);
    if (!next) break;         // 인덱스 밖 어셈블리(패키지 등)에서 끊겼다
    cur = next;
  }
  return { names, types, complete };
}

// 심볼 인덱스에 없지만 정상인 키. UnityEngine.Object/Behaviour 가 가진 것으로, 사용자 어셈블리
// 밖이라 필드 목록에 잡히지 않는다. 이걸 빼지 않으면 모든 컴포넌트가 m_Enabled 를 "낡은 키"로
// 보고한다 — 삭제 판단에 쓰이는 신호에서 거짓 양성은 가장 나쁜 형태다.
const UNITY_BASE_KEYS = new Set(['m_Enabled', 'm_Name', 'serializedVersion']);

/** 직렬화된 키가 실제 타입의 필드와 맞는가. 안 맞는 키는 이름이 바뀌었거나 남은 찌꺼기다. */
function checkFields(sym, info, values) {
  const { names, types, complete } = collectFieldNames(sym, info);
  const unknown = [];
  // 직렬화된 키의 **선언 타입**. 필드 서명 디코딩(97e77da)이 생기기 전에는 낼 수 없었다.
  // 이게 있어야 값을 검증할 수 있고, 어떤 키가 오브젝트 참조를 담는 필드인지 알 수 있다.
  // 값 자체를 판정하지는 않는다 - Unity 의 직렬화 매핑을 추측하지 않고, 타입을 그대로 싣는다.
  const declaredTypes = {};
  let matched = 0;
  let untypedCount = 0;
  for (const k of Object.keys(values)) {
    if (UNITY_BASE_KEYS.has(k) || COMPONENT_NOISE_KEYS.has(k)) continue;
    // 자동 속성은 컴파일러가 <Name>k__BackingField 로 만들고 Unity 도 그 이름으로 직렬화한다.
    if (names.has(k)) {
      matched++;
      const ty = types.get(k);
      if (ty) declaredTypes[k] = ty;
      else untypedCount++;
    } else unknown.push(k);
  }
  return {
    matchedFieldCount: matched,
    declaredTypes,
    ...(untypedCount ? { untypedFieldCount: untypedCount } : {}),
    unknownKeys: unknown,
    baseChainComplete: complete,
    note: unknown.length === 0
      ? 'Every serialized key maps to a field on the compiled type.'
      : (complete
        ? 'These serialized keys have no matching field on the type or its bases. Usually a renamed or ' +
          'deleted field whose old value is still in the asset (Unity keeps unknown keys on load and ' +
          'drops them on the next save). Harmless, but it means the value shown is not read by any code.'
        : 'Base chain leaves the indexed user assemblies, so inherited fields could not all be listed. ' +
          'unknownKeys here is inconclusive — a key may belong to a base class in a package assembly.'),
  };
}

/** 값 객체를 응답 크기 상한에 맞춰 자른다. 자른 사실은 반드시 드러낸다. */
function capValues(values, maxBytes) {
  const out = {};
  let used = 0;
  let dropped = 0;
  let itemsDropped = 0;

  for (const k of Object.keys(values)) {
    const v = values[k];
    const s = JSON.stringify(v);
    const cost = k.length + (s ? s.length : 4) + 4;

    if (used + cost <= maxBytes) { out[k] = v; used += cost; continue; }

    // 키 하나가 예산을 통째로 넘는 경우가 있다 — PrefabInstance 의 m_Modification 이 그렇다.
    // 그 키를 통째로 버리면 응답에 남는 게 serializedVersion 뿐이라 아무 쓸모가 없다.
    // 배열이면 앞에서부터 들어가는 만큼만 싣는다. 자른 개수는 반드시 함께 낸다.
    if (Array.isArray(v)) {
      const head = [];
      let sub = used + k.length + 6;
      for (const item of v) {
        const c = JSON.stringify(item);
        const ic = (c ? c.length : 4) + 1;
        if (sub + ic > maxBytes) break;
        head.push(item);
        sub += ic;
      }
      if (head.length) {
        out[k] = head;
        used = sub;
        itemsDropped += v.length - head.length;
        continue;
      }
    }
    dropped++;
  }
  return { values: out, droppedKeys: dropped, droppedItems: itemsDropped };
}

/**
 * 에셋(프리팹/씬/에셋)의 컴포넌트를 값까지 읽는다.
 *
 * 인덱스 빌드에 참여하지 않는다 — 이 파일 하나만 지금 파싱한다.
 */
function getAssetComponents(index, args) {
  const guid = resolveGuid(index, args.asset);
  const relPath = guid ? index.guidToPath.get(guid) : null;
  const asPath = relPath || String(args.asset || '').replace(/\\/g, '/').replace(/^\/+/, '');

  if (!asPath) {
    return { error: "asset is required — pass an asset path (e.g. 'Assets/X.prefab') or a 32-character GUID." };
  }

  const guard = containedAssetPath(index.root, asPath);
  if (guard.error) return { error: guard.error };
  const abs = guard.abs;

  let st;
  try { st = fs.statSync(abs); } catch {
    return {
      error: `'${asPath}' not found under the project root. Pass a project-relative path or a GUID. ` +
             (guid ? '' : 'The index does not know this GUID — it may be stale (unity_index_rebuild).'),
    };
  }
  if (!st.isFile()) {
    return { error: `'${asPath}' is a directory, not an asset file.` };
  }
  if (st.size > MAX_ASSET_BYTES) {
    return {
      error: `'${asPath}' is ${(st.size / 1048576).toFixed(1)} MB, over the ${MAX_ASSET_BYTES / 1048576} MB limit for ` +
             'value parsing. Assets this large are generated data (font atlases, navmesh, baked tables) rather than ' +
             'authored components. The index-level tools (unity_find_references, unity_find_component_usages) still ' +
             'cover this asset — only value reading is skipped.',
    };
  }

  const t0 = Date.now();
  let text;
  try { text = fs.readFileSync(abs, 'utf8'); } catch (e) { return { error: `Cannot read '${asPath}': ${e.message}` }; }

  if (!text.startsWith('%YAML')) {
    return {
      error: `'${asPath}' is not text-serialized YAML (no %YAML header). It is either a binary asset or a ` +
             'non-Unity file; values cannot be read without the Editor.',
    };
  }

  const parseOpts = {
    maxDepth: args.maxDepth > 0 ? Math.min(args.maxDepth, 32) : 8,
    maxSeqItems: args.maxArrayItems > 0 ? Math.min(args.maxArrayItems, 2000) : 200,
  };

  const { lines, docs } = yaml.splitDocuments(text);

  // 1) 전 문서를 훑어 fileID -> 문서 표. GameObject 이름과 로컬 참조 해석에 쓴다.
  const parsed = [];
  const localDocs = new Map();
  const typeCache = new Map();   // 스크립트 GUID -> 타입 전체 이름 (파일 안에서 재사용)
  let unparsedTotal = 0;
  const unparsedSamples = [];

  for (const d of docs) {
    const r = yaml.parseDocument(lines, d, parseOpts);
    unparsedTotal += r.unparsed;
    for (const s of r.unparsedSamples || []) if (unparsedSamples.length < 5) unparsedSamples.push(s);
    const name = r.body && typeof r.body.m_Name === 'string' ? r.body.m_Name : '';
    // 파서가 상한(maxArrayItems / 키 400개)에 걸려 잘랐는지. 이걸 안 실으면 배열이
    // 200개에서 조용히 끊긴 채로 나간다 — 실측(2026-08-24): 기본 상한에서 문서 24개가
    // 그렇게 잘리고 있었고 응답에는 아무 표시가 없었다.
    parsed.push({ doc: d, className: r.className, body: r.body || {}, name, parseTruncated: !!r.truncated });

    // 라벨은 조인 결과를 쓴다. 'MonoBehaviour' 라고만 하면 무엇을 가리키는 참조인지 알 수 없다.
    // 같은 GUID 가 문서마다 반복되므로 파일 안에서 한 번만 해석한다.
    let label = name ? `${r.className} '${name}'` : r.className;
    const msg = r.body && r.body.m_Script;
    if (msg && typeof msg === 'object' && typeof msg.guid === 'string') {
      let tn = typeCache.get(msg.guid);
      if (tn === undefined) {
        const j = resolveScriptType(index, msg.guid);
        tn = j.resolved && j.type ? j.type.fullName : null;
        typeCache.set(msg.guid, tn);
      }
      if (tn) label = tn;
    }

    localDocs.set(String(d.fileID), { label, className: r.className, name, body: r.body || {} });
  }

  // 2) 컴포넌트 -> 소속 GameObject 이름
  function ownerOf(body) {
    const go = body && body.m_GameObject;
    if (!go || typeof go !== 'object') return null;
    const fid = String(go.fileID);
    if (fid === '0') return null;
    const d = localDocs.get(fid);
    return { fileID: fid, name: d ? d.name : null, found: !!d };
  }

  const sym = index.symbols;
  const wantFileID = args.fileID ? String(args.fileID) : null;
  const wantComponent = args.component ? String(args.component).toLowerCase() : null;
  const wantGameObject = args.gameObject ? String(args.gameObject).toLowerCase() : null;

  const rows = [];
  let gameObjectCount = 0;

  for (const p of parsed) {
    if (p.className === 'GameObject') gameObjectCount++;
    if (args.includeGameObjects === false && p.className === 'GameObject') continue;

    const owner = ownerOf(p.body);

    // --- 조인: m_Script.guid -> 컴파일된 타입
    let script = null;
    const ms = p.body.m_Script;
    if (ms && typeof ms === 'object' && typeof ms.guid === 'string') {
      const join = resolveScriptType(index, ms.guid);
      script = {
        guid: ms.guid,
        csPath: join.csPath || null,
        // .meta 가 없으면 그 스크립트는 프로젝트에 없다 — 에디터의 "can not be loaded" 상태다.
        // 단, **커버리지가 부분이면 단정할 수 없다**. Assets/Packages 만 인덱싱한 상태에서는
        // PackageCache 안의 스크립트가 전부 "없음" 으로 보인다(실측: 그 상태의 전수 스윕에서
        // 4,667건이 없는 스크립트로 잡혔고 실제로는 270건이었다 — 17배 과보고).
        // 그래서 모를 때는 null 을 낸다. false 는 전체 커버리지에서만 쓴다.
        exists: index.guidToPath.has(ms.guid) ? true
          : (index.guidCoverage === 'full' ? false : null),
        type: join.resolved ? join.type : null,
        resolution: join.resolved ? join.confidence : join.reason,
        // Unity 가 직접 적어 둔 값. 우리 조인 결과와 대조할 수 있는 독립 근거다.
        editorClassIdentifier: typeof p.body.m_EditorClassIdentifier === 'string' && p.body.m_EditorClassIdentifier
          ? p.body.m_EditorClassIdentifier : null,
      };
      // Unity 가 에셋에 적어 둔 타입명과 대조한다. 독립 근거이긴 하지만 **캐시된 힌트**라
      // 오래될 수 있다 — 클래스 이름을 바꾸면 그 에셋을 다시 저장하기 전까지 옛 이름이 남는다.
      // 실측(2026-08-24): 불일치 13건 중 확인한 것은 전부 이름 변경이었다
      // (ColiderBasicAttack → ColliderBasicAttack 은 git 이력으로 확인).
      // 그러니 불일치는 "우리 조인이 틀렸다"가 아니라 "에셋의 힌트가 낡았다"는 뜻으로 읽어야 한다.
      const declared = script.editorClassIdentifier
        ? script.editorClassIdentifier.split('::').pop() : '';
      if (script.exists === null) {
        script.existsNote =
          'Unknown, not missing. Only Assets and Packages are indexed right now, so a script that lives in ' +
          'Library/PackageCache looks absent here. Use unity_find_missing_scripts (it merges full GUID ' +
          'coverage first) before treating this as a missing script.';
      }
      if (script.type && declared) {
        script.matchesEditorClassIdentifier = declared === script.type.fullName;
        if (!script.matchesEditorClassIdentifier) {
          script.editorClassIdentifierNote =
            'The asset still records a different type name than the one that compiles from this script file ' +
            'today. Usually the class was renamed and this asset has not been re-saved since. The name in ' +
            'type.fullName is what actually compiles now.';
        }
      }
    }

    const displayName = script && script.type ? script.type.fullName : p.className;

    if (wantFileID && String(p.doc.fileID) !== wantFileID) continue;
    if (wantComponent && !displayName.toLowerCase().includes(wantComponent)) continue;
    if (wantGameObject) {
      const n = (owner && owner.name) || (p.className === 'GameObject' ? p.name : '');
      if (!n || !n.toLowerCase().includes(wantGameObject)) continue;
    }

    // --- 값
    const values = {};
    for (const k of Object.keys(p.body)) {
      if (!args.includeUnityKeys && COMPONENT_NOISE_KEYS.has(k)) continue;
      // MonoBehaviour 컴포넌트의 m_Name 은 항상 빈 값이라 감춘다. 하지만 ScriptableObject
      // (.asset)는 같은 MonoBehaviour 문서인데 m_Name 이 **에셋 이름**이다 — 실제 데이터다.
      // script 유무로만 판단하면 그걸 통째로 버린다(IngameLibrary.asset 에서 그랬다).
      // 빈 값은 `''` 로도 `null` 로도 온다 — `m_Name: ` 뒤에 아무것도 없으면 파서가 null 을 낸다.
      // 둘 다 보지 않으면 감추려던 빈 키가 그대로 남는다.
      if (!args.includeUnityKeys && k === 'm_Name' && script &&
          (p.body[k] === '' || p.body[k] === null)) continue;
      values[k] = p.body[k];
    }
    annotateReferences(index, values, localDocs, 0);

    const capped = capValues(values, args.maxValueBytes > 0 ? Math.min(args.maxValueBytes, 200000) : 16000);

    rows.push({
      fileID: String(p.doc.fileID),
      classId: p.doc.classId,
      className: p.className,
      ...(p.doc.stripped ? { stripped: true } : {}),
      gameObject: owner,
      script,
      ...(sym && script && script.type
        ? { fieldCheck: checkFields(sym, sym.typeByFullName.get(script.type.fullName), values) }
        : {}),
      values: capped.values,
      ...(p.parseTruncated ? {
        parseTruncated: true,
        parseTruncationNote: 'While parsing, an array hit maxArrayItems (default 200) or a map hit 400 keys, ' +
          'so part of this object is not in the values above. Raise maxArrayItems to see the rest.',
      } : {}),
      ...(capped.droppedKeys || capped.droppedItems
        ? { valuesTruncated: true,
            ...(capped.droppedKeys ? { droppedKeyCount: capped.droppedKeys } : {}),
            ...(capped.droppedItems ? { droppedArrayItemCount: capped.droppedItems } : {}),
            truncationNote: 'Raise maxValueBytes, or narrow with fileID/component, to see the rest.' }
        : {}),
    });
  }

  const page = pageOf(rows, args.offset, args.maxResults > 0 ? args.maxResults : 25);

  return {
    asset: asPath,
    guid: guid || index.pathToGuid.get(asPath) || null,
    // script.exists 를 어떻게 읽어야 하는지의 근거. 'assets' 면 false 가 아니라 null 이 나온다.
    guidCoverage: index.guidCoverage,
    fileSizeBytes: st.size,
    documentCount: docs.length,
    gameObjectCount,
    totalCount: page.total,
    returnedCount: page.items.length,
    offset: page.offset,
    nextOffset: page.nextOffset,
    truncated: page.truncated,
    msParse: Date.now() - t0,
    components: page.items,
    // 파서가 못 읽은 줄. 0 이 아니면 이 응답의 값은 불완전하다 — 세기만 하고 감추지 않는다.
    unparsedLines: unparsedTotal,
    ...(unparsedTotal ? { unparsedSamples } : {}),
    note: 'Values are read from the serialized asset, not from the Editor, so this reflects what is on disk ' +
          '(unsaved Editor state is not visible). Object references carry assetPath (cross-asset) or localRef ' +
          '(same file) where they resolve. Unity writes booleans as 1/0.',
  };
}

// _checkFields 는 전수 측정용 시임이다. 도구 응답과 **같은 코드**로 재야 수치가 의미를 갖는다
// (도구를 통해 재면 파일당 500개 페이지 상한에 걸려 과소 집계된다 — 실제로 한 번 그랬다).
module.exports = { _checkFields: checkFields,
                   findReferences, findComponentUsages, findMissingScripts, getTypeSymbols,
                   findCallers, findCallees, status, resolveGuid, resolveScriptType,
                   getAssetComponents };
