// Tiny i18n: 繁體中文 (default) + English
const DICT = {
  zh: {
    subtitle: 'AI 代理農場',
    members: '農場成員',
    f_all: '全部', f_attention: '需要你', f_busy: '忙碌', f_rest: '休息',
    loading: '正在整理農場…',
    offline: '與農場伺服器的連線中斷，重新連線中…',
    help_title: '連接你的 AI 平台',
    st_working: '工作中', st_thinking: '思考中', st_waiting: '等你回覆', st_error: '出錯了',
    st_idle: '待命中', st_sleeping: '休息中',
    chip_working: '工作中', chip_thinking: '思考中', chip_waiting: '需要你', chip_error: '出錯',
    chip_idle: '待命', chip_sleeping: '休息',
    just_now: '剛剛', min_ago: '{n} 分鐘前', hr_ago: '{n} 小時前', day_ago: '{n} 天前',
    tools: '{n} 次工具', turns: '{n} 輪', tokens: '{n} tokens',
    act_thinking: '思考中…', act_waiting: '等你回覆', act_permission: '等待授權', act_question: '有問題想問你',
    act_done: '完成了', act_sleep: '打個盹',
    bubble_waiting: '等你回覆', bubble_permission: '要授權', bubble_error: '出錯了', bubble_done: '完成！',
    kv_project: '專案', kv_model: '模型', kv_platform: '平台', kv_started: '開始', kv_tokens: '產出', kv_session: '工作階段', kv_branch: '分支', kv_plot: '菜圃',
    recent: '最近動態',
    no_agents: '農場還很安靜。<br>啟動 Claude Code、Codex、Cursor 或 Gemini CLI，牠們就會出現在這裡。',
    no_match: '這個分類目前沒有成員',
    in_barn: '在穀倉裡（農場最多 12 隻）',
    demo_on: '目前是<b>示範模式</b>：沒有偵測到正在工作的 agent，所以放了一些示範動物。',
    demo_forced: '已開啟示範模式。',
    demo_off_btn: '關閉示範', demo_on_btn: '開啟示範',
    toast_waiting: '{name} 需要你回覆',
    toast_error: '{name} 出錯了',
    toast_done: '{name} 完成工作了',
    plot_crop: { carrot: '紅蘿蔔', cabbage: '高麗菜', pumpkin: '南瓜', sunflower: '向日葵', strawberry: '草莓', corn: '玉米' },
    help_detected: '已偵測的平台',
    help_auto: '這些平台會自動讀取本機紀錄（唯讀，不會修改任何檔案、不會上傳）。',
    found: '已連接', sessions: '{n} 個工作階段', not_found: '未偵測到',
    help_push: '其他平台：用 HTTP 回報狀態',
    help_push_p: 'OpenAI Agents SDK、LangGraph、AutoGen、Ollama 腳本、你自己的機器人……任何程式都可以用一行請求把狀態送進農場：',
    help_hooks: 'Claude Code 即時掛鉤（選用）',
    help_hooks_p: '預設已經從對話紀錄判斷狀態；加上 hooks 後「等待授權」這類狀態會即時、準確地顯示。把下面這段加進 ~/.claude/settings.json：',
    help_update: '檢查更新',
    help_update_p: 'Agent Farm 不會自己連網檢查版本；想知道有沒有新版，請自己點開發行頁面。',
    help_demo: '示範模式',
    help_demo_p: '沒有 agent 在工作時自動放示範動物（自動），或強制開關。',
    mode_auto: '自動', mode_on: '開', mode_off: '關',
    help_legend: '狀態說明',
    legend_text: '🌱 工作中 → 在自己的菜圃幹活（做越多事，作物長越大）　💭 思考中 → 站在菜圃旁想事情　❗ 需要你 → 跑到農舍門廊等你　✅ 待命 → 在草地上散步　💤 休息 → 回到穀倉旁睡覺',
    theme_auto: '自動（依時間）', theme_day: '白天', theme_night: '夜晚',
    zoom_hint: '滾輪縮放、拖曳移動、點動物看細節',
    temp_badge: '臨時',
    temp_tmpdir: '在暫存資料夾裡執行（通常是腳本或別的 agent 叫起來的）',
    temp_oneshot: '只問一句、沒用任何工具的一次性工作階段，結束 {n} 分鐘後自動消失',
    help_temp: '臨時工作階段',
    help_temp_p: '在暫存資料夾（/tmp、/var/folders）裡跑的，或只問一句就結束的一次性工作階段，會標上「臨時」、排在最後，不會搶真實 agent 的動物和菜圃；一次性的結束 {n} 分鐘後自動消失。保持顯示可以看到某個 agent 偷偷叫了別的 agent。',
    temp_show: '顯示', temp_hide: '隱藏', temp_now: '目前 {n} 個',
  },
  en: {
    subtitle: 'Your AI agents, on a farm',
    members: 'Farm members',
    f_all: 'All', f_attention: 'Needs you', f_busy: 'Busy', f_rest: 'Resting',
    loading: 'Tidying up the farm…',
    offline: 'Lost connection to the farm server — reconnecting…',
    help_title: 'Connect your AI platforms',
    st_working: 'Working', st_thinking: 'Thinking', st_waiting: 'Needs you', st_error: 'Error',
    st_idle: 'Idle', st_sleeping: 'Sleeping',
    chip_working: 'Working', chip_thinking: 'Thinking', chip_waiting: 'Needs you', chip_error: 'Error',
    chip_idle: 'Idle', chip_sleeping: 'Sleeping',
    just_now: 'just now', min_ago: '{n}m ago', hr_ago: '{n}h ago', day_ago: '{n}d ago',
    tools: '{n} tools', turns: '{n} turns', tokens: '{n} tokens',
    act_thinking: 'Thinking…', act_waiting: 'Waiting for you', act_permission: 'Needs permission', act_question: 'Has a question',
    act_done: 'Done', act_sleep: 'Taking a nap',
    bubble_waiting: 'Needs you', bubble_permission: 'Approve?', bubble_error: 'Error', bubble_done: 'Done!',
    kv_project: 'Project', kv_model: 'Model', kv_platform: 'Platform', kv_started: 'Started', kv_tokens: 'Output', kv_session: 'Session', kv_branch: 'Branch', kv_plot: 'Plot',
    recent: 'Recent activity',
    no_agents: 'The farm is quiet.<br>Start Claude Code, Codex, Cursor or Gemini CLI and they will show up here.',
    no_match: 'Nobody in this group right now',
    in_barn: 'In the barn (max 12 on the farm)',
    demo_on: '<b>Demo mode</b>: no busy agents detected, so a few demo animals are out.',
    demo_forced: 'Demo mode is on.',
    demo_off_btn: 'Turn demo off', demo_on_btn: 'Turn demo on',
    toast_waiting: '{name} needs you',
    toast_error: '{name} hit an error',
    toast_done: '{name} finished',
    plot_crop: { carrot: 'Carrots', cabbage: 'Cabbages', pumpkin: 'Pumpkins', sunflower: 'Sunflowers', strawberry: 'Strawberries', corn: 'Corn' },
    help_detected: 'Detected platforms',
    help_auto: 'These are read automatically from local session logs (read-only, nothing is uploaded).',
    found: 'connected', sessions: '{n} sessions', not_found: 'not found',
    help_push: 'Anything else: report over HTTP',
    help_push_p: 'OpenAI Agents SDK, LangGraph, AutoGen, Ollama scripts, your own bots… anything can post its status with one request:',
    help_hooks: 'Claude Code live hooks (optional)',
    help_hooks_p: 'Status already comes from the transcripts; hooks make states like “waiting for permission” instant and exact. Add this to ~/.claude/settings.json:',
    help_update: 'Check for updates',
    help_update_p: 'Agent Farm never checks for new versions by itself (it makes no network requests). To see if there is one, open the releases page.',
    help_demo: 'Demo mode',
    help_demo_p: 'Show demo animals when nothing is working (auto), or force it on/off.',
    mode_auto: 'Auto', mode_on: 'On', mode_off: 'Off',
    help_legend: 'What the animals mean',
    legend_text: '🌱 Working → tending its own plot (the more it does, the bigger the crops)  💭 Thinking → standing by its plot  ❗ Needs you → waiting at the farmhouse porch  ✅ Idle → strolling the meadow  💤 Sleeping → napping by the barn',
    theme_auto: 'Auto (by time)', theme_day: 'Day', theme_night: 'Night',
    zoom_hint: 'Scroll to zoom, drag to pan, click an animal for details',
    temp_badge: 'Temp',
    temp_tmpdir: 'Runs from a temp folder (usually a script or another agent started it)',
    temp_oneshot: 'One prompt, no tools — a one-shot session; it disappears {n} min after it ends',
    help_temp: 'Temporary sessions',
    help_temp_p: 'Sessions run from a temp folder (/tmp, /var/folders) or one-shot sessions (one prompt, no tools) are tagged “Temp”, listed last and never take an animal or plot from a real agent; one-shots vanish {n} min after they end. Keeping them visible lets you notice when an agent quietly starts other agents.',
    temp_show: 'Show', temp_hide: 'Hide', temp_now: '{n} right now',
  },
};

let lang = (() => {
  const q = new URLSearchParams(location.search).get('lang');
  if (q === 'zh' || q === 'en') return q;
  try {
    const s = localStorage.getItem('farm.lang');
    if (s) return s;
  } catch { /* storage blocked */ }
  return /^zh/i.test(navigator.language || '') ? 'zh' : 'en';
})();

export function getLang() { return lang; }
export function setLang(l) {
  lang = l;
  try { localStorage.setItem('farm.lang', l); } catch { /* ignore */ }
  document.documentElement.lang = l === 'zh' ? 'zh-Hant' : 'en';
  applyStatic();
}

export function t(key, vars) {
  let s = DICT[lang][key] ?? DICT.en[key] ?? key;
  if (vars && typeof s === 'string') for (const [k, v] of Object.entries(vars)) s = s.replace(`{${k}}`, v);
  return s;
}

export function applyStatic() {
  document.querySelectorAll('[data-i18n]').forEach((el) => { el.innerHTML = t(el.dataset.i18n); });
}

export function ago(ms, now = Date.now()) {
  const d = Math.max(0, now - ms);
  if (d < 45e3) return t('just_now');
  if (d < 3600e3) return t('min_ago', { n: Math.round(d / 60e3) });
  if (d < 86400e3) return t('hr_ago', { n: Math.round(d / 3600e3) });
  return t('day_ago', { n: Math.round(d / 86400e3) });
}

export function fmtNum(n) {
  if (!n) return '0';
  if (n >= 1e6) return (n / 1e6).toFixed(1).replace(/\.0$/, '') + 'M';
  if (n >= 1e3) return (n / 1e3).toFixed(1).replace(/\.0$/, '') + 'k';
  return String(n);
}
