// P3-b — 컴파일 진단을 인덱스와 조인한다.
//
// 왜 별도 도구인가(§4-(25)) — "컴파일 상태가 뭔가" 와 "이 오류들이 무엇을 건드리나" 는
// 다른 질문이다. 입력의 신선도 의미가 다르고 실패 양상이 다르다. 기존 상태 도구의 응답을
// 가공하면 조인이 깨질 때 멀쩡하던 상태 조회까지 같이 깨진다.
//
// 왜 Unity 로 왕복하지 않는가 — 독립 감사가 지목한 최대 위험이 전송 계층 리팩터링이었다
// (`postToUnity` 를 "stdout 에 쓰기" 에서 "응답 반환" 으로 바꾸면 인증·재시도·타임아웃·
// 정확히-한-번을 전부 건드린다). 진단을 **입력으로 받으면** 그게 통째로 사라지고,
// 도메인 리로드와 30초 큐에도 노출되지 않는다. 호출자는 어차피 상태 도구를 이미 부른다.
//
// 이 도구가 조심해야 하는 것 하나: **컴파일이 실패하면 Unity 는 ScriptAssemblies 를
// 갱신하지 않는다.** 즉 인덱스는 직전 성공 빌드를 설명하고, 오류 줄번호는 새 소스 기준이다.
// 정확히 필요한 순간에 낡는다. 그래서 신선도를 응답의 일부로 싣는다.

const fs = require('fs');
const path = require('path');
const mkey = require('./methodkey');

const MAX_ERRORS = 50;
const BS = String.fromCharCode(92);   // 역슬래시 리터럴을 소스에 두지 않는다

/** 컴파일러가 내는 경로를 인덱스 키(프로젝트 상대)로 맞춘다. */
function normalizePath(index, raw, projectRoot) {
  if (!raw) return null;
  const p = String(raw).split(BS).join('/').replace(/^[/]+/, '');
  if (index.pathToGuid.has(p)) return p;
  const root = (projectRoot || '').split(BS).join('/').replace(/[/]+$/, '');
  if (root && p.toLowerCase().startsWith(root.toLowerCase() + '/')) {
    return p.slice(root.length + 1);
  }
  // 루트를 몰라도 Assets/ 이후를 잘라내면 인덱스 키가 되는 경우가 많다.
  const m = p.match(/(?:^|[/])((?:Assets|Packages|ProjectSettings)[/].*)$/);
  if (m) return m[1];
  return p;
}

/** 고칠 수 있는 자리인가. 판정이 아니라 분류를 싣는다. */
function classifyOrigin(p) {
  if (!p) return 'unknown';
  const n = String(p).split(BS).join('/');
  if (/(?:^|[/])Library[/]PackageCache[/]/i.test(n)) return 'packageCache';
  if (/(?:^|[/])Assets[/]/i.test(n)) return 'assets';
  if (/(?:^|[/])Packages[/]/i.test(n)) return 'embeddedPackage';
  if (/^[A-Za-z]:[/]/.test(n)) return 'localPackage';
  return 'unknown';
}

/**
 * 이 파일의 메서드들을 줄 순으로 늘어놓는다.
 *
 * `line` 은 PDB 시퀀스 포인트라 **본문 시작**이지 시그니처 줄이 아니다. 그래서
 * 시그니처·속성·필드 초기화자의 오류는 어느 메서드의 [line, endLine] 에도 안 들어간다.
 */
function methodSpansForFile(index, file) {
  const sym = index.symbols;
  if (!sym || !sym.typesBySourceFile) return [];
  const typeNames = sym.typesBySourceFile.get(file) || [];
  const spans = [];
  for (const fn of typeNames) {
    const info = sym.typeByFullName.get(fn);
    if (!info) continue;
    const files = info.sourceFiles || [];
    for (const m of (info.methods || [])) {
      if (typeof m.line !== 'number') continue;
      // 부분 클래스 — 이 메서드가 다른 파일에 있으면 이 파일의 범위가 아니다.
      // 안 걸러내면 다른 파일의 줄 범위가 이 파일의 줄과 겹쳐 오류를 엉뚱한 메서드에 붙인다.
      if (typeof m.fileIndex === 'number' && files[m.fileIndex] && files[m.fileIndex] !== file) continue;
      spans.push({
        name: m.name,
        line: m.line,
        endLine: typeof m.endLine === 'number' ? m.endLine : m.line,
        typeFullName: info.fullName,
      });
    }
  }
  spans.sort((a, b) => a.line - b.line || a.endLine - b.endLine);
  return spans;
}

/**
 * 줄 하나를 메서드에 귀속한다.
 *
 * 범위 안이면 `exact`. 범위 밖이면 **조용히 버리지 않고** 바로 다음 메서드로 추정
 * 귀속하되 `inferred` 로 표시한다. 시그니처 줄의 오류가 그 메서드에 붙는 것은 맞지만,
 * 필드 초기화자나 클래스 속성의 오류도 같은 자리로 떨어진다 — 그래서 사실이 아니라 힌트다.
 */
// 선언 줄을 찾기 위해 본문 시작에서 위로 훑는 줄 수.
// 실측(2026-08-27, 표본 276): 본문시작 - 선언줄 거리는 중앙 2 / p90 2 / **최대 5**,
// 분포 {0:33, 1:4, 2:228, 3:6, 5:5} — 시그니처, 여는 중괄호, 첫 문장 순서라 2가 압도적이다.
// 8 이면 속성 한두 줄이 붙은 경우까지 덮는다.
const DECL_SCAN_UP = 8;

/**
 * 메서드의 선언 줄을 소스에서 찾는다. 못 찾으면 null — 추측하지 않는다.
 * `get_`/`set_` 접두사는 자동 속성의 컴파일러 표기이므로 떼고 찾는다.
 */
function findDeclLine(srcLines, span) {
  if (!srcLines) return null;
  const bare = String(span.name).replace(/^(get_|set_)/, '');
  if (!bare || bare.startsWith('<') || bare.startsWith('.')) return null;
  const from = Math.max(1, span.line - DECL_SCAN_UP);
  for (let k = span.line; k >= from; k--) {
    const t = srcLines[k - 1];
    if (t && t.includes(bare)) return k;
  }
  return null;
}

/**
 * 줄 하나를 메서드에 귀속한다. 확신도를 네 단계로 낸다.
 *
 *   exact      본문 범위 안이다
 *   signature  선언 줄과 본문 시작 사이다 — 시그니처·속성 줄. 소스에서 선언을 찾아 확인했다
 *   gap        위 둘 다 아니고 다음 메서드보다 앞이다. 필드 초기화자나 클래스 속성일 수 있다
 *   (null)     뒤에 오는 메서드가 없다
 *
 * `signature` 승급에는 소스가 필요하다. srcLines 가 없으면 승급하지 않고 gap 으로 남는다 —
 * 소스를 못 읽었는데 "시그니처다" 라고 말하면 근거 없는 단정이 된다.
 */
function attributeLine(spans, line, srcLines) {
  if (!spans.length || typeof line !== 'number' || line <= 0) return null;
  for (const s of spans) {
    if (line >= s.line && line <= s.endLine) return Object.assign({}, s, { containment: 'exact' });
  }
  let best = null;
  for (const s of spans) {
    if (s.line >= line && (!best || s.line < best.line)) best = s;
  }
  if (!best) return null;

  const decl = findDeclLine(srcLines, best);
  if (decl !== null && line >= decl && line < best.line) {
    return Object.assign({}, best, { containment: 'signature', declLine: decl });
  }
  return Object.assign({}, best, { containment: 'gap', ...(decl !== null ? { declLine: decl } : {}) });
}

/**
 * 그 줄이 **실제로 무엇인지** 소스에서 분류한다 (`lineKind`).
 *
 * 왜 필요한가 — `gap` 은 "다음 메서드로 붙인 힌트" 라고만 말했다. 실측(2026-08-28,
 * 매핑된 559 파일 45,629 코드 줄): exact 32,995 / signature 3,363 / **gap 8,887** / 없음 384.
 * 그 gap 8,887 의 구성이 필드·문장 2,943 · using·namespace 2,095 · 속성 1,397 ·
 * 타입선언 728 · 시그니처꼴 692 · 기타 652 · 전처리기 380 이다.
 * 즉 **4분의 1 이상이 메서드와 아무 관계가 없는 파일 수준 줄**인데 "바로 다음 메서드" 로
 * 붙고 있었다(`using` 한 줄의 CS0246 이 `.ctor` 로 귀속됐다).
 *
 *   file-level        using / namespace / 전처리기 — 메서드 귀속을 아예 하지 않는다
 *   type-attribute    속성 줄이고 아래가 타입 선언이다 — 타입이 깨진다
 *   member-attribute  속성 줄이고 아래가 멤버다
 *   type-declaration  타입 선언 줄
 *   field-declaration 필드 선언 줄. **인덱스의 필드 이름과 맞았을 때만** 그렇게 말한다
 *   blank-or-comment  빈 줄·주석
 *   unknown           위 어느 것도 아니거나 소스를 못 읽었다 — 추측하지 않는다
 *
 * 필드는 **이름 교차검증**으로만 확정한다. 문법만 보고 "필드 선언" 이라고 하면
 * 지역 변수·프로퍼티·object initializer 가 같은 모양으로 들어온다.
 */
const FILE_LEVEL_RE = /^(?:using\s+(?:static\s+)?[A-Za-z_@]|namespace\b|#)/;
const TYPE_DECL_RE = /\b(?:class|struct|interface|enum|record)\s+[A-Za-z_@]/;
const IDENT_RE = /[A-Za-z_@][A-Za-z0-9_]*/g;

function classifyLine(srcLines, line, typeNames, sym) {
  if (!srcLines || typeof line !== 'number' || line <= 0 || line > srcLines.length) {
    return { kind: 'unknown' };
  }
  const text = String(srcLines[line - 1] || '');
  const s = text.trim();
  if (!s || s.startsWith('//') || s.startsWith('*') || s.startsWith('/*')) return { kind: 'blank-or-comment' };
  if (FILE_LEVEL_RE.test(s)) return { kind: 'file-level' };

  if (s.startsWith('[') && !s.startsWith('[]')) {
    // 아래로 내려가며 첫 코드 줄을 본다 — 속성이 여러 줄 붙을 수 있다.
    for (let k = line; k < srcLines.length; k++) {
      const n = String(srcLines[k] || '').trim();
      if (!n || n.startsWith('//') || n.startsWith('[')) continue;
      return { kind: TYPE_DECL_RE.test(n) ? 'type-attribute' : 'member-attribute' };
    }
    return { kind: 'unknown' };          // 속성 뒤에 코드가 없다 — 단정하지 않는다
  }

  if (TYPE_DECL_RE.test(s)) return { kind: 'type-declaration' };

  // 필드 — 이 파일이 선언한 타입들의 필드 이름과 맞는 것이 이 줄에 있는가.
  const names = new Set();
  const idents = s.match(IDENT_RE) || [];
  if (idents.length && sym && sym.typeByFullName) {
    for (const fn of (typeNames || [])) {
      const info = sym.typeByFullName.get(fn);
      for (const f of ((info && info.fields) || [])) {
        if (!f.name || f.name.startsWith('<')) continue;   // 컴파일러 생성 백킹 필드는 소스에 없다
        if (idents.includes(f.name)) names.add(JSON.stringify({ name: f.name, type: f.type || null, declaringType: info.fullName }));
      }
    }
  }
  if (names.size === 1) {
    const m = JSON.parse([...names][0]);
    return { kind: 'field-declaration', member: { kind: 'field', name: m.name, type: m.type, declaringType: m.declaringType } };
  }
  if (names.size > 1) {
    // 한 줄에 여러 필드가 맞았다(`int a, b;` 또는 초기화자에 다른 필드가 나온다).
    // 하나로 정하지 않고 후보를 준다.
    return { kind: 'field-declaration', candidates: [...names].map(x => JSON.parse(x).name).sort().slice(0, 8) };
  }
  return { kind: 'unknown' };
}

function explain(index, args, meta) {
  const list = Array.isArray(args && args.errors) ? args.errors : null;
  if (!list || list.length === 0) {
    return {
      error: 'errors is required and must be a non-empty array of {file, line, message}. ' +
             'Get them from unity_get_compilation_status. An empty list is not an answer, because ' +
             '"the compilation reported no errors" and "you passed nothing" are different states.',
    };
  }

  const cap = Math.min(Math.max(Number(args.maxErrors) || MAX_ERRORS, 1), MAX_ERRORS);
  const taken = list.slice(0, cap);
  const omittedCount = list.length - taken.length;

  const sym = index.symbols;
  const out = [];
  const srcCache = new Map();

  for (const e of taken) {
    const rawFile = e && e.file;
    const file = normalizePath(index, rawFile, meta && meta.projectRoot);
    const origin = classifyOrigin(rawFile || file);
    const row = {
      file,
      rawFile: rawFile || null,
      line: (e && typeof e.line === 'number') ? e.line : null,
      message: (e && e.message) ? String(e.message).slice(0, 400) : null,
      origin,
    };

    const typeNames = (sym && sym.typesBySourceFile && sym.typesBySourceFile.get(file)) || [];
    if (!typeNames.length) {
      // 조용한 0 을 만들지 않는다. 못 찾은 것과 영향이 없는 것은 다르다.
      row.resolution = 'unresolved';
      row.resolutionNote = origin === 'assets'
        ? 'This path is not in the symbol index. A file that fails to compile has no type in the ' +
          'last-good assemblies, so a NEW or renamed file is expected to land here - that is not ' +
          'evidence that nothing depends on it.'
        : 'Outside the indexed user assemblies (origin=' + origin + '); the index only covers project code.';
      out.push(row);
      continue;
    }

    row.resolution = 'resolved';
    const spans = methodSpansForFile(index, file);
    // 선언 줄을 확인하려면 소스가 필요하다. 오류당 파일 하나이고 상한이 50개라 싸다.
    // 같은 파일이 여러 번 나오면 캐시한다.
    let srcLines = null;
    if (meta && meta.projectRoot) {
      const abs = path.join(meta.projectRoot, file);
      if (srcCache.has(abs)) srcLines = srcCache.get(abs);
      else {
        try { srcLines = fs.readFileSync(abs, 'utf8').split(String.fromCharCode(10)); }
        catch { srcLines = null; }
        srcCache.set(abs, srcLines);
      }
    }
    const hit = attributeLine(spans, row.line, srcLines);

    // 그 줄이 실제로 무엇인지 먼저 말한다. `gap` 만으로는 "다음 메서드로 붙인 힌트" 라는
    // 말밖에 못 했고, gap 의 4분의 1 이상은 메서드와 무관한 파일 수준 줄이었다.
    const cls = classifyLine(srcLines, row.line, typeNames, sym);
    row.lineKind = cls.kind;
    if (cls.member) row.member = cls.member;
    else if (cls.candidates) row.memberCandidates = cls.candidates;

    if (cls.kind === 'file-level') {
      // 메서드에 붙이지 않는다. 붙이면 거짓 힌트다 — `using` 한 줄의 CS0246 이
      // 컴파일러 생성 `.ctor` 로 귀속되고 있었다.
      row.method = null;
      row.methodNote =
        'file-level line (using / namespace / preprocessor), so it is attributed to no method. ' +
        'The type axis below still answers: these are the types this file declares.';
    } else if (hit) {
      row.method = {
        name: hit.name,
        line: hit.line,
        endLine: hit.endLine,
        containment: hit.containment,
        key: hit.typeFullName + '::' + hit.name,
      };
      if (hit.declLine) row.method.declLine = hit.declLine;
      if (hit.containment === 'signature') {
        row.method.containmentNote =
          'line is between this method declaration (declLine, found in the source) and its first ' +
          'sequence point, i.e. the signature or an attribute. Confident: the method name was located ' +
          'on that line in the file on disk.';
      } else if (hit.containment === 'gap') {
        row.method.containmentNote =
          'line is before this method but outside its declaration block, so it may belong to a field ' +
          'initializer, a type-level attribute or another member entirely. Attributed to the next ' +
          'method by position - a hint, not a fact. Read lineKind (' + cls.kind + ') for what the ' +
          'line itself is; when it is field-declaration the member field names the real target.' +
          (srcLines ? '' : ' The source file could not be read, so the declaration line was not checked.');
      }
    } else {
      row.method = null;
      row.methodNote =
        'No method body span covers or follows this line (file-level or type-level location).';
    }

    const primary = row.method ? mkey.typeOf(row.method.key) : typeNames[0];
    const info = sym.typeByFullName.get(primary);
    row.type = info
      ? {
          fullName: info.fullName,
          qualifiedName: info.qualifiedName || info.fullName,
          declaringType: info.declaringType === undefined ? null : info.declaringType,
          assembly: info.assembly,
        }
      : { fullName: primary, qualifiedName: primary, declaringType: null, assembly: null };
    row.typesInFile = typeNames.slice(0, 20);

    if (row.method && index.callGraph && index.callGraph.callersOf) {
      const set = index.callGraph.callersOf.get(row.method.key);
      row.callerCount = set ? set.size : 0;
      row.callers = set ? [...set].sort().slice(0, 10) : [];
    } else {
      row.callerCount = 0;
      row.callers = [];
    }

    // ⚠️ 여기 처음 구현은 `index.scriptUsers` 를 읽었다. 그런 맵은 없다 — 이름은
    // `scriptRefs` 다. 그래서 붙은 에셋이 몇 개든 **조용히 0 을 답하고 있었다.**
    // 프로브 4번이 type 과 callerCount 만 검사해서 통과시켰다(§4-(21)).
    const guid = index.pathToGuid.get(file);
    if (guid) {
      const users = index.scriptRefs && index.scriptRefs.get(guid);
      row.attachedAssetCount = users ? users.size : 0;
      row.attachedAssets = users ? [...users].sort().slice(0, 5) : [];
    } else {
      // GUID 를 못 찾았다는 것은 "붙은 에셋이 없다" 가 아니라 "이 파일을 모른다" 다.
      row.attachedAssetCount = null;
      row.attachedNote = 'No .meta GUID for this path, so attachment could not be looked up at all.';
    }

    out.push(row);
  }

  // 신선도 — 컴파일이 실패했으면 어셈블리는 갱신되지 않았고, 위 조인은 직전 성공 빌드다.
  const freshness = {
    state: args.hadErrors === undefined ? 'unknown' : (args.hadErrors ? 'last-good' : 'current'),
    indexBuiltAt: (meta && meta.builtAt) || null,
    indexFromCache: !!(meta && meta.fromCache),
    compilationGeneration:
      typeof args.compilationGeneration === 'number' ? args.compilationGeneration : null,
    note:
      'The symbol and call graph come from Library/ScriptAssemblies. Unity does NOT update those ' +
      'assemblies when a compilation fails, so while errors exist this join describes the LAST GOOD ' +
      'build, not the code you just edited - a newly added or renamed symbol will not appear at all. ' +
      'Pass hadErrors and compilationGeneration from unity_get_compilation_status to make this ' +
      'explicit; without them the state is unknown.',
  };

  return {
    errorCount: list.length,
    returnedCount: out.length,
    omittedCount,
    ...(omittedCount > 0
      ? {
          omittedNote:
            omittedCount + ' error(s) beyond the cap of ' + cap + ' were not analysed. ' +
            'Compiler errors cascade, so the first ones are usually the real cause.',
        }
      : {}),
    freshness,
    errors: out,
  };
}

module.exports = {
  explain, normalizePath, classifyOrigin, methodSpansForFile, attributeLine, classifyLine, MAX_ERRORS,
};
