// Agent Farm for Windows and Linux: starts the farm server with its own copy of Node and shows the
// farm in a window, with a tray icon and count of agents waiting for you, plus native notifications.
// (The macOS app is macos/AgentFarm.swift; both load the same web/ and server/.)
import { app, BrowserWindow, Menu, Notification, Tray, nativeImage, ipcMain, shell, dialog } from 'electron';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const zh = /^zh/i.test(app.getLocale());
const L = (en, zhText) => (zh ? zhText : en);
const WIN = process.platform === 'win32';

let win = null;
let tray = null;
let server = null;
const FIRST_PORT = Number(process.env.FARM_PORT_START) || 5180;  // (override: testing next to another farm)
let port = FIRST_PORT;
let quitting = false;
let waiting = 0;
let working = 0;
let lastError = '';
let hiddenStart = process.argv.includes('--hidden');  // started by the login item: stay in the tray

const farmUrl = () => `http://127.0.0.1:${port}/`;
const isFarm = (u) => !!u && u.startsWith(farmUrl());

if (!app.requestSingleInstanceLock()) {
  app.quit();
  process.exit(0);
}
app.on('second-instance', () => showFarm());

// ------------------------------------------------------------------ server
async function probe(p) {  // null = nothing there, true = an Agent Farm, false = something else
  try {
    const r = await fetch(`http://127.0.0.1:${p}/api/health`, { signal: AbortSignal.timeout(1500) });
    if (!r.ok) return false;
    return (await r.json()).ok === true;
  } catch (e) {
    const code = e.cause?.code;
    return code === 'ECONNREFUSED' ? null : false;
  }
}

function nodeBinary() {
  // packaged: the Node bundled by desktop/fetch-node.mjs; from source (`npm run desktop`): the node on PATH
  const bundled = path.join(process.resourcesPath, 'node', WIN ? 'node.exe' : 'node');
  return app.isPackaged && fs.existsSync(bundled) ? bundled : 'node';
}

function launchServer() {
  const dataDir = app.getPath('userData');
  fs.mkdirSync(dataDir, { recursive: true });
  const logDir = app.getPath('logs');
  fs.mkdirSync(logDir, { recursive: true });
  const log = fs.openSync(path.join(logDir, 'server.log'), 'w');
  lastError = '';
  const p = spawn(nodeBinary(), [path.join(ROOT, 'server', 'server.mjs')], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(port), HOST: '127.0.0.1', FARM_APP: '1', FARM_DATA_DIR: dataDir,
      FARM_PARENT_PID: String(process.pid) },
    stdio: ['ignore', log, log],
    windowsHide: true,
  });
  p.on('error', (e) => { lastError = String(e.message || e); });
  p.on('exit', (code) => {
    if (server === p) server = null;
    if (!quitting) showError(L('The farm server stopped unexpectedly.', '農場伺服器意外停止了。'),
      lastError || `exit code ${code}`);
  });
  server = p;
}

function stopServer() {
  const p = server;
  server = null;
  if (p && p.exitCode === null) p.kill();
}

async function startFarm() {
  for (let p = FIRST_PORT; p < FIRST_PORT + 20; p++) {
    const r = await probe(p);
    if (r === true) { port = p; loadFarm(); return; }  // a farm is already running (e.g. `npm start`)
    if (r === null) {
      port = p;
      launchServer();
      for (let i = 0; i < 80; i++) {
        await new Promise((ok) => setTimeout(ok, 250));
        if (!server) return;  // the exit handler shows the error
        if ((await probe(p)) === true) { loadFarm(); return; }
      }
      showError(L("The farm server didn't start in time.", '農場伺服器沒有在時間內啟動。'), lastError);
      return;
    }
  }
  showError(L('No free port to start the farm on.', '沒有可用的連接埠可以啟動農場。'));
}

async function restartFarm() {
  stopServer();
  await startFarm();
}

// ------------------------------------------------------------------ window
function buildWindow() {
  win = new BrowserWindow({
    width: 1280, height: 820, minWidth: 720, minHeight: 520, show: false, title: 'Agent Farm',
    backgroundColor: '#1b2a1f', icon: path.join(HERE, 'icon.png'), autoHideMenuBar: true,
    webPreferences: { preload: path.join(HERE, 'preload.cjs'), contextIsolation: true, sandbox: true, nodeIntegration: false },
  });
  win.once('ready-to-show', () => { if (!hiddenStart) win.show(); });
  // links to other sites open in the browser, never inside the app
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/.test(url) && !isFarm(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (e, url) => {
    if (url.startsWith('data:') || isFarm(url)) return;
    e.preventDefault();
    if (/^https?:/.test(url)) shell.openExternal(url);
  });
  win.webContents.on('render-process-gone', () => { if (!quitting && server) loadFarm(); });
  win.on('close', (e) => {
    if (quitting) return;
    e.preventDefault();  // keep watching in the background; the tray (or launching the app again) brings it back
    win.hide();
  });
}

function loadFarm() {
  win?.loadURL(farmUrl());
  if (!hiddenStart) win?.show();
}

function showFarm() {
  if (!win) return;
  hiddenStart = false;
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
}

function showError(message, detail = '') {
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const html = `<!doctype html><meta charset="utf-8"><style>
    body{font:15px system-ui,sans-serif;background:#1b2a1f;color:#f2efe2;display:grid;place-content:center;height:100vh;margin:0;text-align:center}
    p{max-width:520px;color:#c9d3c0;word-break:break-word} button{font:inherit;padding:8px 18px;border-radius:8px;border:0;background:#e9b44c;cursor:pointer}
  </style><h2>${esc(message)}</h2>${detail ? `<p>${esc(detail)}</p>` : ''}
  <p>${esc(L('Log:', '記錄檔：'))} ${esc(path.join(app.getPath('logs'), 'server.log'))}</p>
  <div><button onclick="farmShell.restart()">${esc(L('Try again', '再試一次'))}</button></div>`;
  win?.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html));
  hiddenStart = false;
  win?.show();
}

// ------------------------------------------------------------------ tray, login item
function autostartFile() {
  return path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), 'autostart', 'agent-farm.desktop');
}

function getAutostart() {
  if (process.platform === 'linux') return fs.existsSync(autostartFile());
  return app.getLoginItemSettings().openAtLogin;
}

function setAutostart(on) {
  if (process.platform === 'linux') {
    const f = autostartFile();
    if (!on) { fs.rmSync(f, { force: true }); return; }
    const exec = process.env.APPIMAGE || process.execPath;  // an AppImage's real path, not its temporary mount
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, `[Desktop Entry]\nType=Application\nName=Agent Farm\nExec="${exec}" --hidden\nIcon=agent-farm\nX-GNOME-Autostart-enabled=true\n`);
    return;
  }
  app.setLoginItemSettings({ openAtLogin: on, args: ['--hidden'] });
}

function statusText() {
  if (waiting > 0) return L(`${waiting} waiting for you`, `${waiting} 個在等你`);
  if (working > 0) return L(`${working} working`, `${working} 個工作中`);
  return L('All quiet', '一切平靜');
}

function updateTray() {
  if (!tray) return;
  tray.setToolTip(`Agent Farm · ${statusText()}`);
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: L('Show Agent Farm', '顯示 Agent Farm'), click: showFarm },
    { label: statusText(), enabled: false },
    { type: 'separator' },
    { label: L('Open at login', '登入時自動開啟'), type: 'checkbox', checked: getAutostart(),
      click: (item) => setAutostart(item.checked) },
    { label: L('Restart farm server', '重新啟動農場伺服器'), click: () => restartFarm() },
    { label: L('Check for updates…', '檢查更新…'), click: () => shell.openExternal('https://github.com/irons163/agent-farm/releases/latest') },
    { type: 'separator' },
    { label: L('Quit', '結束'), click: () => app.quit() },
  ]));
  if (process.platform === 'linux') app.setBadgeCount(waiting);
}

function buildTray() {
  try {
    const size = WIN ? 16 : 22;
    tray = new Tray(nativeImage.createFromPath(path.join(HERE, 'icon.png')).resize({ width: size, height: size }));
    tray.on('click', showFarm);
    updateTray();
  } catch {
    tray = null;  // no tray on this desktop: the window still works
  }
}

// ------------------------------------------------------------------ bridge from the page
ipcMain.on('farm', (e, msg) => {
  if (!msg || typeof msg.type !== 'string') return;
  const fromFarm = isFarm(e.senderFrame?.url);
  if (msg.type === 'status' && fromFarm) {
    waiting = Number(msg.waiting) || 0;
    working = Number(msg.working) || 0;
    updateTray();
  } else if (msg.type === 'notify' && fromFarm) {
    notify(String(msg.id || ''), String(msg.body || ''));
  } else if (msg.type === 'restart' && !fromFarm) {
    restartFarm();
  }
});

function notify(id, body) {
  // the page already shows a toast when you're looking at it
  if (win?.isVisible() && win.isFocused() && !win.isMinimized()) return;
  if (!Notification.isSupported()) return;
  const n = new Notification({ title: 'Agent Farm', body, icon: path.join(HERE, 'icon.png') });
  n.on('click', () => {
    showFarm();
    win?.webContents.executeJavaScript(`window.farmSelect && window.farmSelect(${JSON.stringify(id)})`).catch(() => {});
  });
  n.show();
}

// ------------------------------------------------------------------ lifecycle
app.on('before-quit', () => { quitting = true; stopServer(); });
app.on('window-all-closed', () => {});  // stay in the tray
app.on('will-quit', () => stopServer());

app.whenReady().then(async () => {
  if (WIN) app.setAppUserModelId('io.github.irons163.agentfarm');
  Menu.setApplicationMenu(null);
  buildWindow();
  buildTray();
  if (!tray) hiddenStart = false;  // nowhere to bring the window back from
  await startFarm();
}).catch((e) => dialog.showErrorBox('Agent Farm', String(e.stack || e)));
