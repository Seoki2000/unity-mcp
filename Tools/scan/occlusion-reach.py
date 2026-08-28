# -*- coding: utf-8 -*-
"""
A군(오클루전 3개) Missing Script 의 규모와 게임 경로 영향을 Unity 없이 재는 스크립트.
HANDOFF.md §5 / §4-(44) 의 수치를 만든 것이 이 파일이다.

  python Tools/scan/occlusion-reach.py

네 가지를 답한다.
  1. 규모 — (에셋,GUID) 쌍(= 도구의 totalReferenceCount) 과 실제 컴포넌트 인스턴스 수
  2. 씬이 이 프리팹들을 직접 참조하는가
  3. 씬에서 GUID 를 따라 전이(BFS)로 도달하는가
  4. Addressables 그룹에 올라 있는가

콘솔이 cp949 라도 깨지지 않게 stdout 을 utf-8 로 바꾼다.
"""
import os, re, sys, collections

try:
    sys.stdout.reconfigure(encoding="utf-8")
except Exception:
    pass

PROJECT = os.environ.get("UNITY_PROJECT", r"C:/Unity/MainProject")
ASSETS = os.path.join(PROJECT, "Assets").replace("\\", "/")
ADDR = os.path.join(ASSETS, "AddressableAssetsData/AssetGroups").replace("\\", "/")

MISS = {
    "010b78ca8837feb48bc4bc32f6ff5804": "OcclusionSection",
    "5caf0a47863f037419a872370a7d1807": "ElevationLevel",
    "90be40df8f94dcf43a5d9aab5923965d": "ElevationStack",
}
GUID_RE = re.compile(r"guid:\s*([0-9a-f]{32})")
SCAN_EXT = (".prefab", ".unity", ".asset", ".mat", ".controller", ".playable", ".overrideController")


def read(p):
    try:
        return open(p, encoding="utf-8", errors="replace").read()
    except Exception:
        return ""


def main():
    # .meta 를 훑어 guid -> path. Assets/50.Art 는 정션이지만 os.walk 는 따라간다
    guid2path = {}
    for dp, dn, fn in os.walk(ASSETS):
        for f in fn:
            if not f.endswith(".meta"):
                continue
            m = GUID_RE.search(read(os.path.join(dp, f)))
            if m:
                guid2path[m.group(1)] = os.path.join(dp, f)[:-5].replace("\\", "/")

    texts, scenes, holders = {}, [], {}
    for dp, dn, fn in os.walk(ASSETS):
        for f in fn:
            if not f.endswith(SCAN_EXT):
                continue
            p = os.path.join(dp, f).replace("\\", "/")
            t = read(p)
            texts[p] = set(GUID_RE.findall(t))
            if f.endswith(".unity"):
                scenes.append(p)
            per = {g: t.count(g) for g in MISS if g in t}
            if per:
                holders[p] = per

    pairs = sum(len(v) for v in holders.values())
    insts = sum(sum(v.values()) for v in holders.values())
    print("[1] 규모")
    print("  결손 GUID 를 담은 에셋 : %d" % len(holders))
    print("  (에셋, GUID) 쌍        : %d   <- 도구의 totalReferenceCount 와 비교할 값" % pairs)
    print("  컴포넌트 인스턴스      : %d   <- 정리를 택하면 지울 대상은 이 수다" % insts)
    for g, name in MISS.items():
        a = [p for p in holders if g in holders[p]]
        print("    %-18s 에셋 %3d / 인스턴스 %3d" % (name, len(a), sum(holders[p][g] for p in a)))

    print()
    print("[2] 씬이 직접 참조하는가")
    pg = {}
    for p in holders:
        m = GUID_RE.search(read(p + ".meta"))
        if m:
            pg[m.group(1)] = p
    direct = {s: [pg[g] for g in pg if g in texts.get(s, ())] for s in scenes}
    direct = {k: v for k, v in direct.items() if v}
    print("  참조하는 씬: %d" % len(direct))
    for s, v in sorted(direct.items()):
        print("    %s <- %d" % (s.split("/Assets/")[1], len(v)))

    print()
    print("[3] 씬에서 GUID 전이(BFS) 도달")
    target = set(holders)
    hit_any = False
    for s in sorted(scenes):
        seen, q = set(), collections.deque([s])
        while q:
            cur = q.popleft()
            for g in texts.get(cur, ()):
                nxt = guid2path.get(g)
                if nxt and nxt not in seen and nxt in texts:
                    seen.add(nxt)
                    q.append(nxt)
        hit = seen & target
        if hit:
            hit_any = True
            print("    %-70s 도달 %d" % (s.split("/Assets/")[1], len(hit)))
    if not hit_any:
        print("  어떤 씬에서도 전이로 도달하지 않는다 (씬 %d개 전수)" % len(scenes))

    print()
    print("[4] Addressables")
    if not os.path.isdir(ADDR):
        print("  그룹 폴더 없음")
    else:
        allg = set()
        for p in holders:
            m = GUID_RE.search(read(p + ".meta"))
            if m:
                allg.add(m.group(1))
        for f in sorted(os.listdir(ADDR)):
            if not f.endswith(".asset"):
                continue
            toks = set(re.findall(r"([0-9a-f]{32})", read(os.path.join(ADDR, f))))
            print("  %-34s guid토큰 %3d / 교집합 %d" % (f, len(toks), len(toks & allg)))

    print()
    print("네 축이 모두 0 이면 '게임 경로 영향 없음' 이다. 하나라도 0 이 아니면 근거가 깨진 것이니")
    print("HANDOFF.md §5 의 A군 결론(현상 유지)을 다시 판단할 것.")


if __name__ == "__main__":
    main()
