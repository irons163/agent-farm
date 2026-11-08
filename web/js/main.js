import { World, TOOL_ICON, cropStage, prettyTool } from './world.js';
import { t, setLang, getLang, applyStatic, ago, fmtNum } from './i18n.js';

const $ = (s) => document.querySelector(s);
const app = $('#app');
const STATUSES = ['working', 'thinking', 'waiting', 'error', 'idle', 'sleeping'];
const FILTERS = {
  all: () => true,
  attention: (a) => a.status === 'waiting' || a.status === 'error',
  busy: (a) => a.status === 'working' || a.status === 'thinking',
  rest: (a) => a.status === 'idle' || a.status === 'sleeping',
};
const KIND_ICON = { prompt: '🗣️', reply: '💬', say: '💬', wait: '❗', error: '⚠️', done: '✅', stop: '⏹️', warn: '⚠️' };

const store = {
  get(k, d) {
    try { return localStorage.getItem(k) ?? d; } catch { return d; }
  },
  set(k, v) {
    try { localStorage.setItem(k, v); } catch { /* ignore */ }
  },
};

let manifest;
let world;
let state = { agents: [], platforms: {}, collectors: [], demo: {}, config: {} };
let selected = null;
let filter = 'all';
let chipFilter = null;
let themePref = store.get('farm.theme', 'auto');
let firstState = true;
const prev = new Map();
const cardEls = new Map();
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// ------------------------------------------------------------------ boot
async function boot() {
  setLang(getLang());
  $('#btn-lang').textContent = getLang() === 'zh' ? 'EN' : '中';
  makeSky();
  try {
    manifest = await fetch('assets/scene.json', { cache: 'no-cache' }).then((r) => r.json());
  } catch (e) {
    $('#loading p').textContent = 'assets/scene.json missing — run `npm run render` first.';
    return;
  }
  world = new World(manifest, {
    viewport: $('#viewport'), world: $('#world'), bgDay: $('#bg-day'), bgNight: $('#bg-night'),
    stage: $('#stage'), groundFx: $('#ground-fx'), airFx: $('#air-fx'), labels: $('#labels'),
    shadow: $('#island-shadow'),
  }, { select: selectAgent, hover: showTooltip, t, frame: () => {} });
  if (window.innerWidth <= 860) app.classList.add('panel-closed');
  updateInset();
  applyTheme();
  await world.load();
  bindUi();
  connect();
  setInterval(tickClock, 10e3);
  setInterval(() => renderPanel(), 30e3);
  tickClock();
  setTimeout(() => {
    $('#loading').classList.add('done');
    app.classList.remove('preload');
  }, 250);
}

// ------------------------------------------------------------------ data
function connect() {
  let es;
  let offlineTimer;
  const open = () => {
    es = new EventSource('api/stream');
    es.addEventListener('state', (e) => {
      clearTimeout(offlineTimer);
      $('#offline').hidden = true;
      onState(JSON.parse(e.data));
    });
    es.onerror = () => {
      clearTimeout(offlineTimer);
      offlineTimer = setTimeout(() => { $('#offline').hidden = false; }, 2500);
    };
  };
  open();
}

function onState(s) {
  state = s;
  const agents = s.agents || [];
  world.setAgents(agents);
  if (!firstState) notifyTransitions(agents);
  for (const a of agents) prev.set(a.id, a.status);
  firstState = false;
  renderChips();
  renderPanel();
  renderLegend();
  const need = agents.filter((a) => a.status === 'waiting').length;
  document.title = `${need ? `(${need}) ` : ''}Agent Farm · ${t('subtitle')}`;
  if (selected && !agents.some((a) => a.id === selected)) selectAgent(null);
  if ($('#help').open) renderHelp();
}

// ------------------------------------------------------------------ ui pieces
function statusLabel(s) {
  return t(`st_${s}`);
}

function animalName(a) {
  const n = manifest.animals?.[a.animal]?.name;
  return n ? (getLang() === 'zh' ? n.zh : n.en) : '';
}

function avatarSrc(a) {
  const f = manifest.animals?.[a.animal]?.frames;
  return f ? `assets/${f.se_idle}` : '';
}

function activityHtml(a) {
  const act = a.activity || {};
  const text = act.text ? esc(act.text) : '';
  switch (a.status) {
    case 'working':
      return `<span class="tool">${TOOL_ICON(act.tool)} ${esc(prettyTool(act.tool))}</span>${text ? ` · ${text}` : ''}`;
    case 'thinking':
      return `💭 ${text || esc(t('act_thinking'))}`;
    case 'waiting':
      return `❗ <span class="tool">${esc(t(act.kind === 'permission' ? 'act_permission' : 'act_question'))}</span>${text ? ` · ${text}` : ''}`;
    case 'error':
      return `⚠️ ${text || esc(t('st_error'))}`;
    case 'idle':
      return `✅ ${esc(a.lastText || a.title || t('act_done'))}`;
    default:
      return `💤 ${esc(a.lastText || a.title || t('act_sleep'))}`;
  }
}

function spark(bins) {
  const max = Math.max(1, ...bins);
  return `<svg class="spark" viewBox="0 0 120 22" preserveAspectRatio="none">${bins.map((v, i) => {
    const h = v ? Math.max(3, (v / max) * 20) : 1.5;
    return `<rect x="${i * 10}" y="${22 - h}" width="7.5" height="${h}" rx="2" opacity="${v ? 1 : 0.35}"/>`;
  }).join('')}</svg>`;
}

function fmtTime(ms) {
  if (!ms) return '—';
  const d = new Date(ms);
  return d.toLocaleTimeString(getLang() === 'zh' ? 'zh-TW' : 'en-US', { hour: '2-digit', minute: '2-digit' });
}

function detailHtml(a) {
  const plot = a.plot != null ? manifest.zones.plots[a.plot] : null;
  const crops = t('plot_crop');
  const stage = cropStage(a.counts?.tools);
  const rows = [
    [t('kv_platform'), `${esc(a.platformLabel)} · ${esc(animalName(a))}`],
    [t('kv_project'), esc(a.project || '—')],
    a.model && [t('kv_model'), esc(a.model)],
    a.branch && [t('kv_branch'), esc(a.branch)],
    [t('kv_started'), `${fmtTime(a.startedAt)} · ${ago(a.startedAt)}`],
    a.counts?.tokens ? [t('kv_tokens'), `${fmtNum(a.counts.tokens)} tokens`] : null,
    plot && [t('kv_plot'), `${esc(crops[plot.crop] || plot.crop)} ${'🌱'.repeat(Math.max(1, stage))}`],
    a.sessionId && [t('kv_session'), `<code>${esc(a.sessionId.slice(0, 18))}</code>`],
  ].filter(Boolean);
  const prog = a.progress && a.progress.all ? `<div class="progress" title="${a.progress.done}/${a.progress.all}"><i style="width:${Math.round(100 * a.progress.done / a.progress.all)}%"></i></div>` : '';
  const tl = (a.recent || []).slice().reverse().map((e) => {
    const parts = String(e.text || '').split(' · ');
    const icon = e.kind === 'tool' ? TOOL_ICON(parts[0]) : (KIND_ICON[e.kind] || '•');
    if (e.kind === 'tool') e = { ...e, text: [prettyTool(parts[0]), ...parts.slice(1)].join(' · ') };
    const col = { prompt: 'var(--idle)', tool: 'var(--working)', wait: 'var(--waiting)', error: 'var(--error)', reply: 'var(--thinking)' }[e.kind] || 'var(--ink-3)';
    return `<li style="--kc:${col}"><time>${fmtTime(e.t)}</time><span class="tx">${icon} ${esc(e.text || e.kind)}</span></li>`;
  }).join('');
  return `<dl class="kv">${rows.map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join('')}</dl>${prog}` +
    (a.title ? `<div class="act" style="margin-bottom:8px">📌 ${esc(a.title)}</div>` : '') +
    (tl ? `<div class="meta" style="margin-bottom:6px">${t('recent')}</div><ul class="timeline">${tl}</ul>` : '');
}

function tempTitle(a) {
  const n = state.settings?.oneShotMin || 30;
  return (a.tempReason || '').split('+').map((r) => t(`temp_${r}`, { n })).join('；');
}

function tempBadge(a) {
  return a.temp ? `<span class="tmp" title="${esc(tempTitle(a))}">${esc(t('temp_badge'))}</span>` : '';
}

function cardHtml(a) {
  const live = a.status === 'working' || a.status === 'thinking' || a.status === 'waiting';
  return `<div class="avatar"><img src="${avatarSrc(a)}" alt=""><i class="st"></i></div>
    <div class="row1"><div class="nm" title="${esc(a.project)}">${esc(a.name)}</div>${tempBadge(a)}
      <span class="pill"><i class="dot ${live ? 'live' : ''}"></i>${esc(statusLabel(a.status))}</span></div>
    <div class="meta"><span class="pf"><i></i>${esc(a.platformLabel)}</span><span>·</span><span>${esc(animalName(a))}</span>${a.model ? `<span>·</span><span class="md">${esc(a.model)}</span>` : ''}</div>
    <div class="act">${activityHtml(a)}</div>
    <div class="foot">${spark(a.spark || [])}<span>⏱ ${ago(a.lastActive)}</span><span>🔧 ${a.counts?.tools || 0}</span>${a.onFarm ? '' : `<span title="${esc(t('in_barn'))}">🏚️</span>`}</div>
    <div class="detail">${a.id === selected ? detailHtml(a) : ''}</div>`;
}

function renderPanel() {
  const agents = state.agents || [];
  const box = $('#cards');
  $('#count').textContent = agents.length;
  for (const b of document.querySelectorAll('#filters button')) {
    const f = b.dataset.filter;
    const n = agents.filter(FILTERS[f]).length;
    b.innerHTML = `${esc(t(`f_${f}`))}${f !== 'all' ? `<span class="n">${n}</span>` : ''}`;
    b.classList.toggle('on', f === filter);
  }
  const list = agents.filter(FILTERS[filter]);
  if (!agents.length || !list.length) {
    for (const el of cardEls.values()) el.remove();
    cardEls.clear();
    box.innerHTML = `<div class="empty"><span class="big">${agents.length ? '🌾' : '🐣'}</span>${agents.length ? esc(t('no_match')) : t('no_agents')}</div>`;
    return;
  }
  box.querySelector('.empty')?.remove();
  const keep = new Set(list.map((a) => a.id));
  for (const [id, el] of cardEls) if (!keep.has(id)) {
    el.remove();
    cardEls.delete(id);
  }
  list.forEach((a, i) => {
    let el = cardEls.get(a.id);
    if (!el) {
      el = document.createElement('div');
      el.dataset.id = a.id;
      el.addEventListener('click', (e) => {
        if (e.target.closest('.detail')) return;
        selectAgent(selected === a.id ? null : a.id, true);
      });
      cardEls.set(a.id, el);
      el._enter = true;
      setTimeout(() => { el._enter = false; el.classList.remove('enter'); }, 450);
    }
    const html = cardHtml(a);
    if (el._html !== html) {
      el.innerHTML = html;
      el._html = html;
    }
    el.className = `card st-${a.status}${a.id === selected ? ' sel' : ''}${a.onFarm ? '' : ' off-farm'}${a.temp ? ' temp' : ''}${el._enter ? ' enter' : ''}`;
    el.style.setProperty('--pc', a.color);
    el.style.setProperty('--sc', `var(--${a.status})`);
    if (box.children[i] !== el) box.insertBefore(el, box.children[i] || null);
  });
}

function renderChips() {
  const agents = state.agents || [];
  const order = ['working', 'thinking', 'waiting', 'error', 'idle', 'sleeping'];
  const nav = $('#chips');
  nav.innerHTML = order.map((s) => {
    const n = agents.filter((a) => a.status === s).length;
    if (!n && s === 'error') return '';
    const live = n && (s === 'working' || s === 'waiting');
    return `<button class="chip ${n ? '' : 'zero'} ${chipFilter === s ? 'on' : ''}" data-s="${s}" style="--sc:var(--${s})">
      <i class="dot ${live ? 'live' : ''}"></i><b>${n}</b><span class="lb">${esc(t(`chip_${s}`))}</span></button>`;
  }).join('');
}

function renderLegend() {
  const agents = state.agents || [];
  const counts = {};
  for (const a of agents) counts[a.platform] = (counts[a.platform] || 0) + 1;
  $('#legend').innerHTML = Object.entries(counts).map(([p, n]) => {
    const m = state.platforms[p] || { label: p, color: '#999' };
    return `<span style="--pc:${m.color}"><i></i>${esc(m.label)} ${n}</span>`;
  }).join('');
  const note = $('#demo-note');
  if (state.demo?.active) {
    note.hidden = false;
    note.innerHTML = `${state.demo.mode === 'on' ? t('demo_forced') : t('demo_on')} <button data-demo="off">${t('demo_off_btn')}</button>`;
  } else note.hidden = true;
}

// ------------------------------------------------------------------ selection & tooltip
function selectAgent(id, fromPanel = false) {
  selected = id;
  world.select(id);
  renderPanel();
  if (id) {
    const el = cardEls.get(id);
    if (el && !fromPanel) el.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    if (app.classList.contains('panel-closed') && window.innerWidth > 860 && !fromPanel) {
      app.classList.remove('panel-closed');
      updateInset();
    }
  }
}

function showTooltip(id, x, y) {
  const tip = $('#tooltip');
  if (!id) {
    tip.hidden = true;
    return;
  }
  const a = state.agents.find((q) => q.id === id);
  if (!a) {
    tip.hidden = true;
    return;
  }
  tip.style.setProperty('--sc', `var(--${a.status})`);
  tip.style.setProperty('--pc', a.color);
  const html = `<div class="t1"><span class="nm">${esc(a.name)}</span>${tempBadge(a)}<span class="pill"><i class="dot"></i>${esc(statusLabel(a.status))}</span></div>
    ${a.temp ? `<div class="sub">🧪 ${esc(tempTitle(a))}</div>` : ''}
    <div class="sub">${esc(a.platformLabel)} · ${esc(animalName(a))}${a.model ? ' · ' + esc(a.model) : ''}</div>
    <div class="act" style="margin-top:5px">${activityHtml(a)}</div>
    <div class="sub" style="margin-top:4px">⏱ ${ago(a.lastActive)} · 🔧 ${a.counts?.tools || 0}</div>`;
  if (tip._html !== html) {
    tip.innerHTML = html;
    tip._html = html;
  }
  tip.hidden = false;
  const w = tip.offsetWidth;
  const h = tip.offsetHeight;
  tip.style.left = `${Math.min(window.innerWidth - w - 10, x + 16)}px`;
  tip.style.top = `${Math.max(10, Math.min(window.innerHeight - h - 10, y + 16))}px`;
}

// ------------------------------------------------------------------ notifications
function notifyTransitions(agents) {
  for (const a of agents) {
    const p = prev.get(a.id);
    if (!p || p === a.status) continue;
    if (a.status === 'waiting') toast(a, t('toast_waiting', { name: a.name }), true);
    else if (a.status === 'error') toast(a, t('toast_error', { name: a.name }), true);
    else if (a.status === 'idle' && (p === 'working' || p === 'thinking')) toast(a, t('toast_done', { name: a.name }), false);
  }
}

function toast(a, text, important) {
  const box = $('#toasts');
  const el = document.createElement('div');
  el.className = 'toast';
  el.style.setProperty('--sc', `var(--${a.status})`);
  el.style.setProperty('--pc', a.color);
  el.innerHTML = `<img src="${avatarSrc(a)}" alt=""><span>${esc(text)}</span>`;
  el.onclick = () => selectAgent(a.id);
  box.appendChild(el);
  while (box.children.length > 3) box.firstChild.remove();
  setTimeout(() => {
    el.classList.add('out');
    setTimeout(() => el.remove(), 400);
  }, important ? 7000 : 4000);
  if (important && document.hidden && 'Notification' in window && Notification.permission === 'granted') {
    try {
      new Notification('Agent Farm', { body: text, icon: avatarSrc(a), tag: a.id });
    } catch { /* ignore */ }
  }
}

// ------------------------------------------------------------------ help dialog
function renderHelp() {
  const origin = location.origin;
  const cols = (state.collectors || []).map((c) => {
    const p = state.platforms[c.platform] || { label: c.platform, color: '#999' };
    return `<div class="plat" style="--pc:${p.color}"><i></i><div><b>${esc(p.label)}</b><small>${esc(c.root || '')}</small></div>
      ${c.found ? `<span class="ok">✓ ${esc(t('sessions', { n: c.sessions }))}</span>` : `<span class="no">${esc(t('not_found'))}</span>`}</div>`;
  }).join('');
  const hook = state.config?.hookPath || '/path/to/agent-farm/hooks/claude-hook.mjs';
  const hookCmd = { type: 'command', command: `node "${hook}"`, timeout: 5 };
  const hooksJson = JSON.stringify({
    hooks: Object.fromEntries(['UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'Notification', 'Stop', 'SessionStart', 'SessionEnd']
      .map((ev) => [ev, [/ToolUse/.test(ev) ? { matcher: '*', hooks: [hookCmd] } : { hooks: [hookCmd] }]])),
  }, null, 2);
  const mode = state.demo?.mode || 'auto';
  $('#help-body').innerHTML = `
    <h3>${t('help_legend')}</h3><p>${esc(t('legend_text'))}</p><p>${esc(t('zoom_hint'))}</p>
    <h3>${t('help_detected')}</h3><p>${t('help_auto')}</p><div class="plat-list">${cols}</div>
    <h3>${t('help_push')}</h3><p>${t('help_push_p')}</p>
<pre class="code">curl -X POST ${origin}/api/report \\
  -H 'content-type: application/json' \\
  -d '{"id":"support-bot","platform":"openai","model":"gpt-6-mini",
       "status":"working","tool":"search","detail":"order #1932"}'

# status: working | thinking | waiting | error | idle | sleeping | offline
node bin/farm-report.mjs --id researcher --platform deepseek --status thinking</pre>
<pre class="code">import requests  # Python
requests.post("${origin}/api/report", json={
    "id": "researcher", "platform": "deepseek", "status": "working",
    "tool": "web_search", "detail": "LLM eval papers"})</pre>
    <h3>${t('help_hooks')}</h3><p>${t('help_hooks_p')}</p><pre class="code">${esc(hooksJson)}</pre>
    <h3>${t('help_temp')}</h3><p>${esc(t('help_temp_p', { n: state.settings?.oneShotMin || 30 }))}</p>
    <div class="modes">${[true, false].map((v) => `<button type="button" data-temp="${v}" class="${(state.settings?.showTemp ?? true) === v ? 'on' : ''}">${t(v ? 'temp_show' : 'temp_hide')}</button>`).join('')}
      <span class="hint">${esc(t('temp_now', { n: state.settings?.tempCount || 0 }))}</span></div>
    <h3>${t('help_demo')}</h3><p>${t('help_demo_p')}</p>
    <div class="modes">${['auto', 'on', 'off'].map((m) => `<button type="button" data-demo="${m}" class="${m === mode ? 'on' : ''}">${t(`mode_${m}`)}</button>`).join('')}
      ${'Notification' in window && Notification.permission === 'default' ? `<button type="button" id="btn-notify">🔔 ${getLang() === 'zh' ? '啟用桌面通知' : 'Enable notifications'}</button>` : ''}</div>`;
}

async function setDemo(mode) {
  await fetch('api/demo', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ mode }) });
}

// ------------------------------------------------------------------ theme, clock, sky
function isNight() {
  if (themePref === 'day') return false;
  if (themePref === 'night') return true;
  const h = new Date().getHours();
  return h < 6 || h >= 18;
}

function applyTheme() {
  const night = isNight();
  app.dataset.theme = night ? 'night' : 'day';
  document.querySelector('meta[name=theme-color]').content = night ? '#182452' : '#9BD3F2';
  const icon = { auto: '🌓', day: '☀️', night: '🌙' }[themePref];
  const b = $('#btn-theme');
  b.textContent = icon;
  b.title = t(`theme_${themePref}`);
}

function tickClock() {
  const d = new Date();
  $('#clock').textContent = d.toLocaleTimeString(getLang() === 'zh' ? 'zh-TW' : 'en-US', { hour: '2-digit', minute: '2-digit', hour12: false });
  $('#clock-icon').textContent = isNight() ? '🌙' : '☀️';
  if (themePref === 'auto') applyTheme();
}

function makeSky() {
  const stars = $('#stars');
  for (let i = 0; i < 110; i++) {
    const s = document.createElement('i');
    s.className = 'star';
    const big = Math.random() < 0.12;
    s.style.cssText = `left:${Math.random() * 100}%;top:${Math.random() * 62}%;--d:${2 + Math.random() * 4}s;--delay:${-Math.random() * 5}s;${big ? 'width:3px;height:3px;' : ''}`;
    stars.appendChild(s);
  }
  const clouds = $('#clouds');
  for (let i = 0; i < 7; i++) {
    const c = document.createElement('div');
    c.className = 'cloud';
    const w = 140 + Math.random() * 200;
    const tt = 90 + Math.random() * 120;
    c.style.cssText = `top:${4 + Math.random() * 40}%;--w:${w}px;--t:${tt}s;--delay:${-Math.random() * tt}s;--o:${0.55 + Math.random() * 0.4}`;
    c.innerHTML = '<span></span>';
    clouds.appendChild(c);
  }
}

// ------------------------------------------------------------------ layout
function updateInset() {
  const mobile = window.innerWidth <= 860;
  const closed = app.classList.contains('panel-closed');
  const topH = mobile ? 54 : 64;
  world?.setInset(mobile
    ? { right: 0, top: topH + 54, bottom: closed ? 70 : window.innerHeight * 0.46 }
    : { right: closed ? 0 : 372 + 28, top: topH + 18, bottom: 6 });
}

function bindUi() {
  $('#btn-panel').onclick = () => {
    app.classList.toggle('panel-closed');
    updateInset();
    world.fit();
  };
  $('#panel-grip').onclick = () => $('#btn-panel').onclick();
  $('#btn-lang').onclick = () => {
    setLang(getLang() === 'zh' ? 'en' : 'zh');
    $('#btn-lang').textContent = getLang() === 'zh' ? 'EN' : '中';
    for (const el of cardEls.values()) el._html = '';
    for (const c of world.critters.values()) c.lastBubble = null;
    onState(state);
    applyTheme();
    tickClock();
  };
  $('#btn-theme').onclick = () => {
    themePref = { auto: 'day', day: 'night', night: 'auto' }[themePref];
    store.set('farm.theme', themePref);
    applyTheme();
    tickClock();
  };
  $('#btn-help').onclick = () => {
    renderHelp();
    $('#help').showModal();
  };
  $('#zoom-in').onclick = () => world.zoomAt(1.3, window.innerWidth / 2, window.innerHeight / 2);
  $('#zoom-out').onclick = () => world.zoomAt(1 / 1.3, window.innerWidth / 2, window.innerHeight / 2);
  $('#zoom-fit').onclick = () => world.fit();
  $('#filters').onclick = (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    filter = b.dataset.filter;
    renderPanel();
  };
  $('#chips').onclick = (e) => {
    const b = e.target.closest('.chip');
    if (!b) return;
    chipFilter = chipFilter === b.dataset.s ? null : b.dataset.s;
    world.setFilter(chipFilter ? (a) => a.status === chipFilter : null);
    renderChips();
  };
  document.addEventListener('click', async (e) => {
    const d = e.target.closest('[data-demo]');
    if (d) {
      e.preventDefault();
      await setDemo(d.dataset.demo);
    }
    const tb = e.target.closest('[data-temp]');
    if (tb) {
      e.preventDefault();
      await fetch('api/settings', { method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ showTemp: tb.dataset.temp === 'true' }) });
    }
    if (e.target.id === 'btn-notify') {
      e.preventDefault();
      await Notification.requestPermission();
      renderHelp();
    }
  });
  document.addEventListener('keydown', (e) => {
    if (e.target.closest('input, textarea')) return;
    if (e.key === 'Escape') selectAgent(null);
    if (e.key === 'f') world.fit();
    if (e.key === '+' || e.key === '=') $('#zoom-in').onclick();
    if (e.key === '-') $('#zoom-out').onclick();
  });
  let rt;
  window.addEventListener('resize', () => {
    clearTimeout(rt);
    rt = setTimeout(() => {
      updateInset();
      world.fit(false);
    }, 120);
  });
}

boot();
