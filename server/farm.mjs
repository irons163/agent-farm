// The farm registry: polls every collector, assigns each agent a unique animal
// and a raised bed, and produces the snapshot the web app renders.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Session, CFG, clip } from './session.mjs';
import { ClaudeCollector } from './collectors/claude.mjs';
import { CodexCollector } from './collectors/codex.mjs';
import { CursorCollector, GeminiCollector, AntigravityCollector, OpenCodeCollector,
         OllamaCollector } from './collectors/others.mjs';
import { Demo } from './demo.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let VERSION = '';
try { VERSION = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version || ''; } catch { /* unknown */ }
const IN_APP = process.env.FARM_APP === '1';
// commands shown in the help dialog: the macOS app has its own Node, so give full paths there
const NODE_CMD = IN_APP ? process.execPath : 'node';

export const ANIMALS = ['fox', 'cat', 'rabbit', 'owl', 'cow', 'pig', 'sheep', 'hen', 'duck', 'corgi',
  'goat', 'pony'];
export const MAX_ON_FARM = ANIMALS.length;

export const PLATFORMS = {
  'claude-code': { label: 'Claude Code', color: '#D97757', animals: ['fox', 'corgi', 'pony', 'hen'] },
  codex: { label: 'Codex', color: '#10A37F', animals: ['cat', 'goat', 'sheep'] },
  cursor: { label: 'Cursor', color: '#6E7BF2', animals: ['owl', 'hen', 'duck'] },
  'gemini-cli': { label: 'Gemini CLI', color: '#4C8DF6', animals: ['rabbit', 'duck'] },
  antigravity: { label: 'Antigravity', color: '#A46CF0', animals: ['duck', 'rabbit'] },
  opencode: { label: 'OpenCode', color: '#F0A33A', animals: ['corgi', 'pig'] },
  ollama: { label: 'Ollama', color: '#8B919C', animals: ['sheep', 'goat'] },
  openai: { label: 'OpenAI', color: '#3D3D45', animals: ['cat', 'pig'] },
  anthropic: { label: 'Claude API', color: '#D97757', animals: ['fox', 'pony'] },
  gemini: { label: 'Gemini API', color: '#4C8DF6', animals: ['rabbit'] },
  deepseek: { label: 'DeepSeek', color: '#4D6BFE', animals: ['cow', 'pig'] },
  grok: { label: 'Grok', color: '#2B2B33', animals: ['goat'] },
  mistral: { label: 'Mistral', color: '#FA6A1F', animals: ['hen'] },
  qwen: { label: 'Qwen', color: '#6C5CE7', animals: ['pig'] },
  kimi: { label: 'Kimi', color: '#2A6CF6', animals: ['cow'] },
  glm: { label: 'GLM', color: '#3366FF', animals: ['pony'] },
  openrouter: { label: 'OpenRouter', color: '#6467F2', animals: ['duck'] },
  lmstudio: { label: 'LM Studio', color: '#7A5AF8', animals: ['sheep'] },
  custom: { label: 'Custom', color: '#E2A33B', animals: [] },
};

const ORDER = { waiting: 0, error: 1, working: 2, thinking: 3, idle: 4, sleeping: 5 };
const MAX_PUSH = 200; // pushed agents kept in memory
const COLOR = /^#[0-9a-f]{3,8}$/i;

// "Temporary" sessions: run from a temp folder (scripts, other agents probing CLIs) or a
// finished one-shot (one prompt, no tools, over within minutes). They stay visible, but
// are tagged, never take a farm slot from a real agent, and one-shots expire quickly.
const WIN = process.platform === 'win32';
const normDir = (p) => {
  const s = String(p).replace(/\\/g, '/').replace(/\/*$/, '/');
  return WIN ? s.toLowerCase() : s;
};
const TMP_DIRS = (() => {
  const dirs = new Set(['/tmp/', '/private/tmp/', '/var/folders/', '/private/var/folders/', '/var/tmp/']);
  for (const d of [os.tmpdir(), process.env.TMPDIR, process.env.TEMP, process.env.TMP]) {
    if (!d) continue;
    dirs.add(normDir(d));
    try {
      dirs.add(normDir(fs.realpathSync(d)));
    } catch { /* ignore */ }
  }
  return [...dirs];
})();
export const isTempPath = (p) => !!p && TMP_DIRS.some((d) => normDir(p).startsWith(d));
// platforms whose collectors can count prompts and tools reliably
const COUNTED = new Set(['claude-code', 'codex', 'cursor', 'gemini-cli', 'opencode']);
const ONE_SHOT_TTL = Number(process.env.FARM_ONESHOT_MIN || 30) * 60e3;

export function classify(a) {
  if (a.demo || a.source === 'push') return null;
  const oneShot = COUNTED.has(a.platform) && (a.counts?.turns || 0) <= 1 && !a.counts?.tools &&
    (a.status === 'idle' || a.status === 'sleeping') &&
    a.lastActive - (a.startedAt || a.lastActive) < 10 * 60e3;
  if (isTempPath(a.project)) return oneShot ? 'tmpdir+oneshot' : 'tmpdir';
  return oneShot ? 'oneshot' : null;
}

export class Farm {
  constructor({ dataDir }) {
    this.dataDir = dataDir;
    this.collectors = [new ClaudeCollector(), new CodexCollector(), new CursorCollector(),
      new GeminiCollector(), new AntigravityCollector(), new OpenCodeCollector(),
      new OllamaCollector()];
    if (process.env.FARM_COLLECTORS) {
      const allow = new Set(process.env.FARM_COLLECTORS.split(',').map((s) => s.trim()));
      this.collectors = this.collectors.filter((c) => allow.has(c.platform));
    }
    this.polls = new Map();      // collector -> poll still running
    this.lastLists = new Map();  // collector -> sessions from its last finished poll
    this.push = new Map();
    this.demo = null;
    this.demoMode = process.env.FARM_DEMO || 'off'; // auto | on | off
    this.showTemp = true;
    this.animalOf = new Map();
    this.plotOf = new Map();
    this.memory = {};
    this.errors = {};
    this.snapshot = { agents: [], now: Date.now() };
    this.loadState();
  }

  loadState() {
    try {
      const j = JSON.parse(fs.readFileSync(path.join(this.dataDir, 'farm-state.json'), 'utf8'));
      this.memory = j.animals || {};
      // "auto" was the default before demos became opt-in (--demo); a saved "auto" is that old default,
      // not a choice, so it must not switch demo animals back on. "on" and "off" were picked on purpose.
      if ((j.demoMode === 'on' || j.demoMode === 'off') && !process.env.FARM_DEMO) this.demoMode = j.demoMode;
      if (typeof j.showTemp === 'boolean') this.showTemp = j.showTemp;
    } catch {
      /* first run */
    }
  }

  saveState() {
    try {
      fs.mkdirSync(this.dataDir, { recursive: true });
      const keys = Object.keys(this.memory);
      if (keys.length > 400) for (const k of keys.slice(0, keys.length - 400)) delete this.memory[k];
      fs.writeFileSync(path.join(this.dataDir, 'farm-state.json'),
        JSON.stringify({ animals: this.memory, demoMode: this.demoMode, showTemp: this.showTemp }, null, 1));
    } catch {
      /* read-only checkout */
    }
  }

  // ------------------------------------------------------------ push API
  report(body) {
    const id = clip(String(body.id || body.agent || body.name || ''), 80);
    if (!id) throw new Error('missing "id"');
    const key = `push:${id}`;
    if (body.status === 'offline' || body.status === 'remove') {
      this.push.delete(key);
      return { ok: true, removed: true };
    }
    let s = this.push.get(key);
    const platform = String(body.platform || 'custom').toLowerCase().replace(/[^a-z0-9._-]/g, '').slice(0, 32) ||
      'custom';
    if (!s && this.push.size >= MAX_PUSH) {
      // forget the agent that reported longest ago
      let old = null;
      for (const [k, v] of this.push) if (!old || v.lastTs < old[1].lastTs) old = [k, v];
      this.push.delete(old[0]);
    }
    if (!s) {
      s = new Session(key, platform);
      s.extra.source = 'push';
      this.push.set(key, s);
    }
    s.platform = platform;
    s.name = clip(body.name || s.name || id, 40); // no name given: show the id, not the platform
    if (body.project) s.project = clip(body.project, 200);
    if (body.model) s.model = clip(body.model, 60);
    if (body.task || body.title) s.title = clip(body.task || body.title, 100);
    if (body.color && COLOR.test(String(body.color))) s.extra.color = String(body.color);
    if (body.animal && ANIMALS.includes(body.animal)) s.extra.wantAnimal = body.animal;
    if (Number.isFinite(body.tokens)) s.tokens = Math.max(0, Math.floor(body.tokens));
    if (body.progress && typeof body.progress === 'object') {
      s.extra.progress = { done: Number(body.progress.done) || 0, all: Number(body.progress.all) || 0 };
    }
    const now = Date.now();
    let status = String(body.status || 'working').toLowerCase();
    if (status === 'done' || status === 'complete' || status === 'completed') status = 'idle';
    if (status === 'running' || status === 'busy') status = 'working';
    if (status === 'needs_input' || status === 'blocked') status = 'waiting';
    if (!ORDER.hasOwnProperty(status)) status = 'working';
    const tool = body.tool ? clip(body.tool, 40) : undefined;
    const detail = clip(body.detail || body.message || '', 140);
    const prev = s.hook;
    if (status === 'working' && (!prev || prev.tool !== tool || prev.detail !== detail)) s.tools++;
    if (status === 'thinking' && prev && prev.status !== 'thinking' && body.prompt) s.turns++;
    if (body.prompt) s.promptIn(now, body.prompt);
    s.hook = { status, tool, detail, kind: tool ? 'tool' : status, ts: now };
    s.touch(now);
    s.log(now, status === 'working' ? 'tool' : status === 'idle' ? 'reply' : status,
      [tool, detail].filter(Boolean).join(' · ') || status);
    return { ok: true, id: key };
  }

  hookClaude(evt) {
    const c = this.collectors.find((x) => x.platform === 'claude-code');
    return c ? c.hook(evt) : false;
  }

  setDemo(mode) {
    if (!['auto', 'on', 'off'].includes(mode)) throw new Error('mode must be auto|on|off');
    this.demoMode = mode;
    this.saveState();
  }

  setSettings(body) {
    if (typeof body.showTemp === 'boolean') this.showTemp = body.showTemp;
    else throw new Error('expected {"showTemp": true|false}');
    this.saveState();
  }

  // ------------------------------------------------------------ polling
  async tick() {
    const now = Date.now();
    const real = [];
    // A platform whose files are slow or blocked (a network drive, or macOS waiting on a permission
    // prompt for an external disk) must not freeze the whole farm: show its last result meanwhile.
    await Promise.all(this.collectors.map(async (c) => {
      if (!this.polls.has(c)) {
        this.polls.set(c, c.poll(now).then((list) => {
          this.lastLists.set(c, list);
          delete this.errors[c.platform];
        }, (e) => {
          this.lastLists.set(c, []);
          this.errors[c.platform] = String(e.message || e);
        }).finally(() => this.polls.delete(c)));
      }
      let timer;
      await Promise.race([this.polls.get(c), new Promise((r) => { timer = setTimeout(r, 3000); })]);
      clearTimeout(timer);
      real.push(...(this.lastLists.get(c) || []));
    }));
    real.push(...this.push.values());
    const visible = real.filter((s) => now - s.lastTs < CFG.windowMs);
    let demoOn = this.demoMode === 'on' ||
      (this.demoMode === 'auto' && !visible.some((s) => now - s.lastTs < CFG.sleepAfterMs));
    let all = visible;
    if (demoOn) {
      if (!this.demo) this.demo = new Demo();
      all = visible.concat(this.demo.tick(now));
    } else this.demo = null;
    let agents = all.map((s) => s.snapshot(now));
    let tempTotal = 0;
    for (const a of agents) {
      const p = PLATFORMS[a.platform] || PLATFORMS.custom;
      a.platformLabel = p.label;
      a.color = a.color || p.color;
      if (a.label) a.title = a.label;
      const why = classify(a);
      a.temp = !!why;
      if (why) a.tempReason = why;
    }
    // finished one-shots disappear after ONE_SHOT_TTL instead of the full window
    agents = agents.filter((a) => !(a.tempReason?.includes('oneshot') && now - a.lastActive > ONE_SHOT_TTL));
    tempTotal = agents.filter((a) => a.temp).length;
    if (!this.showTemp) agents = agents.filter((a) => !a.temp);
    agents.sort((a, b) => (ORDER[a.status] - ORDER[b.status]) || (b.lastActive - a.lastActive));
    this.place(agents);
    // de-duplicate visible names ("api", "api · 2")
    const seen = {};
    for (const a of agents) {
      const k = a.name;
      seen[k] = (seen[k] || 0) + 1;
      if (seen[k] > 1) a.name = `${k} · ${seen[k]}`;
    }
    this.snapshot = {
      now,
      agents,
      platforms: Object.fromEntries(Object.entries(PLATFORMS).map(([k, v]) => [k, { label: v.label, color: v.color }])),
      collectors: this.collectors.map((c) => ({ ...c.info(), error: this.errors[c.platform] || c.error || undefined })),
      demo: { mode: this.demoMode, active: demoOn },
      settings: { showTemp: this.showTemp, tempCount: tempTotal, oneShotMin: ONE_SHOT_TTL / 60e3 },
      config: { version: VERSION, sleepAfterMin: CFG.sleepAfterMs / 60e3, windowHours: CFG.windowMs / 3600e3, maxOnFarm: MAX_ON_FARM,
        hookPath: path.join(ROOT, 'hooks', 'claude-hook.mjs'), node: NODE_CMD, app: IN_APP,
        reportPath: IN_APP ? path.join(ROOT, 'bin', 'farm-report.mjs') : 'bin/farm-report.mjs' },
    };
    return this.snapshot;
  }

  place(agents) {
    // the most relevant 12 live on the farm; the rest wait in the barn (panel only).
    // temporary sessions only get a spot when no real agent needs it.
    const onFarm = [...agents].sort((a, b) => (a.temp - b.temp) || (ORDER[a.status] - ORDER[b.status]) ||
      (b.lastActive - a.lastActive)).slice(0, MAX_ON_FARM);
    const ids = new Set(onFarm.map((a) => a.id));
    for (const id of [...this.animalOf.keys()]) if (!ids.has(id)) this.animalOf.delete(id);
    for (const id of [...this.plotOf.keys()]) if (!ids.has(id)) this.plotOf.delete(id);
    const usedA = new Set(this.animalOf.values());
    const usedP = new Set(this.plotOf.values());
    let dirty = false;
    // stable order for assignment: oldest session first, so animals don't shuffle
    const byAge = [...onFarm].sort((a, b) => (a.startedAt || a.lastActive) - (b.startedAt || b.lastActive));
    for (const a of byAge) {
      if (!this.animalOf.has(a.id)) {
        const prefs = [a.wantAnimal, this.memory[a.id], ...((PLATFORMS[a.platform] || PLATFORMS.custom).animals),
          ...ANIMALS].filter(Boolean);
        const kind = prefs.find((k) => !usedA.has(k)) || ANIMALS[0];
        this.animalOf.set(a.id, kind);
        usedA.add(kind);
        if (this.memory[a.id] !== kind) {
          this.memory[a.id] = kind;
          dirty = true;
        }
      }
      if (!this.plotOf.has(a.id)) {
        let p = 0;
        while (usedP.has(p)) p++;
        this.plotOf.set(a.id, p);
        usedP.add(p);
      }
    }
    for (const a of agents) {
      a.onFarm = ids.has(a.id);
      a.animal = this.animalOf.get(a.id) || this.memory[a.id] || null;
      a.plot = this.plotOf.has(a.id) ? this.plotOf.get(a.id) : null;
      delete a.wantAnimal;
    }
    if (dirty) this.saveState();
  }
}
