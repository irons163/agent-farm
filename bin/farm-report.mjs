#!/usr/bin/env node
// Report an agent's status to Agent Farm from any script or language.
//   node bin/farm-report.mjs --id my-bot --platform openai --status working --tool search --detail "order #1932"
// Flags: --id (required) --name --platform --model --status --tool --detail --task --project --tokens --animal
// Env:   FARM_URL (default http://127.0.0.1:5180), FARM_TOKEN
const args = process.argv.slice(2);
const body = {};
for (let i = 0; i < args.length; i++) {
  const m = args[i].match(/^--([a-z-]+)(?:=(.*))?$/);
  if (!m) continue;
  const v = m[2] ?? args[++i];
  body[m[1]] = m[1] === 'tokens' ? Number(v) : v;
}
if (!body.id) {
  console.error('usage: farm-report --id <agent-id> [--status working|thinking|waiting|error|idle|sleeping|offline] [--platform openai] [--tool name] [--detail text]');
  process.exit(2);
}
const url = (process.env.FARM_URL || 'http://127.0.0.1:5180') + '/api/report';
const headers = { 'content-type': 'application/json' };
if (process.env.FARM_TOKEN) headers.authorization = `Bearer ${process.env.FARM_TOKEN}`;
try {
  const r = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body), signal: AbortSignal.timeout(3000) });
  const j = await r.json();
  if (!r.ok) throw new Error(j.error || r.statusText);
  console.log('ok', j.id || '');
} catch (e) {
  console.error('farm-report failed:', e.message);
  process.exit(1);
}
