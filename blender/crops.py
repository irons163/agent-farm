"""
Crop sprites for the raised beds: 6 crops x 3 growth stages.

A crop sprite covers one 2x2 bed (centred on the origin, soil top at z=SOIL).
The web app picks the stage from how much work the agent on that bed has done.
"""
import math
import random

import bpy
from mathutils import Vector

from lib import Batch, Ctx, coll, mat

CROPS = ["carrot", "cabbage", "pumpkin", "sunflower", "strawberry", "corn"]
SOIL = 0.24
ROWS = (-0.52, 0.0, 0.52)
COLS = (-0.55, 0.0, 0.55)


def M():
    return dict(
        leaf=mat("c_leaf", "#6DB851", rough=0.6, sheen=0.2),
        leaf2=mat("c_leaf2", "#88CC62", rough=0.6, sheen=0.2),
        dleaf=mat("c_dleaf", "#4E9A45", rough=0.6),
        stem=mat("c_stem", "#5E9C3E", rough=0.6),
        orange=mat("c_orange", "#F58A2E", rough=0.45, coat=0.3),
        pumpkin=mat("c_pumpkin", "#F49A35", rough=0.4, coat=0.4),
        pumpkin_g=mat("c_pumpkin_g", "#9CC45A", rough=0.45),
        cabbage=mat("c_cabbage", "#B7DD8B", rough=0.5, sheen=0.3),
        cabbage2=mat("c_cabbage2", "#97CB6E", rough=0.5, sheen=0.3),
        yellow=mat("c_yellow", "#FFCB2E", rough=0.5),
        brown=mat("c_brown", "#6B4128", rough=0.8),
        red=mat("c_red", "#EE3E48", rough=0.3, coat=0.6),
        white=mat("c_white", "#FFFFFF", rough=0.5),
        corn=mat("c_corn", "#F7D45A", rough=0.5),
        husk=mat("c_husk", "#A9CF73", rough=0.6),
        tassel=mat("c_tassel", "#E3C27C", rough=0.8),
    )


def _plants():
    for r in ROWS:
        for c in COLS:
            yield c, r


def sprout(b, x, y, s=1.0, mi_leaf=0, mi_stem=1, rnd=None):
    rnd = rnd or random.Random(0)
    h = 0.12 * s
    b.cone((x, y, SOIL - 0.01), 0.018 * s, 0.012 * s, h, mi=mi_stem, segs=6)
    a = rnd.uniform(0, math.pi)
    for k in (0, 1):
        ang = a + k * math.pi
        d = Vector((math.cos(ang), math.sin(ang), 0))
        p = Vector((x, y, SOIL + h)) + d * 0.07 * s + Vector((0, 0, 0.015 * s))
        b.sphere(p, 0.07 * s, mi=mi_leaf, seg=12, rings=8, scale=(1.0, 0.55, 0.32))


def leaf_tuft(b, x, y, h, n, spread, mi, rnd, width=0.035, tilt=0.45):
    for k in range(n):
        ang = 2 * math.pi * k / n + rnd.uniform(-0.3, 0.3)
        t = tilt + rnd.uniform(-0.1, 0.15)
        b.cone((x + math.cos(ang) * spread * 0.2, y + math.sin(ang) * spread * 0.2, SOIL - 0.01),
               width, 0.004, h * rnd.uniform(0.8, 1.1), mi=mi, segs=6,
               rot=(-math.sin(ang) * t, math.cos(ang) * t, 0))


def leaf_disc(b, p, r, mi, rnd, tilt=0.35):
    ang = rnd.uniform(0, 2 * math.pi)
    b.sphere(p, r, mi=mi, seg=14, rings=8, scale=(1.0, 0.8, 0.22))


def build(crop, stage):
    Ctx.coll = coll("Crop")
    m = M()
    names = list(m.keys())
    b = Batch(f"crop_{crop}_{stage}", [m[k] for k in names])
    I = {k: i for i, k in enumerate(names)}
    rnd = random.Random(hash((crop, stage)) & 0xFFFF)
    if stage == 1:
        for x, y in _plants():
            sprout(b, x + rnd.uniform(-0.05, 0.05), y + rnd.uniform(-0.04, 0.04),
                   rnd.uniform(0.9, 1.2), I["leaf2"], I["stem"], rnd)
        return [b.build()]

    if crop == "carrot":
        for x, y in _plants():
            h = 0.32 if stage == 2 else 0.46
            leaf_tuft(b, x, y, h, 7, 0.3, I["leaf"] if stage == 3 else I["leaf2"], rnd,
                      width=0.03)
            for k in range(5):
                ang = rnd.uniform(0, 6.28)
                b.ico((x + math.cos(ang) * 0.09, y + math.sin(ang) * 0.09,
                       SOIL + h * rnd.uniform(0.55, 0.9)), 0.05, mi=I["leaf2"], sub=1)
            if stage == 3:
                b.cone((x, y, SOIL - 0.04), 0.075, 0.06, 0.1, mi=I["orange"], segs=14)
                b.sphere((x, y, SOIL + 0.06), 0.06, mi=I["orange"], seg=14, rings=8,
                         scale=(1, 1, 0.5))
    elif crop == "cabbage":
        for x, y in _plants():
            if stage == 2:
                b.sphere((x, y, SOIL + 0.08), 0.1, mi=I["cabbage"], seg=16, rings=10)
                for k in range(5):
                    ang = k * 1.256 + rnd.uniform(0, 0.4)
                    d = Vector((math.cos(ang), math.sin(ang), 0))
                    b.sphere(Vector((x, y, SOIL + 0.05)) + d * 0.11, 0.09, mi=I["cabbage2"],
                             seg=12, rings=8, scale=(1.0, 0.75, 0.35))
            else:
                b.sphere((x, y, SOIL + 0.15), 0.17, mi=I["cabbage"], seg=20, rings=12,
                         scale=(1, 1, 0.92))
                for k in range(7):
                    ang = k * 0.9 + rnd.uniform(0, 0.4)
                    d = Vector((math.cos(ang), math.sin(ang), 0))
                    b.sphere(Vector((x, y, SOIL + 0.1)) + d * 0.15, 0.13, mi=I["cabbage2"],
                             seg=14, rings=8, scale=(1.0, 0.8, 0.5))
    elif crop == "pumpkin":
        spots = [(-0.45, -0.4), (0.4, 0.35), (-0.3, 0.45), (0.45, -0.45), (0.0, 0.0)]
        for k, (x, y) in enumerate(spots):
            for q in range(4):
                ang = q * 1.57 + rnd.uniform(-0.3, 0.3)
                d = Vector((math.cos(ang), math.sin(ang), 0))
                leaf_disc(b, Vector((x, y, SOIL + 0.16 + rnd.uniform(0, 0.08))) + d * 0.2,
                          0.17 if stage == 3 else 0.14, I["leaf"], rnd)
            b.cone((x, y, SOIL - 0.01), 0.02, 0.015, 0.2, mi=I["stem"], segs=6)
        targets = [(-0.12, -0.15), (0.32, -0.05), (-0.35, 0.18)] if stage == 3 else \
            [(-0.1, -0.15), (0.3, 0.0)]
        for (x, y) in targets:
            r = 0.24 if stage == 3 else 0.1
            mi = I["pumpkin"] if stage == 3 else I["pumpkin_g"]
            for q in range(8):
                ang = q * math.pi / 4
                d = Vector((math.cos(ang), math.sin(ang), 0))
                b.sphere(Vector((x, y, SOIL + r * 0.78)) + d * r * 0.42, r * 0.62, mi=mi,
                         seg=16, rings=10, scale=(0.75, 0.75, 1.0))
            b.sphere((x, y, SOIL + r * 0.8), r * 0.8, mi=mi, seg=18, rings=10, scale=(1, 1, 0.9))
            b.cone((x, y, SOIL + r * 1.4), 0.03, 0.02, 0.1 if stage == 3 else 0.05,
                   mi=I["brown"], segs=6, rot=(0.2, 0.2, 0))
    elif crop == "sunflower":
        pts = [(-0.5, -0.45), (0.5, -0.4), (0.0, 0.05), (-0.45, 0.5), (0.5, 0.5)]
        for (x, y) in pts:
            h = 0.5 if stage == 2 else 0.95 + rnd.uniform(-0.08, 0.1)
            b.cone((x, y, SOIL - 0.01), 0.03, 0.022, h, mi=I["stem"], segs=8)
            for q, z in enumerate((0.3, 0.55, 0.78)):
                if z * (1.0 if stage == 3 else 0.6) > h:
                    continue
                ang = q * 2.2 + rnd.uniform(0, 0.5)
                d = Vector((math.cos(ang), math.sin(ang), 0))
                b.sphere(Vector((x, y, SOIL + z * h)) + d * 0.1, 0.1, mi=I["leaf"], seg=12,
                         rings=8, scale=(1.0, 0.6, 0.2))
            if stage == 3:
                c = Vector((x, y, SOIL + h + 0.02))
                f = Vector((0.7, -0.7, 0.35)).normalized()
                u = Vector((0.7071, 0.7071, 0))
                v = f.cross(u).normalized()
                for q in range(12):
                    a = q * math.pi / 6
                    p = c + (u * math.cos(a) + v * math.sin(a)) * 0.13
                    b.ico(p, 0.06, mi=I["yellow"], sub=1, scale=(1, 1, 1))
                b.ico(c + f * 0.03, 0.09, mi=I["brown"], sub=2, scale=(1, 1, 1))
            else:
                b.ico((x, y, SOIL + h + 0.03), 0.06, mi=I["leaf2"], sub=1)
    elif crop == "strawberry":
        for x, y in _plants():
            for q in range(6):
                ang = q * 1.047 + rnd.uniform(-0.2, 0.2)
                d = Vector((math.cos(ang), math.sin(ang), 0))
                b.sphere(Vector((x, y, SOIL + 0.08)) + d * 0.1, 0.085, mi=I["dleaf"], seg=12,
                         rings=8, scale=(1.0, 0.75, 0.3))
            if stage == 2:
                for q in range(2):
                    ang = rnd.uniform(0, 6.28)
                    p = Vector((x + math.cos(ang) * 0.09, y + math.sin(ang) * 0.09, SOIL + 0.14))
                    b.ico(p, 0.035, mi=I["white"], sub=1)
                    b.ico(p + Vector((0, 0, 0.012)), 0.015, mi=I["yellow"], sub=1)
            else:
                for q in range(3):
                    ang = rnd.uniform(-1.6, 0.6)
                    p = Vector((x + math.cos(ang) * 0.15, y + math.sin(ang) * 0.15, SOIL + 0.07))
                    b.cone(p, 0.055, 0.0, 0.1, mi=I["red"], segs=12, rot=(math.pi, 0, 0))
                    b.sphere(p, 0.055, mi=I["red"], seg=12, rings=8, scale=(1, 1, 0.6))
                    b.sphere(p + Vector((0, 0, 0.03)), 0.04, mi=I["leaf"], seg=10, rings=6,
                             scale=(1, 1, 0.3))
    elif crop == "corn":
        for x, y in _plants():
            h = 0.55 if stage == 2 else 1.05 + rnd.uniform(-0.06, 0.08)
            b.cone((x, y, SOIL - 0.01), 0.035, 0.02, h, mi=I["stem"], segs=8)
            for q in range(4 if stage == 3 else 3):
                ang = q * 1.9 + rnd.uniform(0, 0.5)
                z = SOIL + h * (0.25 + q * 0.18)
                b.cone((x, y, z), 0.03, 0.002, 0.42 if stage == 3 else 0.3, mi=I["leaf"],
                       segs=5, rot=(-math.sin(ang) * 1.0, math.cos(ang) * 1.0, 0))
            if stage == 3:
                p = Vector((x + 0.05, y - 0.05, SOIL + h * 0.55))
                b.sphere(p, 0.065, mi=I["corn"], seg=12, rings=10, scale=(1, 1, 2.0))
                b.cone(p + Vector((0, 0, -0.12)), 0.07, 0.02, 0.2, mi=I["husk"], segs=10,
                       rot=(0.2, -0.2, 0))
                for q in range(5):
                    ang = q * 1.256
                    b.cone((x, y, SOIL + h - 0.02), 0.012, 0.0, 0.18, mi=I["tassel"], segs=4,
                           rot=(-math.sin(ang) * 0.6, math.cos(ang) * 0.6, 0))
    return [b.build()]


def destroy(objs):
    for ob in objs:
        bpy.data.objects.remove(ob, do_unlink=True)
