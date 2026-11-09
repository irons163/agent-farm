// Smoke test for an installed/unpacked desktop app: starts it, waits for the farm to answer, then
// kills it hard and checks the farm server goes away with it (the "app crashed" path).
//   node desktop/smoke-test.mjs <app executable> [app args...]
// Uses its own port so it can run next to a real farm. Exit code 0 = pass.
import { spawn } from 'node:child_process';

const [cmd, ...args] = process.argv.slice(2);
if (!cmd) { console.error('usage: node desktop/smoke-test.mjs <app executable> [args...]'); process.exit(2); }

const PORT = 5390;
const URL_ = `http://127.0.0.1:${PORT}`;
const sleep = (ms) => new Promise((ok) => setTimeout(ok, ms));
const get = async (p) => {
  try { return await fetch(URL_ + p, { signal: AbortSignal.timeout(2000) }); } catch { return null; }
};

let output = '';
const child = spawn(cmd, args, {
  env: { ...process.env, FARM_PORT_START: String(PORT), FARM_DEMO: 'on' },
  stdio: ['ignore', 'pipe', 'pipe'],
});
child.stdout.on('data', (d) => { output += d; });
child.stderr.on('data', (d) => { output += d; });
let exited = null;
child.on('exit', (code, sig) => { exited = `${code ?? sig}`; });
child.on('error', (e) => { output += `spawn error: ${e.message}\n`; exited = 'spawn error'; });

const fail = (msg) => {
  console.error(`✖ ${msg}`);
  if (output.trim()) console.error('--- app output ---\n' + output.trim().slice(-4000));
  try { child.kill('SIGKILL'); } catch { /* already gone */ }
  process.exit(1);
};

// 1. the farm comes up (Electron starts the bundled Node, which runs server/server.mjs)
let health = null;
for (let i = 0; i < 90 && !health; i++) {
  if (exited) fail(`the app exited early (${exited}) before the farm answered`);
  const r = await get('/api/health');
  if (r?.ok && (await r.json()).ok === true) health = true;
  else await sleep(1000);
}
if (!health) fail('the farm did not answer /api/health within 90 s');
console.log('✔ /api/health ok');

// 2. the web app is served
const page = await get('/');
if (!page?.ok || !(await page.text()).includes('<html')) fail('GET / did not return the web app');
const scene = await get('/assets/scene.json');
if (!scene?.ok) fail('assets/scene.json is missing from the package');
console.log('✔ web app and assets served');

// 3. the state stream works
const state = await get('/api/state');
if (state && !state.ok) fail(`/api/state answered ${state.status}`);
console.log('✔ state ok');

// 4. kill the app without letting it clean up: the server must notice and exit
child.kill('SIGKILL');
let gone = false;
for (let i = 0; i < 20 && !gone; i++) {
  await sleep(1000);
  gone = (await get('/api/health')) === null;
}
if (!gone) fail('the farm server kept running after the app was killed');
console.log('✔ server stopped with the app');
process.exit(0);
