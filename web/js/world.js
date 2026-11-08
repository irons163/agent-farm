// The 2.5D world: Blender-rendered background + depth-sorted sprites + camera.
const A = (p) => `assets/${p}`;
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const rand = (a, b) => a + Math.random() * (b - a);

// approximate head height (world units) of each animal, for placing labels
const HEIGHT = { fox: 1.72, cat: 1.42, rabbit: 1.86, owl: 1.6, cow: 1.48, pig: 1.3, sheep: 1.38,
  hen: 1.38, duck: 1.2, corgi: 1.45, goat: 1.48, pony: 1.82 };

export const TOOL_ICON = (tool = '') => {
  const t = String(tool).toLowerCase();
  if (/bash|shell|exec|command|terminal|run_/.test(t)) return '⌨️';
  if (/read|view|cat|open/.test(t)) return '📖';
  if (/edit|write|patch|replace|create|notebook/.test(t)) return '✏️';
  if (/grep|glob|search|find|rg|ls/.test(t)) return /web|google/.test(t) ? '🌐' : '🔍';
  if (/web|fetch|browse|url|http/.test(t)) return '🌐';
  if (/task|agent|delegate/.test(t)) return '🤝';
  if (/todo|plan/.test(t)) return '📝';
  if (/generate|llm|chat/.test(t)) return '🧠';
  if (/python|test|pytest|train|eval/.test(t)) return '🧪';
  if (/question|ask|input/.test(t)) return '❓';
  return '🔧';
};

export function prettyTool(tool = '') {
  const s = String(tool);
  if (s.startsWith('mcp__')) {
    const parts = s.split('__').filter(Boolean);
    return (parts[parts.length - 1] || s).replace(/_/g, ' ');
  }
  return s;
}

export function cropStage(tools) {
  if (!tools) return 0;
  if (tools < 10) return 1;
  if (tools < 40) return 2;
  return 3;
}

// ------------------------------------------------------------------ geometry
function segDist(px, py, ax, ay, bx, by) {
  const dx = bx - ax;
  const dy = by - ay;
  const L2 = dx * dx + dy * dy;
  const t = L2 ? clamp(((px - ax) * dx + (py - ay) * dy) / L2, 0, 1) : 0;
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

export class World {
  constructor(m, els, handlers = {}) {
    this.m = m;
    this.els = els;
    this.h = handlers;
    this.W = m.size[0];
    this.H = m.size[1];
    this.cam = { s: 0.5, tx: 0, ty: 0 };
    this.fitS = 0.5;
    this.critters = new Map();
    this.crops = new Map();
    this.agents = [];
    this.selected = null;
    this.filter = null;
    this.first = true;
    this.working = 0;
    this.bladeT = 0;
    this.lastT = performance.now();
    this.inset = { right: 0, top: 0, bottom: 0 };
    this.buildObstacles();
  }

  // world (x, y, z) -> base pixels
  P(x, y, z = 0) {
    const p = this.m.proj;
    return [p[0][0] * x + p[0][1] * y + p[0][2] * z + p[0][3],
      p[1][0] * x + p[1][1] * y + p[1][2] * z + p[1][3]];
  }

  toScreen(px, py) {
    return [px * this.cam.s + this.cam.tx, py * this.cam.s + this.cam.ty];
  }

  // ------------------------------------------------------------------ build
  async load() {
    const { m, els } = this;
    els.world.style.width = `${this.W}px`;
    els.world.style.height = `${this.H}px`;
    const bgs = [[els.bgDay, m.bg.day], [els.bgNight, m.bg.night || m.bg.day]];
    await Promise.all(bgs.map(([img, src]) => new Promise((res) => {
      img.onload = res;
      img.onerror = res;
      img.width = this.W;
      img.height = this.H;
      img.src = A(src);
    })));
    // soft shadow under the floating island
    const isl = m.island.map(([x, y]) => [x, y]);
    const bottom = isl.reduce((a, b) => (b[1] > a[1] ? b : a));
    const left = isl.reduce((a, b) => (b[0] < a[0] ? b : a));
    const right = isl.reduce((a, b) => (b[0] > a[0] ? b : a));
    const sh = els.shadow;
    const w = (right[0] - left[0]) * 0.78;
    Object.assign(sh.style, { left: `${(left[0] + right[0]) / 2 - w / 2}px`, top: `${bottom[1] + 120}px`,
      width: `${w}px`, height: `${w * 0.16}px` });
    // occluders
    for (const o of m.occluders || []) {
      const d = document.createElement('div');
      d.className = 'occ';
      Object.assign(d.style, { left: `${o.x}px`, top: `${o.y}px`, width: `${o.w}px`, height: `${o.h}px`, zIndex: Math.round(o.sort) });
      d.innerHTML = `<img class="day" src="${A(o.src.day)}" alt="" draggable="false">` +
        (o.src.night ? `<img class="night" src="${A(o.src.night)}" alt="" draggable="false">` : '');
      els.stage.appendChild(d);
    }
    // windmill sails
    const b = m.blades;
    if (b && b.frames?.day?.length) {
      const d = document.createElement('div');
      d.className = 'blades';
      Object.assign(d.style, { left: `${b.x}px`, top: `${b.y}px`, width: `${b.w}px`, height: `${b.h}px`, zIndex: Math.round(b.sort) });
      d.innerHTML = '<img class="bday" alt=""><img class="bnight" alt="">';
      els.stage.appendChild(d);
      this.bladeEl = d;
      this.bladeImgs = [d.children[0], d.children[1]];
      for (const k of ['day', 'night']) for (const f of b.frames[k] || []) (new Image()).src = A(f);
    }
    this.buildFx();
    this.bindCamera();
    this.fit(false);
    this.loop = this.loop.bind(this);
    requestAnimationFrame(this.loop);
    // background tabs pause rAF: keep the farm state moving at a low rate anyway
    setInterval(() => {
      if (performance.now() - this.lastT > 400) this.loop(performance.now(), true);
    }, 500);
  }

  buildObstacles() {
    const z = this.m.zones;
    this.obstacles = (this.m.obstacles || []).map(([x, y, r]) => ({ x, y, r }));
    const beds = z.plots.map((p) => p.center);
    for (const [x, y] of beds) this.obstacles.push({ x, y, r: 1.08 });
    const hubs = (z.hubs || []).map(([x, y]) => ({ x, y }));
    const seen = new Set();
    for (const [x, y] of beds) {
      for (const sx of [-1, 1]) for (const sy of [-1, 1]) {
        const hx = +(x + sx * 1.45).toFixed(2);
        const hy = +(y + sy * 1.45).toFixed(2);
        const k = `${hx},${hy}`;
        if (seen.has(k)) continue;
        seen.add(k);
        if (Math.abs(hx) < 9.4 && Math.abs(hy) < 9.4) hubs.push({ x: hx, y: hy });
      }
    }
    this.hubs = hubs.filter((h) => !this.obstacles.some((o) => Math.hypot(h.x - o.x, h.y - o.y) < o.r));
  }

  clear(a, b, ignore) {
    for (const o of this.obstacles) {
      if (ignore.has(o)) continue;
      if (segDist(o.x, o.y, a.x, a.y, b.x, b.y) < o.r - 0.04) return false;
    }
    return true;
  }

  path(from, to) {
    const ignore = new Set(this.obstacles.filter((o) => Math.hypot(from.x - o.x, from.y - o.y) < o.r ||
      Math.hypot(to.x - o.x, to.y - o.y) < o.r));
    if (this.clear(from, to, ignore)) return [to];
    const nodes = [from, ...this.hubs, to];
    const n = nodes.length;
    const dist = new Array(n).fill(Infinity);
    const prev = new Array(n).fill(-1);
    const done = new Array(n).fill(false);
    dist[0] = 0;
    for (;;) {
      let u = -1;
      for (let i = 0; i < n; i++) if (!done[i] && (u < 0 || dist[i] < dist[u])) u = i;
      if (u < 0 || dist[u] === Infinity) break;
      if (u === n - 1) break;
      done[u] = true;
      for (let v = 0; v < n; v++) {
        if (done[v] || v === u) continue;
        const d = Math.hypot(nodes[u].x - nodes[v].x, nodes[u].y - nodes[v].y);
        if (dist[u] + d >= dist[v]) continue;
        if (!this.clear(nodes[u], nodes[v], ignore)) continue;
        dist[v] = dist[u] + d;
        prev[v] = u;
      }
    }
    if (prev[n - 1] < 0) return [to];
    const out = [];
    for (let v = n - 1; v > 0; v = prev[v]) out.unshift(nodes[v]);
    return out;
  }

  // ------------------------------------------------------------------ fx
  buildFx() {
    const { m, els } = this;
    const fx = m.fx || {};
    for (const [x, y] of fx.lanterns || []) {
      const g = document.createElement('div');
      g.className = 'glow';
      g.style.left = `${x}px`;
      g.style.top = `${y}px`;
      g.style.animationDelay = `${-Math.random() * 3}s`;
      els.airFx.appendChild(g);
    }
    for (const [x, y] of (fx.windows || []).slice(0, 8)) {
      const g = document.createElement('div');
      g.className = 'glow';
      Object.assign(g.style, { left: `${x}px`, top: `${y}px`, width: '140px', height: '140px', margin: '-70px', animationDuration: '6s' });
      els.airFx.appendChild(g);
    }
    // fireflies around the meadow, pond and orchard
    const spots = [[2.8, 1.2], [6.6, 2.5], [0.4, 3.0], [-2.5, 1.0], [5.0, -4.5], [-8.0, -6.0], [3.5, 5.5], [-7.0, 2.0]];
    for (let i = 0; i < 22; i++) {
      const [cx, cy] = spots[i % spots.length];
      const [x, y] = this.P(cx + rand(-1.6, 1.6), cy + rand(-1.6, 1.6), rand(0.4, 1.6));
      const f = document.createElement('div');
      f.className = 'firefly';
      f.style.cssText = `left:${x}px;top:${y}px;--t:${rand(6, 12)}s;--b:${rand(1.6, 3.2)}s;--fx:${rand(-90, 90)}px;--fy:${rand(-60, 40)}px;animation-delay:${-rand(0, 10)}s,${-rand(0, 3)}s`;
      els.airFx.appendChild(f);
    }
    const bcols = ['#ffb3cf', '#fff1a0', '#bfe3ff', '#ffd2a1'];
    for (let i = 0; i < 5; i++) {
      const [x, y] = this.P(rand(-3, 8.5), rand(-8, 3), rand(0.6, 1.4));
      const b = document.createElement('div');
      b.className = 'butterfly';
      b.style.cssText = `left:${x}px;top:${y}px;--c:${bcols[i % bcols.length]};--t:${rand(10, 18)}s;--fx:${rand(-160, 160)}px;--fy:${rand(-60, 60)}px;animation-delay:${-rand(0, 10)}s`;
      b.innerHTML = '<i></i><i></i>';
      els.airFx.appendChild(b);
    }
    this.nextPuff = 0;
    this.nextRipple = 0;
  }

  fxTick(now) {
    const { els, m } = this;
    const fx = m.fx || {};
    if (fx.chimney?.length && now > this.nextPuff) {
      const busy = this.working > 0;
      this.nextPuff = now + (busy ? rand(700, 1100) : rand(2200, 3400));
      const [x, y] = fx.chimney[0];
      const p = document.createElement('div');
      p.className = 'puff';
      p.style.cssText = `left:${x + rand(-6, 6)}px;top:${y}px;--dx:${rand(10, 70)}px`;
      els.airFx.appendChild(p);
      setTimeout(() => p.remove(), 4300);
    }
    if (fx.pond && now > this.nextRipple) {
      this.nextRipple = now + rand(1400, 2600);
      const a = rand(0, Math.PI * 2);
      const r = Math.sqrt(Math.random()) * 0.7;
      const x = fx.pond.c[0] + Math.cos(a) * fx.pond.rx * r;
      const y = fx.pond.c[1] + Math.sin(a) * fx.pond.ry * r;
      const d = document.createElement('div');
      d.className = 'ripple';
      d.style.left = `${x}px`;
      d.style.top = `${y}px`;
      els.groundFx.appendChild(d);
      setTimeout(() => d.remove(), 2900);
    }
  }

  burst(px, py, kind) {
    const { els } = this;
    if (kind === 'dust') {
      for (let i = 0; i < 3; i++) {
        const d = document.createElement('div');
        d.className = 'dust';
        d.style.cssText = `left:${px + rand(-26, 26)}px;top:${py + rand(-6, 6)}px;--dx:${rand(-30, 30)}px`;
        els.airFx.appendChild(d);
        setTimeout(() => d.remove(), 950);
      }
      return;
    }
    const s = document.createElement('div');
    s.className = 'sparkle';
    s.textContent = kind;
    s.style.cssText = `left:${px + rand(-30, 20)}px;top:${py}px;--dx:${rand(-20, 20)}px`;
    els.airFx.appendChild(s);
    setTimeout(() => s.remove(), 1400);
  }

  // ------------------------------------------------------------------ camera
  setInset(inset) {
    this.inset = inset;
  }

  contentBox() {
    const pts = this.m.island;
    const xs = pts.map((p) => p[0]);
    const ys = pts.map((p) => p[1]);
    return { x0: Math.min(...xs) - 30, x1: Math.max(...xs) + 30, y0: Math.min(...ys) - 330, y1: Math.max(...ys) + 190 };
  }

  fit(animate = true) {
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const { right, top, bottom } = this.inset;
    const aw = vw - right - 20;
    const ah = vh - top - bottom - 10;
    const b = this.contentBox();
    const s = Math.min(aw / (b.x1 - b.x0), ah / (b.y1 - b.y0));
    this.fitS = s;
    const cx = (b.x0 + b.x1) / 2;
    const cy = (b.y0 + b.y1) / 2;
    const target = { s, tx: 10 + aw / 2 - cx * s, ty: top + ah / 2 - cy * s };
    this.animateCam(target, animate ? 600 : 0);
  }

  animateCam(target, ms = 500) {
    if (!ms) {
      Object.assign(this.cam, target);
      this.applyCam();
      return;
    }
    const from = { ...this.cam };
    const t0 = performance.now();
    this.camAnim = (now) => {
      const k = clamp((now - t0) / ms, 0, 1);
      const e = 1 - Math.pow(1 - k, 3);
      this.cam.s = from.s + (target.s - from.s) * e;
      this.cam.tx = from.tx + (target.tx - from.tx) * e;
      this.cam.ty = from.ty + (target.ty - from.ty) * e;
      this.applyCam();
      if (k >= 1) this.camAnim = null;
    };
  }

  applyCam() {
    const { s, tx, ty } = this.cam;
    this.els.world.style.transform = `translate(${tx}px, ${ty}px) scale(${s})`;
    this.els.labels.classList.toggle('zoomed', s > this.fitS * 1.45);
    const compact = s < 0.235;
    if (compact !== this.compact) {
      this.compact = compact;
      this.els.labels.classList.toggle('compact', compact);
      for (const c of this.critters.values()) c.sizeDirty = true;
    }
  }

  zoomAt(f, sx, sy) {
    const s = clamp(this.cam.s * f, this.fitS * 0.7, this.fitS * 4);
    const k = s / this.cam.s;
    this.cam.tx = sx - (sx - this.cam.tx) * k;
    this.cam.ty = sy - (sy - this.cam.ty) * k;
    this.cam.s = s;
    this.camAnim = null;
    this.applyCam();
  }

  focus(px, py, zoom = true) {
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const { right, top, bottom } = this.inset;
    const s = zoom ? Math.max(this.cam.s, this.fitS * 1.7) : this.cam.s;
    const cx = (vw - right) / 2;
    const cy = top + (vh - top - bottom) / 2 + 30;
    this.animateCam({ s, tx: cx - px * s, ty: cy - py * s }, 650);
  }

  bindCamera() {
    const vp = this.els.viewport;
    const ptrs = new Map();
    let last = null;
    let pinch = null;
    let moved = 0;
    vp.addEventListener('wheel', (e) => {
      e.preventDefault();
      const f = Math.exp(-e.deltaY * (e.ctrlKey ? 0.01 : 0.0016));
      this.zoomAt(f, e.clientX, e.clientY);
    }, { passive: false });
    vp.addEventListener('pointerdown', (e) => {
      ptrs.set(e.pointerId, { x: e.clientX, y: e.clientY });
      try { vp.setPointerCapture(e.pointerId); } catch { /* synthetic pointer */ }
      moved = 0;
      if (ptrs.size === 1) last = { x: e.clientX, y: e.clientY };
      if (ptrs.size === 2) {
        const [a, b] = [...ptrs.values()];
        pinch = { d: Math.hypot(a.x - b.x, a.y - b.y), s: this.cam.s };
      }
    });
    vp.addEventListener('pointermove', (e) => {
      if (!ptrs.has(e.pointerId)) return;
      ptrs.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (ptrs.size === 2 && pinch) {
        const [a, b] = [...ptrs.values()];
        const d = Math.hypot(a.x - b.x, a.y - b.y);
        const f = (pinch.s * (d / pinch.d)) / this.cam.s;
        this.zoomAt(f, (a.x + b.x) / 2, (a.y + b.y) / 2);
        moved += 10;
        return;
      }
      if (last) {
        const dx = e.clientX - last.x;
        const dy = e.clientY - last.y;
        moved += Math.abs(dx) + Math.abs(dy);
        if (moved > 4) vp.classList.add('dragging');
        this.cam.tx += dx;
        this.cam.ty += dy;
        this.camAnim = null;
        this.applyCam();
        last = { x: e.clientX, y: e.clientY };
      }
    });
    const up = (e) => {
      ptrs.delete(e.pointerId);
      if (ptrs.size < 2) pinch = null;
      if (!ptrs.size) {
        last = null;
        vp.classList.remove('dragging');
        if (moved < 5 && e.type === 'pointerup') {
          const hit = document.elementsFromPoint(e.clientX, e.clientY).find((el) => el.classList?.contains('hit'));
          if (hit) this.h.select?.(hit.dataset.id);
          else this.h.select?.(null);
        }
      } else {
        const p = [...ptrs.values()][0];
        last = { x: p.x, y: p.y };
      }
    };
    vp.addEventListener('pointerup', up);
    vp.addEventListener('pointercancel', up);
    vp.addEventListener('dblclick', () => this.fit());
    vp.addEventListener('pointermove', (e) => {
      if (ptrs.size) return;
      const hit = document.elementsFromPoint(e.clientX, e.clientY).find((el) => el.classList?.contains('hit'));
      const id = hit ? hit.dataset.id : null;
      if (id !== this.hoverId) {
        this.hoverId = id;
        for (const c of this.critters.values()) {
          c.el.classList.toggle('hover', c.id === id);
          c.tag.classList.toggle('hover', c.id === id);
        }
      }
      this.h.hover?.(id, e.clientX, e.clientY);
    });
    vp.addEventListener('pointerleave', () => {
      this.hoverId = null;
      this.h.hover?.(null);
    });
  }

  // ------------------------------------------------------------------ agents
  setAgents(agents) {
    this.agents = agents;
    const onFarm = agents.filter((a) => a.onFarm && a.animal && this.m.animals?.[a.animal]);
    const ids = new Set(onFarm.map((a) => a.id));
    for (const [id, c] of this.critters) {
      if (!ids.has(id)) {
        c.destroy();
        this.critters.delete(id);
      }
    }
    // slot assignment for shared zones
    const z = this.m.zones;
    const waiting = onFarm.filter((a) => a.status === 'waiting').sort((a, b) => (a.id < b.id ? -1 : 1));
    const sleeping = onFarm.filter((a) => a.status === 'sleeping').sort((a, b) => (a.plot ?? 0) - (b.plot ?? 0));
    const slot = {};
    waiting.forEach((a, i) => { slot[a.id] = z.porch[i % z.porch.length]; });
    sleeping.forEach((a, i) => { slot[a.id] = z.barnyard[i % z.barnyard.length]; });
    this.working = onFarm.filter((a) => a.status === 'working').length;
    for (const a of onFarm) {
      let c = this.critters.get(a.id);
      if (c && c.kind !== a.animal) {
        c.destroy();
        this.critters.delete(a.id);
        c = null;
      }
      if (!c) {
        c = new Critter(this, a, this.first);
        this.critters.set(a.id, c);
      }
      c.update(a, slot[a.id]);
    }
    this.syncCrops(onFarm);
    this.first = false;
  }

  syncCrops(onFarm) {
    const z = this.m.zones;
    const want = new Map();
    for (const a of onFarm) {
      if (a.plot == null || !z.plots[a.plot]) continue;
      want.set(a.plot, { stage: cropStage(a.counts?.tools), crop: z.plots[a.plot].crop });
    }
    for (const [plot, el] of this.crops) {
      const w = want.get(plot);
      if (!w || !w.stage) {
        el.remove();
        this.crops.delete(plot);
      }
    }
    for (const [plot, w] of want) {
      if (!w.stage) continue;
      const meta = this.m.crops?.[w.crop];
      if (!meta) continue;
      let el = this.crops.get(plot);
      const [cx, cy] = z.plots[plot].center;
      const [px, py] = this.P(cx, cy, 0);
      if (!el) {
        el = document.createElement('div');
        el.className = 'crop';
        Object.assign(el.style, { left: `${px - meta.ax}px`, top: `${py - meta.ay}px`, width: `${meta.w}px`, height: `${meta.h}px`, zIndex: Math.round(py) });
        el.innerHTML = '<img alt="" draggable="false">';
        this.els.stage.appendChild(el);
        this.crops.set(plot, el);
      }
      if (el.dataset.stage !== String(w.stage)) {
        const img = el.firstChild;
        const grew = el.dataset.stage && Number(el.dataset.stage) < w.stage;
        img.src = A(meta.stages[String(w.stage)]);
        el.dataset.stage = String(w.stage);
        img.classList.remove('grow');
        void img.offsetWidth;
        img.classList.add('grow');
        if (grew) this.burst(px, py - 40, '🌱');
      }
    }
  }

  select(id) {
    this.selected = id;
    for (const c of this.critters.values()) c.setSelected(c.id === id);
    const c = this.critters.get(id);
    if (c) {
      const [px, py] = this.P(c.x, c.y);
      this.focus(px, py - 40);
    }
  }

  setFilter(fn) {
    this.filter = fn;
    for (const c of this.critters.values()) c.setDim(fn ? !fn(c.agent) : false);
  }

  // keep name tags / bubbles from piling on top of each other
  layoutTags() {
    const items = [];
    for (const c of this.critters.values()) {
      if (c.tagX == null) continue;
      if (c.sizeDirty || !c.tagW) {
        c.tagW = c.tag.offsetWidth || 80;
        c.tagH = c.tag.offsetHeight || 24;
        c.sizeDirty = false;
      }
      const solo = (c.agent.status === 'sleeping' || (this.compact && c.agent.status === 'idle')) &&
        !c.tag.classList.contains('sel') && !c.tag.classList.contains('hover') &&
        !this.els.labels.classList.contains('zoomed');
      items.push({ c, x: c.tagX, y: c.tagY, w: c.tagW * c.tagK, h: (solo ? 18 : c.tagH) * c.tagK, solo });
    }
    items.sort((a, b) => b.y - a.y);
    const placed = [];
    for (const it of items) {
      let y = it.y;
      if (!it.solo) {
        for (let k = 0; k < 10; k++) {
          const hit = placed.find((p) => Math.abs(p.x - it.x) < (p.w + it.w) / 2 + 3 && y > p.y - p.h + 1 && y - it.h < p.y - 1);
          if (!hit) break;
          y = hit.y - hit.h - 2;
        }
        placed.push({ ...it, y });
      }
      const c = it.c;
      const lift = it.y - y;
      c.tag.style.transform = `translate(${it.x}px, ${y}px) translate(-50%, -100%) scale(${c.tagK})`;
      c.tag.classList.toggle('lifted', lift > 4);
    }
  }

  critterAt(id) {
    return this.critters.get(id);
  }

  // ------------------------------------------------------------------ loop
  loop(now, manual = false) {
    const dt = Math.min(manual ? 0.5 : 0.05, (now - this.lastT) / 1000);
    this.lastT = now;
    if (this.camAnim) this.camAnim(now);
    for (const c of this.critters.values()) c.tick(dt, now);
    this.layoutTags();
    // windmill: spins faster the more agents are working
    if (this.bladeImgs) {
      const fr = this.m.blades.frames;
      const speed = 2.2 + Math.min(14, this.working * 2.6);
      this.bladeT += dt * speed;
      const k = Math.floor(this.bladeT) % fr.day.length;
      if (k !== this.bladeK) {
        this.bladeK = k;
        this.bladeImgs[0].src = A(fr.day[k]);
        if (fr.night) this.bladeImgs[1].src = A(fr.night[k]);
      }
    }
    this.fxTick(now);
    this.h.frame?.(now);
    if (!manual) requestAnimationFrame(this.loop);
  }
}

// ------------------------------------------------------------------ critter
class Critter {
  constructor(world, a, placeNow) {
    this.w = world;
    this.id = a.id;
    this.kind = a.animal;
    this.meta = world.m.animals[a.animal];
    this.agent = a;
    this.dir = Math.random() < 0.5 ? 'se' : 'sw';
    this.face = this.dir;
    this.frame = 0;
    this.ft = 0;
    this.route = [];
    this.target = null;
    this.idleNext = 0;
    this.dustNext = 0;
    this.speed = 1.7;
    this.placeNow = placeNow;
    // spawn at the farm gate (or directly in place on first load)
    this.x = 8.6;
    this.y = -8.6;
    const { w: sw, h: sh, ax, ay } = this.meta;
    const el = document.createElement('div');
    el.className = 'critter';
    el.style.width = `${sw}px`;
    el.style.height = `${sh}px`;
    const rr = 0.5 * world.m.ppu;
    el.innerHTML = `<div class="ring" style="left:${ax - rr}px;top:${ay - rr / 2}px;width:${rr * 2}px;height:${rr}px"></div>` +
      `<div class="body" style="left:0;top:0;width:${sw}px;height:${sh}px;--ox:${ax}px;--oy:${ay}px"><img alt="" draggable="false"></div>` +
      `<div class="hit" data-id="${a.id}" style="left:${ax - 46}px;top:${ay - 118}px;width:92px;height:128px"></div>`;
    this.el = el;
    this.img = el.querySelector('img');
    world.els.stage.appendChild(el);
    const tag = document.createElement('div');
    tag.className = 'tag';
    tag.innerHTML = '<div class="fxs"></div><div class="bubble"></div><div class="name"><i class="pd"></i><span></span></div>';
    this.tag = tag;
    this.bubble = tag.querySelector('.bubble');
    this.fxs = tag.querySelector('.fxs');
    this.nameEl = tag.querySelector('.name span');
    world.els.labels.appendChild(tag);
    for (const f of Object.values(this.meta.frames)) (new Image()).src = A(f);
  }

  destroy() {
    this.el.remove();
    this.tag.remove();
  }

  setSelected(on) {
    this.el.classList.toggle('sel', on);
    this.tag.classList.toggle('sel', on);
  }

  setDim(on) {
    this.el.style.opacity = on ? 0.45 : '';
    this.tag.classList.toggle('dim', on);
  }

  goalFor(a, slot) {
    const z = this.w.m.zones;
    const st = a.status;
    if (st === 'waiting' && slot) return { x: slot[0], y: slot[1], face: 'se', zone: 'porch' };
    if (st === 'sleeping' && slot) return { x: slot[0], y: slot[1], face: Math.random() < 0.5 ? 'se' : 'sw', zone: 'barn' };
    if (st === 'idle') {
      const pts = z.meadow;
      const p = pts[Math.floor(Math.random() * pts.length)];
      return { x: p[0] + rand(-0.35, 0.35), y: p[1] + rand(-0.35, 0.35), face: Math.random() < 0.5 ? 'se' : 'sw', zone: 'meadow' };
    }
    const plot = z.plots[a.plot ?? 0];
    const [sx, sy] = plot.station;
    return { x: sx, y: sy, face: plot.id % 2 ? 'se' : 'sw', zone: `plot${plot.id}` };
  }

  update(a, slot) {
    const prev = this.agent;
    this.agent = a;
    const pc = a.color || '#999';
    this.el.style.setProperty('--pc', pc);
    this.tag.style.setProperty('--pc', pc);
    this.tag.style.setProperty('--sc', `var(--${a.status})`);
    this.nameEl.textContent = a.temp ? `🧪 ${a.name}` : a.name;
    this.tag.classList.toggle('temp', !!a.temp);
    this.el.classList.toggle('temp', !!a.temp);
    for (const s of ['working', 'thinking', 'waiting', 'error', 'idle', 'sleeping']) {
      this.el.classList.toggle(`st-${s}`, a.status === s);
      this.tag.classList.toggle(`st-${s}`, a.status === s);
    }
    const goal = this.goalFor(a, slot);
    const zoneChanged = !this.target || this.target.zone !== goal.zone ||
      (slot && (Math.abs(this.target.x - goal.x) > 0.01 || Math.abs(this.target.y - goal.y) > 0.01));
    if (zoneChanged) this.go(goal);
    // little celebrations
    if (prev && prev !== a) {
      const [px, py] = this.w.P(this.x, this.y);
      if ((a.counts?.tools || 0) > (prev.counts?.tools || 0) && a.status === 'working') this.w.burst(px, py - 70, '✨');
      if (prev.status !== 'idle' && a.status === 'idle' && prev.status !== 'sleeping') this.w.burst(px, py - 90, '✅');
    }
    this.renderTag();
  }

  go(goal) {
    this.target = goal;
    if (this.placeNow) {
      this.x = goal.x;
      this.y = goal.y;
      this.route = [];
      this.placeNow = false;
      this.dir = goal.face;
      return;
    }
    this.route = this.w.path({ x: this.x, y: this.y }, { x: goal.x, y: goal.y });
    const far = Math.hypot(goal.x - this.x, goal.y - this.y);
    this.speed = far > 7 ? 2.5 : 1.75;
    this.idleNext = performance.now() + rand(6000, 14000);
  }

  renderTag() {
    const a = this.agent;
    const act = a.activity || {};
    let html = '';
    const esc = (s) => String(s || '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
    const L = this.w.h.t || ((k) => k);
    if (a.status === 'working') html = `${TOOL_ICON(act.tool)}<span class="bt">${esc(prettyTool(act.tool) || '…')}</span>`;
    else if (a.status === 'thinking') html = '💭<span class="dots"><i></i><i></i><i></i></span>';
    else if (a.status === 'waiting') html = `❗<span class="bt">${esc(L(act.kind === 'permission' ? 'bubble_permission' : 'bubble_waiting'))}</span>`;
    else if (a.status === 'error') html = `⚠️<span class="bt">${esc(L('bubble_error'))}</span>`;
    else if (a.status === 'idle' && Date.now() - a.lastActive < 90e3) html = `✅<span class="bt">${esc(L('bubble_done'))}</span>`;
    if (html !== this.lastBubble) {
      this.bubble.innerHTML = html;
      this.lastBubble = html;
      this.sizeDirty = true;
    }
    if (this.lastName !== a.name) {
      this.lastName = a.name;
      this.sizeDirty = true;
    }
    const fx = a.status === 'sleeping' ? '<span class="zzz">Z</span><span class="zzz">z</span><span class="zzz">z</span>' :
      a.status === 'error' ? '<div class="storm"></div>' : '';
    if (fx !== this.lastFx) {
      this.fxs.innerHTML = fx;
      this.lastFx = fx;
      this.fxs.style.position = 'relative';
    }
  }

  tick(dt, now) {
    const a = this.agent;
    let moving = false;
    if (this.route.length) {
      const nxt = this.route[0];
      const dx = nxt.x - this.x;
      const dy = nxt.y - this.y;
      const d = Math.hypot(dx, dy);
      const step = this.speed * dt;
      if (d <= step) {
        this.x = nxt.x;
        this.y = nxt.y;
        this.route.shift();
      } else {
        this.x += (dx / d) * step;
        this.y += (dy / d) * step;
      }
      if (d > 0.001) this.dir = Math.abs(dx) > Math.abs(dy) ? (dx > 0 ? 'se' : 'nw') : (dy > 0 ? 'ne' : 'sw');
      moving = this.route.length > 0 || d > step;
    }
    if (!moving && this.target) {
      if (this.dir !== 'se' && this.dir !== 'sw') this.dir = this.target.face;
      // idle animals wander around the meadow
      if (a.status === 'idle' && now > this.idleNext) {
        const g = this.goalFor(a);
        g.zone = this.target.zone;
        this.target = g;
        this.route = this.w.path({ x: this.x, y: this.y }, g);
        this.speed = 1.2;
        this.idleNext = now + rand(7000, 16000);
      }
      if (a.status === 'idle' && Math.random() < dt * 0.08) this.dir = this.dir === 'se' ? 'sw' : 'se';
    }
    this.el.classList.toggle('moving', moving);
    // frame
    let name;
    this.ft += dt;
    if (moving) {
      const fps = this.speed > 2 ? 12 : 9;
      if (this.ft > 1 / fps) {
        this.ft = 0;
        this.frame = (this.frame + 1) % 4;
      }
      name = `${this.dir}_walk${this.frame}`;
    } else if (a.status === 'working') {
      if (this.ft > 0.38) {
        this.ft = 0;
        this.frame = (this.frame + 1) % 2;
      }
      name = `${this.dir}_work${this.frame}`;
      if (now > this.dustNext) {
        this.dustNext = now + rand(700, 1300);
        const [px, py] = this.w.P(this.x + 0.25, this.y - 0.1);
        this.w.burst(px, py, 'dust');
      }
    } else if (a.status === 'sleeping') {
      name = `${this.dir}_sleep`;
    } else {
      name = `${this.dir}_idle`;
    }
    const src = this.meta.frames[name] || this.meta.frames[`${this.dir}_idle`] || this.meta.frames.se_idle;
    if (src !== this.src) {
      this.src = src;
      this.img.src = A(src);
    }
    const [px, py] = this.w.P(this.x, this.y);
    this.el.style.transform = `translate(${px - this.meta.ax}px, ${py - this.meta.ay}px)`;
    this.el.style.zIndex = Math.round(py);
    // label in screen space
    const hgt = (HEIGHT[this.kind] || 1.5) * (a.status === 'sleeping' && !moving ? 0.62 : 1);
    const [tx, ty] = this.w.P(this.x, this.y, hgt);
    const [sx, sy] = this.w.toScreen(tx, ty - 6);
    this.tagK = this.w.compact ? 0.9 : clamp(this.w.cam.s / this.w.fitS, 0.85, 1.25);
    this.tagX = sx;
    this.tagY = sy;
    this.tag.style.zIndex = Math.round(py);
  }
}
