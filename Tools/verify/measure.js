'use strict';

// Independent end-to-end audit driver for TASK.md.  It calls the public MCP tools,
// but derives source truth from Roslyn output and raw on-disk YAML/file existence.
const fs = require('fs');
const path = require('path');
// 경로는 이 파일 위치와 환경변수에서 온다 - 절대경로를 박으면 다른 머신에서 안 돈다.
const PKG = path.join(__dirname, '..', '..');
const tools = require(path.join(PKG, 'Bridge/index/tools'));

const ROOT = process.env.UNITY_MCP_PROJECT || 'C:/Unity/MainProject';
const OUT = process.env.MEASURE_OUT || path.join(__dirname, 'measurement-results.json');
// roslyn-oracle/ 를 dotnet run 해서 만든다. README 참조.
const GT = process.env.ROSLYN_GROUND_TRUTH || path.join(__dirname, 'roslyn-ground-truth.json');
const roslyn = JSON.parse(fs.readFileSync(GT, 'utf8'));
const idx = tools.ensureIndex(3000, true, false);
const call = (name, args) => JSON.parse(tools.callLocalTool(name, args, 3000).content[0].text);
const slash = p => p.replace(/\\/g, '/');
const abs = p => path.join(ROOT, ...p.split('/'));
const lineOf = (text, at) => 1 + (text.slice(0, at).match(/\n/g) || []).length;

function walk(dir, out = [], seen = new Set()) {
  let real;
  try { real = fs.realpathSync(dir); } catch { return out; }
  if (seen.has(real)) return out;
  seen.add(real);
  let entries = [];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    let isDir = e.isDirectory(), isFile = e.isFile();
    if (!isDir && !isFile && e.isSymbolicLink()) {
      try { const st = fs.statSync(p); isDir = st.isDirectory(); isFile = st.isFile(); } catch { continue; }
    }
    if (isDir) walk(p, out, seen);
    else if (isFile) out.push(p);
  }
  return out;
}

const allDiskFiles = walk(path.join(ROOT, 'Assets'));
const relDiskFiles = allDiskFiles.map(p => slash(path.relative(ROOT, p)));
const diskExact = new Set(relDiskFiles);
const diskLower = new Map(relDiskFiles.map(p => [p.toLowerCase(), p]));

// Raw m_Script GUID grep, intentionally independent of idx.scriptRefs.
const yamlScriptRefs = new Map();
const scriptRe = /m_Script:\s*\{[^}\r\n]*guid:\s*([0-9a-f]{32})[^}\r\n]*\}/g;
for (const p of allDiskFiles) {
  if (p.endsWith('.meta')) continue;
  let b;
  try { b = fs.readFileSync(p); } catch { continue; }
  if (b.includes(0)) continue;
  const text = b.toString('latin1');
  let m;
  while ((m = scriptRe.exec(text))) {
    const g = m[1].toLowerCase();
    if (!yamlScriptRefs.has(g)) yamlScriptRefs.set(g, new Set());
    yamlScriptRefs.get(g).add(slash(path.relative(ROOT, p)));
  }
}

// A: reproduce only the documented filename candidate selection, then validate
// the chosen file against Roslyn declarations and public impact output.
const types = [...idx.symbols.typeByFullName.values()];
const csAssets = [...idx.guidToPath.values()].filter(p => /\.cs$/i.test(p));
const declsByPath = new Map();
for (const d of roslyn.typeDecls) {
  if (!declsByPath.has(d.path)) declsByPath.set(d.path, []);
  declsByPath.get(d.path).push(d);
}
function fileCandidates(info) {
  const short = String(info.fullName || '').split('.').pop();
  return csAssets.filter(p => p.slice(p.lastIndexOf('/') + 1) === short + '.cs');
}
function declarationMatches(info, file) {
  return (declsByPath.get(file) || []).filter(d =>
    d.name === info.name && d.ns === (info.namespace || ''));
}
const noPdb = types.filter(t => !(t.sourceFiles && t.sourceFiles[0]));
const fallbackRows = [];
for (const info of noPdb) {
  const candidates = fileCandidates(info);
  if (candidates.length !== 1) continue;
  const file = candidates[0];
  const matches = declarationMatches(info, file);
  const response = call('unity_impact_analysis', { target: info.qualifiedName || info.fullName, maxPerAxis: 200 });
  const assets = response.assets || {};
  const guid = idx.pathToGuid.get(file);
  const rawAttached = [...(yamlScriptRefs.get(guid) || [])].sort();
  const toolAttached = [...(assets.attachedTo || [])].sort();
  fallbackRows.push({
    type: info.fullName, qualifiedName: info.qualifiedName, namespace: info.namespace,
    declaringType: info.declaringType, file, declarationMatches: matches,
    toolBasis: assets.scriptAssetBasis || null, toolScriptAsset: assets.scriptAsset || null,
    rawAttached, toolAttached, attachedOmitted: assets.attachedToOmitted || 0,
    attachedEqual: JSON.stringify(rawAttached) === JSON.stringify(toolAttached)
  });
}
const shortCollisions = [...idx.symbols.typesByShortName.entries()]
  .map(([name, vals]) => ({ name, occurrences: vals.length, types: [...new Set(vals)].sort() }))
  .filter(x => x.occurrences > 1);
const roslynPartialKeys = new Set(roslyn.typeDecls.filter(d => d.partial).map(d => d.fullName));
const roslynGenericKeys = new Set(roslyn.typeDecls.filter(d => d.arity > 0).map(d => d.fullName));

// B: bridge-shaped lexical collection versus Roslyn active syntax and raw trivia.
const CONST_RE = /(?:const|static\s+readonly)\s+string\s+([A-Za-z_]\w*)\s*=\s*"([^"\r\n]*)"/g;
const LOAD_RE = /(?:Resources\s*\.\s*Load(?:All|Async)?|AssetDatabase\s*\.\s*Load(?:AssetAtPath|MainAssetAtPath|AllAssetsAtPath|AllAssetRepresentationsAtPath))\s*(?:<[^>()]*>)?\s*\(([^;)]*)\)/g;
function foldBridge(expr, consts) {
  let out = '';
  for (const raw of String(expr).split('+')) {
    const t = raw.trim();
    if (!t) return null;
    if (t.length >= 2 && t[0] === '"' && t[t.length - 1] === '"') out += t.slice(1, -1);
    else if (/^[A-Za-z_]\w*$/.test(t) && consts.has(t)) out += consts.get(t);
    else return null;
  }
  return out || null;
}
const resources = new Map();
for (const p of relDiskFiles) {
  const i = p.lastIndexOf('/Resources/');
  if (i < 0 || p.endsWith('.meta')) continue;
  const key = p.slice(i + 11).replace(/\.[^./]+$/, '').toLowerCase();
  if (!resources.has(key)) resources.set(key, []);
  resources.get(key).push(p);
}
const lexicalLoads = [];
for (const p of allDiskFiles.filter(p => /\.cs$/i.test(p))) {
  let text;
  try { text = fs.readFileSync(p, 'utf8'); } catch { continue; }
  const rel = slash(path.relative(ROOT, p));
  const consts = new Map();
  let cm; CONST_RE.lastIndex = 0;
  while ((cm = CONST_RE.exec(text))) consts.set(cm[1], cm[2]);
  let m; LOAD_RE.lastIndex = 0;
  while ((m = LOAD_RE.exec(text))) {
    const folded = foldBridge(m[1], consts);
    const kind = /Resources\s*\.\s*Load/.test(m[0]) ? 'resources-key' : 'asset-path';
    let exists = null, exactPath = null, caseMismatch = false;
    if (folded != null) {
      if (kind === 'resources-key') {
        const hits = resources.get(folded.replace(/\\/g, '/').toLowerCase()) || [];
        exists = hits.length > 0; exactPath = hits;
      } else {
        const value = folded.replace(/\\/g, '/');
        exists = diskExact.has(value);
        exactPath = diskLower.get(value.toLowerCase()) || null;
        caseMismatch = !exists && !!exactPath;
      }
    }
    lexicalLoads.push({ file: rel, line: lineOf(text, m.index), kind, expression: m[1], folded, exists, exactPath, caseMismatch, snippet: m[0] });
  }
}
const activeKeys = new Set(roslyn.loads.map(x => x.path + ':' + x.line));
const triviaByKey = new Map(roslyn.triviaLoads.map(x => [x.path + ':' + x.line, x]));
for (const x of lexicalLoads) {
  const key = x.file + ':' + x.line;
  x.syntaxClass = activeKeys.has(key) ? 'active' : (triviaByKey.get(key)?.category || 'not-in-roslyn');
}
const lexicalKeys = new Set(lexicalLoads.map(x => x.file + ':' + x.line));
const activeMisses = roslyn.loads.filter(x => !lexicalKeys.has(x.path + ':' + x.line));
const lexicalByKey = new Map(lexicalLoads.map(x => [x.file + ':' + x.line, x]));
const foldingMisses = roslyn.loads.filter(x => x.folded != null && lexicalByKey.get(x.path + ':' + x.line)?.folded == null);
const status = call('unity_index_status', {});
const reportedDangling = status.danglingLoads || [];
const danglingImpactReproductions = reportedDangling.map(d => ({
  target: d.path,
  response: call('unity_impact_analysis', { target: d.path, maxPerAxis: 200 })
}));
const danglingDiskChecks = reportedDangling.map(d => ({
  ...d,
  exactExists: d.kind === 'resources-key' ? resources.has(d.path.toLowerCase()) : diskExact.has(d.path),
  caseInsensitiveExists: d.kind === 'resources-key' ? resources.has(d.path.toLowerCase()) : diskLower.has(d.path.toLowerCase()),
  actualCasePath: d.kind === 'asset-path' ? (diskLower.get(d.path.toLowerCase()) || null) : null
}));

// C: ask the public tool about every physical line in every mapped source file.
const mappedFiles = [...idx.symbols.typesBySourceFile.keys()].filter(p => p.startsWith('Assets/') && fs.existsSync(abs(p))).sort();
const queries = [];
for (const file of mappedFiles) {
  const count = fs.readFileSync(abs(file), 'utf8').split('\n').length;
  for (let line = 1; line <= count; line++) queries.push({ file, line, message: 'independent-audit-probe' });
}
const explained = [];
for (let i = 0; i < queries.length; i += 50) {
  const response = call('unity_explain_compile_errors', { errors: queries.slice(i, i + 50), maxErrors: 50 });
  explained.push(...(response.errors || []));
}
const fieldTruth = new Map();
for (const f of roslyn.fields) {
  if (!idx.symbols.typesBySourceFile.has(f.path)) continue;
  const key = f.path + ':' + f.line;
  if (!fieldTruth.has(key)) fieldTruth.set(key, []);
  fieldTruth.get(key).push(f);
}
const predictedFields = explained.filter(e => e.lineKind === 'field-declaration');
const trueFieldLines = [...fieldTruth.keys()];
const truePositiveLines = predictedFields.filter(e => fieldTruth.has(e.file + ':' + e.line));
const falsePositiveLines = predictedFields.filter(e => !fieldTruth.has(e.file + ':' + e.line));
const hiddenFields = explained.filter(e => fieldTruth.has(e.file + ':' + e.line) && e.lineKind !== 'field-declaration');
const memberWrong = predictedFields.filter(e => {
  if (!e.member) return false;
  const truth = fieldTruth.get(e.file + ':' + e.line) || [];
  return !truth.some(f => f.name === e.member.name);
});
const disabledRangesByFile = new Map();
for (const d of (roslyn.disabledRanges || [])) {
  if (!disabledRangesByFile.has(d.path)) disabledRangesByFile.set(d.path, []);
  disabledRangesByFile.get(d.path).push(d);
}
const isDisabled = e => (disabledRangesByFile.get(e.file) || []).some(d => e.line >= d.startLine && e.line <= d.endLine);
const isNestedTruth = e => (fieldTruth.get(e.file + ':' + e.line) || []).some(f => String(f.containing || '').includes('/'));
const ctorExact = explained.filter(e => e.method && e.method.containment === 'exact' && /^\.c?ctor$/.test(e.method.name));
const nonCtorExact = explained.filter(e => e.method && e.method.containment === 'exact' && !/^\.c?ctor$/.test(e.method.name));
const countsBy = (arr, key) => Object.fromEntries([...arr.reduce((m, x) => m.set(x[key] ?? 'null', (m.get(x[key] ?? 'null') || 0) + 1), new Map())]);

const result = {
  generatedAt: new Date().toISOString(),
  indexStats: idx.stats,
  A: {
    indexedUniqueTypes: types.length,
    sourceDeclaredSyntaxTypes: roslyn.typeDecls.length,
    noPdb: noPdb.length,
    fallbackUniqueFilename: fallbackRows.length,
    fallbackCorrectDeclaration: fallbackRows.filter(x => x.declarationMatches.length > 0).length,
    fallbackWrongDeclaration: fallbackRows.filter(x => x.declarationMatches.length === 0),
    basisMismatch: fallbackRows.filter(x => x.toolBasis !== 'filename-match' || x.toolScriptAsset !== x.file),
    attachedCrossCheckTypes: fallbackRows.length,
    attachedMismatch: fallbackRows.filter(x => !x.attachedEqual),
    attachedRawTotal: fallbackRows.reduce((n, x) => n + x.rawAttached.length, 0),
    attachedToolTotal: fallbackRows.reduce((n, x) => n + x.toolAttached.length + x.attachedOmitted, 0),
    shortNameCollisionCount: shortCollisions.length,
    crossNamespaceShortNameCollisionCount: shortCollisions.filter(x => x.types.length > 1).length,
    sameFullNameDuplicateCollisionCount: shortCollisions.filter(x => x.types.length === 1).length,
    duplicateTypeEntries: idx.symbols.duplicateTypes.length,
    shortNameCollisions: shortCollisions,
    noPdbNested: noPdb.filter(x => !!x.declaringType).map(x => ({ type: x.fullName, qualifiedName: x.qualifiedName, sourceDeclared: roslyn.typeDecls.some(d => d.name === x.name && d.ns === (x.namespace || '') && d.fullName.endsWith(x.qualifiedName || '/'+x.name)), candidates: fileCandidates(x).length })),
    noPdbGeneric: noPdb.filter(x => roslynGenericKeys.has(x.fullName) || /`\d+/.test(x.fullName)).map(x => ({ type: x.fullName, qualifiedName: x.qualifiedName, candidates: fileCandidates(x).length })),
    noPdbPartial: noPdb.filter(x => roslynPartialKeys.has(x.fullName)).map(x => ({ type: x.fullName, candidates: fileCandidates(x).length })),
    fallbackRows
  },
  B: {
    tool: {
      resolved: idx.stats.pathLoadResolved, dangling: idx.stats.pathLoadUnresolved,
      dynamic: idx.stats.dynamicLoadSites, total: idx.stats.pathLoadResolved + idx.stats.pathLoadUnresolved + idx.stats.dynamicLoadSites,
      statusDangling: reportedDangling, danglingOmitted: status.danglingLoadsOmitted || 0
    },
    lexicalTotal: lexicalLoads.length,
    lexicalFolded: lexicalLoads.filter(x => x.folded != null).length,
    lexicalDynamic: lexicalLoads.filter(x => x.folded == null).length,
    syntaxClasses: countsBy(lexicalLoads, 'syntaxClass'),
    activeRoslynTotal: roslyn.loads.length,
    activeRoslynFolded: roslyn.loads.filter(x => x.folded != null).length,
    activeRoslynDynamic: roslyn.loads.filter(x => x.folded == null).length,
    activeMisses,
    activeLexicalFolded: lexicalLoads.filter(x => x.syntaxClass === 'active' && x.folded != null).length,
    activeLexicalDynamic: lexicalLoads.filter(x => x.syntaxClass === 'active' && x.folded == null).length,
    foldingMisses,
    inactiveOrCommentFalsePositives: lexicalLoads.filter(x => x.syntaxClass !== 'active'),
    lexicalDangling: lexicalLoads.filter(x => x.folded != null && !x.exists),
    danglingDiskChecks,
    danglingImpactReproductions,
    plusConcatenations: lexicalLoads.filter(x => x.expression.includes('+')),
    pathsWithSpaces: lexicalLoads.filter(x => x.folded && x.folded.includes(' ')),
    caseMismatches: lexicalLoads.filter(x => x.caseMismatch),
    resourcesCalls: lexicalLoads.filter(x => x.kind === 'resources-key')
  },
  C: {
    mappedFiles: mappedFiles.length,
    measuredLines: explained.length,
    trueFieldLines: trueFieldLines.length,
    predictedFieldLines: predictedFields.length,
    truePositiveFieldLines: truePositiveLines.length,
    falsePositiveCount: falsePositiveLines.length,
    falsePositiveDisabledCount: falsePositiveLines.filter(isDisabled).length,
    falsePositiveCtorExactCount: falsePositiveLines.filter(e => e.method && e.method.containment === 'exact' && /^\.c?ctor$/.test(e.method.name)).length,
    falsePositiveLines,
    hiddenFieldCount: hiddenFields.length,
    hiddenByLineKind: countsBy(hiddenFields, 'lineKind'),
    hiddenNestedCount: hiddenFields.filter(isNestedTruth).length,
    hiddenUnknownNestedCount: hiddenFields.filter(e => e.lineKind === 'unknown' && isNestedTruth(e)).length,
    hiddenFields,
    precision: predictedFields.length ? truePositiveLines.length / predictedFields.length : null,
    recall: trueFieldLines.length ? truePositiveLines.length / trueFieldLines.length : null,
    memberWrongCount: memberWrong.length,
    memberWrongOnTrueFieldCount: memberWrong.filter(e => fieldTruth.has(e.file + ':' + e.line)).length,
    memberWrongOnNonFieldCount: memberWrong.filter(e => !fieldTruth.has(e.file + ':' + e.line)).length,
    memberWrong,
    ctorExactLines: ctorExact.length,
    ctorExactKinds: countsBy(ctorExact, 'lineKind'),
    nonCtorExactLines: nonCtorExact.length,
    nonCtorExactKinds: countsBy(nonCtorExact, 'lineKind'),
    lineKinds: countsBy(explained, 'lineKind')
  }
};
fs.writeFileSync(OUT, JSON.stringify(result, null, 2));
console.log(JSON.stringify({
  A: { noPdb: result.A.noPdb, fallback: result.A.fallbackUniqueFilename, wrong: result.A.fallbackWrongDeclaration.length, attachedMismatch: result.A.attachedMismatch.length },
  B: { tool: result.B.tool, active: result.B.activeRoslynTotal, activeFolded: result.B.activeRoslynFolded, activeMisses: result.B.activeMisses.length, falsePositives: result.B.inactiveOrCommentFalsePositives.length },
  C: { files: result.C.mappedFiles, lines: result.C.measuredLines, trueFields: result.C.trueFieldLines, predicted: result.C.predictedFieldLines, fp: result.C.falsePositiveCount, hidden: result.C.hiddenFieldCount, precision: result.C.precision, recall: result.C.recall, memberWrong: result.C.memberWrongCount }
}, null, 2));
