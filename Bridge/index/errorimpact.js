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
    for (const m of (info.methods || [])) {
      if (typeof m.line !== 'number') continue;
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
function attributeLine(spans, line) {
  if (!spans.length || typeof line !== 'number' || line <= 0) return null;
  for (const s of spans) {
    if (line >= s.line && line <= s.endLine) return Object.assign({}, s, { containment: 'exact' });
  }
  let best = null;
  for (const s of spans) {
    if (s.line >= line && (!best || s.line < best.line)) best = s;
  }
  if (best) return Object.assign({}, best, { containment: 'inferred' });
  return null;
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
    const hit = attributeLine(spans, row.line);
    if (hit) {
      row.method = {
        name: hit.name,
        line: hit.line,
        endLine: hit.endLine,
        containment: hit.containment,
        key: hit.typeFullName + '::' + hit.name,
      };
      if (hit.containment === 'inferred') {
        row.method.containmentNote =
          'line falls outside every method body span. PDB sequence points start past the opening ' +
          'brace, so signatures, attributes and field initializers sit outside every span. ' +
          'Attributed to the next method by position - treat as a hint, not a fact.';
      }
    } else {
      row.method = null;
      row.methodNote =
        'No method body span covers or follows this line (file-level or type-level location).';
    }

    const primary = row.method ? row.method.key.slice(0, row.method.key.indexOf('::')) : typeNames[0];
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

    const guid = index.pathToGuid.get(file);
    if (guid) {
      const users = index.scriptUsers && index.scriptUsers.get(guid);
      row.attachedAssetCount = users ? users.size : 0;
      row.attachedAssets = users ? [...users].sort().slice(0, 5) : [];
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
  explain, normalizePath, classifyOrigin, methodSpansForFile, attributeLine, MAX_ERRORS,
};
