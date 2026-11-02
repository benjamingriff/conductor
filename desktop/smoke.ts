// Executed only by the explicit smoke command inside an isolated application profile.
// It exercises the real sandbox/preload/main/SQLite path without triggering T3.
export async function rendererSmoke() {
  const bridge = window.conductor!;
  const request = async (path: string, method = 'GET', body?: unknown): Promise<any> => {
    const result = await bridge.request(path, method, body); if (!result.ok) throw new Error(result.error); return result.value;
  };
  const initial = await request('/state');
  if (initial.settings.enabled) throw new Error('Smoke profile must start paused');
  await request('/settings', 'PATCH', { targetPace: 80 });
  if ((await request('/state')).settings.targetPace !== 80) throw new Error('Pace persistence failed');
  await request('/settings', 'PATCH', { targetPace: 110 });
  const invalid = await bridge.request('/settings', 'PATCH', { targetPace: 201 });
  if (invalid.ok) throw new Error('Invalid pace accepted');
  const account = initial.accounts[0];
  const hook = await request('/webhooks', 'POST', { name: 'Smoke worker', group: 'Desktop checks', url: 'http://127.0.0.1:1/private-smoke-token', accountIds: [account.id], enabled: true });
  const schedule = await request(`/webhooks/${hook.id}/schedules`, 'POST', { enabled: true, intervalMinutes: 30, start: '22:00', end: '06:00', timezone: 'Europe/London', nights: [0,1,2,3,4,5,6] });
  const saved = await request('/state');
  if (JSON.stringify(saved).includes('private-smoke-token')) throw new Error('State exposes webhook capability URL');
  if (saved.webhooks[0].schedules[0].intervalMinutes !== 30) throw new Error('Schedule persistence failed');
  await request(`/schedules/${schedule.id}`, 'DELETE'); await request(`/webhooks/${hook.id}`, 'DELETE');
  const tabs = [...document.querySelectorAll<HTMLButtonElement>('[role=tab]')];
  for (const tab of tabs) {
    tab.click(); await new Promise(r => setTimeout(r, 80));
    if (!document.querySelector('[role=tabpanel]')) throw new Error('Tab content missing');
    if (document.documentElement.scrollWidth > innerWidth) throw new Error('Layout overflows');
  }
  tabs[0]?.click(); await new Promise(r => setTimeout(r, 100));
  const add = [...document.querySelectorAll<HTMLButtonElement>('button')].find(b => b.textContent?.trim() === 'Add webhook');
  if (!add) throw new Error('Add webhook control missing');
  add.click(); await new Promise(r => setTimeout(r, 100));
  const dialog = document.querySelector<HTMLDialogElement>('dialog[open]');
  if (!dialog || !dialog.contains(document.activeElement)) throw new Error('Webhook dialog did not open and receive focus');
  dialog.querySelector<HTMLButtonElement>('[aria-label="Close dialog"]')!.click();
  await new Promise(r => setTimeout(r, 200));
  if (document.querySelector('dialog[open]')) throw new Error('Webhook dialog did not close');
  return { bridge: true, nodeHidden: typeof (window as any).require === 'undefined', accounts: initial.accounts.length, overflow: document.documentElement.scrollWidth > innerWidth, title: document.title, version: (await bridge.desktop('info')).version, configurationCrud: true, capabilityMasking: true, paceValidation: true, tabs: tabs.length, dialogFocus: true };
}
