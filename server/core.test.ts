import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Schedule, UsageAccount, UsageSnapshot } from '../shared/types.js';
import { Store } from './storage.js';
import { accountGate } from './gates.js';
import { nextSlots, slotsBetween, withinWindow } from './schedule.js';
import { normalizeClaude, normalizeCodex, UsageService } from './usage.js';
import { Scheduler } from './scheduler.js';

const baseSchedule: Schedule = { id: 'schedule', webhookId: 'hook', enabled: true, intervalMinutes: 30, start: '22:00', end: '06:00', timezone: 'Europe/London', nights: [0, 1, 2, 3, 4, 5, 6], revision: 1, createdAt: '2020-01-01T00:00:00Z' };
function snapshot(now: Date, used = 30): UsageSnapshot { return { checkedAt: now.toISOString(), status: 'ok', error: null, identity: 'test-account', windows: [{ id: 'weekly', label: 'Weekly', kind: 'weekly', usedPercent: used, durationMinutes: 10080, resetsAt: new Date(now.getTime() + 3.5 * 86400_000).toISOString() }] }; }
function account(now: Date, used: number): UsageAccount { return { id: 'a', provider: 'codex', name: 'Codex', homePath: '', paceOverride: null, snapshot: snapshot(now, used) }; }

test('relative target pace, equality, overrides, exhaustion, and stale readings', () => {
  const now = new Date('2026-10-16T21:30:00Z');
  assert.equal(accountGate(account(now, 54.99), 110, now).allowed, true);
  assert.equal(accountGate(account(now, 55), 110, now).allowed, false);
  assert.equal(accountGate(account(now, 40), 80, now).allowed, false);
  assert.equal(accountGate(account(now, 39.99), 80, now).allowed, true);
  assert.equal(accountGate({ ...account(now, 45), paceOverride: 80 }, 110, now).allowed, false);
  assert.equal(accountGate(account(now, 100), 200, now).allowed, false);
  assert.equal(accountGate(account(now, 5), 110, new Date(now.getTime() + 300_001)).allowed, false);
  const failed = account(now, 1); failed.snapshot!.status = 'error'; failed.snapshot!.error = 'Probe failed';
  assert.equal(accountGate(failed, 110, now).reason, 'Probe failed');
  const expired = account(now, 1); expired.snapshot!.windows[0].resetsAt = now.toISOString();
  assert.equal(accountGate(expired, 110, now).allowed, false);
});
test('all reported weekly buckets must qualify; session exhaustion is ignored', () => {
  const now = new Date(), a = account(now, 20);
  a.snapshot!.windows.push({ ...a.snapshot!.windows[0], id: 'scoped', label: 'Model', usedPercent: 60 });
  assert.equal(accountGate(a, 110, now).allowed, false);
  a.snapshot!.windows[1].kind = 'session';
  assert.equal(accountGate(a, 110, now).allowed, true);
});
test('UK Friday night belongs to Friday and excludes 06:00', () => {
  const schedule = { ...baseSchedule, nights: [4] };
  assert.equal(withinWindow(schedule, new Date('2026-10-17T04:59:59Z')), true);
  assert.equal(withinWindow(schedule, new Date('2026-10-17T05:00:00Z')), false);
  assert.equal(withinWindow(schedule, new Date('2026-10-17T21:00:00Z')), false);
  const slots = slotsBetween(schedule, new Date('2026-10-16T20:59:59Z'), new Date('2026-10-17T05:00:00Z'));
  assert.equal(slots.length, 16);
  assert.equal(slots[0].local, '2026-10-16 22:00');
  assert.equal(slots.at(-1)!.local, '2026-10-17 05:30');
});
test('spring gaps are skipped and autumn repeated slots fire once', () => {
  const spring = slotsBetween(baseSchedule, new Date('2026-03-28T21:59:59Z'), new Date('2026-03-29T06:00:00Z'));
  assert.equal(spring.length, 14);
  assert.ok(spring.every(s => !s.local.startsWith('2026-03-29 01:')));
  const autumn = slotsBetween(baseSchedule, new Date('2026-10-24T20:59:59Z'), new Date('2026-10-25T06:00:00Z'));
  assert.equal(autumn.length, 16);
  assert.equal(new Set(autumn.map(s => s.key)).size, 16);
  assert.equal(autumn.filter(s => s.local === '2026-10-25 01:00').length, 1);
  assert.equal(autumn.find(s => s.local === '2026-10-25 01:00')!.at, '2026-10-25T00:00:00.000Z');
  assert.equal(nextSlots(baseSchedule, new Date('2026-10-17T05:00:00Z'))[0].local, '2026-10-17 22:00');
});
test('quota normalizers distinguish weekly/session and reject unsupported plans', () => {
  const windows = normalizeCodex({ rateLimits: { primary: { usedPercent: 20, windowDurationMins: 10080, resetsAt: 1792649574 }, secondary: { usedPercent: 100, windowDurationMins: 300, resetsAt: 1792150758 } } });
  assert.deepEqual(windows.map(w => w.kind), ['weekly', 'session']);
  assert.deepEqual(normalizeCodex({ rateLimits: { planType: 'free', primary: { usedPercent: 10 } } }), []);
  const claude = normalizeClaude({ rate_limits_available: true, rate_limits: { seven_day: { utilization: 33, resets_at: '2026-10-21T11:00:00Z' }, model_scoped: [{ display_name: 'Opus', utilization: 50, resets_at: '2026-10-21T11:00:00Z' }] } });
  assert.deepEqual(claude.map(w => w.usedPercent), [33, 50]);
});
test('SQLite persists pause state and masked URLs; startup recovery never replays uncertain sends', () => {
  const dir = mkdtempSync(join(tmpdir(), 'conductor-store-'));
  try {
    let store = new Store(join(dir, 'state.sqlite'));
    const a = store.saveAccount({ provider: 'codex', name: 'Test', homePath: '', paceOverride: null });
    const h = store.saveWebhook({ name: 'Worker', group: '', url: 'http://localhost:9999/secret-token', accountIds: [a.id], enabled: true });
    assert.ok(!JSON.stringify(h).includes('secret-token'));
    store.updateSettings({ targetPace: 80, enabled: false });
    const d = store.claim({ key: 'same-slot', webhookId: h.id, scheduleId: null, intendedAt: new Date().toISOString(), now: new Date().toISOString() })!;
    store.finish(d.id, 'sending', 'in flight'); store.close();
    store = new Store(join(dir, 'state.sqlite')); store.recover();
    assert.equal(store.settings.enabled, false); assert.equal(store.settings.targetPace, 80);
    assert.equal(store.activity()[0].outcome, 'unknown');
    assert.equal(store.claim({ key: 'same-slot', webhookId: h.id, scheduleId: null, intendedAt: new Date().toISOString(), now: new Date().toISOString() }), null);
    store.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

function fixture(fetcher: typeof fetch = async () => new Response(null, { status: 202 })) {
  const store = new Store(':memory:');
  let clock = new Date('2026-10-16T21:29:50Z');
  const a = store.saveAccount({ provider: 'codex', name: 'Test', homePath: '', paceOverride: null });
  const h = store.saveWebhook({ name: 'Worker', group: '', url: 'http://localhost:9999/test', accountIds: [a.id], enabled: true });
  const s = store.saveSchedule(h.id, { enabled: true, intervalMinutes: 30, start: '22:00', end: '06:00', nights: [0,1,2,3,4,5,6], timezone: 'Europe/London' });
  store.db.prepare('UPDATE schedules SET data=? WHERE id=?').run(JSON.stringify({ ...s, createdAt: '2020-01-01T00:00:00Z' }), s.id);
  const usage = new UsageService(store, async () => snapshot(clock));
  const scheduler = new Scheduler(store, usage, { now: () => clock, fetch: fetcher });
  return { store, h, scheduler, setClock: (value: string) => { clock = new Date(value); } };
}
test('scheduler dispatches exactly once per slot and never replays after a sleep gap', async () => {
  let calls = 0;
  const f = fixture(async () => { calls++; return new Response(null, { status: 202 }); });
  f.store.updateSettings({ enabled: true }); f.setClock('2026-10-16T21:30:03Z');
  await f.scheduler.tick(); await f.scheduler.tick();
  assert.equal(calls, 1); assert.equal(f.store.activity()[0].outcome, 'dispatched');
  f.setClock('2026-10-16T23:30:03Z'); await f.scheduler.tick(); assert.equal(calls, 1);
  f.store.close();
});
test('manual dispatch obeys pause, window and over-pace gates; timeouts stay unknown', async () => {
  let calls = 0;
  const f = fixture(async () => { calls++; throw new Error('Network timeout with a sensitive URL that must not be logged'); });
  await f.scheduler.runNow(f.h.id); assert.equal(calls, 0); assert.equal(f.store.activity()[0].outcome, 'skipped');
  f.store.updateSettings({ enabled: true }); await f.scheduler.runNow(f.h.id);
  assert.equal(calls, 1); assert.equal(f.store.activity()[0].outcome, 'unknown');
  assert.ok(!JSON.stringify(f.store.activity()).includes('sensitive URL'));
  f.setClock('2026-10-17T05:00:00Z'); await f.scheduler.runNow(f.h.id); assert.equal(calls, 1);
  f.store.close();
});
test('pause during a fresh quota read prevents the pending send', async () => {
  const store = new Store(':memory:'); const now = new Date('2026-10-16T21:30:00Z');
  const a = store.saveAccount({ provider: 'codex', name: 'Test', homePath: '', paceOverride: null });
  const h = store.saveWebhook({ name: 'Worker', group: '', url: 'http://localhost:9999/test', accountIds: [a.id], enabled: true });
  store.saveSchedule(h.id, { enabled: true, intervalMinutes: 30, start: '22:00', end: '06:00', nights: [0,1,2,3,4,5,6], timezone: 'Europe/London' });
  store.updateSettings({ enabled: true }); let release!: () => void; let calls = 0;
  const usage = new UsageService(store, async () => { await new Promise<void>(r => { release = r; }); return snapshot(now); });
  const scheduler = new Scheduler(store, usage, { now: () => now, fetch: async () => { calls++; return new Response(null, { status: 202 }); } });
  const attempt = scheduler.runNow(h.id); store.updateSettings({ enabled: false }); release(); await attempt;
  assert.equal(calls, 0); assert.equal(store.activity()[0].outcome, 'skipped'); store.close();
});
test('in-flight delivery retains its admitted policy revision after a setting change', async () => {
  let release!: () => void;
  const f = fixture(async () => { await new Promise<void>(r => { release = r; }); return new Response(null, { status: 202 }); });
  f.store.updateSettings({ enabled: true });
  const admittedRevision = f.store.settings.revision;
  const attempt = f.scheduler.runNow(f.h.id);
  while (!release) await new Promise(r => setImmediate(r));
  f.store.updateSettings({ targetPace: 80 }); release(); await attempt;
  assert.equal(f.store.activity()[0].policyRevision, admittedRevision);
  assert.equal(f.store.activity()[0].gate!.accounts[0].effectivePace, 110);
  f.store.close();
});
