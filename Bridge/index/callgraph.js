'use strict';
// 레이어 B-2: IL 본문을 디코딩해 호출 그래프를 만든다.
//
// 왜 필요한가 — §2-1 정정의 핵심이다. grep 은 `TakeDamage` 라는 **문자열의 위치**를 주고,
// 호출 그래프는 **실제로 그 메서드를 호출하는 심볼**을 준다. "이 함수 이름을 안전하게
// 바꿀 수 있나?" 에 답할 수 있는 것은 후자뿐이다.
// 컴파일 결과(IL)를 읽으므로 소스 재파싱보다 정확하다 — NarshaADK 가 PDB 를 쓰는 것과 같은 이유다.
//
// 정직한 한계 (아래 stats 에 그대로 보고한다)
//   - 오버로드를 구분하지 않는다. 키가 Type::Method 이므로 TakeDamage(int) 와
//     TakeDamage(float) 가 합쳐진다. "이 이름을 바꿀 수 있나"에는 충분하지만
//     시그니처 단위 정밀도가 필요하면 Phase 2c 에서 서명 디코딩이 필요하다.
//   - 사용자 어셈블리 안의 타입을 대상으로 한 호출만 기록한다. UnityEngine/BCL 호출까지
//     담으면 그래프가 폭발하고 정작 필요한 프로젝트 내부 관계가 묻힌다.
//   - 알 수 없는 옵코드를 만나면 **그 메서드 본문 디코딩을 중단**하고 실패로 센다.
//     잘못된 오프셋으로 계속 읽으면 조용히 거짓 호출을 만들어낸다. 그게 더 나쁘다.

const path = require('path');
const clr = require('./clrmeta');

// ── 단일 바이트 옵코드의 오퍼랜드 크기. 없는 값은 '미지'로 취급해 중단한다.
// -1 은 switch(4 + 4*n) 처리.
const OP1 = new Int8Array(256).fill(-2);   // -2 = 미지
(function () {
  const set = (list, size) => { for (const c of list) OP1[c] = size; };
  const range = (a, b, size) => { for (let c = a; c <= b; c++) OP1[c] = size; };

  range(0x00, 0x0D, 0);                     // nop..stloc.3 (0x0E 부터 오퍼랜드 있음)
  range(0x0E, 0x13, 1);                     // ldarg.s..stloc.s
  OP1[0x14] = 0;                            // ldnull
  range(0x15, 0x1E, 0);                     // ldc.i4.m1..ldc.i4.8
  OP1[0x1F] = 1;                            // ldc.i4.s
  OP1[0x20] = 4;                            // ldc.i4
  OP1[0x21] = 8;                            // ldc.i8
  OP1[0x22] = 4;                            // ldc.r4
  OP1[0x23] = 8;                            // ldc.r8
  set([0x25, 0x26], 0);                     // dup, pop
  set([0x27, 0x28, 0x29], 4);               // jmp, call, calli
  OP1[0x2A] = 0;                            // ret
  range(0x2B, 0x37, 1);                     // br.s..ble.un.s
  range(0x38, 0x44, 4);                     // br..ble.un
  OP1[0x45] = -1;                           // switch
  range(0x46, 0x6E, 0);                     // ldind..conv.*  (산술/변환 계열)
  OP1[0x6F] = 4;                            // callvirt
  range(0x70, 0x75, 4);                     // cpobj, ldobj, ldstr, newobj, castclass, isinst
  set([0x76], 0);                           // conv.r.un
  OP1[0x79] = 4;                            // unbox
  OP1[0x7A] = 0;                            // throw
  range(0x7B, 0x81, 4);                     // ldfld..stobj
  range(0x82, 0x8B, 0);                     // conv.ovf.*
  OP1[0x8C] = 4;                            // box
  OP1[0x8D] = 4;                            // newarr
  OP1[0x8E] = 0;                            // ldlen
  OP1[0x8F] = 4;                            // ldelema
  range(0x90, 0x9A, 0);                     // ldelem.*
  range(0x9B, 0xA2, 0);                     // stelem.*
  set([0xA3, 0xA4, 0xA5], 4);               // ldelem, stelem, unbox.any
  range(0xB3, 0xBA, 0);                     // conv.ovf.* (2차)
  OP1[0xC2] = 4;                            // refanyval
  OP1[0xC3] = 0;                            // ckfinite
  OP1[0xC6] = 4;                            // mkrefany
  OP1[0xD0] = 4;                            // ldtoken
  range(0xD1, 0xDA, 0);                     // conv.*, add.ovf..
  OP1[0xDB] = 0;                            // (예약)
  OP1[0xDC] = 0;                            // endfinally
  OP1[0xDD] = 4;                            // leave
  OP1[0xDE] = 1;                            // leave.s
  OP1[0xDF] = 0;                            // stind.i
  OP1[0xE0] = 0;                            // conv.u
})();

// ── 0xFE 접두 2바이트 옵코드
const OP2 = new Int8Array(256).fill(-2);
(function () {
  const range = (a, b, size) => { for (let c = a; c <= b; c++) OP2[c] = size; };
  range(0x00, 0x05, 0);                     // arglist, ceq, cgt, cgt.un, clt, clt.un
  OP2[0x06] = 4;                            // ldftn
  OP2[0x07] = 4;                            // ldvirtftn
  range(0x09, 0x0E, 2);                     // ldarg, ldarga, starg, ldloc, ldloca, stloc
  OP2[0x0F] = 0;                            // localloc
  OP2[0x11] = 0;                            // endfilter
  OP2[0x12] = 1;                            // unaligned.
  range(0x13, 0x14, 0);                     // volatile., tail.
  OP2[0x15] = 4;                            // initobj
  OP2[0x16] = 4;                            // constrained.
  range(0x17, 0x18, 0);                     // cpblk, initblk
  OP2[0x19] = 1;                            // no.
  OP2[0x1A] = 0;                            // rethrow
  OP2[0x1C] = 4;                            // sizeof
  range(0x1D, 0x1E, 0);                     // refanytype, readonly.
})();

// 호출을 만드는 옵코드
const CALL_OPS_1 = new Set([0x27 /*jmp*/, 0x28 /*call*/, 0x6F /*callvirt*/, 0x73 /*newobj*/]);
const CALL_OPS_2 = new Set([0x06 /*ldftn*/, 0x07 /*ldvirtftn*/]);

/** 메서드 본문의 IL 시작 오프셋과 길이. tiny/fat 두 포맷. */
function methodBody(md, rva) {
  if (!rva) return null;
  const off = md.rvaToOffset(rva);
  if (off < 0) return null;
  const b0 = md.buf[off];
  if ((b0 & 3) === 2) {
    return { ilStart: off + 1, codeSize: b0 >> 2 };            // tiny
  }
  if ((b0 & 3) === 3) {
    const codeSize = md.buf.readUInt32LE(off + 4);
    const headerSize = (md.buf.readUInt16LE(off) >> 12) * 4;   // 보통 12
    return { ilStart: off + headerSize, codeSize };            // fat
  }
  return null;
}

/** 메타데이터 토큰 → { table, row } */
function token(t) { return { table: (t >>> 24) & 0xFF, row: t & 0xFFFFFF }; }

/**
 * 호출 대상 토큰을 "Type::Method" 로 해석한다.
 * 해석 불가(외부 어셈블리 등)면 null.
 */
function resolveCallTarget(md, tok, typeOfMethodRow) {
  const { table, row } = token(tok);
  if (!row) return null;

  if (table === 0x06) {                     // MethodDef — 같은 어셈블리
    const name = md.getString(md.readCol(0x06, row, 3));
    const typeFull = typeOfMethodRow.get(row) || null;
    return typeFull ? { type: typeFull, method: name, kind: 'internal' } : null;
  }

  if (table === 0x0A) {                     // MemberRef — 다른 어셈블리 또는 TypeRef
    const parent = md.readCol(0x0A, row, 0);
    const name = md.getString(md.readCol(0x0A, row, 1));
    const tag = parent & 0x7;
    const prow = parent >>> 3;
    if (tag === 1) {                        // TypeRef
      const ns = md.getString(md.readCol(0x01, prow, 2));
      const nm = md.getString(md.readCol(0x01, prow, 1));
      return { type: ns ? `${ns}.${nm}` : nm, method: name, kind: 'external' };
    }
    if (tag === 0) {                        // TypeDef
      const ns = md.getString(md.readCol(0x02, prow, 2));
      const nm = md.getString(md.readCol(0x02, prow, 1));
      return { type: ns ? `${ns}.${nm}` : nm, method: name, kind: 'internal' };
    }
    return null;                            // ModuleRef/MethodDef/TypeSpec 부모는 지금 다루지 않는다
  }

  if (table === 0x2B) {                     // MethodSpec — 제네릭 인스턴스
    const inner = md.readCol(0x2B, row, 0);
    const tag = inner & 0x1;
    const irow = inner >>> 1;
    return resolveCallTarget(md, ((tag === 0 ? 0x06 : 0x0A) << 24) | irow, typeOfMethodRow);
  }

  return null;
}

/**
 * 어셈블리 하나의 호출 엣지를 뽑는다.
 * @param {Set<string>} knownTypes 사용자 어셈블리에 있는 타입 전체 이름 집합 (필터)
 */
function extractCalls(dllPath, knownTypes) {
  const md = clr.open(dllPath);

  // MethodDef 행 → 소속 타입 전체 이름
  const typeOfMethodRow = new Map();
  const typeRows = md.rows(0x02);
  for (let r = 1; r <= typeRows; r++) {
    const ns = md.getString(md.readCol(0x02, r, 2));
    const nm = md.getString(md.readCol(0x02, r, 1));
    const full = ns ? `${ns}.${nm}` : nm;
    const start = md.readCol(0x02, r, 5);
    const end = r < typeRows ? md.readCol(0x02, r + 1, 5) - 1 : md.rows(0x06);
    for (let m = start; m <= end && m >= 1; m++) typeOfMethodRow.set(m, full);
  }

  const edges = [];
  let decoded = 0, failed = 0, bodiless = 0;

  for (let m = 1; m <= md.rows(0x06); m++) {
    const rva = md.readCol(0x06, m, 0);
    const body = methodBody(md, rva);
    if (!body) { bodiless++; continue; }

    const callerType = typeOfMethodRow.get(m);
    const callerName = md.getString(md.readCol(0x06, m, 3));
    if (!callerType) continue;

    let p = body.ilStart;
    const end = body.ilStart + body.codeSize;
    let broke = false;

    while (p < end) {
      const b = md.buf[p];
      let opSize, isCall, callTokenAt;

      if (b === 0xFE) {
        const b2 = md.buf[p + 1];
        opSize = OP2[b2];
        if (opSize === -2) { broke = true; break; }
        isCall = CALL_OPS_2.has(b2);
        callTokenAt = p + 2;
        p += 2 + opSize;
      } else {
        opSize = OP1[b];
        if (opSize === -2) { broke = true; break; }
        if (opSize === -1) {                       // switch
          const n = md.buf.readUInt32LE(p + 1);
          p += 1 + 4 + 4 * n;
          continue;
        }
        isCall = CALL_OPS_1.has(b);
        callTokenAt = p + 1;
        p += 1 + opSize;
      }

      if (isCall) {
        const tok = md.buf.readUInt32LE(callTokenAt);
        const target = resolveCallTarget(md, tok, typeOfMethodRow);
        // 사용자 어셈블리 안의 타입만 남긴다 — UnityEngine/BCL 까지 담으면 그래프가 폭발한다.
        if (target && knownTypes.has(target.type)) {
          edges.push({
            fromType: callerType, fromMethod: callerName,
            toType: target.type, toMethod: target.method,
          });
        }
      }
    }

    if (broke) failed++; else decoded++;
  }

  return { edges, decoded, failed, bodiless, assembly: path.basename(dllPath, '.dll') };
}

/**
 * 사용자 어셈블리 전체의 호출 그래프.
 * @param {object} symbolIndex symbols.buildSymbolIndex 결과
 */
function buildCallGraph(root, symbolIndex) {
  const t0 = Date.now();
  const dir = path.join(root, 'Library', 'ScriptAssemblies');

  const knownTypes = new Set(symbolIndex.typeByFullName.keys());
  const userAsm = symbolIndex.assemblies.filter(a => a.isUserAssembly);

  const callsFrom = new Map();     // "Type::Method" -> Set("Type::Method")
  const callersOf = new Map();
  let decoded = 0, failed = 0, bodiless = 0, edgeCount = 0;
  const perAssembly = [];

  for (const a of userAsm) {
    const dll = path.join(dir, a.dll);
    let r;
    try { r = extractCalls(dll, knownTypes); }
    catch (e) { perAssembly.push({ assembly: a.assembly, error: e.message }); continue; }

    decoded += r.decoded; failed += r.failed; bodiless += r.bodiless;
    for (const e of r.edges) {
      const from = `${e.fromType}::${e.fromMethod}`;
      const to = `${e.toType}::${e.toMethod}`;
      if (from === to) continue;                       // 자기 재귀는 그래프에서 의미가 적다

      let f = callsFrom.get(from);
      if (!f) callsFrom.set(from, f = new Set());
      if (!f.has(to)) { f.add(to); edgeCount++; }

      let c = callersOf.get(to);
      if (!c) callersOf.set(to, c = new Set());
      c.add(from);
    }
    perAssembly.push({ assembly: a.assembly, decoded: r.decoded, failed: r.failed, edges: r.edges.length });
  }

  return {
    callsFrom, callersOf, perAssembly,
    stats: {
      assemblies: userAsm.length,
      methodsDecoded: decoded,
      methodsFailed: failed,
      methodsWithoutBody: bodiless,
      edges: edgeCount,
      callees: callsFrom.size,
      callTargets: callersOf.size,
      msTotal: Date.now() - t0,
    },
  };
}

module.exports = { buildCallGraph, extractCalls };
