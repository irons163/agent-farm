// Claude Code: reads ~/.claude/projects/<project>/<session>.jsonl transcripts.
import fs from 'node:fs';
import path from 'node:path';
import { Session, CFG, clip } from '../session.mjs';
import { HOME, JsonlTail, listDir, statSafe, ts, toolDetail, textOf, readHead, headObjects,
         stripTags } from '../util.mjs';

const ROOT = process.env.CLAUDE_CONFIG_DIR
  ? path.join(process.env.CLAUDE_CONFIG_DIR, 'projects')
  : path.join(HOME, '.claude', 'projects');

// hook events name their transcript; only ever follow real transcripts under ROOT
function transcriptIn(root, p) {
  if (typeof p !== 'string' || !p.endsWith('.jsonl') || p.includes('\0')) return '';
  try {
    const real = fs.realpathSync(p);
    const base = fs.realpathSync(root) + path.sep;
    // keep the caller's spelling so it matches the paths scan() lists
    return real.startsWith(base) && fs.statSync(real).isFile() ? path.resolve(p) : '';
  } catch {
    return '';
  }
}

function promptText(content) {
  const raw = textOf(content);
  if (!raw) return '';
  const cmd = raw.match(/<command-name>([^<]*)<\/command-name>/);
  if (cmd) {
    const args = raw.match(/<command-args>([\s\S]*?)<\/command-args>/);
    return `${cmd[1].trim()} ${args ? args[1].trim() : ''}`.trim();
  }
  if (/^\s*<(local-command|system-reminder|bash-|task-notification|user-memory)/.test(raw)) return '';
  if (/^\s*Caveat:/.test(raw)) return '';
  return stripTags(raw);
}

export class ClaudeCollector {
  constructor() {
    this.platform = 'claude-code';
    this.files = new Map(); // file -> {tail, session}
    this.lastScan = 0;
    this.found = false;
    this.root = ROOT;
  }

  info() {
    return { platform: this.platform, root: this.root, found: this.found, sessions: this.files.size };
  }

  sessionFor(file) {
    let rec = this.files.get(file);
    if (!rec) {
      const sid = path.basename(file, '.jsonl');
      const s = new Session(`claude:${sid}`, this.platform);
      s.extra.sessionId = sid;
      rec = { tail: new JsonlTail(file), session: s, headDone: false };
      this.files.set(file, rec);
    }
    return rec;
  }

  async scan(now) {
    const projects = await listDir(this.root);
    this.found = projects.length > 0;
    const cands = [];
    for (const d of projects) {
      if (!d.isDirectory()) continue;
      const dir = path.join(this.root, d.name);
      for (const f of await listDir(dir)) {
        if (!f.isFile() || !f.name.endsWith('.jsonl')) continue;
        cands.push(path.join(dir, f.name));
      }
    }
    const fresh = [];
    await Promise.all(cands.map(async (file) => {
      const st = await statSafe(file);
      if (st && now - st.mtimeMs < CFG.windowMs) fresh.push([file, st]);
    }));
    this.active = fresh.map(([f]) => f);
    for (const file of [...this.files.keys()]) if (!this.active.includes(file)) this.files.delete(file);
    return fresh;
  }

  async poll(now) {
    let list;
    if (now - this.lastScan > 10e3 || !this.active) {
      this.lastScan = now;
      list = await this.scan(now);
    } else {
      list = [];
      await Promise.all(this.active.map(async (f) => {
        const st = await statSafe(f);
        if (st) list.push([f, st]);
      }));
    }
    for (const [file, st] of list) {
      const rec = this.sessionFor(file);
      if (st.mtimeMs === rec.tail.mtime && st.size === rec.tail.size) continue;
      if (!rec.headDone) {
        rec.headDone = true;
        await this.readHeadInfo(file, rec.session);
      }
      const rows = await rec.tail.read(st);
      for (const r of rows) this.ingest(rec.session, r);
      if (!rec.session.lastTs) rec.session.lastTs = st.mtimeMs;
    }
    return [...this.files.values()].map((r) => r.session).filter((s) => s.lastTs);
  }

  async readHeadInfo(file, s) {
    const rows = headObjects(await readHead(file));
    for (const r of rows) {
      if (r.cwd && !s.project) s.project = r.cwd;
      if (r.type === 'user' && !s.title) {
        const t = promptText(r.message?.content);
        if (t) s.title = clip(t, 80);
      }
      if (s.project && s.title) break;
    }
  }

  ingest(s, r) {
    const t = ts(r.timestamp);
    if (r.cwd) s.project = r.cwd;
    if (r.gitBranch && r.gitBranch !== 'HEAD') s.extra.branch = r.gitBranch;
    switch (r.type) {
      case 'summary':
        if (r.summary) s.title = clip(r.summary, 80);
        return;
      case 'agent-name':
      case 'custom-title':
      case 'ai-title': {
        const n = r.agentName || r.customTitle || r.title || r.aiTitle;
        if (n) s.extra.label = clip(n, 60);
        return;
      }
      case 'user': {
        if (r.isSidechain) {
          s.touch(t);
          return;
        }
        const c = r.message?.content;
        if (Array.isArray(c) && c.some((x) => x && x.type === 'tool_result')) {
          for (const x of c) if (x && x.type === 'tool_result') s.toolEnd(t, x.tool_use_id, x.is_error);
          return;
        }
        const raw = textOf(c);
        if (/\[Request interrupted by user/.test(raw)) {
          s.interrupt(t);
          return;
        }
        if (r.isMeta) {
          s.touch(t);
          return;
        }
        const text = promptText(c);
        if (text) s.promptIn(t, text);
        else s.touch(t);
        return;
      }
      case 'assistant': {
        if (r.isSidechain) {
          s.touch(t);
          return;
        }
        const m = r.message || {};
        if (m.model && !m.model.startsWith('<')) s.model = m.model;
        if (m.usage?.output_tokens) s.tokens += m.usage.output_tokens;
        if (r.isApiErrorMessage || r.error) {
          s.error(t, textOf(m.content) || r.error || 'API error');
          return;
        }
        const blocks = Array.isArray(m.content) ? m.content : [];
        let said = '';
        for (const b of blocks) {
          if (!b) continue;
          if (b.type === 'tool_use') s.toolStart(t, b.id, b.name, toolDetail(b.name, b.input));
          else if (b.type === 'text' && b.text) said = b.text;
          else if (b.type === 'thinking') s.thinking(t);
        }
        if (said) s.text(t, stripTags(said), m.stop_reason === 'end_turn');
        else if (!blocks.some((b) => b && b.type === 'tool_use')) s.thinking(t);
        if (m.stop_reason === 'end_turn' && !said) s.done(t);
        return;
      }
      case 'system': {
        if (/error/i.test(r.subtype || '') || r.level === 'error') s.error(t, r.content || r.subtype);
        else s.touch(t);
        return;
      }
      default:
        if (t) s.touch(t);
    }
  }

  /** Real-time events from the optional Claude Code hook (hooks/claude-hook.mjs). */
  hook(evt) {
    const sid = evt.session_id;
    if (!sid) return false;
    let rec = [...this.files.values()].find((r) => r.session.extra.sessionId === sid);
    if (!rec && evt.transcript_path) {
      const file = transcriptIn(this.root, evt.transcript_path);
      if (file) {
        rec = this.sessionFor(file);
        this.active = [...new Set([...(this.active || []), file])];
      }
    }
    if (!rec) return false;
    const s = rec.session;
    const now = Date.now();
    if (typeof evt.cwd === 'string' && evt.cwd) s.project = clip(evt.cwd, 300);
    const name = evt.hook_event_name;
    const tool = typeof evt.tool_name === 'string' ? clip(evt.tool_name, 80) : undefined;
    const detail = tool ? clip(toolDetail(tool, evt.tool_input), 140) : '';
    if (name === 'PreToolUse') s.hook = { status: /AskUserQuestion|ExitPlanMode/.test(tool) ? 'waiting' : 'working', kind: 'tool', tool, detail, ts: now };
    else if (name === 'PostToolUse' || name === 'UserPromptSubmit' || name === 'SubagentStop') s.hook = { status: 'thinking', ts: now, detail: name === 'UserPromptSubmit' ? clip(evt.prompt, 120) : '' };
    else if (name === 'Notification') {
      const msg = String(evt.message || '');
      if (/permission|approve|waiting|input/i.test(msg) || evt.notification_type === 'permission_prompt')
        s.hook = { status: 'waiting', kind: 'permission', detail: clip(msg, 120), ts: now };
      else if (evt.notification_type === 'idle_prompt') s.hook = { status: 'idle', detail: clip(msg, 120), ts: now };
    } else if (name === 'Stop') s.hook = { status: 'idle', ts: now, detail: '' };
    else if (name === 'SessionEnd') s.hook = { status: 'sleeping', ts: now, detail: '' };
    else if (name === 'SessionStart') s.hook = { status: 'idle', ts: now, detail: '' };
    if (s.hook) s.touch(now);
    return true;
  }
}
