// Phase 1.5 근거용 프로토타입: 에디터 밖에서 직렬화 데이터 인덱스를 만들 수 있는가, 얼마나 걸리는가.
// Unity API 를 전혀 쓰지 않는다 — .meta / YAML 텍스트만 읽는다.
const fs = require('fs'), path = require('path');
const ROOT = process.argv[2];
if (!ROOT) {
  console.error('사용법: node index-prototype.js <프로젝트 경로>');
  console.error('예:     node index-prototype.js C:/Unity/MainProject');
  console.error('       node index-prototype.js C:/Unity/MainProject --all   (PackageCache 포함)');
  process.exit(2);
}
const ASSETS = path.join(ROOT, 'Assets');

const YAML_EXT = new Set(['.prefab', '.unity', '.asset', '.mat', '.controller', '.anim']);
const t0 = Date.now();

// ── 1) 전체 파일 목록 (한 번의 재귀)
//
// ⚠️ 2026-08-27 수정. 여기 두 줄이 조용히 깨져 있었다:
//   1) `(function walkAll(){...})` 에 **호출 괄호가 없어** 실행되지 않았다
//   2) 그 아래 `walkDir(r)` 는 **정의된 적 없는 함수**인데 `try{}catch{}` 가
//      ReferenceError 를 삼켰다
// 결과: Packages 와 Library/PackageCache 를 한 번도 훑지 않고 Assets 만 봤다.
// 그래서 이 스크립트가 내던 수치가 출하 인덱스와 크게 달랐다 —
// meta 2,037 / YAML 783 / 엣지 4,355 (출하: 3,142 / 1,171 / 6,305).
// README 의 2026-08-23 표는 **이 버그가 있는 채로 측정된 값**이다.
// 독립 감사(Codex CLI)가 지적하고 재현했다.
const metas = [], yamls = [];
// 스코프를 고를 수 있게 한다. 출하 인덱스는 기본이 `includePackageCache: false` 이므로
// **기본값을 그것과 맞춰야** 두 수치를 나란히 놓고 비교할 수 있다(교차검증의 전제).
// `--all` 을 주면 PackageCache 까지 훑는다 — 원래 이 스크립트의 용도였던 전수 타이밍 측정이다.
const INCLUDE_PACKAGE_CACHE = process.argv.includes('--all');
const walkRoots = INCLUDE_PACKAGE_CACHE
  ? [ASSETS, path.join(ROOT, 'Packages'), path.join(ROOT, 'Library', 'PackageCache')]
  : [ASSETS, path.join(ROOT, 'Packages')];
console.log(`── 스코프: ${INCLUDE_PACKAGE_CACHE ? 'Assets + Packages + Library/PackageCache (--all)'
  : 'Assets + Packages (출하 기본값과 동일)'}`);

// ⚠️ **정션을 따라가야 한다.** `Assets/50.Art` 는 SVN 리포(`C:/svn/.../Art`)로 가는
// Windows Junction 이고, `Dirent.isDirectory()` 는 정션에 대해 **false** 를 낸다
// (`isSymbolicLink()` 가 true 다). 그래서 이 스크립트는 아트 라이브러리를 통째로
// 건너뛰고 있었다 — 실측 `.meta` 1,105개(전체 3,142개 중 35%)가 빠졌다.
// 2026-08-27 에 출하 인덱스와 수치가 안 맞아서 발견했다. `find -type f` 도 같은 이유로
// 정션을 안 따라가므로 대조군으로 쓸 때 주의할 것.
function isDirEntry(dirent, fullPath) {
  if (dirent.isDirectory()) return true;
  if (!dirent.isSymbolicLink()) return false;
  try { return fs.statSync(fullPath).isDirectory(); } catch { return false; }
}

function walk(dir) {
  let ents;
  try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of ents) {
    const p = path.join(dir, e.name);
    if (isDirEntry(e, p)) { walk(p); continue; }
    if (e.name.endsWith('.meta')) metas.push(p);
    else if (YAML_EXT.has(path.extname(e.name))) yamls.push(p);
  }
}
for (const r of walkRoots) walk(r);
const tWalk = Date.now();

// ── 2) .meta → GUID ↔ 경로 양방향
const guidToPath = new Map(), pathToGuid = new Map();
const GUID_RE = /^guid:\s*([0-9a-f]{32})\s*$/m;
for (const m of metas) {
  let head;
  try { head = fs.readFileSync(m, 'latin1').slice(0, 400); } catch { continue; }
  const g = GUID_RE.exec(head);
  if (!g) continue;
  const assetPath = path.relative(ROOT, m.slice(0, -5)).split(require('path').sep).join('/');
  guidToPath.set(g[1], assetPath);
  pathToGuid.set(assetPath, g[1]);
}
const tMeta = Date.now();

// ── 3) YAML → guid 참조 역인덱스 + m_Script 조인 후보
const refs = new Map();          // guid -> Set(참조하는 에셋 경로)
const scriptRefs = new Map();    // 스크립트 guid -> Set(붙어있는 에셋 경로)
let bytes = 0;
const ANY_GUID = /guid:\s*([0-9a-f]{32})/g;
const SCRIPT_GUID = /m_Script:\s*\{fileID:\s*\d+,\s*guid:\s*([0-9a-f]{32})/g;

for (const y of yamls) {
  let txt;
  try { txt = fs.readFileSync(y, 'latin1'); } catch { continue; }
  bytes += txt.length;
  const rel = path.relative(ROOT, y).split(require('path').sep).join('/');

  let m;
  ANY_GUID.lastIndex = 0;
  while ((m = ANY_GUID.exec(txt)) !== null) {
    let s = refs.get(m[1]); if (!s) refs.set(m[1], s = new Set());
    s.add(rel);
  }
  SCRIPT_GUID.lastIndex = 0;
  while ((m = SCRIPT_GUID.exec(txt)) !== null) {
    let s = scriptRefs.get(m[1]); if (!s) scriptRefs.set(m[1], s = new Set());
    s.add(rel);
  }
}
const tYaml = Date.now();

const mem = process.memoryUsage();
let edges = 0; for (const s of refs.values()) edges += s.size;

console.log('── 아웃프로세스 인덱스 프로토타입 (Node, Unity API 미사용) ──');
console.log(`파일 목록 수집   ${String(tWalk - t0).padStart(6)} ms   (.meta ${metas.length}, YAML ${yamls.length})`);
console.log(`.meta GUID 인덱스 ${String(tMeta - tWalk).padStart(5)} ms   GUID ${guidToPath.size}개`);
console.log(`YAML 역참조 인덱스 ${String(tYaml - tMeta).padStart(4)} ms   ${(bytes/1048576).toFixed(1)} MB 파싱`);
console.log(`──────────────────────────────────`);
console.log(`총 콜드 빌드      ${String(tYaml - t0).padStart(6)} ms`);
console.log(`역참조 엣지        ${edges}`);
console.log(`참조된 GUID        ${refs.size}`);
console.log(`m_Script 조인 후보 ${scriptRefs.size} 스크립트 GUID`);
console.log(`힙 사용            ${(mem.heapUsed/1048576).toFixed(1)} MB`);

// ── 4) 조인 질의 샘플: 스크립트 GUID → 이걸 쓰는 프리팹/씬
let sample = null, best = 0;
for (const [g, s] of scriptRefs) if (s.size > best) { best = s.size; sample = g; }
if (sample) {
  const p = guidToPath.get(sample) || '(경로 미해석)';
  console.log(`\n조인 질의 예시 — 가장 많이 쓰인 스크립트:`);
  console.log(`  ${p}`);
  console.log(`  → ${best}개 에셋에서 사용됨. 예: ${[...scriptRefs.get(sample)].slice(0,3).join(', ')}`);
}
