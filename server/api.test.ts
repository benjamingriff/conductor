import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createApp } from './app.js';
import { Store } from './storage.js';
import { UsageService } from './usage.js';
import { Scheduler } from './scheduler.js';

test('API persists configuration and delivers only through gates to a disposable receiver', async () => {
  const received: unknown[] = [];
  const receiver = createServer((req, res) => { let body = ''; req.on('data', chunk => { body += chunk; }); req.on('end', () => { received.push(JSON.parse(body)); res.writeHead(202); res.end(); }); });
  await new Promise<void>(resolve => receiver.listen(0, '127.0.0.1', resolve));
  const receiverPort = (receiver.address() as AddressInfo).port;
  const store = new Store(':memory:');
  const now = new Date('2026-10-16T21:30:00Z');
  const usage = new UsageService(store, async () => ({ checkedAt: now.toISOString(), status: 'ok', error: null, identity: 'test-identity', windows: [{ id: 'weekly', label: 'Weekly', kind: 'weekly', usedPercent: 20, durationMinutes: 10080, resetsAt: new Date(now.getTime() + 3.5 * 86400_000).toISOString() }] }));
  const scheduler = new Scheduler(store, usage, { now: () => now });
  const app = createApp(store, usage, scheduler, { startedAt: now.toISOString(), dataPath: '/tmp/test', port: 4317, startup: 'disabled', lingering: false, version: 'test' }, '/tmp/no-static-files');
  const server = app.listen(0, '127.0.0.1'); await new Promise<void>(resolve => server.once('listening', resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api`;
  async function call(path: string, method = 'GET', data?: unknown, headers: Record<string, string> = {}) { return fetch(base + path, { method, headers: { 'content-type': 'application/json', ...headers }, body: data === undefined ? undefined : JSON.stringify(data) }); }
  try {
    const a = await (await call('/accounts', 'POST', { provider: 'codex', name: 'Receiver test account', homePath: '', paceOverride: null })).json();
    const h = await (await call('/webhooks', 'POST', { name: 'Receiver test', group: 'Tests', url: `http://127.0.0.1:${receiverPort}/secret-url`, accountIds: [a.id], enabled: true })).json();
    const schedule = await call(`/webhooks/${h.id}/schedules`, 'POST', { enabled: true, intervalMinutes: 30, start: '22:00', end: '06:00', timezone: 'Europe/London', nights: [0,1,2,3,4,5,6] });
    assert.equal(schedule.status, 201);
    await call(`/webhooks/${h.id}/run`, 'POST', {}); assert.equal(received.length, 0, 'Paused app must not send.');
    await call('/settings', 'PATCH', { enabled: true, targetPace: 110 });
    await call(`/webhooks/${h.id}/run`, 'POST', {});
    assert.equal(received.length, 1); assert.equal(store.activity()[0].outcome, 'dispatched');
    assert.equal((received[0] as { sender: string }).sender, 'conductor');
    const state = await (await call('/state')).json();
    assert.ok(!JSON.stringify(state).includes('secret-url'), 'State must mask capability URLs.');
    assert.ok(!JSON.stringify(state.activity).includes('secret-url'));
    assert.equal((await call('/settings', 'PATCH', { targetPace: 201 })).status, 400);
    assert.equal((await call('/settings', 'PATCH', { enabled: false }, { Origin: 'https://evil.example' })).status, 403);
    assert.equal(store.settings.enabled, true, 'Cross-origin request must not mutate settings.');
    assert.equal((await call(`/accounts/${a.id}`, 'DELETE')).status, 400, 'Used account cannot be removed.');
    await call(`/webhooks/${h.id}`, 'DELETE');
    assert.equal(store.schedules().length, 0, 'Deleting webhook removes its schedules.');
    assert.equal(store.activity().length, 2, 'Deleting webhook retains delivery history.');
  } finally {
    await scheduler.stop(); await usage.drain();
    await Promise.all([new Promise<void>(r => server.close(() => r())), new Promise<void>(r => receiver.close(() => r()))]);
    store.close();
  }
});
