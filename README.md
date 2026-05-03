# Obsidian Google Calendar Sync

## Overview

Obsidian Google Calendar Sync is a plugin for Obsidian that syncs your Obsidian Tasks to Google Calendar as events. It is currently only a one way sync from Obsidian to Google Calendar. The plugin supports syncing reminders, task start/end times, full mobile support and has auto-sync functionality. There's also a repair option which will strip all events in Google Calendar created by this plugin and recreate them, which can be helpful if you experience inconsistencies in the sync process. You can configure a bunch of options in the settings such as default reminder time, limit sync to specific folders/files and optional verbose logging

A quick note on metadata and task IDs: 

The plugin uses IDs in the form of HTML comments included as part of the task content in order to reliably  and persistently track tasks across different lines, files, app reboots or even across vaults. The IDs are only added to tasks that actually sync — i.e. tasks containing a `📅 YYYY-MM-DD` date. Undated `- [ ]` tasks (scratch lists, notes, anything that's not a calendar candidate) are left alone, and the moment you add a date to a previously-untagged task an ID is injected. Throughout your editing the ID will always be pushed to the end of the line for clarity. The IDs themselves are protected so you don't accidentally delete them, however they are deletable if you delete the entire task line (this is by design). The IDs are saved into the metadata, which itself lives in the plugin settings along with your oauth tokens. This keeps your task metadata and auth status consistent across sessions and devices.

In Live Preview / Source mode the ID is displayed as a small monospace pill (e.g. `id:abc123…`) by default — see the **Task ID Display** setting below to show the full HTML comment, truncate it, or hide it entirely. The raw text in the file is unchanged regardless of which mode you pick.

## Installation

### Requirements
[Obsidian Tasks](https://github.com/obsidian-tasks-group/obsidian-tasks)

### Installing the Plugin
Currently the plugin has not been added to the Obsidian Community plugins yet, this will happen after some testing and feedback from early users

#### Manual Installation
1. Download the latest release from [GitHub Releases](https://github.com/sasoon/obsidian-gcal-sync/releases)
2. Extract the zip file into your Obsidian vault's `.obsidian/plugins/` directory
3. Restart Obsidian and enable the plugin in Settings > Community Plugins

## Authentication & Setup

This fork requires you to supply your own Google Cloud OAuth credentials. There are no built-in credentials — this gives you full control over your own API project and avoids "This app is blocked" warnings.

### Creating Google Cloud credentials
1. Go to [Google Cloud Console](https://console.cloud.google.com/)
2. Create a new project (or select an existing one)
3. Enable the **Google Calendar API** (APIs & Services → Library → search "Google Calendar API")
4. Go to **Credentials** → **Create Credentials** → **OAuth client ID**
5. Choose **Desktop app** as the application type
6. Copy the **Client ID** and **Client Secret** into the plugin settings (Settings → Google Calendar Sync → Google OAuth Credentials)

### Desktop Setup (Windows, macOS, Linux)
1. Enter your Client ID and Client Secret in the plugin settings
2. Click the plugin icon in the ribbon
3. The plugin will open your browser for authentication
4. A local web server will handle the OAuth callback (port 8085)
5. Grant the requested permissions
6. Return to Obsidian — you should see a success message
7. Your tasks will now sync with Google Calendar

### Mobile Setup (iOS, Android)
1. Enter your Client ID and Client Secret in the plugin settings (or authenticate on desktop first and sync your vault data via Obsidian Sync / git)
2. Click the plugin icon in the ribbon
3. The plugin will open your browser for authentication
4. After authorising, you’ll be redirected back to Obsidian
5. The plugin will complete authentication and show a success message
6. Your tasks will now sync with Google Calendar

## Usage

### Basic Usage
1. Create tasks in Obsidian using the checkbox syntax `- [ ] Task description 📅 2026-05-04`
2. The plugin will automatically add a task ID to the end of each dated task line (undated tasks are ignored — they get a tag the moment you add a date)
3. Tasks will sync to Google Calendar based on your settings
4. Changes to task descriptions, dates, or completion status will sync automatically
5. If you have a vault full of pre-existing dated tasks that have never been tagged, run a manual sync from the ribbon — the **Backfill task IDs on sync** setting (on by default) will tag all of them in one pass

![image](https://github.com/user-attachments/assets/aa9d9790-7cb5-4d5f-be0e-c38c47edff3b)


### Date and Time Formats
The plugin recognizes these date formats in your tasks:
- `📅 YYYY-MM-DD` - Task date without time
- `⏰ HH:MM` - Start time
- `➡️ 15:30` - End time
- `📅 YYYY-MM-DD ⏰ HH:MM` - Task date with time
- `⏳ YYYY-MM-DD` - Start date for tasks with a duration

### Reminders
- Set a reminder with `🔔XX` where XX is the time before the task. It accepts minutes, hours and days in the following syntax: `🔔25m`, `🔔9h`, `🔔3d`. Make sure the reminder follows the emoji with no space in between them. The reminder can be anywhere in the task
- Example: `- [ ] Buy keyboard 🔔1d 📅 2025-03-04`
- If no reminder value is specified, the default reminder time from settings is used

### Configuration Options
In the plugin settings, you can:
- Enable/disable auto-sync
- **Calendar ID** — which Google Calendar to sync into. Defaults to `primary` (your default calendar). To target a different calendar, paste its ID from Google Calendar → that calendar's settings → "Integrate calendar" → "Calendar ID" (e.g. `you@gmail.com` for the primary, or a long `…@group.calendar.google.com` for secondary calendars). Note: changing this does not migrate events that were already synced to the previous calendar — they remain there until you manually clean them up
- Set a default reminder time (in minutes)
- **Task ID Display** — controls how the `<!-- task-id: ... -->` comment renders in Live Preview / Source mode. Choose `Truncate` (default, shows `id:abc123…`), `Show full comment`, or `Hide entirely`. The underlying file is unchanged
- **Backfill task IDs on sync** (on by default) — when you run a full sync, the plugin first scans every matching file and tags any dated, un-IDed tasks before syncing. Without this, only tasks you've actively edited get tagged
- Limit sync to specific folders
- Enable verbose logging for troubleshooting
- Adjust mobile optimizations and file scan limits

![image](https://github.com/user-attachments/assets/93756ab2-ef72-40ba-9d26-410cee7335c3)


### Ribbon
The plugin adds a ribbon on desktop and mobile which can be used to initiate a manual sync, toggle auto-sync, repair and disconnect from Google Calendar. The auto-sync will sync your changes to Gcal on demand. If you experience a sync disruption of any kind, run the repair command to strip your Gcal of Obsidian Tasks and recreate them. This should generally fix most desynchronization issues. Disconnect will delete your oauth tokens, and will prompt you to reconnect. The ribbon also acts as a status indicator on desktop, and will update dynamically to indicate sync status and active syncs

![image](https://github.com/user-attachments/assets/8d23e5da-224c-4f70-9a60-5b761b11d727)

![image](https://github.com/user-attachments/assets/af2f3c1c-fe60-463f-a23d-8c8134ecea55)

![image](https://github.com/user-attachments/assets/03ea4bc3-b8eb-4ddb-b0f0-82ffe3e09064)


## Security and Privacy

- **Your own credentials**: You supply your own Google Cloud project — no shared OAuth client IDs
- **OAuth 2.0 with PKCE**: Secure authentication without storing your Google password
- **Local Token Storage**: OAuth tokens are stored only in your Obsidian vault settings
- **No External Data Storage**: The plugin only communicates directly with Google APIs

## Support

For issues, questions, or feature requests, please visit the [GitHub repository](https://github.com/sasoon/obsidian-gcal-sync).

## License

GNU General Public License v3.0 (GPL-3.0)
