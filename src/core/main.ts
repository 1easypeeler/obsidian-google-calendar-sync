import { Plugin, Notice, Menu, MenuItem, Editor, TFile, TAbstractFile, MarkdownView } from 'obsidian';
import { GoogleAuthManager } from '../calendar/googleAuth';
import { TaskParser } from '../tasks/taskParser';
import { CalendarSync } from '../calendar/calendarSync';
import { RepairManager } from '../repair/repairManager';
import { GoogleCalendarSettingsTab, DEFAULT_SETTINGS } from './settings';
import type { GoogleCalendarSettings, Task } from './types';
import { loadGoogleCredentials } from '../config/config';
import { TIMING } from '../config/constants';
import { useStore, type TaskStore } from './store';
import debounce from 'just-debounce-it';
import { MetadataManager } from '../metadata/metadataManager';
import { TokenController } from '../tasks/TokenController';
import { LogUtils } from '../utils/logUtils';
import { hasTaskChanged } from '../utils/taskUtils';
import { initializeStore } from './store';

export default class GoogleCalendarSyncPlugin extends Plugin {
    settings: GoogleCalendarSettings;
    public metadataManager: MetadataManager | null = null;
    public authManager: GoogleAuthManager | null = null;
    public calendarSync: CalendarSync | null = null;
    public repairManager: RepairManager | null = null;
    public taskParser: TaskParser;
    public tokenController: TokenController;
    private statusBarItem: HTMLElement | null = null;
    private ribbonIcon: HTMLElement | null = null;
    private unsubscribeStore: (() => void) | undefined = undefined;
    private lastContent: string[] = [];
    private cleanupInterval: number | null = null;

    async onload() {
        try {
            console.log('Loading Google Calendar Sync plugin...');

            // Load settings first
            await this.loadSettings();

            // Dev convenience: if no client ID is configured in settings, fall
            // back to the env-var path (loadGoogleCredentials reads from .env).
            // In production this returns an empty string and is a no-op.
            if (!this.settings.clientId) {
                this.settings.clientId = loadGoogleCredentials().clientId;
            }

            // Always disable welcome modal
            // Note: saveSettings() removed here - settings will be saved later when needed
            this.settings.hasCompletedOnboarding = true;

            // Initialize LogUtils
            LogUtils.initialize(this);

            // Initialize store with plugin instance early so it's ready for any state updates
            // This must happen before auth operations that may need to update store state
            initializeStore(this);

            // Initialize TaskParser first
            this.taskParser = new TaskParser(this);

            // Initialize auth manager and await token loading
            this.authManager = new GoogleAuthManager(this);

            // Make sure any previous protocol handlers are cleaned up first
            // Don't await - let cleanup happen in background to avoid blocking startup
            this.authManager.cleanup();

            try {
                await this.authManager.loadSavedTokens();
            } catch (e) {
                console.error('Failed to load saved tokens, clearing authentication state:', e);

                // Log specific error for debugging
                if (e instanceof Error) {
                    LogUtils.error(`Token loading error: ${e.message}`);
                }

                if (this.settings.oauth2Tokens) {
                    this.settings.oauth2Tokens = undefined;
                    await this.saveSettings();
                    LogUtils.debug('Cleared invalid OAuth tokens from settings');
                }
            }

            // Probe the stored refresh token now so we don't sit in a fake
            // 'connected' state when Google has revoked access. Transient
            // network errors leave state intact; only definitive revocation
            // (400/401 from the token endpoint) clears it.
            let isAuthenticated = this.authManager.isAuthenticated();
            if (isAuthenticated) {
                const result = await this.authManager.validateOnLoad();
                if (result === 'revoked') {
                    isAuthenticated = false;
                    new Notice('Google Calendar access has been revoked. Please reconnect.', 8000);
                }
            }

            // Initialize metadata manager
            this.metadataManager = new MetadataManager(this);

            // Initialize store with complete initial state
            useStore.setState({
                syncEnabled: this.settings.syncEnabled,
                authenticated: isAuthenticated,
                status: isAuthenticated ? 'connected' : 'disconnected',
                tempSyncEnableCount: 0,
                error: null,
                processingTasks: new Set(),
                taskVersions: new Map(),
                locks: new Set(),
                lockTimeouts: new Map(),
                lastSyncTime: null,
                syncInProgress: false,
                syncQueue: new Set(),
                failedSyncs: new Map(),
                plugin: this
            });

            // Initialize UI components
            this.initializeStatusBar();
            this.ribbonIcon = this.initializeRibbonIcon();

            // Initialize TokenController
            this.tokenController = new TokenController(this);
            const extension = this.tokenController.getExtension();
            this.registerEditorExtension([extension]);

            // Initialize UI state
            this.updateRibbonStatus(useStore.getState().status);

            // Subscribe to store changes - wrapped in try-catch to prevent errors from causing issues
            this.unsubscribeStore = useStore.subscribe((state) => {
                try {
                    this.updateRibbonStatus(state.status);
                    this.updateStatusBar();
                } catch (error) {
                    LogUtils.error('Error in store subscription:', error);
                }
            });

            // Initialize calendar sync if authenticated
            // Defer until after onload() completes to avoid blocking startup
            if (isAuthenticated) {
                setTimeout(() => this.initializeCalendarSync(), 0);
            }

            // Register event handlers
            this.registerEventHandlers();

            // Start periodic cleanup
            this.startPeriodicCleanup();

            // NOTE: File change monitoring is handled in registerEventHandlers()
            // with proper debouncing to prevent double-syncing

            LogUtils.debug('Plugin loaded successfully');
        } catch (error) {
            LogUtils.error('Failed to load plugin:', error);
            useStore.getState().setStatus('error', error instanceof Error ? error : new Error(String(error)));
        }
    }

    private registerEventHandlers() {
        // Register file change events with shorter debounce
        this.registerEvent(
            this.app.vault.on('modify',
                debounce(async (file: TFile) => {
                    if (!useStore.getState().isSyncAllowed()) return;
                    if (!file.path.endsWith('.md')) return;

                    try {
                        // Get the file content
                        const state = useStore.getState();
                        state.invalidateFileCache(file.path);
                        const content = await state.getFileContent(file.path);

                        // Find all task lines in the file
                        const lines = content.split('\n');
                        const taskLines = lines.filter(line => this.taskParser.isTaskLine(line));

                        if (taskLines.length === 0) return;

                        // Parse tasks from task lines only
                        const tasks = [];
                        for (const line of taskLines) {
                            const task = await this.taskParser.parseTask(line, file.path);
                            if (task && task.id) {
                                tasks.push(task);
                            }
                        }

                        if (tasks.length === 0) return;

                        // Filter out tasks that were just synced
                        const tasksToQueue = [];

                        for (const task of tasks) {
                            if (!task.id) continue;

                            // Check for just synced tasks and skip them
                            const metadata = state.plugin.settings.taskMetadata?.[task.id];
                            if (metadata?.justSynced && metadata.syncTimestamp) {
                                const syncAge = Date.now() - metadata.syncTimestamp;
                                if (syncAge < TIMING.JUST_SYNCED_WINDOW_MS) { // Use a longer window (2 seconds)
                                    LogUtils.debug(`Task ${task.id} was just synced ${syncAge}ms ago, skipping (file handler)`);
                                    continue;
                                }
                            }

                            // Only queue if not locked
                            if (!state.isTaskLocked(task.id)) {
                                tasksToQueue.push(task);
                            }
                        }

                        // Enqueue all tasks at once
                        if (tasksToQueue.length > 0) {
                            await state.enqueueTasks(tasksToQueue);
                        }
                    } catch (error) {
                        LogUtils.error(`Failed to process file changes for ${file.path}:`, error);
                    }
                }, TIMING.FILE_CHANGE_DEBOUNCE_MS) // Reduced to 1 second for more responsive sync
            )
        );

        // Register settings tab
        this.addSettingTab(new GoogleCalendarSettingsTab(this.app, this));

        // Register file menu events
        this.registerEvent(
            this.app.workspace.on('file-menu', (menu, file: TAbstractFile) => {
                if (!(file instanceof TFile) || !file.path.endsWith('.md')) return;

                menu.addItem((item) => {
                    item
                        .setTitle('Sync Tasks with Google Calendar')
                        .setIcon('calendar-clock')
                        .onClick(async () => {
                            const state = useStore.getState();
                            try {
                                state.enableTempSync();
                                state.startSync();
                                const tasks = await this.taskParser.parseTasksFromFile(file);
                                await state.enqueueTasks(tasks.filter(t => t?.id));
                                await state.processSyncQueueNow();
                                state.endSync(true);
                                new Notice('Tasks synced with Google Calendar');
                            } catch (error) {
                                LogUtils.error(`Failed to sync tasks from ${file.path}:`, error);
                                state.endSync(false);
                                new Notice('Failed to sync tasks with Google Calendar');
                            } finally {
                                state.disableTempSync();
                            }
                        });
                });
            })
        );

        // Register editor change events for auto-sync with improved batching
        this.registerEvent(
            this.app.workspace.on('editor-change',
                debounce(async (editor: Editor) => {
                    if (!useStore.getState().isSyncAllowed()) return;

                    const view = this.app.workspace.getActiveViewOfType(MarkdownView);
                    if (!view || !view.file) return;

                    // Check if the cursor is on a task line
                    const cursorPos = editor.getCursor();
                    const currentLine = editor.getLine(cursorPos.line);

                    // Only proceed if the current line is a task line
                    if (!this.taskParser.isTaskLine(currentLine)) {
                        return;
                    }

                    const state = useStore.getState();
                    if (state.syncInProgress) {
                        LogUtils.debug('Sync in progress, will retry after current sync');
                        setTimeout(() => {
                            if (view.file) {
                                this.processEditorChanges(view.file);
                            }
                        }, 500); // Reduced retry time to 500ms
                        return;
                    }

                    if (view.file) {
                        await this.processEditorChanges(view.file);
                    }
                }, TIMING.EDITOR_CHANGE_DEBOUNCE_MS) // Reduced to 500ms for more responsive sync
            )
        );
    }

    private async processEditorChanges(file: TFile) {
        const state = useStore.getState();
        try {
            // First check if we can read the file
            try {
                // Force fresh content read
                await state.invalidateFileCache(file.path);
                await state.getFileContent(file.path);
            } catch (fileError) {
                LogUtils.error(`Failed to read file ${file.path} during editor changes:`, fileError);
                return; // Exit early if we can't read the file
            }

            // Get the current cursor position and line
            const editor = this.app.workspace.getActiveViewOfType(MarkdownView)?.editor;
            if (!editor) return;

            const cursorPos = editor.getCursor();
            const currentLine = editor.getLine(cursorPos.line);

            // Only process the task at the current line
            if (this.taskParser.isTaskLine(currentLine)) {
                const task = await this.taskParser.parseTask(currentLine, file.path);

                if (task && task.id) {
                    // Get metadata to check if task has changed
                    const metadata = this.settings.taskMetadata[task.id];
                    const result = hasTaskChanged(task, metadata, task.id);
                    const hasChanged = result.changed;

                    if (hasChanged) {
                        // Additional check for recently synced tasks
                        if (metadata?.justSynced && metadata.syncTimestamp) {
                            const syncAge = Date.now() - metadata.syncTimestamp;
                            if (syncAge < 2500) { // Even longer window for editor changes
                                LogUtils.debug(`Task ${task.id} was just synced ${syncAge}ms ago, skipping editor handler`);
                                return; // Skip completely
                            }
                        }

                        LogUtils.debug(`Task ${task.id} has changed, enqueueing for sync`);

                        // Process non-locked task immediately
                        if (!state.isTaskLocked(task.id)) {
                            await state.enqueueTasks([task]);

                            // Trigger immediate sync to process the task
                            await state.processSyncQueueNow();
                        } else {
                            // If task is locked, add to queue for later processing
                            LogUtils.debug(`Task ${task.id} is locked, adding to sync queue for later processing`);
                            state.addToSyncQueue(task.id);
                        }
                    } else {
                        LogUtils.debug(`Task ${task.id} has not changed, skipping enqueue`);
                    }
                }
            }
        } catch (error) {
            LogUtils.error(`Failed to process editor changes for ${file.path}:`, error);
        }
    }

    public async handleTaskDeletion(taskId: string, eventId: string | undefined) {
        const { isTaskLocked, isSyncEnabled, addProcessingTask, removeProcessingTask } = useStore.getState();

        if (isTaskLocked(taskId)) {
            LogUtils.debug(`Task ${taskId} is locked, skipping deletion`);
            return;
        }

        // Skip deletion handling if sync is disabled
        if (!isSyncEnabled()) {
            LogUtils.debug(`🔒 Sync is disabled, skipping deletion handling for ${taskId}`);
            return;
        }

        try {
            addProcessingTask(taskId);
            if (eventId) {
                LogUtils.debug(`Deleting calendar event: ${eventId}`);
                try {
                    await this.calendarSync?.deleteEvent(eventId);
                    LogUtils.debug(`Successfully deleted event: ${eventId}`);
                } catch (deleteError) {
                    // Log but continue — still clean up metadata even if calendar deletion fails
                    // (event may already be deleted, or API may be temporarily unavailable)
                    LogUtils.error(`Failed to delete calendar event ${eventId}:`, deleteError);
                }
            }
            await this.metadataManager?.removeTaskMetadata(taskId);
            LogUtils.debug('Cleaned up task metadata');
        } finally {
            removeProcessingTask(taskId);
        }
    }

    public async initializeCalendarSync() {
        if (!this.authManager) return;

        try {
            // Verify authentication before proceeding, skip prompt if we're coming from protocol handler
            const isAuthenticatedFromHandler = useStore.getState().authenticated;
            if (!await this.verifyAuthentication(isAuthenticatedFromHandler)) {
                useStore.getState().setStatus('disconnected');
                console.log('Authentication verification failed, not initializing calendar sync');
                return;
            }

            this.calendarSync = new CalendarSync(this);
            await this.calendarSync.initialize();

            // Initialize repair manager if needed
            if (!this.repairManager) {
                this.repairManager = new RepairManager(this);
            }

            // Skip initial cleanup on load - only do this during manual repair
            LogUtils.debug('Skipping initial cleanup during load');
            useStore.getState().setStatus('connected');
        } catch (error) {
            LogUtils.error('Failed to initialize calendar sync:', error);
            useStore.getState().setStatus('error', error instanceof Error ? error : new Error(String(error)));

            // Check if this is an auth error and handle appropriately
            if (error instanceof Error &&
                (error.message.includes('Authentication') ||
                    error.message.includes('auth') ||
                    error.message.includes('401'))) {
                console.log('Auth-related error detected, marking as disconnected');
                useStore.getState().setStatus('disconnected');
                useStore.getState().setAuthenticated(false);

                // Clear invalid tokens on auth errors
                if (this.settings.oauth2Tokens) {
                    this.settings.oauth2Tokens = undefined;
                    await this.saveSettings();
                }
            }
        }
    }

    private startPeriodicCleanup() {
        // Run cleanup every 5 minutes
        this.cleanupInterval = window.setInterval(() => {
            useStore.getState().clearStaleProcessingTasks();
        }, TIMING.PERIODIC_CLEANUP_INTERVAL_MS);
    }

    private async getAllTasks(): Promise<Task[]> {
        const tasks: Task[] = [];
        const files = this.app.vault.getMarkdownFiles();

        for (const file of files) {
            if (this.settings.includeFolders.length > 0 &&
                !this.settings.includeFolders.some(folder => file.path.startsWith(folder))) {
                continue;
            }
            try {
                const fileTasks = await this.taskParser.parseTasksFromFile(file);
                tasks.push(...fileTasks);
            } catch (error) {
                LogUtils.error(`Failed to parse tasks from ${file.path}:`, error);
            }
        }
        return tasks;
    }

    async onunload() {
        try {
            console.log('🔄 Unloading Google Calendar Sync plugin...');

            // Clear periodic cleanup interval to prevent memory leak
            if (this.cleanupInterval) {
                clearInterval(this.cleanupInterval);
                this.cleanupInterval = null;
            }

            // Clean up any pending sync operations
            useStore.getState().clearSyncQueue();

            // Clean up metadata
            if (this.metadataManager) {
                await this.metadataManager.cleanup();
            }

            // Clean up UI elements
            if (this.statusBarItem) {
                this.statusBarItem.remove();
            }

            if (this.ribbonIcon) {
                this.ribbonIcon.remove();
                this.ribbonIcon = null;
            }

            // Clean up store subscription
            if (this.unsubscribeStore) {
                this.unsubscribeStore();
            }

            // Clean up auth and sync components
            if (this.authManager) {
                await this.authManager.cleanup();
            }

            // Clear references
            this.calendarSync = null;
            this.authManager = null;
            this.metadataManager = null;
            this.statusBarItem = null;

            // Reset store state last
            useStore.getState().reset();

            console.log('Plugin cleanup completed');
        } catch (error) {
            console.error('❌ Error during plugin cleanup:', error);
        }
    }

    async loadSettings() {
        this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
    }

    private initializeRibbonIcon() {
        return this.addRibbonIcon('calendar-clock', 'Google Calendar Sync', (e: MouseEvent) => {
            // Check both the authManager and the store state
            const storeAuthenticated = useStore.getState().authenticated;
            const authManagerAuthenticated = this.authManager?.isAuthenticated() || false;

            if (!storeAuthenticated && !authManagerAuthenticated) {
                this.authManager?.authorize();
            } else {
                this.showSyncMenu(e);
            }
        });
    }

    private updateRibbonStatus(status: TaskStore['status']): void {
        if (!this.ribbonIcon) return;

        // Remove existing classes
        this.ribbonIcon.removeClass('is-connected', 'is-syncing', 'is-error', 'is-disconnected');

        // Add new class and tooltip
        switch (status) {
            case 'connected':
                this.ribbonIcon.addClass('is-connected');
                this.ribbonIcon.setAttribute('aria-label', 'Connected to Google Calendar');
                break;
            case 'syncing':
                this.ribbonIcon.addClass('is-syncing');
                this.ribbonIcon.setAttribute('aria-label', 'Syncing with Google Calendar...');
                break;
            case 'error':
                this.ribbonIcon.addClass('is-error');
                this.ribbonIcon.setAttribute('aria-label', 'Google Calendar Sync Error');
                break;
            case 'disconnected':
            default:
                this.ribbonIcon.addClass('is-disconnected');
                this.ribbonIcon.setAttribute('aria-label', 'Connect to Google Calendar (click to connect)');
        }
    }

    public updateStatusBar() {
        if (!this.statusBarItem) return;

        const state = useStore.getState();
        let text = '';
        let tooltip = '';

        switch (state.status) {
            case 'connected':
                if (state.syncInProgress) {
                    text = '🔄 GCal: Syncing...';
                    tooltip = `Syncing tasks with Google Calendar (${state.syncQueue.size} remaining)`;
                } else {
                    text = state.syncEnabled ? '🟢 GCal: Auto-sync On' : '🟡 GCal: Ready';
                    tooltip = state.syncEnabled ? 'Auto-sync is enabled' : 'Auto-sync is paused';
                    if (state.lastSyncTime) {
                        tooltip += ` (Last sync: ${new Date(state.lastSyncTime).toLocaleTimeString()})`;
                    }
                }
                break;
            case 'syncing':
                text = '🔄 GCal: Syncing...';
                tooltip = `Syncing tasks with Google Calendar (${state.syncQueue.size} remaining)`;
                break;
            case 'disconnected':
                text = '⚪ GCal: Disconnected';
                tooltip = 'Click to connect to Google Calendar';
                break;
            case 'error':
                text = '🔴 GCal: Error';
                tooltip = state.error?.message || 'An error occurred';
                if (state.failedSyncs.size > 0) {
                    tooltip += ` (${state.failedSyncs.size} failed tasks)`;
                }
                break;
            case 'refreshing_token':
                text = '🔄 GCal: Refreshing...';
                tooltip = 'Refreshing authentication token';
                break;
        }

        this.statusBarItem.setText(text);
        this.statusBarItem.setAttr('aria-label', tooltip);
        this.statusBarItem.setAttr('aria-label-position', 'top');
    }

    private initializeStatusBar() {
        this.statusBarItem = this.addStatusBarItem();
        this.statusBarItem.addClass('gcal-sync-status');
        this.statusBarItem.onClickEvent((event: MouseEvent) => {
            if (!this.authManager?.isAuthenticated()) {
                this.authManager?.authorize();
            } else {
                this.showSyncMenu(event);
            }
        });
        this.updateStatusBar();
    }

    private showSyncMenu(event: MouseEvent) {
        const menu = new Menu();

        menu.addItem((item: MenuItem) => {
            item
                .setTitle("Sync Now")
                .setIcon("sync")
                .onClick(() => this.syncAllTasks());
        });

        menu.addItem((item: MenuItem) => {
            const syncEnabled = useStore.getState().syncEnabled;
            item
                .setTitle(syncEnabled ? "Disable Auto-sync" : "Enable Auto-sync")
                .setIcon(syncEnabled ? "toggle-left" : "toggle-right")
                .onClick(async () => {
                    const newState = !syncEnabled;
                    useStore.getState().setSyncEnabled(newState);
                    // Update plugin settings
                    this.settings.syncEnabled = newState;
                    await this.saveSettings();
                    this.updateStatusBar();
                    new Notice(`Auto-sync ${newState ? 'enabled' : 'disabled'}`);
                });
        });

        menu.addItem((item: MenuItem) => {
            item
                .setTitle("Repair Calendar Sync")
                .setIcon("tool")
                .onClick(async () => {
                    if (!this.repairManager) {
                        new Notice('Repair manager not initialized');
                        return;
                    }
                    try {
                        new Notice('Starting repair process...');
                        await this.repairManager.repairSyncState(
                            (progress) => console.log(`Repair progress: ${progress.phase} - ${progress.processedItems}/${progress.totalItems}`)
                        );
                        new Notice('Repair completed successfully');
                    } catch (error) {
                        console.error('Repair failed:', error);
                        new Notice('Repair failed. Check console for details.');
                    }
                });
        });

        menu.addItem((item: MenuItem) => {
            item
                .setTitle("Disconnect Google Calendar")
                .setIcon("log-out")
                .onClick(() => this.disconnectGoogle());
        });

        // Show menu at the click position
        menu.showAtPosition({
            x: event.x,
            y: event.y
        });
    }

    async saveSettings() {
        await this.saveData(this.settings);
    }

    /**
     * Force open editor views to re-evaluate StateFields that read from settings
     * (e.g. the task-id display decoration). Dispatches a no-op transaction so
     * the StateField update path runs and rebuilds decorations.
     */
    public refreshEditorExtensions(): void {
        this.app.workspace.iterateAllLeaves(leaf => {
            const view = leaf.view;
            if (view instanceof MarkdownView) {
                // @ts-ignore - cm exists on editor but is not typed
                const cm = view.editor?.cm;
                if (cm) {
                    cm.dispatch({});
                }
            }
        });
    }

    private async syncAllTasks() {
        const state = useStore.getState();
        if (state.syncInProgress) {
            console.log('🔄 Sync already in progress');
            return;
        }

        try {
            state.startSync();
            state.enableTempSync();

            // Backfill IDs into pre-existing un-tagged tasks before parsing,
            // so the upcoming getAllTasks() pass picks them up.
            if (this.settings.backfillIdsOnSync && this.taskParser) {
                try {
                    const result = await this.taskParser.backfillTaskIds();
                    if (result.idsAdded > 0) {
                        new Notice(`Tagged ${result.idsAdded} new task${result.idsAdded === 1 ? '' : 's'} across ${result.filesTouched} file${result.filesTouched === 1 ? '' : 's'}`);
                    }
                } catch (error) {
                    console.error('Backfill failed (continuing with sync):', error);
                }
            }

            // Get all tasks
            const tasks = await this.taskParser?.getAllTasks() || [];
            console.log(`Found ${tasks.length} tasks to sync`);

            // Get all Obsidian events from calendar
            const allTaskIds = new Set(tasks.map(t => t.id));
            const calendarEvents = await this.calendarSync?.findAllObsidianEvents() || [];
            console.log(`Found ${calendarEvents.length} Obsidian events in calendar`);

            // Clean up orphaned events and metadata
            if (this.repairManager) {
                await this.repairManager.deleteOrphanedEvents(
                    calendarEvents,
                    allTaskIds,
                    (progress) => console.log(`Cleanup progress: ${progress.phase} - ${progress.processedItems}/${progress.totalItems}`)
                );
                await this.repairManager.cleanupOrphanedMetadata(
                    allTaskIds,
                    (progress) => console.log(`Cleanup progress: ${progress.phase} - ${progress.processedItems}/${progress.totalItems}`)
                );
            }

            // Enqueue all tasks and process immediately
            await state.enqueueTasks(tasks);
            await state.processSyncQueueNow();

            await this.saveSettings();
            state.endSync(true);
            new Notice('Tasks synced with Google Calendar');
            console.log('✅ Full sync completed');
        } catch (error) {
            console.error('❌ Sync failed:', error);
            state.endSync(false);
            state.setStatus('error', error instanceof Error ? error : new Error(String(error)));
            new Notice('Sync failed. Please try again.');
        } finally {
            state.disableTempSync();
        }
    }

    private async disconnectGoogle() {
        try {
            if (this.authManager?.isAuthenticated()) {
                await this.authManager.revokeAccess();
            }

            // Clear tokens in settings
            if (this.settings.oauth2Tokens) {
                this.settings.oauth2Tokens = undefined;
                await this.saveSettings();
            }

            this.calendarSync = null;
            const { setStatus, setAuthenticated, setSyncEnabled } = useStore.getState();
            setStatus('disconnected');
            setAuthenticated(false);
            setSyncEnabled(false); // Ensure sync is disabled when disconnected
            new Notice('Disconnected from Google Calendar');

            // Show option to reconnect
            const reconnect = window.confirm('Do you want to reconnect to Google Calendar?');
            if (reconnect && this.authManager) {
                this.authManager.authorize();
            }
        } catch (error) {
            useStore.getState().setStatus('error', error instanceof Error ? error : new Error(String(error)));
            new Notice('Failed to disconnect from Google Calendar');
        }
    }

    private isTaskFile(file: TAbstractFile): boolean {
        // First check if it's a markdown file
        if (!(file instanceof TFile) || !file.extension.toLowerCase().endsWith('md')) {
            return false;
        }

        // If no included folders specified, all markdown files are task files
        if (!this.settings.includeFolders || this.settings.includeFolders.length === 0) {
            return true;
        }

        // Get the include settings
        const includeSettings = this.settings.includeFolders;

        // Check for direct file match
        if (includeSettings.some(path => path === file.path)) {
            return true;
        }

        // Check if file is in included folders with strict matching
        if (includeSettings.some(folder => {
            // Skip if this is a direct file reference (likely ends with .md)
            if (!folder.endsWith('/') && folder.includes('.')) {
                return false;
            }
            return file.path.startsWith(folder + '/');
        })) {
            return true;
        }

        // Try more lenient matching (without requiring trailing slash)
        if (includeSettings.some(folder => {
            // Skip if this is a direct file reference
            if (!folder.endsWith('/') && folder.includes('.')) {
                return false;
            }
            const folderNoSlash = folder.endsWith('/') ? folder.slice(0, -1) : folder;
            return file.path.startsWith(folderNoSlash + '/');
        })) {
            return true;
        }

        return false;
    }

    /**
     * Checks if the current token is valid or renews it if needed.
     * @returns true if the token is valid or was successfully renewed
     */
    private async verifyAuthentication(skipPrompt = false): Promise<boolean> {
        // First check the store state - if we were just authenticated via protocol handler
        if (useStore.getState().authenticated) {
            console.log('Already authenticated according to store state');
            return true;
        }

        // If we're already authenticated, return true
        if (this.authManager && this.authManager.isAuthenticated()) {
            try {
                // Perform a token verification test
                await this.authManager.getValidAccessToken();
                return true;
            } catch (error) {
                console.log('Token verification failed:', error);
                // Token might be invalid, proceed to authentication flow
            }
        }

        // If skipPrompt is true, we're coming from the protocol handler or other authenticated source
        if (skipPrompt) {
            return false;
        }

        // Ask user if they want to connect
        const confirmConnection = await this.showConfirmationDialog(
            'Connect to Google Calendar',
            'You need to connect to Google Calendar to sync tasks. Connect now?',
            'Connect',
            'Cancel'
        );

        if (confirmConnection) {
            console.log('🔍 Not authenticated, redirecting to auth flow');
            if (this.authManager) {
                await this.authManager.authorize();
                // Auth flow will handle initializing calendar sync if successful
                return true;
            }
            return false;
        } else {
            console.log('ℹ️ User declined to authenticate');
            return false;
        }
    }

    // Helper method to show a confirmation dialog
    private async showConfirmationDialog(
        title: string,
        message: string,
        confirmText: string,
        cancelText: string
    ): Promise<boolean> {
        return new Promise((resolve) => {
            const confirm = window.confirm(message);
            resolve(confirm);
        });
    }
}    