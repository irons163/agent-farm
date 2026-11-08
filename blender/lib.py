"""
Small procedural-modelling toolkit shared by the Agent Farm Blender scripts.

Everything is built from code (bmesh primitives + Principled materials) so the
whole farm can be restyled and re-rendered at any time. Blender 5.2, bpy only.
"""
import math
import random

import bmesh
import bpy
from mathutils import Euler, Matrix, Vector


# --------------------------------------------------------------------------
# colour helpers
# --------------------------------------------------------------------------
def _s2l(c):
    return c / 12.92 if c <= 0.04045 else ((c + 0.055) / 1.055) ** 2.4


def hexcol(h, a=1.0):
    h = h.lstrip("#")
    r, g, b = (int(h[i:i + 2], 16) / 255.0 for i in (0, 2, 4))
    return (_s2l(r), _s2l(g), _s2l(b), a)


def mix_hex(a, b, t):
    a, b = a.lstrip("#"), b.lstrip("#")
    ca = [int(a[i:i + 2], 16) for i in (0, 2, 4)]
    cb = [int(b[i:i + 2], 16) for i in (0, 2, 4)]
    return "#" + "".join(f"{round(x + (y - x) * t):02x}" for x, y in zip(ca, cb))


# --------------------------------------------------------------------------
# materials
# --------------------------------------------------------------------------
MATS = {}


def _new_material(name):
    m = bpy.data.materials.new(name)
    if m.node_tree is None:
        try:
            m.use_nodes = True
        except Exception:
            pass
    return m


def _bsdf(m):
    for n in m.node_tree.nodes:
        if n.type == "BSDF_PRINCIPLED":
            return n
    n = m.node_tree.nodes.new("ShaderNodeBsdfPrincipled")
    out = next(x for x in m.node_tree.nodes if x.type == "OUTPUT_MATERIAL")
    m.node_tree.links.new(n.outputs[0], out.inputs[0])
    return n


def mat(name, color, rough=0.6, metallic=0.0, spec=0.35, sheen=0.0, coat=0.0,
        emit=None, emit_strength=0.0, transmission=0.0, ior=1.45):
    if name in MATS:
        return MATS[name]
    m = _new_material(name)
    b = _bsdf(m)
    b.inputs["Base Color"].default_value = hexcol(color)
    b.inputs["Roughness"].default_value = rough
    b.inputs["Metallic"].default_value = metallic
    b.inputs["Specular IOR Level"].default_value = spec
    b.inputs["Sheen Weight"].default_value = sheen
    b.inputs["Coat Weight"].default_value = coat
    b.inputs["Transmission Weight"].default_value = transmission
    b.inputs["IOR"].default_value = ior
    if emit:
        b.inputs["Emission Color"].default_value = hexcol(emit)
    b.inputs["Emission Strength"].default_value = emit_strength
    m.diffuse_color = hexcol(color)
    MATS[name] = m
    return m


def mat_noise(name, c1, c2, scale=0.35, rough=0.8, detail=3.0, lo=0.38, hi=0.62,
              space="world", c3=None, spec=0.25):
    """Two/three tone colour variation driven by a noise texture."""
    if name in MATS:
        return MATS[name]
    m = _new_material(name)
    nt = m.node_tree
    b = _bsdf(m)
    b.inputs["Roughness"].default_value = rough
    b.inputs["Specular IOR Level"].default_value = spec
    if space == "world":
        geo = nt.nodes.new("ShaderNodeNewGeometry")
        vec = geo.outputs["Position"]
    else:
        tc = nt.nodes.new("ShaderNodeTexCoord")
        vec = tc.outputs["Object"]
    nz = nt.nodes.new("ShaderNodeTexNoise")
    nz.inputs["Scale"].default_value = scale
    nz.inputs["Detail"].default_value = detail
    nt.links.new(vec, nz.inputs["Vector"])
    ramp = nt.nodes.new("ShaderNodeValToRGB")
    el = ramp.color_ramp.elements
    el[0].position, el[0].color = lo, hexcol(c1)
    el[1].position, el[1].color = hi, hexcol(c2)
    if c3:
        e = el.new((lo + hi) / 2)
        e.color = hexcol(c3)
    nt.links.new(nz.outputs["Fac"], ramp.inputs["Fac"])
    nt.links.new(ramp.outputs["Color"], b.inputs["Base Color"])
    m.diffuse_color = hexcol(c1)
    MATS[name] = m
    return m


def mat_spots(name, base, spot, scale=2.4, thresh=0.56, rough=0.6):
    """Cow-style organic spots in object space (they move with the animal)."""
    if name in MATS:
        return MATS[name]
    m = _new_material(name)
    nt = m.node_tree
    b = _bsdf(m)
    b.inputs["Roughness"].default_value = rough
    b.inputs["Specular IOR Level"].default_value = 0.3
    b.inputs["Sheen Weight"].default_value = 0.3
    tc = nt.nodes.new("ShaderNodeTexCoord")
    nz = nt.nodes.new("ShaderNodeTexNoise")
    nz.inputs["Scale"].default_value = scale
    nz.inputs["Detail"].default_value = 1.0
    nz.inputs["Roughness"].default_value = 0.4
    nt.links.new(tc.outputs["Object"], nz.inputs["Vector"])
    ramp = nt.nodes.new("ShaderNodeValToRGB")
    ramp.color_ramp.interpolation = "EASE"
    el = ramp.color_ramp.elements
    el[0].position, el[0].color = thresh - 0.012, hexcol(base)
    el[1].position, el[1].color = thresh + 0.012, hexcol(spot)
    nt.links.new(nz.outputs["Fac"], ramp.inputs["Fac"])
    nt.links.new(ramp.outputs["Color"], b.inputs["Base Color"])
    MATS[name] = m
    return m


def set_emission(m, color=None, strength=0.0):
    b = _bsdf(m)
    if color:
        b.inputs["Emission Color"].default_value = hexcol(color)
    b.inputs["Emission Strength"].default_value = strength


# --------------------------------------------------------------------------
# collections
# --------------------------------------------------------------------------
def coll(name, parent=None):
    c = bpy.data.collections.get(name)
    if c is None:
        c = bpy.data.collections.new(name)
        (parent or bpy.context.scene.collection).children.link(c)
    return c


class Ctx:
    """Current target collection for newly created objects."""
    coll = None


def _link(ob, c=None):
    c = c or Ctx.coll or bpy.context.scene.collection
    c.objects.link(ob)
    return ob


# --------------------------------------------------------------------------
# primitive objects
# --------------------------------------------------------------------------
def _finish(ob, m, loc, rot, scale, smooth, parent, bevel=0.0, bevel_segs=3, subsurf=0):
    if m is not None:
        if isinstance(m, (list, tuple)):
            for mm in m:
                ob.data.materials.append(mm)
        else:
            ob.data.materials.append(m)
    if smooth:
        ob.data.shade_smooth()
    if parent is not None:
        ob.parent = parent
    ob.location = loc
    ob.rotation_euler = Euler(rot) if not isinstance(rot, Euler) else rot
    ob.scale = scale
    if bevel > 0:
        md = ob.modifiers.new("Bevel", "BEVEL")
        md.width = bevel
        md.segments = bevel_segs
        md.limit_method = "ANGLE"
        md.angle_limit = math.radians(35)
        md.use_clamp_overlap = True
    if subsurf:
        md = ob.modifiers.new("Subsurf", "SUBSURF")
        md.levels = subsurf
        md.render_levels = subsurf
    return ob


def _mesh_obj(name):
    me = bpy.data.meshes.new(name)
    ob = bpy.data.objects.new(name, me)
    _link(ob)
    return ob, me


def sphere(name, r=1.0, loc=(0, 0, 0), m=None, scale=(1, 1, 1), rot=(0, 0, 0), seg=32,
           rings=16, parent=None, smooth=True):
    ob, me = _mesh_obj(name)
    bm = bmesh.new()
    bmesh.ops.create_uvsphere(bm, u_segments=seg, v_segments=rings, radius=r)
    bm.to_mesh(me)
    bm.free()
    return _finish(ob, m, loc, rot, scale, smooth, parent)


def ico(name, r=1.0, loc=(0, 0, 0), m=None, scale=(1, 1, 1), rot=(0, 0, 0), sub=2,
        parent=None, smooth=True, jitter=0.0, seed=0):
    ob, me = _mesh_obj(name)
    bm = bmesh.new()
    bmesh.ops.create_icosphere(bm, subdivisions=sub, radius=r)
    if jitter:
        rnd = random.Random(seed)
        for v in bm.verts:
            v.co *= 1.0 + rnd.uniform(-jitter, jitter)
    bm.to_mesh(me)
    bm.free()
    return _finish(ob, m, loc, rot, scale, smooth, parent)


def box(name, size=(1, 1, 1), loc=(0, 0, 0), m=None, rot=(0, 0, 0), bevel=0.04, segs=3,
        parent=None, smooth=False):
    ob, me = _mesh_obj(name)
    bm = bmesh.new()
    bmesh.ops.create_cube(bm, size=1.0)
    for v in bm.verts:
        v.co = Vector((v.co.x * size[0], v.co.y * size[1], v.co.z * size[2]))
    bm.to_mesh(me)
    bm.free()
    return _finish(ob, m, loc, rot, (1, 1, 1), smooth, parent, bevel=bevel, bevel_segs=segs)


def cyl(name, r=0.5, depth=1.0, loc=(0, 0, 0), m=None, rot=(0, 0, 0), verts=32, r2=None,
        parent=None, smooth=True, bevel=0.0, segs=2, scale=(1, 1, 1)):
    """Cylinder / truncated cone along local Z, centred on loc."""
    ob, me = _mesh_obj(name)
    bm = bmesh.new()
    rr2 = r if r2 is None else r2
    bmesh.ops.create_cone(bm, cap_ends=rr2 > 0 or True, cap_tris=False, segments=verts,
                          radius1=r, radius2=rr2, depth=depth)
    bm.normal_update()
    for f in bm.faces:
        # smooth sides, flat caps (avoids shading artefacts on the caps)
        f.smooth = smooth and abs(f.normal.z) < 0.95
    bm.to_mesh(me)
    bm.free()
    return _finish(ob, m, loc, rot, scale, False, parent, bevel=bevel, bevel_segs=segs)


def cone(name, r=0.5, depth=1.0, loc=(0, 0, 0), m=None, rot=(0, 0, 0), verts=24, r2=0.0,
         parent=None, smooth=True, scale=(1, 1, 1)):
    return cyl(name, r, depth, loc, m, rot, verts, r2=r2, parent=parent, smooth=smooth,
               scale=scale)


def torus(name, R=0.5, r=0.1, loc=(0, 0, 0), m=None, rot=(0, 0, 0), seg=32, ring=12,
          parent=None, scale=(1, 1, 1), arc=2 * math.pi):
    ob, me = _mesh_obj(name)
    bm = bmesh.new()
    rows = []
    closed = arc >= 2 * math.pi - 1e-6
    nseg = seg if closed else seg + 1
    for i in range(nseg):
        a = arc * i / seg
        ca, sa = math.cos(a), math.sin(a)
        row = []
        for j in range(ring):
            b = 2 * math.pi * j / ring
            x = (R + r * math.cos(b)) * ca
            y = (R + r * math.cos(b)) * sa
            z = r * math.sin(b)
            row.append(bm.verts.new((x, y, z)))
        rows.append(row)
    for i in range(seg):
        a, b2 = rows[i], rows[(i + 1) % nseg]
        for j in range(ring):
            bm.faces.new((a[j], a[(j + 1) % ring], b2[(j + 1) % ring], b2[j]))
    if not closed:
        bm.faces.new(list(reversed(rows[0])))
        bm.faces.new(rows[-1])
    bm.normal_update()
    bm.to_mesh(me)
    bm.free()
    return _finish(ob, m, loc, rot, scale, True, parent)


def capsule(name, r, a, b, m=None, parent=None, seg=24, scale_xy=1.0):
    """Capsule between points a and b (in parent space)."""
    a, b = Vector(a), Vector(b)
    d = b - a
    L = d.length
    ob, me = _mesh_obj(name)
    bm = bmesh.new()
    rings = 12
    verts = []
    # build along +Z from 0..L with hemispherical caps
    prof = []
    for i in range(rings // 2 + 1):
        t = math.pi / 2 * i / (rings // 2)
        prof.append((r * math.sin(t), -r * math.cos(t)))  # bottom cap (rho, z)
    top = [(rho, L - z) for rho, z in reversed(prof)]
    prof = prof + top
    for rho, z in prof:
        row = []
        for j in range(seg):
            ang = 2 * math.pi * j / seg
            row.append(bm.verts.new((rho * math.cos(ang) * scale_xy, rho * math.sin(ang), z)))
        verts.append(row)
    for i in range(len(verts) - 1):
        for j in range(seg):
            q = (verts[i][j], verts[i][(j + 1) % seg], verts[i + 1][(j + 1) % seg], verts[i + 1][j])
            try:
                bm.faces.new(q)
            except ValueError:
                pass
    bmesh.ops.remove_doubles(bm, verts=bm.verts, dist=1e-5)
    bm.normal_update()
    bm.to_mesh(me)
    bm.free()
    rot = Vector((0, 0, 1)).rotation_difference(d.normalized()).to_euler() if L > 1e-6 else Euler()
    return _finish(ob, m, a, rot, (1, 1, 1), True, parent)


def prism(name, profile, depth, loc=(0, 0, 0), m=None, rot=(0, 0, 0), axis="x", parent=None,
          bevel=0.0, segs=2):
    """Extrude a 2D polygon `profile` [(u, v), ...] by `depth`.

    axis='x': profile in (y, z) plane, extruded along X (centred).
    axis='y': profile in (x, z) plane, extruded along Y (centred).
    """
    ob, me = _mesh_obj(name)
    bm = bmesh.new()
    h = depth / 2
    if axis == "x":
        f = [bm.verts.new((-h, u, v)) for u, v in profile]
        k = [bm.verts.new((h, u, v)) for u, v in profile]
    else:
        f = [bm.verts.new((u, -h, v)) for u, v in profile]
        k = [bm.verts.new((u, h, v)) for u, v in profile]
    n = len(profile)
    bm.faces.new(f)
    bm.faces.new(list(reversed(k)))
    for i in range(n):
        j = (i + 1) % n
        bm.faces.new((f[i], f[j], k[j], k[i]))
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    bm.to_mesh(me)
    bm.free()
    return _finish(ob, m, loc, rot, (1, 1, 1), False, parent, bevel=bevel, bevel_segs=segs)


def empty(name, loc=(0, 0, 0), rot=(0, 0, 0), parent=None):
    ob = bpy.data.objects.new(name, None)
    _link(ob)
    if parent is not None:
        ob.parent = parent
    ob.location = loc
    ob.rotation_euler = rot
    ob.empty_display_size = 0.2
    return ob


# --------------------------------------------------------------------------
# merged scatter meshes (one object, many tiny primitives, multi-material)
# --------------------------------------------------------------------------
class Batch:
    def __init__(self, name, mats):
        self.name = name
        self.mats = list(mats)
        self.bm = bmesh.new()

    def _tag(self, verts, mi, smooth=True):
        faces = set()
        for v in verts:
            faces.update(v.link_faces)
        for f in faces:
            f.material_index = mi
            f.smooth = smooth

    def ico(self, loc, r, mi=0, sub=1, scale=(1, 1, 1), smooth=True):
        mtx = Matrix.Translation(loc) @ Matrix.Diagonal((*scale, 1.0))
        res = bmesh.ops.create_icosphere(self.bm, subdivisions=sub, radius=r, matrix=mtx)
        self._tag(res["verts"], mi, smooth)

    def sphere(self, loc, r, mi=0, seg=12, rings=8, scale=(1, 1, 1)):
        mtx = Matrix.Translation(loc) @ Matrix.Diagonal((*scale, 1.0))
        res = bmesh.ops.create_uvsphere(self.bm, u_segments=seg, v_segments=rings, radius=r,
                                        matrix=mtx)
        self._tag(res["verts"], mi)

    def cone(self, loc, r1, r2, depth, mi=0, segs=8, rot=(0, 0, 0), smooth=True):
        mtx = Matrix.Translation(loc) @ Euler(rot).to_matrix().to_4x4() @ \
            Matrix.Translation((0, 0, depth / 2))
        res = bmesh.ops.create_cone(self.bm, cap_ends=True, cap_tris=False, segments=segs,
                                    radius1=r1, radius2=r2, depth=depth, matrix=mtx)
        self._tag(res["verts"], mi, smooth)

    def box(self, loc, size, mi=0, rot=(0, 0, 0)):
        mtx = Matrix.Translation(loc) @ Euler(rot).to_matrix().to_4x4() @ \
            Matrix.Diagonal((*size, 1.0))
        res = bmesh.ops.create_cube(self.bm, size=1.0, matrix=mtx)
        self._tag(res["verts"], mi, smooth=False)

    def disc(self, loc, r, depth, mi=0, segs=24, scale=(1, 1)):
        mtx = Matrix.Translation(loc) @ Matrix.Diagonal((scale[0], scale[1], 1, 1))
        res = bmesh.ops.create_cone(self.bm, cap_ends=True, cap_tris=False, segments=segs,
                                    radius1=r, radius2=r, depth=depth, matrix=mtx)
        self._tag(res["verts"], mi, smooth=False)

    def build(self, smooth_mod=False, bevel=0.0):
        ob, me = _mesh_obj(self.name)
        self.bm.normal_update()
        self.bm.to_mesh(me)
        self.bm.free()
        for m in self.mats:
            me.materials.append(m)
        if bevel:
            md = ob.modifiers.new("Bevel", "BEVEL")
            md.width = bevel
            md.segments = 2
            md.limit_method = "ANGLE"
        return ob


def look_rot(direction, up=(0, 0, 1)):
    """Euler that turns local +Z toward `direction`."""
    return Vector((0, 0, 1)).rotation_difference(Vector(direction).normalized()).to_euler()


def all_objects(c):
    out = list(c.objects)
    for ch in c.children:
        out.extend(all_objects(ch))
    return out
