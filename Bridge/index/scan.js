'use strict';
// Phase 2 레이어 A + C: 직렬화 데이터 인덱스와 조인.
//
// Unity API 를 쓰지 않는다 — .meta 와 YAML 텍스트만 읽는다. Phase 1.5 에서 이 방식이
// 실제 프로젝트(115.4 MB YAML / 783 파일)를 ~420 ms 에 인덱싱함을 실측으로 확인했다.
// 같은 질의를 인에디터 AssetDatabase.GetDependencies 로 하면 1건당 2,425 ms 이고
// 그 동안 에디터 메인 스레드가 멈춘다.

const fs = require('fs');
const path = require('path');

// YAML 텍스트 직렬화를 쓰는 에셋 확장자.
// ⚠️ Force Binary 직렬화 모드 프로젝트에서는 이 스캔이 동작하지 않는다(Phase 1.5 §6).
// 텍스트 직렬화된 Unity 자산 중 `guid: <32hex>` 형태의 참조를 담는 확장자.
// 2026-08-23 실측: 이 목록이 6종이던 때 이 프로젝트에서 GUID 참조 4,550건이 인덱스 밖에
// 있었다 (.vfx 4,085 / .vfxblock 294 / .mixer 89 / .vfxoperator 80 / .lighting 1).
// 그 결과 실제로 참조되는 에셋 10건에 unity_find_references 가 totalCount: 0 을 오류도
// 경고도 없이 답했다. 목록을 늘려도 스캔 대상은 4.7 MB 만 늘어난다 (132.9 MB 대비 3.5%).
//
// 그래도 이 목록은 원리적으로 불완전하다 — 서드파티 패키지는 자기 확장자를 쓴다.
// 그래서 질의 결과가 0 일 때 이 목록을 함께 실어 "없음" 과 "안 봤음" 을 구분한다.
const YAML_EXT = new Set([
  '.prefab', '.unity', '.asset', '.mat', '.controller', '.anim',
  '.vfx', '.vfxblock', '.vfxoperator',           // VFX Graph
  '.mixer',                                      // 오디오 믹서
  '.lighting', '.giparams',                      // 라이팅
  '.overridecontroller', '.mask',                // 애니메이션
  '.physicmaterial',                             // 물리
  '.playable', '.signal',                        // 타임라인
  '.spriteatlas', '.spriteatlasv2',              // 스프라이트 아틀라스
  '.terrainlayer', '.shadervariants',
  '.preset', '.guiskin', '.fontsettings',
]);

// .meta 의 guid 는 파일 앞부분에 있다. 전체를 읽지 않고 앞 400 바이트만 본다.
const META_HEAD_BYTES = 400;
const META_GUID_RE = /^guid:\s*([0-9a-f]{32})\s*$/m;

// 임의 GUID 참조 / m_Script 참조.
// m_Script 는 "이 에셋에 이 스크립트가 붙어 있다"는 조인 키다 — Unreal 의 C++↔Blueprint 경계에 해당한다.
const ANY_GUID_RE = /guid:\s*([0-9a-f]{32})/g;
const SCRIPT_BLOCK_RE = /m_Script:\s*\{fileID:\s*(\d+),\s*guid:\s*([0-9a-f]{32})[^}]*\}/g;

/** 프로젝트 루트 기준 슬래시 경로로 정규화한다. */
function rel(root, p) {
  return path.relative(root, p).split(path.sep).join('/');
}

/**
 * 디렉터리를 재귀 순회하며 파일을 분류한다.
 * .meta 와 YAML 에셋만 수집한다. 심볼릭 링크는 따라가지 않는다(순환 방지).
 */
function collectFiles(roots) {
  const metas = [];
  const yamls = [];
  const seenDirs = new Set();
  const skipped = [];   // 따라갈 수 없던 링크 — 조용히 사라지지 않게 남긴다

  function walk(dir) {
    let real;
    try { real = fs.realpathSync(dir); } catch { return; }
    if (seenDirs.has(real)) return;   // 링크 순환 방지
    seenDirs.add(real);

    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }

    for (const e of entries) {
      const p = path.join(dir, e.name);
      // Windows 정션은 Dirent 에서 isDirectory() 거짓 / isSymbolicLink() 참으로 보고된다.
      // 두 분기가 모두 거짓이 되어 통째로 건너뛰던 것 — Unity 는 정션을 따라가므로 그 안의
      // 에셋도 엄연히 프로젝트의 일부인데 인덱스에서만 사라졌다. 아트 폴더를 외부(예:
      // OneDrive)에 두고 정션으로 붙이는 구성에서는 프로젝트의 3분의 1이 조용히 빠진다.
      // 링크 순환은 위의 realpath + seenDirs 로 이미 막혀 있어 따라가도 안전하다.
      let isDir = e.isDirectory();
      let isFile = e.isFile();
      if (!isDir && !isFile && e.isSymbolicLink()) {
        try {
          const st = fs.statSync(p);   // 링크를 따라가 실체를 본다
          isDir = st.isDirectory();
          isFile = st.isFile();
        } catch {
          skipped.push(p);             // 끊어진 링크 — 세어서 드러낸다
          continue;
        }
      }

      if (isDir) {
        walk(p);
      } else if (isFile) {
        if (e.name.endsWith('.meta')) metas.push(p);
        else if (YAML_EXT.has(path.extname(e.name).toLowerCase())) yamls.push(p);
      }
    }
  }

  for (const r of roots) walk(r);
  return { metas, yamls, skipped };
}

/**
 * .meta 스캔 → GUID ↔ 경로 양방향 인덱스.
 *
 * 스코프 주의: Phase 1.5 실측으로 Assets 만 211 ms, Library/PackageCache 를 포함하면
 * 9,614 ms (45배)였다. 호출자가 스코프를 정한다.
 */
function buildMetaIndex(root, metaFiles) {
  const guidToPath = new Map();
  const pathToGuid = new Map();

  for (const m of metaFiles) {
    let head;
    try {
      const fd = fs.openSync(m, 'r');
      const buf = Buffer.allocUnsafe(META_HEAD_BYTES);
      const n = fs.readSync(fd, buf, 0, META_HEAD_BYTES, 0);
      fs.closeSync(fd);
      head = buf.slice(0, n).toString('latin1');
    } catch { continue; }

    const match = META_GUID_RE.exec(head);
    if (!match) continue;

    // "Foo.prefab.meta" -> "Foo.prefab"
    const assetPath = rel(root, m.slice(0, -'.meta'.length));
    guidToPath.set(match[1], assetPath);
    pathToGuid.set(assetPath, match[1]);
  }

  return { guidToPath, pathToGuid };
}

/**
 * YAML 스캔 → 역참조 인덱스 + m_Script 사용처.
 *
 * refs:       참조된 GUID -> 그 GUID 를 참조하는 에셋 경로 집합
 * scriptRefs: 스크립트 GUID -> 그 스크립트가 붙은 에셋 경로 집합
 */
function buildYamlIndex(root, yamlFiles) {
  const refs = new Map();
  const scriptRefs = new Map();
  let bytesParsed = 0;
  let filesFailed = 0;

  for (const y of yamlFiles) {
    let text;
    // latin1 로 읽는다 — GUID/구조 토큰은 전부 ASCII 이고, UTF-8 디코딩 비용을 피한다.
    // (에셋 안의 한글 문자열은 여기서 해석하지 않으므로 안전하다.)
    try { text = fs.readFileSync(y, 'latin1'); } catch { filesFailed++; continue; }
    bytesParsed += text.length;

    const assetPath = rel(root, y);

    let m;
    ANY_GUID_RE.lastIndex = 0;
    while ((m = ANY_GUID_RE.exec(text)) !== null) {
      let set = refs.get(m[1]);
      if (!set) refs.set(m[1], set = new Set());
      set.add(assetPath);
    }

    SCRIPT_BLOCK_RE.lastIndex = 0;
    while ((m = SCRIPT_BLOCK_RE.exec(text)) !== null) {
      // fileID 0 은 "참조 없음"이다. Missing Script 로 오분류하면 안 된다.
      if (m[1] === '0') continue;
      let set = scriptRefs.get(m[2]);
      if (!set) scriptRefs.set(m[2], set = new Set());
      set.add(assetPath);
    }
  }

  return { refs, scriptRefs, bytesParsed, filesFailed };
}

/**
 * 전체 인덱스를 만든다.
 *
 * @param {string} root         프로젝트 루트 (Assets 의 부모)
 * @param {object} opts
 * @param {boolean} opts.includePackageCache  Library/PackageCache 도 .meta 스캔에 포함 (느리다)
 */
function buildIndex(root, opts = {}) {
  const t0 = Date.now();

  // YAML 은 Assets 만 본다. 패키지 안의 프리팹은 우리가 바꿀 대상이 아니다.
  const assetRoots = [path.join(root, 'Assets')];

  // .meta 는 참조 해석에 필요하므로 Packages 까지 본다.
  // PackageCache 는 45배 비싸므로 기본 제외 — 옵션으로만 켠다.
  const metaRoots = [path.join(root, 'Assets'), path.join(root, 'Packages')];
  if (opts.includePackageCache) metaRoots.push(path.join(root, 'Library', 'PackageCache'));

  const assetFiles = collectFiles(assetRoots);
  const metaFiles = metaRoots === assetRoots ? assetFiles : collectFiles(metaRoots);
  const tCollect = Date.now();

  const meta = buildMetaIndex(root, metaFiles.metas);
  const tMeta = Date.now();

  const yaml = buildYamlIndex(root, assetFiles.yamls);
  const tYaml = Date.now();

  let edges = 0;
  for (const s of yaml.refs.values()) edges += s.size;

  return {
    root,
    includePackageCache: !!opts.includePackageCache,
    // 'assets'  = Assets + Packages 만 스캔 (Missing Script 판정에 불충분)
    // 'full'    = PackageCache 까지 포함 (판정 가능)
    guidCoverage: opts.includePackageCache ? 'full' : 'assets',
    // 질의가 0 을 답할 때 "안 본 확장자였나" 를 판단할 근거.
    yamlExtensions: [...YAML_EXT].sort(),
    guidToPath: meta.guidToPath,
    pathToGuid: meta.pathToGuid,
    refs: yaml.refs,
    scriptRefs: yaml.scriptRefs,
    stats: {
      metaFiles: metaFiles.metas.length,
      yamlFiles: assetFiles.yamls.length,
      guids: meta.guidToPath.size,
      referencedGuids: yaml.refs.size,
      referenceEdges: edges,
      scriptGuids: yaml.scriptRefs.size,
      bytesParsed: yaml.bytesParsed,
      filesFailed: yaml.filesFailed,
      msCollect: tCollect - t0,
      msMeta: tMeta - tCollect,
      msYaml: tYaml - tMeta,
      msTotal: tYaml - t0,
    },
  };
}

/**
 * 이미 만든 인덱스에 Library/PackageCache 의 .meta GUID 를 병합한다.
 *
 * ⚠️ 왜 별도 단계인가 — Missing Script 판정에는 **전체 GUID 커버리지가 필수**다.
 *    Assets/Packages 만 스캔한 상태로 판정하면 패키지 안의 스크립트가 전부
 *    "없는 스크립트"로 잡힌다. 실측(MainProject): 89건으로 보고되지만
 *    그중 79건(참조 492건)이 PackageCache 에 실제로 존재하는 오분류였고,
 *    진짜는 10건(참조 150건)이었다.
 *
 *    반대로 이걸 항상 하면 콜드 빌드가 크게 느려진다(.meta 24,179개.
 *    실측 3.4~9.6초 — OS 파일 캐시 상태에 따라 변동). 그래서 필요할 때만 부른다.
 */
function mergePackageCacheGuids(index) {
  if (index.guidCoverage === 'full') return index;

  const t0 = Date.now();
  const pcRoot = path.join(index.root, 'Library', 'PackageCache');
  const files = collectFiles([pcRoot]);
  const extra = buildMetaIndex(index.root, files.metas);

  let added = 0;
  for (const [g, p] of extra.guidToPath) {
    if (!index.guidToPath.has(g)) {
      index.guidToPath.set(g, p);
      index.pathToGuid.set(p, g);
      added++;
    }
  }

  index.guidCoverage = 'full';
  index.stats.packageCacheMetaFiles = files.metas.length;
  index.stats.packageCacheGuidsAdded = added;
  index.stats.msPackageCache = Date.now() - t0;
  return index;
}

module.exports = { buildIndex, collectFiles, buildMetaIndex, mergePackageCacheGuids, YAML_EXT, rel };
