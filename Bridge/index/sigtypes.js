// ECMA-335 시그니처의 Type 인코딩 디코더 (II.23.2.12).
//
// 왜 필요한가 — 지금까지 필드는 이름/접근자만 있고 **타입이 없었다.** 그래서
// `unity_get_asset_components` 가 직렬화 값을 보여주면서도 그 값이 선언 타입에 맞는지
// 검증할 수 없고, `objectReference` 필드가 무엇을 담는 필드인지 말할 수 없었다.
//
// 이 모듈은 Type 인코딩만 다룬다. FieldSig(II.23.2.4)는 `FIELD(0x06) CustomMod* Type`,
// MethodDefSig(II.23.2.1)는 앞에 호출 규약과 인자 수가 붙는다 — 오버로드 구분을 할 때
// 같은 Type 디코더를 재사용한다.
//
// **모르는 것은 null 로 돌려준다.** 추측해서 채우면 값 검증이 거짓말을 하게 된다.

// II.23.1.16 ELEMENT_TYPE_*
const ET = {
  END: 0x00, VOID: 0x01, BOOLEAN: 0x02, CHAR: 0x03,
  I1: 0x04, U1: 0x05, I2: 0x06, U2: 0x07, I4: 0x08, U4: 0x09,
  I8: 0x0a, U8: 0x0b, R4: 0x0c, R8: 0x0d, STRING: 0x0e,
  PTR: 0x0f, BYREF: 0x10, VALUETYPE: 0x11, CLASS: 0x12, VAR: 0x13,
  ARRAY: 0x14, GENERICINST: 0x15, TYPEDBYREF: 0x16,
  I: 0x18, U: 0x19, FNPTR: 0x1b, OBJECT: 0x1c, SZARRAY: 0x1d, MVAR: 0x1e,
  CMOD_REQD: 0x1f, CMOD_OPT: 0x20, INTERNAL: 0x21,
  MODIFIER: 0x40, SENTINEL: 0x41, PINNED: 0x45,
};

// 원시 타입은 **C# 이름**으로 낸다. 읽는 쪽이 C# 소스와 대조하기 때문이다
// (`System.Int32` 보다 `int` 가 선언과 눈으로 맞춰진다).
const PRIMITIVE = {
  [ET.VOID]: 'void', [ET.BOOLEAN]: 'bool', [ET.CHAR]: 'char',
  [ET.I1]: 'sbyte', [ET.U1]: 'byte', [ET.I2]: 'short', [ET.U2]: 'ushort',
  [ET.I4]: 'int', [ET.U4]: 'uint', [ET.I8]: 'long', [ET.U8]: 'ulong',
  [ET.R4]: 'float', [ET.R8]: 'double', [ET.STRING]: 'string',
  [ET.I]: 'System.IntPtr', [ET.U]: 'System.UIntPtr',
  [ET.OBJECT]: 'object', [ET.TYPEDBYREF]: 'System.TypedReference',
};

/** blob 안의 압축 부호없는 정수. */
function uint(b, st) {
  const x = b[st.p];
  if (x === undefined) throw new Error('signature truncated');
  if ((x & 0x80) === 0) { st.p += 1; return x; }
  if ((x & 0x40) === 0) { const v = ((x & 0x3f) << 8) | b[st.p + 1]; st.p += 2; return v; }
  const v = ((x & 0x1f) << 24) | (b[st.p + 1] << 16) | (b[st.p + 2] << 8) | b[st.p + 3];
  st.p += 4; return v;
}

/**
 * Type 하나를 읽어 이름 문자열로 돌려준다.
 *
 * `resolveCoded(codedIndex)` 는 TypeDefOrRefOrSpec 코드 인덱스를 이름으로 바꾸는 콜백이다
 * (호출부의 `resolveTypeDefOrRef` 를 그대로 쓴다 — 같은 인코딩이다).
 * 깊이 상한을 둔다: 손상된 blob 이 무한 재귀로 프로세스를 죽이지 않게.
 */
function readType(b, st, resolveCoded, depth) {
  if (depth > 12) return null;
  const et = b[st.p];
  if (et === undefined) return null;
  st.p += 1;

  if (PRIMITIVE[et] !== undefined) return PRIMITIVE[et];

  switch (et) {
    case ET.CLASS:
    case ET.VALUETYPE: {
      const coded = uint(b, st);
      return resolveCoded(coded) || null;
    }
    case ET.SZARRAY: {
      // CustomMod* 가 앞에 올 수 있다.
      skipCustomMods(b, st);
      const inner = readType(b, st, resolveCoded, depth + 1);
      return inner ? inner + '[]' : null;
    }
    case ET.ARRAY: {
      const inner = readType(b, st, resolveCoded, depth + 1);
      // ArrayShape: rank, numSizes, sizes*, numLoBounds, loBounds*
      const rank = uint(b, st);
      const numSizes = uint(b, st);
      for (let i = 0; i < numSizes; i++) uint(b, st);
      const numLo = uint(b, st);
      for (let i = 0; i < numLo; i++) uint(b, st);
      if (!inner) return null;
      return inner + '[' + (rank > 1 ? ','.repeat(rank - 1) : '') + ']';
    }
    case ET.GENERICINST: {
      const kind = b[st.p]; st.p += 1;            // CLASS 또는 VALUETYPE
      if (kind !== ET.CLASS && kind !== ET.VALUETYPE) return null;
      const coded = uint(b, st);
      const base = resolveCoded(coded);
      const argc = uint(b, st);
      const args = [];
      for (let i = 0; i < argc; i++) {
        const a = readType(b, st, resolveCoded, depth + 1);
        args.push(a || '?');
      }
      if (!base) return null;
      // `List`1` -> `List`. 백틱 뒤 숫자는 아리티 표기라 사람이 읽을 이름에서 뺀다.
      const clean = base.replace(/`\d+$/, '');
      return clean + '<' + args.join(', ') + '>';
    }
    case ET.PTR: {
      skipCustomMods(b, st);
      const inner = readType(b, st, resolveCoded, depth + 1);
      return inner ? inner + '*' : null;
    }
    case ET.BYREF: {
      const inner = readType(b, st, resolveCoded, depth + 1);
      return inner ? 'ref ' + inner : null;
    }
    // 제네릭 파라미터. 어느 파라미터인지만 알 수 있고 실제 타입은 인스턴스마다 다르다.
    case ET.VAR: { const n = uint(b, st); return '!' + n; }
    case ET.MVAR: { const n = uint(b, st); return '!!' + n; }
    case ET.FNPTR: return null;      // 함수 포인터 — 필드에서 사실상 안 나온다
    case ET.INTERNAL: return null;   // 런타임 내부 표현
    default:
      return null;                   // 모르는 인코딩은 추측하지 않는다
  }
}

/** CustomMod* 를 건너뛴다. `CMOD_REQD|CMOD_OPT TypeDefOrRefEncoded` 의 반복이다. */
function skipCustomMods(b, st) {
  let guard = 0;
  while (guard++ < 16) {
    const et = b[st.p];
    if (et !== ET.CMOD_REQD && et !== ET.CMOD_OPT) return;
    st.p += 1;
    uint(b, st);
  }
}

/**
 * FieldSig 를 디코딩한다 (II.23.2.4): `FIELD(0x06) CustomMod* Type`.
 * 실패하면 null — 호출부가 "모른다" 로 싣는다.
 */
function decodeFieldSig(blob, resolveCoded) {
  if (!blob || !blob.length) return null;
  try {
    const st = { p: 0 };
    const kind = blob[st.p];
    // 0x06 이 아니면 FieldSig 가 아니다. 관용적으로 넘겨주지 않는다.
    if (kind !== 0x06) return null;
    st.p += 1;
    skipCustomMods(blob, st);
    return readType(blob, st, resolveCoded, 0);
  } catch {
    return null;
  }
}

/**
 * MethodDefSig / MethodRefSig 를 디코딩한다 (II.23.2.1 / II.23.2.2).
 *
 *   conv [GenParamCount] ParamCount RetType Param*
 *
 * conv 의 0x10 이 GENERIC 이면 제네릭 인자 수가 먼저 온다. VARARG 호출부에는 파라미터
 * 목록 중간에 SENTINEL(0x41) 이 낀다.
 *
 * 오버로드 구분에 필요한 것은 **파라미터 타입 목록**이다. C# 은 반환 타입으로
 * 오버로드하지 않으므로 키에는 파라미터만 쓴다.
 *
 * 실패하면 null. 파라미터 하나를 못 그리면 그 자리에 `?` 가 들어간다 —
 * 실측(2026-08-27): MethodDef 178,574개 중 `?` 포함 225개(0.13%),
 * MemberRef 123,720개 중 11,038개(8.9%). `?` 가 있는 키는 정의 쪽과 맞출 수 없으므로
 * 호출부에서는 **미해석으로 세고 시그니처 그래프에 넣지 않는다.**
 */
function decodeMethodSig(blob, resolveCoded) {
  if (!blob || !blob.length) return null;
  try {
    const st = { p: 0 };
    const conv = blob[st.p++];
    if (conv & 0x10) uint(blob, st);            // GENERIC -> GenParamCount
    const paramCount = uint(blob, st);
    const ret = readType(blob, st, resolveCoded, 0);
    const params = [];
    for (let i = 0; i < paramCount; i++) {
      if (blob[st.p] === ET.SENTINEL) { st.p += 1; params.push('...'); continue; }
      const t = readType(blob, st, resolveCoded, 0);
      params.push(t === null ? '?' : t);
    }
    return { params, ret, generic: !!(conv & 0x10), hasThis: !!(conv & 0x20) };
  } catch {
    return null;
  }
}

/** `Type::Method(int,string)` 형태의 키를 만든다. 공백 없이 — 키는 사람이 아니라 맵이 읽는다. */
function methodSigKey(typeFull, methodName, params) {
  return typeFull + '::' + methodName + '(' + params.join(',') + ')';
}

module.exports = { decodeFieldSig, decodeMethodSig, methodSigKey, readType, uint, ET, PRIMITIVE };
