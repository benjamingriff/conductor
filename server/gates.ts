import type { AccountGate, UsageAccount, WindowGate } from '../shared/types.js';
export const FRESH_MS = 5 * 60_000;
/** Percentages are rounded by providers; equality within 1e-8 points is denied. */
export function accountGate(account: UsageAccount, targetPace: number, now: Date): AccountGate {
  const pace = account.paceOverride ?? targetPace;
  const base = { accountId: account.id, accountName: account.name, effectivePace: pace };
  const fail = (reason: string): AccountGate => ({ ...base, allowed: false, reason, windows: [] });
  const s = account.snapshot;
  if (!s) return fail('Usage has not been checked yet.');
  if (s.status !== 'ok') return fail(s.error ?? 'Usage reading is unavailable.');
  const age = now.getTime() - Date.parse(s.checkedAt);
  if (!Number.isFinite(age) || age > FRESH_MS || age < -30_000) return fail('Usage reading is stale. Refresh required.');
  if (!s.identity) return fail('Provider account identity is unavailable.');
  const weekly = s.windows.filter(w => w.kind === 'weekly');
  if (!weekly.length) return fail('This account did not report a weekly allowance.');
  const windows: WindowGate[] = [];
  for (const w of weekly) {
    const reset = w.resetsAt ? Date.parse(w.resetsAt) : NaN;
    const duration = w.durationMinutes * 60_000;
    if (!Number.isFinite(reset) || !Number.isFinite(duration) || duration <= 0 || reset <= now.getTime() || reset - duration > now.getTime() || !Number.isFinite(w.usedPercent) || w.usedPercent < 0 || w.usedPercent > 100) return fail(`${w.label}: valid current weekly window is unavailable.`);
    const budgetPercent = 100 * (now.getTime() - (reset - duration)) / duration;
    const cutoffPercent = Math.min(100, budgetPercent * pace / 100);
    windows.push({ id: w.id, label: w.label, usedPercent: w.usedPercent, budgetPercent, cutoffPercent, resetsAt: w.resetsAt!, allowed: w.usedPercent < cutoffPercent - 1e-8 });
  }
  const blocked = windows.find(w => !w.allowed);
  return { ...base, allowed: !blocked, windows, reason: blocked ? `${blocked.label}: ${blocked.usedPercent.toFixed(1)}% used; cutoff ${blocked.cutoffPercent.toFixed(1)}%.` : `Weekly usage is below the ${pace}% pace cutoff.` };
}
