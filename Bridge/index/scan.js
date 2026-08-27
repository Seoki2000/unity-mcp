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
const META_EXTRA_GUID_RE = /[0-9a-f]{32}/g;

// 임의 GUID 참조 / m_Script 참조.
// m_Script 는 "이 에셋에 이 스크립트가 붙어 있다"는 조인 키다 — Unreal 의 C++↔Blueprint 경계에 해당한다.
const ANY_GUID_RE = /guid:\s*([0-9a-f]{32})/g;
// `guid: <32hex>` 가 아닌 형태로 에셋을 가리키는 참조.
// 실측(2026-08-24, MainProject): VFX Graph 는 오브젝트 참조를 **YAML 문자열 안의 JSON** 으로 쓴다.
//     m_SerializableObject: '{"obj":{"fileID":2800000,"guid":"502f39c6...","type":3}}'
// TMP 폰트 에셋은 원본 폰트를 `m_SourceFontFileGUID: <32hex>` 로 가리키고,
// Addressables 는 그룹 항목을 `m_GUID: <32hex>` 로 가리킨다.
// 위 정규식은 셋 다 못 본다. 그 결과 실제로 참조되는 에셋 3건이 참조 0 으로 나왔다
// (그중 하나는 자기 SDF 에셋이 쓰는 NotoSansKR .ttf — "안 쓰이니 지워도 된다" 로 읽히는 답이다).
//
// 형태를 하나씩 추가하는 방식은 이전에 확장자 화이트리스트에서 이미 실패했다.
// 그래서 형태를 세지 않는다 — **32자리 hex 토큰 중 실제 .meta GUID 인 것**만 참조로 친다.
// 우연히 일치할 확률은 128비트 난수라 0 이고, 아닌 것(믹서 이펙트 ID, 서명 해시 등)은
// .meta 에 없으므로 저절로 걸러진다.
//
// 두 형태를 한 정규식으로 합쳐 **한 번만** 훑는다. 따로 훑으면 181 MB 를 두 번 읽는다
// (실측: 분리 515+2,000 ms → 합치면 1,957 ms).
const GUID_SCAN_RE = /guid:\s*([0-9a-f]{32})|([0-9a-f]{32})/g;
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
  const others = [];
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
        else others.push(p);   // 확장자 목록 밖 — 텍스트면 참조 스캔 대상이다(§scanOtherFiles)
      }
    }
  }

  for (const r of roots) walk(r);
  return { metas, yamls, others, skipped };
}

// 확장자 목록 밖 파일에서 참조를 찾는다.
//
// 왜 필요한가 — 화이트리스트는 원리적으로 불완전하다. 실측(2026-08-24, MainProject):
// `.shadergraph` 는 텍스처를 JSON 문자열 안의 GUID 로 참조하고(`"texture":{"guid":"…"}`),
// `.asmdef` 는 다른 어셈블리를 `"GUID:…"` 로 참조한다. 둘 다 목록 밖이라 안 보였고,
// 그 결과 **에셋 19개가 "참조 0"** 으로 답해졌다 — 셰이더 서브그래프, 텍스처, .asmdef, .hlsl.
// 목록에 확장자를 더 넣는 대응은 이미 두 번 실패했다(6종 → 24종 → 그래도 새 형태가 나왔다).
//
// 그래서 확장자로 고르지 않는다. **내용으로 고른다** — 앞 512바이트에 NUL 이 없으면 텍스트로
// 보고 훑는다. 판정이 틀리는 방향도 안전하다: 바이너리를 텍스트로 오인하면 비용만 들고,
// 텍스트를 놓치면 답이 틀린다. 비용이 틀리는 쪽으로 실패하게 둔다.
//
// 실측 비용: 1,508개 스니핑 357 ms, 그중 텍스트 816개 8.7 MB (바이너리 692개 945 MB 는 안 읽는다).
const SNIFF_BYTES = 512;
const MAX_TEXT_BYTES = 16 * 1024 * 1024;

// 경로/키로 에셋을 부르는 코드. GUID 가 아니라 **문자열**이라 참조 인덱스에 안 잡힌다.
//   Resources.Load("Prefabs/Foo")                       → Assets/**/Resources/Prefabs/Foo.*
//   AssetDatabase.LoadAssetAtPath<T>("Assets/X.prefab")  → 그 경로 그대로
//
// "정적 인덱스가 원리적으로 못 보는 축" 이라고 문서에 적어 뒀지만, 다시 재보니 **상당 부분은
// 볼 수 있었다.** 다만 리터럴만 봐서는 안 된다 — 실측(MainProject): 로드 호출 71개 중
// **인라인 리터럴은 1개뿐**이고 나머지는 경로를 `const string` 에 두고 이름으로 부른다:
//     AssetDatabase.LoadAssetAtPath<GameObject>(MainCameraPrefabPath)
//     AssetDatabase.LoadAssetAtPath<GameObject>(EntryFolder + "/FX_Hit_Spark.prefab")
// 그래서 같은 파일의 문자열 상수를 접어서 푼다. 그러자 엣지 23개가 살아났다
// (보스 프리팹, Global Volume Profile, 셰이더 — 전부 에디터 오서링 스크립트가 부르는 것).
//
// 런타임에 조립되는 것(`GUIDToAssetPath(guids[i])`, 매개변수)은 여전히 불가능하다.
// 44건이 그렇고, 그 수를 응답에 실어 "못 본 몫" 을 드러낸다.
const CONST_STRING_RE = /(?:const|static\s+readonly)\s+string\s+([A-Za-z_]\w*)\s*=\s*"([^"\r\n]*)"/g;
const LOAD_CALL_RE = /(?:Resources\s*\.\s*Load(?:All|Async)?|AssetDatabase\s*\.\s*Load(?:AssetAtPath|MainAssetAtPath|AllAssetsAtPath|AllAssetRepresentationsAtPath))\s*(?:<[^>()]*>)?\s*\(([^;)]*)\)/g;

/**
 * 로드 호출의 인자 식을 문자열로 접는다. `"a" + Const + "b"` 까지만 다룬다.
 * 못 접으면 null — 그건 세어서 드러낸다.
 */
function foldPathExpression(expr, consts) {
  const parts = String(expr).split('+');
  let out = '';
  for (let raw of parts) {
    const t = raw.trim();
    if (!t) return null;
    if (t.length >= 2 && t[0] === '"' && t[t.length - 1] === '"') { out += t.slice(1, -1); continue; }
    if (/^[A-Za-z_]\w*$/.test(t) && consts.has(t)) { out += consts.get(t); continue; }
    return null;   // 변수·메서드 호출·인덱싱 — 정적으로는 알 수 없다
  }
  return out || null;
}

/** `Assets/**\/Resources/<key>.<ext>` 를 key -> 경로들 로. Resources.Load 의 인자가 그 key 다. */
function buildResourcesMap(root, fileLists) {
  const byKey = new Map();
  for (const list of fileLists) {
    for (const f of list) {
      const p = rel(root, f);
      const i = p.lastIndexOf('/Resources/');
      if (i === -1) continue;
      if (p.endsWith('.meta')) continue;
      const after = p.slice(i + '/Resources/'.length);
      const key = after.replace(/\.[^./]+$/, '');
      let arr = byKey.get(key.toLowerCase());
      if (!arr) byKey.set(key.toLowerCase(), arr = []);
      arr.push(p);
    }
  }
  return byKey;
}

function scanOtherFiles(root, files, meta, refs, weak, resourcesMap) {
  const t0 = Date.now();
  let sniffed = 0, textFiles = 0, binaryFiles = 0, largeFiles = 0, bytes = 0, edges = 0;
  let pathLoadEdges = 0, pathLoadResolved = 0, pathLoadUnresolved = 0, dynamicLoads = 0;
  const buf = Buffer.allocUnsafe(SNIFF_BYTES);

  for (const f of files) {
    let st;
    try { st = fs.statSync(f); } catch { continue; }
    if (st.size > MAX_TEXT_BYTES) { largeFiles++; continue; }

    let n = 0;
    try {
      const fd = fs.openSync(f, 'r');
      n = fs.readSync(fd, buf, 0, SNIFF_BYTES, 0);
      fs.closeSync(fd);
    } catch { continue; }
    sniffed++;

    let isBinary = false;
    for (let i = 0; i < n; i++) if (buf[i] === 0) { isBinary = true; break; }
    if (isBinary) { binaryFiles++; continue; }

    let text;
    try { text = fs.readFileSync(f, 'latin1'); } catch { continue; }
    textFiles++;
    bytes += text.length;

    const assetPath = rel(root, f);
    const ownGuid = meta.pathToGuid.get(assetPath);
    GUID_SCAN_RE.lastIndex = 0;
    let m;
    while ((m = GUID_SCAN_RE.exec(text)) !== null) {
      const g = m[1] !== undefined ? m[1] : m[2];
      if (g === ownGuid) continue;
      // 여기서는 두 형태 모두 실제 .meta GUID 인 것만 인정한다. 이 파일들은 Unity 직렬화가
      // 아니라 임의 텍스트라(소스코드·문서 포함) 형태만으로는 참조인지 알 수 없다.
      if (!meta.guidToPath.has(g)) continue;
      let set = refs.get(g);
      if (!set) refs.set(g, set = new Set());
      if (!set.has(assetPath)) { set.add(assetPath); edges++; }
      // 여기서 나온 엣지는 **직렬화 구조가 아니라 텍스트 일치**다. 소스코드·문서·그래프
      // JSON 어디든 32자리 hex 가 있으면 잡힌다. 대부분 진짜 참조지만(셰이더그래프의
      // 텍스처, asmdef 의 의존), 원리적으로는 GUID 를 그냥 적어둔 문자열일 수도 있다.
      // 그래서 세기만 하지 않고 **어느 엣지가 그런 것인지** 남겨 응답에서 구분한다.
      let w = weak.get(g);
      if (!w) weak.set(g, w = new Set());
      w.add(assetPath);
    }

    // 경로/키 로드는 소스 파일에서만 의미가 있다.
    if (resourcesMap && /\.cs$/i.test(assetPath)) {
      const addEdge = (targetPath) => {
        const g = meta.pathToGuid.get(targetPath);
        if (!g) return false;
        let set = refs.get(g);
        if (!set) refs.set(g, set = new Set());
        if (!set.has(assetPath)) { set.add(assetPath); pathLoadEdges++; }
        return true;
      };

      // 같은 파일의 문자열 상수를 먼저 모은다.
      const consts = new Map();
      CONST_STRING_RE.lastIndex = 0;
      let cm;
      while ((cm = CONST_STRING_RE.exec(text)) !== null) consts.set(cm[1], cm[2]);

      const isResourcesCall = /Resources\s*\.\s*Load/;
      let mm;
      LOAD_CALL_RE.lastIndex = 0;
      while ((mm = LOAD_CALL_RE.exec(text)) !== null) {
        const folded = foldPathExpression(mm[1], consts);
        if (folded === null) { dynamicLoads++; continue; }
        const value = folded.replace(/\\/g, '/');

        let hit = false;
        if (isResourcesCall.test(mm[0])) {
          // Resources.Load 의 인자는 확장자 없는 키다.
          const hits = resourcesMap.get(value.toLowerCase());
          if (hits) for (const h of hits) { addEdge(h); hit = true; }
        } else {
          hit = addEdge(value);
        }
        if (hit) pathLoadResolved++; else pathLoadUnresolved++;
      }
    }
  }

  return { sniffed, textFiles, binaryFiles, largeFiles, bytes, edges,
           pathLoadEdges, pathLoadResolved, pathLoadUnresolved, dynamicLoads,
           ms: Date.now() - t0 };
}

/**
 * .meta 스캔 → GUID ↔ 경로 양방향 인덱스.
 *
 * 스코프 주의: Phase 1.5 실측으로 Assets 만 211 ms, Library/PackageCache 를 포함하면
 * 9,614 ms (45배)였다. 호출자가 스코프를 정한다.
 */
function buildMetaIndex(root, metaFiles, opts = {}) {
  const guidToPath = new Map();
  const pathToGuid = new Map();
  // 참조를 담고 있는 .meta 의 본문. 아래 §buildIndex 에서 엣지로 바꾼다.
  const withRefs = [];
  const collectRefs = opts.collectRefs !== false;

  for (const m of metaFiles) {
    let text;
    try {
      if (!collectRefs) {
        // 자기 guid 만 필요할 때는 앞부분만 읽는다(PackageCache 2만 개를 훑는 경로).
        const fd = fs.openSync(m, 'r');
        const buf = Buffer.allocUnsafe(META_HEAD_BYTES);
        const n = fs.readSync(fd, buf, 0, META_HEAD_BYTES, 0);
        fs.closeSync(fd);
        text = buf.slice(0, n).toString('latin1');
      } else {
        // 전체를 읽는다. 실측(MainProject): .meta 3,142개 합계 3.5 MB / 314 ms.
        text = fs.readFileSync(m, 'latin1');
      }
    } catch { continue; }

    const match = META_GUID_RE.exec(text);
    if (!match) continue;

    // "Foo.prefab.meta" -> "Foo.prefab"
    const assetPath = rel(root, m.slice(0, -'.meta'.length));
    guidToPath.set(match[1], assetPath);
    pathToGuid.set(assetPath, match[1]);

    // ⚠️ .meta 도 다른 에셋을 참조한다 — 인덱스는 오랫동안 이걸 출처로 보지 않았다.
    // 실측(2026-08-24, MainProject): FBX 임포터의 externalObjects 가 머티리얼을
    // `second: {fileID: 2100000, guid: …}` 로 물고 있고, 아바타 소스/스프라이트도 같다.
    // 참조 130건 / 대상 41개이며, 그중 **18개는 다른 어디에서도 참조되지 않아**
    // unity_find_references 가 "참조 0" 을 답하고 있었다(모델에 물린 머티리얼들).
    // 지우면 임포트한 모델의 머티리얼 할당이 깨진다.
    if (collectRefs) {
      // 자기 guid 말고 다른 32자리 hex 가 또 있는지만 싸게 본다.
      META_EXTRA_GUID_RE.lastIndex = 0;
      let count = 0;
      while (META_EXTRA_GUID_RE.exec(text) !== null) { if (++count > 1) break; }
      if (count > 1) withRefs.push({ assetPath, ownGuid: match[1], text });
    }
  }

  return { guidToPath, pathToGuid, withRefs };
}

/**
 * YAML 스캔 → 역참조 인덱스 + m_Script 사용처.
 *
 * refs:       참조된 GUID -> 그 GUID 를 참조하는 에셋 경로 집합
 * scriptRefs: 스크립트 GUID -> 그 스크립트가 붙은 에셋 경로 집합
 */
function buildYamlIndex(root, yamlFiles, meta) {
  const knownGuids = meta && meta.guidToPath ? meta.guidToPath : null;
  const pathToGuid = meta && meta.pathToGuid ? meta.pathToGuid : null;
  const refs = new Map();
  const scriptRefs = new Map();
  // 인스펙터 배선(UnityEvent)을 담은 파일. 여기서는 경로만 모은다 — 값 해석에는 심볼
  // 인덱스가 필요한데 그건 아직 없다. 이 패스에서 텍스트를 이미 들고 있으므로
  // 판별 비용이 사실상 0 이다(부분 문자열 검사 한 번).
  const eventFiles = [];
  // 어셈블리 수식 타입 이름(`Type, Assembly, Version=…`)을 담은 파일. 같은 이유로 여기서 고른다.
  const typeRefFiles = [];
  let bytesParsed = 0;
  let filesFailed = 0;
  let bareEdges = 0;

  for (const y of yamlFiles) {
    let text;
    // latin1 로 읽는다 — GUID/구조 토큰은 전부 ASCII 이고, UTF-8 디코딩 비용을 피한다.
    // (에셋 안의 한글 문자열은 여기서 해석하지 않으므로 안전하다.)
    try { text = fs.readFileSync(y, 'latin1'); } catch { filesFailed++; continue; }
    bytesParsed += text.length;

    const assetPath = rel(root, y);
    // 에셋이 **자기 GUID** 를 본문에 적어두는 경우가 있다(BroAudio 의 _assetGUID,
    // TMP 폰트 에셋 등). 그걸 참조 엣지로 세면 "이 에셋을 참조하는 것 1건" 이 되어
    // 아무도 안 쓰는 에셋이 쓰이는 것처럼 보인다 — 자기 자신은 참조가 아니다.
    // 실측(2026-08-24): 맨 GUID 스캔을 넣자 이런 자기 참조가 4건 생겼다.
    const ownGuid = pathToGuid ? pathToGuid.get(assetPath) : null;

    // 이 파일 안에서 어떤 형태로 봤는지. `guid:` 로도 나온 GUID 는 맨 형태로 또 나와도
    // 새로 얻은 것이 아니다 — 그걸 구분해야 "맨 형태 덕분에 늘어난 엣지" 수가 정직해진다.
    const prefixed = new Set();
    const bareOnly = new Set();

    let m;
    GUID_SCAN_RE.lastIndex = 0;
    while ((m = GUID_SCAN_RE.exec(text)) !== null) {
      let g = m[1];
      if (g !== undefined && g === ownGuid) continue;   // 자기 자신
      if (g === undefined) {
        // `guid:` 접두가 없는 형태 — 실제 에셋 GUID 인 것만 인정한다(위 주석 참조).
        g = m[2];
        if (g === ownGuid) continue;                    // 자기 자신
        if (!knownGuids || !knownGuids.has(g)) continue;
        if (!prefixed.has(g)) bareOnly.add(g);
      } else {
        prefixed.add(g);
        bareOnly.delete(g);
      }
      let set = refs.get(g);
      if (!set) refs.set(g, set = new Set());
      set.add(assetPath);
    }
    bareEdges += bareOnly.size;

    if (text.indexOf('m_PersistentCalls') !== -1) eventFiles.push(y);
    if (text.indexOf('Version=') !== -1) typeRefFiles.push(y);

    SCRIPT_BLOCK_RE.lastIndex = 0;
    while ((m = SCRIPT_BLOCK_RE.exec(text)) !== null) {
      // fileID 0 은 "참조 없음"이다. Missing Script 로 오분류하면 안 된다.
      if (m[1] === '0') continue;
      let set = scriptRefs.get(m[2]);
      if (!set) scriptRefs.set(m[2], set = new Set());
      set.add(assetPath);
    }
  }

  return { refs, scriptRefs, bytesParsed, filesFailed, bareEdges, eventFiles, typeRefFiles };
}

/**
 * 전체 인덱스를 만든다.
 *
 * @param {string} root         프로젝트 루트 (Assets 의 부모)
 * @param {object} opts
 * @param {boolean} opts.includePackageCache  Library/PackageCache 도 .meta 스캔에 포함 (느리다)
 */
// 캐시가 지금 디스크 상태와 맞는지 판단할 지문.
// 캐시 검사가 version 과 root 만 보고 있었다 — 에셋이 바뀌어도 낡은 답을 조용히 계속 냈다.
// 완전한 증분 갱신은 아니다. 어긋난 것을 감지해 전체 재빌드로 넘기는 것이 목적이다
// (전체 재빌드가 이 프로젝트에서 1.1 초라 그 편이 단순하고 확실하다).
// 파일 하나의 (mtime, size) 를 32비트로 접는다. 합으로 누적하므로 순서에 무관하다
// (readdir 순서는 파일시스템이 정하는 것이라 의존하면 안 된다).
function foldFile(mtimeMs, size) {
  let x = (Math.floor(mtimeMs) ^ Math.imul(size, 2654435761)) | 0;
  x = (x ^ (x >>> 15)) | 0;
  return x;
}

/**
 * 컴파일 산출물(`Library/ScriptAssemblies`)의 서명.
 *
 * 왜 전체 지문과 따로 두는가 — fingerprint() 는 5,825 파일을 stat 해서 실측 **약 690 ms** 다.
 * 웜 질의가 48 ms 이므로 매 호출에 붙일 수 없다. 그런데 심볼·호출그래프 레이어는
 * 오직 이 디렉터리의 DLL/PDB 에서 나오고, 그게 낡는 사건은 **재컴파일** 하나다.
 * 여기만 보면 378 파일 / 실측 **15 ms** 라 매 호출에 붙일 수 있다.
 *
 * 에셋 쪽 낡음은 이걸로 안 잡힌다 — 그건 throttle 된 fingerprint() 가 맡는다.
 */
function assemblySignature(root) {
  const dir = path.join(root, 'Library', 'ScriptAssemblies');
  let names;
  try { names = fs.readdirSync(dir); }
  catch { return { files: 0, maxMtimeMs: 0, totalBytes: 0, hash: 0, missing: true }; }

  let maxMtimeMs = 0, totalBytes = 0, files = 0, hash = 0;
  for (const n of names) {
    try {
      const st = fs.statSync(path.join(dir, n));
      if (!st.isFile()) continue;
      if (st.mtimeMs > maxMtimeMs) maxMtimeMs = st.mtimeMs;
      totalBytes += st.size;
      hash = (hash + foldFile(st.mtimeMs, st.size)) | 0;
      files++;
    } catch { /* 사라진 파일 — files 개수 차이로 잡힌다 */ }
  }
  return { files, maxMtimeMs: Math.round(maxMtimeMs), totalBytes, hash, missing: false };
}

/** 두 서명이 같은 컴파일 세대인가. 어느 쪽이라도 없으면 "모른다" 이므로 다르다고 본다. */
function sameAssemblySignature(a, b) {
  if (!a || !b) return false;
  return a.files === b.files && a.totalBytes === b.totalBytes &&
         a.hash === b.hash && a.maxMtimeMs === b.maxMtimeMs;
}

const NL_RE = new RegExp("\\r?\\n");
const ENABLED_RE = new RegExp("^\\s*-\\s*enabled:\\s*(\\d)");
const PATH_RE = new RegExp("^\\s*path:\\s*(.+?)\\s*$");

/**
 * `ProjectSettings/EditorBuildSettings.asset` 의 빌드 씬 목록.
 *
 * 왜 여기 있나 — `impact.js` 와 `projectmap.js` 에 **글자 그대로 같은 구현**이 있었다
 * (18줄 / 19줄, 임시 경로 변수 하나만 달랐다). 빌드 씬 판정은 "이 씬이 실제로 빌드에
 * 들어가나" 라는 답의 근거이므로, 두 도구가 서로 다르게 읽기 시작하면 같은 프로젝트에
 * 대해 다른 답이 나간다.
 *
 * 읽을 수 없으면 **null** 이다 — 빈 배열로 돌려주면 "빌드 씬이 없다" 로 읽힌다.
 */
function readBuildScenes(root) {
  const p = path.join(root, 'ProjectSettings', 'EditorBuildSettings.asset');
  let text;
  try { text = fs.readFileSync(p, 'utf8'); } catch { return null; }

  const out = [];
  let enabled = null;
  for (const line of text.split(NL_RE)) {
    let m = ENABLED_RE.exec(line);
    if (m) { enabled = m[1] === '1'; continue; }
    m = PATH_RE.exec(line);
    if (m && enabled !== null) {
      if (m[1]) out.push({ index: out.length, path: m[1], enabled });
      enabled = null;
    }
  }
  return out;
}

function fingerprintFrom(metaFiles, yamlFiles, otherFiles) {
  let maxMtimeMs = 0;
  let totalBytes = 0;
  let counted = 0;
  // 최댓값 mtime 만으로는 부족하다. 실측(2026-08-23): 가장 새로운 파일보다 오래된 파일의
  // mtime 을 바꿔도 max 는 그대로여서 감지되지 않았다. 파일별 해시를 합산해야 어느 파일이
  // 어느 방향으로 바뀌어도 지문이 달라진다.
  let hash = 0;
  // otherFiles 를 빼면 .shadergraph/.asmdef 가 바뀌어도 캐시가 낡은 줄 모른다 —
  // 이제 그 파일들도 참조 출처이므로 지문에 들어가야 한다.
  for (const list of [metaFiles, yamlFiles, otherFiles || []]) {
    for (const f of list) {
      try {
        const st = fs.statSync(f);
        if (st.mtimeMs > maxMtimeMs) maxMtimeMs = st.mtimeMs;
        totalBytes += st.size;
        hash = (hash + foldFile(st.mtimeMs, st.size)) | 0;
        counted++;
      } catch { /* 사라진 파일 — 개수 차이로 잡힌다 */ }
    }
  }
  return {
    metaFiles: metaFiles.length,
    yamlFiles: yamlFiles.length,
    otherFiles: otherFiles ? otherFiles.length : 0,
    counted,
    maxMtimeMs: Math.round(maxMtimeMs),
    totalBytes,
    hash,
  };
}

/** 인덱스를 만들지 않고 지문만 계산한다. 캐시 유효성 검사용. */
function fingerprint(root, opts = {}) {
  // buildIndex 와 **같은 루트**여야 한다. 다르면 ProjectSettings 변경이 지문에 안 잡혀
  // 낡은 캐시를 계속 서빙한다(빌드 씬 목록을 바꿔도 인덱스가 모른다).
  const assetRoots = [path.join(root, 'Assets'), path.join(root, 'ProjectSettings')];
  const metaRoots = [path.join(root, 'Assets'), path.join(root, 'Packages')];
  if (opts.includePackageCache) metaRoots.push(path.join(root, 'Library', 'PackageCache'));
  const assetFiles = collectFiles(assetRoots);
  const metaFiles = collectFiles(metaRoots);
  return fingerprintFrom(metaFiles.metas, assetFiles.yamls, assetFiles.others);
}

function buildIndex(root, opts = {}) {
  const t0 = Date.now();

  // YAML 은 Assets 만 본다. 패키지 안의 프리팹은 우리가 바꿀 대상이 아니다.
  //
  // 예외: `ProjectSettings` 는 **참조 출처로** 본다. 여기 있는 `.asset` 들이 Assets 의
  // GUID 를 가리키는데 스캔 루트 밖이라 인덱스에 없었다. 실측(2026-08-26): 스캔에 들어온
  // 파일 27개에서 엣지 38개, 그중 프로젝트 에셋 대상 19개(씬 13 / 비-씬 6),
  // 나머지는 패키지·빌트인 GUID 다. `EditorBuildSettings` 하나가 엣지 18개를 낸다
  // (m_Scenes 항목은 14개이고, 그중 인덱스에서 경로가 풀리는 것이 13개다).
  // 결과: `unity_find_references('Assets/0.Scenes/MainFlow/0.BootStrapScene.unity')` 가
  // "참조 1건" 을 답한다 — **빌드 0번 씬인데** 빌드 설정이 참조한다는 사실이 빠진 채로.
  // 삭제·이름변경 판단에 쓰이는 도구에서 이건 §4-(21) 과 같은 형태의 오답이다.
  // 비용은 파일 31개 — 무시할 수 있다.
  const assetRoots = [path.join(root, 'Assets'), path.join(root, 'ProjectSettings')];

  // .meta 는 참조 해석에 필요하므로 Packages 까지 본다.
  // PackageCache 는 45배 비싸므로 기본 제외 — 옵션으로만 켠다.
  const metaRoots = [path.join(root, 'Assets'), path.join(root, 'Packages')];
  if (opts.includePackageCache) metaRoots.push(path.join(root, 'Library', 'PackageCache'));

  const assetFiles = collectFiles(assetRoots);
  const metaFiles = metaRoots === assetRoots ? assetFiles : collectFiles(metaRoots);
  const tCollect = Date.now();

  const meta = buildMetaIndex(root, metaFiles.metas);
  const tMeta = Date.now();

  // .meta 인덱스를 먼저 만들고 그 GUID 집합을 넘긴다 — 맨 GUID 토큰을 걸러낼 기준이 된다.
  const yaml = buildYamlIndex(root, assetFiles.yamls, meta);
  const tYaml = Date.now();

  // .meta 안의 참조를 엣지로 바꾼다. 출처는 .meta 가 아니라 **그 .meta 가 설명하는 에셋**이다
  // ("Boss_23_base.mat 을 SK_23.fbx 가 참조한다" 가 읽는 쪽에 맞는 문장이다).
  let metaEdges = 0;
  for (const mr of meta.withRefs) {
    GUID_SCAN_RE.lastIndex = 0;
    let mm;
    while ((mm = GUID_SCAN_RE.exec(mr.text)) !== null) {
      const g = mm[1] !== undefined ? mm[1] : mm[2];
      if (g === mr.ownGuid) continue;                 // 자기 자신
      if (!meta.guidToPath.has(g)) continue;          // 프로젝트 밖/내장 — 경로로 못 바꾼다
      let set = yaml.refs.get(g);
      if (!set) yaml.refs.set(g, set = new Set());
      if (!set.has(mr.assetPath)) { set.add(mr.assetPath); metaEdges++; }
    }
  }

  // 확장자 목록 밖 텍스트 파일(.shadergraph/.asmdef/.cs 등)에서도 참조를 찾는다.
  const weakRefs = new Map();
  const resourcesMap = buildResourcesMap(root, [assetFiles.others, assetFiles.yamls]);
  const other = scanOtherFiles(root, assetFiles.others, meta, yaml.refs, weakRefs, resourcesMap);

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
    // 캐시 유효성 검사용. 여기서 계산해 두면 저장 시 다시 훑지 않는다.
    fingerprint: fingerprintFrom(metaFiles.metas, assetFiles.yamls, assetFiles.others),
    guidToPath: meta.guidToPath,
    pathToGuid: meta.pathToGuid,
    // 인스펙터 배선 해석에 쓸 파일 목록(경로만).
    eventFiles: yaml.eventFiles,
    typeRefFiles: yaml.typeRefFiles,
    refs: yaml.refs,
    // 텍스트 일치로만 얻은 엣지(직렬화 구조가 아님). 응답에서 구분해 싣는다.
    weakRefs,
    scriptRefs: yaml.scriptRefs,
    stats: {
      metaFiles: metaFiles.metas.length,
      yamlFiles: assetFiles.yamls.length,
      // 그중 `ProjectSettings` 에서 온 것. Assets 기준 숫자(1,144)와 비교 가능하게 따로 센다.
      settingsFiles: assetFiles.yamls.filter(p => p.indexOf('ProjectSettings') >= 0).length,
      guids: meta.guidToPath.size,
      referencedGuids: yaml.refs.size,
      referenceEdges: edges,
      scriptGuids: yaml.scriptRefs.size,
      // `guid:` 접두 없이 발견한 참조 엣지 수(JSON 내장, m_SourceFontFileGUID 등).
      bareGuidEdges: yaml.bareEdges,
      // .meta(임포터 설정)에서만 나온 참조 엣지 수. FBX 의 externalObjects 등.
      metaRefEdges: metaEdges,
      metaFilesWithRefs: meta.withRefs.length,
      // 확장자 목록 밖 텍스트 파일에서 얻은 엣지와 그 비용.
      otherTextFiles: other.textFiles,
      otherBinarySkipped: other.binaryFiles,
      otherLargeSkipped: other.largeFiles,
      otherRefEdges: other.edges,
      // 코드가 경로/키로 부르는 에셋. 리터럴만 해석된다 — 조립된 경로는 dynamicLoadSites 로 센다.
      pathLoadEdges: other.pathLoadEdges,
      pathLoadResolved: other.pathLoadResolved,
      pathLoadUnresolved: other.pathLoadUnresolved,
      dynamicLoadSites: other.dynamicLoads,
      resourcesKeys: resourcesMap.size,
      msOther: other.ms,
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
  const extra = buildMetaIndex(index.root, files.metas, { collectRefs: false });

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

module.exports = {
  buildIndex, collectFiles, buildMetaIndex, buildYamlIndex, mergePackageCacheGuids,
  fingerprint, fingerprintFrom, assemblySignature, sameAssemblySignature, readBuildScenes, YAML_EXT, rel,
};
