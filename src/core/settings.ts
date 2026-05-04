import { App, PluginSettingTab, Setting } from 'obsidian';
import type GoogleCalendarSync from './main';
import { GoogleCalendarSettings } from './types';
import { useStore } from './store';
import { Notice } from 'obsidian';

// "primary" or an email-shaped ID (user calendars: you@gmail.com,
// secondary calendars: <hash>@group.calendar.google.com, holiday calendars:
// en.uk#holiday@group.v.calendar.google.com). The character class allows
// the few non-alphanumerics Google emits in calendar IDs (`._%+-#`).
function isValidCalendarId(id: string): boolean {
    if (id === 'primary') return true;
    return /^[A-Za-z0-9._%+\-#]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,}$/.test(id);
}

export const DEFAULT_SETTINGS: GoogleCalendarSettings = {
    clientId: '',
    clientSecret: '',
    oauth2Tokens: undefined,
    syncEnabled: true,
    defaultReminder: 30,
    calendarId: 'primary',
    taskIdDisplay: 'truncate',
    backfillIdsOnSync: true,
    includeFolders: [],  // Empty by default to scan all folders
    taskMetadata: {},
    taskIds: {},
    verboseLogging: false,
    hasCompletedOnboarding: true,  // Set to true to prevent welcome modal on startup
};

export class GoogleCalendarSettingsTab extends PluginSettingTab {
    plugin: GoogleCalendarSync;

    constructor(app: App, plugin: GoogleCalendarSync) {
        super(app, plugin);
        this.plugin = plugin;
    }

    display(): void {
        const { containerEl } = this;
        containerEl.empty();

        // Sync section (general settings go first without a heading per Obsidian guidelines)

        new Setting(containerEl)
            .setName('Auto-sync')
            .setDesc('Automatically sync tasks when they are created or modified')
            .addToggle(toggle => toggle
                .setValue(this.plugin.settings.syncEnabled)
                .onChange(async (value) => {
                    this.plugin.settings.syncEnabled = value;
                    useStore.getState().setSyncEnabled(value);
                    await this.plugin.saveSettings();
                    this.plugin.updateStatusBar();
                    new Notice(`Auto-sync ${value ? 'enabled' : 'disabled'}`);
                }));

        new Setting(containerEl)
            .setName('Folders to Sync')
            .setDesc('Specify folders to scan for tasks. One folder per line. Leave empty to scan all folders.')
            .addTextArea(text => text
                .setPlaceholder('folder1\nfolder2/subfolder')
                .setValue(this.plugin.settings.includeFolders.join('\n'))
                .onChange(async (value) => {
                    this.plugin.settings.includeFolders = value
                        .split('\n')
                        .map(folder => folder.trim())
                        .filter(folder => folder.length > 0);
                    await this.plugin.saveSettings();
                }));

        // Calendar section
        new Setting(containerEl).setName('Calendar').setHeading();

        new Setting(containerEl)
            .setName('Calendar ID')
            .setDesc('Google Calendar to sync tasks with. Use "primary" for your default calendar, or paste a calendar ID from Google Calendar > calendar settings > "Integrate calendar" (e.g. you@gmail.com or abc123@group.calendar.google.com). Events already synced to a different calendar are not migrated.')
            .addText(text => {
                // Buffer typing in onChange; validate and save on blur so users
                // don't get a Notice on every keystroke while mid-typing.
                let pending = this.plugin.settings.calendarId || 'primary';
                text.setPlaceholder('primary')
                    .setValue(pending)
                    .onChange(value => { pending = value.trim(); });

                text.inputEl.addEventListener('blur', async () => {
                    if (pending.length === 0) {
                        this.plugin.settings.calendarId = 'primary';
                        text.setValue('primary');
                        await this.plugin.saveSettings();
                        return;
                    }
                    if (!isValidCalendarId(pending)) {
                        new Notice('Invalid Calendar ID — expected "primary" or an email-shaped ID.');
                        text.setValue(this.plugin.settings.calendarId || 'primary');
                        return;
                    }
                    this.plugin.settings.calendarId = pending;
                    await this.plugin.saveSettings();
                });
            });

        new Setting(containerEl)
            .setName('Default Reminder')
            .setDesc('Default reminder time in minutes before the task (if no specific reminder is set)')
            .addText(text => text
                .setPlaceholder('30')
                .setValue(this.plugin.settings.defaultReminder.toString())
                .onChange(async (value) => {
                    const reminder = parseInt(value);
                    if (!isNaN(reminder) && reminder >= 0) {
                        this.plugin.settings.defaultReminder = reminder;
                        await this.plugin.saveSettings();
                    }
                }));

        new Setting(containerEl)
            .setName('Task ID Display')
            .setDesc('How to display the <!-- task-id: ... --> comment on synced task lines in Live Preview / Source mode. The raw text in the file is unchanged.')
            .addDropdown(dropdown => dropdown
                .addOption('show', 'Show full comment')
                .addOption('truncate', 'Truncate (e.g. id:abc123…)')
                .addOption('hide', 'Hide entirely')
                .setValue(this.plugin.settings.taskIdDisplay || 'truncate')
                .onChange(async (value) => {
                    this.plugin.settings.taskIdDisplay = value as 'show' | 'hide' | 'truncate';
                    await this.plugin.saveSettings();
                    this.plugin.refreshEditorExtensions();
                }));

        new Setting(containerEl)
            .setName('Backfill task IDs on sync')
            .setDesc('When you run a full sync, scan all matching files and add task IDs to any tasks that don\'t have one yet. Without this, tasks only get IDs when you actively edit a line.')
            .addToggle(toggle => toggle
                .setValue(this.plugin.settings.backfillIdsOnSync ?? true)
                .onChange(async (value) => {
                    this.plugin.settings.backfillIdsOnSync = value;
                    await this.plugin.saveSettings();
                }));

        new Setting(containerEl)
            .setName('Verbose Logging')
            .setDesc('Enable detailed debug logging (useful for troubleshooting)')
            .addToggle(toggle => toggle
                .setValue(this.plugin.settings.verboseLogging)
                .onChange(async (value) => {
                    this.plugin.settings.verboseLogging = value;
                    await this.plugin.saveSettings();
                }));

        // OAuth Credentials section
        new Setting(containerEl).setName('Google OAuth credentials').setHeading();

        const oauthDesc = containerEl.createEl('div', { cls: 'setting-item-description gcal-oauth-description' });

        oauthDesc.createEl('p', { text: 'This plugin requires your own Google Cloud OAuth credentials to authenticate with Google Calendar:' });
        const ol = oauthDesc.createEl('ol');
        const step1 = ol.createEl('li');
        step1.appendText('Go to ');
        step1.createEl('a', { text: 'Google Cloud Console', href: 'https://console.cloud.google.com/' });
        ol.createEl('li', { text: 'Create a new project (or select existing)' });
        ol.createEl('li', { text: 'Enable the Google Calendar API' });
        ol.createEl('li', { text: 'Go to "Credentials" \u2192 "Create Credentials" \u2192 "OAuth client ID"' });
        ol.createEl('li', { text: 'Choose "Desktop app" as the application type' });
        ol.createEl('li', { text: 'Copy the Client ID and Client Secret below' });
        const noteP = oauthDesc.createEl('p');
        noteP.createEl('strong', { text: 'Note:' });
        noteP.appendText(' After changing credentials, disconnect your Google account and restart Obsidian (or disable and re-enable the plugin) before reconnecting.');

        // Buffered credential inputs — values stay in DOM only and are
        // persisted to disk in a single saveSettings() call when the user
        // clicks "Save credentials". This prevents partially-typed secrets
        // from being snapshotted into Obsidian Sync / iCloud backup history.
        let pendingClientId = this.plugin.settings.clientId || '';
        let pendingClientSecret = ''; // Always blank initially; empty = keep existing

        new Setting(containerEl)
            .setName('Client ID')
            .setDesc('Your Google OAuth Client ID')
            .addText(text => text
                .setPlaceholder('xxxxxx.apps.googleusercontent.com')
                .setValue(pendingClientId)
                .onChange(value => { pendingClientId = value.trim(); }));

        const hasSavedSecret = this.plugin.authManager?.hasClientSecret() ?? false;
        new Setting(containerEl)
            .setName('Client Secret')
            .setDesc(hasSavedSecret
                ? 'A Client Secret is saved. Leave blank to keep the existing value.'
                : 'Your Google OAuth Client Secret. Stored encrypted via the OS keychain.')
            .addText(text => {
                text.setPlaceholder(hasSavedSecret ? '••••••••••••' : 'GOCSPX-xxxxxx')
                    .setValue('')
                    .onChange(value => { pendingClientSecret = value; });
                text.inputEl.type = 'password';
                text.inputEl.autocomplete = 'off';
            });

        new Setting(containerEl)
            .setName('Save credentials')
            .setDesc('Persist the Client ID and Client Secret. The Client Secret is encrypted before being written to disk.')
            .addButton(btn => btn
                .setButtonText('Save credentials')
                .setCta()
                .onClick(async () => {
                    if (!this.plugin.authManager) {
                        new Notice('Auth manager not ready yet — try again in a moment.');
                        return;
                    }
                    try {
                        this.plugin.settings.clientId = pendingClientId;
                        await this.plugin.saveSettings();
                        this.plugin.authManager.refreshClientId();

                        if (pendingClientSecret) {
                            await this.plugin.authManager.setClientSecret(pendingClientSecret);
                            pendingClientSecret = '';
                        }

                        new Notice('Credentials saved.');
                        this.display(); // Re-render to update the "saved" indicator
                    } catch (e) {
                        console.error('Failed to save credentials:', e);
                        new Notice('Failed to save credentials. Check the developer console.');
                    }
                }));

        if (hasSavedSecret) {
            new Setting(containerEl)
                .setName('Clear saved Client Secret')
                .setDesc('Remove the encrypted Client Secret from this device. You will need to re-enter it to sync.')
                .addButton(btn => btn
                    .setButtonText('Clear')
                    .setWarning()
                    .onClick(async () => {
                        if (!this.plugin.authManager) return;
                        await this.plugin.authManager.clearClientSecret();
                        new Notice('Client Secret cleared.');
                        this.display();
                    }));
        }
    }
}