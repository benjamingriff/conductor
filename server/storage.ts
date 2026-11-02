import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { mkdirSync, chmodSync } from 'node:fs';
import { dirname } from 'node:path';
import type { Dispatch, DispatchOutcome, GateResult, Schedule, Settings, UsageAccount, UsageSnapshot, Webhook } from '../shared/types.js';
import type { z } from 'zod';
import type { accountSchema, scheduleSchema, webhookSchema } from '../shared/schemas.js';

export type WebhookInput = z.infer<typeof webhookSchema>;
export type ScheduleInput = z.infer<typeof scheduleSchema>;
export type AccountInput = z.infer<typeof accountSchema>;
export class Store {
  readonly db: DatabaseSync;
  constructor(readonly path: string) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(path);
    if (path !== ':memory:') chmodSync(path, 0o600);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS settings (id INTEGER PRIMARY KEY CHECK(id=1), data TEXT NOT NULL);
      INSERT OR IGNORE INTO settings VALUES(1, '{"enabled":false,"targetPace":110,"revision":1}');
      CREATE TABLE IF NOT EXISTS accounts (id TEXT PRIMARY KEY, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS webhooks (id TEXT PRIMARY KEY, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS schedules (id TEXT PRIMARY KEY, webhook_id TEXT NOT NULL REFERENCES webhooks(id) ON DELETE CASCADE, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS dispatches (id TEXT PRIMARY KEY, slot_key TEXT UNIQUE NOT NULL, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS runtime_lock (id INTEGER PRIMARY KEY CHECK(id=1), owner TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS dispatch_created ON dispatches(json_extract(data, '$.createdAt'));`);
  }
  get settings(): Settings { return this.readOne('settings', 1)!; }
  getMetadata(key: string): string | null { return (this.db.prepare('SELECT value FROM metadata WHERE key=?').get(key) as { value: string } | undefined)?.value ?? null; }
  setMetadata(key: string, value: string) { this.db.prepare('INSERT INTO metadata VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key, value); }
  updateSettings(update: Partial<Pick<Settings, 'enabled' | 'targetPace'>>): Settings {
    const current = this.settings;
    const next = { ...current, ...update, revision: current.revision + 1 };
    this.db.prepare('UPDATE settings SET data=? WHERE id=1').run(JSON.stringify(next));
    return next;
  }
  private readOne<T>(table: string, id: string | number): T | null {
    const row = this.db.prepare(`SELECT data FROM ${table} WHERE id=?`).get(id) as { data: string } | undefined;
    return row ? JSON.parse(row.data) as T : null;
  }
  private all<T>(table: string): T[] { return (this.db.prepare(`SELECT data FROM ${table} ORDER BY rowid`).all() as { data: string }[]).map(r => JSON.parse(r.data)); }
  private put(table: string, id: string, data: unknown) { this.db.prepare(`INSERT INTO ${table}(id,data) VALUES(?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data`).run(id, JSON.stringify(data)); }
  accounts(): UsageAccount[] { return this.all('accounts'); }
  account(id: string): UsageAccount | null { return this.readOne('accounts', id); }
  saveAccount(input: AccountInput, id: string = randomUUID()): UsageAccount {
    const old = this.account(id);
    const sameSource = old?.provider === input.provider && old.homePath === input.homePath;
    const value: UsageAccount = { id, ...input, snapshot: sameSource ? old.snapshot : null };
    this.put('accounts', id, value); return value;
  }
  saveSnapshot(id: string, snapshot: UsageSnapshot, expectedSource?: Pick<UsageAccount, 'provider' | 'homePath'>): void {
    const account = this.account(id);
    if (!account || (expectedSource && (account.provider !== expectedSource.provider || account.homePath !== expectedSource.homePath))) return;
    this.put('accounts', id, { ...account, snapshot });
  }
  deleteAccount(id: string): void {
    if (this.webhooks().some(h => h.accountIds.includes(id))) throw new Error('This account is used by a webhook. Edit that webhook first.');
    this.db.prepare('DELETE FROM accounts WHERE id=?').run(id);
  }
  webhooks(): Webhook[] {
    return this.all<Omit<Webhook, 'schedules'> & { url: string }>('webhooks').map(h => this.publicWebhook(h));
  }
  private publicWebhook(h: Omit<Webhook, 'schedules'> & { url: string }): Webhook {
    const { url, ...rest } = h;
    return { ...rest, maskedUrl: `${new URL(url).host}/…/••••••••`, schedules: this.schedules().filter(s => s.webhookId === h.id) };
  }
  webhook(id: string): (WebhookInput & { id: string }) | null { return this.readOne('webhooks', id); }
  saveWebhook(input: WebhookInput, id: string = randomUUID()): Webhook {
    if (input.accountIds.some(a => !this.account(a))) throw new Error('Select existing usage accounts.');
    this.put('webhooks', id, { id, ...input });
    return this.webhooks().find(h => h.id === id)!;
  }
  deleteWebhook(id: string) { this.db.prepare('DELETE FROM webhooks WHERE id=?').run(id); }
  schedules(): Schedule[] { return this.all('schedules'); }
  schedule(id: string): Schedule | null { return this.readOne('schedules', id); }
  saveSchedule(webhookId: string, input: ScheduleInput, id: string = randomUUID()): Schedule {
    if (!this.webhook(webhookId)) throw new Error('Webhook not found.');
    const old = this.schedule(id);
    const next: Schedule = { id, webhookId, ...input, revision: (old?.revision ?? 0) + 1, createdAt: old?.createdAt ?? new Date().toISOString() };
    this.db.prepare('INSERT INTO schedules VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data').run(id, webhookId, JSON.stringify(next));
    return next;
  }
  deleteSchedule(id: string) { this.db.prepare('DELETE FROM schedules WHERE id=?').run(id); }
  claim(input: { key: string; webhookId: string; scheduleId: string | null; intendedAt: string; now: string }): Dispatch | null {
    const hook = this.webhook(input.webhookId);
    if (!hook) return null;
    const value: Dispatch = { id: randomUUID(), webhookId: hook.id, webhookName: [hook.group, hook.name].filter(Boolean).join(' / '), scheduleId: input.scheduleId, intendedAt: input.intendedAt, createdAt: input.now, finishedAt: null, outcome: 'checking', reason: 'Checking admission gates.', httpStatus: null, gate: null, policyRevision: this.settings.revision };
    const result = this.db.prepare('INSERT OR IGNORE INTO dispatches VALUES(?,?,?)').run(value.id, input.key, JSON.stringify(value));
    return result.changes === 1 ? value : null;
  }
  finish(id: string, outcome: DispatchOutcome, reason: string, gate: GateResult | null = null, httpStatus: number | null = null) {
    const old = this.readOne<Dispatch>('dispatches', id); if (!old) return;
    const data = { ...old, outcome, reason, gate, httpStatus, policyRevision: gate && old.outcome === 'checking' ? this.settings.revision : old.policyRevision, finishedAt: ['checking', 'sending'].includes(outcome) ? null : new Date().toISOString() };
    this.db.prepare('UPDATE dispatches SET data=? WHERE id=?').run(JSON.stringify(data), id);
  }
  activity(limit = 100, before?: string): Dispatch[] {
    const query = before ? 'SELECT data FROM dispatches WHERE json_extract(data,\'$.createdAt\') < ? ORDER BY json_extract(data,\'$.createdAt\') DESC, rowid DESC LIMIT ?' : 'SELECT data FROM dispatches ORDER BY json_extract(data,\'$.createdAt\') DESC, rowid DESC LIMIT ?';
    const rows = (before ? this.db.prepare(query).all(before, limit) : this.db.prepare(query).all(limit)) as { data: string }[];
    return rows.map(r => JSON.parse(r.data));
  }
  recover() {
    for (const d of this.all<Dispatch>('dispatches')) {
      if (d.outcome === 'checking') this.finish(d.id, 'skipped', 'Service restarted before sending; slot will not replay.');
      if (d.outcome === 'sending') this.finish(d.id, 'unknown', 'Service restarted during delivery; no automatic retry.');
    }
  }
  close() { this.db.close(); }
}
