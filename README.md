# Conductor

An Electron desktop app for scheduling T3 Code webhooks around your weekly subscription budget. React renders the interface; the Electron main process owns SQLite, quota checks, and scheduling. Installed builds need no Node installation or local web server.

## Use

Open **Conductor** from the application launcher, or run `conductor`.

1. Check your Codex/Claude usage accounts in Settings. They read existing local CLI logins; no credentials are copied and no agent turn is started.
2. Add a named webhook URL from a T3 Code task and select its usage account(s). Prompts, models, worktrees and reviews stay in T3.
3. Add a schedule. Defaults: every 30 minutes, 22:00–06:00, Europe/London, every night. UK daylight saving is handled automatically.
4. Check gates, then resume scheduling. New installations start paused.

Closing the window hides it to the tray. Reopen from the tray or launcher. **Quit Conductor** stops scheduling. **Launch at login** is in Settings and enabled on the first Linux installation. The app must be running in a logged-in desktop session; it does not run before login, wake the machine, or replay missed slots. T3 must also be available to receive webhooks. Already admitted T3 work may finish after 06:00.

## Develop alongside the installed app

Requires Node 24, npm, a graphical desktop, and the local provider CLIs for real usage readings.

```sh
npm ci
npm run dev
```

This opens **Conductor Dev**, with Vite renderer hot reload and separate development data. Restart the command after changing main-process code. Editing this checkout does not change the installed release or its schedules. Development starts with no webhooks and cannot change the installed app's login setting.

Some npm installations require approving dependency install scripts. If Electron was not downloaded, run `node node_modules/electron/install.js` after reviewing the dependency. Keep Electron's Chromium sandbox enabled.

## Build, install and update locally

On Linux:

```sh
npm test
npm run build
npm run package
npm run test:packaged
npm run install:desktop
```

The installer opens the app, adds its launcher and application entry, and enables login startup on first install. No root access is needed. It copies the complete app, including Electron, into a versioned release outside this checkout. It stops/disables the older **Conductor-managed** systemd service if present, takes a private offline SQLite backup, then switches the installed release. Existing settings, webhooks, schedules, pause state and history are retained. Other services and user lingering are untouched.

For the normal edit → release workflow:

```sh
npm run ship -- patch
# or: npm run ship -- minor
```

This runs checks, bumps package/package-lock versions without a git tag or commit, builds, packages, runs the native packaged smoke check, installs and opens the release. A failed build does not switch the installed app. Previous release directories and pre-upgrade database backups are retained. Version bumps remain in the working tree if a later packaging/install step fails.

Installation paths:

| Item | Location |
| --- | --- |
| Stable launcher | `~/.local/bin/conductor` |
| Releases and current symlink | `$XDG_DATA_HOME/conductor-desktop/` (default `~/.local/share`) |
| Application entry | `$XDG_DATA_HOME/applications/conductor.desktop` |
| Login entry | `$XDG_CONFIG_HOME/autostart/conductor.desktop` (default `~/.config`) |
| Installed data | `$XDG_STATE_HOME/conductor/` (default `~/.local/state`) |
| Development data | `$XDG_STATE_HOME/conductor-dev/` |
| App diagnostics | installed data directory, `desktop.log` |

To restore an older **app version**, quit Conductor, repoint `current` to the desired release under `releases`, then launch again. Database backups are separate; do not copy an old database over running SQLite. This release uses the existing database format.

macOS: `npm run build && npm run package` on a Mac produces a native `.app`; copy it to `~/Applications`. macOS data lives under the Electron user-data directory. Signing, notarization, login registration and native Mac execution have not been validated here. The automated local installer and `ship` currently target Linux.

## Weekly gate

Target pace is configurable from 1–200%, default 110%, with per-account overrides.

```
steady budget = fraction of the provider's current weekly window already passed
cutoff = min(100%, steady budget × target pace / 100)
```

Halfway through a weekly allowance, 110% permits starts below 55% used; 80% permits below 40%. Consumption at or above the cutoff blocks new sends. Every reported weekly bucket for every selected account must qualify. Session limits do not gate starts. T3 owns continuation after an admitted webhook; Conductor does not recheck running threads.

Readings are refreshed at most every five minutes while the app is running or a scheduled request needs them. Concurrent reads share a probe; failed automatic reads have a one-minute backoff. Manual refresh bypasses it. Missing, invalid or stale readings block starts. Choose accounts matching the workflow's actual T3 provider login.

## Scheduling and delivery

The scheduler ticks every 15 seconds, accepts up to 30 seconds of ordinary scheduling jitter, and skips gaps longer than 60 seconds. Resume from sleep resets the scheduling clock. Friday overnight schedules include Saturday morning; the end time is excluded. Repeated autumn wall-clock slots are claimed once, and missing spring times are skipped.

SQLite durably claims each slot. Activity distinguishes **Dispatched**, **Skipped**, **Failed**, and **Unknown**. A successful HTTP response confirms webhook acceptance, not task/PR completion. A timeout or restart during an uncertain POST is never automatically retried. Future ordinary slots still run. Only one delivery is in flight per webhook; this does not prevent overlapping T3 agent work. Configure worker overlap handling in T3/your skills.

Global pause persists across restarts and prevents new sends. It cannot recall an HTTP request already started. Deleting configuration preserves history. Webhook capability URLs are stored locally and masked in the dashboard/activity. Keep database backups private.

## Architecture and verification

- `desktop/main.ts`: lifecycle, tray, login startup and validated IPC; sandboxed renderer, context isolation, no Node integration, denied navigation/popups/permissions.
- `desktop/preload.cjs`: narrow request/settings bridge. Installed builds load bundled files with a content security policy and open no HTTP listener.
- `server/controller.ts`: shared validated application operations.
- `server/{scheduler,gates,schedule,usage,storage}.ts`: scheduling, pace policy, CLI quota readers and SQLite.
- `scripts/`: development, packaging, isolated native smoke checks and local installation.

```sh
npm run check
npm test
npm run test:desktop     # requires a built app and a graphical session
npm run test:packaged    # requires npm run package
```

Tests cover usage gates, both UK DST transitions, durable claims/recovery, pause races, no catch-up after sleep, API validation, masking, HTTP delivery to a disposable local receiver, and the shared Linux state lock. The native Electron smoke check uses temporary data, exercises the real sandbox → preload → main → SQLite path, configuration CRUD, all tabs, dialog focus, close-to-tray/reopen, and captures the actual window. It never sends a T3 webhook. No headless CI display is assumed.

Optional environment overrides: `CONDUCTOR_CODEX_BIN`, `CONDUCTOR_CLAUDE_BIN`, `CODEX_HOME`, `CLAUDE_CONFIG_DIR`, `CONDUCTOR_STATE_DIR`. Per-account homes override the initial CLI home. A Linux kernel lock rejects a second scheduler against the same data directory. The legacy HTTP adapter remains available for development with `npm run dev:web`, but is not launched by the desktop app.

`PROPOSAL.md`, `ui-proposal.html` and `pace-explorer.html` are historical design artifacts.
