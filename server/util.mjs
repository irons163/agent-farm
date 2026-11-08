import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

export const HOME = os.homedir();

export function ts(v) {
  if (v == null) return 0;
  if (typeof v === 'number') return v < 1e12 ? v * 1000 : v;
  const t = Date.parse(v);
  return Number.isNaN(t) ? 0 : t;
}

export async function exists(p) {
  try {
    await fsp.access(p);
    return true;
  } catch {
    return false;
  }
}

export async function statSafe(p) {
  try {
    return await fsp.stat(p);
  } catch {
    return null;
  }
}

export async function listDir(p) {
  try {
    return await fsp.readdir(p, { withFileTypes: true });
  } catch {
    return [];
  }
}

export async function realDir(p) {
  try {
    return await fsp.realpath(p);
  } catch {
    return p;
  }
}

/** Incrementally reads appended JSON lines from a growing file. */
export class JsonlTail {
  constructor(file, initialBytes = 768 * 1024) {
    this.file = file;
    this.initialBytes = initialBytes;
    this.offset = -1;
    this.rest = '';
    this.mtime = 0;
    this.size = 0;
  }

  async read(st) {
    st = st || (await statSafe(this.file));
    if (!st) return [];
    this.mtime = st.mtimeMs;
    let start;
    let skipFirst = false;
    if (this.offset < 0 || st.size < this.offset) {
      start = Math.max(0, st.size - this.initialBytes);
      skipFirst = start > 0;
      this.rest = '';
    } else {
      start = this.offset;
    }
    if (st.size <= start) {
      this.offset = st.size;
      return [];
    }
    const len = Math.min(st.size - start, 8 * 1024 * 1024);
    const fh = await fsp.open(this.file, 'r');
    let text;
    try {
      const buf = Buffer.alloc(len);
      await fh.read(buf, 0, len, start);
      text = buf.toString('utf8');
    } finally {
      await fh.close();
    }
    this.offset = start + len;
    this.size = st.size;
    text = this.rest + text;
    const lines = text.split('\n');
    this.rest = lines.pop() || '';
    if (skipFirst) lines.shift();
    const out = [];
    for (const l of lines) {
      if (!l || l[0] !== '{') continue;
      try {
        out.push(JSON.parse(l));
      } catch {
        /* partial or binary line */
      }
    }
    return out;
  }
}

export async function readHead(file, bytes = 48 * 1024) {
  try {
    const fh = await fsp.open(file, 'r');
    try {
      const buf = Buffer.alloc(bytes);
      const { bytesRead } = await fh.read(buf, 0, bytes, 0);
      return buf.subarray(0, bytesRead).toString('utf8');
    } finally {
      await fh.close();
    }
  } catch {
    return '';
  }
}

export function headObjects(text) {
  const out = [];
  for (const l of text.split('\n')) {
    if (!l || l[0] !== '{') continue;
    try {
      out.push(JSON.parse(l));
    } catch {
      /* cut line */
    }
  }
  return out;
}

const base = (p) => (p ? String(p).split(/[\\/]/).filter(Boolean).pop() : '');

export function toolDetail(name, input) {
  if (!input || typeof input !== 'object') {
    if (typeof input === 'string') return input.split('\n')[0];
    return '';
  }
  const n = String(name || '');
  if (/^(Bash|shell|exec_command|run_shell_command|Shell|local_shell)$/i.test(n)) {
    const c = input.description || input.command || input.cmd;
    return Array.isArray(c) ? c.slice(-1)[0] : String(c || '').split('\n')[0];
  }
  if (input.file_path || input.path || input.notebook_path || input.target_file || input.absolute_path) {
    return base(input.file_path || input.path || input.notebook_path || input.target_file ||
                input.absolute_path);
  }
  if (input.pattern || input.glob_pattern) return String(input.pattern || input.glob_pattern);
  if (input.url) {
    try {
      return new URL(input.url).host;
    } catch {
      return String(input.url);
    }
  }
  if (input.query) return String(input.query);
  if (input.description) return String(input.description);
  if (input.title) return String(input.title);
  if (input.prompt) return String(input.prompt).split('\n')[0];
  if (Array.isArray(input.questions) && input.questions[0]) {
    const q = input.questions[0];
    return String(q.question || q.title || q.header || '');
  }
  for (const v of Object.values(input)) if (typeof v === 'string' && v.length < 200) return v;
  return '';
}

export function textOf(content) {
  if (content == null) return '';
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((c) => (typeof c === 'string' ? c : c && (c.text ?? c.input_text ?? '')))
      .filter(Boolean)
      .join(' ');
  }
  if (typeof content === 'object' && content.text) return content.text;
  return '';
}

/** Turn a dash-flattened path slug (e.g. "Volumes-M2SSD-Documents-My-App") back into a real path. */
const slugCache = new Map();
export function resolveSlug(slug) {
  if (slugCache.has(slug)) return slugCache.get(slug);
  const parts = slug.replace(/^-+/, '').split('-').filter((x) => x !== '');
  let best = '';
  const walk = (dir, i) => {
    if (i >= parts.length) {
      best = dir;
      return true;
    }
    for (let j = parts.length; j > i; j--) {
      for (const sep of ['-', '.', '_', ' ']) {
        const name = parts.slice(i, j).join(sep);
        const p = path.join(dir, name);
        if (fs.existsSync(p)) {
          if (walk(p, j)) return true;
        }
        if (j === i + 1) break;
      }
    }
    return false;
  };
  try {
    if (process.platform === 'win32' && /^[a-z]$/i.test(parts[0] || '')) walk(`${parts[0].toUpperCase()}:\\`, 1);
    else walk('/', 0);
  } catch {
    /* ignore */
  }
  const out = best || '/' + parts.join('/');
  slugCache.set(slug, out);
  return out;
}

export function stripTags(s) {
  return String(s || '')
    .replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, ' ')
    .replace(/<[^>]{1,40}>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}
