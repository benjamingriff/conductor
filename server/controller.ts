import { isAbsolute } from 'node:path';
import { ZodError } from 'zod';
import { accountSchema, scheduleSchema, settingsSchema, webhookSchema } from '../shared/schemas.js';
import { accountGate } from './gates.js';
import { nextSlots } from './schedule.js';
import { expandHome } from './usage.js';
import type { Store } from './storage.js';
import type { UsageService } from './usage.js';
import type { Scheduler } from './scheduler.js';
import type { ServiceInfo } from '../shared/types.js';

export class ApiError extends Error { constructor(message: string, readonly status = 400) { super(message); } }
export class Controller {
  constructor(readonly store: Store, readonly usage: UsageService, readonly scheduler: Scheduler, readonly service: Omit<ServiceInfo, 'heartbeatAt' | 'uptimeSeconds'>) {}
  async request(path: string, method = 'GET', body?: unknown): Promise<unknown> {
    if (typeof path !== 'string' || path.length > 1000 || (!path.startsWith('/') || path.startsWith('//')) || !['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].includes(method)) throw new ApiError('Invalid application request.');
    const url = new URL(path, 'http://conductor.local'), parts = url.pathname.split('/').filter(Boolean), [resource, id, action] = parts;
    const s = this.store;
    try {
      if (path === '/health' && method === 'GET') return { ok: true, startedAt: this.service.startedAt, heartbeatAt: this.scheduler.heartbeatAt, enabled: s.settings.enabled };
      if (path === '/state' && method === 'GET') {
        void this.usage.refreshAll(false).catch(() => {});
        const now = new Date();
        return { settings: s.settings, accounts: s.accounts(), webhooks: s.webhooks(), activity: s.activity(), service: { ...this.service, heartbeatAt: this.scheduler.heartbeatAt, uptimeSeconds: Math.floor((Date.now() - Date.parse(this.service.startedAt)) / 1000) }, now: now.toISOString(), accountGates: s.accounts().map(a => accountGate(a, s.settings.targetPace, now)), nextSlots: Object.fromEntries(s.schedules().map(schedule => [schedule.id, nextSlots(schedule, now)])) };
      }
      if (resource === 'settings' && parts.length === 1 && method === 'PATCH') { const update = settingsSchema.parse(body); if (update.enabled !== undefined && update.enabled !== s.settings.enabled) this.scheduler.resetClock(); return s.updateSettings(update); }
      if (resource === 'accounts' && parts.length <= 2) {
        if (method === 'GET' && !id) return s.accounts();
        if (method === 'DELETE' && id) { s.deleteAccount(id); return { ok: true }; }
        if ((method === 'POST' && !id) || (method === 'PUT' && id)) {
          if (id && !s.account(id)) throw new ApiError('Account not found.', 404);
          const input = accountSchema.parse(body);
          if (input.homePath && !isAbsolute(expandHome(input.homePath))) throw new ApiError('Use an absolute home path or ~/path.');
          const account = s.saveAccount(input, id); if (!id) void this.usage.refresh(account.id); return account;
        }
      }
      if (path === '/usage/refresh' && method === 'POST') { await this.usage.refreshAll(); return { ok: true }; }
      if (resource === 'webhooks') {
        if (parts.length === 1 && method === 'POST') return s.saveWebhook(webhookSchema.parse(body));
        if (id && parts.length === 2) {
          const hook = s.webhook(id); if (!hook) throw new ApiError('Webhook not found.', 404);
          if (method === 'GET') return hook;
          if (method === 'DELETE') { s.deleteWebhook(id); return { ok: true }; }
          if (method === 'PUT') { const input = webhookSchema.parse(body); this.scheduler.resetClock(); return s.saveWebhook(input, id); }
        }
        if (id && parts.length === 3 && method === 'POST') {
          if (!s.webhook(id)) throw new ApiError('Webhook not found.', 404);
          if (action === 'check') return this.scheduler.check(id);
          if (action === 'run') { const runId = await this.scheduler.runNow(id); return { id: runId, activity: s.activity() }; }
          if (action === 'schedules') return s.saveSchedule(id, scheduleSchema.parse(body));
        }
      }
      if (resource === 'schedules' && id && parts.length === 2) {
        const old = s.schedule(id); if (!old) throw new ApiError('Schedule not found.', 404);
        if (method === 'DELETE') { s.deleteSchedule(id); return { ok: true }; }
        if (method === 'PUT') { const input = scheduleSchema.parse(body); this.scheduler.resetClock(); return s.saveSchedule(old.webhookId, input, old.id); }
      }
      if (resource === 'activity' && parts.length === 1 && method === 'GET') return s.activity(100, url.searchParams.get('before') ?? undefined);
      throw new ApiError('Application route not found.', 404);
    } catch (error) {
      if (error instanceof ApiError) throw error;
      if (error instanceof ZodError) throw new ApiError(error.issues.map(i => i.message).join(' '));
      if (error instanceof Error && ['Select existing usage accounts.', 'This account is used by a webhook. Edit that webhook first.', 'Webhook not found.'].includes(error.message)) throw new ApiError(error.message);
      throw new ApiError('Request could not be completed.', 500);
    }
  }
}
