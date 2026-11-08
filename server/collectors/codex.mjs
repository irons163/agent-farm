// OpenAI Codex (CLI, IDE extension and Desktop): ~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl
import path from 'node:path';
import { Session, CFG, clip } from '../session.mjs';
import { HOME, JsonlTail, listDir, realDir, statSafe, ts, textOf, stripTags } from '../util.mjs';

const ROOT = path.join(process.env.CODEX_HOME || path.join(HOME, '.codex'), 'sessions');

const pad = (n) => String(n).padStart(2, '0');

function argsDetail(name, raw) {
  if (!raw) return '';
  let a = raw;
  if (typeof raw === 'string') {
    try {
      a = JSON.parse(raw);
    } catch {
      return raw.split('\n').find((l) => l.trim()) || '';
    }
  }
  if (Array.isArray(a.command)) return a.command.slice(-1)[0];
  if (a.cmd) return String(a.cmd);
  if (a.command) return String(a.command);
  if (a.title) return String(a.title);
  if (Array.isArray(a.questions) && a.questions[0]) return a.questions[0].question || a.questions[0].title || '';
  if (a.query) return String(a.query);
  if (a.path) return path.basename(String(a.path));
  return '';
}

export class CodexCollector {
  constructor() {
    this.platform = 'codex';
    this.files = new Map();
    this.lastScan = 0;
    this.found = false;
    this.root = ROOT;
  }

  info() {
    return { platform: this.platform, root: this.root, found: this.found, sessions: this.files.size };
  }

  async scan(now) {
    const root = await realDir(this.root);
    const days = [];
    const span = Math.ceil(CFG.windowMs / 86400e3) + 1;
    for (let k = 0; k <= span; k++) {
      const d = new Date(now - k * 86400e3);
      days.push(path.join(root, String(d.getFullYear()), pad(d.getMonth() + 1), pad(d.getDate())));
    }
    const fresh = [];
    let any = false;
    for (const dir of days) {
      const ents = await listDir(dir);
      if (ents.length) any = true;
      await Promise.all(ents.map(async (e) => {
        if (!e.isFile() || !e.name.endsWith('.jsonl')) return;
        const f = path.join(dir, e.name);
        const st = await statSafe(f);
        if (st && now - st.mtimeMs < CFG.windowMs) fresh.push([f, st]);
      }));
    }
    this.found = any || (await listDir(root)).length > 0;
    this.active = fresh.map(([f]) => f);
    for (const f of [...this.files.keys()]) if (!this.active.includes(f)) this.files.delete(f);
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
      let rec = this.files.get(file);
      if (!rec) {
        const m = path.basename(file).match(/([0-9a-f]{8}-[0-9a-f-]{27,})\.jsonl$/i);
        const id = m ? m[1] : path.basename(file, '.jsonl');
        const s = new Session(`codex:${id}`, this.platform);
        s.extra.sessionId = id;
        rec = { tail: new JsonlTail(file, 2 * 1024 * 1024), session: s };
        this.files.set(file, rec);
      }
      if (st.mtimeMs === rec.tail.mtime && st.size === rec.tail.size) continue;
      for (const r of await rec.tail.read(st)) this.ingest(rec.session, r);
      if (!rec.session.lastTs) rec.session.lastTs = st.mtimeMs;
    }
    return [...this.files.values()].map((r) => r.session).filter((s) => s.lastTs);
  }

  ingest(s, r) {
    const t = ts(r.timestamp);
    const p = r.payload || {};
    switch (r.type) {
      case 'session_meta':
        if (p.cwd) s.project = p.cwd;
        if (p.originator) s.extra.client = p.originator;
        if (p.thread_source === 'automation') s.extra.automation = true;
        s.touch(t);
        return;
      case 'turn_context':
        if (p.cwd) s.project = p.cwd;
        if (p.model) s.model = p.model;
        return;
      case 'response_item':
        return this.item(s, t, p);
      case 'event_msg':
        return this.event(s, t, p);
      default:
        return;
    }
  }

  item(s, t, p) {
    switch (p.type) {
      case 'function_call':
      case 'custom_tool_call':
      case 'local_shell_call': {
        const name = p.name || (p.type === 'local_shell_call' ? 'shell' : 'tool');
        const detail = argsDetail(name, p.arguments ?? p.input ?? p.action);
        s.toolStart(t, p.call_id || p.id, name, detail);
        return;
      }
      case 'function_call_output':
      case 'custom_tool_call_output':
      case 'local_shell_call_output':
        s.toolEnd(t, p.call_id);
        return;
      case 'reasoning':
        s.thinking(t);
        return;
      default:
        return;
    }
  }

  event(s, t, p) {
    switch (p.type) {
      case 'thread_settings_applied':
        if (p.thread_settings?.model) s.model = p.thread_settings.model;
        if (p.thread_settings?.cwd) s.project = p.thread_settings.cwd;
        return;
      case 'task_started':
        s.thinking(t);
        s.lastKind = 'prompt';
        return;
      case 'user_message':
        s.promptIn(t, p.message || '');
        return;
      case 'item_completed': {
        const it = p.item || {};
        if (it.type === 'UserMessage') {
          const text = stripTags(textOf(it.content));
          if (text) s.promptIn(t, text);
        } else if (it.type === 'AgentMessage') {
          const text = textOf(it.content);
          if (text) s.text(t, text, false);
        } else if (it.type === 'CommandExecution') {
          // the matching tool call already counted; just log the command
          s.touch(t);
        } else if (it.type === 'Reasoning') {
          s.thinking(t);
        }
        return;
      }
      case 'agent_message':
        s.text(t, p.message, false);
        return;
      case 'agent_reasoning':
        s.thinking(t);
        return;
      case 'exec_command_begin':
        s.toolStart(t, p.call_id, 'shell', argsDetail('shell', { command: p.command }));
        return;
      case 'exec_command_end':
      case 'patch_apply_end':
      case 'mcp_tool_call_end':
        s.toolEnd(t, p.call_id);
        return;
      case 'exec_approval_request':
      case 'apply_patch_approval_request':
      case 'request_user_input':
      case 'elicitation_request':
        s.waiting(t, p.reason || argsDetail('', { command: p.command }) || 'approval');
        return;
      case 'token_count': {
        const u = p.info?.total_token_usage;
        if (u?.output_tokens) s.tokens = u.output_tokens;
        return;
      }
      case 'task_complete':
        s.done(t, p.last_agent_message || '');
        return;
      case 'turn_aborted':
        s.interrupt(t);
        return;
      case 'error':
      case 'stream_error':
        s.error(t, p.message || 'error');
        return;
      case 'thread_name_updated':
        if (p.thread_name || p.name) s.extra.label = clip(p.thread_name || p.name, 60);
        return;
      default:
        return;
    }
  }
}
