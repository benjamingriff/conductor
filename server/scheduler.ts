import { randomUUID } from 'node:crypto';
import type { GateResult, Schedule, UsageAccount } from '../shared/types.js';
import { accountGate } from './gates.js';
import { slotsBetween, withinWindow } from './schedule.js';
import type { Store } from './storage.js';
import type { UsageService } from './usage.js';

export class Scheduler {
  private lastTick: number;
  private timer: NodeJS.Timeout | null = null;
  private ticking = false;
  private stopping = false;
  private active = new Map<string, Promise<unknown>>();
  heartbeatAt: string | null = null;
  constructor(readonly store: Store, readonly usage: UsageService, private options: { now?: () => Date; fetch?: typeof fetch; timeoutMs?: number } = {}) { this.lastTick = this.now().getTime(); }
  private now() { return this.options.now?.() ?? new Date(); }
  resetClock() { this.lastTick = this.now().getTime(); }
  start() { this.timer = setInterval(() => { void this.tick().catch(() => console.error('Scheduler tick failed; next tick will retry future slots.')); }, 15_000); }
  async tick() {
    if (this.ticking || this.stopping) return;
    this.ticking = true;
    try {
      const now = this.now(), previous = this.lastTick;
      this.lastTick = now.getTime(); this.heartbeatAt = now.toISOString();
      if (now.getTime() < previous || now.getTime() - previous > 60_000) return; // Sleep/clock gap: no catch-up.
      const tasks: Promise<unknown>[] = [];
      for (const schedule of this.store.schedules()) {
        for (const slot of slotsBetween(schedule, new Date(previous), now)) {
          if (Date.parse(slot.at) < Date.parse(schedule.createdAt)) continue;
          if (now.getTime() - Date.parse(slot.at) > 30_000) continue;
          tasks.push(this.dispatch(schedule.webhookId, schedule, slot.key, slot.at));
        }
      }
      await Promise.allSettled(tasks);
    } finally { this.ticking = false; }
  }
  async check(webhookId: string, schedule?: Schedule): Promise<GateResult> {
    let hook = this.store.webhook(webhookId);
    if (!hook) return { allowed: false, reason: 'Webhook no longer exists.', accounts: [] };
    const original = JSON.stringify(hook);
    await Promise.all(hook.accountIds.map(id => this.usage.refresh(id)));
    hook = this.store.webhook(webhookId);
    if (!hook || JSON.stringify(hook) !== original) return { allowed: false, reason: 'Webhook changed while checking; wait for the next slot.', accounts: [] };
    const settings = this.store.settings, now = this.now();
    const accounts = hook.accountIds.map(id => this.store.account(id)).filter((a): a is UsageAccount => a !== null);
    const gates = accounts.map(a => accountGate(a, settings.targetPace, now));
    const fail = (reason: string): GateResult => ({ allowed: false, reason, accounts: gates });
    if (this.stopping) return fail('Service is stopping.');
    if (!settings.enabled) return fail('Scheduling is paused globally.');
    if (!hook.enabled) return fail('Webhook is disabled.');
    const schedules = schedule ? [this.store.schedule(schedule.id)].filter((s): s is Schedule => !!s && s.revision === schedule.revision) : this.store.schedules().filter(s => s.webhookId === webhookId);
    if (!schedules.some(s => s.enabled && withinWindow(s, now))) return fail('Outside an enabled schedule’s window or selected nights.');
    if (!accounts.length || accounts.length !== hook.accountIds.length) return fail('Select valid usage accounts for this webhook.');
    const denied = gates.find(g => !g.allowed);
    if (denied) return fail(`${denied.accountName}: ${denied.reason}`);
    return { allowed: true, reason: 'All admission gates pass. T3 owns the work after delivery.', accounts: gates };
  }
  runNow(webhookId: string) { return this.dispatch(webhookId, undefined, `manual:${randomUUID()}`, this.now().toISOString()); }
  private async dispatch(webhookId: string, schedule: Schedule | undefined, key: string, intendedAt: string) {
    const record = this.store.claim({ key, webhookId, scheduleId: schedule?.id ?? null, intendedAt, now: this.now().toISOString() });
    if (!record) return null;
    if (this.active.has(webhookId)) { this.store.finish(record.id, 'skipped', 'A webhook request is already in flight.'); return record.id; }
    const task = (async () => {
      try {
        const gate = await this.check(webhookId, schedule);
        if (!gate.allowed) { this.store.finish(record.id, 'skipped', gate.reason, gate); return record.id; }
        const hook = this.store.webhook(webhookId);
        // No await between this final admission and starting the POST.
        if (!hook || !this.store.settings.enabled || !hook.enabled || this.stopping) { this.store.finish(record.id, 'skipped', 'Scheduling changed before sending.', gate); return record.id; }
        this.store.finish(record.id, 'sending', 'Webhook request in flight.', gate);
        try {
          const response = await (this.options.fetch ?? fetch)(hook.url, { method: 'POST', headers: { 'content-type': 'application/json', 'user-agent': 'conductor/0.1.0' }, body: JSON.stringify({ dispatchId: record.id, intendedAt, sender: 'conductor' }), redirect: 'manual', signal: AbortSignal.timeout(this.options.timeoutMs ?? 10_000) });
          await response.body?.cancel();
          this.store.finish(record.id, response.ok ? 'dispatched' : 'failed', response.ok ? `Webhook accepted · HTTP ${response.status}. Work continues in T3.` : `Webhook rejected · HTTP ${response.status}. No automatic retry.`, gate, response.status);
        } catch (error) {
          const refused = error instanceof Error && (error.cause as { code?: string } | undefined)?.code === 'ECONNREFUSED';
          this.store.finish(record.id, refused ? 'failed' : 'unknown', refused ? 'Connection refused. Check T3 and the webhook address.' : 'Delivery could not be confirmed. No automatic retry; next ordinary slot remains scheduled.', gate);
        }
        return record.id;
      } catch {
        this.store.finish(record.id, 'skipped', 'Admission check failed. No webhook was sent.'); return record.id;
      }
    })();
    this.active.set(webhookId, task);
    try { return await task; } finally { this.active.delete(webhookId); }
  }
  async stop() { this.stopping = true; if (this.timer) clearInterval(this.timer); await Promise.allSettled(this.active.values()); }
}
