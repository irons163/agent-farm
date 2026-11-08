"""
Render every 2.5D asset of the Agent Farm and write web/assets/scene.json.

    blender -b --factory-startup -P blender/render_all.py -- [--quality draft|preview|final]
        [--only all|bg|animals|crops] [--themes day,night] [--animals fox,cat]

Outputs (relative to --out, default web/assets):
    bg_<theme>.webp                 the whole island (sky is transparent; the web paints it)
    occ/<id>_<theme>.webp           occluder cut-outs (house, trees ...) for depth sorting
    blades/<theme>_<k>.webp         windmill sail frames (12 steps over 90 degrees)
    animals/<kind>/<dir>_<pose>.webp  animal sprites (dir = se, sw, ne, nw)
    crops/<crop>_<stage>.webp       crop sprites for the raised beds (stage 1..3)
    scene.json                      projection, zones, sprite anchors, fx positions
"""
import argparse
import importlib
import json
import math
import os
import sys
import time

import bpy
from bpy_extras.object_utils import world_to_camera_view
from mathutils import Euler, Matrix, Vector

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import lib  # noqa: E402
import farm_scene as fs  # noqa: E402

importlib.reload(lib)
importlib.reload(fs)

BASE_W, BASE_H = 2560, 1600
ORTHO = 32.0                    # world units across BASE_W
CAM_ROT = Euler((math.radians(60), 0, math.radians(45)))
CAM_UP_SHIFT = 0.25             # vertical framing tweak (world units along screen-up)
SS = 2                          # sprite supersampling vs. background pixels
QUALITY = {
    "draft": dict(scale=40, samples=12, sprite_samples=8, occ=True),
    "preview": dict(scale=60, samples=48, sprite_samples=24, occ=True),
    "final": dict(scale=100, samples=160, sprite_samples=64, occ=True),
}
R_AX = CAM_ROT.to_matrix() @ Vector((1, 0, 0))
U_AX = CAM_ROT.to_matrix() @ Vector((0, 1, 0))
F_AX = CAM_ROT.to_matrix() @ Vector((0, 0, -1))
PPU = BASE_W / ORTHO


def log(*a):
    print("[farm]", *a, flush=True)


def parse_args():
    argv = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
    p = argparse.ArgumentParser()
    p.add_argument("--out", default=os.path.normpath(os.path.join(HERE, "..", "web", "assets")))
    p.add_argument("--quality", default="final", choices=list(QUALITY))
    p.add_argument("--themes", default="day,night")
    p.add_argument("--only", default="all", choices=["all", "bg", "animals", "crops", "farm"])
    p.add_argument("--animals", default="")
    p.add_argument("--no-occ", action="store_true")
    p.add_argument("--save-blend", default="")
    return p.parse_args(argv)


# --------------------------------------------------------------------------
def clear_scene():
    for ob in list(bpy.data.objects):
        bpy.data.objects.remove(ob, do_unlink=True)
    for c in list(bpy.data.collections):
        bpy.data.collections.remove(c)
    lib.MATS.clear()


def setup_render(samples):
    sc = bpy.context.scene
    sc.render.engine = "CYCLES"
    try:
        prefs = bpy.context.preferences.addons["cycles"].preferences
        prefs.compute_device_type = "METAL"
        prefs.refresh_devices()
        for d in prefs.devices:
            d.use = d.type != "CPU"
        sc.cycles.device = "GPU"
    except Exception as e:
        log("GPU setup failed, using CPU:", e)
    c = sc.cycles
    c.samples = samples
    c.use_adaptive_sampling = True
    c.adaptive_threshold = 0.02
    c.use_denoising = True
    try:
        c.denoiser = "OPENIMAGEDENOISE"
    except Exception:
        pass
    c.max_bounces = 6
    c.diffuse_bounces = 3
    c.glossy_bounces = 2
    c.transmission_bounces = 2
    c.transparent_max_bounces = 4
    c.sample_clamp_indirect = 5.0
    c.seed = 3
    sc.render.film_transparent = True
    sc.render.use_persistent_data = True
    st = sc.render.image_settings
    st.file_format = "WEBP"
    st.color_mode = "RGBA"
    st.quality = 92
    vs = sc.view_settings
    for vt in ("Khronos PBR Neutral", "AgX", "Standard"):
        try:
            vs.view_transform = vt
            break
        except Exception:
            continue
    try:
        vs.look = "None"
    except Exception:
        pass
    vs.exposure = 0.0
    sc.render.dither_intensity = 0.6


def make_camera(name="IsoCam"):
    sc = bpy.context.scene
    cd = bpy.data.cameras.new(name)
    cd.type = "ORTHO"
    cd.sensor_fit = "HORIZONTAL"
    cd.clip_start = 0.1
    cd.clip_end = 400
    cam = bpy.data.objects.new(name, cd)
    sc.collection.objects.link(cam)
    cam.rotation_euler = CAM_ROT
    return cam


def frame_main(cam, pct):
    sc = bpy.context.scene
    cam.data.ortho_scale = ORTHO
    cam.location = U_AX * CAM_UP_SHIFT - F_AX * 80
    sc.camera = cam
    sc.render.resolution_x = BASE_W
    sc.render.resolution_y = BASE_H
    sc.render.resolution_percentage = pct
    sc.render.use_border = False
    sc.render.use_crop_to_border = False
    bpy.context.view_layer.update()


def proj(cam, p):
    sc = bpy.context.scene
    v = world_to_camera_view(sc, cam, Vector(p))
    return (v.x * BASE_W, (1.0 - v.y) * BASE_H)


# --------------------------------------------------------------------------
# lighting / themes
# --------------------------------------------------------------------------
THEME_LIGHTS = {"day": [], "night": []}


def setup_world(theme):
    sc = bpy.context.scene
    w = bpy.data.worlds.get("FarmWorld") or bpy.data.worlds.new("FarmWorld")
    sc.world = w
    if w.node_tree is None:
        try:
            w.use_nodes = True
        except Exception:
            pass
    bg = next(n for n in w.node_tree.nodes if n.type == "BACKGROUND")
    if theme == "day":
        bg.inputs["Color"].default_value = lib.hexcol("#DCEAF7")
        bg.inputs["Strength"].default_value = 0.95
    else:
        bg.inputs["Color"].default_value = lib.hexcol("#2A3A6B")
        bg.inputs["Strength"].default_value = 0.42


def _sun(name, direction, energy, color, angle):
    ld = bpy.data.lights.new(name, "SUN")
    ld.energy = energy
    ld.color = lib.hexcol(color)[:3]
    ld.angle = math.radians(angle)
    ob = bpy.data.objects.new(name, ld)
    bpy.context.scene.collection.objects.link(ob)
    ob.rotation_euler = lib.look_rot(-Vector(direction))
    return ob


def _point(name, loc, energy, color, radius):
    ld = bpy.data.lights.new(name, "POINT")
    ld.energy = energy
    ld.color = lib.hexcol(color)[:3]
    ld.shadow_soft_size = radius
    ob = bpy.data.objects.new(name, ld)
    bpy.context.scene.collection.objects.link(ob)
    ob.location = loc
    return ob


DAY_SUN = ((0.2, 0.62, -0.76), 3.4, "#FFF0DA", 3.5)


def make_lights(info=None):
    THEME_LIGHTS["day"] = [_sun("Sun", *DAY_SUN)]
    night = [_sun("Moon", (-0.35, 0.55, -0.76), 0.75, "#B4C8FF", 2.0)]
    if info:
        for k, p in enumerate(info["lanterns"]):
            night.append(_point(f"LampL{k}", p, 45, "#FFB25A", 0.08))
        for k, p in enumerate(info["window_lights"]):
            night.append(_point(f"WinL{k}", p, 28, "#FFB868", 0.35))
    THEME_LIGHTS["night"] = night


def apply_theme(theme):
    setup_world(theme)
    for t, obs in THEME_LIGHTS.items():
        for ob in obs:
            ob.hide_render = t != theme
    night = theme == "night"
    if "window" in lib.MATS:
        lib.set_emission(lib.MATS["window"], "#FFC46B", 3.2 if night else 0.0)
    if "lampglass" in lib.MATS:
        lib.set_emission(lib.MATS["lampglass"], "#FFD08A", 9.0 if night else 0.35)


# --------------------------------------------------------------------------
# rendering helpers
# --------------------------------------------------------------------------
def render_to(path):
    sc = bpy.context.scene
    os.makedirs(os.path.dirname(path), exist_ok=True)
    sc.render.filepath = path
    bpy.ops.render.render(write_still=True)


def set_border(x0, y0, x1, y1):
    sc = bpy.context.scene
    sc.render.use_border = True
    sc.render.use_crop_to_border = True
    sc.render.border_min_x = (x0 + 0.25) / BASE_W
    sc.render.border_max_x = (x1 + 0.25) / BASE_W
    sc.render.border_min_y = (BASE_H - y1 + 0.25) / BASE_H
    sc.render.border_max_y = (BASE_H - y0 + 0.25) / BASE_H


def clear_border():
    sc = bpy.context.scene
    sc.render.use_border = False
    sc.render.use_crop_to_border = False


def bbox_px(cam, objs, pad=6):
    xs, ys = [], []
    dg = bpy.context.evaluated_depsgraph_get()
    for ob in objs:
        if ob.type not in {"MESH", "FONT", "CURVE"}:
            continue
        oe = ob.evaluated_get(dg)
        for c in oe.bound_box:
            x, y = proj(cam, oe.matrix_world @ Vector(c))
            xs.append(x)
            ys.append(y)
    x0 = max(0, int(math.floor(min(xs))) - pad)
    y0 = max(0, int(math.floor(min(ys))) - pad)
    x1 = min(BASE_W, int(math.ceil(max(xs))) + pad)
    y1 = min(BASE_H, int(math.ceil(max(ys))) + pad)
    return x0, y0, x1, y1


def scene_mesh_objects():
    return [o for o in bpy.context.scene.objects if o.type in {"MESH", "FONT", "CURVE"}]


def rel(path, out):
    return os.path.relpath(path, out).replace(os.sep, "/")


# --------------------------------------------------------------------------
# farm: background, occluders, blades
# --------------------------------------------------------------------------
def render_farm(args, q, out, manifest):
    t0 = time.time()
    info = fs.build_all()
    log(f"farm built: {len(bpy.data.objects)} objects in {time.time() - t0:.1f}s")
    make_lights(info)
    cam = make_camera()
    frame_main(cam, q["scale"])
    themes = [t for t in args.themes.split(",") if t]
    blades_coll = bpy.data.collections["blades"]
    blade_objs = lib.all_objects(blades_coll)
    piv = info["blades"]["pivot"]
    base_rot = piv.rotation_euler.copy()

    # ---------------- manifest geometry ----------------
    o = proj(cam, (0, 0, 0))
    ex = proj(cam, (1, 0, 0))
    ey = proj(cam, (0, 1, 0))
    ez = proj(cam, (0, 0, 1))
    manifest["size"] = [BASE_W, BASE_H]
    manifest["ppu"] = PPU
    manifest["proj"] = [[ex[0] - o[0], ey[0] - o[0], ez[0] - o[0], o[0]],
                        [ex[1] - o[1], ey[1] - o[1], ez[1] - o[1], o[1]]]
    z = info["zones"]
    manifest["zones"] = z
    manifest["obstacles"] = info["obstacles"]
    manifest["island"] = [list(proj(cam, p)) for p in
                          ((-10, -10, 0), (10, -10, 0), (10, 10, 0), (-10, 10, 0))]
    manifest["fx"] = dict(
        chimney=[list(proj(cam, p)) for p in info["chimney"]],
        lanterns=[list(proj(cam, p)) for p in info["lanterns"]],
        windows=[list(proj(cam, (p[0], p[1], p[2]))) for p in info["window_lights"]],
        pond=dict(c=list(proj(cam, (*fs.POND["c"], 0.08))),
                  rx=fs.POND["r"] * PPU * math.sqrt(2) / 2 * 1.42,
                  ry=fs.POND["r"] * PPU * math.sqrt(2) / 4 * 1.42),
        hub=list(proj(cam, info["blades"]["hub"])),
    )

    hide_blades(blade_objs, True)
    for theme in themes:
        apply_theme(theme)
        clear_border()
        bpy.context.scene.cycles.samples = q["samples"]
        path = os.path.join(out, f"bg_{theme}.webp")
        t1 = time.time()
        render_to(path)
        log(f"bg {theme}: {time.time() - t1:.1f}s")
        manifest.setdefault("bg", {})[theme] = rel(path, out)

    # ---------------- occluders ----------------
    occs = []
    all_objs = scene_mesh_objects()
    if not args.no_occ and q["occ"]:
        for oc in info["occluders"]:
            objs = [ob for ob in lib.all_objects(oc["coll"]) if ob.type in {"MESH", "FONT"}]
            if not objs:
                continue
            x0, y0, x1, y1 = bbox_px(cam, objs)
            entry = dict(id=oc["id"], x=x0, y=y0, w=x1 - x0, h=y1 - y0,
                         sort=round(proj(cam, (*oc["foot"], 0))[1], 2), src={})
            group = set(objs)
            for ob in all_objs:
                ob.is_holdout = ob not in group
            for theme in themes:
                apply_theme(theme)
                set_border(x0, y0, x1, y1)
                path = os.path.join(out, "occ", f"{oc['id']}_{theme}.webp")
                render_to(path)
                entry["src"][theme] = rel(path, out)
            occs.append(entry)
            log(f"occluder {oc['id']} {x1 - x0}x{y1 - y0}")
        for ob in all_objs:
            ob.is_holdout = False
    manifest["occluders"] = occs

    # ---------------- windmill blades ----------------
    hide_blades(blade_objs, False)
    hub = Vector(info["blades"]["hub"])
    X = Vector((0.7071, 0.7071, 0))
    Y = Vector((0, 0, 1))
    pts = [proj(cam, hub + (X * math.cos(a) + Y * math.sin(a)) * 3.05)
           for a in [i * math.pi / 18 for i in range(36)]]
    x0 = int(min(p[0] for p in pts)) - 6
    x1 = int(max(p[0] for p in pts)) + 6
    y0 = int(min(p[1] for p in pts)) - 6
    y1 = int(max(p[1] for p in pts)) + 6
    blade_set = set(o for o in blade_objs if o.type == "MESH")
    for ob in scene_mesh_objects():
        ob.is_holdout = ob not in blade_set
    frames = {}
    NB = 12
    for theme in themes:
        apply_theme(theme)
        set_border(x0, y0, x1, y1)
        frames[theme] = []
        for k in range(NB):
            th = math.radians(90.0 * k / NB)
            piv.rotation_euler = (base_rot.to_matrix() @ Matrix.Rotation(-th, 3, "Z")).to_euler()
            path = os.path.join(out, "blades", f"{theme}_{k:02d}.webp")
            render_to(path)
            frames[theme].append(rel(path, out))
    piv.rotation_euler = base_rot
    for ob in scene_mesh_objects():
        ob.is_holdout = False
    mill_sort = None
    for e in occs:
        if e["id"] == "windmill":
            mill_sort = e["sort"] + 0.5
    manifest["blades"] = dict(x=x0, y=y0, w=x1 - x0, h=y1 - y0, frames=frames,
                              sort=mill_sort or proj(cam, (*fs.MILL["c"], 0))[1] + 30)
    clear_border()
    if args.save_blend:
        bpy.ops.wm.save_as_mainfile(filepath=args.save_blend)
    log(f"farm done in {time.time() - t0:.1f}s")


def hide_blades(objs, hidden):
    for ob in objs:
        ob.hide_render = hidden


# --------------------------------------------------------------------------
# sprites (animals, crops)
# --------------------------------------------------------------------------
def sprite_camera(w_units, h_units, anchor_frac=(0.5, 0.8), target=(0, 0, 0)):
    """Ortho camera with the same view as the background at SS x resolution.

    The world point `target` lands at anchor_frac of the sprite canvas.
    """
    sc = bpy.context.scene
    cam = sc.camera if sc.camera and sc.camera.name == "SpriteCam" else make_camera("SpriteCam")
    wpx = int(round(w_units * PPU * SS))
    hpx = int(round(h_units * PPU * SS))
    cam.data.ortho_scale = wpx / (PPU * SS)
    # canvas centre relative to the anchor, in world units along screen axes
    du = (0.5 - anchor_frac[0]) * wpx / (PPU * SS)
    dv = (anchor_frac[1] - 0.5) * hpx / (PPU * SS)
    cam.location = Vector(target) + R_AX * du + U_AX * dv - F_AX * 60
    cam.rotation_euler = CAM_ROT
    sc.camera = cam
    sc.render.resolution_x = wpx
    sc.render.resolution_y = hpx
    clear_border()
    bpy.context.view_layer.update()
    return cam, wpx, hpx


def shadow_catcher():
    ob = bpy.data.objects.get("Catcher")
    if ob:
        return ob
    me = bpy.data.meshes.new("Catcher")
    import bmesh
    bm = bmesh.new()
    bmesh.ops.create_grid(bm, x_segments=1, y_segments=1, size=8)
    bm.to_mesh(me)
    bm.free()
    ob = bpy.data.objects.new("Catcher", me)
    bpy.context.scene.collection.objects.link(ob)
    ob.is_shadow_catcher = True
    return ob


def render_animals(args, q, out, manifest):
    import animals as an
    importlib.reload(an)
    setup_world("day")
    THEME_LIGHTS["day"] = [_sun("Sun", *DAY_SUN)]
    shadow_catcher()
    sc = bpy.context.scene
    sc.cycles.samples = q["sprite_samples"]
    pct = q["scale"]
    kinds = [k for k in (args.animals.split(",") if args.animals else an.KINDS) if k]
    W_U, H_U = 2.7, 2.5
    AX, AY = 0.42, 0.82
    cam, wpx, hpx = sprite_camera(W_U, H_U, (AX, AY))
    sc.render.resolution_percentage = pct
    meta = manifest.setdefault("animals", {})
    dirs = {"se": 0.0, "ne": 90.0, "nw": 180.0, "sw": 270.0}
    for kind in kinds:
        t0 = time.time()
        rig = an.build(kind)
        entry = dict(w=wpx / SS, h=hpx / SS, ax=wpx / SS * AX, ay=hpx / SS * AY,
                     frames={}, name=an.NAMES[kind])
        for d, ang in dirs.items():
            rig.root.rotation_euler = (0, 0, math.radians(ang))
            poses = [("idle", 0)] + [("walk", i) for i in range(4)]
            if d in ("se", "sw"):
                poses += [("work", 0), ("work", 1), ("sleep", 0)]
            for pose, i in poses:
                an.pose(rig, pose, i)
                bpy.context.view_layer.update()
                name = f"{d}_{pose}{i if pose in ('walk', 'work') else ''}"
                path = os.path.join(out, "animals", kind, name + ".webp")
                render_to(path)
                entry["frames"][name] = rel(path, out)
        an.destroy(rig)
        meta[kind] = entry
        log(f"animal {kind}: {time.time() - t0:.1f}s")


def render_crops(args, q, out, manifest):
    import crops as cr
    importlib.reload(cr)
    setup_world("day")
    THEME_LIGHTS["day"] = [_sun("Sun", *DAY_SUN)]
    shadow_catcher().location.z = cr.SOIL
    sc = bpy.context.scene
    sc.cycles.samples = q["sprite_samples"]
    W_U, H_U = 3.1, 3.3
    cam, wpx, hpx = sprite_camera(W_U, H_U, (0.5, 0.66))
    sc.render.resolution_percentage = q["scale"]
    meta = manifest.setdefault("crops", {})
    for crop in cr.CROPS:
        meta[crop] = dict(w=wpx / SS, h=hpx / SS, ax=wpx / SS * 0.5, ay=hpx / SS * 0.66,
                          stages={})
        for stage in (1, 2, 3):
            objs = cr.build(crop, stage)
            bpy.context.view_layer.update()
            path = os.path.join(out, "crops", f"{crop}_{stage}.webp")
            render_to(path)
            meta[crop]["stages"][str(stage)] = rel(path, out)
            cr.destroy(objs)
        log(f"crop {crop} done")


# --------------------------------------------------------------------------
def main():
    args = parse_args()
    q = QUALITY[args.quality]
    out = args.out
    os.makedirs(out, exist_ok=True)
    mpath = os.path.join(out, "scene.json")
    manifest = {}
    if os.path.exists(mpath):
        with open(mpath) as f:
            manifest = json.load(f)
    manifest["quality"] = args.quality
    manifest["ss"] = SS
    t0 = time.time()
    clear_scene()
    setup_render(q["samples"])
    if args.only in ("all", "bg", "farm"):
        render_farm(args, q, out, manifest)
    if args.only in ("all", "animals"):
        clear_scene()
        render_animals(args, q, out, manifest)
    if args.only in ("all", "crops"):
        clear_scene()
        render_crops(args, q, out, manifest)
    manifest["generated"] = time.strftime("%Y-%m-%d %H:%M:%S")
    with open(mpath, "w") as f:
        json.dump(manifest, f, indent=1)
    log(f"all done in {time.time() - t0:.1f}s -> {mpath}")


if __name__ == "__main__":
    main()
