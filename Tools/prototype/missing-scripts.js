const fs=require('fs'), path=require('path');
const ROOT=process.argv[2];
if(!ROOT){
  console.error('사용법: node missing-scripts.js <프로젝트 경로>');
  console.error('예:     node missing-scripts.js C:/Unity/MainProject');
  console.error('인자를 빼면 예전에는 path.join 안에서 의미불명한 TypeError 로 죽었다.');
  process.exit(2);
}
// ⚠️ 확장자 화이트리스트다. 출하 인덱스는 2026-08-24 에 이 방식을 버리고 **내용 스니핑**
// (앞 512바이트에 NUL 이 없으면 텍스트로 본다)으로 갔다. 그래서 두 수치가 다르고,
// 그 차이가 곧 이 목록의 한계다 — prototype/README.md 의 대조 표를 볼 것.
const YE=new Set(['.prefab','.unity','.asset','.mat','.controller','.anim']);

function timed(label, fn){ const t=Date.now(); const r=fn(); console.log(`  ${label.padEnd(42)} ${String(Date.now()-t).padStart(6)} ms`); return r; }

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

const GRE=/^guid:\s*([0-9a-f]{32})\s*$/m;
function metaGuids(roots){
  const set=new Set();
  for(const root of roots){
    (function w(d){ let e; try{e=fs.readdirSync(d,{withFileTypes:true})}catch{return}
      for(const x of e){ const p=path.join(d,x.name);
        if(isDirEntry(x,p)) w(p);
        else if(x.name.endsWith('.meta')){ let h; try{h=fs.readFileSync(p,'latin1').slice(0,400)}catch{continue}
          const m=GRE.exec(h); if(m) set.add(m[1]); } } })(path.join(ROOT,root));
  }
  return set;
}

console.log('── .meta 스캔 범위별 비용 ──');
const assetsOnly = timed('Assets 만',                 ()=>metaGuids(['Assets']));
const withPkgs   = timed('Assets + Packages',          ()=>metaGuids(['Assets','Packages']));
const withCache  = timed('Assets + Packages + PackageCache', ()=>metaGuids(['Assets','Packages','Library/PackageCache']));
console.log(`  GUID 수: Assets ${assetsOnly.size} / +Packages ${withPkgs.size} / +PackageCache ${withCache.size}`);
console.log('');

// m_Script 블록 단위로 guid + m_EditorClassIdentifier 를 함께 뽑는다
const BLOCK=/m_Script:\s*\{fileID:\s*\d+,\s*guid:\s*([0-9a-f]{32})[\s\S]{0,400}?m_EditorClassIdentifier:\s*([^\r\n]*)/g;
const usage=new Map(), ident=new Map();
timed('Assets YAML 파싱 (m_Script + 식별자)', ()=>{
  (function w(d){ let e; try{e=fs.readdirSync(d,{withFileTypes:true})}catch{return}
    for(const x of e){ const p=path.join(d,x.name);
      if(isDirEntry(x,p)) w(p);
      else if(YE.has(path.extname(x.name))){ let t; try{t=fs.readFileSync(p,'latin1')}catch{continue}
        const rel=path.relative(ROOT,p).split(path.sep).join('/');
        let m; BLOCK.lastIndex=0;
        while((m=BLOCK.exec(t))!==null){
          let s=usage.get(m[1]); if(!s) usage.set(m[1], s=new Set()); s.add(rel);
          const id=(m[2]||'').trim(); if(id && !ident.has(m[1])) ident.set(m[1], id);
        } } } })(path.join(ROOT,'Assets'));
});

const missing=[...usage.keys()].filter(g=>!withCache.has(g));
let files=new Set(), refs=0;
for(const g of missing){ refs+=usage.get(g).size; for(const a of usage.get(g)) files.add(a); }
console.log('');
console.log(`── Missing Script (참조되지만 .meta 가 없는 스크립트) ──`);
console.log(`  GUID ${missing.length}개 / 영향 에셋 ${files.size}개 / 참조 ${refs}건`);
const rows=missing.map(g=>({g,n:usage.get(g).size,id:ident.get(g)||'(식별자 미기록)'})).sort((a,b)=>b.n-a.n);
for(const r of rows) console.log(`  ${String(r.n).padStart(4)}건  ${r.g.slice(0,8)}…  ${r.id}`);
