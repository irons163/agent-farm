#!/usr/bin/env node
// Claude Code hook → Agent Farm. Forwards hook events so the farm shows
// "waiting for permission", tool use and turn ends the instant they happen.
// Never blocks Claude: always exits 0 within ~1.5 s, even if the farm is down.
// Configure in ~/.claude/settings.json (see README or the farm's help dialog).
// farm address: --url http://127.0.0.1:5181 (or FARM_URL); default port 5180
const ui = process.argv.indexOf('--url');
const url = ((ui > 0 && process.argv[ui + 1]) || process.env.FARM_URL || 'http://127.0.0.1:5180').replace(/\/$/, '') +
  '/api/hook/claude';
let raw = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (c) => { raw += c; });
process.stdin.on('end', async () => {
  try {
    const e = JSON.parse(raw || '{}');
    // only forward what the farm needs (no tool outputs or file contents)
    const body = {
      session_id: e.session_id, transcript_path: e.transcript_path, cwd: e.cwd,
      hook_event_name: e.hook_event_name, tool_name: e.tool_name,
      tool_input: e.tool_input && typeof e.tool_input === 'object'
        ? Object.fromEntries(Object.entries(e.tool_input).filter(([k, v]) => typeof v === 'string' && v.length < 400 && /path|command|description|pattern|url|query|prompt/.test(k)))
        : undefined,
      message: e.message, notification_type: e.notification_type,
      prompt: typeof e.prompt === 'string' ? e.prompt.slice(0, 300) : undefined,
    };
    const headers = { 'content-type': 'application/json' };
    if (process.env.FARM_TOKEN) headers.authorization = `Bearer ${process.env.FARM_TOKEN}`;
    await fetch(url, { method: 'POST', headers, body: JSON.stringify(body), signal: AbortSignal.timeout(1200) });
  } catch { /* farm not running: ignore */ }
  process.exit(0);
});
