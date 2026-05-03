import { LOG_LEVELS } from '../config/constants';
import { Notice } from 'obsidian';
import type GoogleCalendarSync from '../core/main';

export class LogUtils {
    private static plugin: GoogleCalendarSync;

    static initialize(plugin: GoogleCalendarSync) {
        this.plugin = plugin;
    }

    /**
     * Debug level logging - only shown if verboseLogging is enabled
     */
    static debug(message: string, ...args: any[]) {
        if (this.plugin?.settings.verboseLogging) {
            console.log(`${LOG_LEVELS.DEBUG} ${message}`, ...args);
        }
    }

    /**
     * Info level logging
     */
    static info(message: string, ...args: any[]) {
        console.log(`${LOG_LEVELS.INFO} ${message}`, ...args);
    }

    /**
     * Warning level logging
     */
    static warn(message: string, ...args: any[]) {
        console.log(`${LOG_LEVELS.WARN} ${message}`, ...args);
    }

    /**
     * Error level logging (console only - use notify() for user-visible errors)
     */
    static error(message: string, error?: any) {
        console.error(`${LOG_LEVELS.ERROR} ${message}`, error);
    }

    /**
     * Success level logging
     */
    static success(message: string, ...args: any[]) {
        console.log(`${LOG_LEVELS.SUCCESS} ${message}`, ...args);
    }

    /**
     * Log with notice (user visible)
     */
    static notify(message: string, isError = false) {
        const icon = isError ? LOG_LEVELS.ERROR : LOG_LEVELS.SUCCESS;
        new Notice(`${icon} ${message}`);
    }

    /**
     * Truncate text for logging. Use `redact()` for objects that may contain
     * tokens — this method only shortens, it does not scrub credentials.
     */
    static sanitize(text: string | undefined, maxLength = 100): string {
        if (!text) return '[empty]';
        if (text.length <= maxLength) return text;
        return text.substring(0, maxLength) + '...(truncated)';
    }

    /**
     * Returns a deep copy of `value` with credential-bearing fields replaced
     * with '[REDACTED]'. Use before logging anything that came from an OAuth
     * response, callback URL params, or token storage.
     */
    static redact<T>(value: T): T {
        const SENSITIVE_KEYS = /^(code|access_token|refresh_token|id_token|state|code_verifier|code_challenge|client_secret|authorization|password|bearer)$/i;

        const walk = (input: any): any => {
            if (input === null || input === undefined) return input;
            if (typeof input !== 'object') return input;
            if (Array.isArray(input)) return input.map(walk);

            const out: any = {};
            for (const [key, val] of Object.entries(input)) {
                out[key] = SENSITIVE_KEYS.test(key) ? '[REDACTED]' : walk(val);
            }
            return out;
        };

        return walk(value) as T;
    }

    /**
     * Group related logs together
     */
    static group(name: string, fn: () => void) {
        console.group(`${LOG_LEVELS.INFO} ${name}`);
        try {
            fn();
        } finally {
            console.groupEnd();
        }
    }
} 