export type Provider = 'codex' | 'claude';
export interface UsageWindow { id: string; label: string; kind: 'weekly' | 'session'; usedPercent: number; resetsAt: string | null; durationMinutes: number; }
export interface UsageSnapshot { checkedAt: string; status: 'ok' | 'error'; error: string | null; identity: string | null; windows: UsageWindow[]; }
export interface UsageAccount { id: string; provider: Provider; name: string; homePath: string; paceOverride: number | null; snapshot: UsageSnapshot | null; }
export interface Schedule { id: string; webhookId: string; enabled: boolean; intervalMinutes: number; start: string; end: string; timezone: string; nights: number[]; revision: number; createdAt: string; }
export interface Webhook { id: string; name: string; group: string; maskedUrl: string; accountIds: string[]; enabled: boolean; schedules: Schedule[]; }
export interface Settings { enabled: boolean; targetPace: number; revision: number; }
export interface WindowGate { id: string; label: string; usedPercent: number; budgetPercent: number; cutoffPercent: number; resetsAt: string; allowed: boolean; }
export interface AccountGate { accountId: string; accountName: string; allowed: boolean; reason: string; effectivePace: number; windows: WindowGate[]; }
export interface GateResult { allowed: boolean; reason: string; accounts: AccountGate[]; }
export type DispatchOutcome = 'checking' | 'sending' | 'dispatched' | 'skipped' | 'failed' | 'unknown';
export interface Dispatch { id: string; webhookId: string; webhookName: string; scheduleId: string | null; intendedAt: string; createdAt: string; finishedAt: string | null; outcome: DispatchOutcome; reason: string; httpStatus: number | null; gate: GateResult | null; policyRevision: number; }
export interface ServiceInfo { startedAt: string; heartbeatAt: string | null; dataPath: string; port: number; startup: string; lingering: boolean; uptimeSeconds: number; version: string; }
export interface Dashboard { settings: Settings; accounts: UsageAccount[]; webhooks: Webhook[]; activity: Dispatch[]; service: ServiceInfo; now: string; }
export interface Slot { at: string; key: string; local: string; }
