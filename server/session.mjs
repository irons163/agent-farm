// A platform-neutral model of one AI agent session and how we derive its
// "farm status" from the stream of events the collectors feed it.

export const STATUS = ['working', 'thinking', 'waiting', 'error', 'idle', 'sleeping'];

export const CFG = {
  sleepAfterMs: Number(process.env.FARM_SLEEP_MIN || 15) * 60e3,   // idle -> sleeping
  windowMs: Number(process.env.FARM_WINDOW_HOURS || 12) * 3600e3,  // hide older sessions
  thinkingStaleMs: 4 * 60e3,      // "thinking" this long without events -> idle
  toolStaleMs: 20 * 60e3,         // a pending tool this old is probably a stuck prompt
  editPromptMs: 40e3,             // an edit that has not finished after this is a permission prompt
  errorKeepMs: 30 * 60e3,
};

// Tools whose pending state means the agent is asking *you* something.
const WAIT_TOOLS = /^(AskUserQuestion|ExitPlanMode|request_user_input.*|ask_user.*|ask_followup_question)$/i;
const EDIT_TOOLS = /^(Edit|Write|MultiEdit|NotebookEdit|apply_patch|replace|write_file|edit_file)$/i;

const clip = (s, n = 140) => {
  if (s == null) return '';
  s = String(s).replace(/\s+/g, ' ').trim();
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
};
export { clip };

export class Session {
  constructor(id, platform) {
    this.id = id;
    this.platform = platform;
    this.project = '';
    this.name = '';
    this.title = '';
    this.model = '';
    this.startedAt = 0;
    this.lastTs = 0;
    this.lastKind = 'none';
    this.lastText = '';
    this.prompt = '';
    this.pending = new Map();
    this.waitReason = '';
    this.errorMsg = '';
    this.tools = 0;
    this.turns = 0;
    this.tokens = 0;
    this.events = [];
    this.times = [];
    this.hook = null;   // {status, tool, detail, ts} from real-time hooks
    this.extra = {};
  }

  touch(ts) {
    if (!ts || Number.isNaN(ts)) return;
    if (!this.startedAt || ts < this.startedAt) this.startedAt = ts;
    if (ts > this.lastTs) this.lastTs = ts;
    this.times.push(ts);
    if (this.times.length > 600) this.times.splice(0, this.times.length - 600);
  }

  log(ts, kind, text) {
    this.events.push({ t: ts, kind, text: clip(text, 160) });
    if (this.events.length > 40) this.events.splice(0, this.events.length - 40);
  }

  promptIn(ts, text) {
    this.touch(ts);
    this.turns++;
    this.prompt = clip(text, 200);
    if (!this.title) this.title = clip(text, 80);
    this.lastKind = 'prompt';
    this.waitReason = '';
    this.errorMsg = '';
    this.pending.clear();
    this.log(ts, 'prompt', text);
  }

  thinking(ts) {
    this.touch(ts);
    if (this.lastKind !== 'prompt') this.lastKind = 'thinking';
  }

  toolStart(ts, id, name, detail) {
    this.touch(ts);
    this.tools++;
    this.pending.set(id || `${name}-${ts}`, { name, detail: clip(detail, 120), ts });
    this.lastKind = 'tool';
    if (WAIT_TOOLS.test(name)) this.waitReason = clip(detail || name, 120);
    this.log(ts, 'tool', `${name}${detail ? ' · ' + detail : ''}`);
  }

  toolEnd(ts, id, isError) {
    this.touch(ts);
    if (id && this.pending.has(id)) this.pending.delete(id);
    else if (!id && this.pending.size) this.pending.delete([...this.pending.keys()].pop());
    this.lastKind = 'tool_result';
    if (isError) this.log(ts, 'warn', 'tool error');
  }

  toolDone(ts, name, detail) {
    // a tool reported only once it finished (no start event)
    this.touch(ts);
    this.tools++;
    this.lastKind = 'tool_result';
    this.log(ts, 'tool', `${name}${detail ? ' · ' + detail : ''}`);
  }

  text(ts, text, final) {
    this.touch(ts);
    if (text) this.lastText = clip(text, 200);
    if (final) {
      this.lastKind = 'done';
      this.pending.clear();
      if (text) this.log(ts, 'reply', text);
    } else {
      this.lastKind = 'text';
      if (text) this.log(ts, 'say', text);
    }
  }

  done(ts, text) {
    this.touch(ts);
    if (text) {
      this.lastText = clip(text, 200);
      this.log(ts, 'reply', text);
    } else this.log(ts, 'done', '');
    this.lastKind = 'done';
    this.pending.clear();
  }

  interrupt(ts) {
    this.touch(ts);
    this.lastKind = 'done';
    this.pending.clear();
    this.log(ts, 'stop', 'interrupted');
  }

  error(ts, msg) {
    this.touch(ts);
    this.lastKind = 'error';
    this.errorMsg = clip(msg || 'error', 160);
    this.pending.clear();
    this.log(ts, 'error', msg);
  }

  waiting(ts, reason) {
    this.touch(ts);
    this.waitReason = clip(reason || 'waiting for you', 140);
    this.log(ts, 'wait', reason);
  }

  // ---------------------------------------------------------------- status
  derive(now) {
    const age = now - this.lastTs;
    let status = 'idle';
    let activity = { kind: 'idle', text: this.lastText || '' };
    const last = [...this.pending.values()].pop();
    if (this.lastKind === 'error' && age < CFG.errorKeepMs) {
      status = 'error';
      activity = { kind: 'error', text: this.errorMsg };
    } else if (last && WAIT_TOOLS.test(last.name)) {
      status = 'waiting';
      activity = { kind: 'question', tool: last.name, text: last.detail || this.waitReason };
    } else if (last && EDIT_TOOLS.test(last.name) && age > CFG.editPromptMs && age < 6 * 3600e3) {
      status = 'waiting';
      activity = { kind: 'permission', tool: last.name, text: last.detail };
    } else if (last && age < CFG.toolStaleMs) {
      status = 'working';
      activity = { kind: 'tool', tool: last.name, text: last.detail };
    } else if (last && age < 6 * 3600e3) {
      status = 'waiting';
      activity = { kind: 'permission', tool: last.name, text: last.detail };
    } else if (['prompt', 'tool_result', 'thinking', 'text'].includes(this.lastKind) &&
               age < CFG.thinkingStaleMs) {
      status = 'thinking';
      activity = { kind: 'thinking', text: this.lastKind === 'text' ? this.lastText : this.prompt };
    } else if (this.waitReason && age < 6 * 3600e3) {
      status = 'waiting';
      activity = { kind: 'question', text: this.waitReason };
    }
    // real-time hook overlay (Claude Code hooks, push API)
    const h = this.hook;
    if (h && h.ts >= this.lastTs - 1500 && now - h.ts < 6 * 3600e3) {
      if (h.status === 'working' && now - h.ts > CFG.toolStaleMs) {
        // keep file-derived status
      } else if (h.status === 'thinking' && now - h.ts > CFG.thinkingStaleMs) {
        // stale
      } else {
        status = h.status;
        activity = { kind: h.kind || h.status, tool: h.tool, text: h.detail || activity.text };
      }
    }
    if (status === 'idle' && age > CFG.sleepAfterMs) status = 'sleeping';
    return { status, activity };
  }

  spark(now) {
    const bins = new Array(12).fill(0);
    for (const t of this.times) {
      const k = Math.floor((now - t) / (5 * 60e3));
      if (k >= 0 && k < 12) bins[11 - k]++;
    }
    return bins;
  }

  snapshot(now) {
    const { status, activity } = this.derive(now);
    return {
      id: this.id,
      platform: this.platform,
      name: this.name || this.project.split(/[\\/]/).filter(Boolean).pop() || this.platform,
      title: this.title,
      project: this.project,
      model: this.model,
      status,
      activity,
      prompt: this.prompt,
      lastText: this.lastText,
      lastActive: this.lastTs,
      startedAt: this.startedAt,
      counts: { tools: this.tools, turns: this.turns, tokens: this.tokens },
      recent: this.events.slice(-14),
      spark: this.spark(now),
      ...this.extra,
    };
  }
}
