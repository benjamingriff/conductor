import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { acquireStateLock } from './lock.js';
import { mkdir } from 'node:fs/promises';
import { Store } from './storage.js';
import { UsageService } from './usage.js';
import { Scheduler } from './scheduler.js';
import { createApp, startupStatus } from './app.js';

process.umask(0o077);
const dataDir = resolve(process.env.CONDUCTOR_STATE_DIR ?? join(process.env.XDG_STATE_HOME ?? join(homedir(), '.local/state'), 'conductor'));
await mkdir(dataDir, { recursive: true, mode: 0o700 });
const lock = await acquireStateLock(dataDir);
const port = Number(process.env.CONDUCTOR_PORT ?? 4317);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid CONDUCTOR_PORT.');
const store = new Store(join(dataDir, 'conductor.sqlite'));
if (!store.getMetadata('accounts-initialized')) {
  if (!store.accounts().length) {
    store.saveAccount({ name: 'Codex · local', provider: 'codex', homePath: process.env.CODEX_HOME ?? '', paceOverride: null });
    store.saveAccount({ name: 'Claude · local', provider: 'claude', homePath: process.env.CLAUDE_CONFIG_DIR ?? '', paceOverride: null });
  }
  store.setMetadata('accounts-initialized', 'true');
}
store.recover();
const usage = new UsageService(store), scheduler = new Scheduler(store, usage);
const status = await startupStatus();
const built = fileURLToPath(new URL('../web', import.meta.url));
const webRoot = process.env.CONDUCTOR_WEB_ROOT ?? (import.meta.url.endsWith('.ts') ? resolve('dist/web') : built);
const app = createApp(store, usage, scheduler, { startedAt: new Date().toISOString(), dataPath: dataDir, port, ...status, version: '0.1.0' }, webRoot);
const server = app.listen(port, '127.0.0.1', () => console.log(`Conductor listening at http://localhost:${port} · scheduling ${store.settings.enabled ? 'enabled' : 'paused'}`));
server.on('error', error => { console.error(error.message); process.exitCode = 1; void shutdown(); });
scheduler.start();
void usage.refreshAll().catch(() => console.error('Initial usage refresh failed.'));
let closing = false;
async function shutdown() {
  if (closing) return; closing = true;
  const timeout = setTimeout(() => process.exit(1), 35_000); timeout.unref();
  const httpClosed = new Promise<void>(resolve => server.close(() => resolve()));
  await scheduler.stop(); await usage.drain(); await httpClosed; store.close();
  await new Promise<void>(resolve => lock ? lock.close(() => resolve()) : resolve());
  clearTimeout(timeout);
}
process.on('SIGTERM', () => void shutdown()); process.on('SIGINT', () => void shutdown());
