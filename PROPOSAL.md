# Conductor: local webhook scheduler

Revised 16 October 2026. Setup and UI proposal; no live schedules or OS services are enabled.

## Scope

A Vite + React dashboard for named T3 webhook URLs, recurring schedules, and configurable weekly usage gates. A local Node service runs continuously. T3 owns the prompts, models, skills, project/worktree configuration, threads, reviews, and session-limit continuation.

Conductor's job ends at the webhook response. There is no thread tracking, backlog inspection, recovery hook, or lifetime worker lock in this version. “Name combos” means a friendly name paired with a URL; actual git worktrees remain configured in T3.

## What runs

**Daily use: one Node process under a systemd user service.** It serves the built React app and JSON API at `http://localhost:4317`, runs the scheduler, reads weekly usage, sends webhooks, and writes SQLite history. Closing the browser has no effect on scheduling.

**Development: Vite on 5173 and the backend on 4317.** Vite proxies API calls to the backend. Daily use serves the output of `vite build` from Node; it does not depend on a running development server. [Vite production build documentation](https://vite.dev/guide/build.html)

Use TypeScript, React, Vite, a small Node HTTP API, SQLite, and a timezone-aware scheduling library. Resolve and pin dependencies during implementation; the installed Node 24 is the initial runtime. No Redis, queue server, Electron shell, or cron entry per workflow.

Keep mutable data outside the checkout at `$XDG_STATE_HOME/conductor/conductor.sqlite`, falling back to `~/.local/state/conductor/conductor.sqlite`. Store operational logs in the systemd journal; expose a health endpoint with a scheduler heartbeat.

## Named webhooks

Each record has a friendly name, HTTP(S) URL, optional project/group label, selected usage account(s), and enabled flag. Example: `Askesis / Next ticket`. URLs are masked outside the editor and redacted from logs.

Add one or more schedules beneath each webhook. A URL's prompts, models, fresh/bound-thread behavior, and worktree setup remain configured in T3. Conductor sends a simple JSON POST; optional dispatch/slot metadata needs no prompt changes for basic operation. Do not also enable an interval in T3 for the same workflow.

The account selection is explicit because Conductor cannot infer the subscription from a URL. Where a workflow uses several known accounts, select all and require all their initial weekly gates to pass. Subsequent phases are entirely T3's responsibility.

Actions: add/edit webhook, enable/disable, add/edit schedule, **Check gates** without sending, and **Run now** through the same gates. A real test is clearly labelled because it starts the T3 workflow. Saving or validating a URL never sends a request.

## Configurable target pace

**Target pace** is an editable percentage of the steady weekly allowance. Default 110%, with 80%, 100%, and 110% presets, a slider, and numeric input. Suggested slider range 50–150%; numeric input allows 1–200%. Store a global default and optional per-account overrides; show each account's effective value. Changes affect future decisions immediately.

For each relevant weekly bucket of each selected account:

```text
steadyBudgetPercent = 100 × (now - windowStart) / windowDuration
cutoffPercent = min(100, steadyBudgetPercent × targetPacePercent / 100)

allow if usedPercent < cutoffPercent
skip at/above cutoff or when weekly allowance is exhausted
```

Use the provider's actual reset window, not a Monday assumption. Use a documented small numeric tolerance at equality. At the instant a window resets there is no accumulated budget; evaluation becomes eligible once budget accumulates. Expired or invalid account/reset/duration data means skip.

Halfway through the provider's week, 110% gives a 55% allowance cutoff; 80% gives 40%. There is no additional reserve. Consumption uses the provider's authoritative weekly percentage, not API cost or reconstructed raw token counts. Separate subscriptions are not averaged.

Refresh before a due send when the snapshot is older than five minutes; share one bounded refresh across simultaneous requests for the same account. Missing/unavailable/failed readings skip that slot and display the reason. A failed refresh does not fall back to an old successful admission. Show observation age and offer manual refresh.

The remaining integration work is a narrow local usage adapter. Reuse T3's quota-reading/normalisation behavior, with attribution: prefer an existing authenticated local read interface if practical, otherwise reuse provider probes without an agent turn. First prove fresh Codex and/or Claude readings against the configured account identity. No T3 thread correlation or recovery hook is required.

## Schedules and gates

Each schedule stores an enabled flag, interval in minutes, selected nights, start/end time, and timezone. Default: every 30 minutes, daily, 22:00–06:00, `Europe/London`. Start with intervals and overnight windows; arbitrary cron and one-off alarms can follow later.

Slots are anchored to the window start: 22:00, 22:30, …, 05:30. 06:00 is excluded. Selected days refer to the night beginning that day: Friday includes Saturday before 06:00. Explain this beside the day picker.

Store timestamps in UTC and calculate slots in the configured timezone. A unique intended local-slot key prevents duplicate sends for repeated autumn clock times; nonexistent spring slots are skipped. Save schedule edits transactionally and recompute future slots without deleting history.

Suggested examples:

- Next-ticket worker: every 30 minutes, 22:00–06:00.
- Reliability discovery: every two hours, 22:15–06:00, producing 22:15, 00:15, 02:15, 04:15.
- Other discovery skills: independent named T3 webhook tasks with staggered start times or selected nights. No discovery rotation engine is needed initially.

Each slot checks global enabled state, webhook/schedule toggles, window/day, fresh weekly usage, and whether the slot is already claimed. Persist the claim before sending and recheck pause/window immediately before POST. Denied slots are skipped rather than queued.

Only one HTTP send may be in flight per webhook. This is not a lock spanning the T3 workflow. Later slots may send again even if T3 is still working; the configured T3 task and its skills handle overlap.

**Run now** obeys all gates, including the overnight window. **Check gates** never sends and is available at any time.

## On/off and running work

The header has a prominent **Pause scheduling / Resume scheduling** button. Persist pause state in SQLite before acknowledging it; it survives browser refreshes, crashes, reboots, and updates. New installations start paused.

Pause stops new sends; it cannot recall a request already accepted by T3. It does not interrupt threads. Per-webhook and per-schedule toggles control individual jobs. Resume waits for the next slot and never releases missed work in a batch.

After T3 accepts a webhook, Conductor leaves it alone. A task starting at 05:59 may continue through the morning, exhaust weekly allowance, and resume after a session reset. This is explicitly accepted. Native T3 auto-resume is configured in T3 and is not enforced here.

## Service lifecycle

Use `conductor.service` as a systemd user service with `Restart=on-failure` and `RestartSec=5`. Its start command uses a resolved absolute Node path and the built backend entry, independent of an interactive shell or browser. Install/enable it during implementation; this proposal does not change system configuration.

Enable the service at login. For operation before login and after logout, enable user lingering once: the user manager then starts at boot and persists after logout. Show the actual startup/linger status in the dashboard. Starting Conductor does not start T3; T3 must also be available for execution. Linger behavior was checked against the installed `loginctl` manual. [Official documentation source](https://github.com/systemd/systemd/blob/main/man/loginctl.xml)

Operational commands after installation:

```sh
systemctl --user enable --now conductor.service
systemctl --user status conductor.service
journalctl --user -u conductor.service
systemctl --user restart conductor.service
systemctl --user stop conductor.service
```

The scheduler polls about every fifteen seconds but calculates due wall-clock slots from SQLite rather than relative process timers. Allow a short lateness margin for ordinary event-loop jitter. Detect startup or a substantial clock/sleep gap, skip missed slots, and advance to the next future one. Never replay overnight work on a morning restart. The app cannot run while the machine is off or asleep and will not wake the machine.

On SIGTERM, stop admitting sends, wait a bounded time for in-flight requests, flush history, and close SQLite. Use an OS process lock plus database slot uniqueness to avoid accidentally running two schedulers.

A successful HTTP response is **Dispatched**, not a completed task/PR. Outcomes are `dispatched`, `skipped` with reason, `failed` for a definite rejection, and `unknown` when timeout/crash leaves delivery uncertain. Recover pre-send claims as skipped; potentially sent claims become unknown. Do not automatically retry ambiguous sends because another POST can create another T3 thread. Wait for the next ordinary slot.

This provides durable scheduling without claiming exactly-once delivery across HTTP. Prefer the direct local webhook route on the same host. A public T3 relay can queue accepted requests independently; use short delivery age where available. Conductor controls when it sends, not the eventual start time of a queued T3 task. That limitation is accepted rather than adding prompt changes or T3 runtime hooks.

## UI proposal

Black panels, charcoal outlines, white main text, muted grey labels, and restrained green/amber status colors. No gradients or illustrations. Touch-friendly controls; stack cards on narrow screens. `ui-proposal.html` is an interactive design prototype with sample data only.

**Overview:** global pause, next overnight window, weekly account cards, editable target pace/presets, and named webhook cards showing interval, window, next slot, selected account gate, enable toggle, and schedule edit. Keep global pause, outside-window, and over-pace states distinct.

**Webhook editor:** name, URL, optional group, account selection, enabled state. No prompt/model editor. **Schedule editor:** interval, nights, start/end time, timezone, explanatory summary, and eventually the next few eligible slots.

**Activity:** timestamp, webhook name, outcome, and concrete gate or response. Examples: “Skipped: 58.4% used; cutoff 55%,” “Dispatched: HTTP 202,” and “Unknown: response timed out; no retry.” No implied agent completion.

**Service:** API heartbeat, startup/linger status, last restart, data path, local address, and provider-reading health. Explain backend offline clearly. Distinguish pausing scheduling from stopping the OS service.

Loopback is local to this machine. A phone's localhost means the phone itself; phone access later needs an explicitly configured private-network proxy/binding. Design responsively now without claiming the loopback address is remotely accessible.

## Data and build order

SQLite stores global settings, usage accounts/optional pace overrides and observations, webhooks, schedules, and dispatches with unique slot IDs, timestamps, effective policy/gate snapshots, and redacted outcomes. Changing a target pace must not rewrite old decision history.

1. Prove fresh quota reads for the actual configured local provider accounts.
2. Build React UI, backend API, SQLite persistence, and configurable gates; default paused.
3. Add scheduling and webhook sending, first using a disposable receiver. Check cutoff equality, stale readings, pause races, DST, HTTP timeout, duplicate claims, and restart without replay.
4. Build/package under the systemd user service; exercise restart and persisted pause. Document linger and T3 availability, then add real URLs and enable chosen schedules.

This replaces the earlier thread-aware orchestration design. Worktrees, execution, reviews, session limits, and completion remain in T3.
