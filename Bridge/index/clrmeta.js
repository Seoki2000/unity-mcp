'use strict';
// ECMA-335 메타데이터 리더 (레이어 B의 기반).
//
// 왜 직접 읽는가
//   - Mono.Cecil 은 Unity 설치본의 il2cpp/build/deploy 와 MonoBleedingEdge 내부 경로에만 있다.
//     지원되는 참조 경로가 아니라 Unity 버전이 바뀌면 깨진다.
//   - Phase 1.5 에서 인덱스를 아웃프로세스(브릿지)로 정했다. 의존성 0 을 유지한다.
//   - Unity 가 내는 PDB 는 **Portable PDB** 이고(시그니처 'BSJB' 확인) DLL 메타데이터와
//     같은 컨테이너 포맷이다. 리더 하나로 둘 다 읽는다 — 심볼과 "소스 파일 ↔ 타입" 매핑을 함께 얻는다.
//
// 이 파일은 컨테이너/테이블 파싱만 담당한다. 의미 해석은 symbols.js 가 한다.

const fs = require('fs');

// ── 힙 인덱스 크기 비트 (테이블 스트림 헤더의 HeapSizes)
const HEAP_STRING = 0x01;
const HEAP_GUID = 0x02;
const HEAP_BLOB = 0x04;

// ── 코드화 인덱스 정의: [후보 테이블 목록, 태그 비트 수]
// 후보 중 하나라도 행 수가 커지면 인덱스가 4바이트가 된다.
const CODED = {
  TypeDefOrRef:        [[0x02, 0x01, 0x1B], 2],
  HasConstant:         [[0x04, 0x08, 0x17], 2],
  HasCustomAttribute:  [[0x06,0x04,0x01,0x02,0x08,0x09,0x0A,0x00,0x1A,0x1B,0x14,0x17,0x15,0x16,0x18,0x19,0x1C,0x20,0x23,0x26,0x27,0x28,0x2A,0x2C], 5],
  HasFieldMarshall:    [[0x04, 0x08], 1],
  HasDeclSecurity:     [[0x02, 0x06, 0x20], 2],
  MemberRefParent:     [[0x02, 0x01, 0x1A, 0x06, 0x1B], 3],
  HasSemantics:        [[0x14, 0x17], 1],
  MethodDefOrRef:      [[0x06, 0x0A], 1],
  MemberForwarded:     [[0x04, 0x06], 1],
  Implementation:      [[0x26, 0x23, 0x27], 2],
  CustomAttributeType: [[0xFF, 0xFF, 0x06, 0x0A, 0xFF], 3],
  ResolutionScope:     [[0x00, 0x1A, 0x23, 0x01], 2],
  TypeOrMethodDef:     [[0x02, 0x06], 1],
  HasCustomDebugInformation: [[0x06,0x04,0x01,0x02,0x08,0x09,0x0A,0x00,0x1A,0x1B,0x14,0x17,0x15,0x16,0x18,0x19,0x1C,0x20,0x23,0x26,0x27,0x28,0x2A,0x2C,0x30,0x31,0x32,0x33,0x34,0x35], 5],
};

// ── 테이블 스키마. 행 크기를 계산해 관심 없는 테이블도 정확히 건너뛰기 위해 전부 필요하다.
// 표기: 숫자 = 고정 바이트, 'S'/'G'/'B' = String/Guid/Blob 힙, {t:id} = 단순 테이블 인덱스,
//       {c:'Name'} = 코드화 인덱스
const T = {
  0x00: ['Module',        [2, 'S', 'G', 'G', 'G']],
  0x01: ['TypeRef',       [{ c: 'ResolutionScope' }, 'S', 'S']],
  0x02: ['TypeDef',       [4, 'S', 'S', { c: 'TypeDefOrRef' }, { t: 0x04 }, { t: 0x06 }]],
  0x03: ['FieldPtr',      [{ t: 0x04 }]],
  0x04: ['Field',         [2, 'S', 'B']],
  0x05: ['MethodPtr',     [{ t: 0x06 }]],
  0x06: ['MethodDef',     [4, 2, 2, 'S', 'B', { t: 0x08 }]],
  0x07: ['ParamPtr',      [{ t: 0x08 }]],
  0x08: ['Param',         [2, 2, 'S']],
  0x09: ['InterfaceImpl', [{ t: 0x02 }, { c: 'TypeDefOrRef' }]],
  0x0A: ['MemberRef',     [{ c: 'MemberRefParent' }, 'S', 'B']],
  0x0B: ['Constant',      [2, { c: 'HasConstant' }, 'B']],
  0x0C: ['CustomAttribute',[{ c: 'HasCustomAttribute' }, { c: 'CustomAttributeType' }, 'B']],
  0x0D: ['FieldMarshal',  [{ c: 'HasFieldMarshall' }, 'B']],
  0x0E: ['DeclSecurity',  [2, { c: 'HasDeclSecurity' }, 'B']],
  0x0F: ['ClassLayout',   [2, 4, { t: 0x02 }]],
  0x10: ['FieldLayout',   [4, { t: 0x04 }]],
  0x11: ['StandAloneSig', ['B']],
  0x12: ['EventMap',      [{ t: 0x02 }, { t: 0x14 }]],
  0x13: ['EventPtr',      [{ t: 0x14 }]],
  0x14: ['Event',         [2, 'S', { c: 'TypeDefOrRef' }]],
  0x15: ['PropertyMap',   [{ t: 0x02 }, { t: 0x17 }]],
  0x16: ['PropertyPtr',   [{ t: 0x17 }]],
  0x17: ['Property',      [2, 'S', 'B']],
  0x18: ['MethodSemantics',[2, { t: 0x06 }, { c: 'HasSemantics' }]],
  0x19: ['MethodImpl',    [{ t: 0x02 }, { c: 'MethodDefOrRef' }, { c: 'MethodDefOrRef' }]],
  0x1A: ['ModuleRef',     ['S']],
  0x1B: ['TypeSpec',      ['B']],
  0x1C: ['ImplMap',       [2, { c: 'MemberForwarded' }, 'S', { t: 0x1A }]],
  0x1D: ['FieldRVA',      [4, { t: 0x04 }]],
  0x1E: ['EncLog',        [4, 4]],
  0x1F: ['EncMap',        [4]],
  0x20: ['Assembly',      [4, 2, 2, 2, 2, 4, 'B', 'S', 'S']],
  0x21: ['AssemblyProcessor', [4]],
  0x22: ['AssemblyOS',    [4, 4, 4]],
  0x23: ['AssemblyRef',   [2, 2, 2, 2, 4, 'B', 'S', 'S', 'B']],
  0x24: ['AssemblyRefProcessor', [4, { t: 0x23 }]],
  0x25: ['AssemblyRefOS', [4, 4, 4, { t: 0x23 }]],
  0x26: ['File',          [4, 'S', 'B']],
  0x27: ['ExportedType',  [4, 4, 'S', 'S', { c: 'Implementation' }]],
  0x28: ['ManifestResource', [4, 4, 'S', { c: 'Implementation' }]],
  0x29: ['NestedClass',   [{ t: 0x02 }, { t: 0x02 }]],
  0x2A: ['GenericParam',  [2, 2, { c: 'TypeOrMethodDef' }, 'S']],
  0x2B: ['MethodSpec',    [{ c: 'MethodDefOrRef' }, 'B']],
  0x2C: ['GenericParamConstraint', [{ t: 0x2A }, { c: 'TypeDefOrRef' }]],
  // ── Portable PDB 전용 테이블
  0x30: ['Document',      ['B', 'G', 'B', 'G']],
  0x31: ['MethodDebugInformation', [{ t: 0x30 }, 'B']],
  0x32: ['LocalScope',    [{ t: 0x06 }, { t: 0x34 }, { t: 0x33 }, { t: 0x35 }, 4, 4]],
  0x33: ['LocalVariable', [2, 2, 'S']],
  0x34: ['LocalConstant', ['S', 'B']],
  0x35: ['ImportScope',   [{ t: 0x35 }, 'B']],
  0x36: ['StateMachineMethod', [{ t: 0x06 }, { t: 0x06 }]],
  0x37: ['CustomDebugInformation', [{ c: 'HasCustomDebugInformation' }, 'G', 'B']],
};

/** RVA → 파일 오프셋. 섹션 헤더로 매핑한다. */
function rvaToOffset(sections, rva) {
  for (const s of sections) {
    if (rva >= s.virtualAddress && rva < s.virtualAddress + Math.max(s.virtualSize, s.rawSize)) {
      return s.rawOffset + (rva - s.virtualAddress);
    }
  }
  return -1;
}

/** PE 파일에서 메타데이터 루트 오프셋을 찾는다. PDB 는 파일 시작이 곧 메타데이터 루트다. */
function findMetadataRoot(buf) {
  // PDB / 순수 메타데이터: 바로 BSJB
  if (buf.length >= 4 && buf.readUInt32LE(0) === 0x424A5342) {
    return { metaOffset: 0, sections: [] };
  }

  if (buf.length < 0x40 || buf.readUInt16LE(0) !== 0x5A4D) {
    throw new Error('Not a PE file and not a metadata blob (no MZ, no BSJB)');
  }
  const peOff = buf.readUInt32LE(0x3C);
  if (buf.readUInt32LE(peOff) !== 0x00004550) throw new Error('Bad PE signature');

  const coff = peOff + 4;
  const numSections = buf.readUInt16LE(coff + 2);
  const optSize = buf.readUInt16LE(coff + 16);
  const optOff = coff + 20;
  const magic = buf.readUInt16LE(optOff);
  const pe32Plus = magic === 0x20B;

  // 데이터 디렉터리 시작: PE32 는 optOff+96, PE32+ 는 optOff+112
  const dataDirOff = optOff + (pe32Plus ? 112 : 96);
  const cliRva = buf.readUInt32LE(dataDirOff + 14 * 8);       // index 14 = CLI header
  if (!cliRva) throw new Error('No CLI header (not a managed assembly)');

  const secOff = optOff + optSize;
  const sections = [];
  for (let i = 0; i < numSections; i++) {
    const o = secOff + i * 40;
    sections.push({
      name: buf.slice(o, o + 8).toString('latin1').replace(/\0+$/, ''),
      virtualSize: buf.readUInt32LE(o + 8),
      virtualAddress: buf.readUInt32LE(o + 12),
      rawSize: buf.readUInt32LE(o + 16),
      rawOffset: buf.readUInt32LE(o + 20),
    });
  }

  const cliOff = rvaToOffset(sections, cliRva);
  if (cliOff < 0) throw new Error('CLI header RVA not mapped');
  const metaRva = buf.readUInt32LE(cliOff + 8);
  const metaOffset = rvaToOffset(sections, metaRva);
  if (metaOffset < 0) throw new Error('Metadata RVA not mapped');
  return { metaOffset, sections };
}

/** 메타데이터 루트를 파싱해 스트림 목록을 얻는다. */
function readStreams(buf, metaOffset) {
  if (buf.readUInt32LE(metaOffset) !== 0x424A5342) throw new Error('Bad metadata signature');
  const versionLength = buf.readUInt32LE(metaOffset + 12);
  let p = metaOffset + 16 + versionLength;
  p += 2;                                   // Flags
  const streamCount = buf.readUInt16LE(p); p += 2;

  const streams = {};
  for (let i = 0; i < streamCount; i++) {
    const offset = buf.readUInt32LE(p); p += 4;
    const size = buf.readUInt32LE(p); p += 4;
    let end = p;
    while (buf[end] !== 0) end++;
    const name = buf.slice(p, end).toString('latin1');
    p = end + 1;
    p = p + ((4 - ((p - metaOffset) % 4)) % 4);   // 4바이트 정렬
    streams[name] = { offset: metaOffset + offset, size };
  }
  return streams;
}

/**
 * 어셈블리(또는 Portable PDB)를 열어 테이블/힙 접근자를 돌려준다.
 */
function open(filePath) {
  const buf = fs.readFileSync(filePath);
  const { metaOffset, sections } = findMetadataRoot(buf);
  const streams = readStreams(buf, metaOffset);

  const tableStream = streams['#~'] || streams['#-'];
  if (!tableStream) throw new Error('No table stream (#~)');

  const strings = streams['#Strings'];
  const blobs = streams['#Blob'];
  const guids = streams['#GUID'];

  let p = tableStream.offset;
  p += 4;                                   // Reserved
  p += 2;                                   // Major/Minor version
  const heapSizes = buf[p]; p += 1;
  p += 1;                                   // Reserved
  const valid = buf.readBigUInt64LE(p); p += 8;
  const sorted = buf.readBigUInt64LE(p); p += 8;

  // Portable PDB 의 #Pdb 스트림에는 참조 테이블 행 수가 들어 있다(TypeSystem 테이블 크기).
  // 우리는 PDB 에서 Document/MethodDebugInformation 만 쓰므로, MethodDef 인덱스 폭을
  // 정확히 잡기 위해 이 값을 읽는다.
  let externalRowCounts = null;
  if (streams['#Pdb']) {
    const pdbOff = streams['#Pdb'].offset;
    // PdbId(20) + EntryPoint(4) + ReferencedTypeSystemTables(8) + TypeSystemTableRows(가변)
    const refTables = buf.readBigUInt64LE(pdbOff + 24);
    externalRowCounts = {};
    let q = pdbOff + 32;
    for (let i = 0; i < 64; i++) {
      if ((refTables >> BigInt(i)) & 1n) {
        externalRowCounts[i] = buf.readUInt32LE(q);
        q += 4;
      }
    }
  }

  const rowCount = {};
  for (let i = 0; i < 64; i++) {
    if ((valid >> BigInt(i)) & 1n) {
      rowCount[i] = buf.readUInt32LE(p);
      p += 4;
    }
  }
  // 이 파일에 없는 테이블의 행 수는 외부(PDB의 경우 원본 어셈블리) 값을 쓴다.
  const rowsOf = (id) => rowCount[id] || (externalRowCounts && externalRowCounts[id]) || 0;

  const stringIndexSize = (heapSizes & HEAP_STRING) ? 4 : 2;
  const guidIndexSize = (heapSizes & HEAP_GUID) ? 4 : 2;
  const blobIndexSize = (heapSizes & HEAP_BLOB) ? 4 : 2;

  function tableIndexSize(id) { return rowsOf(id) < 65536 ? 2 : 4; }

  function codedIndexSize(name) {
    const [tables, bits] = CODED[name];
    const max = 1 << (16 - bits);
    for (const t of tables) {
      if (t === 0xFF) continue;
      if (rowsOf(t) >= max) return 4;
    }
    return 2;
  }

  function colSize(col) {
    if (typeof col === 'number') return col;
    if (col === 'S') return stringIndexSize;
    if (col === 'G') return guidIndexSize;
    if (col === 'B') return blobIndexSize;
    if (col.t !== undefined) return tableIndexSize(col.t);
    if (col.c !== undefined) return codedIndexSize(col.c);
    throw new Error('Unknown column ' + JSON.stringify(col));
  }

  // 각 테이블의 시작 오프셋과 행 크기를 미리 계산한다.
  const layout = {};
  let cursor = p;
  for (let id = 0; id < 64; id++) {
    if (!rowCount[id]) continue;
    const def = T[id];
    if (!def) throw new Error(`Unknown metadata table 0x${id.toString(16)}`);
    const cols = def[1];
    const offsets = [];
    let rowSize = 0;
    for (const c of cols) { offsets.push(rowSize); rowSize += colSize(c); }
    layout[id] = { name: def[0], cols, offsets, rowSize, start: cursor, rows: rowCount[id] };
    cursor += rowSize * rowCount[id];
  }

  function readCol(id, row, colIndex) {
    const L = layout[id];
    if (!L || row < 1 || row > L.rows) return 0;
    const off = L.start + (row - 1) * L.rowSize + L.offsets[colIndex];
    const size = colSize(L.cols[colIndex]);
    if (size === 1) return buf[off];
    if (size === 2) return buf.readUInt16LE(off);
    if (size === 4) return buf.readUInt32LE(off);
    if (size === 8) return Number(buf.readBigUInt64LE(off));
    return 0;
  }

  function getString(index) {
    if (!strings || !index) return '';
    let end = strings.offset + index;
    while (buf[end] !== 0) end++;
    return buf.slice(strings.offset + index, end).toString('utf8');
  }

  /** 압축 정수(ECMA-335 II.23.2) 를 읽는다. */
  function readCompressed(off) {
    const b0 = buf[off];
    if ((b0 & 0x80) === 0) return { value: b0, size: 1 };
    if ((b0 & 0x40) === 0) return { value: ((b0 & 0x3F) << 8) | buf[off + 1], size: 2 };
    return {
      value: ((b0 & 0x1F) << 24) | (buf[off + 1] << 16) | (buf[off + 2] << 8) | buf[off + 3],
      size: 4,
    };
  }

  function getBlob(index) {
    if (!blobs || !index) return Buffer.alloc(0);
    const at = blobs.offset + index;
    const { value: len, size } = readCompressed(at);
    return buf.slice(at + size, at + size + len);
  }

  return {
    buf, layout, rowsOf, getString, getBlob, readCol, readCompressed,
    hasTable: (id) => !!layout[id],
    rows: (id) => (layout[id] ? layout[id].rows : 0),
    isPdb: !!streams['#Pdb'],
    // FieldRVA(0x1D)로 정적 배열 초기화 데이터를 읽을 때 필요하다.
    sections,
    rvaToOffset: (rva) => rvaToOffset(sections, rva),
  };
}

module.exports = { open, T, findMetadataRoot };
