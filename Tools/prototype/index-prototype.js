// Phase 1.5 근거용 프로토타입: 에디터 밖에서 직렬화 데이터 인덱스를 만들 수 있는가, 얼마나 걸리는가.
// Unity API 를 전혀 쓰지 않는다 — .meta / YAML 텍스트만 읽는다.
const fs = require('fs'), path = require('path');
const ROOT = process.argv[2];
const ASSETS = path.join(ROOT, 'Assets');

const YAML_EXT = new Set(['.prefab', '.unity', '.asset', '.mat', '.controller', '.anim']);
const t0 = Date.now();

// ── 1) 전체 파일 목록 (한 번의 재귀)
const metas = [], yamls = [];
const walkRoots = [ASSETS, path.join(ROOT,'Packages'), path.join(ROOT,'Library','PackageCache')];
(function walkAll(){ for (const r of walkRoots) walk(r); })
;(function walk(dir) {
  let ents;
  try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of ents) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) { walk(p); continue; }
    if (e.name.endsWith('.meta')) metas.push(p);
    else if (YAML_EXT.has(path.extname(e.name))) yamls.push(p);
  }
})(ASSETS);
for (const r of walkRoots.slice(1)) { try { walkDir(r); } catch {} }
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
