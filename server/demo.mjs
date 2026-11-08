// Simulated agents so the farm is lively even with nothing running (demo mode).
import { Session } from './session.mjs';

const CAST = [
  { platform: 'claude-code', project: 'shop-frontend', model: 'claude-opus-5-5', task: '重構結帳流程並補上測試' },
  { platform: 'codex', project: 'data-pipeline', model: 'gpt-6.1', task: 'Fix flaky ETL job and add retries' },
  { platform: 'gemini-cli', project: 'docs-site', model: 'gemini-3-pro', task: '把文件翻成英文並更新截圖' },
  { platform: 'cursor', project: 'mobile-app', model: 'cursor-agent', task: 'Implement offline sync for notes' },
  { platform: 'claude-code', project: 'infra', model: 'claude-sonnet-5-5', task: '升級 Terraform 模組並檢查 drift' },
  { platform: 'opencode', project: 'cli-tool', model: 'qwen3-coder', task: 'Add shell completions' },
  { platform: 'ollama', project: 'local model', model: 'llama3.3:70b', task: 'Summarise meeting notes' },
  { platform: 'openai', project: 'support-bot', model: 'gpt-6-mini', task: '回覆客服工單分類' },
  { platform: 'deepseek', project: 'ml-notebook', model: 'deepseek-v4', task: 'Tune the ranking model' },
];

const TOOLS = {
  'claude-code': [['Read', 'checkout.tsx'], ['Grep', 'useCart'], ['Edit', 'checkout.tsx'], ['Bash', 'npm test'], ['Write', 'checkout.test.tsx'], ['Bash', 'git diff --stat'], ['WebFetch', 'docs.stripe.com']],
  codex: [['shell', 'pytest -q tests/etl'], ['apply_patch', 'etl/jobs.py'], ['shell', 'rg retry'], ['web.search', 'airflow retry exponential']],
  'gemini-cli': [['read_file', 'index.md'], ['replace', 'getting-started.md'], ['run_shell_command', 'npm run build'], ['google_web_search', 'astro i18n routing']],
  cursor: [['Read', 'sync.ts'], ['Edit', 'sync.ts'], ['Shell', 'pnpm test sync'], ['Grep', 'IndexedDB']],
  opencode: [['read', 'main.go'], ['edit', 'completion.go'], ['bash', 'go test ./...']],
  ollama: [['generate', 'llama3.3:70b']],
  openai: [['classify_ticket', '#4821'], ['lookup_order', 'A-1932'], ['draft_reply', '退款流程']],
  deepseek: [['python', 'train.py --epochs 3'], ['read', 'metrics.csv'], ['python', 'eval.py']],
};

const rnd = (a, b) => a + Math.random() * (b - a);
const pick = (a) => a[Math.floor(Math.random() * a.length)];

export class Demo {
  constructor() {
    this.sessions = [];
    this.t0 = Date.now();
    CAST.forEach((c, i) => {
      const s = new Session(`demo:${i}`, c.platform);
      s.project = `~/demo/${c.project}`;
      s.name = c.project;
      s.model = c.model;
      s.title = c.task;
      s.extra.demo = true;
      const start = Date.now() - rnd(2, 50) * 60e3;
      s.startedAt = start;
      s.tools = Math.floor(rnd(0, 70));
      s.turns = Math.floor(rnd(1, 9));
      s.tokens = Math.floor(rnd(2e3, 9e4));
      for (let k = 0; k < 40; k++) s.times.push(Date.now() - rnd(0, 60) * 60e3);
      s.lastTs = Date.now() - rnd(0, 20e3);
      this.sessions.push({ s, c, next: Date.now() + rnd(0, 4000), phase: 'start', step: 0 });
    });
    // a couple start asleep / waiting so every state shows up at once
    this.sessions[6].phase = 'sleep';
    this.sessions[6].next = Date.now() + 60e3;
    this.set(this.sessions[6], 'sleeping', null, '');
    this.sessions[3].phase = 'wait';
    this.set(this.sessions[3], 'waiting', 'Edit', 'sync.ts — 需要你核准修改', 'permission');
    this.sessions[3].next = Date.now() + 25e3;
  }

  set(a, status, tool, detail, kind) {
    const now = Date.now();
    a.s.hook = { status, tool: tool || undefined, detail, kind: kind || (tool ? 'tool' : status), ts: now };
    a.s.touch(now);
    if (status === 'working') {
      a.s.tools++;
      a.s.tokens += Math.floor(rnd(80, 900));
      a.s.log(now, 'tool', `${tool} · ${detail}`);
    } else if (status === 'waiting') a.s.log(now, 'wait', detail);
    else if (status === 'idle') a.s.log(now, 'reply', detail);
    else if (status === 'error') a.s.log(now, 'error', detail);
  }

  tick(now) {
    for (const a of this.sessions) {
      if (now < a.next) continue;
      const tools = TOOLS[a.c.platform] || TOOLS.codex;
      switch (a.phase) {
        case 'start':
        case 'sleep':
        case 'idle':
          a.s.turns++;
          a.s.log(now, 'prompt', a.c.task);
          a.s.prompt = a.c.task;
          this.set(a, 'thinking', null, a.c.task);
          a.phase = 'think';
          a.step = Math.floor(rnd(3, 7));
          a.next = now + rnd(3e3, 7e3);
          break;
        case 'think': {
          const [tool, detail] = pick(tools);
          this.set(a, 'working', tool, detail);
          a.phase = 'tool';
          a.next = now + rnd(3e3, 11e3);
          break;
        }
        case 'tool':
          a.step--;
          if (a.step <= 0) {
            const r = Math.random();
            if (r < 0.28) {
              this.set(a, 'waiting', 'AskUserQuestion', pick(['要用哪個資料庫？', 'Ship it to staging?', '需要你核准 git push', 'Which API version should I target?']), 'question');
              a.phase = 'wait';
              a.next = now + rnd(20e3, 45e3);
            } else if (r < 0.36) {
              this.set(a, 'error', null, pick(['Rate limit reached (429)', 'Tests failed: 3 errors', 'Context window exceeded']));
              a.phase = 'err';
              a.next = now + rnd(12e3, 20e3);
            } else {
              this.set(a, 'idle', null, pick(['完成！所有測試通過 ✅', 'Done — opened a PR.', '已更新文件並重新建置', 'Finished. 3 files changed.']));
              a.phase = Math.random() < 0.35 ? 'nap' : 'idle';
              a.next = now + (a.phase === 'nap' ? rnd(8e3, 14e3) : rnd(18e3, 40e3));
            }
          } else {
            this.set(a, 'thinking', null, '');
            a.phase = 'think';
            a.next = now + rnd(2e3, 5e3);
          }
          break;
        case 'nap':
          this.set(a, 'sleeping', null, '');
          a.phase = 'sleep';
          a.next = now + rnd(40e3, 90e3);
          break;
        case 'wait':
        case 'err':
          a.s.log(now, 'prompt', 'OK, go ahead');
          this.set(a, 'thinking', null, 'OK, go ahead');
          a.phase = 'think';
          a.step = Math.floor(rnd(2, 4));
          a.next = now + rnd(2e3, 4e3);
          break;
        default:
          a.phase = 'idle';
      }
    }
    return this.sessions.map((a) => a.s);
  }
}
