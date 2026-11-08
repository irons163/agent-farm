#!/usr/bin/env node
// Agent Farm server: serves the web app and streams live agent status (SSE).
//   node server/server.mjs            -> http://127.0.0.1:5180
// Env: PORT, HOST, FARM_TOKEN (required when HOST is not loopback; open the farm once
//      with /?token=<FARM_TOKEN> to get a cookie), FARM_DEMO=auto|on|off,
//      FARM_WINDOW_HOURS, FARM_SLEEP_MIN, FARM_COLLECTORS
import crypto from 'node:crypto';
import http from 'node:http';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// node:sqlite (OpenCode collector) prints an experimental warning; keep the log clean
const emit = process.emitWarning;
process.emitWarning = (w, ...a) => {
  if (String(w).includes('SQLite')) return;
  return emit.call(process, w, ...a);
};

const { Farm } = await import('./farm.mjs');

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WEB = path.resolve(HERE, '..', 'web');
const PORT = Number(process.env.PORT || 5180);
const HOST = process.env.HOST || '127.0.0.1';
const TOKEN = process.env.FARM_TOKEN || '';
const LOOPBACK = ['127.0.0.1', 'localhost', '::1'].includes(HOST);
const TICK = 1500;

if (!LOOPBACK && !TOKEN) {
  // the state stream contains prompts and project paths: never serve it to a network unauthenticated
  console.error(`\n  ✖ HOST=${HOST} is reachable from other machines. Set FARM_TOKEN to a long random string, e.g.\n` +
    `    FARM_TOKEN=$(openssl rand -hex 24) HOST=${HOST} npm start\n`);
  process.exit(1);
}

const farm = new Farm({ dataDir: path.resolve(HERE, '..', 'data') });

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png',
  '.webp': 'image/webp', '.jpg': 'image/jpeg', '.ico': 'image/x-icon', '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8', '.md': 'text/markdown; charset=utf-8',
};

const clients = new Set();
let lastPayload = '';

function send(res, code, obj, headers = {}) {
  const body = typeof obj === 'string' ? obj : JSON.stringify(obj);
  res.writeHead(code, { ...SECURITY_HEADERS, 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...headers });
  res.end(body);
}

async function readBody(req, limit = 64 * 1024) {
  let size = 0;
  const chunks = [];
  for await (const c of req) {
    size += c.length;
    if (size > limit) throw new Error('body too large');
    chunks.push(c);
  }
  const raw = Buffer.concat(chunks).toString('utf8');
  return raw ? JSON.parse(raw) : {};
}

const SECURITY_HEADERS = {
  'x-content-type-options': 'nosniff',
  'x-frame-options': 'DENY',
  'referrer-policy': 'no-referrer',
  'cross-origin-resource-policy': 'same-origin',
};
const CSP = ["default-src 'self'", "script-src 'self'",
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com", 'font-src https://fonts.gstatic.com',
  "img-src 'self'", "connect-src 'self'", "object-src 'none'", "base-uri 'none'", "form-action 'self'",
  "frame-ancestors 'none'"].join('; ');

const digest = (s) => crypto.createHash('sha256').update(String(s)).digest();
const TOKEN_HASH = TOKEN ? digest(TOKEN) : null;
const tokenOk = (v) => !!(TOKEN_HASH && v) && crypto.timingSafeEqual(digest(v), TOKEN_HASH);
const COOKIE = 'farm_token';

function cookie(req, name) {
  for (const part of String(req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === name) {
      try {
        return decodeURIComponent(part.slice(i + 1).trim());
      } catch {
        return '';
      }
    }
  }
  return '';
}

// DNS rebinding: a web page can point its own hostname at 127.0.0.1, but it can't change the
// Host header, so on a loopback bind only loopback host names are served.
const LOOPBACK_HOST = /^(127\.0\.0\.1|localhost|[a-z0-9-]+\.localhost|\[::1\])(:\d+)?$/i;
function hostOk(req) {
  if (!LOOPBACK) return true; // non-loopback binds are protected by the token instead
  const h = req.headers.host;
  return !h || LOOPBACK_HOST.test(h);
}

// reads and writes of agent data: on loopback anything on this machine; on a network bind the token
function authorized(req) {
  if (TOKEN) {
    const h = req.headers.authorization || '';
    const bearer = h.startsWith('Bearer ') ? h.slice(7) : '';
    if (!(tokenOk(bearer) || tokenOk(req.headers['x-farm-token']) || tokenOk(cookie(req, COOKIE)))) return false;
  } else if (!LOOPBACK) return false;
  return true;
}

// browsers always send Origin on POST; a page from any other origin (another local dev server
// included) must not be able to change the farm. CLI tools and hooks send no Origin.
function sameOrigin(req) {
  const origin = req.headers.origin;
  if (!origin) return true;
  try {
    return new URL(origin).host === req.headers.host;
  } catch {
    return false;
  }
}

async function serveStatic(req, res, pathname) {
  let p;
  try {
    p = decodeURIComponent(pathname);
  } catch {
    return send(res, 400, { error: 'bad path' });
  }
  if (p.includes('\0')) return send(res, 400, { error: 'bad path' });
  if (p === '/') p = '/index.html';
  const file = path.resolve(WEB, '.' + p);
  if (!file.startsWith(WEB + path.sep)) return send(res, 403, { error: 'forbidden' });
  let st;
  try {
    st = await fsp.stat(file);
  } catch {
    return send(res, 404, { error: 'not found' });
  }
  if (st.isDirectory()) return send(res, 404, { error: 'not found' });
  const ext = path.extname(file).toLowerCase();
  const isAsset = file.includes(`${path.sep}assets${path.sep}`) && ext !== '.json';
  res.writeHead(200, {
    ...SECURITY_HEADERS,
    ...(ext === '.html' ? { 'content-security-policy': CSP } : {}),
    'content-type': MIME[ext] || 'application/octet-stream',
    'content-length': st.size,
    'cache-control': isAsset ? 'public, max-age=3600' : 'no-cache',
  });
  if (req.method === 'HEAD') return res.end();
  fs.createReadStream(file).on('error', () => res.destroy()).pipe(res);
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const p = url.pathname;
  try {
    if (!hostOk(req)) return send(res, 421, { error: 'unexpected host' });
    // network bind: /?token=… once, then a same-site cookie carries it (EventSource can't set headers)
    if (TOKEN && url.searchParams.has('token') && req.method === 'GET') {
      if (!tokenOk(url.searchParams.get('token'))) return send(res, 401, { error: 'bad token' });
      return send(res, 302, '', {
        location: p,
        'set-cookie': `${COOKIE}=${encodeURIComponent(TOKEN)}; HttpOnly; SameSite=Strict; Path=/; Max-Age=31536000`,
      });
    }
    if (p.startsWith('/api/') && !authorized(req)) return send(res, 401, { error: 'unauthorized' });
    if (p === '/api/state' && req.method === 'GET') return send(res, 200, farm.snapshot);
    if (p === '/api/health') return send(res, 200, { ok: true, agents: farm.snapshot.agents.length });
    if (p === '/api/stream' && req.method === 'GET') {
      if (clients.size >= 64) return send(res, 503, { error: 'too many viewers' });
      res.writeHead(200, {
        ...SECURITY_HEADERS,
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-store',
        connection: 'keep-alive',
        'x-accel-buffering': 'no',
      });
      res.write('retry: 2000\n\n');
      res.write(`event: state\ndata: ${JSON.stringify(farm.snapshot)}\n\n`);
      clients.add(res);
      req.on('close', () => clients.delete(res));
      return;
    }
    if (req.method === 'POST' && p.startsWith('/api/')) {
      if (!sameOrigin(req)) return send(res, 403, { error: 'cross-origin request blocked' });
      const body = await readBody(req);
      if (p === '/api/report') {
        const items = Array.isArray(body) ? body : [body];
        const out = items.map((b) => farm.report(b));
        await pump(true);
        return send(res, 200, out.length === 1 ? out[0] : out);
      }
      if (p === '/api/hook/claude') {
        const ok = farm.hookClaude(body);
        await pump(true);
        return send(res, 200, { ok });
      }
      if (p === '/api/settings') {
        farm.setSettings(body);
        await pump(true);
        return send(res, 200, { ok: true, showTemp: farm.showTemp });
      }
      if (p === '/api/demo') {
        farm.setDemo(String(body.mode || ''));
        await pump(true);
        return send(res, 200, { ok: true, mode: farm.demoMode });
      }
      return send(res, 404, { error: 'unknown endpoint' });
    }
    if (req.method === 'GET' || req.method === 'HEAD') return await serveStatic(req, res, p);
    return send(res, 405, { error: 'method not allowed' });
  } catch (e) {
    if (res.headersSent) return res.destroy();
    return send(res, 400, { error: String(e.message || e) });
  }
});
server.on('clientError', (err, socket) => socket.destroy());

let busy = false;
async function pump(force = false) {
  if (busy && !force) return;
  busy = true;
  try {
    const snap = await farm.tick();
    const { now, ...rest } = snap;
    const key = JSON.stringify(rest.agents.map((a) => [a.id, a.status, a.activity, a.counts, a.animal, a.plot, a.onFarm, a.lastActive])) +
      JSON.stringify(rest.demo);
    const payload = JSON.stringify(snap);
    if (force || key !== lastPayload) {
      lastPayload = key;
      for (const c of clients) c.write(`event: state\ndata: ${payload}\n\n`);
    }
  } catch (e) {
    console.error('[farm] tick failed:', e);
  } finally {
    busy = false;
  }
}

setInterval(pump, TICK);
setInterval(() => {
  for (const c of clients) c.write(`event: ping\ndata: ${Date.now()}\n\n`);
}, 15000);

await pump();
server.listen(PORT, HOST, () => {
  const n = farm.snapshot.agents.length;
  console.log(`\n  🌾 Agent Farm  →  http://${HOST === '0.0.0.0' ? 'localhost' : HOST}:${PORT}`);
  console.log(`     ${n} agent${n === 1 ? '' : 's'} found · collectors: ${farm.snapshot.collectors.filter((c) => c.found).map((c) => c.platform).join(', ') || 'none'}`);
  if (!LOOPBACK) console.log(`     open http://<this-machine>:${PORT}/?token=<FARM_TOKEN> once on each device`);
  console.log('');
});
