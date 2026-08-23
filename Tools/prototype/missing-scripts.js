const fs=require('fs'), path=require('path');
const ROOT=process.argv[2];
const YE=new Set(['.prefab','.unity','.asset','.mat','.controller','.anim']);

function timed(label, fn){ const t=Date.now(); const r=fn(); console.log(`  ${label.padEnd(42)} ${String(Date.now()-t).padStart(6)} ms`); return r; }

const GRE=/^guid:\s*([0-9a-f]{32})\s*$/m;
function metaGuids(roots){
  const set=new Set();
  for(const root of roots){
    (function w(d){ let e; try{e=fs.readdirSync(d,{withFileTypes:true})}catch{return}
      for(const x of e){ const p=path.join(d,x.name);
        if(x.isDirectory()) w(p);
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
      if(x.isDirectory()) w(p);
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
