'use strict';
// Phase 2c: Unity YAML 문서의 **값**을 읽는다.
//
// 레이어 A(scan.js)는 GUID 참조만 정규식으로 긁는다 — "누가 누구를 참조하는가"에는 그것으로 충분하고
// 115 MB 를 0.6 초에 훑는 이유도 그것이다. 하지만 "이 컴포넌트의 speed 가 얼마인가", "이 프리팹
// 인스턴스가 무엇을 오버라이드했는가" 는 값을 실제로 파싱해야 답할 수 있다.
//
// 그래서 이 모듈은 인덱스 빌드에 참여하지 않는다. **질의 시점에 파일 하나만** 파싱한다.
// 전체 프로젝트를 값까지 파싱하면 비용이 자릿수로 뛰고, 대부분의 값은 아무도 묻지 않는다.
//
// Unity 의 YAML 은 완전한 YAML 이 아니라 에미터가 내는 규칙적인 부분집합이다.
// 여기서도 그 부분집합만 다룬다 — 그리고 다루지 못한 줄은 조용히 버리지 않고 센다(`unparsed`).
// "실패 0" 을 커버리지의 증거로 쓸 수 없다는 것이 지난 감사의 교훈이다(HANDOFF §4-7).

// --- !u!114 &7276160912913218055 [stripped]
const DOC_RE = /^--- !u!(\d+) &(-?\d+)(\s+stripped)?\s*$/;

// 정수 스칼라. fileID 는 64비트라 Number 로 바꾸면 값이 깨진다(4336403264386578480 → ...8480 이 아님).
// 그래서 자릿수가 큰 정수는 문자열로 남긴다.
const INT_RE = /^-?\d+$/;
const FLOAT_RE = /^-?(?:\d+\.\d*|\.\d+|\d+)(?:[eE][-+]?\d+)?$/;
const SAFE_INT_DIGITS = 15;
const GUID_LIKE_RE = /^[0-9a-f]{32}$/;

/** 앞쪽 공백 수. Unity 는 탭을 쓰지 않는다. */
function indentOf(line) {
  let n = 0;
  while (n < line.length && line[n] === ' ') n++;
  return n;
}

/**
 * 문서 경계로 자른다. 각 문서는 `--- !u!<classId> &<fileID>` 로 시작한다.
 * 본문은 다음 구분자 직전까지.
 */
function splitDocuments(text) {
  const lines = text.split(/\r?\n/);
  const docs = [];
  let cur = null;

  for (let i = 0; i < lines.length; i++) {
    const m = DOC_RE.exec(lines[i]);
    if (!m) continue;
    if (cur) { cur.end = i; docs.push(cur); }
    cur = {
      classId: Number(m[1]),
      fileID: m[2],                // 문자열로 유지 — 64비트다
      stripped: !!m[3],            // 프리팹 인스턴스가 참조만 남긴 스텁
      headerLine: i + 1,           // 1-based
      start: i + 1,
      end: lines.length,
    };
  }
  if (cur) docs.push(cur);

  return { lines, docs };
}

/** 작은따옴표 스칼라 — YAML 규칙상 '' 가 ' 하나다. */
function unquoteSingle(s) {
  return s.slice(1, -1).replace(/''/g, "'");
}

/** 큰따옴표 스칼라 — 역슬래시 이스케이프. JSON 과 호환되지 않는 경우가 있어 직접 푼다. */
function unquoteDouble(s) {
  let out = '';
  for (let i = 1; i < s.length - 1; i++) {
    const c = s[i];
    if (c !== '\\') { out += c; continue; }
    const n = s[++i];
    if (n === 'n') out += '\n';
    else if (n === 't') out += '\t';
    else if (n === 'r') out += '\r';
    else if (n === '0') out += '\0';
    else if (n === 'u') { out += String.fromCharCode(parseInt(s.slice(i + 1, i + 5), 16) || 0); i += 4; }
    else out += n;
  }
  return out;
}

/** 인용/숫자/평문 스칼라 하나를 값으로 바꾼다. */
function parseScalar(raw) {
  const s = raw.trim();
  if (s === '') return '';
  if (s.length >= 2 && s[0] === "'" && s[s.length - 1] === "'") return unquoteSingle(s);
  if (s.length >= 2 && s[0] === '"' && s[s.length - 1] === '"') return unquoteDouble(s);

  // GUID 는 숫자로 보일 수 있다. Unity 내장 어셈블리 GUID `0000000000000000e000000000000000` 은
  // `\d+e\d+` 지수표기와 형태가 같아 Number 로 바꾸면 **0 이 된다**. 대조군 실측에서 씬 71개가
  // 이 GUID 를 잃었다 — 값이 사라진 게 아니라 조용히 0 으로 바뀌는, 더 나쁜 형태였다.
  if (GUID_LIKE_RE.test(s)) return s;
  // 선행 0 이 붙은 정수는 YAML 에서 숫자 표기가 아니다. 식별자를 숫자로 만들지 않는다.
  if (/^-?0\d/.test(s)) return s;

  if (INT_RE.test(s)) {
    // 부호를 뺀 자릿수로 판단한다.
    const digits = s[0] === '-' ? s.length - 1 : s.length;
    return digits > SAFE_INT_DIGITS ? s : Number(s);
  }
  if (FLOAT_RE.test(s)) return Number(s);
  // .inf / .nan / 평문 문자열은 그대로 둔다. Unity 는 bool 을 1/0 으로 쓰므로 여기서 bool 로 바꾸지 않는다
  // — 1 이 true 인지 숫자 1 인지는 필드 타입을 알아야 정해지고, 그 판단은 이 층의 일이 아니다.
  return s;
}

/**
 * 플로우 표기 `{...}` / `[...]` 를 파싱한다. 중첩과 인용을 처리한다.
 * 반환: { value, ok } — 형식이 어긋나면 ok:false 로 원문을 그대로 돌려준다.
 */
function parseFlow(src) {
  let i = 0;
  const s = src;

  function skipWs() { while (i < s.length && (s[i] === ' ' || s[i] === '\t')) i++; }

  function readQuoted(q) {
    const start = i;
    i++;                                   // 여는 따옴표
    while (i < s.length) {
      if (q === "'" && s[i] === "'") {
        if (s[i + 1] === "'") { i += 2; continue; }
        i++; return s.slice(start, i);
      }
      if (q === '"' && s[i] === '\\') { i += 2; continue; }
      if (q === '"' && s[i] === '"') { i++; return s.slice(start, i); }
      i++;
    }
    return s.slice(start, i);              // 닫히지 않음 — 있는 데까지
  }

  // 플로우 안의 스칼라: , } ] 전까지. 인용은 통째로.
  function readScalarToken() {
    skipWs();
    if (s[i] === "'" || s[i] === '"') return readQuoted(s[i]);
    const start = i;
    while (i < s.length && s[i] !== ',' && s[i] !== '}' && s[i] !== ']') i++;
    return s.slice(start, i);
  }

  function readValue() {
    skipWs();
    if (s[i] === '{') return readMap();
    if (s[i] === '[') return readSeq();
    return parseScalar(readScalarToken());
  }

  function readMap() {
    const obj = {};
    i++;                                   // '{'
    skipWs();
    if (s[i] === '}') { i++; return obj; }
    while (i < s.length) {
      skipWs();
      // 키는 콜론 전까지 (인용 키는 Unity 가 쓰지 않는다)
      const kStart = i;
      while (i < s.length && s[i] !== ':' && s[i] !== '}' && s[i] !== ',') i++;
      const key = s.slice(kStart, i).trim();
      if (s[i] === ':') i++;
      obj[key] = readValue();
      skipWs();
      if (s[i] === ',') { i++; continue; }
      if (s[i] === '}') { i++; break; }
      break;                               // 형식 이탈
    }
    return obj;
  }

  function readSeq() {
    const arr = [];
    i++;                                   // '['
    skipWs();
    if (s[i] === ']') { i++; return arr; }
    while (i < s.length) {
      arr.push(readValue());
      skipWs();
      if (s[i] === ',') { i++; continue; }
      if (s[i] === ']') { i++; break; }
      break;
    }
    return arr;
  }

  try {
    const v = readValue();
    skipWs();
    return { value: v, ok: i >= s.length };   // 남은 찌꺼기가 있으면 우리가 못 읽은 형식이다
  } catch {
    return { value: src, ok: false };
  }
}

// --- 여러 줄에 걸친 값 -------------------------------------------------------
// Unity 에미터는 줄이 길어지면 접는다. 실측(MainProject 2026-08-24)으로 세 형태가 나왔다.
//   (1) 플로우 맵 줄바꿈:  target: {fileID: -86799..., guid: ea98...,
//                            type: 3}
//   (2) 평문 스칼라 접힘:  RuntimeTypeString: Unity.Behavior.Start, Unity.Behavior, Version=0.0.0.0,
//                            Culture=neutral, PublicKeyToken=null
//   (3) 인용 스칼라 접힘:  m_text: 'You are currently a client.
//                            (빈 줄) ...  Do you wish to exit?'
// 셋 다 "키보다 더 깊이 들여쓴 다음 줄" 이라는 공통점이 있다.
// 이걸 처리하기 전에는 이 세 형태가 파일 하나에서 수백 줄씩 유실됐다 —
// 그리고 뒤따르는 형제 키들까지 함께 무너졌다(따옴표가 안 닫힌 채 다음 줄로 넘어가므로).

/** 인용 스칼라가 이 줄에서 닫혔는가. */
function isQuoteClosed(s, q) {
  let i = 1;
  while (i < s.length) {
    if (q === "'") {
      if (s[i] === "'") { if (s[i + 1] === "'") { i += 2; continue; } return true; }
      i++;
    } else {
      if (s[i] === '\\') { i += 2; continue; }
      if (s[i] === '"') return true;
      i++;
    }
  }
  return false;
}

/** 플로우 괄호의 잔여 깊이. 인용 안의 괄호는 세지 않는다. 0 이면 닫혔다. */
function flowDepth(s) {
  let d = 0, i = 0, q = null;
  while (i < s.length) {
    const c = s[i];
    if (q) {
      if (q === "'" && c === "'") { if (s[i + 1] === "'") { i += 2; continue; } q = null; }
      else if (q === '"' && c === '\\') { i += 2; continue; }
      else if (q === '"' && c === '"') { q = null; }
      i++; continue;
    }
    if (c === "'" || c === '"') { q = c; i++; continue; }
    if (c === '{' || c === '[') d++;
    else if (c === '}' || c === ']') d--;
    i++;
  }
  return d;
}

/** YAML 접힘 규칙: 줄바꿈 1개는 공백, 빈 줄 n개는 개행 n개. */
function foldLines(parts) {
  if (!parts.length) return '';
  let out = parts[0];
  let blanks = 0;
  for (let k = 1; k < parts.length; k++) {
    if (parts[k] === '') { blanks++; continue; }
    out += blanks > 0 ? '\n'.repeat(blanks) : ' ';
    out += parts[k];
    blanks = 0;
  }
  return out;
}

// 평문 스칼라의 이어붙이기는 다음 줄이 `key: value` 로 보이면 멈춘다.
// 접힌 평문 스칼라(어셈블리 수식 이름 등)에는 ': ' 가 없다.
const LOOKS_LIKE_KEY_RE = /^[^:'"{}[\]]+:(\s|$)/;

const DEFAULTS = {
  maxDepth: 8,
  maxSeqItems: 200,
  maxKeys: 400,
};

/**
 * 블록 매핑/시퀀스 파서.
 *
 * Unity 에미터의 규칙:
 *   - 매핑은 `key: value` 또는 `key:` + 더 깊은 들여쓰기
 *   - 시퀀스 항목 `- ...` 은 **키와 같은 들여쓰기**에 온다 (`m_Component:` / `- component: {...}`)
 *   - 항목이 매핑이면 두 번째 키부터 항목 들여쓰기 +2
 */
function parseBlock(lines, start, end, opts) {
  const o = { ...DEFAULTS, ...(opts || {}) };
  const ctx = { lines, end, i: start, unparsed: 0, truncated: false, samples: [] };

  // 못 읽은 줄은 세기만 하면 무엇이 빠졌는지 알 수 없다. 표본을 남겨 호출부가 드러낼 수 있게 한다.
  function noteUnparsed(line) {
    ctx.unparsed++;
    if (ctx.samples.length < 5) ctx.samples.push(String(line).trim().slice(0, 120));
  }

  function parseMap(indent, depth) {
    const obj = {};
    let keys = 0;

    while (ctx.i < ctx.end) {
      const raw = ctx.lines[ctx.i];
      if (!raw.trim()) { ctx.i++; continue; }

      const ind = indentOf(raw);
      if (ind < indent) break;
      const body = raw.slice(ind);
      if (body[0] === '-' && (body.length === 1 || body[1] === ' ')) break;   // 부모 키의 시퀀스다

      if (ind > indent) { noteUnparsed(raw); ctx.i++; continue; }                     // 예상 밖 들여쓰기

      const m = /^(.*?):(?:[ \t](.*))?$/.exec(body);
      if (!m) { noteUnparsed(raw); ctx.i++; continue; }

      const key = m[1];
      const inline = m[2] === undefined ? '' : m[2].trim();
      ctx.i++;

      if (keys >= o.maxKeys) { obj.__truncatedKeys = true; ctx.truncated = true; continue; }
      keys++;

      if (inline !== '') {
        obj[key] = valueOf(continued(inline, ind), depth);
        continue;
      }

      // 값이 다음 줄들에 있다. 무엇인지 앞을 봐서 정한다.
      const nxt = peekMeaningful();
      if (nxt === null) { obj[key] = null; continue; }
      const nInd = indentOf(ctx.lines[nxt]);
      const nBody = ctx.lines[nxt].slice(nInd);
      const isSeqItem = nBody[0] === '-' && (nBody.length === 1 || nBody[1] === ' ');

      if (isSeqItem && nInd >= indent) {
        ctx.i = nxt;
        obj[key] = depth + 1 > o.maxDepth ? '__depth_limit__' : parseSeq(nInd, depth + 1);
      } else if (nInd > indent) {
        ctx.i = nxt;
        obj[key] = depth + 1 > o.maxDepth ? '__depth_limit__' : parseMap(nInd, depth + 1);
      } else {
        obj[key] = null;   // 빈 값
      }
    }
    return obj;
  }

  function parseSeq(indent, depth) {
    const arr = [];
    while (ctx.i < ctx.end) {
      const raw = ctx.lines[ctx.i];
      if (!raw.trim()) { ctx.i++; continue; }
      const ind = indentOf(raw);
      if (ind !== indent) break;
      const body = raw.slice(ind);
      if (!(body[0] === '-' && (body.length === 1 || body[1] === ' '))) break;

      const rest = body.slice(1).replace(/^ /, '');
      ctx.i++;

      // 항목의 나머지 줄(더 깊은 들여쓰기)을 모은다.
      const itemLines = [];
      const itemIndent = indent + 2;
      if (rest !== '') itemLines.push(' '.repeat(itemIndent) + rest);
      while (ctx.i < ctx.end) {
        const r2 = ctx.lines[ctx.i];
        if (!r2.trim()) { ctx.i++; itemLines.push(r2); continue; }
        if (indentOf(r2) <= indent) break;
        itemLines.push(r2);
        ctx.i++;
      }

      // 끝의 빈 줄은 항목의 일부가 아니다. 남겨두면 스칼라 항목이 매핑으로 오판돼
      // 값이 통째로 {} 가 된다(파일 마지막 항목에서 실제로 그랬다).
      while (itemLines.length && !itemLines[itemLines.length - 1].trim()) itemLines.pop();

      if (arr.length >= o.maxSeqItems) { ctx.truncated = true; continue; }

      // 중첩 시퀀스(`- - a`)는 이 파서가 다루지 않는 형태다. MainProject 의 텍스트 에셋
      // 1,144개에는 한 건도 없지만, 없다고 단정하지 말고 만나면 드러내야 한다 —
      // 조용히 문자열 "- a" 로 만들면 그게 배열이었다는 사실이 사라진다.
      if (itemLines.length && /^\s*-(\s|$)/.test(itemLines[0])) noteUnparsed(itemLines[0]);

      // 항목이 `key: ...` 로 시작하면 매핑, 아니면 스칼라/플로우.
      const isMapping = itemLines.length > 1 || /^\s*[^:{[]+:(\s|$)/.test(itemLines[0] || '');
      if (!itemLines.length) { arr.push(null); continue; }
      if (isMapping) {
        const sub = parseBlock(itemLines, 0, itemLines.length,
          { ...o, maxDepth: o.maxDepth - depth });
        arr.push(sub.value);
        ctx.unparsed += sub.unparsed;
        for (const smp of sub.samples || []) if (ctx.samples.length < 5) ctx.samples.push(smp);
        if (sub.truncated) ctx.truncated = true;
      } else {
        arr.push(valueOf(itemLines[0].trim(), depth));
      }
    }
    return arr;
  }

  /**
   * `key: <inline>` 의 값이 다음 줄들로 이어지면 모아서 하나의 텍스트로 만든다.
   * 이어지는 줄은 키보다 깊이 들여쓴 줄이다. 값이 이미 완결이면 아무것도 소비하지 않는다.
   */
  function continued(inline, keyIndent) {
    const q = (inline[0] === "'" || inline[0] === '"') ? inline[0] : null;
    const isFlow = inline[0] === '{' || inline[0] === '[';

    if (q && isQuoteClosed(inline, q)) return inline;
    if (isFlow && flowDepth(inline) <= 0) return inline;

    const parts = [inline];
    let depthLeft = isFlow ? flowDepth(inline) : 0;

    while (ctx.i < ctx.end) {
      const raw = ctx.lines[ctx.i];

      if (!raw.trim()) {
        // 빈 줄 — 인용 스칼라 안에서는 개행을 뜻한다. 그 밖에서는 값의 끝이다.
        // 인용 안에서는 들여쓰기를 보지 않는다(닫는 따옴표가 1열에 오는 경우가 있다).
        if (!q) break;
        parts.push('');
        ctx.i++;
        continue;
      }

      // 인용 스칼라는 따옴표가 닫힐 때까지가 값이다 — 들여쓰기로 끊으면 안 된다.
      // 실측: Unity 는 값이 개행으로 끝나면 닫는 따옴표를 **1열**에 낸다.
      //   m_text: 'StartClient
      //   (빈 줄)
      //   '
      // 이걸 들여쓰기로 자르면 그 뒤 형제 키들이 통째로 유실된다(TMP 텍스트가 있는 씬마다 72줄).
      if (!q && indentOf(raw) <= keyIndent) break;
      if (q && DOC_RE.test(raw)) break;          // 폭주 방지 — 문서 경계는 절대 넘지 않는다
      const t = raw.trim();

      if (q) {
        parts.push(t);
        ctx.i++;
        if (endsQuote(t, q)) break;
        continue;
      }
      if (isFlow) {
        parts.push(t);
        ctx.i++;
        depthLeft += flowDepth(t);
        if (depthLeft <= 0) break;
        continue;
      }
      // 평문 스칼라 — 다음 줄이 키로 보이면 값이 아니다.
      if (LOOKS_LIKE_KEY_RE.test(t)) break;
      parts.push(t);
      ctx.i++;
    }

    return isFlow ? parts.join(' ') : foldLines(parts);
  }

  /** 이 줄에서 열려 있던 인용이 닫히는가. */
  function endsQuote(t, q) {
    let i = 0;
    while (i < t.length) {
      if (q === "'") {
        if (t[i] === "'") { if (t[i + 1] === "'") { i += 2; continue; } return true; }
        i++;
      } else {
        if (t[i] === '\\') { i += 2; continue; }
        if (t[i] === '"') return true;
        i++;
      }
    }
    return false;
  }

  function valueOf(text, depth) {
    if (text[0] === '{' || text[0] === '[') {
      if (depth + 1 > o.maxDepth) return '__depth_limit__';
      const f = parseFlow(text);
      if (!f.ok) noteUnparsed(text);
      return f.value;
    }
    return parseScalar(text);
  }

  function peekMeaningful() {
    for (let j = ctx.i; j < ctx.end; j++) if (ctx.lines[j].trim()) return j;
    return null;
  }

  // 문서 본문의 최상위 들여쓰기를 첫 유효 줄에서 정한다(보통 0).
  const first = peekMeaningful();
  const baseIndent = first === null ? 0 : indentOf(ctx.lines[first]);
  const value = parseMap(baseIndent, 0);

  return { value, unparsed: ctx.unparsed, unparsedSamples: ctx.samples, samples: ctx.samples, truncated: ctx.truncated };
}

/**
 * 문서 하나를 파싱한다. Unity 문서는 `ClassName:` 하나를 최상위 키로 갖는다.
 * 반환: { className, body, unparsed, truncated }
 */
function parseDocument(lines, doc, opts) {
  const r = parseBlock(lines, doc.start, doc.end, opts);
  const keys = Object.keys(r.value);
  const className = keys.length === 1 ? keys[0] : null;
  return {
    className,
    body: className ? r.value[className] : r.value,
    unparsed: r.unparsed,
    unparsedSamples: r.unparsedSamples,
    truncated: r.truncated,
  };
}

module.exports = { splitDocuments, parseDocument, parseBlock, parseFlow, parseScalar, indentOf, DOC_RE };
