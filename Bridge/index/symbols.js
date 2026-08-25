'use strict';
// 레이어 B: 컴파일된 어셈블리에서 타입/멤버 심볼을 읽고, PDB 로 "소스 파일 ↔ 타입"을 잇는다.
//
// 이게 NarshaADK 의 "Compiler Symbol Index (PDB)" 레이어에 대응한다. 소스를 재파싱하지 않고
// 컴파일러가 이미 만들어 둔 결과를 읽는다는 점이 같다.
//
// 왜 PDB 인가 — 스크립트 GUID 는 .cs **파일 경로**를 가리키는데, 우리가 알고 싶은 것은 **타입**이다.
// 파일명으로 클래스명을 추측하는 방법은 (a) 한 파일에 여러 타입, (b) 네임스페이스,
// (c) 파일명과 다른 클래스명(비 MonoBehaviour) 에서 틀린다.
// Portable PDB 의 Document / MethodDebugInformation 테이블은 이 매핑을 정확히 갖고 있다.
//
// Unity 가 어셈블리에 심는 UnitySourceGeneratedAssemblyMonoScriptTypes_v1(MonoScriptData) 도
// 같은 정보를 갖고 있지만 **문서화되지 않은 내부 포맷**이라 채택하지 않았다. PDB 는 공개 스펙이다.

const fs = require('fs');
const path = require('path');
const clr = require('./clrmeta');

// TypeDef.Flags
const TYPE_VISIBILITY_MASK = 0x7;
const TYPE_PUBLIC = 0x1;
const TYPE_INTERFACE = 0x20;
const TYPE_ABSTRACT = 0x80;
const TYPE_SEALED = 0x100;

// Field.Flags
const FIELD_ACCESS_MASK = 0x7;
const FIELD_PUBLIC = 0x6;
const FIELD_STATIC = 0x10;
const FIELD_NOT_SERIALIZED = 0x80;

// MethodDef.Flags
const METHOD_ACCESS_MASK = 0x7;
const METHOD_PUBLIC = 0x6;
const METHOD_STATIC = 0x10;
const METHOD_VIRTUAL = 0x40;
const METHOD_ABSTRACT = 0x400;

/** TypeDefOrRef 코드화 인덱스를 풀어 표시용 타입 이름을 만든다. */
function resolveTypeDefOrRef(md, coded) {
  if (!coded) return null;
  const tag = coded & 0x3;
  const row = coded >> 2;
  if (!row) return null;

  if (tag === 0) {           // TypeDef — 같은 어셈블리 안
    const ns = md.getString(md.readCol(0x02, row, 2));
    const nm = md.getString(md.readCol(0x02, row, 1));
    return ns ? `${ns}.${nm}` : nm;
  }
  if (tag === 1) {           // TypeRef — 외부 어셈블리
    const ns = md.getString(md.readCol(0x01, row, 2));
    const nm = md.getString(md.readCol(0x01, row, 1));
    return ns ? `${ns}.${nm}` : nm;
  }
  return '(TypeSpec)';       // 제네릭 인스턴스 등 — 서명 디코딩이 필요하므로 지금은 표시만
}

/** TypeDef 의 FieldList/MethodList 는 범위다. 다음 행의 시작 - 1 이 끝. */
function listRange(md, tableId, row, colIndex, targetTableId) {
  const start = md.readCol(tableId, row, colIndex);
  const rows = md.rows(tableId);
  const end = row < rows ? md.readCol(tableId, row + 1, colIndex) - 1 : md.rows(targetTableId);
  return { start, end };
}

/** 절대 소스 경로를 프로젝트 상대 경로로. 프로젝트 밖이면 null. */
function toProjectRelative(root, absPath) {
  const a = absPath.replace(/\\/g, '/');
  const r = root.replace(/\\/g, '/').replace(/\/+$/, '');
  if (!a.toLowerCase().startsWith(r.toLowerCase() + '/')) return null;
  return a.slice(r.length + 1);
}

/** Portable PDB → MethodDef 행 번호 → 소스 문서 경로(절대). */
function readPdbMethodDocuments(pdbPath) {
  const md = clr.open(pdbPath);
  if (!md.isPdb) return null;

  // Document 이름은 [separator 바이트][압축 blob 인덱스]* 이고, 각 조각을 separator 로 잇는다.
  const docNames = new Map();
  for (let r = 1; r <= md.rows(0x30); r++) {
    const b = md.getBlob(md.readCol(0x30, r, 0));
    if (!b.length) { docNames.set(r, ''); continue; }
    const sep = b[0] ? String.fromCharCode(b[0]) : '';
    const parts = [];
    // 압축정수 인라인 디코딩 — readCompressed 는 파일 버퍼용이라 blob 조각에는 쓸 수 없다.
    let p = 1;
    while (p < b.length) {
      const b0 = b[p];
      let v, n;
      if ((b0 & 0x80) === 0) { v = b0; n = 1; }
      else if ((b0 & 0x40) === 0) { v = ((b0 & 0x3f) << 8) | b[p + 1]; n = 2; }
      else { v = ((b0 & 0x1f) << 24) | (b[p + 1] << 16) | (b[p + 2] << 8) | b[p + 3]; n = 4; }
      p += n;
      parts.push(v ? md.getBlob(v).toString('utf8') : '');
    }
    docNames.set(r, parts.join(sep));
  }

  // MethodDebugInformation 의 행 N 은 MethodDef 의 행 N 과 1:1 대응한다.
  const methodDoc = new Map();
  for (let r = 1; r <= md.rows(0x31); r++) {
    const docRow = md.readCol(0x31, r, 0);
    if (docRow) methodDoc.set(r, docNames.get(docRow) || '');
  }
  return methodDoc;
}

// 메서드에 붙은 속성을 읽는다 — "호출자 0" 의 뜻을 바꾸는 정보다.
//
// `[MenuItem]`, `[RuntimeInitializeOnLoadMethod]`, `[Test]` 가 붙은 메서드는 **코드 호출자가
// 0 인 것이 정상**이다. 에디터나 테스트 러너가 부르기 때문이다. 그걸 모르면 호출 그래프의
// 0 이 "죽은 코드" 로 읽힌다. 실측(MainProject): MenuItem 87 / ContextMenu 19 /
// RuntimeInitializeOnLoadMethod 6 — 112개 지점이 이 상태다.
//
// 어떤 속성이 "진입점" 인지는 원리적으로 알 수 없다(프레임워크마다 다르다).
// 그래서 판정하지 않고 **붙어 있는 속성을 그대로 보고한다.** 판단은 읽는 쪽이 한다.
// 다만 컴파일러가 자동으로 다는 표식은 신호가 아니라 잡음이라 뺀다.
const NOISE_ATTRIBUTE_RE = /^(System\.Runtime\.CompilerServices\.|System\.Diagnostics\.|System\.Reflection\.)/;

/** MethodDef 행 번호 -> 그 메서드에 붙은 속성 타입 이름들. */
function readMethodAttributes(md) {
  const byMethodRow = new Map();
  const rows = md.rows(0x0C);
  if (!rows) return byMethodRow;

  for (let r = 1; r <= rows; r++) {
    // Parent: HasCustomAttribute 코드화 인덱스(5비트 태그). 태그 0 = MethodDef.
    const parent = md.readCol(0x0C, r, 0);
    if ((parent & 0x1F) !== 0) continue;
    const methodRow = parent >>> 5;
    if (!methodRow) continue;

    // Type: CustomAttributeType(3비트). 2 = MethodDef(같은 어셈블리), 3 = MemberRef(외부).
    const type = md.readCol(0x0C, r, 1);
    const tag = type & 0x7;
    const row = type >>> 3;
    let name = null;

    if (tag === 3 && row) {
      // MemberRef.Class -> MemberRefParent(3비트). 1 = TypeRef.
      const cls = md.readCol(0x0A, row, 0);
      if ((cls & 0x7) === 1) {
        const cr = cls >>> 3;
        const ns = md.getString(md.readCol(0x01, cr, 2));
        const nm = md.getString(md.readCol(0x01, cr, 1));
        name = ns ? `${ns}.${nm}` : nm;
      }
    }
    // `[Conditional]` 은 Diagnostics 소음 필터에 걸리지만 예외로 남긴다.
    // 이 속성이 붙은 메서드의 **호출은 해당 심볼이 없는 빌드에서 컴파일 단계에 사라진다.**
    // 실측(2026-08-26, 독립 감사에서 지적): `Edit.cs` 는 `[Conditional("UNITY_EDITOR")]`
    // 로그 래퍼인데 호출자 지표에서 프로젝트 1위(파일 단위 유입 49개)로 나온다.
    // 즉 중심성 최상위가 빌드에는 호출이 남지 않는 타입이다. 그 사실을 설명할 증거를
    // 필터가 버리고 있었다 — 이름만이라도 남겨야 응답이 그걸 말할 수 있다.
    // (속성 인자 — 어느 심볼인지 — 는 아직 디코딩하지 않는다. 블롭 파싱은 별건이다.)
    const keepAnyway = name === 'System.Diagnostics.ConditionalAttribute';
    if (!name || (!keepAnyway && NOISE_ATTRIBUTE_RE.test(name))) continue;

    let list = byMethodRow.get(methodRow);
    if (!list) byMethodRow.set(methodRow, list = []);
    if (!list.includes(name)) list.push(name);
  }
  return byMethodRow;
}

/**
 * 어셈블리 하나를 읽어 타입/멤버와 소스 매핑을 만든다.
 */
function readAssembly(root, dllPath) {
  const md = clr.open(dllPath);

  const asmName = md.rows(0x20) ? md.getString(md.readCol(0x20, 1, 7)) : path.basename(dllPath, '.dll');

  // PDB 는 있으면 쓴다. 없으면 소스 매핑 없이 타입 정보만 얻는다.
  let methodDoc = null;
  const pdbPath = dllPath.slice(0, -4) + '.pdb';
  if (fs.existsSync(pdbPath)) {
    try { methodDoc = readPdbMethodDocuments(pdbPath); }
    catch (e) { methodDoc = null; }
  }

  const methodAttrs = readMethodAttributes(md);

  const types = [];
  const typeRows = md.rows(0x02);

  for (let r = 1; r <= typeRows; r++) {
    const flags = md.readCol(0x02, r, 0);
    const name = md.getString(md.readCol(0x02, r, 1));
    const ns = md.getString(md.readCol(0x02, r, 2));
    if (name === '<Module>') continue;

    const fullName = ns ? `${ns}.${name}` : name;
    const baseType = resolveTypeDefOrRef(md, md.readCol(0x02, r, 3));

    const fieldRange = listRange(md, 0x02, r, 4, 0x04);
    const methodRange = listRange(md, 0x02, r, 5, 0x06);

    const fields = [];
    for (let f = fieldRange.start; f <= fieldRange.end && f >= 1; f++) {
      const ff = md.readCol(0x04, f, 0);
      fields.push({
        name: md.getString(md.readCol(0x04, f, 1)),
        isPublic: (ff & FIELD_ACCESS_MASK) === FIELD_PUBLIC,
        isStatic: !!(ff & FIELD_STATIC),
        notSerialized: !!(ff & FIELD_NOT_SERIALIZED),
      });
    }

    const methods = [];
    const docs = new Set();
    for (let mi = methodRange.start; mi <= methodRange.end && mi >= 1; mi++) {
      const mf = md.readCol(0x06, mi, 2);
      const attrs = methodAttrs.get(mi);
      methods.push({
        name: md.getString(md.readCol(0x06, mi, 3)),
        isPublic: (mf & METHOD_ACCESS_MASK) === METHOD_PUBLIC,
        isStatic: !!(mf & METHOD_STATIC),
        isVirtual: !!(mf & METHOD_VIRTUAL),
        isAbstract: !!(mf & METHOD_ABSTRACT),
        // 속성은 있을 때만 싣는다(대부분의 메서드에는 없다).
        ...(attrs && attrs.length ? { attributes: attrs } : {}),
        row: mi,
      });
      if (methodDoc) {
        const d = methodDoc.get(mi);
        if (d) docs.add(d);
      }
    }

    // 타입이 선언된 소스 파일 — 메서드들의 문서 중 프로젝트 안에 있는 것.
    const sourceFiles = [];
    for (const d of docs) {
      const relPath = toProjectRelative(root, d);
      if (relPath) sourceFiles.push(relPath);
    }
    sourceFiles.sort();

    types.push({
      fullName, name, namespace: ns, assembly: asmName,
      baseType,
      isPublic: (flags & TYPE_VISIBILITY_MASK) === TYPE_PUBLIC,
      isInterface: !!(flags & TYPE_INTERFACE),
      isAbstract: !!(flags & TYPE_ABSTRACT),
      isSealed: !!(flags & TYPE_SEALED),
      fields, methods,
      sourceFiles,
    });
  }

  return { assembly: asmName, dll: path.basename(dllPath), hasPdb: !!methodDoc, types };
}

/**
 * Library/ScriptAssemblies 전체를 읽어 심볼 인덱스를 만든다.
 *
 * 사용자 어셈블리만 고른다. 이름 휴리스틱이 아니라 **PDB 문서 경로가 프로젝트 안을 가리키는지**로
 * 판정한다 — Unity 자체 패키지 어셈블리는 소스가 프로젝트 밖(PackageCache)에 있다.
 */
function buildSymbolIndex(root, opts = {}) {
  const t0 = Date.now();
  const dir = path.join(root, 'Library', 'ScriptAssemblies');

  let files = [];
  try {
    files = fs.readdirSync(dir).filter(f => f.endsWith('.dll')).map(f => path.join(dir, f));
  } catch (e) {
    return { error: `Cannot read ${dir}: ${e.message}` };
  }

  const typeByFullName = new Map();     // 전체 이름 -> 타입
  const duplicateTypes = [];            // 전체 이름이 겹쳐 첫 것에 밀린 타입들(아래 주석 참조)
  const typesByShortName = new Map();  // 짧은 이름 -> [타입...]
  const typesBySourceFile = new Map(); // 프로젝트 상대 .cs 경로 -> [타입...]
  const assemblies = [];
  const failed = [];
  let userAssemblies = 0;
  let typeCount = 0;

  for (const dll of files) {
    let a;
    try { a = readAssembly(root, dll); }
    catch (e) { failed.push({ dll: path.basename(dll), error: e.message }); continue; }

    // 프로젝트 안 소스를 가진 타입이 하나라도 있으면 사용자 어셈블리로 본다.
    const inProject = a.types.some(t => t.sourceFiles.length > 0);
    assemblies.push({
      assembly: a.assembly, dll: a.dll, hasPdb: a.hasPdb,
      typeCount: a.types.length, isUserAssembly: inProject,
    });
    if (!inProject && !opts.includeAllAssemblies) continue;

    userAssemblies++;
    for (const t of a.types) {
      typeCount++;
      if (!typeByFullName.has(t.fullName)) typeByFullName.set(t.fullName, t);
      // 같은 전체 이름이 어셈블리를 넘어 또 나오면 첫 것만 남는다(위 줄). 그 사실을 버리지 않는다 —
      // 짧은 이름 유일성 판정이 그것에 걸려 있다. 실측(MainProject): 1,169개 중 123개가 여기 걸리고,
      // 대부분 컴파일러 생성이지만 `Segment`/`PassData`/`EffectState`/`Tab` 처럼 실제 타입도 있다.
      // 캐시가 이걸 잃으면 모든 짧은 이름이 유일해 보이고, 그 유일성에 기대는 두 곳
      // (`resolveScriptType` 의 파일명 폴백, 영향 분석의 대상 해석)이 조용히 하나를 골라 답한다.
      else duplicateTypes.push(t);

      let shortList = typesByShortName.get(t.name);
      if (!shortList) typesByShortName.set(t.name, shortList = []);
      shortList.push(t.fullName);

      for (const sf of t.sourceFiles) {
        let list = typesBySourceFile.get(sf);
        if (!list) typesBySourceFile.set(sf, list = []);
        if (!list.includes(t.fullName)) list.push(t.fullName);
      }
    }
  }

  return {
    typeByFullName, typesByShortName, typesBySourceFile, assemblies, duplicateTypes,
    stats: {
      dllFiles: files.length,
      userAssemblies,
      types: typeCount,
      sourceFilesMapped: typesBySourceFile.size,
      failedAssemblies: failed.length,
      msTotal: Date.now() - t0,
    },
    failed,
  };
}

module.exports = { buildSymbolIndex, readAssembly, readPdbMethodDocuments };
