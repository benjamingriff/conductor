import express from 'express';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { ApiError, Controller } from './controller.js';
import type { Store } from './storage.js';
import type { Scheduler } from './scheduler.js';
import type { UsageService } from './usage.js';
import type { ServiceInfo } from '../shared/types.js';

const exec = promisify(execFile);
export async function startupStatus() {
  const run = async (args: string[]) => { try { return (await exec(args[0], args.slice(1), { timeout: 2000 })).stdout.trim(); } catch (error) { return typeof (error as { stdout?: unknown }).stdout === 'string' && (error as { stdout: string }).stdout.trim() ? (error as { stdout: string }).stdout.trim() : 'unavailable'; } };
  const [startup, linger] = await Promise.all([run(['systemctl', '--user', 'is-enabled', 'conductor.service']), run(['loginctl', 'show-user', process.env.USER ?? '', '-p', 'Linger', '--value'])]);
  return { startup, lingering: linger === 'yes' };
}
export function createApp(store: Store, usage: UsageService, scheduler: Scheduler, service: Omit<ServiceInfo, 'heartbeatAt' | 'uptimeSeconds'>, webRoot: string) {
  const app = express(); app.disable('x-powered-by');
  app.use((req, res, next) => {
    const host = req.hostname;
    if (!['localhost', '127.0.0.1', '::1', '[::1]'].includes(host)) { res.status(403).json({ error: 'Use the local Conductor address.' }); return; }
    if (req.path.startsWith('/api')) {
      res.setHeader('Cache-Control', 'no-store');
      const origin = req.get('origin');
      if (origin) { try { const u = new URL(origin); if (!['localhost', '127.0.0.1', '[::1]'].includes(u.hostname) || ![String(service.port), '5173'].includes(u.port)) throw new Error(); } catch { res.status(403).json({ error: 'Cross-origin API access is not allowed.' }); return; } }
      if (['POST', 'PUT', 'PATCH'].includes(req.method) && !req.is('application/json')) { res.status(415).json({ error: 'Send application/json.' }); return; }
    }
    next();
  });
  app.use(express.json({ limit: '32kb' }));
  const controller = new Controller(store, usage, scheduler, service);
  app.use('/api', async (req, res, next) => {
    try {
      const value = await controller.request(req.url, req.method, req.body);
      const created = req.method === 'POST' && (/^\/accounts$|^\/webhooks$|^\/webhooks\/[^/]+\/schedules$/.test(req.path));
      res.status(created ? 201 : 200).json(value);
    } catch (error) { next(error); }
  });
  app.use(express.static(webRoot, { index: false, maxAge: '1h' }));
  app.get('/{*path}', (_req, res) => { res.setHeader('Cache-Control', 'no-cache'); res.sendFile(join(webRoot, 'index.html')); });
  app.use((error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    if (error instanceof ApiError) { res.status(error.status).json({ error: error.message }); return; }
    if (error instanceof SyntaxError) { res.status(400).json({ error: 'Invalid JSON request.' }); return; }
    const safe = error instanceof Error && ['Select existing usage accounts.', 'This account is used by a webhook. Edit that webhook first.', 'Webhook not found.'].includes(error.message);
    res.status(safe ? 400 : 500).json({ error: safe ? (error as Error).message : 'Request could not be completed.' });
  });
  return app;
}
