import { app, BrowserWindow, ipcMain, Menu, Tray, nativeImage, shell, dialog, powerMonitor, nativeTheme } from 'electron';
import { homedir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { mkdir, readFile, writeFile, unlink } from 'node:fs/promises';
import { Store } from '../server/storage.js';
import { UsageService } from '../server/usage.js';
import { Scheduler } from '../server/scheduler.js';
import { Controller } from '../server/controller.js';
import { acquireStateLock } from '../server/lock.js';
import type { Server } from 'node:net';

const dev = process.env.CONDUCTOR_CHANNEL === 'development' || !app.isPackaged;
app.setName(dev ? 'Conductor Dev' : 'Conductor');
app.setPath('userData', process.argv.includes('--smoke') && process.env.CONDUCTOR_SMOKE_DIR ? join(process.env.CONDUCTOR_SMOKE_DIR, 'profile') : join(app.getPath('appData'), dev ? 'conductor-development' : 'conductor-desktop'));
const stateDir = resolve(process.env.CONDUCTOR_STATE_DIR ?? (process.platform === 'linux' ? join(process.env.XDG_STATE_HOME ?? join(homedir(), '.local/state'), dev ? 'conductor-dev' : 'conductor') : join(app.getPath('userData'), 'state')));
const here = dirname(fileURLToPath(import.meta.url));
const rendererPath = join(here, '../web/index.html');
const rendererUrl = process.env.CONDUCTOR_RENDERER_URL && dev ? process.env.CONDUCTOR_RENDERER_URL : pathToFileURL(rendererPath).href;
let stateLock: Server | null = null;
const runtimeFile = join(stateDir, 'desktop-runtime.json');
let win: BrowserWindow | null = null, tray: Tray | null = null, quitting = false, cleanupDone = false;
let stopping: Promise<void> | null = null;
let store: Store, usage: UsageService, scheduler: Scheduler, controller: Controller;
const gotLock = app.requestSingleInstanceLock();
if (gotLock && process.argv.includes('--quit')) app.exit(0);
if (!gotLock) app.quit();
else {
  app.on('second-instance', (_event, argv) => { if (argv.includes('--quit')) app.quit(); else showWindow(); });
  app.on('activate', () => showWindow());
  app.on('window-all-closed', () => {});
  app.on('before-quit', event => {
    quitting = true;
    if (cleanupDone) return;
    event.preventDefault();
    void (stopping ??= stop()).finally(() => { cleanupDone = true; app.quit(); });
  });
  void app.whenReady().then(start).catch(error => { console.error('Conductor startup failed:', error instanceof Error ? error.message : 'Unknown error'); dialog.showErrorBox('Conductor could not start', 'Another scheduler may be running, or the data directory is unavailable. Check the local app logs.'); quitting = true; cleanupDone = true; app.quit(); });
}

function showWindow() {
  if (!win || win.isDestroyed()) createWindow();
  if (win!.isMinimized()) win!.restore();
  win!.show(); win!.focus();
}
function createWindow() {
  const bounds = store?.getMetadata('desktop-window');
  let size = { width: 1220, height: 900 }; try { const saved = JSON.parse(bounds ?? '{}'); if (saved.width >= 850 && saved.width <= 2560 && saved.height >= 600 && saved.height <= 1600) size = saved; } catch {}
  win = new BrowserWindow({ ...size, minWidth: 850, minHeight: 620, title: dev ? 'Conductor Dev' : 'Conductor', backgroundColor: '#09090a', show: false,
    icon: join(here, '../../public/icon.png'), autoHideMenuBar: true, titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    webPreferences: { preload: join(here, 'preload.cjs'), contextIsolation: true, sandbox: true, nodeIntegration: false, webSecurity: true, backgroundThrottling: false },
  });
  const current = win;
  current.webContents.on('render-process-gone', (_event, details) => { if (!quitting && details.reason !== 'clean-exit') void current.loadURL(rendererUrl); });
  current.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  current.webContents.on('will-navigate', (event, url) => { if (url !== rendererUrl) event.preventDefault(); });
  current.webContents.session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  current.on('close', event => { if (!quitting && tray) { event.preventDefault(); current.hide(); } });
  current.on('resize', () => { if (!current.isMaximized() && !cleanupDone && !quitting) { const [width, height] = current.getSize(); store?.setMetadata('desktop-window', JSON.stringify({ width, height })); } });
  current.on('closed', () => { win = null; });
  current.webContents.on('did-finish-load', () => { if (!process.argv.includes('--background') && !(process.platform === 'darwin' && app.getLoginItemSettings().wasOpenedAtLogin)) current.show(); });
  void current.loadURL(rendererUrl);
}
function validateSender(event: Electron.IpcMainInvokeEvent) {
  if (!win || event.sender !== win.webContents || event.senderFrame !== win.webContents.mainFrame || event.senderFrame.url !== rendererUrl) throw new Error('Untrusted application frame.');
}
function loginPath() { return join(process.env.XDG_CONFIG_HOME ?? join(homedir(), '.config'), 'autostart/conductor.desktop'); }
async function launchAtLogin() {
  if (dev) return false;
  if (process.platform === 'darwin') return app.getLoginItemSettings().openAtLogin;
  try { return (await readFile(loginPath(), 'utf8')).includes('X-Conductor-Managed=true'); } catch { return false; }
}
async function setLogin(enabled: boolean) {
  if (dev) throw new Error('Launch at login is configured in the installed app.');
  if (process.platform === 'darwin') { app.setLoginItemSettings({ openAtLogin: enabled }); return launchAtLogin(); }
  const path = loginPath();
  try { if (!(await readFile(path, 'utf8')).includes('X-Conductor-Managed=true')) throw new Error('An unrelated login entry already exists.'); } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; }
  if (!enabled) { try { if ((await readFile(path, 'utf8')).includes('X-Conductor-Managed=true')) await unlink(path); } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; } return false; }
  await mkdir(dirname(path), { recursive: true });
  const launcher = process.env.CONDUCTOR_LAUNCHER ?? join(homedir(), '.local/bin/conductor');
  await writeFile(path, `[Desktop Entry]\nType=Application\nName=Conductor\nExec="${launcher.replaceAll('"', '\\"')}" --background\nTerminal=false\nX-Conductor-Managed=true\n`, { mode: 0o600 });
  return true;
}
async function info() { return { version: app.getVersion(), electron: process.versions.electron, channel: dev ? 'development' : 'installed', dataPath: stateDir, appPath: app.getAppPath(), launchAtLogin: await launchAtLogin(), platform: process.platform }; }
function updateTray() {
  if (!tray) return;
  tray.setToolTip(`Conductor · ${store.settings.enabled ? 'Scheduling enabled' : 'Paused'}`);
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'Open Conductor', click: showWindow },
    { label: store.settings.enabled ? 'Pause scheduling' : 'Resume scheduling', click: () => { scheduler.resetClock(); store.updateSettings({ enabled: !store.settings.enabled }); updateTray(); } },
    { type: 'separator' }, { label: `Version ${app.getVersion()}`, enabled: false },
    { label: 'Quit Conductor', click: () => app.quit() },
  ]));
}
async function start() {
  nativeTheme.themeSource = 'dark';
  if (process.argv.includes('--smoke') && (!process.env.CONDUCTOR_SMOKE_DIR || !process.env.CONDUCTOR_STATE_DIR || !dev)) throw new Error('Smoke checks require an isolated development data directory.');
  process.umask(0o077); await mkdir(stateDir, { recursive: true, mode: 0o700 });
  stateLock = await acquireStateLock(stateDir);
  store = new Store(join(stateDir, 'conductor.sqlite'));
  if (!store.getMetadata('accounts-initialized')) {
    if (!store.accounts().length) { for (const provider of ['codex', 'claude'] as const) store.saveAccount({ name: `${provider === 'codex' ? 'Codex' : 'Claude'} · local`, provider, homePath: process.env[provider === 'codex' ? 'CODEX_HOME' : 'CLAUDE_CONFIG_DIR'] ?? '', paceOverride: null }); }
    store.setMetadata('accounts-initialized', 'true');
  }
  store.recover(); usage = new UsageService(store); scheduler = new Scheduler(store, usage);
  controller = new Controller(store, usage, scheduler, { startedAt: new Date().toISOString(), dataPath: stateDir, port: 0, startup: 'Desktop application', lingering: false, version: app.getVersion() });
  ipcMain.handle('conductor:request', async (event, path, method, body) => {
    validateSender(event);
    try { const value = await controller.request(path, method, body); updateTray(); return { ok: true, value }; }
    catch (e) { return { ok: false, error: e instanceof Error ? e.message : 'Request failed.' }; }
  });
  ipcMain.handle('conductor:desktop', async (event, action, value) => {
    validateSender(event);
    if (action === 'info') return info();
    if (action === 'show-data') { const error = await shell.openPath(stateDir); if (error) throw new Error('Could not open the data folder.'); return true; }
    if (action === 'login' && typeof value === 'boolean') return setLogin(value);
    throw new Error('Unknown desktop action.');
  });
  const icon = nativeImage.createFromPath(join(here, '../../public/tray.png'));
  tray = new Tray(icon); tray.on('click', showWindow); updateTray();
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    ...(process.platform === 'darwin' ? [{ label: 'Conductor', submenu: [{ role: 'about' as const }, { type: 'separator' as const }, { role: 'quit' as const }] }] : []),
    { label: 'File', submenu: [{ label: 'Hide window', accelerator: 'CmdOrCtrl+W', click: () => win?.close() }, { role: 'quit' }] },
    { label: 'Edit', submenu: [{ role: 'undo' }, { role: 'redo' }, { type: 'separator' }, { role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'selectAll' }] },
    { label: 'View', submenu: [{ role: 'reload' }, { role: 'toggleDevTools' }, { role: 'resetZoom' }, { role: 'zoomIn' }, { role: 'zoomOut' }] },
  ]));
  process.on('SIGTERM', () => app.quit()); process.on('SIGINT', () => app.quit());
  powerMonitor.on('resume', () => scheduler.resetClock());
  scheduler.start(); void usage.refreshAll().catch(() => {});
  await writeFile(runtimeFile, JSON.stringify({ pid: process.pid, version: app.getVersion(), startedAt: new Date().toISOString(), channel: dev ? 'development' : 'installed' }), { mode: 0o600 });
  createWindow();
  if (process.argv.includes('--smoke')) void smoke();
}
async function stop() {
  const deadline = setTimeout(() => app.exit(1), 35_000); deadline.unref();
  try { await scheduler?.stop(); await usage?.drain(); store?.close(); if (stateLock) await new Promise<void>(r => stateLock!.close(() => r())); await unlink(runtimeFile).catch(() => {}); tray?.destroy(); } finally { clearTimeout(deadline); }
}
async function smoke() {
  const output = process.env.CONDUCTOR_SMOKE_DIR;
  if (!output) { app.quit(); return; }
  try {
    await mkdir(output, { recursive: true });
    await new Promise<void>((resolve, reject) => { const timer = setTimeout(() => reject(new Error('Renderer load timed out')), 20_000); win!.webContents.once('did-finish-load', () => { clearTimeout(timer); resolve(); }); });
    await new Promise(r => setTimeout(r, 1000));
    const { rendererSmoke } = await import('./smoke.js');
    const result = await win!.webContents.executeJavaScript(`(${rendererSmoke.toString()})()`);
    if (!result.nodeHidden || result.overflow) throw new Error('Renderer isolation or layout check failed');
    win!.close(); if (win!.isVisible()) throw new Error('Window did not hide to tray'); showWindow(); await new Promise(r => setTimeout(r, 300));
    const viewport = await win!.webContents.executeJavaScript(`({width:innerWidth,height:innerHeight,dpr:devicePixelRatio,scrollWidth:document.documentElement.scrollWidth})`);
    if (viewport.scrollWidth > viewport.width) throw new Error('Layout overflow after reopening');
    await mkdir(output, { recursive: true }); await writeFile(join(output, 'desktop.png'), (await win!.webContents.capturePage()).toPNG());
    for (const tab of ['webhooks', 'activity', 'settings']) {
      await win!.webContents.executeJavaScript(`document.getElementById('tab-${tab}').click()`);
      await new Promise(r => setTimeout(r, 150));
      await writeFile(join(output, `${tab}.png`), (await win!.webContents.capturePage()).toPNG());
    }
    await writeFile(join(output, 'result.json'), JSON.stringify({ ...result, viewport, hideAndReopen: true, sqlite: true }));
    app.quit();
  } catch (error) { await writeFile(join(output, 'error.txt'), String(error)); console.error('Desktop smoke failed:', String(error)); process.exitCode = 1; app.quit(); }
}
