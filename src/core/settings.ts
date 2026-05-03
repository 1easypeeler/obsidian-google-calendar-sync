import { App, PluginSettingTab, Setting } from 'obsidian';
import type GoogleCalendarSync from './main';
import { GoogleCalendarSettings } from './types';
import { useStore } from './store';
import { Notice } from 'obsidian';

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
    mobileSyncLimit: 100,  // Default to 100 files on mobile
    mobileOptimizations: true,  // Enable mobile optimizations by default
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

        containerEl.createEl('h2', { text: 'Google Calendar Sync Settings' });

        // Sync Settings Section
        containerEl.createEl('h3', { text: 'Sync Settings' });

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

        // Calendar Settings Section
        containerEl.createEl('h3', { text: 'Calendar Settings' });

        new Setting(containerEl)
            .setName('Calendar ID')
            .setDesc('Google Calendar to sync tasks with. Use "primary" for your default calendar, or paste a calendar ID from Google Calendar > calendar settings > "Integrate calendar" (e.g. you@gmail.com or abc123@group.calendar.google.com). Events already synced to a different calendar are not migrated.')
            .addText(text => text
                .setPlaceholder('primary')
                .setValue(this.plugin.settings.calendarId || 'primary')
                .onChange(async (value) => {
                    const trimmed = value.trim();
                    this.plugin.settings.calendarId = trimmed.length > 0 ? trimmed : 'primary';
                    await this.plugin.saveSettings();
                }));

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

        // Mobile Settings Section
        containerEl.createEl('h3', { text: 'Mobile Optimizations' });

        new Setting(containerEl)
            .setName('Enable Mobile Optimizations')
            .setDesc('Apply mobile-specific optimizations for better performance on mobile devices')
            .addToggle(toggle => toggle
                .setValue(this.plugin.settings.mobileOptimizations ?? true)
                .onChange(async (value) => {
                    this.plugin.settings.mobileOptimizations = value;
                    await this.plugin.saveSettings();
                }));

        new Setting(containerEl)
            .setName('Mobile Sync File Limit')
            .setDesc('Maximum number of files to scan for tasks on mobile devices (lower values improve performance)')
            .addText(text => text
                .setPlaceholder('100')
                .setValue((this.plugin.settings.mobileSyncLimit ?? 100).toString())
                .onChange(async (value) => {
                    const limit = parseInt(value);
                    if (!isNaN(limit) && limit > 0) {
                        this.plugin.settings.mobileSyncLimit = limit;
                        await this.plugin.saveSettings();
                    }
                }));

        // OAuth Credentials Section
        containerEl.createEl('h3', { text: 'Google OAuth Credentials' });

        const oauthDesc = containerEl.createEl('div', { cls: 'setting-item-description' });
        oauthDesc.style.marginBottom = '1em';

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

        new Setting(containerEl)
            .setName('Client ID')
            .setDesc('Your Google OAuth Client ID')
            .addText(text => text
                .setPlaceholder('xxxxxx.apps.googleusercontent.com')
                .setValue(this.plugin.settings.clientId || '')
                .onChange(async (value) => {
                    this.plugin.settings.clientId = value.trim();
                    await this.plugin.saveSettings();
                }));

        new Setting(containerEl)
            .setName('Client Secret')
            .setDesc('Your Google OAuth Client Secret')
            .addText(text => {
                text.setPlaceholder('GOCSPX-xxxxxx')
                    .setValue(this.plugin.settings.clientSecret || '')
                    .onChange(async (value) => {
                        this.plugin.settings.clientSecret = value.trim();
                        await this.plugin.saveSettings();
                    });
                text.inputEl.type = 'password';
            });
    }
}