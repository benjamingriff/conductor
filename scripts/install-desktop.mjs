import { spawn, execFileSync } from 'node:child_process';
import { cp, mkdir, readFile, writeFile, readlink, symlink, rename, unlink, access, open } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, dirname, resolve } from 'node:path';

if (process.platform !== 'linux') throw new Error('The local installer currently supports Linux. On macOS, package on a Mac and copy Conductor.app to ~/Applications.');
process.umask(0o077);
const pkg = JSON.parse(await readFile('package.json', 'utf8'));
const source = resolve(`release/Conductor-linux-${process.arch}`);
await access(join(source, 'conductor'));
const config = process.env.XDG_CONFIG_HOME ?? join(homedir(), '.config');
const dataHome = process.env.XDG_DATA_HOME ?? join(homedir(), '.local/share');
const base = join(dataHome, 'conductor-desktop');
const unitPath = join(config, 'systemd/user/conductor.service');
const readOptional = async path => { try { return await readFile(path, 'utf8'); } catch (e) { if (e.code === 'ENOENT') return null; throw e; } };
const unit = await readOptional(unitPath);
const installConfigPath = join(base, 'install.json');
const installedConfig = JSON.parse(await readOptional(installConfigPath) ?? 'null');
const unitState = unit?.startsWith('# Managed by Conductor') ? unit.match(/^Environment="CONDUCTOR_STATE_DIR=(.*)"$/m)?.[1]?.replace(/\\(["\\])/g, '$1').replaceAll('%%', '%') : null;
const stateDir = resolve(process.env.CONDUCTOR_STATE_DIR ?? installedConfig?.stateDir ?? unitState ?? join(process.env.XDG_STATE_HOME ?? join(homedir(), '.local/state'), 'conductor'));
if (installedConfig?.stateDir && installedConfig.stateDir !== stateDir) throw new Error('This installation already uses a different data directory. Keep its configured directory when upgrading.');
const cliPaths = {};
for (const key of ['CONDUCTOR_CODEX_BIN', 'CONDUCTOR_CLAUDE_BIN', 'CODEX_HOME', 'CLAUDE_CONFIG_DIR']) {
  const unitValue = unit?.startsWith('# Managed by Conductor') ? unit.match(new RegExp('^Environment="' + key + '=(.*)"$', 'm'))?.[1]?.replace(/\\(["\\])/g, '$1').replaceAll('%%', '%') : null;
  const value = process.env[key] ?? installedConfig?.cliPaths?.[key] ?? unitValue;
  if (value) cliPaths[key] = value;
}
const current = join(base, 'current');
const launcher = join(homedir(), '.local/bin/conductor');
const runtimePath = join(stateDir, 'desktop-runtime.json');
const autostart = join(config, 'autostart/conductor.desktop');
const desktopPath = join(dataHome, 'applications/conductor.desktop');
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const target = join(base, 'releases', `${pkg.version}-${stamp}`);
const managed = 'X-Conductor-Managed=true';
const exists = async path => { try { await access(path); return true; } catch { return false; } };
const read = async path => { try { return await readFile(path, 'utf8'); } catch (e) { if (e.code === 'ENOENT') return null; throw e; } };
const sleep = ms => new Promise(r => setTimeout(r, ms));
const alive = pid => { try { process.kill(pid, 0); return true; } catch { return false; } };
const shellQuote = value => "'" + value.replaceAll("'", "'\\''") + "'";
const desktopQuote = value => '"' + value.replaceAll('\\', '\\\\').replaceAll('"', '\\"').replaceAll('`', '\\`').replaceAll('$', '\\$').replaceAll('%', '%%') + '"';
let previous = null;
try { previous = await readlink(current); } catch (e) { if (e.code !== 'ENOENT') throw e; }
for (const path of [autostart, desktopPath]) {
  const content = await read(path);
  if (content && !content.includes(managed)) throw new Error(`Refusing to replace an unrelated desktop entry: ${path}`);
}
const existingLauncher = await read(launcher);
if (existingLauncher && !existingLauncher.includes('# Managed by Conductor Desktop')) throw new Error(`An unrelated launcher exists: ${launcher}`);
let serviceWasActive = false, serviceWasEnabled = false, desktopWasRunning = false, previousVersion = null, launchedChild = null;
const systemctl = (...args) => execFileSync('systemctl', ['--user', ...args], { stdio: 'pipe', encoding: 'utf8' });
if (unit?.startsWith('# Managed by Conductor')) {
  try { serviceWasActive = systemctl('is-active', 'conductor.service').trim() === 'active'; } catch {}
  try { serviceWasEnabled = systemctl('is-enabled', 'conductor.service').trim() === 'enabled'; } catch {}
}
async function quitInstalled() {
  let runtime; try { runtime = JSON.parse(await readFile(runtimePath, 'utf8')); } catch { return; }
  if (!Number.isInteger(runtime.pid) || !alive(runtime.pid)) return;
  desktopWasRunning = true; previousVersion = runtime.version;
  if (!previous) throw new Error('A desktop instance is running without an installed release. Quit it before installing.');
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE; delete env.CONDUCTOR_CHANNEL; env.CONDUCTOR_STATE_DIR = stateDir; delete env.CONDUCTOR_RENDERER_URL;
  const child = spawn(join(current, 'conductor'), ['--quit'], { env, stdio: 'ignore' });
  await new Promise((r, reject) => { child.once('error', reject); child.once('exit', r); });
  for (let attempt = 0; attempt < 160; attempt++) { if (!alive(runtime.pid)) return; await sleep(250); }
  throw new Error('Conductor is still shutting down. Installation left the previous release in place.');
}
async function pointTo(path) {
  const temporary = `${current}.${process.pid}.tmp`;
  await symlink(path, temporary); await rename(temporary, current);
}
async function launch(expectedVersion = pkg.version) {
  const log = await open(join(stateDir, 'desktop.log'), 'a', 0o600);
  const env = { ...process.env };
  for (const key of ['ELECTRON_RUN_AS_NODE', 'CONDUCTOR_CHANNEL', 'CONDUCTOR_STATE_DIR', 'CONDUCTOR_RENDERER_URL', 'CONDUCTOR_SMOKE_DIR']) delete env[key];
  Object.assign(env, cliPaths); env.CONDUCTOR_STATE_DIR = stateDir;
  const child = spawn(join(current, 'conductor'), [], { env, detached: true, stdio: ['ignore', log.fd, log.fd] });
  launchedChild = child;
  let spawnError; child.once('error', e => { spawnError = e; });
  child.unref(); await log.close();
  for (let attempt = 0; attempt < 80; attempt++) {
    if (spawnError) throw spawnError;
    try { const runtime = JSON.parse(await readFile(runtimePath, 'utf8')); if (runtime.pid === child.pid && runtime.version === expectedVersion && alive(child.pid)) return; } catch {}
    if (child.exitCode !== null) throw new Error(`Installed app exited ${child.exitCode}. See ${stateDir}/desktop.log`);
    await sleep(250);
  }
  throw new Error(`Installed app did not become ready. See ${stateDir}/desktop.log`);
}
let switched = false;
try {
  await mkdir(dirname(target), { recursive: true });
  await cp(source, target, { recursive: true });
  // Stop the old scheduler before taking an offline backup or starting Electron.
  if (serviceWasActive) systemctl('stop', 'conductor.service');
  if (serviceWasEnabled) systemctl('disable', 'conductor.service');
  await quitInstalled();
  await mkdir(stateDir, { recursive: true, mode: 0o700 });
  if (await exists(join(stateDir, 'conductor.sqlite'))) {
    const backup = join(stateDir, 'backups', `before-${pkg.version}-${stamp}`);
    await mkdir(backup, { recursive: true, mode: 0o700 });
    for (const suffix of ['', '-wal', '-shm']) { const path = join(stateDir, `conductor.sqlite${suffix}`); if (await exists(path)) await cp(path, join(backup, `conductor.sqlite${suffix}`)); }
    console.log(`Configuration backup: ${backup}`);
  }
  await pointTo(target); switched = true;
  if (previous) await writeFile(join(base, 'previous-release'), previous + '\n');
  await mkdir(dirname(launcher), { recursive: true });
  await writeFile(launcher, `#!/bin/sh\n# Managed by Conductor Desktop\nunset ELECTRON_RUN_AS_NODE CONDUCTOR_CHANNEL CONDUCTOR_STATE_DIR CONDUCTOR_RENDERER_URL CONDUCTOR_SMOKE_DIR\nexport CONDUCTOR_STATE_DIR=${shellQuote(stateDir)}\n${Object.entries(cliPaths).map(([key, value]) => `export ${key}=${shellQuote(value)}\n`).join('')}exec ${shellQuote(join(current, 'conductor'))} "$@" >>${shellQuote(join(stateDir, 'desktop.log'))} 2>&1\n`, { mode: 0o755 });
  const iconPath = join(dataHome, 'icons/hicolor/512x512/apps/conductor.png');
  await mkdir(dirname(iconPath), { recursive: true }); await cp('public/icon.png', iconPath);
  const entry = `[Desktop Entry]\nType=Application\nName=Conductor\nComment=Local workflow scheduler\nExec=${desktopQuote(launcher)}\nIcon=conductor\nTerminal=false\nCategories=Development;Utility;\nStartupWMClass=Conductor\n${managed}\n`;
  await mkdir(dirname(desktopPath), { recursive: true }); await writeFile(desktopPath, entry, { mode: 0o644 });
  // First install starts at login; subsequent installs preserve the user's toggle.
  if (!previous) { await mkdir(dirname(autostart), { recursive: true }); await writeFile(autostart, entry.replace(`Exec=${desktopQuote(launcher)}`, `Exec=${desktopQuote(launcher)} --background`), { mode: 0o600 }); }
  try { execFileSync('update-desktop-database', [dirname(desktopPath)], { stdio: 'ignore' }); } catch {}
  await writeFile(installConfigPath, JSON.stringify({ stateDir, cliPaths }, null, 2) + '\n', { mode: 0o600 });
  await launch();
  console.log(`Conductor ${pkg.version} installed and opened.\nLauncher: ${launcher}\nData: ${stateDir}`);
} catch (error) {
  // A failed readiness check may leave the new main process alive. Stop it before restoring.
  if (launchedChild?.pid && alive(launchedChild.pid)) {
    launchedChild.kill('SIGTERM');
    for (let attempt = 0; attempt < 160 && alive(launchedChild.pid); attempt++) await sleep(250);
    if (alive(launchedChild.pid)) throw new AggregateError([error], 'The failed release is still stopping. Previous scheduler was not started concurrently.');
  }
  if (switched && previous) await pointTo(previous);
  if (desktopWasRunning && previous) { try { await launch(previousVersion); } catch (restoreError) { console.error('Previous desktop release could not restart:', restoreError.message); } }
  if (serviceWasEnabled) try { systemctl('enable', 'conductor.service'); } catch {}
  if (serviceWasActive) try { systemctl('start', 'conductor.service'); } catch {}
  throw error;
}
