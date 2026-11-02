import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { createHash } from 'node:crypto';
import { access } from 'node:fs/promises';
import { constants } from 'node:fs';
import { homedir } from 'node:os';
import { join, isAbsolute } from 'node:path';
import type { UsageAccount, UsageSnapshot, UsageWindow } from '../shared/types.js';
import type { Store } from './storage.js';
import { FRESH_MS } from './gates.js';

type Json = Record<string, any>;
const record = (x: unknown): Json => x && typeof x === 'object' && !Array.isArray(x) ? x as Json : {};
const fingerprint = (value: string) => createHash('sha256').update(value).digest('hex').slice(0, 16);
export const expandHome = (value: string): string => value === '~' ? homedir() : value.startsWith('~/') ? join(homedir(), value.slice(2)) : value;
async function executable(name: 'codex' | 'claude') {
  const explicit = process.env[name === 'codex' ? 'CONDUCTOR_CODEX_BIN' : 'CONDUCTOR_CLAUDE_BIN'];
  const candidates = [explicit, ...((process.env.PATH ?? '').split(':').map(p => join(p, name))), join(homedir(), '.local/share/mise/installs', name, 'latest', name === 'codex' ? 'bin/codex' : 'claude')].filter((p): p is string => !!p);
  for (const path of candidates) { try { await access(path, constants.X_OK); return path; } catch { /* Try next location. */ } }
  throw new Error(`${name === 'codex' ? 'Codex' : 'Claude'} CLI was not found. Install/sign in locally or set CONDUCTOR_${name.toUpperCase()}_BIN.`);
}

/** Only control/read messages are sent. No thread/start, turn/start, or user prompt. */
async function controlProbe(account: UsageAccount): Promise<{ usage: Json; identity: string }> {
  const provider = account.provider;
  const bin = await executable(provider);
  const configHome = expandHome(account.homePath);
  if (configHome && !isAbsolute(configHome)) throw new Error('Account home must be an absolute path or begin with ~/ .');
  const env = { ...process.env, ...(configHome ? { [provider === 'codex' ? 'CODEX_HOME' : 'CLAUDE_CONFIG_DIR']: configHome } : {}) };
  // Avoid inheriting a parent T3/Claude session marker into a read-only probe.
  delete env.CLAUDECODE;
  const args = provider === 'codex' ? ['app-server', '--listen', 'stdio://'] : ['--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose', '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}'];
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { env, cwd: homedir(), stdio: ['pipe', 'pipe', 'pipe'] });
    let done = false, outputBytes = 0, identity = `${provider}:${configHome || 'default'}`;
    const reader = createInterface({ input: child.stdout });
    const finish = (error?: Error, value?: { usage: Json; identity: string }) => {
      if (done) return; done = true; clearTimeout(timer); reader.close(); child.stdin.end(); child.kill('SIGTERM');
      const kill = setTimeout(() => child.kill('SIGKILL'), 1000); kill.unref(); child.once('exit', () => clearTimeout(kill));
      if (error) reject(error); else resolve(value!);
    };
    const timer = setTimeout(() => finish(new Error('Usage probe timed out. Check the CLI login and try again.')), 25_000);
    child.stderr.resume(); // Provider output can contain private data; never log it.
    child.stdin.on('error', () => finish(new Error('Usage probe closed before responding.')));
    child.on('error', () => finish(new Error('Could not start the local usage probe.')));
    child.on('exit', () => { if (!done) finish(new Error('Usage probe exited. Open the CLI/T3 and check its login.')); });
    const send = (data: unknown) => { if (!done) child.stdin.write(JSON.stringify(data) + '\n'); };
    reader.on('line', line => {
      outputBytes += Buffer.byteLength(line);
      if (outputBytes > 2_000_000) { finish(new Error('Usage probe response exceeded its limit.')); return; }
      let message: Json; try { message = record(JSON.parse(line)); } catch { return; }
      if (provider === 'codex') {
        if (message.id === 1) {
          if (message.error) { finish(new Error('Codex could not initialise the usage reader.')); return; }
          send({ method: 'initialized' }); send({ id: 2, method: 'account/rateLimits/read', params: null });
        }
        if (message.id === 2) {
          if (message.error) { finish(new Error('Codex usage unavailable. Sign in with a subscription account in Codex/T3.')); return; }
          const result = record(message.result);
          if (typeof result.accountId === 'string') identity = result.accountId;
          finish(undefined, { usage: result, identity: fingerprint(identity) });
        }
      } else if (message.type === 'control_response') {
        const response = record(message.response);
        if (response.subtype !== 'success') { finish(new Error('Claude usage unavailable. Check the Claude/T3 login.')); return; }
        if (response.request_id === 'init') {
          const accountInfo = record(record(response.response).account);
          identity = String(accountInfo.accountUuid ?? accountInfo.uuid ?? identity);
          send({ type: 'control_request', request_id: 'usage', request: { subtype: 'get_usage' } });
        }
        if (response.request_id === 'usage') finish(undefined, { usage: record(response.response), identity: fingerprint(identity) });
      }
    });
    send(provider === 'codex' ? { id: 1, method: 'initialize', params: { clientInfo: { name: 'conductor', title: 'Conductor', version: '0.1.0' }, capabilities: { experimentalApi: true } } } : { type: 'control_request', request_id: 'init', request: { subtype: 'initialize', hooks: {} } });
  });
}

function window(id: string, label: string, kind: 'weekly' | 'session', used: unknown, reset: unknown, durationMinutes: number): UsageWindow | null {
  if (typeof used !== 'number' || !Number.isFinite(used) || used < 0 || used > 100) return null;
  const ms = typeof reset === 'number' ? reset * 1000 : typeof reset === 'string' ? Date.parse(reset) : NaN;
  return { id, label, kind, usedPercent: used, resetsAt: Number.isFinite(ms) ? new Date(ms).toISOString() : null, durationMinutes };
}
export function normalizeCodex(raw: Json): UsageWindow[] {
  const limits = record(record(raw.rateLimitsByLimitId).codex ?? raw.rateLimits);
  const result: UsageWindow[] = [];
  for (const [id, fallback] of [['primary', 300], ['secondary', 10080]] as const) {
    const w = record(limits[id]);
    const duration = typeof w.windowDurationMins === 'number' ? w.windowDurationMins : ['free', 'go'].includes(limits.planType) ? 0 : fallback;
    if (duration !== 300 && duration !== 10080) continue; // Do not mislabel monthly/other plans as weekly.
    const normalized = window(id, duration === 10080 ? 'Weekly' : 'Session', duration === 10080 ? 'weekly' : 'session', w.usedPercent, w.resetsAt, duration);
    if (normalized) result.push(normalized);
  }
  return result;
}
export function normalizeClaude(raw: Json): UsageWindow[] {
  if (!raw.rate_limits_available) return [];
  const limits = record(raw.rate_limits), result: UsageWindow[] = [];
  for (const [id, kind, label, duration] of [['five_hour', 'session', 'Session', 300], ['seven_day', 'weekly', 'Weekly', 10080]] as const) {
    const w = record(limits[id]); const normalized = window(id, label, kind, w.utilization, w.resets_at, duration);
    if (normalized) result.push(normalized);
  }
  for (const scoped of Array.isArray(limits.model_scoped) ? limits.model_scoped : []) {
    const w = record(scoped), name = typeof w.display_name === 'string' ? w.display_name : 'Model';
    const normalized = window(`weekly_${name.toLowerCase().replace(/\W+/g, '_')}`, `Weekly · ${name}`, 'weekly', w.utilization, w.resets_at, 10080);
    if (normalized) result.push(normalized);
  }
  return result;
}
export type UsageProbe = (account: UsageAccount) => Promise<UsageSnapshot>;
export const probeUsage: UsageProbe = async account => {
  try {
    const { usage, identity } = await controlProbe(account);
    const windows = account.provider === 'codex' ? normalizeCodex(usage) : normalizeClaude(usage);
    if (!windows.some(w => w.kind === 'weekly')) throw new Error('No weekly subscription allowance reported. Check the selected CLI account.');
    return { checkedAt: new Date().toISOString(), status: 'ok', error: null, identity, windows };
  } catch (error) {
    return { checkedAt: new Date().toISOString(), status: 'error', error: error instanceof Error ? error.message : 'Usage probe failed.', identity: null, windows: [] };
  }
};
export class UsageService {
  private pending = new Map<string, Promise<void>>();
  constructor(private store: Store, private probe: UsageProbe = probeUsage) {}
  async refresh(id: string, force = false): Promise<void> {
    const account = this.store.account(id); if (!account) return;
    const age = Date.now() - Date.parse(account.snapshot?.checkedAt ?? '');
    if (!force && account.snapshot?.status === 'error' && age >= 0 && age < 60_000) return; // Bounded failure backoff; manual refresh can retry.
    if (!force && account.snapshot?.status === 'ok' && age >= 0 && age < FRESH_MS && account.snapshot.windows.filter(w => w.kind === 'weekly').every(w => !!w.resetsAt && Date.parse(w.resetsAt) > Date.now())) return;
    const key = `${id}:${account.provider}:${account.homePath}`;
    if (this.pending.has(key)) return this.pending.get(key);
    const task = this.probe(account).then(snapshot => this.store.saveSnapshot(id, snapshot, account)).finally(() => this.pending.delete(key));
    this.pending.set(key, task); return task;
  }
  async refreshAll(force = true) { await Promise.all(this.store.accounts().map(a => this.refresh(a.id, force))); }
  async drain() { await Promise.allSettled(this.pending.values()); }
}
