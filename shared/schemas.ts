import { z } from 'zod';
import { IANAZone } from 'luxon';
const pace = z.number().int().min(1).max(200);
export const settingsSchema = z.object({ enabled: z.boolean().optional(), targetPace: pace.optional() }).strict();
export const accountSchema = z.object({ provider: z.enum(['codex', 'claude']), name: z.string().trim().min(1).max(80), homePath: z.string().trim().max(500), paceOverride: pace.nullable() }).strict();
export const webhookSchema = z.object({
  name: z.string().trim().min(1).max(100), group: z.string().trim().max(80),
  url: z.string().max(4096).refine(value => { try { const u = new URL(value); return ['http:', 'https:'].includes(u.protocol) && !u.username && !u.password && !u.hash; } catch { return false; } }, 'Use an HTTP(S) URL without embedded username/password or fragment.'),
  accountIds: z.array(z.string().min(1)).min(1).max(20).refine(a => new Set(a).size === a.length), enabled: z.boolean(),
}).strict();
export const scheduleSchema = z.object({
  enabled: z.boolean(), intervalMinutes: z.number().int().min(1).max(1440),
  start: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/), end: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/),
  timezone: z.string().max(100).refine(value => IANAZone.isValidZone(value), 'Choose a valid IANA timezone.'),
  nights: z.array(z.number().int().min(0).max(6)).min(1).max(7).refine(a => new Set(a).size === a.length),
}).strict().refine(s => s.start !== s.end, 'Start and end times must differ.');
