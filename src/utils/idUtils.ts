/**
 * Secure ID generator with cross-platform compatibility
 * Uses crypto.getRandomValues() for cryptographically secure random generation
 */
export class IdUtils {
    private static readonly CHARS = 'abcdefghijklmnopqrstuvwxyz0123456789';
    private static readonly ID_LENGTH = 16;

    // Obsidian Tasks plugin parses these emoji tokens right-to-left from end
    // of line and stops at the first unrecognized content. The task-id HTML
    // comment must therefore sit *before* the leftmost of these on the line,
    // or Tasks fails to read the due/done/etc dates that trail it.
    private static readonly TASKS_PLUGIN_TOKEN = /📅|✅|⏳|🛫|🔁|⏫|🔼|🔽|🔺|⏬|🆔|⛔|➕|❌|⏩/u;
    private static readonly TASK_ID_COMMENT_GLOBAL = /\s*<!-- task-id: [a-z0-9]+ -->\s*/g;
    private static readonly TASK_ID_COMMENT = /<!-- task-id: [a-z0-9]+ -->/;

    /**
     * Generates a cryptographically secure random ID
     * Uses crypto.getRandomValues() for secure random generation
     * @returns A random ID string (16 characters, alphanumeric lowercase)
     */
    static generateRandomId(): string {
        // Try to use crypto.randomUUID() first (most secure, returns 36-char UUID)
        if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
            // Remove hyphens and take first 16 chars for compatibility
            return crypto.randomUUID().replace(/-/g, '').slice(0, this.ID_LENGTH);
        }

        // Fallback to crypto.getRandomValues() which is widely supported
        if (typeof crypto !== 'undefined' && typeof crypto.getRandomValues === 'function') {
            const randomValues = new Uint8Array(this.ID_LENGTH);
            crypto.getRandomValues(randomValues);
            let id = '';
            for (let i = 0; i < this.ID_LENGTH; i++) {
                id += this.CHARS.charAt(randomValues[i] % this.CHARS.length);
            }
            return id;
        }

        // Final fallback for environments without crypto (should be rare)
        // Uses multiple entropy sources for better randomness
        let id = '';
        const timestamp = Date.now().toString(36);
        const random = Math.random().toString(36).slice(2);
        const combined = timestamp + random;

        for (let i = 0; i < this.ID_LENGTH; i++) {
            if (i < combined.length) {
                const charCode = combined.charCodeAt(i);
                id += this.CHARS.charAt(charCode % this.CHARS.length);
            } else {
                id += this.CHARS.charAt(Math.floor(Math.random() * this.CHARS.length));
            }
        }
        return id;
    }

    /**
     * Generates a secure time-based ID
     * @returns A time-based ID with cryptographically secure random suffix (16 characters)
     */
    static generateTimeBasedId(): string {
        // Get timestamp as base (provides ~8-9 chars in base36)
        const timestamp = Date.now().toString(36);

        // Generate secure random suffix
        const suffixLength = Math.max(this.ID_LENGTH - timestamp.length, 6);
        let randomSuffix = '';

        if (typeof crypto !== 'undefined' && typeof crypto.getRandomValues === 'function') {
            const randomValues = new Uint8Array(suffixLength);
            crypto.getRandomValues(randomValues);
            for (let i = 0; i < suffixLength; i++) {
                randomSuffix += this.CHARS.charAt(randomValues[i] % this.CHARS.length);
            }
        } else {
            // Fallback using Math.random (less secure but functional)
            for (let i = 0; i < suffixLength; i++) {
                randomSuffix += this.CHARS.charAt(Math.floor(Math.random() * this.CHARS.length));
            }
        }

        return (timestamp + randomSuffix).slice(0, this.ID_LENGTH);
    }

    /**
     * Insert a task-id HTML comment onto a task line at a position that
     * doesn't block the Obsidian Tasks plugin's right-to-left token parser.
     * The comment is placed just before the leftmost Tasks-recognised emoji
     * token (📅, ✅, etc.) so the metadata block at the end of the line stays
     * intact. If the line has no such token, the comment is appended at end.
     *
     * Caller must ensure `line` does not already contain a task-id comment;
     * use `repositionTaskIdComment` to relocate an existing one.
     */
    static insertTaskIdComment(line: string, idComment: string): string {
        const stripped = line.replace(/\s+$/, '');
        const match = stripped.match(this.TASKS_PLUGIN_TOKEN);
        if (!match || match.index === undefined) {
            return `${stripped} ${idComment}`;
        }
        const before = stripped.slice(0, match.index).replace(/\s+$/, '');
        const after = stripped.slice(match.index);
        return `${before} ${idComment} ${after}`;
    }

    /**
     * Move any existing task-id comment(s) on the line to the correct position
     * (before the trailing Tasks-plugin token block). Returns the line
     * unchanged if it contains no task-id comment.
     */
    static repositionTaskIdComment(line: string): string {
        const match = line.match(this.TASK_ID_COMMENT);
        if (!match) return line;
        const idComment = match[0];
        const cleaned = line.replace(this.TASK_ID_COMMENT_GLOBAL, ' ').replace(/\s+$/, '');
        return this.insertTaskIdComment(cleaned, idComment);
    }
}