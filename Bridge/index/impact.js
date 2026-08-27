'use strict';

/**
 * unity_impact_analysis — "이걸 바꾸면 무엇이 깨지나" 를 축을 나눠 한 번에 답한다.
 *
 * 대상은 셋 중 하나다: 타입(`Hurtbox`), 메서드(`GameManager::GoToResultButton`),
 * 에셋(경로 또는 32자 GUID).
 *
 * ⚠️ 이 파일보다 `Tools/probe-impact-analysis.js` 를 먼저 썼다. P1 의 교훈(HANDOFF §4-(22)):
 * 새 응답을 만들 때 "이 응답으로 답해야 하는 질문" 을 먼저 적지 않으면 무엇이 빠졌는지
 * 볼 방법이 없다. 코드 리뷰는 P1 에서 축 하나가 통째로 빠진 것을 두 번 놓쳤고,
 * 프로브는 첫 실행에 잡았다.
 *
 * 설계 원칙 셋:
 *
 * 1. **축을 합치지 않는다.** 코드 호출자와 인스펙터 배선과 타입이름 참조는 고치는 방법이
 *    다르다. 합쳐서 "영향 12건" 이라고 하면 어디를 봐야 하는지 알 수 없다.
 * 2. **모르는 것을 센다.** 이 인덱스는 동적 로드 44곳을 못 풀고, 인터페이스 구현 목록이
 *    아예 없고(타입 53개), 바이너리 에셋을 안 읽는다. 그걸 안 적으면 "다른 건 안 깨진다" 로
 *    읽힌다. `unknown` 은 옵션이 아니라 응답의 일부다.
 * 3. **전이는 경계를 명시한다.** 파생 타입의 호출자의 씬까지 따라가면 프로젝트 절반이 나온다.
 *    기본은 직접 영향 + 상속 폐쇄뿐이고, 호출자 전이는 `depth` 로 명시적으로 켠다.
 */

const path = require('path');

let log = () => {};
function setLogger(fn) { log = fn; }

const DEFAULT_MAX_PER_AXIS = 25;
const MAX_PER_AXIS = 200;
const MAX_DEPTH = 3;

const GENERATED_TYPE = /[<>]|^__|^UnitySourceGeneratedAssembly|(^|\.)MonoScriptData$|(^|\.)NameOf$|^__GEN\./;

function typeOfKey(key) {
  const i = key.indexOf('::');
  return i < 0 ? key : key.slice(0, i);
}

/** 배열을 상한까지 자르고 몇 개를 접었는지 같이 돌려준다. 조용히 자르지 않는다. */
function cap(list, max) {
  const arr = [...list].sort();
  if (arr.length <= max) return { items: arr, omitted: 0 };
  return { items: arr.slice(0, max), omitted: arr.length - max };
}

// ---------------------------------------------------------------------------
// 대상 해석
// ---------------------------------------------------------------------------

function resolveTarget(index, raw) {
  const sym = index.symbols;
  const t = String(raw).trim();

  if (t.indexOf('::') >= 0) {
    const [ty, m] = [typeOfKey(t), t.slice(t.indexOf('::') + 2)];
    const info = sym ? sym.typeByFullName.get(ty) : null;
    return { kind: 'method', type: ty, method: m, key: t, typeInfo: info || null };
  }

  // ⚠️ 중첩 타입의 유일한 이름(`Outer/Inner`)은 **에셋 경로 판정보다 먼저** 봐야 한다.
  // 아래 분기가 `/` 를 보면 무조건 에셋 경로로 취급하기 때문이다. 그래서 이 도구가
  // "candidates 중 하나를 넣어라" 라고 답해 놓고 **그 후보를 넣으면 '인덱스에 없다'** 고
  // 거절했다. 제시한 길이 막다른 길이면 거절만도 못하다. (2026-08-27 손검사로 잡음)
  if (sym && sym.typeByQualifiedName && sym.typeByQualifiedName.has(t)) {
    const ti = sym.typeByQualifiedName.get(t);
    return { kind: 'type', type: ti.fullName, typeInfo: ti, resolvedByQualifiedName: t };
  }

  // 32자 GUID 또는 경로처럼 보이면 에셋
  const isGuid = /^[0-9a-f]{32}$/i.test(t);
  if (isGuid || t.indexOf('/') >= 0) {
    // 입력이 경로면 GUID 가 있어야 실재하는 에셋이고, 입력이 GUID 면 경로가 있어야 한다.
    // 처음엔 `!guid && !assetPath` 로 판정했는데, 경로 입력은 assetPath 가 항상 채워지므로
    // **없는 경로가 "영향 0" 으로 통과했다.** 없는 대상에 0 을 답하면 "안 깨진다" 로 읽힌다.
    const guid = isGuid ? t.toLowerCase() : index.pathToGuid.get(t);
    const assetPath = isGuid ? index.guidToPath.get(t.toLowerCase()) : t;
    const exists = isGuid ? !!assetPath : !!guid;
    if (!exists) return { kind: 'asset', assetPath: assetPath || t, guid: guid || null, missing: true };
    return { kind: 'asset', assetPath: assetPath || null, guid: guid || null };
  }

  // 타입 이름
  if (sym) {
    // 전체 이름이 맞아도 **먼저 모호성을 본다.** 같은 전체 이름이 어셈블리를 넘어 두 번
    // 나오는 경우가 이 프로젝트에 29건 있다(`Segment`, `PassData`, `EffectState`, `Tab` 등).
    // 그중 하나를 조용히 골라 답하면 "이걸 바꾸면 무엇이 깨지나" 에 다른 타입의 영향을 준다.
    const short = sym.typesByShortName.get(t) || [];
    const sameName = short.filter(fn => fn === t);
    if (sameName.length > 1) {
      const asms = [];
      const winner = sym.typeByFullName.get(t);
      if (winner) asms.push(winner.assembly || '?');
      for (const d of (sym.duplicateTypes || [])) if (d.fullName === t) asms.push(d.assembly || '?');
      // 거절만 하면 막다른 길이다. 대신 물을 **유일한 이름**을 같이 준다.
      const qualified = [];
      const w = sym.typeByFullName.get(t);
      if (w) qualified.push(w.qualifiedName || w.fullName);
      for (const d of (sym.duplicateTypes || [])) {
        if (d.fullName === t) qualified.push(d.qualifiedName || d.fullName);
      }
      return { kind: 'ambiguous', sameFullName: true, name: t, count: sameName.length,
               assemblies: asms.sort(), candidates: qualified.sort(),
               hint: 'Pass one of candidates - nested types are unique under their Outer/Inner name.' };
    }
    if (sym.typeByFullName.has(t)) return { kind: 'type', type: t, typeInfo: sym.typeByFullName.get(t) };
    const uniq = [...new Set(short)];
    if (uniq.length === 1) return { kind: 'type', type: uniq[0], typeInfo: sym.typeByFullName.get(uniq[0]) };
    if (uniq.length > 1) {
      return { kind: 'ambiguous', candidates: uniq.sort().slice(0, 25), count: uniq.length };
    }
  }
  return { kind: 'unknown', input: t };
}

// ---------------------------------------------------------------------------
// 축 계산
// ---------------------------------------------------------------------------

/** 이 타입을 상속하는 타입들. 직계와 전이를 나눠서 — 폐쇄는 싸다(관측 최대 8). */
function subclassesOf(sym, typeName) {
  const direct = [];
  for (const [n, i] of sym.typeByFullName) {
    if (i.baseType === typeName && !GENERATED_TYPE.test(n)) direct.push(n);
  }
  const seen = new Set(direct);
  const stack = [...direct];
  while (stack.length) {
    const cur = stack.pop();
    for (const [n, i] of sym.typeByFullName) {
      if (i.baseType === cur && !GENERATED_TYPE.test(n) && !seen.has(n)) { seen.add(n); stack.push(n); }
    }
  }
  return { direct: direct.sort(), transitive: [...seen].sort() };
}

function baseChainOf(sym, typeName) {
  const chain = [];
  let cur = sym.typeByFullName.get(typeName);
  const guard = new Set([typeName]);
  while (cur && cur.baseType) {
    chain.push(cur.baseType);
    if (guard.has(cur.baseType)) break;
    guard.add(cur.baseType);
    cur = sym.typeByFullName.get(cur.baseType);
  }
  return chain;
}

/** 이 타입의 소스 파일에서 정의된 메서드 키들. */
function methodKeysOfType(sym, typeName) {
  const info = sym.typeByFullName.get(typeName);
  if (!info) return [];
  return (info.methods || []).map(m => typeName + '::' + m.name);
}

/** 메서드 키 집합의 호출자를 depth 단계까지 모은다. 단계별로 나눠 돌려준다. */
function callersUpTo(cg, keys, depth) {
  const levels = [];
  let frontier = new Set(keys);
  const seen = new Set(keys);
  for (let d = 0; d < depth; d++) {
    const next = new Set();
    for (const k of frontier) {
      for (const caller of (cg.callersOf.get(k) || [])) {
        if (seen.has(caller)) continue;
        seen.add(caller);
        next.add(caller);
      }
    }
    if (!next.size) break;
    levels.push([...next].sort());
    frontier = next;
  }
  return levels;
}

function attributesOfMethod(sym, typeName, methodName) {
  const info = sym.typeByFullName.get(typeName);
  if (!info) return [];
  const out = [];
  for (const m of (info.methods || [])) {
    if (m.name !== methodName) continue;
    for (const a of (m.attributes || [])) out.push(a);
  }
  return [...new Set(out)].sort();
}

function attributesOfType(sym, typeName) {
  const info = sym.typeByFullName.get(typeName);
  if (!info) return [];
  const out = [];
  for (const m of (info.methods || [])) {
    for (const a of (m.attributes || [])) out.push(m.name + ' [' + a + ']');
  }
  return [...new Set(out)].sort();
}

// ---------------------------------------------------------------------------
// 본체
// ---------------------------------------------------------------------------

function buildImpact(index, args) {
  const sym = index.symbols;
  if (!sym || !sym.typeByFullName || !sym.typeByFullName.size) {
    return {
      error: 'Symbol index is empty — Library/ScriptAssemblies has no readable user assembly. ' +
             'Let Unity finish compiling, then run unity_index_rebuild.',
    };
  }

  const a = args || {};
  if (!a.target || !String(a.target).trim()) {
    return { error: "target is required — a type name ('Hurtbox'), a 'Type::Method' key, or an asset path / 32-char GUID." };
  }
  let maxPerAxis = Number.isFinite(a.maxPerAxis) ? Math.floor(a.maxPerAxis) : DEFAULT_MAX_PER_AXIS;
  if (maxPerAxis < 1) maxPerAxis = 1;
  if (maxPerAxis > MAX_PER_AXIS) maxPerAxis = MAX_PER_AXIS;
  let depth = Number.isFinite(a.depth) ? Math.floor(a.depth) : 1;
  if (depth < 1) depth = 1;
  if (depth > MAX_DEPTH) depth = MAX_DEPTH;

  const target = resolveTarget(index, a.target);

  if (target.kind === 'ambiguous') {
    if (target.sameFullName) {
      // 거절하되 **막다르지 않게** 한다. 중첩 타입은 `Outer/Inner` 로 유일하므로 그 이름을 준다.
      // 수치 정정(2026-08-27): 겹쳐 밀린 것은 레코드 123개이고 **고유 이름은 29개**다.
      // 그중 19개가 컴파일러 생성이고, 사용자가 실제로 질의할 만한 것은
      // PassData(3) · Segment(2) · Tab(2) · FactorySettings(2) · EffectState(2) 다섯이다.
      return {
        error: `${target.count} types in the user assemblies carry the full name '${target.name}' ` +
               `(assemblies: ${[...new Set(target.assemblies)].join(', ')}). The index keys types by ` +
               `namespace.name, which drops the declaring type of a nested type, so nested types with ` +
               `the same name collide. Pass one of candidates below - a nested type is unique under its ` +
               `Outer/Inner name - or ask about a method ('Type::Method') or the source file as an asset.`,
        assemblies: [...new Set(target.assemblies)],
        candidates: target.candidates || [],
      };
    }
    return {
      error: `'${a.target}' matches ${target.count} types. Pass the full name.`,
      candidates: target.candidates,
    };
  }
  if (target.kind === 'asset' && target.missing) {
    // 없는 에셋에 축을 0 으로 채워 돌려주면 "아무것도 안 깨진다" 로 읽힌다.
    // 이 프로젝트에서 반복해 고쳐 온 형태의 오답이라 여기서는 에러로 끊는다.
    return {
      error: `'${a.target}' is not in the index — no .meta with that path or GUID. ` +
             `It may be deleted, outside Assets (ProjectSettings files are scanned as reference ` +
             `sources but have no GUID of their own), or the index may be stale — run unity_index_rebuild. ` +
             `No impact axes are reported: zeroes here would read as "nothing breaks".`,
    };
  }
  if (target.kind === 'unknown') {
    return {
      error: `Could not resolve '${a.target}'. Pass a type name, 'Type::Method', an asset path ` +
             `(e.g. 'Assets/2.Prefabs/Player.prefab'), or a 32-character GUID. ` +
             `If it is a real asset the index may be stale — run unity_index_rebuild.`,
    };
  }

  const cg = index.callGraph || { callersOf: new Map(), callsFrom: new Map() };
  const out = {
    target: { input: String(a.target), kind: target.kind },
    depth,
    summary: { impactedCount: 0, byAxis: {} },
  };

  let impacted = 0;
  const axis = (name, n) => { out.summary.byAxis[name] = n; impacted += n; };

  // ---- 코드 축 -----------------------------------------------------------
  const codeKeys = target.kind === 'method'
    ? [target.key]
    : (target.kind === 'type' ? methodKeysOfType(sym, target.type) : []);

  if (codeKeys.length) {
    const levels = callersUpTo(cg, codeKeys, depth);
    const direct = levels[0] || [];
    const capped = cap(direct, maxPerAxis);
    const callerFiles = new Set();
    for (const k of direct) {
      const info = sym.typeByFullName.get(typeOfKey(k));
      const f = info && info.sourceFiles && info.sourceFiles[0];
      if (f) callerFiles.add(f);
    }
    out.code = {
      callers: capped.items,
      callersOmitted: capped.omitted,
      callerFiles: [...callerFiles].sort().slice(0, maxPerAxis),
      callerFileCount: callerFiles.size,
    };
    if (levels.length > 1) {
      out.code.transitive = levels.slice(1).map((lv, i) => ({
        level: i + 2, count: lv.length, sample: lv.slice(0, Math.min(10, maxPerAxis)),
      }));
      out.code.transitiveNote =
        'Level 2+ are callers of callers. They are listed as counts with a sample because the ' +
        'fan-out is not bounded by anything meaningful: raise depth only when you need it. ' +
        'Measured on this project (120-method sample): level 1 median 1 / p90 3 / max 59, ' +
        'level 2 median 1 / p90 5 / max 76.';
      out.summary.byAxis.transitiveCallers =
        out.code.transitive.reduce((n, lv) => n + lv.count, 0);
    }
    axis('codeCallers', direct.length);
  }

  // ---- 상속 축 -----------------------------------------------------------
  if (target.kind === 'type' || (target.kind === 'method' && target.typeInfo)) {
    const ty = target.kind === 'type' ? target.type : target.type;
    const subs = subclassesOf(sym, ty);
    const t = cap(subs.transitive, maxPerAxis);
    out.inheritance = {
      type: ty,
      baseChain: baseChainOf(sym, ty),
      directSubclasses: subs.direct.slice(0, maxPerAxis),
      transitiveSubclasses: t.items,
      transitiveOmitted: t.omitted,
    };
    if (target.kind === 'method' && !subs.transitive.length) {
      // 메서드 대상인데 파생이 없으면 빈 블록은 잡음이다. 타입 대상일 때는 "파생 없음" 이
      // 답이므로 남긴다.
      delete out.inheritance;
    } else if (target.kind === 'method') {
      out.inheritance.note =
        'Subclasses of the declaring type. If this method is virtual or abstract, an override in ' +
        'any of them changes behaviour at the call sites above; the call graph key is Type::Method ' +
        'and does not distinguish overrides.';
    }
    axis('subclasses', subs.transitive.length);
  }

  // ---- 에셋 축 -----------------------------------------------------------
  const assetsBlock = { };
  if (target.kind === 'type' || target.kind === 'method') {
    // 이 타입의 스크립트 GUID로 붙어 있는 에셋
    const ty = target.type || target.kind;
    const info = sym.typeByFullName.get(ty);
    const src = info && info.sourceFiles && info.sourceFiles[0];
    const guid = src ? index.pathToGuid.get(src) : null;
    const users = guid ? index.scriptRefs.get(guid) : null;
    if (users && users.size) {
      const c = cap(users, maxPerAxis);
      assetsBlock.attachedTo = c.items;
      assetsBlock.attachedToOmitted = c.omitted;
      axis('attachedAssets', users.size);
    }
    if (src) assetsBlock.scriptAsset = src;
  }

  if (target.kind === 'asset' && target.guid) {
    const refs = index.refs.get(target.guid) || new Set();
    const weak = index.weakRefs ? (index.weakRefs.get(target.guid) || new Set()) : new Set();
    // .cs 출처는 코드다 — 경로 상수 로드(`Resources.Load`, `LoadAssetAtPath`)로 들어온 엣지이거나
    // 소스에 GUID 를 적어둔 것이다. 후자는 weakRefs 에 있으므로 그걸로 가른다.
    const codeSrc = [...refs].filter(p => /\.cs$/i.test(p) && !weak.has(p));
    const settings = [...refs].filter(p => p.startsWith('ProjectSettings/'));
    const assetSrc = [...refs].filter(p => !/\.cs$/i.test(p) && !p.startsWith('ProjectSettings/'));

    const cRef = cap(assetSrc, maxPerAxis);
    assetsBlock.referencedBy = cRef.items;
    assetsBlock.referencedByOmitted = cRef.omitted;
    if (weak.size) {
      assetsBlock.textualMatches = cap(weak, maxPerAxis).items;
      assetsBlock.textualMatchNote =
        'These matched the GUID as text in a non-serialized file (shader graph, asmdef, source, ' +
        'docs), not in a serialized reference field. Usually real, but check before treating them ' +
        'as the only thing keeping the asset alive.';
    }
    if (settings.length) {
      assetsBlock.projectSettings = settings.sort();
      assetsBlock.projectSettingsNote =
        'Referenced from ProjectSettings — build scene list, graphics or quality settings. ' +
        'Deleting or moving the asset changes project configuration, not just other assets.';
    }
    if (codeSrc.length) {
      out.code = out.code || {};
      out.code.pathLoads = codeSrc.sort();
      out.code.pathLoadsNote =
        'Code loads this asset by a literal or const-folded path (Resources.Load, ' +
        'AssetDatabase.LoadAssetAtPath). Renaming or moving the asset breaks these without a ' +
        'compile error.';
      axis('codePathLoads', codeSrc.length);
    }
    axis('referencingAssets', assetSrc.length);
    if (weak.size) axis('textualMatches', weak.size);
    if (settings.length) axis('projectSettings', settings.length);

    // 이 에셋이 스크립트면, 붙어 있는 곳도 같이 낸다.
    if (/\.cs$/i.test(target.assetPath || '')) {
      const users = index.scriptRefs.get(target.guid);
      if (users && users.size) {
        const c = cap(users, maxPerAxis);
        assetsBlock.attachedTo = c.items;
        assetsBlock.attachedToOmitted = c.omitted;
        axis('attachedAssets', users.size);
      }
      const types = sym.typesBySourceFile.get(target.assetPath) || [];
      if (types.length) assetsBlock.definesTypes = types.slice(0, maxPerAxis);
    }

    // 빌드 씬이면 그 사실과 순번
    if (/\.unity$/i.test(target.assetPath || '')) {
      const bs = readBuildScenes(index.root);
      const hit = bs ? bs.find(s => s.path === target.assetPath) : null;
      if (hit) {
        out.buildScene = hit;
        out.buildSceneNote =
          'Listed in ProjectSettings/EditorBuildSettings.asset at this index. Enabled does not ' +
          'mean production — this project keeps dev and test scenes enabled too. Removing or ' +
          'renaming the scene changes SceneManager load-by-index behaviour.';
      }
    }
  }
  if (Object.keys(assetsBlock).length) out.assets = assetsBlock;

  // ---- 데이터 축 (에셋 안에 저장된 호출/참조) -----------------------------
  const dataBlock = {};
  if (target.kind === 'method') {
    const wired = index.inspectorWiring && index.inspectorWiring.byKey
      ? index.inspectorWiring.byKey.get(target.key) : null;
    if (wired && wired.size) {
      dataBlock.inspectorWirings = [...wired].sort();
      // 직렬화된 배선이 적어둔 타입 이름이 지금 이름과 다를 수 있다. 실측(2026-08-26):
      // 3건이 `TempGameManager` 를 적어두고 있고 조인으로 `GameManager` 에 붙었다.
      // 이름을 바꾸는 판단을 할 때 이건 알아야 한다 — 그 행들은 이미 낡은 이름을 들고 있다.
      const stale = [];
      for (const [, list] of index.inspectorWiring.byMethod) {
        for (const w of list) {
          if (!w || w.method !== target.method) continue;
          if (w.type !== target.type) continue;
          if (w.declaredType && w.declaredType !== w.type) {
            stale.push({ asset: w.asset, declaredType: w.declaredType, resolvedType: w.type });
          }
        }
      }
      if (stale.length) {
        dataBlock.staleDeclaredTypes = stale;
        dataBlock.staleDeclaredTypeNote =
          'These wirings store a type name that no longer matches the resolved type. They were ' +
          'joined through the target asset, not the name. A rename decision should treat them as ' +
          'already out of date.';
      }
      dataBlock.inspectorWiringNote =
        'UnityEvent persistent calls stored in these assets. They never appear in the IL call ' +
        'graph. Renaming or removing the method breaks them silently — the Editor shows the row ' +
        'as <Missing> only when someone opens that object.';
      axis('inspectorWirings', wired.size);
    }
  }
  if (target.kind === 'type' || target.kind === 'method') {
    const ty = target.type;
    const named = index.typeNameRefs && index.typeNameRefs.byType
      ? index.typeNameRefs.byType.get(ty) : null;
    if (named && named.size) {
      dataBlock.typeNameRefs = [...named].sort();
      dataBlock.typeNameRefNote =
        'These assets name the type as an assembly-qualified string (a Behavior graph node, for ' +
        'example). Renaming the type or its assembly breaks them, and no compiler or GUID index ' +
        'sees it.';
      axis('typeNameRefs', named.size);
    }
    // 이 타입의 어느 메서드든 인스펙터에 배선돼 있으면 알린다(타입 대상일 때).
    if (target.kind === 'type' && index.inspectorWiring && index.inspectorWiring.byKey) {
      const hits = [];
      for (const [key, assets] of index.inspectorWiring.byKey) {
        if (typeOfKey(key) !== ty) continue;
        for (const asset of assets) hits.push(key + '  <-  ' + asset);
      }
      if (hits.length) {
        dataBlock.inspectorWirings = hits.sort().slice(0, maxPerAxis);
        axis('inspectorWirings', hits.length);
      }
    }
  }
  if (Object.keys(dataBlock).length) out.data = dataBlock;

  // ---- 진입점 축 ---------------------------------------------------------
  const attrs = target.kind === 'method'
    ? attributesOfMethod(sym, target.type, target.method)
    : (target.kind === 'type' ? attributesOfType(sym, target.type) : []);
  if (attrs.length) {
    out.entryPoints = {
      attributes: attrs.slice(0, maxPerAxis),
      note: 'A framework calls these, so a zero caller count is expected and not evidence of ' +
            'dead code. [Conditional] means the calls are removed from builds without that symbol.',
    };
    axis('attributeEntryPoints', attrs.length);
  }

  // ---- 모르는 것 ---------------------------------------------------------
  const st = index.stats || {};
  out.unknown = {
    dynamicLoadSites: st.dynamicLoadSites || 0,
    dynamicLoadNote:
      'Call sites that load an asset by a path built at run time. Any of them could reach this ' +
      'target; the index cannot say which.',
    interfaceImplementers:
      'not indexed — the symbol index stores only each type base class, so "who implements this ' +
      'interface" cannot be answered here (53 interface types in this project). Ask the compiler.',
    referenceEdgesToUnindexed: (() => {
      let n = 0;
      for (const [g, s] of index.refs) if (!index.guidToPath.has(g)) n += s.size;
      return n;
    })(),
    binaryAssetsSkipped: st.otherBinarySkipped || 0,
    largeTextAssetsSkipped: st.otherLargeSkipped || 0,
    projectSettingsScanned: true,
    editorState: 'disk only — unsaved scene or prefab edits in the open Editor are invisible here',
    overloads: 'call graph keys are Type::Method, so overloads share one key and their callers are merged',
    nestedTypeNames:
      'type names are namespace.name without the declaring type, so nested types with the same name ' +
      'collide (123 types in this project, all nested). Impact for such a name is refused rather than ' +
      'guessed; other tools report the collision as ambiguousFullName.',
  };

  // 무엇이 "깨지나" 는 **어떤 연산인가**에 달렸다. 같은 데이터가 연산에 따라 다르게 읽힌다:
  // GUID 를 보존하는 이름 변경은 직렬화 참조 2건을 그대로 두고 코드의 경로 상수만 깨뜨리고,
  // 메서드 본문 변경은 호출자 45개 파일 중 어느 것도 깨뜨리지 않는다.
  // 그래서 축을 **출처**로 가른다 — 이름으로 가리키나(조용히 깨진다), GUID 로 가리키나
  // (이름 변경·이동에 살아남는다), 컴파일러가 보나(즉시 잡힌다).
  // 이건 Unity 의 동작을 실험한 결과가 아니라 **직렬화 형태에서 도출한 것**이고, 그렇게 적는다.
  const present = k => !!out.summary.byAxis[k];
  const byName = [];
  const byGuid = [];
  const byCompiler = [];
  if (present('inspectorWirings')) byName.push('data.inspectorWirings (m_MethodName is a string)');
  if (present('typeNameRefs')) byName.push('data.typeNameRefs (assembly-qualified name string)');
  if (present('codePathLoads')) byName.push('code.pathLoads (asset path string in code)');
  if (present('referencingAssets')) byGuid.push('assets.referencedBy (GUID)');
  if (present('attachedAssets')) byGuid.push('assets.attachedTo (m_Script GUID)');
  if (present('projectSettings')) byGuid.push('assets.projectSettings (GUID)');
  if (present('textualMatches')) byGuid.push('assets.textualMatches (GUID written as text)');
  if (present('codeCallers')) byCompiler.push('code.callers');
  if (present('subclasses')) byCompiler.push('inheritance.transitiveSubclasses');
  out.effectByOperation = {
    rename: {
      breaksSilently: byName,
      caughtByCompiler: byCompiler,
      survives: byGuid,
    },
    moveOrReimport: {
      breaksSilently: byName.filter(x => /pathLoads/.test(x)),
      survives: byGuid.concat(byName.filter(x => !/pathLoads/.test(x))),
    },
    delete: { breaks: byName.concat(byGuid).concat(byCompiler) },
    changeBodyOnly: {
      breaks: [],
      note: 'no structural reference changes; behaviour changes for everything listed above',
    },
    basis: 'derived from how each axis points at the target (name string / GUID / compiled reference), ' +
           'not from testing Unity behaviour. Verify before a large rename.',
  };

  out.summary.impactedCount = impacted;
  out.note =
    'Axes are reported separately on purpose: a code caller, an Inspector wiring, a type-name ' +
    'string and a const-path load break in different ways and are fixed differently, so no single ' +
    'total is given. Zero on every axis is not proof that nothing breaks — read unknown. ' +
    'Transitive impact stops at the depth you asked for (default 1) except for the inheritance ' +
    'closure, which is complete. impactedCount counts things that depend on the target, which is ' +
    'not the same as things that break: read effectByOperation before concluding that a rename or ' +
    'a body change is dangerous.';

  return out;
}

// P1 과 같은 파일을 읽는다. 여기서 다시 읽는 이유는 영향 분석이 P1 없이도 동작해야 하기 때문이다.
function readBuildScenes(root) {
  const fs = require('fs');
  let text;
  try { text = fs.readFileSync(path.join(root, 'ProjectSettings', 'EditorBuildSettings.asset'), 'utf8'); }
  catch (e) { return null; }
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

module.exports = { buildImpact, setLogger, resolveTarget };
