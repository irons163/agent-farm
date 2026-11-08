"""
Twelve chibi farm animals built from primitives, each with a tiny rig so the
renderer can pose them (idle / walk x4 / work x2 / sleep).

Every animal is built facing +X (front-right on screen) at the origin; the
renderer spins `rig.root` to get the other three iso directions.
"""
import math

import bpy
from mathutils import Matrix, Vector

import lib
from lib import Ctx, box, capsule, coll, cone, cyl, empty, ico, mat, mat_spots, sphere, torus

KINDS = ["fox", "cat", "rabbit", "owl", "cow", "pig", "sheep", "hen", "duck", "corgi", "goat",
         "pony"]
NAMES = {
    "fox": {"zh": "狐狸", "en": "Fox"},
    "cat": {"zh": "貓咪", "en": "Cat"},
    "rabbit": {"zh": "兔兔", "en": "Bunny"},
    "owl": {"zh": "貓頭鷹", "en": "Owl"},
    "cow": {"zh": "乳牛", "en": "Cow"},
    "pig": {"zh": "小豬", "en": "Piggy"},
    "sheep": {"zh": "綿羊", "en": "Sheep"},
    "hen": {"zh": "母雞", "en": "Hen"},
    "duck": {"zh": "小鴨", "en": "Duck"},
    "corgi": {"zh": "柯基", "en": "Corgi"},
    "goat": {"zh": "山羊", "en": "Goat"},
    "pony": {"zh": "小馬", "en": "Pony"},
}


class Rig:
    def __init__(self, kind):
        self.kind = kind
        self.coll = None
        self.root = None
        self.body = None
        self.head = None
        self.tail = None
        self.legs = []          # [(pivot, phase_sign, is_front)]
        self.wings = []         # [(pivot, side)]
        self.eyes_open = []
        self.eyes_closed = []
        self.biped = False
        self.base = {}
        self.leg_h = 0.3
        self.belly = 0.2        # height of the body bottom above ground


def _fur(name, color, rough=0.72, sheen=0.35):
    return mat(name, color, rough=rough, sheen=sheen, spec=0.3)


def _attach(ob, piv):
    bpy.context.view_layer.update()
    ob.parent = piv
    ob.matrix_parent_inverse = piv.matrix_world.inverted()
    return ob


EYE = None


def _eye_mats():
    return (mat("eye_black", "#221C20", rough=0.12, coat=1.0, spec=0.6),
            mat("eye_shine", "#FFFFFF", rough=0.3, emit="#FFFFFF", emit_strength=3.0),
            mat("eye_white", "#FFFFFF", rough=0.35),
            mat("blush", "#FF9DB0", rough=0.9))


def _surf(c, radii, az, el, side):
    d = Vector((math.cos(el) * math.cos(az), side * math.cos(el) * math.sin(az), math.sin(el)))
    k = 1.0 / math.sqrt((d.x / radii[0]) ** 2 + (d.y / radii[1]) ** 2 + (d.z / radii[2]) ** 2)
    return Vector(c) + d * k, d


def add_eyes(rig, c, radii, az=0.55, el=0.18, size=0.072, ring=False, blush=True,
             blush_az=0.95, blush_el=-0.12, inset=0.35, piv=None):
    black, shine, white, pink = _eye_mats()
    piv = piv or rig.head
    for side in (-1, 1):
        p, d = _surf(c, radii, az, el, side)
        p = p - d * size * inset
        rot = (0, -el, side * az)
        if ring:
            w = sphere("eye_w", size * 1.25, p - d * size * 0.15, white, scale=(0.6, 1, 1.15),
                       rot=rot, seg=20, rings=12)
            rig.eyes_open.append(_attach(w, piv))
            p = p + d * size * 0.32
        e = sphere("eye", size, p, black, scale=(0.62, 1, 1.18), rot=rot, seg=20, rings=12)
        rig.eyes_open.append(_attach(e, piv))
        hl = sphere("eye_hl", size * 0.32,
                    p + d * size * 0.42 + Vector((0.0, 0.0, size * 0.42)) +
                    Vector((0, -side * 0, 0)), shine, seg=10, rings=6)
        rig.eyes_open.append(_attach(hl, piv))
        hl2 = sphere("eye_hl2", size * 0.15,
                     p + d * size * 0.45 + Vector((0.0, 0.0, -size * 0.38)), shine, seg=8,
                     rings=6)
        rig.eyes_open.append(_attach(hl2, piv))
        # closed eye: a little arc
        z = d.copy()
        up = Vector((0, 0, 1))
        y = (up - z * up.dot(z)).normalized()
        x = y.cross(z)
        mtx = Matrix((x, y, z)).transposed()
        ce = torus("eye_closed", size * 0.85, size * 0.2, p + d * size * 0.45, black, seg=14,
                   ring=8, arc=math.pi)
        ce.rotation_euler = (mtx @ Matrix.Rotation(math.pi, 3, "Z")).to_euler()
        ce.hide_render = True
        rig.eyes_closed.append(_attach(ce, piv))
        if blush:
            bp, bd = _surf(c, radii, blush_az, blush_el, side)
            b = sphere("blush", size * 0.95, bp - bd * 0.02, pink, scale=(0.35, 1.25, 0.8),
                       rot=(0, -blush_el, side * blush_az), seg=16, rings=8)
            _attach(b, piv)


def _legs_quad(rig, m, hips, r, hip_z, hoof=None, hoof_h=0.07):
    """hips: [(x, y, phase_sign, is_front)]"""
    for (x, y, ph, front) in hips:
        piv = empty("leg_piv", (x, y, hip_z), parent=rig.root)
        leg = capsule("leg", r, (x, y, r * 0.95), (x, y, hip_z + 0.12), m)
        _attach(leg, piv)
        if hoof:
            h = cyl("hoof", r * 1.04, hoof_h, (x, y, hoof_h / 2 + 0.005), hoof, verts=16)
            _attach(h, piv)
        rig.legs.append((piv, ph, front))
    rig.leg_h = hip_z


def _new_rig(kind, body_c):
    rig = Rig(kind)
    rig.coll = coll("Animal_" + kind)
    Ctx.coll = rig.coll
    rig.root = empty("root", (0, 0, 0))
    rig.body = empty("body_piv", body_c, parent=rig.root)
    return rig


def _head(rig, neck):
    bpy.context.view_layer.update()
    rig.head = empty("head_piv", Vector(neck) - Vector(rig.body.location), parent=rig.body)
    return rig.head


def _tail(rig, base):
    rig.tail = empty("tail_piv", Vector(base) - Vector(rig.body.location), parent=rig.body)
    return rig.tail


def _body(rig, ob):
    return _attach(ob, rig.body)


# --------------------------------------------------------------------------
# individual animals
# --------------------------------------------------------------------------
def build_fox():
    org = _fur("fox_org", "#F28B3F")
    cream = _fur("fox_cream", "#FFF5E8")
    dark = _fur("fox_dark", "#5B3B33", sheen=0.2)
    nose = mat("nose_dark", "#2A2225", rough=0.25, coat=0.6)
    rig = _new_rig("fox", (0, 0, 0.6))
    _body(rig, sphere("body", 1, (0, 0, 0.6), org, scale=(0.5, 0.35, 0.33)))
    _body(rig, sphere("chest", 1, (0.27, 0, 0.56), cream, scale=(0.24, 0.25, 0.27)))
    _legs_quad(rig, dark, [(0.27, 0.16, 1, True), (0.27, -0.16, -1, True),
                           (-0.27, 0.16, -1, False), (-0.27, -0.16, 1, False)], 0.085, 0.42)
    h = _head(rig, (0.36, 0, 0.82))
    hc, hr = (0.45, 0, 1.06), (0.37, 0.39, 0.34)
    _attach(sphere("head", 1, hc, org, scale=hr), h)
    for s in (-1, 1):
        _attach(sphere("cheek", 0.17, (0.58, s * 0.2, 0.94), cream, scale=(1, 1.1, 0.85)), h)
        erot = (-s * math.radians(16), math.radians(-8), 0)
        _attach(cone("ear", 0.17, 0.4, (0.38, s * 0.22, 1.5), org, r2=0.012, rot=erot,
                     verts=20), h)
        _attach(cone("ear_in", 0.1, 0.27, (0.415, s * 0.22, 1.47), cream, r2=0.01, rot=erot,
                     verts=16), h)
        _attach(cone("ear_tip", 0.075, 0.12, (0.365, s * 0.245, 1.65), dark, r2=0.008,
                     rot=erot, verts=16), h)
    _attach(sphere("muzzle", 1, (0.75, 0, 0.98), cream, scale=(0.19, 0.14, 0.12)), h)
    _attach(sphere("nose", 0.055, (0.93, 0, 1.01), nose), h)
    add_eyes(rig, hc, hr, az=0.5, el=0.2, size=0.07)
    t = _tail(rig, (-0.42, 0, 0.66))
    _attach(sphere("tail", 1, (-0.68, 0, 0.84), org, scale=(0.34, 0.19, 0.19),
                   rot=(0, math.radians(38), 0)), t)
    _attach(sphere("tail_tip", 0.15, (-0.92, 0, 1.03), cream), t)
    rig.belly = 0.6 - 0.33
    return rig


def build_cat():
    fur = _fur("cat_fur", "#A3ADC2")
    light = _fur("cat_light", "#F1F3F8")
    stripe = _fur("cat_stripe", "#7E899F")
    pink = mat("pink_nose", "#F4A3B3", rough=0.4)
    rig = _new_rig("cat", (0, 0, 0.55))
    _body(rig, sphere("body", 1, (0, 0, 0.55), fur, scale=(0.44, 0.31, 0.31)))
    _body(rig, sphere("belly", 1, (0.2, 0, 0.5), light, scale=(0.25, 0.24, 0.25)))
    srot = (Matrix.Rotation(math.radians(90), 3, "Y") @
            Matrix.Rotation(math.radians(90), 3, "Z")).to_euler()
    for k in range(3):
        _body(rig, torus("stripe", 0.29 - 0.03 * abs(k - 1), 0.03,
                         (-0.2 + k * 0.13, 0, 0.6), stripe, rot=srot, seg=24, ring=6,
                         arc=math.pi))
    _legs_quad(rig, fur, [(0.24, 0.15, 1, True), (0.24, -0.15, -1, True),
                          (-0.24, 0.15, -1, False), (-0.24, -0.15, 1, False)], 0.08, 0.36)
    h = _head(rig, (0.32, 0, 0.8))
    hc, hr = (0.4, 0, 1.03), (0.37, 0.41, 0.34)
    _attach(sphere("head", 1, hc, fur, scale=hr), h)
    for s in (-1, 1):
        _attach(cone("ear", 0.15, 0.27, (0.36, s * 0.24, 1.35), fur, r2=0.01,
                     rot=(-s * math.radians(18), math.radians(-6), 0), verts=4), h)
        _attach(cone("ear_in", 0.085, 0.18, (0.39, s * 0.235, 1.33), pink, r2=0.01,
                     rot=(-s * math.radians(18), math.radians(-6), 0), verts=4), h)
        _attach(sphere("muzzle", 0.11, (0.7, s * 0.075, 0.93), light), h)
        for k in (-1, 0, 1):
            w = cyl("whisker", 0.006, 0.32, (0.74, s * 0.26, 0.93 + k * 0.035),
                    mat("whisker", "#FFFFFF", rough=0.5),
                    rot=(math.radians(90 + s * 4), 0, s * math.radians(-12 + k * 6)), verts=4)
            _attach(w, h)
    _attach(sphere("nose", 0.04, (0.79, 0, 0.99), pink, scale=(1, 1.3, 0.8)), h)
    add_eyes(rig, hc, hr, az=0.48, el=0.15, size=0.075)
    t = _tail(rig, (-0.42, 0, 0.58))
    pts = [(-0.44, 0, 0.58), (-0.6, 0, 0.66), (-0.7, 0, 0.82), (-0.72, 0, 1.0),
           (-0.66, 0, 1.15), (-0.56, 0, 1.2)]
    for k, (a, b) in enumerate(zip(pts, pts[1:])):
        _attach(capsule("tail", 0.055, a, b, fur if k < 4 else stripe), t)
    rig.belly = 0.55 - 0.31
    return rig


def build_rabbit():
    fur = _fur("rab_fur", "#F8F2EA")
    pink = mat("rab_pink", "#F7B5C3", rough=0.6)
    rig = _new_rig("rabbit", (-0.05, 0, 0.5))
    _body(rig, sphere("body", 1, (-0.05, 0, 0.52), fur, scale=(0.42, 0.34, 0.38)))
    _legs_quad(rig, fur, [(0.22, 0.13, 1, True), (0.22, -0.13, -1, True)], 0.075, 0.3)
    for s, ph in ((1, -1), (-1, 1)):
        piv = empty("leg_piv", (-0.2, s * 0.2, 0.22), parent=rig.root)
        f = sphere("foot", 1, (-0.12, s * 0.21, 0.1), fur, scale=(0.24, 0.1, 0.1))
        _attach(f, piv)
        _attach(sphere("haunch", 1, (-0.22, s * 0.22, 0.28), fur, scale=(0.2, 0.12, 0.2)), piv)
        rig.legs.append((piv, ph, False))
    h = _head(rig, (0.22, 0, 0.82))
    hc, hr = (0.3, 0, 1.04), (0.36, 0.38, 0.33)
    _attach(sphere("head", 1, hc, fur, scale=hr), h)
    for s in (-1, 1):
        rot = (-s * math.radians(10), math.radians(-14), 0)
        _attach(sphere("ear", 1, (0.2, s * 0.13, 1.56), fur, scale=(0.1, 0.075, 0.34), rot=rot),
                h)
        _attach(sphere("ear_in", 1, (0.235, s * 0.13, 1.56), pink, scale=(0.06, 0.05, 0.27),
                       rot=rot), h)
        _attach(sphere("cheek", 0.1, (0.6, s * 0.07, 0.95), fur), h)
    _attach(sphere("nose", 0.04, (0.68, 0, 1.0), pink, scale=(1, 1.3, 0.85)), h)
    _attach(box("teeth", (0.03, 0.06, 0.06), (0.66, 0, 0.88), mat("tooth", "#FFFFFF"),
                bevel=0.01), h)
    add_eyes(rig, hc, hr, az=0.55, el=0.15, size=0.072)
    t = _tail(rig, (-0.45, 0, 0.5))
    _attach(sphere("tail", 0.14, (-0.48, 0, 0.5), fur), t)
    rig.belly = 0.15
    return rig


def build_owl():
    brown = _fur("owl_brown", "#A57A57")
    dark = _fur("owl_dark", "#7A563D")
    cream = _fur("owl_cream", "#F4E4C8")
    face = _fur("owl_face", "#FBF1DF")
    beak = mat("beak", "#F3A642", rough=0.4)
    rig = _new_rig("owl", (0, 0, 0.62))
    rig.biped = True
    _body(rig, sphere("body", 1, (0, 0, 0.66), brown, scale=(0.44, 0.44, 0.5)))
    _body(rig, sphere("belly", 1, (0.2, 0, 0.58), cream, scale=(0.29, 0.33, 0.36)))
    for k, (x, y, z) in enumerate(((0.45, 0.0, 0.62), (0.43, 0.13, 0.5), (0.43, -0.13, 0.5),
                                   (0.44, 0.07, 0.74), (0.44, -0.07, 0.74), (0.42, 0, 0.42))):
        _body(rig, cone("chev", 0.035, 0.06, (x, y, z), dark, r2=0.0,
                        rot=(math.radians(180), 0, 0), verts=3))
    for s in (-1, 1):
        piv = empty("leg_piv", (0.12, s * 0.15, 0.2), parent=rig.root)
        _attach(sphere("foot", 1, (0.18, s * 0.15, 0.06), beak, scale=(0.14, 0.09, 0.06)), piv)
        _attach(capsule("leg", 0.045, (0.13, s * 0.15, 0.06), (0.1, s * 0.15, 0.3), beak), piv)
        rig.legs.append((piv, s, True))
        wp = empty("wing_piv", Vector((-0.02, s * 0.36, 0.95)) - Vector((0, 0, 0.62)),
                   parent=rig.body)
        w = sphere("wing", 1, (-0.08, s * 0.37, 0.64), dark, scale=(0.26, 0.08, 0.3),
                   rot=(s * math.radians(-6), math.radians(-12), 0))
        _attach(w, wp)
        rig.wings.append((wp, s))
    h = _head(rig, (0.05, 0, 0.98))
    hc, hr = (0.08, 0, 1.18), (0.4, 0.43, 0.36)
    _attach(sphere("head", 1, hc, brown, scale=hr), h)
    for s in (-1, 1):
        _attach(sphere("facedisc", 1, (0.37, s * 0.155, 1.15), face, scale=(0.09, 0.19, 0.21)),
                h)
        _attach(cone("tuft", 0.1, 0.24, (0.08, s * 0.27, 1.53), brown, r2=0.01,
                     rot=(-s * math.radians(28), math.radians(-6), 0), verts=12), h)
    _attach(cone("beak", 0.065, 0.16, (0.45, 0, 1.06), beak, r2=0.0,
                 rot=(0, math.radians(150), 0), verts=12), h)
    add_eyes(rig, (0.3, 0, 1.17), (0.16, 0.5, 0.3), az=0.8, el=0.02, size=0.095,
             blush=False, inset=0.0)
    t = _tail(rig, (-0.4, 0, 0.4))
    for s in (-1, 0, 1):
        _attach(sphere("tailf", 1, (-0.44, s * 0.08, 0.32), dark, scale=(0.14, 0.07, 0.05),
                       rot=(0, math.radians(30), s * 0.3)), t)
    rig.belly = 0.2
    rig.leg_h = 0.2
    return rig


def build_cow():
    spots = mat_spots("cow_spots", "#FBF8F3", "#2F2A2C", scale=2.3, thresh=0.6)
    spots_h = mat_spots("cow_spots_h", "#FBF8F3", "#2F2A2C", scale=3.4, thresh=0.62)
    pink = mat("cow_pink", "#F6BAB6", rough=0.5)
    horn = mat("horn", "#F3E6C9", rough=0.45)
    hoof = mat("hoof", "#4B4041", rough=0.4)
    dark = mat("nose_dark", "#2A2225", rough=0.25, coat=0.6)
    gold = mat("bell", "#F4C64E", rough=0.25, metallic=0.8)
    collar = mat("collar", "#E2574C", rough=0.5)
    rig = _new_rig("cow", (0, 0, 0.66))
    _body(rig, sphere("body", 1, (0, 0, 0.66), spots, scale=(0.56, 0.37, 0.36)))
    _body(rig, sphere("udder", 0.13, (-0.18, 0, 0.36), pink, scale=(1, 1.2, 0.8)))
    _legs_quad(rig, mat_spots("cow_leg", "#FBF8F3", "#2F2A2C", scale=2.0, thresh=0.7),
               [(0.32, 0.18, 1, True), (0.32, -0.18, -1, True),
                (-0.32, 0.18, -1, False), (-0.32, -0.18, 1, False)], 0.1, 0.46, hoof=hoof,
               hoof_h=0.09)
    h = _head(rig, (0.45, 0, 0.88))
    hc, hr = (0.53, 0, 1.08), (0.33, 0.37, 0.31)
    _attach(sphere("head", 1, hc, spots_h, scale=hr), h)
    _attach(sphere("muzzle", 1, (0.8, 0, 0.96), pink, scale=(0.18, 0.26, 0.16)), h)
    for s in (-1, 1):
        _attach(sphere("nostril", 0.035, (0.95, s * 0.09, 0.99), dark, scale=(0.6, 1, 1.3)), h)
        _attach(sphere("ear", 1, (0.48, s * 0.39, 1.13), spots_h, scale=(0.08, 0.17, 0.06),
                       rot=(s * math.radians(-15), 0, 0)), h)
        _attach(sphere("ear_in", 1, (0.5, s * 0.4, 1.13), pink, scale=(0.05, 0.12, 0.035),
                       rot=(s * math.radians(-15), 0, 0)), h)
        _attach(cone("horn", 0.055, 0.17, (0.47, s * 0.17, 1.38), horn, r2=0.02,
                     rot=(-s * math.radians(25), math.radians(-10), 0), verts=12), h)
    _attach(sphere("tuft", 0.09, (0.58, 0, 1.36), mat("cow_black", "#2F2A2C", rough=0.7)), h)
    add_eyes(rig, hc, hr, az=0.6, el=0.22, size=0.07)
    _body(rig, torus("collar", 0.27, 0.035, (0.42, 0, 0.84), collar,
                     rot=(0, math.radians(70), 0), scale=(1, 1.15, 1), seg=24, ring=8))
    _body(rig, sphere("bell", 0.075, (0.56, 0, 0.66), gold))
    t = _tail(rig, (-0.55, 0, 0.85))
    _attach(capsule("tail", 0.03, (-0.56, 0, 0.86), (-0.66, 0, 0.5),
                    mat("cow_white", "#FBF8F3")), t)
    _attach(sphere("tailtuft", 0.07, (-0.67, 0, 0.47), mat("cow_black", "#2F2A2C"),
                   scale=(1, 1, 1.4)), t)
    rig.belly = 0.66 - 0.36
    return rig


def build_pig():
    pink = _fur("pig_pink", "#F8B8C4", sheen=0.25, rough=0.6)
    dpink = mat("pig_dpink", "#EE96A9", rough=0.55)
    dark = mat("pig_nostril", "#B9586E", rough=0.6)
    hoof = mat("pig_hoof", "#C47787", rough=0.5)
    rig = _new_rig("pig", (0, 0, 0.56))
    _body(rig, sphere("body", 1, (0, 0, 0.56), pink, scale=(0.52, 0.39, 0.37)))
    _legs_quad(rig, pink, [(0.28, 0.18, 1, True), (0.28, -0.18, -1, True),
                           (-0.28, 0.18, -1, False), (-0.28, -0.18, 1, False)], 0.095, 0.34,
               hoof=hoof)
    h = _head(rig, (0.42, 0, 0.78))
    hc, hr = (0.5, 0, 0.94), (0.36, 0.39, 0.34)
    _attach(sphere("head", 1, hc, pink, scale=hr), h)
    _attach(cyl("snout", 0.16, 0.14, (0.84, 0, 0.88), dpink, rot=(0, math.radians(90), 0),
                verts=28, scale=(1, 1.12, 1), bevel=0.03), h)
    for s in (-1, 1):
        _attach(sphere("nostril", 0.035, (0.915, s * 0.06, 0.88), dark, scale=(0.4, 0.8, 1.2)),
                h)
        _attach(cone("ear", 0.15, 0.22, (0.48, s * 0.24, 1.25), dpink, r2=0.01,
                     rot=(-s * math.radians(20), math.radians(35), 0), verts=3,
                     scale=(1, 1, 1)), h)
    add_eyes(rig, hc, hr, az=0.52, el=0.24, size=0.068)
    t = _tail(rig, (-0.5, 0, 0.66))
    _attach(torus("tail", 0.075, 0.025, (-0.56, 0, 0.7), pink, rot=(math.radians(90), 0, 0),
                  seg=20, ring=8, arc=math.radians(320)), t)
    rig.belly = 0.56 - 0.37
    return rig


def build_sheep():
    wool = mat("wool", "#FCFAF5", rough=0.95, sheen=0.6, spec=0.2)
    face = _fur("sheep_face", "#43393C", sheen=0.15)
    rig = _new_rig("sheep", (0, 0, 0.66))
    _body(rig, sphere("body", 1, (0, 0, 0.66), wool, scale=(0.46, 0.36, 0.33)))
    import random
    rnd = random.Random(5)
    for k in range(26):
        a = rnd.uniform(0, 2 * math.pi)
        e = rnd.uniform(-0.6, 1.2)
        d = Vector((math.cos(a) * math.cos(e), math.sin(a) * math.cos(e), math.sin(e)))
        p = Vector((0, 0, 0.66)) + Vector((d.x * 0.46, d.y * 0.36, d.z * 0.33))
        _body(rig, ico("puff", rnd.uniform(0.15, 0.21), p, wool, sub=2))
    _legs_quad(rig, face, [(0.26, 0.17, 1, True), (0.26, -0.17, -1, True),
                           (-0.26, 0.17, -1, False), (-0.26, -0.17, 1, False)], 0.07, 0.42)
    h = _head(rig, (0.42, 0, 0.9))
    hc, hr = (0.56, 0, 1.0), (0.27, 0.27, 0.3)
    _attach(sphere("head", 1, hc, face, scale=hr), h)
    for k, (x, y, z, r) in enumerate(((0.5, 0, 1.3, 0.14), (0.42, 0.1, 1.24, 0.12),
                                      (0.42, -0.1, 1.24, 0.12), (0.6, 0.08, 1.27, 0.1),
                                      (0.6, -0.08, 1.27, 0.1))):
        _attach(ico("tuft", r, (x, y, z), wool, sub=2), h)
    for s in (-1, 1):
        _attach(sphere("ear", 1, (0.5, s * 0.3, 1.06), face, scale=(0.07, 0.15, 0.055),
                       rot=(s * math.radians(-20), 0, 0)), h)
    add_eyes(rig, hc, hr, az=0.55, el=0.12, size=0.06, ring=True, blush=True, blush_az=0.9,
             inset=0.1)
    t = _tail(rig, (-0.46, 0, 0.72))
    _attach(ico("tail", 0.12, (-0.52, 0, 0.74), wool, sub=2), t)
    rig.belly = 0.66 - 0.36
    return rig


def build_hen():
    white = _fur("hen_white", "#FFFDF8", sheen=0.3)
    grey = _fur("hen_grey", "#E7E2DA", sheen=0.3)
    red = mat("hen_red", "#EA4B4F", rough=0.45)
    beak = mat("beak", "#F3A642", rough=0.4)
    leg = mat("hen_leg", "#F49B3B", rough=0.45)
    rig = _new_rig("hen", (0, 0, 0.56))
    rig.biped = True
    _body(rig, sphere("body", 1, (-0.02, 0, 0.56), white, scale=(0.42, 0.33, 0.36)))
    for s in (-1, 1):
        piv = empty("leg_piv", (0.02, s * 0.12, 0.26), parent=rig.root)
        _attach(cyl("leg", 0.03, 0.26, (0.02, s * 0.12, 0.14), leg, verts=10), piv)
        for k in (-1, 0, 1):
            _attach(capsule("toe", 0.02, (0.02, s * 0.12, 0.02),
                            (0.13, s * 0.12 + k * 0.05, 0.02), leg), piv)
        rig.legs.append((piv, s, True))
        wp = empty("wing_piv", Vector((0.02, s * 0.3, 0.7)) - Vector((0, 0, 0.56)),
                   parent=rig.body)
        _attach(sphere("wing", 1, (-0.06, s * 0.32, 0.56), grey, scale=(0.27, 0.08, 0.2),
                       rot=(0, math.radians(-12), 0)), wp)
        rig.wings.append((wp, s))
    h = _head(rig, (0.2, 0, 0.78))
    hc, hr = (0.27, 0, 1.0), (0.27, 0.27, 0.28)
    _attach(sphere("head", 1, hc, white, scale=hr), h)
    for k, (x, z, r) in enumerate(((0.22, 1.3, 0.075), (0.3, 1.32, 0.085), (0.38, 1.27, 0.07))):
        _attach(sphere("comb", r, (x, 0, z), red, scale=(1, 0.6, 1)), h)
    _attach(cone("beak", 0.07, 0.15, (0.58, 0, 0.98), beak, r2=0.0,
                 rot=(0, math.radians(90), 0), verts=14), h)
    _attach(sphere("wattle", 1, (0.52, 0, 0.84), red, scale=(0.05, 0.04, 0.08)), h)
    add_eyes(rig, hc, hr, az=0.62, el=0.15, size=0.058)
    t = _tail(rig, (-0.38, 0, 0.66))
    for k, s in enumerate((-1, 0, 1)):
        _attach(sphere("tailf", 1, (-0.46, s * 0.08, 0.86), white if k != 1 else grey,
                       scale=(0.1, 0.06, 0.2), rot=(s * 0.25, math.radians(-25), 0)), t)
    rig.belly = 0.22
    rig.leg_h = 0.26
    return rig


def build_duck():
    yel = _fur("duck_yel", "#FFD85E", sheen=0.3)
    bill = mat("duck_bill", "#FF9E45", rough=0.4)
    rig = _new_rig("duck", (0, 0, 0.44))
    rig.biped = True
    _body(rig, sphere("body", 1, (0, 0, 0.45), yel, scale=(0.43, 0.33, 0.3)))
    _body(rig, cone("tailpt", 0.14, 0.22, (-0.45, 0, 0.56), yel, r2=0.0,
                    rot=(0, math.radians(-55), 0), verts=16))
    for s in (-1, 1):
        piv = empty("leg_piv", (0.05, s * 0.13, 0.16), parent=rig.root)
        _attach(cyl("leg", 0.03, 0.16, (0.05, s * 0.13, 0.1), bill, verts=10), piv)
        _attach(sphere("foot", 1, (0.13, s * 0.13, 0.025), bill, scale=(0.14, 0.09, 0.025)), piv)
        rig.legs.append((piv, s, True))
        wp = empty("wing_piv", Vector((0.0, s * 0.3, 0.55)) - Vector((0, 0, 0.44)),
                   parent=rig.body)
        _attach(sphere("wing", 1, (-0.06, s * 0.32, 0.47), mat("duck_wing", "#F7C94A",
                                                                 rough=0.7, sheen=0.3),
                       scale=(0.24, 0.08, 0.15), rot=(0, math.radians(-15), 0)), wp)
        rig.wings.append((wp, s))
    h = _head(rig, (0.22, 0, 0.66))
    hc, hr = (0.28, 0, 0.88), (0.28, 0.28, 0.27)
    _attach(sphere("head", 1, hc, yel, scale=hr), h)
    _attach(sphere("bill", 1, (0.6, 0, 0.82), bill, scale=(0.2, 0.13, 0.055)), h)
    for k, (dx, dz) in enumerate(((0, 0.0), (-0.05, 0.03), (0.05, 0.02))):
        _attach(sphere("hair", 1, (0.25 + dx, 0, 1.15 + dz), yel, scale=(0.05, 0.03, 0.09),
                       rot=(0, math.radians(-20 + k * 25), 0)), h)
    add_eyes(rig, hc, hr, az=0.58, el=0.18, size=0.06)
    rig.belly = 0.17
    rig.leg_h = 0.16
    return rig


def build_corgi():
    org = _fur("corgi_org", "#EFA35A")
    white = _fur("corgi_white", "#FFF8EF")
    nose = mat("nose_dark", "#2A2225", rough=0.25, coat=0.6)
    tongue = mat("tongue", "#F07C8E", rough=0.4)
    rig = _new_rig("corgi", (-0.05, 0, 0.5))
    _body(rig, sphere("body", 1, (-0.05, 0, 0.5), org, scale=(0.56, 0.33, 0.3)))
    _body(rig, sphere("chest", 1, (0.28, 0, 0.44), white, scale=(0.25, 0.27, 0.25)))
    _body(rig, sphere("belly", 1, (-0.05, 0, 0.38), white, scale=(0.45, 0.27, 0.18)))
    _legs_quad(rig, white, [(0.3, 0.17, 1, True), (0.3, -0.17, -1, True),
                            (-0.36, 0.17, -1, False), (-0.36, -0.17, 1, False)], 0.085, 0.27)
    h = _head(rig, (0.42, 0, 0.75))
    hc, hr = (0.5, 0, 0.92), (0.33, 0.36, 0.3)
    _attach(sphere("head", 1, hc, org, scale=hr), h)
    _attach(sphere("blaze", 1, (0.66, 0, 0.92), white, scale=(0.18, 0.08, 0.22)), h)
    _attach(sphere("muzzle", 1, (0.76, 0, 0.84), white, scale=(0.17, 0.15, 0.12)), h)
    _attach(sphere("nose", 0.05, (0.92, 0, 0.88), nose), h)
    _attach(sphere("tongue", 1, (0.84, 0, 0.73), tongue, scale=(0.05, 0.05, 0.03)), h)
    for s in (-1, 1):
        rot = (-s * math.radians(22), math.radians(-8), 0)
        _attach(cone("ear", 0.16, 0.34, (0.44, s * 0.2, 1.25), org, r2=0.02, rot=rot, verts=20),
                h)
        _attach(cone("ear_in", 0.1, 0.24, (0.47, s * 0.2, 1.23), white, r2=0.01, rot=rot,
                     verts=16), h)
    add_eyes(rig, hc, hr, az=0.52, el=0.2, size=0.068)
    t = _tail(rig, (-0.58, 0, 0.55))
    _attach(sphere("tail", 0.13, (-0.62, 0, 0.58), white), t)
    rig.belly = 0.5 - 0.3
    return rig


def build_goat():
    fur = _fur("goat_fur", "#ECDFCA")
    patch = _fur("goat_patch", "#C9A984")
    horn = mat("goat_horn", "#8E7A66", rough=0.45)
    hoof = mat("hoof", "#4B4041", rough=0.4)
    pink = mat("cow_pink", "#F6BAB6", rough=0.5)
    gold = mat("bell", "#F4C64E", rough=0.25, metallic=0.8)
    rig = _new_rig("goat", (0, 0, 0.66))
    _body(rig, sphere("body", 1, (0, 0, 0.66), fur, scale=(0.5, 0.33, 0.32)))
    _body(rig, sphere("patch", 1, (-0.12, 0, 0.82), patch, scale=(0.3, 0.3, 0.15)))
    _legs_quad(rig, fur, [(0.3, 0.16, 1, True), (0.3, -0.16, -1, True),
                          (-0.3, 0.16, -1, False), (-0.3, -0.16, 1, False)], 0.075, 0.48,
               hoof=hoof)
    h = _head(rig, (0.42, 0, 0.92))
    hc, hr = (0.52, 0, 1.12), (0.31, 0.3, 0.3)
    _attach(sphere("head", 1, hc, fur, scale=hr), h)
    _attach(sphere("muzzle", 1, (0.78, 0, 1.02), fur, scale=(0.16, 0.17, 0.14)), h)
    _attach(sphere("nose", 0.04, (0.92, 0, 1.06), pink, scale=(0.7, 1.4, 0.8)), h)
    _attach(cone("beard", 0.07, 0.2, (0.72, 0, 0.82), mat("beard", "#DCCDB3", rough=0.9),
                 r2=0.0, rot=(0, math.radians(165), 0), verts=12), h)
    for s in (-1, 1):
        _attach(sphere("ear", 1, (0.5, s * 0.33, 1.14), fur, scale=(0.07, 0.17, 0.05),
                       rot=(s * math.radians(-25), 0, 0)), h)
        hr_ = torus("horn", 0.14, 0.035, (0.4, s * 0.12, 1.34), horn,
                    rot=(math.radians(90), 0, 0), seg=16, ring=8, arc=math.radians(150))
        hr_.rotation_euler = (math.radians(90), math.radians(-30), 0)
        _attach(hr_, h)
    add_eyes(rig, hc, hr, az=0.6, el=0.2, size=0.065)
    _body(rig, sphere("bell", 0.07, (0.5, 0, 0.66), gold))
    t = _tail(rig, (-0.5, 0, 0.8))
    _attach(cone("tail", 0.06, 0.18, (-0.54, 0, 0.88), fur, r2=0.0,
                 rot=(0, math.radians(-40), 0), verts=10), t)
    rig.belly = 0.66 - 0.32
    return rig


def build_pony():
    coat = _fur("pony_coat", "#C98457")
    mane = _fur("pony_mane", "#5F3B2B", sheen=0.4)
    snout = _fur("pony_snout", "#EDCDAE")
    hoof = mat("pony_hoof", "#3F3330", rough=0.4)
    rig = _new_rig("pony", (0, 0, 0.78))
    _body(rig, sphere("body", 1, (0, 0, 0.78), coat, scale=(0.54, 0.33, 0.32)))
    _legs_quad(rig, coat, [(0.32, 0.16, 1, True), (0.32, -0.16, -1, True),
                           (-0.32, 0.16, -1, False), (-0.32, -0.16, 1, False)], 0.09, 0.56,
               hoof=hoof, hoof_h=0.1)
    _body(rig, capsule("neck", 0.17, (0.36, 0, 0.88), (0.5, 0, 1.22), coat))
    h = _head(rig, (0.5, 0, 1.18))
    hc, hr = (0.58, 0, 1.38), (0.31, 0.27, 0.28)
    _attach(sphere("head", 1, hc, coat, scale=hr), h)
    _attach(sphere("snout", 1, (0.86, 0, 1.27), snout, scale=(0.17, 0.2, 0.16)), h)
    for s in (-1, 1):
        _attach(sphere("nostril", 0.025, (1.01, s * 0.07, 1.3), mat("nose_dark", "#2A2225"),
                       scale=(0.5, 1, 1.4)), h)
        _attach(cone("ear", 0.07, 0.2, (0.5, s * 0.13, 1.66), coat, r2=0.01,
                     rot=(-s * math.radians(12), math.radians(-12), 0), verts=12), h)
    for k, (x, z, r) in enumerate(((0.62, 1.62, 0.09), (0.52, 1.66, 0.1), (0.42, 1.55, 0.1))):
        _attach(ico("forelock", r, (x, 0, z), mane, sub=2), h)
    for k in range(6):
        t = k / 5
        p = Vector((0.36, 0, 1.04)) + (Vector((0.5, 0, 1.42)) - Vector((0.36, 0, 1.04))) * t
        _body(rig, ico("mane", 0.11 - 0.01 * k, p + Vector((-0.1, 0, 0.12)), mane, sub=2))
    add_eyes(rig, hc, hr, az=0.66, el=0.2, size=0.068)
    t = _tail(rig, (-0.52, 0, 0.92))
    pts = [(-0.54, 0, 0.94), (-0.68, 0, 0.84), (-0.74, 0, 0.66), (-0.72, 0, 0.48)]
    for k, (a, b) in enumerate(zip(pts, pts[1:])):
        _attach(capsule("tail", 0.09 - 0.012 * k, a, b, mane), t)
    rig.belly = 0.78 - 0.32
    return rig


BUILDERS = dict(fox=build_fox, cat=build_cat, rabbit=build_rabbit, owl=build_owl,
                cow=build_cow, pig=build_pig, sheep=build_sheep, hen=build_hen,
                duck=build_duck, corgi=build_corgi, goat=build_goat, pony=build_pony)


def build(kind):
    rig = BUILDERS[kind]()
    bpy.context.view_layer.update()
    rig.base = {ob.name: (ob.location.copy(), ob.rotation_euler.copy())
                for ob in rig.coll.objects if ob.type == "EMPTY"}
    return rig


def _reset(rig):
    for ob in rig.coll.objects:
        if ob.type == "EMPTY" and ob.name in rig.base and ob is not rig.root:
            loc, rot = rig.base[ob.name]
            ob.location = loc
            ob.rotation_euler = rot
    for e in rig.eyes_open:
        e.hide_render = False
    for e in rig.eyes_closed:
        e.hide_render = True
    for piv, _, _ in rig.legs:
        for ch in piv.children:
            ch.hide_render = False


def pose(rig, kind, i=0):
    _reset(rig)
    body, head, tail = rig.body, rig.head, rig.tail
    b0 = rig.base[body.name][0]
    if kind == "idle":
        if tail:
            tail.rotation_euler.z += math.radians(8)
        return
    if kind == "walk":
        s = math.cos(i * math.pi / 2)            # 1, 0, -1, 0
        up = 1.0 - abs(s)
        amp = math.radians(30 if rig.biped else 26)
        for piv, ph, front in rig.legs:
            piv.rotation_euler.y = amp * s * ph
        body.location.z = b0.z + (0.045 if not rig.biped else 0.035) * up
        if rig.biped:
            body.rotation_euler.x = math.radians(7) * s
            for wp, side in rig.wings:
                wp.rotation_euler.x = side * math.radians(-12) * up
        else:
            body.rotation_euler.y = math.radians(2.5) * s
        head.rotation_euler.y = math.radians(-4) * up
        if tail:
            tail.rotation_euler.z = math.radians(18) * s
        return
    if kind == "work":
        if rig.biped:
            body.rotation_euler.y = math.radians(24 if i == 0 else 8)
            head.rotation_euler.y = math.radians(22 if i == 0 else 6)
            for wp, side in rig.wings:
                wp.rotation_euler.x = side * math.radians(-25 if i == 0 else -5)
        else:
            head.rotation_euler.y = math.radians(30 if i == 0 else 10)
            body.rotation_euler.y = math.radians(6 if i == 0 else 2)
            body.location.z = b0.z - (0.03 if i == 0 else 0.0)
            for piv, ph, front in rig.legs:
                if front and i == 0:
                    piv.rotation_euler.y = math.radians(-14) * (1 if ph > 0 else 0)
        if tail:
            tail.rotation_euler.z = math.radians(22 if i == 0 else -22)
        return
    if kind == "sleep":
        drop = max(0.0, rig.belly - 0.03)
        for piv, _, _ in rig.legs:
            for ch in piv.children:
                ch.hide_render = True
        body.location.z = b0.z - drop
        head.rotation_euler.y = math.radians(14)
        head.location.z -= 0.04
        if tail:
            tail.rotation_euler.z = math.radians(55)
        for e in rig.eyes_open:
            e.hide_render = True
        for e in rig.eyes_closed:
            e.hide_render = False
        for wp, side in rig.wings:
            wp.rotation_euler.x = 0
        return


def destroy(rig):
    for ob in list(rig.coll.objects):
        bpy.data.objects.remove(ob, do_unlink=True)
    bpy.data.collections.remove(rig.coll)
