// Cursor Agent, Gemini CLI, Google Antigravity, OpenCode and Ollama collectors.
import fsp from 'node:fs/promises';
import path from 'node:path';
import { Session, CFG, clip } from '../session.mjs';
import { HOME, JsonlTail, listDir, statSafe, ts, toolDetail, textOf, resolveSlug,
         stripTags } from '../util.mjs';

// ---------------------------------------------------------------- Cursor
export class CursorCollector {
  constructor() {
    this.platform = 'cursor';
    this.root = path.join(HOME, '.cursor', 'projects');
    this.files = new Map();
    this.found = false;
    this.lastScan = 0;
  }

  info() {
    return { platform: this.platform, root: this.root, found: this.found, sessions: this.files.size };
  }

  async scan(now) {
    const out = [];
    const projects = await listDir(this.root);
    this.found = projects.length > 0;
    for (const p of projects) {
      if (!p.isDirectory()) continue;
      const dir = path.join(this.root, p.name, 'agent-transcripts');
      for (const e of await listDir(dir)) {
        let f = null;
        if (e.isFile() && e.name.endsWith('.jsonl')) f = path.join(dir, e.name);
        else if (e.isDirectory()) f = path.join(dir, e.name, e.name + '.jsonl');
        if (!f) continue;
        const st = await statSafe(f);
        if (st && now - st.mtimeMs < CFG.windowMs) out.push([f, st, p.name]);
      }
    }
    this.active = out.map((x) => [x[0], x[2]]);
    return out;
  }

  async poll(now) {
    let list;
    if (now - this.lastScan > 10e3 || !this.active) {
      this.lastScan = now;
      list = await this.scan(now);
    } else {
      list = [];
      for (const [f, slug] of this.active) {
        const st = await statSafe(f);
        if (st) list.push([f, st, slug]);
      }
    }
    const keep = new Set(list.map((x) => x[0]));
    for (const f of [...this.files.keys()]) if (!keep.has(f)) this.files.delete(f);
    for (const [file, st, slug] of list) {
      let rec = this.files.get(file);
      if (!rec) {
        const id = path.basename(file, '.jsonl');
        const s = new Session(`cursor:${id}`, this.platform);
        s.project = resolveSlug(slug);
        s.extra.sessionId = id;
        rec = { tail: new JsonlTail(file, 1024 * 1024), session: s, last: null };
        this.files.set(file, rec);
      }
      if (st.mtimeMs !== rec.tail.mtime || st.size !== rec.tail.size) {
        const rows = await rec.tail.read(st);
        for (const r of rows) {
          this.ingest(rec.session, r, st.mtimeMs);
          rec.last = r;
        }
      }
      this.settle(rec, st.mtimeMs, now);
    }
    return [...this.files.values()].map((r) => r.session).filter((s) => s.lastTs);
  }

  ingest(s, r, t) {
    if (r.type === 'turn_ended') {
      if (r.status === 'error') s.error(t, r.error || 'turn failed');
      else s.done(t);
      return;
    }
    const c = r.message?.content;
    if (r.role === 'user') {
      const raw = textOf(c);
      const q = raw.match(/<user_query>([\s\S]*?)<\/user_query>/);
      const text = stripTags(q ? q[1] : raw);
      if (text) s.promptIn(t, text);
    } else if (r.role === 'assistant' && Array.isArray(c)) {
      for (const b of c) {
        if (b?.type === 'tool_use') s.toolDone(t, b.name, toolDetail(b.name, b.input));
        else if (b?.type === 'text' && b.text) s.text(t, b.text, false);
      }
    }
  }

  settle(rec, mtime, now) {
    // transcripts have no tool results: a trailing tool call in a fresh file means "running"
    const s = rec.session;
    const r = rec.last;
    s.pending.clear();
    if (!r) return;
    if (r.role === 'assistant' && Array.isArray(r.message?.content) && now - mtime < 90e3) {
      const tools = r.message.content.filter((b) => b?.type === 'tool_use');
      const last = tools.pop();
      if (last) s.pending.set('cur', { name: last.name, detail: clip(toolDetail(last.name, last.input), 120), ts: mtime });
    }
  }
}

// ---------------------------------------------------------------- Gemini CLI
export class GeminiCollector {
  constructor() {
    this.platform = 'gemini-cli';
    this.root = path.join(HOME, '.gemini', 'tmp');
    this.cache = new Map();
    this.found = false;
  }

  info() {
    return { platform: this.platform, root: this.root, found: this.found, sessions: this.cache.size };
  }

  async poll(now) {
    const dirs = await listDir(this.root);
    this.found = dirs.length > 0;
    const seen = new Set();
    for (const d of dirs) {
      if (!d.isDirectory()) continue;
      const base = path.join(this.root, d.name);
      let project = '';
      try {
        project = (await fsp.readFile(path.join(base, '.project_root'), 'utf8')).trim();
      } catch {
        /* older CLI versions hash the path */
      }
      for (const f of await listDir(path.join(base, 'chats'))) {
        if (!f.isFile() || !/^session-.*\.json$/.test(f.name)) continue;
        const file = path.join(base, 'chats', f.name);
        const st = await statSafe(file);
        if (!st || now - st.mtimeMs > CFG.windowMs) continue;
        seen.add(file);
        const c = this.cache.get(file);
        if (c && c.mtime === st.mtimeMs) continue;
        try {
          const j = JSON.parse(await fsp.readFile(file, 'utf8'));
          this.cache.set(file, { mtime: st.mtimeMs, session: this.build(j, project || d.name, st.mtimeMs) });
        } catch {
          /* being written */
        }
      }
    }
    for (const f of [...this.cache.keys()]) if (!seen.has(f)) this.cache.delete(f);
    return [...this.cache.values()].map((c) => c.session);
  }

  build(j, project, mtime) {
    const s = new Session(`gemini:${j.sessionId || path.basename(project)}`, this.platform);
    s.project = project;
    const msgs = Array.isArray(j.messages) ? j.messages : [];
    msgs.forEach((m, i) => {
      const t = ts(m.timestamp) || mtime;
      if (m.model) s.model = m.model;
      if (m.tokens?.output) s.tokens += m.tokens.output;
      if (m.type === 'user') s.promptIn(t, textOf(m.content));
      else if (m.type === 'gemini') {
        let pending = false;
        for (const tc of m.toolCalls || []) {
          const st = String(tc.status || '').toLowerCase();
          if (/executing|scheduled|validating|awaiting/.test(st)) {
            s.toolStart(t, tc.id, tc.name, toolDetail(tc.name, tc.args));
            if (/awaiting/.test(st)) s.waiting(t, `${tc.name} 需要核准`);
            pending = true;
          } else s.toolDone(t, tc.displayName || tc.name, toolDetail(tc.name, tc.args));
        }
        if (m.thoughts?.length) s.thinking(t);
        const text = textOf(m.content);
        if (text) s.text(t, text, !pending && i === msgs.length - 1);
      } else if (m.type === 'error') s.error(t, textOf(m.content));
    });
    if (!s.lastTs) s.lastTs = mtime;
    return s;
  }
}

// ---------------------------------------------------------------- Antigravity
export class AntigravityCollector {
  constructor() {
    this.platform = 'antigravity';
    this.root = path.join(HOME, '.gemini', 'antigravity');
    this.sessions = new Map();
    this.found = false;
  }

  info() {
    return { platform: this.platform, root: this.root, found: this.found, sessions: this.sessions.size };
  }

  async poll(now) {
    const conv = path.join(this.root, 'conversations');
    const ents = await listDir(conv);
    this.found = ents.length > 0;
    const seen = new Set();
    for (const e of ents) {
      const m = e.name.match(/^([0-9a-f-]{36})\.(db|pb)$/);
      if (!m) continue;
      const id = m[1];
      let mt = 0;
      for (const suf of ['', '-wal']) {
        const st = await statSafe(path.join(conv, e.name + suf));
        if (st) mt = Math.max(mt, st.mtimeMs);
      }
      const brain = path.join(this.root, 'brain', id);
      const task = await statSafe(path.join(brain, 'task.md'));
      if (task) mt = Math.max(mt, task.mtimeMs);
      if (!mt || now - mt > CFG.windowMs) continue;
      seen.add(id);
      let s = this.sessions.get(id);
      if (!s) {
        s = new Session(`antigravity:${id}`, this.platform);
        s.extra.sessionId = id;
        this.sessions.set(id, s);
      }
      if (task && task.mtimeMs !== s.extra.taskMtime) {
        s.extra.taskMtime = task.mtimeMs;
        try {
          const md = await fsp.readFile(path.join(brain, 'task.md'), 'utf8');
          const h = md.split('\n').find((l) => /^#\s+/.test(l));
          if (h) s.title = clip(h.replace(/^#+\s*/, ''), 80);
          const done = (md.match(/^\s*[-*]\s+\[x\]/gim) || []).length;
          const all = (md.match(/^\s*[-*]\s+\[[ x/]\]/gim) || []).length;
          if (all) s.extra.progress = { done, all };
          const cur = md.split('\n').find((l) => /^\s*[-*]\s+\[\/\]/.test(l));
          if (cur) s.extra.current = clip(cur.replace(/^\s*[-*]\s+\[\/\]\s*/, ''), 100);
        } catch {
          /* ignore */
        }
      }
      if (mt > s.lastTs) {
        s.touch(mt);
        s.log(mt, 'tool', s.extra.current || 'working');
      }
      const age = now - mt;
      s.pending.clear();
      s.lastKind = age < 180e3 ? 'thinking' : 'done';
      if (age < 45e3) s.pending.set('ag', { name: 'Antigravity', detail: s.extra.current || s.title, ts: mt });
      if (!s.project) s.project = s.title ? '' : id.slice(0, 8);
      s.name = 'Antigravity';
    }
    for (const id of [...this.sessions.keys()]) if (!seen.has(id)) this.sessions.delete(id);
    return [...this.sessions.values()];
  }
}

// ---------------------------------------------------------------- OpenCode
export class OpenCodeCollector {
  constructor() {
    this.platform = 'opencode';
    this.db = path.join(process.env.XDG_DATA_HOME || path.join(HOME, '.local', 'share'), 'opencode', 'opencode.db');
    this.found = false;
    this.sessions = new Map();
    this.lastPoll = 0;
  }

  info() {
    return { platform: this.platform, root: this.db, found: this.found, sessions: this.sessions.size };
  }

  async poll(now) {
    if (now - this.lastPoll < 2500) return [...this.sessions.values()];
    this.lastPoll = now;
    const st = await statSafe(this.db);
    this.found = !!st;
    if (!st) return [];
    let db;
    try {
      const { DatabaseSync } = await import('node:sqlite');
      db = new DatabaseSync(this.db, { readOnly: true });
      const rows = db.prepare(`SELECT id, title, directory, model, time_created, time_updated, tokens_output
                               FROM session WHERE parent_id IS NULL AND time_archived IS NULL
                               AND time_updated > ? ORDER BY time_updated DESC LIMIT 20`)
        .all(now - CFG.windowMs);
      const seen = new Set();
      for (const r of rows) {
        seen.add(r.id);
        let s = this.sessions.get(r.id);
        if (!s || s.extra.updated !== r.time_updated) {
          s = new Session(`opencode:${r.id}`, this.platform);
          s.extra.updated = r.time_updated;
          s.project = r.directory;
          s.title = clip(r.title, 80);
          try {
            const m = JSON.parse(r.model);
            s.model = m.modelID || m.id || '';
          } catch {
            s.model = r.model || '';
          }
          s.tokens = r.tokens_output || 0;
          s.startedAt = r.time_created;
          const parts = db.prepare(`SELECT data, time_updated FROM part WHERE session_id = ?
                                    ORDER BY time_updated DESC LIMIT 60`).all(r.id).reverse();
          for (const p of parts) {
            let d;
            try {
              d = JSON.parse(p.data);
            } catch {
              continue;
            }
            const t = p.time_updated;
            if (d.type === 'tool') {
              const status = d.state?.status;
              const detail = toolDetail(d.tool, d.state?.input) || d.state?.title || '';
              if (status === 'running' || status === 'pending') s.toolStart(t, d.callID || d.id, d.tool, detail);
              else if (status === 'error') {
                s.toolDone(t, d.tool, detail);
              } else s.toolDone(t, d.tool, detail);
            } else if (d.type === 'text' && d.text && !d.synthetic) {
              s.text(t, d.text, false);
            } else if (d.type === 'step-start') s.thinking(t);
            else if (d.type === 'step-finish') {
              if (d.reason === 'stop' || d.reason === 'end_turn') s.done(t);
            }
          }
          try {
            const perm = db.prepare('SELECT * FROM permission WHERE session_id = ? LIMIT 1').get(r.id);
            if (perm) s.waiting(r.time_updated, perm.title || perm.type || 'permission');
          } catch {
            /* schema differs */
          }
          s.touch(r.time_updated);
          this.sessions.set(r.id, s);
        }
      }
      for (const id of [...this.sessions.keys()]) if (!seen.has(id)) this.sessions.delete(id);
    } catch (e) {
      this.error = String(e.message || e);
    } finally {
      try {
        db?.close();
      } catch {
        /* ignore */
      }
    }
    return [...this.sessions.values()];
  }
}

// ---------------------------------------------------------------- Ollama
export class OllamaCollector {
  constructor() {
    this.platform = 'ollama';
    this.url = (process.env.OLLAMA_HOST || 'http://127.0.0.1:11434').replace(/\/$/, '');
    if (!/^https?:/.test(this.url)) this.url = 'http://' + this.url;
    this.found = false;
    this.sessions = new Map();
    this.lastPoll = 0;
  }

  info() {
    return { platform: this.platform, root: this.url, found: this.found, sessions: this.sessions.size };
  }

  async poll(now) {
    if (now - this.lastPoll < 5000) return [...this.sessions.values()];
    this.lastPoll = now;
    try {
      const ctl = AbortSignal.timeout(700);
      const r = await fetch(this.url + '/api/ps', { signal: ctl });
      const j = await r.json();
      this.found = true;
      const seen = new Set();
      for (const m of j.models || []) {
        const id = `ollama:${m.name}`;
        seen.add(id);
        let s = this.sessions.get(id);
        if (!s) {
          s = new Session(id, this.platform);
          s.name = `Ollama · ${m.name.split(':')[0]}`;
          s.model = m.name;
          s.project = 'local model';
          this.sessions.set(id, s);
        }
        // expires_at = last use + keep_alive (default 5 min)
        const lastUse = ts(m.expires_at) - 5 * 60e3;
        if (lastUse > s.lastTs) {
          s.touch(Math.min(lastUse, now));
          s.log(now, 'tool', `generate · ${m.name}`);
        }
        s.pending.clear();
        s.lastKind = 'done';
        if (now - lastUse < 20e3) s.pending.set('gen', { name: 'generate', detail: m.name, ts: lastUse });
        s.title = `${m.details?.parameter_size || ''} ${m.details?.quantization_level || ''}`.trim();
      }
      for (const id of [...this.sessions.keys()]) if (!seen.has(id)) this.sessions.delete(id);
    } catch {
      this.found = false;
      this.sessions.clear();
    }
    return [...this.sessions.values()];
  }
}
