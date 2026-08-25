'use strict';
// Phase 3 레이어 D: **인스펙터가 만든 호출 엣지**.
//
// IL 호출 그래프(레이어 B-2)는 코드가 코드를 부르는 것만 본다. 그런데 Unity 에서는
// 호출의 상당 부분이 **에셋 안에 데이터로** 들어 있다 — 버튼의 OnClick 에 끌어다 놓은 메서드는
// 어느 .cs 에서도 호출되지 않는다.
//
// 실측(2026-08-24, MainProject)이 그 결과를 그대로 보여준다:
//   unity_find_callers GameManager::GoToResultButton  → 호출자 0
//   실제로는 씬 2개(4.MapScene, 4.MapScene-trensparent)의 버튼에 배선돼 있다.
//   소스에도 그렇게 적혀 있다: "씬에서 GoToResultButton 퍼시스턴트 이벤트로 이미 연결됨"
//
// "호출자 0" 은 "지워도 된다" 로 읽힌다. 이건 참조 인덱스가 "참조 0" 을 잘못 답하던 것과
// 같은 형태의 결함이고, 같은 이유로 위험하다.
//
// JetBrains Rider 가 2018.3 부터 같은 것을 인덱싱한다(m_PersistentCalls / m_Target /
// m_MethodName 을 읽어 Find Usages 에 "Unity event handler" 로 넣는다). 접근이 검증돼 있다.
//
// 비용: 레이어 A 가 훑을 때 `m_PersistentCalls` 를 담은 파일 경로를 미리 모아 둔다
// (부분 문자열 검사 1회, 추가 I/O 0). 이 프로젝트에서 1,144개 중 **23개**만 여기서 파싱한다.

const fs = require('fs');
const path = require('path');
const yaml = require('./yamlvalues');

// 외부 대상(다른 에셋의 컴포넌트)을 해석할 때 그 에셋을 파싱한다. 큰 파일은 포기하고
// 선언된 이름으로 대체한다 — 배선 하나 때문에 17 MB 프리팹을 파싱할 이유가 없다.
const MAX_TARGET_ASSET_BYTES = 4 * 1024 * 1024;

/** `Namespace.Type, Assembly, Version=…` 에서 타입 이름만. */
function typeNameOf(assemblyQualified) {
  if (typeof assemblyQualified !== 'string' || !assemblyQualified) return null;
  const t = assemblyQualified.split(',')[0].trim();
  return t || null;
}

/** 문서 하나에서 m_Script.guid 를 꺼내 컴파일된 타입으로 해석한다. */
function typeOfDoc(doc, index, resolveScriptType, cache) {
  const ms = doc && doc.body && doc.body.m_Script;
  if (!ms || typeof ms !== 'object' || typeof ms.guid !== 'string') return null;
  let t = cache.get(ms.guid);
  if (t === undefined) {
    const j = resolveScriptType(index, ms.guid);
    t = j.resolved && j.type ? j.type.fullName : null;
    cache.set(ms.guid, t);
  }
  return t;
}

/**
 * 인스펙터 배선 인덱스를 만든다.
 *
 * @param {string} root
 * @param {string[]} eventFiles  `m_PersistentCalls` 를 담은 YAML 파일 절대경로
 * @param {object} index         레이어 A+B 가 올라간 인덱스(guidToPath, symbols 필요)
 * @param {function} resolveScriptType  queries.resolveScriptType (순환 import 를 피해 주입받는다)
 */
function buildInspectorWiring(root, eventFiles, index, resolveScriptType) {
  const t0 = Date.now();
  const byKey = new Map();      // "Type::Method" -> Set(배선한 에셋 경로)
  const byMethod = new Map();   // "Method" -> [배선 상세]
  const typeCache = new Map();  // 스크립트 GUID -> 타입 전체 이름
  const assetDocCache = new Map();   // 에셋 경로 -> Map(fileID -> 문서) | null(파싱 포기)

  let calls = 0, resolved = 0, viaDeclared = 0, unresolved = 0, disabled = 0, staleDeclared = 0;

  /** 다른 에셋의 fileID 가 가리키는 컴포넌트의 타입. 못 하면 null. */
  function typeOfExternal(assetPath, fileID) {
    if (!assetPath) return null;
    let docs = assetDocCache.get(assetPath);
    if (docs === undefined) {
      docs = null;
      const abs = path.join(root, assetPath);
      try {
        const st = fs.statSync(abs);
        if (st.isFile() && st.size <= MAX_TARGET_ASSET_BYTES) {
          const text = fs.readFileSync(abs, 'utf8');
          if (text.startsWith('%YAML')) {
            const s = yaml.splitDocuments(text);
            docs = new Map();
            for (const d of s.docs) {
              // 깊이는 얕게 — m_Script 만 필요하다.
              docs.set(String(d.fileID), yaml.parseDocument(s.lines, d, { maxDepth: 3, maxSeqItems: 1 }));
            }
          }
        }
      } catch { docs = null; }
      assetDocCache.set(assetPath, docs);
    }
    if (!docs) return null;
    const doc = docs.get(String(fileID));
    return doc ? typeOfDoc(doc, index, resolveScriptType, typeCache) : null;
  }

  for (const f of eventFiles) {
    let text;
    try { text = fs.readFileSync(f, 'utf8'); } catch { continue; }
    const assetPath = path.relative(root, f).split(path.sep).join('/');

    const s = yaml.splitDocuments(text);
    const docs = new Map();
    const parsed = [];
    for (const d of s.docs) {
      const r = yaml.parseDocument(s.lines, d, { maxDepth: 16, maxSeqItems: 2000 });
      docs.set(String(d.fileID), r);
      parsed.push(r);
    }

    // m_PersistentCalls 는 컴포넌트마다 다른 필드 밑에 있다(m_OnClick, onValueChanged, …).
    // 그래서 값 트리를 걸으며 찾는다.
    const visit = (node, depth) => {
      if (!node || typeof node !== 'object' || depth > 12) return;
      if (Array.isArray(node)) { for (const v of node) visit(v, depth + 1); return; }

      const pc = node.m_PersistentCalls;
      if (pc && Array.isArray(pc.m_Calls)) {
        for (const call of pc.m_Calls) {
          if (!call || typeof call !== 'object') continue;
          const method = typeof call.m_MethodName === 'string' ? call.m_MethodName.trim() : '';
          if (!method) continue;
          calls++;

          // m_CallState 0 = Off. 배선은 있지만 실행되지 않는다 — 세되 구분한다.
          const off = call.m_CallState === 0;
          if (off) disabled++;

          const declared = typeNameOf(call.m_TargetAssemblyTypeName);
          const tgt = call.m_Target && typeof call.m_Target === 'object' ? call.m_Target : {};
          const fid = tgt.fileID === undefined ? '0' : String(tgt.fileID);

          let type = null;
          let targetAsset = null;

          if (typeof tgt.guid === 'string') {
            // 다른 에셋의 오브젝트를 가리킨다.
            targetAsset = index.guidToPath.get(tgt.guid) || null;
            type = typeOfExternal(targetAsset, fid);
          } else if (fid !== '0') {
            const d = docs.get(fid);
            if (d) type = typeOfDoc(d, index, resolveScriptType, typeCache);
          }

          if (type) resolved++;
          else if (declared) { type = declared; viaDeclared++; }
          else { unresolved++; }

          // 선언된 이름이 지금 컴파일되는 타입과 다르면 그 사실을 남긴다.
          // m_EditorClassIdentifier 와 같은 성질이다 — 클래스 이름을 바꾸고 에셋을 다시
          // 저장하지 않으면 옛 이름이 남는다(실측: TempGameManager → 현재 GameManager).
          //
          // 단, 에셋이 **네임스페이스 없는 짧은 이름**을 적어 두는 경우가 있다
          // (실측: `RuntimeAnimatorPlayer` vs `INab.Demo.RuntimeAnimatorPlayer`).
          // 그걸 이름 변경으로 보고하면 거짓 경보다 — 짧은 이름 일치도 같은 것으로 친다.
          const shortOf = t => t.slice(t.lastIndexOf('.') + 1);
          const stale = !!(declared && type && declared !== type && declared !== shortOf(type));
          if (stale) staleDeclared++;

          const entry = {
            asset: assetPath,
            method,
            type: type || null,
            ...(stale ? { declaredType: declared } : {}),
            ...(targetAsset ? { targetAsset } : {}),
            ...(off ? { callState: 'Off' } : {}),
          };

          if (type) {
            const key = `${type}::${method}`;
            let set = byKey.get(key);
            if (!set) byKey.set(key, set = new Set());
            set.add(assetPath);
          }
          let list = byMethod.get(method);
          if (!list) byMethod.set(method, list = []);
          list.push(entry);
        }
      }

      for (const k of Object.keys(node)) {
        if (k === 'm_PersistentCalls') continue;
        visit(node[k], depth + 1);
      }
    };

    for (const r of parsed) visit(r.body, 0);
  }

  return {
    byKey,
    byMethod,
    stats: {
      files: eventFiles.length,
      calls,
      resolvedByJoin: resolved,
      resolvedByDeclaredName: viaDeclared,
      unresolved,
      disabledCalls: disabled,
      staleDeclaredNames: staleDeclared,
      msTotal: Date.now() - t0,
    },
  };
}

// --- 타입 이름 문자열 참조 -----------------------------------------------------
//
// 어떤 프레임워크는 컴포넌트를 GUID 가 아니라 **어셈블리 수식 타입 이름**으로 저장한다.
// Unity Behavior 그래프가 그렇다:
//     RuntimeTypeString: BombAction, Assembly-CSharp, Version=0.0.0.0, Culture=neutral, ...
//
// 그러면 그 클래스는 어느 프리팹에도 붙어 있지 않고, 어느 코드도 호출하지 않는다.
// 실측(2026-08-24): `BombAction` 에 대해 우리 도구 셋이 전부 0 을 답했다 —
//   get_type_symbols 붙은 에셋 0 / find_callers 0 / find_references 0
// 실제로는 보스 행동트리의 노드다. 지우면 보스 AI 가 깨진다.
//
// 필드 이름 화이트리스트(`RuntimeTypeString` 등)로 잡지 않는다 — 확장자 화이트리스트에서
// 이미 실패한 방식이다. **형태**로 잡는다: `타입, 어셈블리, Version=` 꼴이고 그 타입이
// 심볼 인덱스에 실재할 때만 엣지로 친다. 심볼 인덱스는 사용자 어셈블리만 담으므로
// mscorlib/UnityEngine 타입은 저절로 걸러진다(실측: 656건 중 사용자 타입은 32건).
//
// ⚠️ 어셈블리 이름에는 하이픈이 들어간다(`Assembly-CSharp`). 문자 클래스에서 빠뜨리면
//    정작 프로젝트 코드만 통째로 안 잡힌다 — 처음에 그렇게 했다가 표본에서 발견했다.
const TYPE_QUALIFIED_RE = /([A-Za-z_][A-Za-z0-9_.`+]*)\s*,\s*([A-Za-z0-9_.\-]+)\s*,\s*Version=/g;

/**
 * @param {string[]} typeRefFiles  `Version=` 을 담은 YAML 파일(레이어 A 가 모아 둔 것)
 * @param {object} sym             심볼 인덱스
 */
function buildTypeNameRefs(root, typeRefFiles, sym) {
  const t0 = Date.now();
  const byType = new Map();     // 타입 전체 이름 -> Set(그 이름을 담은 에셋)
  let candidates = 0, matched = 0;

  if (!sym) return { byType, stats: { files: 0, candidates: 0, edges: 0, msTotal: 0 } };

  for (const f of typeRefFiles) {
    let text;
    try { text = fs.readFileSync(f, 'latin1'); } catch { continue; }
    const assetPath = path.relative(root, f).split(path.sep).join('/');

    TYPE_QUALIFIED_RE.lastIndex = 0;
    let m;
    while ((m = TYPE_QUALIFIED_RE.exec(text)) !== null) {
      candidates++;
      const name = m[1];
      if (!sym.typeByFullName.has(name)) continue;   // 사용자 어셈블리 타입이 아니다
      matched++;
      let set = byType.get(name);
      if (!set) byType.set(name, set = new Set());
      set.add(assetPath);
    }
  }

  let edges = 0;
  for (const s of byType.values()) edges += s.size;
  return {
    byType,
    stats: { files: typeRefFiles.length, candidates, types: byType.size, edges, msTotal: Date.now() - t0 },
  };
}

module.exports = { buildInspectorWiring, buildTypeNameRefs };
