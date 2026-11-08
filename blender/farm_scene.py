"""
Procedural builder for the Agent Farm island (2.5D isometric diorama).

World layout (top of grass = z 0, island spans -10..10 on X and Y).
The iso camera looks from +X/-Y toward -X/+Y, so on screen:
    +X+Y -> right, -X-Y -> left, -X+Y -> up (far), +X-Y -> down (near)

Zones exported for the web app (see render_all.py):
    plots    12 raised beds (agents at work)
    porch    farmhouse porch (agents waiting for you)
    meadow   open grass (idle agents)
    barnyard straw yard (sleeping agents)
"""
import math
import random

import bpy
from mathutils import Vector

from lib import (Batch, Ctx, box, coll, cone, cyl, empty, hexcol, ico, mat, mat_noise,
                 prism, sphere, torus)

P = dict(
    grass1="#A6D26F", grass2="#8CC35F", grass3="#BCDD84",
    soil1="#B07A55", soil2="#9A6748", soil3="#83563C", bedrock="#6F5547",
    stone="#BEB6AA", stone2="#9F978C", stone3="#D3CCC1",
    path1="#E8CE9E", path2="#D8B88A",
    tilled1="#C39467", tilled2="#AE8159",
    bedsoil1="#71503A", bedsoil2="#5E412F", mound="#664532",
    plank="#C58F5E", plank2="#AD7B4F", wood_dark="#8A6143",
    wall="#F8EDDA", trim="#FFFAF2", roof="#E2704F", roof2="#CC5C40", brick="#BC6E52",
    shutter="#72A7CF", door="#A06D47", porch="#C99868",
    barn="#D5564C", barn2="#C24A42", barn_trim="#FFF6EC", barn_roof="#6E5F73",
    silo="#CCD6DD", silo_band="#9EAAB4", silo_cap="#E2704F",
    mill="#F6F0E5", mill_band="#B98C66", sail="#FFF9F0",
    leaf1="#7DBB5E", leaf2="#64A350", leaf3="#9BCC70", pine1="#4F9161", pine2="#3F7F52",
    trunk="#8E603E",
    water_edge="#86D3E2", water_deep="#3F9EC2", sand="#EBDBB0",
    lily="#7DC05B", reed="#6FA14A", cattail="#7C5537",
    hay="#EECB68", hay2="#DBB04B", straw="#F0DC97",
    f_pink="#F59BB8", f_white="#FFFFFF", f_yellow="#FFD65C", f_purple="#B99EF2",
    f_red="#F2675F", f_blue="#86BBF4", f_orange="#FFAE5C",
    iron="#3E3B42", lamp="#FFE6B0", window="#A9D4EA", apple="#E5484D",
    sign_board="#9E6C46", sign_text="#FFF4DE", hive="#FBF3E4",
)

ISL = 10.0  # half size of the island


def M(name, **kw):
    """Material shortcut by palette key."""
    return mat(name, P[name] if name in P else kw.pop("color"), **kw)


# --------------------------------------------------------------------------
# layout (all world units)
# --------------------------------------------------------------------------
HOUSE = dict(c=(-6.4, 4.9), w=4.0, d=3.4, h=2.3)
BARN = dict(c=(0.7, 7.1), w=4.6, d=3.8, h=2.4)
SILO = dict(c=(-2.5, 8.45), r=1.0, h=5.2)
MILL = dict(c=(-7.9, -2.0), r=1.15)
BIGTREE = dict(c=(0.2, 3.7))
POND = dict(c=(6.8, 2.6), r=2.1)
WELL = dict(c=(8.1, -2.9))
ARCH = dict(c=(8.45, -8.45))

BED = 2.0
BED_GAP = 0.9
BED_X0, BED_Y0 = -4.6, -7.9
CROPS = ["carrot", "cabbage", "pumpkin", "sunflower", "strawberry", "corn"]


def bed_centers():
    out = []
    for j in range(3):          # rows (y)
        for i in range(4):      # columns (x)
            out.append((BED_X0 + i * (BED + BED_GAP), BED_Y0 + j * (BED + BED_GAP)))
    return out


def zones():
    """Animal destinations exported to the web app."""
    plots = []
    # order: nearest-to-camera beds first so the first agents get the best view
    beds = bed_centers()
    beds_sorted = sorted(range(len(beds)), key=lambda k: -(beds[k][0] - beds[k][1]))
    for n, k in enumerate(beds_sorted):
        cx, cy = beds[k]
        plots.append(dict(id=n, bed=k, center=(cx, cy), station=(cx + 1.22, cy - 1.22),
                          crop=CROPS[k % len(CROPS)]))
    porch = [(-7.8, 1.45), (-6.75, 1.25), (-5.7, 1.45), (-4.75, 1.75),
             (-7.3, 0.35), (-6.2, 0.2), (-5.15, 0.55), (-4.1, 0.85)]
    mc = (2.85, 1.1)
    meadow = [(round(mc[0] + 1.45 * math.cos(a), 3), round(mc[1] + 1.05 * math.sin(a), 3))
              for a in [math.radians(15 + 45 * i) for i in range(8)]]
    meadow.insert(0, mc)
    barnyard = [(3.95, 5.3), (4.95, 5.15), (5.85, 5.75), (4.35, 6.35), (5.4, 6.55),
                (4.0, 7.35), (1.35, 2.75), (-0.85, 2.55), (-1.9, 3.6), (2.4, 3.95),
                (-0.3, 1.6), (0.95, 1.55)]
    hubs = [(4.9, -0.35), (1.2, -0.35), (-2.4, 0.35), (-4.9, 0.95), (3.95, 2.75),
            (6.2, -1.6), (6.95, -5.0)]
    return dict(plots=plots, porch=porch, meadow=meadow, meadow_center=mc,
                meadow_radius=(1.8, 1.3), barnyard=barnyard, hubs=hubs)


def obstacles():
    """Circles (x, y, r) animals should walk around."""
    hx, hy = HOUSE["c"]
    bx, by = BARN["c"]
    return [
        (hx, hy, 2.75), (bx, by, 3.05), (SILO["c"][0], SILO["c"][1], 1.25),
        (MILL["c"][0], MILL["c"][1], 1.6), (BIGTREE["c"][0], BIGTREE["c"][1], 0.55),
        (POND["c"][0], POND["c"][1], 2.65), (WELL["c"][0], WELL["c"][1], 0.8),
    ]


OCCLUDERS = []   # [{'id', 'coll', 'foot': (x, y)}]


def occ(name, foot):
    c = coll("occ_" + name, coll("Occluders"))
    OCCLUDERS.append(dict(id=name, coll=c, foot=foot))
    Ctx.coll = c
    return c


def static(name="Static"):
    Ctx.coll = coll(name)
    return Ctx.coll


# --------------------------------------------------------------------------
# island
# --------------------------------------------------------------------------
def build_island():
    static()
    grass = mat_noise("grass", P["grass2"], P["grass1"], scale=0.18, lo=0.35, hi=0.7,
                      c3=P["grass3"], rough=0.85)
    soil = mat_noise("soil", P["soil2"], P["soil1"], scale=0.5, lo=0.4, hi=0.62, rough=0.9)
    rock = mat_noise("bedrock", P["bedrock"], P["soil3"], scale=0.7, rough=0.9)
    box("grass_top", (2 * ISL, 2 * ISL, 0.55), (0, 0, -0.275), grass, bevel=0.32, segs=5)
    box("soil", (2 * ISL - 0.35, 2 * ISL - 0.35, 1.5), (0, 0, -1.25), soil, bevel=0.25, segs=3)
    box("bedrock", (2 * ISL - 0.9, 2 * ISL - 0.9, 0.8), (0, 0, -2.25), rock, bevel=0.35, segs=3)

    # pebbles embedded in the two visible soil faces (+X and -Y)
    rnd = random.Random(4)
    b = Batch("soil_stones", [M("stone2", rough=0.8), M("stone", rough=0.8)])
    for _ in range(46):
        t = rnd.uniform(-ISL + 0.8, ISL - 0.8)
        z = rnd.uniform(-2.3, -0.75)
        r = rnd.uniform(0.12, 0.3)
        if rnd.random() < 0.5:
            loc = (ISL - 0.17, t, z)
            sc = (0.45, 1.2, 0.8)
        else:
            loc = (t, -ISL + 0.17, z)
            sc = (1.2, 0.45, 0.8)
        b.ico(loc, r, mi=rnd.randint(0, 1), sub=1, scale=sc)
    b.build()

    # hanging grass lip / moss blobs on the visible edges
    b = Batch("grass_lip", [grass])
    for k in range(70):
        t = -ISL + 0.6 + (2 * ISL - 1.2) * k / 69.0 + rnd.uniform(-0.1, 0.1)
        r = rnd.uniform(0.16, 0.3)
        if k % 2 == 0:
            b.ico((ISL - 0.02, t, -0.5), r, sub=1, scale=(0.55, 1.4, 0.9))
        else:
            b.ico((t, -ISL + 0.02, -0.5), r, sub=1, scale=(1.4, 0.55, 0.9))
    b.build()


# --------------------------------------------------------------------------
# paths & ground patches
# --------------------------------------------------------------------------
PATHS = [
    [(9.35, -9.35), (8.2, -7.1), (7.05, -4.9), (6.1, -2.4), (4.9, -0.45)],
    [(4.9, -0.45), (2.6, -0.55), (0.6, -0.45), (-1.8, 0.05), (-3.9, 0.7), (-5.4, 1.4),
     (-6.4, 2.0)],
    [(4.9, -0.45), (4.0, 1.1), (3.75, 2.8), (4.1, 4.2), (4.6, 5.2)],
    [(4.6, 5.2), (3.6, 6.5), (3.15, 7.1)],
    [(7.05, -4.9), (8.0, -3.6)],
]


def _poly_dist(p, poly):
    best = 1e9
    px, py = p
    for (ax, ay), (bx, by) in zip(poly, poly[1:]):
        dx, dy = bx - ax, by - ay
        L2 = dx * dx + dy * dy
        t = max(0.0, min(1.0, ((px - ax) * dx + (py - ay) * dy) / L2)) if L2 else 0
        cx, cy = ax + t * dx, ay + t * dy
        best = min(best, math.hypot(px - cx, py - cy))
    return best


def build_paths():
    static()
    pm = mat_noise("path", P["path2"], P["path1"], scale=1.1, lo=0.38, hi=0.65, rough=0.92)
    b = Batch("paths", [pm])
    rnd = random.Random(11)
    for poly in PATHS:
        for (ax, ay), (bx, by) in zip(poly, poly[1:]):
            L = math.hypot(bx - ax, by - ay)
            n = max(2, int(L / 0.22))
            for k in range(n + 1):
                t = k / n
                x, y = ax + (bx - ax) * t, ay + (by - ay) * t
                r = 0.46 + rnd.uniform(-0.04, 0.05)
                b.disc((x, y, 0.012), r, 0.024, segs=20)
    b.build()

    # stepping stones scattered on the paths
    b = Batch("path_stones", [M("stone3", rough=0.75), M("stone", rough=0.75)])
    for poly in PATHS[:3]:
        for (ax, ay), (bx, by) in zip(poly, poly[1:]):
            L = math.hypot(bx - ax, by - ay)
            for k in range(int(L / 0.9)):
                t = (k + 0.5) / max(1, int(L / 0.9))
                x = ax + (bx - ax) * t + rnd.uniform(-0.18, 0.18)
                y = ay + (by - ay) * t + rnd.uniform(-0.18, 0.18)
                b.disc((x, y, 0.03), rnd.uniform(0.13, 0.2), 0.035, mi=rnd.randint(0, 1),
                       segs=10, scale=(1.0, rnd.uniform(0.7, 1.0)))
    b.build(bevel=0.012)


# --------------------------------------------------------------------------
# fields
# --------------------------------------------------------------------------
def build_fields():
    static()
    tilled = mat_noise("tilled", P["tilled2"], P["tilled1"], scale=0.9, lo=0.4, hi=0.62,
                       rough=0.95)
    xs = [c[0] for c in bed_centers()]
    ys = [c[1] for c in bed_centers()]
    x0, x1 = min(xs) - BED / 2 - 0.7, max(xs) + BED / 2 + 0.7
    y0, y1 = min(ys) - BED / 2 - 0.55, max(ys) + BED / 2 + 0.7
    box("field_ground", (x1 - x0, y1 - y0, 0.06), ((x0 + x1) / 2, (y0 + y1) / 2, 0.0), tilled,
        bevel=0.03, segs=2)
    plank = mat_noise("plank", P["plank2"], P["plank"], scale=3.0, lo=0.35, hi=0.7, rough=0.7)
    bsoil = mat_noise("bedsoil", P["bedsoil2"], P["bedsoil1"], scale=2.0, rough=0.95)
    mound = M("mound", rough=0.95)
    post = M("wood_dark", rough=0.7)
    for k, (cx, cy) in enumerate(bed_centers()):
        hb = BED / 2
        z = 0.03
        bt = Batch(f"bed_{k}", [plank, post, bsoil, mound])
        bt.box((cx, cy - hb + 0.06, z + 0.13), (BED, 0.12, 0.26), mi=0)
        bt.box((cx, cy + hb - 0.06, z + 0.13), (BED, 0.12, 0.26), mi=0)
        bt.box((cx - hb + 0.06, cy, z + 0.13), (0.12, BED - 0.24, 0.26), mi=0)
        bt.box((cx + hb - 0.06, cy, z + 0.13), (0.12, BED - 0.24, 0.26), mi=0)
        for sx in (-1, 1):
            for sy in (-1, 1):
                bt.box((cx + sx * (hb - 0.06), cy + sy * (hb - 0.06), z + 0.16),
                       (0.17, 0.17, 0.32), mi=1)
        bt.box((cx, cy, z + 0.11), (BED - 0.2, BED - 0.2, 0.2), mi=2)
        for r in (-0.52, 0.0, 0.52):
            bt.sphere((cx, cy + r, z + 0.21), 0.2, mi=3, seg=16, rings=8,
                      scale=(4.0, 0.95, 0.42))
        ob = bt.build(bevel=0.018)
        ob.name = f"bed_{k}"

    # scarecrow guarding the field
    sc = (-7.15, -6.55)
    shirt = M("f_red", rough=0.8)
    straw = M("hay", rough=0.9)
    pole = M("wood_dark", rough=0.8)
    cyl("sc_pole", 0.06, 1.9, (sc[0], sc[1], 0.95), pole, verts=10)
    cyl("sc_arm", 0.05, 1.3, (sc[0], sc[1], 1.35), pole, verts=10,
        rot=(math.radians(90), 0, math.radians(-45)))
    box("sc_shirt", (0.42, 0.42, 0.6), (sc[0], sc[1], 1.25), shirt, bevel=0.1, segs=3)
    sphere("sc_head", 0.24, (sc[0], sc[1], 1.78), M("sand", rough=0.9))
    cyl("sc_brim", 0.42, 0.04, (sc[0], sc[1], 1.95), straw, verts=24)
    cone("sc_hat", 0.24, 0.32, (sc[0], sc[1], 2.12), straw, r2=0.1, verts=18)
    for s in (-1, 1):
        ico("sc_hand", 0.09, (sc[0] + s * 0.46, sc[1] + s * 0.46, 1.35), straw, sub=1)


# --------------------------------------------------------------------------
# buildings
# --------------------------------------------------------------------------
def _window(name, loc, normal, w=0.72, h=0.86, shutters=True, flowerbox=False, mats=None,
            parent=None):
    """Window on a wall whose outward normal is +X ('x') or -Y ('-y')."""
    trim, glass, shut, plank = mats
    x, y, z = loc
    if normal == "x":
        box(name + "_frame", (0.1, w + 0.14, h + 0.14), (x + 0.03, y, z), trim, bevel=0.02)
        box(name + "_glass", (0.1, w, h), (x + 0.05, y, z), glass, bevel=0.0)
        box(name + "_mv", (0.12, 0.05, h), (x + 0.07, y, z), trim, bevel=0.0)
        box(name + "_mh", (0.12, w, 0.05), (x + 0.07, y, z), trim, bevel=0.0)
        if shutters:
            for s in (-1, 1):
                box(name + "_sh", (0.06, 0.3, h + 0.06), (x + 0.04, y + s * (w / 2 + 0.24), z),
                    shut, bevel=0.015)
        if flowerbox:
            box(name + "_fb", (0.22, w + 0.1, 0.16), (x + 0.12, y, z - h / 2 - 0.12), plank,
                bevel=0.02)
            return (x + 0.2, y, z - h / 2 - 0.02), "x", w
    else:
        box(name + "_frame", (w + 0.14, 0.1, h + 0.14), (x, y - 0.03, z), trim, bevel=0.02)
        box(name + "_glass", (w, 0.1, h), (x, y - 0.05, z), glass, bevel=0.0)
        box(name + "_mv", (0.05, 0.12, h), (x, y - 0.07, z), trim, bevel=0.0)
        box(name + "_mh", (w, 0.12, 0.05), (x, y - 0.07, z), trim, bevel=0.0)
        if shutters:
            for s in (-1, 1):
                box(name + "_sh", (0.3, 0.06, h + 0.06), (x + s * (w / 2 + 0.24), y - 0.04, z),
                    shut, bevel=0.015)
        if flowerbox:
            box(name + "_fb", (w + 0.1, 0.22, 0.16), (x, y - 0.12, z - h / 2 - 0.12), plank,
                bevel=0.02)
            return (x, y - 0.2, z - h / 2 - 0.02), "-y", w
    return None


def _flowers_line(b, start, axis, length, rnd, n=7, mis=(0, 1, 2)):
    x, y, z = start
    for i in range(n):
        t = (i + 0.5) / n - 0.5
        px = x + (t * length if axis == "-y" else rnd.uniform(-0.04, 0.04))
        py = y + (t * length if axis == "x" else rnd.uniform(-0.04, 0.04))
        b.ico((px, py, z + 0.07), rnd.uniform(0.06, 0.085), mi=rnd.choice(mis), sub=1)
        b.ico((px, py, z + 0.0), 0.07, mi=3, sub=1, scale=(1.2, 1.2, 0.6))


WINDOW_LIGHTS = []   # world positions just outside windows (night glow)
LANTERNS = []        # lamp positions
CHIMNEY = []


def build_house():
    cx, cy = HOUSE["c"]
    W, D, H = HOUSE["w"], HOUSE["d"], HOUSE["h"]
    occ("house", foot=(cx + W / 2 + 0.2, cy - D / 2 - 1.05))
    wall = mat_noise("house_wall", "#F1E3CC", P["wall"], scale=2.5, lo=0.3, hi=0.7, rough=0.85)
    trim = M("trim", rough=0.6)
    stone = mat_noise("found", P["stone2"], P["stone"], scale=3.0, rough=0.85)
    roof = mat_noise("roof", P["roof2"], P["roof"], scale=1.6, lo=0.3, hi=0.7, rough=0.6)
    brick = M("brick", rough=0.85)
    glass = mat("window", P["window"], rough=0.12, spec=0.6, coat=0.4)
    shut = M("shutter", rough=0.55)
    door = mat_noise("door", "#8E5F3E", P["door"], scale=6, rough=0.6)
    plank = M("porch", rough=0.75)
    z0 = 0.3
    box("h_found", (W + 0.24, D + 0.24, z0), (cx, cy, z0 / 2), stone, bevel=0.05)
    box("h_walls", (W, D, H), (cx, cy, z0 + H / 2), wall, bevel=0.03)
    for sx in (-1, 1):
        for sy in (-1, 1):
            box("h_corner", (0.16, 0.16, H), (cx + sx * W / 2, cy + sy * D / 2, z0 + H / 2),
                M("plank2", rough=0.7), bevel=0.02)
    box("h_band", (W + 0.08, D + 0.08, 0.12), (cx, cy, z0 + H - 0.06), M("plank2", rough=0.7),
        bevel=0.02)
    gh = 1.55
    zt = z0 + H
    prism("h_gable", [(-W / 2, 0), (W / 2, 0), (0, gh)], D, (cx, cy, zt), wall, axis="y")
    # roof slabs
    a = math.atan2(gh, W / 2)
    ov = 0.42
    t = 0.2
    half = (W / 2 + ov) / math.cos(a)
    zr = zt + gh
    for s in (1, -1):
        mx = s * (W / 2 + ov) / 2
        mz = zr - (W / 2 + ov) / 2 * math.tan(a)
        n = Vector((s * math.sin(a), 0, math.cos(a)))
        c = Vector((cx + mx, cy, mz)) + n * (t / 2 + 0.02)
        box("h_roof", (half + 0.04, D + 0.7, t), c, roof, rot=(0, s * a, 0), bevel=0.05)
        for k in range(1, 5):
            f = k / 5.0
            px = s * (W / 2 + ov) * f
            pz = zr - abs(px) * math.tan(a)
            pc = Vector((cx + px, cy, pz)) + n * (t + 0.03)
            cyl("h_tile", 0.05, D + 0.7, pc, M("roof2", rough=0.6),
                rot=(math.radians(90), 0, 0), verts=10)
    cyl("h_ridge", 0.12, D + 0.8, (cx, cy, zr + 0.2), M("roof2", rough=0.6),
        rot=(math.radians(90), 0, 0), verts=14)
    # chimney on the right slope (+X side)
    chx = cx + 1.05
    chy = cy + 0.65
    box("h_chimney", (0.52, 0.52, 1.9), (chx, chy, zr - 0.1), brick, bevel=0.03)
    box("h_chimcap", (0.66, 0.66, 0.14), (chx, chy, zr + 0.9), stone, bevel=0.03)
    CHIMNEY.append((chx, chy, zr + 1.0))
    # front (-Y) face: door, windows, round attic window
    fy = cy - D / 2
    box("h_doorframe", (1.08, 0.12, 1.78), (cx, fy - 0.02, z0 + 0.87), trim, bevel=0.03)
    box("h_door", (0.86, 0.14, 1.62), (cx, fy - 0.04, z0 + 0.81), door, bevel=0.03)
    sphere("h_knob", 0.05, (cx + 0.28, fy - 0.14, z0 + 0.8), M("lamp", rough=0.3, metallic=0.6))
    box("h_doorwin", (0.36, 0.16, 0.36), (cx, fy - 0.04, z0 + 1.3), glass, bevel=0.02)
    fb_mats = [M("f_pink"), M("f_white"), M("f_yellow"), M("leaf2")]
    rnd = random.Random(3)
    fl = Batch("h_flowerboxes", fb_mats)
    for dx in (-1.35, 1.35):
        res = _window("h_win", (cx + dx, fy, z0 + 1.28), "-y", w=0.7, h=0.8,
                      mats=(trim, glass, shut, plank), flowerbox=True)
        WINDOW_LIGHTS.append((cx + dx, fy - 0.8, z0 + 1.2))
        _flowers_line(fl, res[0], res[1], res[2], rnd)
    torus("h_attic_frame", 0.32, 0.06, (cx, fy - 0.04, zt + 0.62), trim,
          rot=(math.radians(90), 0, 0), seg=28, ring=10)
    cyl("h_attic", 0.3, 0.1, (cx, fy - 0.02, zt + 0.62), glass, rot=(math.radians(90), 0, 0),
        verts=28)
    WINDOW_LIGHTS.append((cx, fy - 0.8, zt + 0.5))
    # right (+X) face windows
    rx = cx + W / 2
    for dy in (-0.85, 0.85):
        res = _window("h_winx", (rx, cy + dy, z0 + 1.28), "x", w=0.7, h=0.8,
                      mats=(trim, glass, shut, plank), flowerbox=True)
        WINDOW_LIGHTS.append((rx + 0.8, cy + dy, z0 + 1.2))
        _flowers_line(fl, res[0], res[1], res[2], rnd)
    fl.build()
    # porch
    pd = 1.0
    box("h_porch", (2.6, pd, 0.2), (cx, fy - pd / 2, 0.1), plank, bevel=0.03)
    box("h_step", (1.2, 0.34, 0.1), (cx, fy - pd - 0.17, 0.05), plank, bevel=0.02)
    for s in (-1, 1):
        cyl("h_post", 0.07, 1.9, (cx + s * 1.18, fy - pd + 0.1, 0.2 + 0.95),
            M("trim"), verts=12)
    box("h_porch_roof", (2.9, 1.25, 0.12), (cx, fy - pd / 2 - 0.05, 2.2), roof,
        rot=(math.radians(14), 0, 0), bevel=0.03)
    # porch lantern + potted plant
    lp = (cx - 1.18, fy - 0.9, 1.72)
    box("h_lamp", (0.18, 0.18, 0.26), lp, mat("lampglass", P["lamp"], rough=0.3), bevel=0.02)
    box("h_lampcap", (0.24, 0.24, 0.06), (lp[0], lp[1], lp[2] + 0.16), M("iron"), bevel=0.01)
    LANTERNS.append((lp[0], lp[1] - 0.15, lp[2]))
    cyl("h_pot", 0.17, 0.3, (cx + 0.85, fy - 0.35, 0.35), M("roof2"), r2=0.21, verts=16)
    ico("h_plant", 0.26, (cx + 0.85, fy - 0.35, 0.66), M("leaf2"), sub=2, jitter=0.08, seed=2)


def build_barn():
    cx, cy = BARN["c"]
    W, D, H = BARN["w"], BARN["d"], BARN["h"]
    occ("barn", foot=(cx + W / 2 + 0.25, cy - D / 2 - 0.1))
    red = mat_noise("barn_wall", P["barn2"], P["barn"], scale=4.0, lo=0.3, hi=0.7, rough=0.8)
    trim = M("barn_trim", rough=0.6)
    roof = mat_noise("barn_roof", "#5F5165", P["barn_roof"], scale=2.0, rough=0.65)
    stone = MATS_get("found")
    dark = mat("barn_dark", "#4A2E2A", rough=0.9)
    z0 = 0.18
    box("b_found", (W + 0.2, D + 0.2, z0), (cx, cy, z0 / 2), stone, bevel=0.04)
    box("b_walls", (W, D, H), (cx, cy, z0 + H / 2), red, bevel=0.03)
    # vertical board lines on the walls
    lines = Batch("b_boards", [mat("barn_line", "#B5433C", rough=0.85)])
    for k in range(1, 12):
        y = cy - D / 2 + D * k / 12
        lines.box((cx + W / 2 + 0.005, y, z0 + H / 2), (0.02, 0.025, H - 0.1))
    for k in range(1, 14):
        x = cx - W / 2 + W * k / 14
        lines.box((x, cy - D / 2 - 0.005, z0 + H / 2), (0.025, 0.02, H - 0.1))
    lines.build()
    zt = z0 + H
    prof = [(-D / 2, 0), (D / 2, 0), (D / 2 * 0.84, 1.05), (0, 1.75), (-D / 2 * 0.84, 1.05)]
    prism("b_gable", prof, W, (cx, cy, zt), red, axis="x")
    outer = [(-D / 2 - 0.34, -0.18), (-D / 2 * 0.84 - 0.12, 1.12), (0, 1.92),
             (D / 2 * 0.84 + 0.12, 1.12), (D / 2 + 0.34, -0.18)]
    inner = [(u, v - 0.2) for u, v in outer]
    inner[0] = (inner[0][0] + 0.12, inner[0][1] + 0.05)
    inner[-1] = (inner[-1][0] - 0.12, inner[-1][1] + 0.05)
    prism("b_roof", outer + list(reversed(inner)), W + 0.55, (cx, cy, zt), roof, axis="x",
          bevel=0.04)
    # white trim: corners, eaves, gable outline on the door side
    for sx in (-1, 1):
        for sy in (-1, 1):
            box("b_corner", (0.16, 0.16, H), (cx + sx * W / 2, cy + sy * D / 2, z0 + H / 2),
                trim, bevel=0.02)
    box("b_band", (W + 0.1, D + 0.1, 0.1), (cx, cy, zt - 0.02), trim, bevel=0.02)
    gx = cx + W / 2 + 0.03
    for (u0, v0), (u1, v1) in zip(prof[1:] + prof[:1], prof[2:] + prof[:2]):
        if v0 == 0 and v1 == 0:
            continue
        L = math.hypot(u1 - u0, v1 - v0)
        ang = math.atan2(v1 - v0, u1 - u0)
        box("b_gtrim", (0.08, L + 0.1, 0.12), (gx, cy + (u0 + u1) / 2, zt + (v0 + v1) / 2),
            trim, rot=(ang, 0, 0), bevel=0.02)
    # big double doors on the +X gable
    dh, dw = 1.95, 0.95
    for s in (-1, 1):
        dc = (gx + 0.02, cy + s * (dw / 2 + 0.02), z0 + dh / 2)
        box("b_door", (0.08, dw, dh), dc, red, bevel=0.02)
        box("b_dframe_v", (0.1, 0.1, dh), (dc[0] + 0.02, dc[1] + s * (dw / 2 - 0.05), dc[2]),
            trim, bevel=0.01)
        box("b_dframe_v2", (0.1, 0.1, dh), (dc[0] + 0.02, dc[1] - s * (dw / 2 - 0.05), dc[2]),
            trim, bevel=0.01)
        for dz in (-dh / 2 + 0.05, dh / 2 - 0.05, 0.0):
            box("b_dframe_h", (0.1, dw, 0.1), (dc[0] + 0.02, dc[1], dc[2] + dz), trim, bevel=0.01)
        for hz in (-1, 1):
            ang = math.atan2(dh / 2 - 0.1, dw - 0.1) * hz
            box("b_x", (0.09, math.hypot(dw - 0.1, dh / 2 - 0.1) + 0.02, 0.08),
                (dc[0] + 0.03, dc[1], dc[2] + (dh / 4 if hz > 0 else -dh / 4)), trim,
                rot=(ang * s, 0, 0), bevel=0.01)
    # hay loft
    lz = zt + 0.55
    box("b_loft_frame", (0.1, 0.95, 0.85), (gx + 0.02, cy, lz), trim, bevel=0.02)
    box("b_loft", (0.1, 0.75, 0.66), (gx + 0.04, cy, lz), dark, bevel=0.0)
    rnd = random.Random(8)
    hb = Batch("b_hay", [M("hay", rough=0.95), M("hay2", rough=0.95)])
    for _ in range(14):
        hb.ico((gx + 0.06, cy + rnd.uniform(-0.3, 0.3), lz - 0.3 + rnd.uniform(0, 0.25)),
               rnd.uniform(0.08, 0.14), mi=rnd.randint(0, 1), sub=1, scale=(0.6, 1, 1))
    hb.build()
    WINDOW_LIGHTS.append((gx + 0.9, cy, z0 + 1.0))
    # side windows on -Y face
    glass = MATS_get("window")
    fy = cy - D / 2
    for dx in (-1.3, 0.2):
        box("b_win_frame", (0.78, 0.1, 0.7), (cx + dx, fy - 0.04, z0 + 1.5), trim, bevel=0.02)
        box("b_win", (0.62, 0.1, 0.54), (cx + dx, fy - 0.06, z0 + 1.5), glass, bevel=0.0)
        box("b_win_m", (0.05, 0.12, 0.54), (cx + dx, fy - 0.08, z0 + 1.5), trim, bevel=0.0)
        WINDOW_LIGHTS.append((cx + dx, fy - 0.8, z0 + 1.3))
    # weather vane
    vx = cx + W / 2 - 0.4
    cyl("b_vane_pole", 0.03, 0.9, (vx, cy, zt + 1.92 + 0.45), M("iron"), verts=8)
    box("b_vane_arrow", (0.7, 0.04, 0.04), (vx, cy, zt + 2.6), M("iron"), bevel=0.0)
    cone("b_vane_tip", 0.07, 0.16, (vx + 0.36, cy, zt + 2.6), M("iron"), r2=0.0,
         rot=(0, math.radians(90), 0), verts=8)
    box("b_vane_tail", (0.04, 0.2, 0.16), (vx - 0.34, cy, zt + 2.6), M("iron"), bevel=0.0)
    sphere("b_vane_ball", 0.06, (vx, cy, zt + 2.45), M("lamp", rough=0.3, metallic=0.7))
    # barn lantern
    lp = (gx + 0.12, cy + 1.3, z0 + 2.05)
    box("b_lamp", (0.18, 0.18, 0.26), lp, MATS_get("lampglass"), bevel=0.02)
    box("b_lampcap", (0.24, 0.24, 0.06), (lp[0], lp[1], lp[2] + 0.16), M("iron"), bevel=0.01)
    LANTERNS.append((lp[0] + 0.15, lp[1], lp[2]))


def MATS_get(name):
    from lib import MATS
    return MATS[name]


def build_silo():
    cx, cy = SILO["c"]
    r, h = SILO["r"], SILO["h"]
    occ("silo", foot=(cx + r * 0.71, cy - r * 0.71))
    metal = mat("silo", P["silo"], rough=0.38, metallic=0.25, spec=0.5)
    band = mat("silo_band", P["silo_band"], rough=0.4, metallic=0.4)
    cyl("s_body", r, h, (cx, cy, h / 2 + 0.1), metal, verts=40)
    cyl("s_base", r + 0.12, 0.25, (cx, cy, 0.12), MATS_get("found"), verts=40, bevel=0.03)
    for k in range(1, 6):
        torus("s_band", r + 0.01, 0.035, (cx, cy, 0.1 + h * k / 6), band, seg=40, ring=8)
    dome = sphere("s_dome", r + 0.08, (cx, cy, h + 0.1), M("silo_cap", rough=0.55),
                  scale=(1, 1, 0.62), seg=40, rings=20)
    cyl("s_cap", 0.18, 0.2, (cx, cy, h + 0.1 + (r + 0.08) * 0.62 + 0.05), M("silo_cap"),
        verts=16)
    sphere("s_top", 0.11, (cx, cy, h + 0.1 + (r + 0.08) * 0.62 + 0.2), MATS_get("trim"))
    # ladder on +X side
    lx = cx + r + 0.12
    for s in (-1, 1):
        box("s_rail", (0.05, 0.05, h - 0.4), (lx, cy + s * 0.18, h / 2 + 0.2), band, bevel=0.0)
    for k in range(int((h - 0.6) / 0.3)):
        box("s_rung", (0.04, 0.36, 0.04), (lx, cy, 0.5 + k * 0.3), band, bevel=0.0)


BLADES = {}


def build_windmill():
    cx, cy = MILL["c"]
    r = MILL["r"]
    occ("windmill", foot=(cx + r * 0.75, cy - r * 0.75))
    body = mat_noise("mill", "#EDE4D6", P["mill"], scale=3.0, rough=0.8)
    band = M("mill_band", rough=0.75)
    roof = MATS_get("roof")
    trim = MATS_get("trim")
    glass = MATS_get("window")
    rot8 = (0, 0, math.radians(22.5))
    cyl("m_base", r + 0.18, 0.55, (cx, cy, 0.27), MATS_get("found"), verts=8, rot=rot8,
        bevel=0.04)
    th = 4.4
    cyl("m_tower", r, th, (cx, cy, 0.55 + th / 2), body, verts=8, r2=0.82, rot=rot8,
        smooth=False, bevel=0.03)
    for k, z in enumerate((1.8, 3.3)):
        rr = r + (0.82 - r) * ((z - 0.55) / th)
        cyl("m_band", rr + 0.04, 0.14, (cx, cy, z), band, verts=8, rot=rot8, smooth=False,
            r2=rr + 0.03)
    zt = 0.55 + th
    cyl("m_gallery", 1.08, 0.16, (cx, cy, zt + 0.05), band, verts=8, rot=rot8, smooth=False,
        bevel=0.02)
    cone("m_cap", 1.0, 1.25, (cx, cy, zt + 0.7), roof, r2=0.08, verts=8, rot=rot8, smooth=False)
    sphere("m_finial", 0.13, (cx, cy, zt + 1.4), trim)
    # door + windows on -Y face
    fy = cy - r * 0.96
    box("m_door", (0.62, 0.14, 1.1), (cx, fy, 0.55 + 0.55), MATS_get("door"), bevel=0.04)
    box("m_door_tr", (0.78, 0.1, 0.1), (cx, fy - 0.02, 0.55 + 1.15), trim, bevel=0.02)
    for z in (2.55,):
        rr = r + (0.82 - r) * ((z - 0.55) / th)
        box("m_win", (0.42, 0.12, 0.5), (cx, cy - rr * 0.95, z), glass, bevel=0.02)
        box("m_win_fr", (0.52, 0.08, 0.6), (cx, cy - rr * 0.93, z), trim, bevel=0.02)
        WINDOW_LIGHTS.append((cx, cy - rr - 0.8, z))
    # hub & blades on the side facing the camera
    f = Vector((1, -1, 0)).normalized()
    hub = Vector((cx, cy, zt + 0.45)) + f * 1.08
    cyl("m_axle", 0.11, 0.9, Vector((cx, cy, zt + 0.45)) + f * 0.75, band,
        rot=(math.radians(90), 0, math.radians(45)), verts=12)
    BLADES["hub"] = tuple(hub)
    BLADES["axis"] = tuple(f)
    bc = coll("blades")
    Ctx.coll = bc
    X = Vector((0.7071, 0.7071, 0))
    Y = Vector((0, 0, 1))
    from mathutils import Matrix
    mrot = Matrix((X, Y, f)).transposed().to_euler()
    piv = empty("blade_pivot", hub, mrot)
    BLADES["pivot"] = piv
    wood = M("wood_dark", rough=0.7)
    sail = mat("sail", P["sail"], rough=0.85, sheen=0.4)
    cyl("bl_hub", 0.26, 0.34, (0, 0, 0.1), MATS_get("roof2"), verts=16, parent=piv, bevel=0.03)
    sphere("bl_nose", 0.15, (0, 0, 0.28), trim, parent=piv)
    L = 2.75
    for k in range(4):
        ang = math.radians(90 * k + 15)
        d = Vector((math.cos(ang), math.sin(ang), 0))
        p = Vector((-math.sin(ang), math.cos(ang), 0))
        box("bl_spar", (L, 0.11, 0.08), d * (L / 2 + 0.1), wood, rot=(0, 0, ang), parent=piv,
            bevel=0.015)
        sc = d * (0.4 + (L - 0.45) / 2) + p * 0.28
        box("bl_sail", (L - 0.55, 0.48, 0.03), sc + Vector((0, 0, 0.03)), sail,
            rot=(0, 0, ang), parent=piv, bevel=0.01)
        for q in range(5):
            tq = 0.45 + (L - 0.6) * q / 4
            box("bl_lat", (0.05, 0.56, 0.05), d * tq + p * 0.28 + Vector((0, 0, 0.05)), wood,
                rot=(0, 0, ang), parent=piv, bevel=0.0)
        box("bl_edge", (L - 0.5, 0.05, 0.05), d * (0.4 + (L - 0.45) / 2) + p * 0.53 +
            Vector((0, 0, 0.05)), wood, rot=(0, 0, ang), parent=piv, bevel=0.0)
    static()


# --------------------------------------------------------------------------
# trees, bushes, pond, props
# --------------------------------------------------------------------------
LEAVES = None


def leaf_mats():
    return [mat_noise("leaf_a", P["leaf2"], P["leaf1"], scale=1.6, rough=0.75, space="world"),
            mat_noise("leaf_b", P["leaf1"], P["leaf3"], scale=1.8, rough=0.75, space="world"),
            mat_noise("leaf_c", "#558F46", P["leaf2"], scale=1.5, rough=0.75, space="world")]


def round_tree(name, x, y, s=1.0, seed=0, apples=False, occluder=True):
    if occluder:
        occ(name, foot=(x + 0.3 * s, y - 0.3 * s))
    rnd = random.Random(seed)
    trunk = mat_noise("trunk", "#7A5034", P["trunk"], scale=5.0, rough=0.85)
    lm = leaf_mats()
    th = 1.55 * s
    cyl(name + "_trunk", 0.2 * s, th, (x, y, th / 2), trunk, r2=0.13 * s, verts=14)
    for k in range(2):
        a = rnd.uniform(0, 6.28)
        cyl(name + "_root", 0.09 * s, 0.4 * s, (x + math.cos(a) * 0.17 * s,
                                                 y + math.sin(a) * 0.17 * s, 0.08), trunk,
            rot=(math.cos(a) * 0.9, math.sin(a) * -0.9, 0), verts=8)
    blobs = [((0, 0, th + 0.75 * s), 0.95 * s)]
    for k in range(4):
        a = rnd.uniform(0, 6.28) + k * 1.57
        blobs.append(((math.cos(a) * 0.55 * s, math.sin(a) * 0.55 * s,
                       th + rnd.uniform(0.3, 0.75) * s), rnd.uniform(0.6, 0.75) * s))
    blobs.append(((0.1 * s, -0.05 * s, th + 1.35 * s), 0.62 * s))
    for k, (o, r) in enumerate(blobs):
        ico(name + f"_leaf{k}", r, (x + o[0], y + o[1], o[2]), lm[k % 3], sub=3, jitter=0.035,
            seed=seed * 10 + k)
    if apples:
        am = M("apple", rough=0.35, coat=0.5)
        for k in range(9):
            o, r = blobs[k % len(blobs)]
            a = rnd.uniform(-1.2, 0.8)
            e = rnd.uniform(-0.3, 0.6)
            d = Vector((math.cos(a) * math.cos(e), math.sin(a) * math.cos(e) - 0.4, math.sin(e)))
            d.normalize()
            p = Vector((x + o[0], y + o[1], o[2])) + d * r * 0.97
            sphere(name + "_apple", 0.075 * s, p, am, seg=12, rings=8)
    if occluder:
        static()


def big_tree():
    x, y = BIGTREE["c"]
    occ("bigtree", foot=(x + 0.38, y - 0.38))
    rnd = random.Random(21)
    trunk = mat_noise("trunk", "#7A5034", P["trunk"], scale=5.0, rough=0.85)
    lm = leaf_mats()
    cyl("bt_trunk", 0.36, 2.4, (x, y, 1.2), trunk, r2=0.24, verts=18)
    for a in (0.4, 2.3, 4.2):
        cyl("bt_root", 0.14, 0.7, (x + math.cos(a) * 0.3, y + math.sin(a) * 0.3, 0.12), trunk,
            r2=0.05, rot=(math.sin(a) * -1.2, math.cos(a) * 1.2, 0), verts=10)
    cyl("bt_branch", 0.12, 1.2, (x + 0.45, y - 0.2, 2.3), trunk, r2=0.07,
        rot=(math.radians(20), math.radians(55), 0), verts=10)
    blobs = [((0, 0, 3.35), 1.45), ((0.95, 0.35, 3.0), 1.05), ((-0.9, 0.45, 3.1), 1.1),
             ((0.25, -0.85, 2.95), 1.0), ((0.15, 0.6, 3.95), 1.0), ((-0.35, -0.25, 4.1), 0.9),
             ((0.85, -0.45, 3.7), 0.8), ((-0.95, -0.55, 3.45), 0.8)]
    for k, (o, r) in enumerate(blobs):
        ico(f"bt_leaf{k}", r, (x + o[0], y + o[1], o[2]), lm[k % 3], sub=3, jitter=0.03,
            seed=100 + k)
    fm = [M("f_white", rough=0.5), M("f_pink", rough=0.5)]
    bb = Batch("bt_blossom", fm)
    for k in range(40):
        o, r = blobs[k % len(blobs)]
        a = rnd.uniform(-2.2, 1.2)
        e = rnd.uniform(-0.2, 0.9)
        d = Vector((math.cos(a) * math.cos(e), math.sin(a) * math.cos(e), math.sin(e)))
        p = Vector((x + o[0], y + o[1], o[2])) + d * r * 0.98
        bb.ico(p, rnd.uniform(0.05, 0.075), mi=k % 2, sub=1)
    bb.build()
    # tire swing on the branch
    sw = (x + 0.95, y - 0.4)
    for s in (-1, 1):
        cyl("bt_rope", 0.015, 1.55, (sw[0] + s * 0.12, sw[1] - s * 0.12, 1.95), M("hay2"),
            verts=6)
    box("bt_seat", (0.5, 0.22, 0.05), (sw[0], sw[1], 1.18), M("plank"),
        rot=(0, 0, math.radians(-45)), bevel=0.015)
    static()


def pine(name, x, y, s=1.0, seed=0, occluder=True):
    if occluder:
        occ(name, foot=(x + 0.25 * s, y - 0.25 * s))
    trunk = mat_noise("trunk", "#7A5034", P["trunk"], scale=5.0, rough=0.85)
    pm = [mat_noise("pine_a", P["pine2"], P["pine1"], scale=2.0, rough=0.8),
          mat_noise("pine_b", "#36704A", P["pine2"], scale=2.0, rough=0.8)]
    cyl(name + "_trunk", 0.14 * s, 0.7 * s, (x, y, 0.35 * s), trunk, verts=10)
    rnd = random.Random(seed)
    for k, (z, r, h) in enumerate(((0.55, 0.95, 1.3), (1.2, 0.75, 1.15), (1.8, 0.52, 0.95))):
        cone(name + f"_c{k}", r * s, h * s, (x, y, (z + h / 2) * s), pm[k % 2], r2=0.06 * s,
             verts=12, rot=(0, 0, rnd.uniform(0, 1)))
    if occluder:
        static()


def bush(b, x, y, s=1.0, rnd=None, mi=(0, 1)):
    rnd = rnd or random.Random(0)
    for k in range(3):
        a = rnd.uniform(0, 6.28)
        b.ico((x + math.cos(a) * 0.22 * s, y + math.sin(a) * 0.22 * s, 0.22 * s),
              rnd.uniform(0.26, 0.36) * s, mi=rnd.choice(mi), sub=2)


def _blob_ring(c, r, wob, n=48, seed=0):
    rnd = random.Random(seed)
    ph = [rnd.uniform(0, 6.28) for _ in range(3)]
    pts = []
    for k in range(n):
        a = 2 * math.pi * k / n
        rr = r * (1 + wob * (0.6 * math.sin(2 * a + ph[0]) + 0.3 * math.sin(3 * a + ph[1]) +
                             0.15 * math.sin(5 * a + ph[2])))
        pts.append((c[0] + rr * math.cos(a), c[1] + rr * math.sin(a)))
    return pts


def _flat_poly(name, pts, z, thick, m):
    import bmesh
    from lib import _mesh_obj
    ob, me = _mesh_obj(name)
    bm = bmesh.new()
    top = [bm.verts.new((x, y, z)) for x, y in pts]
    bot = [bm.verts.new((x, y, z - thick)) for x, y in pts]
    bm.faces.new(top)
    bm.faces.new(list(reversed(bot)))
    n = len(pts)
    for i in range(n):
        j = (i + 1) % n
        bm.faces.new((top[j], top[i], bot[i], bot[j]))
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    bm.to_mesh(me)
    bm.free()
    ob.data.materials.append(m)
    md = ob.modifiers.new("Bevel", "BEVEL")
    md.width = min(0.06, thick * 0.45)
    md.segments = 2
    return ob


def build_pond():
    static()
    c, r = POND["c"], POND["r"]
    sand = mat_noise("sand", "#E0CC9C", P["sand"], scale=2.0, rough=0.9)
    _flat_poly("pond_bank", _blob_ring(c, r * 1.16, 0.06, seed=5), 0.04, 0.06, sand)
    # water: radial gradient deep -> shallow
    from lib import _new_material, _bsdf, MATS
    wm = _new_material("water")
    nt = wm.node_tree
    b = _bsdf(wm)
    b.inputs["Roughness"].default_value = 0.06
    b.inputs["Coat Weight"].default_value = 0.8
    b.inputs["Coat Roughness"].default_value = 0.03
    b.inputs["Specular IOR Level"].default_value = 0.6
    tc = nt.nodes.new("ShaderNodeTexCoord")
    sep = nt.nodes.new("ShaderNodeVectorMath")
    sep.operation = "LENGTH"
    nt.links.new(tc.outputs["Object"], sep.inputs[0])
    mr = nt.nodes.new("ShaderNodeMath")
    mr.operation = "DIVIDE"
    mr.inputs[1].default_value = r * 1.05
    nt.links.new(sep.outputs["Value"], mr.inputs[0])
    ramp = nt.nodes.new("ShaderNodeValToRGB")
    el = ramp.color_ramp.elements
    el[0].position, el[0].color = 0.15, hexcol(P["water_deep"])
    el[1].position, el[1].color = 0.95, hexcol(P["water_edge"])
    nt.links.new(mr.outputs["Value"], ramp.inputs["Fac"])
    nt.links.new(ramp.outputs["Color"], b.inputs["Base Color"])
    MATS["water"] = wm
    w = _flat_poly("pond_water", [(x - c[0], y - c[1]) for x, y in
                                  _blob_ring(c, r, 0.06, seed=5)], 0.0, 0.05, wm)
    w.location = (c[0], c[1], 0.075)
    rnd = random.Random(13)
    rocks = Batch("pond_rocks", [M("stone", rough=0.7), M("stone2", rough=0.7),
                                 M("stone3", rough=0.7)])
    ring = _blob_ring(c, r * 1.12, 0.06, n=26, seed=5)
    for k, (x, y) in enumerate(ring):
        if k % 2 and rnd.random() < 0.7:
            rocks.ico((x, y, 0.08), rnd.uniform(0.13, 0.24), mi=rnd.randint(0, 2), sub=2,
                      scale=(1.2, 1.0, 0.65))
    rocks.build()
    lily = Batch("lilies", [M("lily", rough=0.5), M("f_pink", rough=0.5), M("f_white")])
    for (dx, dy, s) in ((-0.9, 0.5, 0.3), (0.5, -0.9, 0.26), (0.9, 0.7, 0.32), (-0.2, -0.3, 0.22),
                        (-1.2, -0.6, 0.24)):
        lily.disc((c[0] + dx, c[1] + dy, 0.085), s, 0.02, mi=0, segs=18)
    for (dx, dy) in ((-0.9, 0.5), (0.9, 0.7)):
        for k in range(6):
            a = k * 1.047
            lily.ico((c[0] + dx + math.cos(a) * 0.07, c[1] + dy + math.sin(a) * 0.07, 0.13),
                     0.06, mi=1, sub=1, scale=(1.4, 0.8, 0.8))
        lily.ico((c[0] + dx, c[1] + dy, 0.16), 0.045, mi=2, sub=1)
    lily.build()
    # reeds & cattails at the back edge
    rb = Batch("reeds", [M("reed", rough=0.7), M("cattail", rough=0.8)])
    for k in range(16):
        a = rnd.uniform(0.6, 2.2)
        rr = r * rnd.uniform(0.9, 1.08)
        x, y = c[0] + math.cos(a) * rr, c[1] + math.sin(a) * rr
        h = rnd.uniform(0.6, 1.05)
        rb.cone((x, y, 0.05), 0.025, 0.012, h, mi=0, segs=6,
                rot=(rnd.uniform(-0.15, 0.15), rnd.uniform(-0.15, 0.15), 0))
        if k % 3 == 0:
            rb.sphere((x, y, 0.05 + h * 0.85), 0.045, mi=1, seg=8, rings=6, scale=(1, 1, 2.6))
    rb.build()
    # little wooden dock reaching in from the meadow side
    dk = Batch("dock", [MATS_get("plank"), M("wood_dark")])
    for k in range(5):
        dk.box((c[0] - r - 0.35 + k * 0.32, c[1] - 0.35, 0.16), (0.28, 0.9, 0.06), mi=0)
    for (dx, dy) in ((-0.3, -0.7), (-0.3, 0.0), (0.95, -0.7), (0.95, 0.0)):
        dk.box((c[0] - r + dx, c[1] + dy - 0.0, 0.08), (0.08, 0.08, 0.3), mi=1)
    dk.build(bevel=0.01)


def build_barnyard():
    static()
    cy0 = (4.85, 6.15)
    _flat_poly("straw_patch", _blob_ring(cy0, 1.55, 0.1, seed=9), 0.03, 0.04,
               mat_noise("straw", P["hay"], P["straw"], scale=3.0, rough=0.95))
    hay = mat_noise("hay", P["hay2"], P["hay"], scale=5.0, rough=0.95)
    for (x, y, rz) in ((6.55, 7.7, 0.0), (5.55, 8.45, 0.35), (7.4, 6.8, -0.2)):
        cyl("hayroll", 0.48, 0.82, (x, y, 0.48), hay, rot=(math.radians(90), 0, rz), verts=28)
        for s in (-1, 1):
            torus("hayring", 0.3, 0.03, (x + math.sin(rz) * s * 0.41,
                                         y - math.cos(rz) * s * 0.41, 0.48), M("hay2"),
                  rot=(math.radians(90), 0, rz), seg=20, ring=6)
    box("haybale", (0.95, 0.6, 0.5), (7.55, 7.95, 0.28), hay, bevel=0.06)
    box("haybale2", (0.95, 0.6, 0.5), (7.55, 7.95, 0.78), hay, rot=(0, 0, 0.3), bevel=0.06)
    # water trough
    tx, ty = 3.45, 4.15
    box("trough", (1.2, 0.5, 0.34), (tx, ty, 0.2), MATS_get("plank"), bevel=0.04)
    box("trough_w", (1.04, 0.36, 0.05), (tx, ty, 0.35), MATS_get("water"), bevel=0.0)


def build_props():
    static()
    rnd = random.Random(7)
    iron = M("iron", rough=0.5, metallic=0.4)
    lampm = MATS_get("lampglass")
    # lantern posts
    for (x, y) in ((6.25, -4.55), (5.55, 0.25), (-3.0, 1.25), (3.15, 3.3), (-0.4, -0.95)):
        occ(f"lantern_{len(LANTERNS)}", foot=(x + 0.1, y - 0.1))
        cyl("lp_base", 0.12, 0.14, (x, y, 0.07), iron, verts=12)
        cyl("lp_post", 0.045, 1.45, (x, y, 0.75), iron, verts=10)
        box("lp_lamp", (0.2, 0.2, 0.28), (x, y, 1.6), lampm, bevel=0.02)
        cone("lp_cap", 0.2, 0.16, (x, y, 1.82), iron, r2=0.02, verts=4,
             rot=(0, 0, math.radians(45)))
        LANTERNS.append((x, y, 1.6))
        static()
    # well
    wx, wy = WELL["c"]
    occ("well", foot=(wx + 0.5, wy - 0.5))
    stone = mat_noise("wellstone", P["stone2"], P["stone3"], scale=4.0, rough=0.8)
    cyl("well_ring", 0.62, 0.62, (wx, wy, 0.31), stone, verts=18, bevel=0.04)
    cyl("well_water", 0.48, 0.05, (wx, wy, 0.58), MATS_get("water"), verts=18)
    for s in (-1, 1):
        box("well_post", (0.1, 0.1, 1.25), (wx + s * 0.5, wy + s * 0.5, 1.0),
            MATS_get("plank"), rot=(0, 0, math.radians(-45)), bevel=0.015)
    prism("well_roof", [(-0.75, 0), (0.75, 0), (0, 0.55)], 0.95, (wx, wy, 1.55),
          MATS_get("roof"), axis="y", bevel=0.02).rotation_euler = (0, 0, math.radians(45))
    cyl("well_bucket", 0.12, 0.18, (wx + 0.1, wy - 0.45, 0.7), MATS_get("plank"), r2=0.14,
        verts=12)
    static()
    # notice board ("task board") + mailbox near the porch
    nb = (-4.15, 2.35)
    occ("board", foot=(nb[0] + 0.45, nb[1] - 0.45))
    for s in (-1, 1):
        box("nb_post", (0.09, 0.09, 1.5), (nb[0] + s * 0.42, nb[1] + s * 0.42, 0.75),
            M("wood_dark"), bevel=0.015)
    box("nb_board", (1.12, 0.08, 0.7), (nb[0], nb[1], 1.15), MATS_get("plank"),
        rot=(0, 0, math.radians(45)), bevel=0.02)
    for k, col in enumerate(("f_white", "f_yellow", "f_pink", "f_blue")):
        u = -0.3 + 0.2 * k
        box("nb_note", (0.17, 0.02, 0.2), (nb[0] + u * 0.707 + 0.04, nb[1] + u * 0.707 - 0.04,
                                           1.18 + (0.1 if k % 2 else -0.08)),
            M(col, rough=0.8), rot=(0, 0, math.radians(45)), bevel=0.0)
    box("nb_roof", (1.3, 0.3, 0.06), (nb[0] + 0.02, nb[1] - 0.02, 1.55), MATS_get("roof"),
        rot=(math.radians(18), 0, math.radians(45)), bevel=0.01)
    mb = (-3.3, 2.05)
    cyl("mb_post", 0.05, 0.9, (mb[0], mb[1], 0.45), M("wood_dark"), verts=8)
    box("mb_box", (0.48, 0.26, 0.26), (mb[0], mb[1], 0.98), M("f_blue", rough=0.5), bevel=0.08)
    box("mb_flag", (0.03, 0.12, 0.2), (mb[0] + 0.1, mb[1] + 0.15, 1.12), M("f_red"), bevel=0.0)
    static()
    # entrance arch with sign
    ax, ay = ARCH["c"]
    occ("arch", foot=(ax + 0.95, ay - 0.95))
    d = Vector((0.7071, 0.7071, 0))
    wood = MATS_get("plank")
    for s in (-1, 1):
        p = Vector((ax, ay, 0)) + d * 1.25 * s
        cyl("arch_post", 0.11, 2.45, (p.x, p.y, 1.22), M("wood_dark"), verts=12)
        sphere("arch_knob", 0.13, (p.x, p.y, 2.5), M("wood_dark"))
    box("arch_beam", (2.95, 0.16, 0.16), (ax, ay, 2.28), M("wood_dark"),
        rot=(0, 0, math.radians(45)), bevel=0.02)
    box("arch_sign", (2.15, 0.1, 0.5), (ax + 0.05, ay - 0.05, 1.83), M("sign_board"),
        rot=(0, 0, math.radians(45)), bevel=0.04)
    for s in (-1, 1):
        p = Vector((ax, ay, 0)) + d * 0.75 * s
        cyl("arch_chain", 0.012, 0.22, (p.x + 0.03, p.y - 0.03, 2.15), iron, verts=6)
    cu = bpy.data.curves.new("sign_text", "FONT")
    cu.body = "AGENT FARM"
    cu.align_x = "CENTER"
    cu.align_y = "CENTER"
    cu.size = 0.3
    cu.extrude = 0.012
    cu.space_character = 1.05
    tob = bpy.data.objects.new("sign_text", cu)
    Ctx.coll.objects.link(tob)
    tob.location = (ax + 0.05 + 0.04, ay - 0.05 - 0.04, 1.82)
    tob.rotation_euler = (math.radians(90), 0, math.radians(45))
    tob.data.materials.append(M("sign_text", rough=0.6))
    # little flowers growing on the arch posts
    fb = Batch("arch_vines", [M("leaf2"), M("f_pink"), M("f_white")])
    for s in (-1, 1):
        p = Vector((ax, ay, 0)) + d * 1.25 * s
        for k in range(9):
            z = 0.2 + k * 0.24
            a = k * 1.7
            fb.ico((p.x + math.cos(a) * 0.12, p.y + math.sin(a) * 0.12, z), 0.085,
                   mi=0 if k % 3 else 1 + (k // 3) % 2, sub=1)
    fb.build()
    static()
    # beehives
    for (x, y) in ((8.85, -5.9), (8.85, -4.9)):
        box("hive_base", (0.5, 0.5, 0.12), (x, y, 0.06), M("wood_dark"), bevel=0.01)
        for k in range(3):
            box("hive", (0.46, 0.46, 0.2), (x, y, 0.2 + k * 0.21), M("hive", rough=0.7),
                bevel=0.03)
        box("hive_roof", (0.56, 0.56, 0.08), (x, y, 0.84), MATS_get("roof"), bevel=0.02)


def build_fence():
    static()
    wood = mat_noise("fence", "#E9D9C0", "#FFF6E8", scale=3.0, rough=0.7)
    b = Batch("fence", [wood])
    e = ISL - 0.45
    k = 0
    n = 24
    for i in range(n + 1):
        t = -e + 2 * e * i / n
        b.box((-e, t, 0.36), (0.12, 0.12, 0.72))
        b.box((t, e, 0.36), (0.12, 0.12, 0.72))
    for z in (0.3, 0.58):
        b.box((-e, 0, z), (0.07, 2 * e, 0.09))
        b.box((0, e, z), (2 * e, 0.07, 0.09))
    b.build(bevel=0.02)


def scatter_decor():
    static()
    rnd = random.Random(42)
    z = zones()
    hx, hy = HOUSE["c"]
    blocked = [(c[0], c[1], c[2] + 0.35) for c in obstacles()]
    blocked += [(z["meadow_center"][0], z["meadow_center"][1], 2.0), (4.85, 6.15, 1.9),
                (-6.2, 1.0, 1.7), (ARCH["c"][0], ARCH["c"][1], 1.6), (-4.15, 2.35, 0.7),
                (-3.3, 2.05, 0.4), (8.85, -5.4, 0.9), (-7.15, -6.55, 0.6), (3.45, 4.15, 0.8)]
    for p in z["barnyard"]:
        blocked.append((p[0], p[1], 0.75))
    xs = [c[0] for c in bed_centers()]
    ys = [c[1] for c in bed_centers()]
    fx0, fx1 = min(xs) - 1.8, max(xs) + 1.8
    fy0, fy1 = min(ys) - 1.75, max(ys) + 1.8

    def free(x, y, pad=0.0):
        if abs(x) > ISL - 0.55 or abs(y) > ISL - 0.55:
            return False
        if fx0 - pad < x < fx1 + pad and fy0 - pad < y < fy1 + pad:
            return False
        for (bx, by, br) in blocked:
            if math.hypot(x - bx, y - by) < br + pad:
                return False
        for poly in PATHS:
            if _poly_dist((x, y), poly) < 0.6 + pad:
                return False
        return True

    fm = [M("f_pink", rough=0.5), M("f_white", rough=0.5), M("f_yellow", rough=0.5),
          M("f_purple", rough=0.5), M("f_red", rough=0.5), M("f_blue", rough=0.5),
          M("leaf2"), M("f_orange", rough=0.5)]
    fl = Batch("flowers", fm)
    placed = 0
    tries = 0
    while placed < 120 and tries < 6000:
        tries += 1
        x, y = rnd.uniform(-ISL, ISL), rnd.uniform(-ISL, ISL)
        if not free(x, y):
            continue
        col = rnd.choice([0, 0, 1, 2, 2, 3, 4, 5, 7])
        for k in range(rnd.randint(2, 4)):
            px, py = x + rnd.uniform(-0.2, 0.2), y + rnd.uniform(-0.2, 0.2)
            h = rnd.uniform(0.12, 0.24)
            fl.cone((px, py, 0.0), 0.012, 0.008, h, mi=6, segs=5)
            fl.ico((px, py, h + 0.02), rnd.uniform(0.05, 0.075), mi=col, sub=1,
                   scale=(1, 1, 0.75))
        placed += 1
    fl.build()
    gm = [mat("tuft_a", "#7DB858", rough=0.8), mat("tuft_b", "#93C76A", rough=0.8)]
    tf = Batch("tufts", gm)
    placed = 0
    tries = 0
    while placed < 260 and tries < 9000:
        tries += 1
        x, y = rnd.uniform(-ISL, ISL), rnd.uniform(-ISL, ISL)
        if not free(x, y, -0.25):
            continue
        mi = rnd.randint(0, 1)
        for k in range(3):
            a = rnd.uniform(0, 6.28)
            tf.cone((x + math.cos(a) * 0.05, y + math.sin(a) * 0.05, 0.0), 0.04, 0.0,
                    rnd.uniform(0.14, 0.26), mi=mi, segs=4,
                    rot=(math.cos(a) * 0.35, math.sin(a) * 0.35, 0))
        placed += 1
    tf.build()
    lm = leaf_mats()
    bb = Batch("bushes", lm[:2] + [M("f_pink"), M("f_white")])
    spots = [(-9.0, 2.2), (-8.9, 8.0), (-4.0, 9.0), (2.3, 9.3), (8.9, 9.0), (9.2, 4.9),
             (-3.5, 6.3), (9.1, -1.4), (5.5, -8.9), (-9.2, -9.2), (-9.2, -3.9), (3.1, 9.2),
             (6.2, -6.4), (7.7, -6.9)]
    for (x, y) in spots:
        bush(bb, x, y, rnd.uniform(0.9, 1.25), rnd)
        if rnd.random() < 0.6:
            for k in range(5):
                a = rnd.uniform(0, 6.28)
                bb.ico((x + math.cos(a) * 0.35, y + math.sin(a) * 0.35, rnd.uniform(0.3, 0.5)),
                       0.06, mi=2 + k % 2, sub=1)
    bb.build()
    rk = Batch("rocks", [M("stone", rough=0.7), M("stone2", rough=0.7)])
    for (x, y, s) in ((-9.1, -6.3, 0.3), (9.2, -7.6, 0.25), (-6.0, 8.9, 0.28), (9.3, 2.0, 0.22),
                      (-2.6, -9.5, 0.2), (1.8, 5.0, 0.18), (-9.3, 5.2, 0.24)):
        rk.ico((x, y, s * 0.35), s, mi=rnd.randint(0, 1), sub=2, scale=(1.25, 1.0, 0.7))
        rk.ico((x + s * 0.9, y - s * 0.6, s * 0.2), s * 0.55, mi=rnd.randint(0, 1), sub=2,
               scale=(1.2, 1.0, 0.7))
    rk.build()
    # flower garden beds at the front-right
    gb = Batch("garden", [M("f_pink"), M("f_purple"), M("f_yellow"), M("f_white"), lm[0],
                          M("f_orange")])
    for row in range(3):
        for k in range(5):
            x2 = 6.05 + k * 0.45 + rnd.uniform(-0.05, 0.05)
            y2 = -8.4 + row * 0.55 + rnd.uniform(-0.05, 0.05)
            gb.ico((x2, y2, 0.16), 0.2, mi=4, sub=2, scale=(1, 1, 0.8))
            for q in range(4):
                a = q * 1.57 + rnd.uniform(0, 0.6)
                gb.ico((x2 + math.cos(a) * 0.12, y2 + math.sin(a) * 0.12, 0.3), 0.065,
                       mi=(row + k) % 4 if (row + k) % 5 else 5, sub=1)
    gb.build()


# --------------------------------------------------------------------------
def build_all():
    OCCLUDERS.clear()
    WINDOW_LIGHTS.clear()
    LANTERNS.clear()
    CHIMNEY.clear()
    build_island()
    build_paths()
    build_fields()
    build_house()
    build_barn()
    build_silo()
    build_windmill()
    big_tree()
    build_pond()
    build_barnyard()
    build_props()
    build_fence()
    # perimeter trees (back edges + corners)
    round_tree("tree_a", -8.85, 8.85, 1.0, seed=1, apples=True)
    pine("pine_a", -4.4, 9.25, 1.1, seed=3)
    round_tree("tree_c", 4.6, 9.2, 0.95, seed=4)
    pine("pine_b", 8.9, 8.6, 1.2, seed=5)
    round_tree("tree_d", 9.1, 6.6, 0.85, seed=6, apples=True)
    pine("pine_c", -9.0, -5.4, 1.15, seed=7)
    pine("pine_d", -8.6, -8.4, 0.95, seed=8)
    round_tree("tree_e", -9.15, 0.6, 0.8, seed=9)
    scatter_decor()
    return dict(zones=zones(), obstacles=obstacles(), occluders=OCCLUDERS,
                window_lights=list(WINDOW_LIGHTS), lanterns=list(LANTERNS),
                chimney=list(CHIMNEY), blades=BLADES)
