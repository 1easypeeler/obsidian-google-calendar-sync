# Obsidian Google Calendar Sync

A fork of [sasoon/obsidian-gcal-sync](https://github.com/sasoon/obsidian-gcal-sync) with a full security overhaul and several quality-of-life additions. See [Differences from upstream](#differences-from-upstream) for a summary of what changed and why.

## Overview

This plugin syncs Obsidian Tasks to Google Calendar as events — one-way, from Obsidian to Google Calendar. Core capabilities:

- Automatic sync on task creation or modification
- Manual sync, repair, and disconnect via the ribbon
- Task dates, start/end times, and per-task reminders
- Configurable target calendar (any calendar in your Google account, not just the default)
- Selective folder sync

### How task IDs work

The plugin tracks tasks using HTML comments embedded at the end of each task line (e.g. `<!-- task-id: abc12345 -->`). Key behaviours:

- **Only dated tasks get an ID.** A task must contain `📅 YYYY-MM-DD` to be tagged. Plain `- [ ]` items are left untouched.
- **Adding a date tags the task immediately.** The moment you type a date onto a previously-untagged line, an ID is injected.
- **IDs are always at the end of the line** and are protected from accidental deletion — they can only be removed by deleting the entire task line.
- **Backfill on sync.** Running a manual sync will tag all pre-existing dated-but-untagged tasks in one pass (on by default, configurable).
- **Configurable display.** In Live Preview / Source mode the ID renders as a small `id:abc123…` pill by default. You can show the full comment, truncate it, or hide it entirely — the file on disk is unchanged regardless.

---

## Requirements

- [Obsidian Tasks](https://github.com/obsidian-tasks-group/obsidian-tasks) community plugin
- Your own Google Cloud project with the Calendar API enabled (see setup below)

---

## Installation

1. Download `google-calendar-sync.zip` from the [latest release](https://github.com/1easypeeler/obsidian-gcal-sync/releases/latest)
2. Extract the zip into `<vault>/.obsidian/plugins/` — this creates the `google-calendar-sync` folder with all required files
3. Restart Obsidian and enable the plugin under Settings → Community Plugins

---

## Setup

This plugin requires your own Google Cloud OAuth credentials. There are no shared or bundled credentials — this keeps your data entirely within your own Google project and avoids "This app is blocked" warnings from Google.

### 1. Create Google Cloud credentials

1. Go to [Google Cloud Console](https://console.cloud.google.com/)
2. Create a new project (or select an existing one)
3. Enable the **Google Calendar API** — APIs & Services → Library → search "Google Calendar API"
4. Go to **Credentials** → **Create Credentials** → **OAuth client ID**
5. Choose **Desktop app** as the application type
6. Note your **Client ID** and **Client Secret**

### 2. Enter credentials in Obsidian

1. Open Settings → Google Calendar Sync → **Google OAuth Credentials**
2. Paste your Client ID and Client Secret into the respective fields
3. Click **Save credentials** — the secret is encrypted before being written to disk
4. To update the secret later, enter the new value and click **Save credentials** again
5. To remove the secret from this device, use **Clear saved Client Secret**

> After changing credentials, disconnect your Google account and restart Obsidian (or disable and re-enable the plugin) before reconnecting.

### 3. Authenticate

1. Click the plugin icon in the ribbon
2. Your browser will open for OAuth authorisation
3. Grant the requested permissions
4. A local callback server on port 8085 completes the handshake
5. Return to Obsidian — a success notice confirms authentication

---

## Task syntax

```
- [ ] Task description 📅 2026-05-04
- [ ] Task with time 📅 2026-05-04 ⏰ 09:00 ➡️ 10:00
- [ ] Task with reminder 🔔1d 📅 2026-05-04
- [ ] Task with start date ⏳ 2026-05-01 📅 2026-05-04
```

| Marker | Meaning |
|---|---|
| `📅 YYYY-MM-DD` | Task date — required for sync |
| `⏰ HH:MM` | Start time |
| `➡️ HH:MM` | End time |
| `⏳ YYYY-MM-DD` | Start date (for multi-day tasks) |
| `🔔Xm` / `🔔Xh` / `🔔Xd` | Reminder — X minutes, hours, or days before the event |

If no reminder is specified, the default reminder time from settings is used.

---

## Configuration

All settings are under Settings → Google Calendar Sync.

### Sync Settings

| Setting | Description |
|---|---|
| **Auto-sync** | Automatically sync tasks when they are created or modified |
| **Folders to Sync** | Restrict scanning to specific folders, one per line. Leave empty to scan the entire vault |

### Calendar Settings

| Setting | Description |
|---|---|
| **Calendar ID** | Which Google Calendar to sync into. Defaults to `primary`. To use a different calendar, paste its ID from Google Calendar → that calendar's settings → Integrate calendar (e.g. `you@gmail.com` or `abc123@group.calendar.google.com`). Note: changing this does not migrate events already synced to the previous calendar |
| **Default Reminder** | Reminder time in minutes applied to events that have no task-level reminder |
| **Task ID Display** | How `<!-- task-id: ... -->` renders in Live Preview / Source mode: `Truncate` (default — shows `id:abc123…`), `Show full comment`, or `Hide entirely`. The file on disk is unchanged |
| **Backfill task IDs on sync** | On a full sync, scan all matching files and tag any dated, un-IDed tasks before syncing. On by default |
| **Verbose Logging** | Write detailed debug output to the developer console |

### Google OAuth Credentials

| Setting | Description |
|---|---|
| **Client ID** | Your Google OAuth Client ID |
| **Client Secret** | Your Google OAuth Client Secret. Stored encrypted. Leave blank to keep the existing saved value |
| **Save credentials** | Persist the Client ID and Client Secret. The secret is encrypted before being written to disk |
| **Clear saved Client Secret** | Remove the encrypted secret from this device (only shown when a secret is saved) |

---

## Ribbon

The ribbon icon provides access to:

- **Sync** — push all pending changes to Google Calendar immediately
- **Toggle auto-sync** — enable or disable automatic syncing
- **Repair** — wipe all plugin-created events from Google Calendar and recreate them from the current vault state. Use this to resolve sync inconsistencies
- **Disconnect** — delete stored OAuth tokens and prompt for re-authentication

The icon updates dynamically to reflect current sync status.

---

## Security and Privacy

- **Your own credentials** — no shared OAuth client IDs; your data stays within your own Google project
- **OAuth 2.0 with PKCE** — Proof Key for Code Exchange (S256) prevents authorisation code interception on the loopback redirect
- **Encrypted credential storage** — the Client Secret is encrypted via the OS keychain (Electron `safeStorage`: macOS Keychain, Windows DPAPI, Linux libsecret). OAuth tokens follow the same path
- **No external proxies** — the OAuth flow goes directly between Obsidian and Google; no third-party relay servers are involved
- **Credential-safe logging** — tokens, secrets, and authorisation codes are scrubbed before anything is written to the developer console
- **Startup token validation** — on launch the plugin silently probes whether stored tokens are still valid and clears them cleanly if revoked, prompting re-authentication rather than failing silently

---

## Differences from upstream

This fork diverges from [sasoon/obsidian-gcal-sync](https://github.com/sasoon/obsidian-gcal-sync) in the following areas.

### New features

| Feature | Detail |
|---|---|
| Configurable calendar | Target any Google Calendar by ID, not just `primary` |
| Task ID display modes | Show, truncate, or hide the `<!-- task-id -->` comment in the editor without changing the file |
| Backfill on sync | Tag all pre-existing dated-but-untagged tasks in one sync pass |
| Date-gated tagging | IDs are only added to tasks that contain a `📅` date — undated tasks are never touched |

### Security changes

| Area | Change |
|---|---|
| OAuth flow | Added PKCE (S256 challenge) and a per-session path nonce on the loopback redirect URI |
| Client Secret storage | Encrypted via OS keychain (`safeStorage`) on desktop; removed plaintext storage entirely |
| Token storage | Tokens encrypted with the same mechanism; legacy plaintext values are migrated on first load |
| Third-party relay | Removed the Netlify proxy fallback — no third-party server is involved in any code path |
| Credential logging | `LogUtils.redact()` scrubs all sensitive fields before anything is written to the console |
| Credential saves | Credentials are buffered in the UI and only written to disk on an explicit button click |
| Token validation | Startup probe clears tokens only on confirmed revocation (HTTP 400/401), not on transient network errors |
| Forced re-auth | Removed the 90-day forced re-authentication timer |

---

## License

GNU General Public License v3.0 (GPL-3.0)
