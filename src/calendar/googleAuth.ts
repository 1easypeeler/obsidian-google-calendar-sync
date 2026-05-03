import { Notice, Platform, requestUrl, App, Plugin, ObsidianProtocolData } from 'obsidian';
import { loadGoogleCredentials } from '../config/config';
import type GoogleCalendarSyncPlugin from '../core/main';
import type { OAuth2Tokens } from '../core/types';
import { createHash } from 'crypto';
import { LogUtils } from '../utils/logUtils';
import { CryptoUtils } from '../utils/cryptoUtils';
import { SecureStorage } from '../utils/secureStorage';

// Define constants for OAuth redirect URIs
const DESKTOP_PORT = 8085;
const DESKTOP_HOST = '127.0.0.1';
// The desktop redirect path includes a per-flow random nonce so co-resident
// processes can't blindly POST to /callback and inject auth codes.
const DESKTOP_PATH_PREFIX = '/callback';
const DESKTOP_REDIRECT_BASE = `http://${DESKTOP_HOST}:${DESKTOP_PORT}`;

const REDIRECT_URL_MOBILE = 'https://obsidian-gcal-sync-netlify-oauth.netlify.app/redirect.html';

const GOOGLE_TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token';

export class GoogleAuthManager {
    private clientId: string;
    private redirectUri: string;
    private accessToken: string | null = null;
    private refreshToken: string | null = null;
    private tokenExpiry: number | null = null;
    private readonly plugin: GoogleCalendarSyncPlugin;
    private codeVerifier: string | null = null;
    private app: App;
    private encryptionKey: CryptoKey | null = null;
    private refreshPromise: Promise<OAuth2Tokens> | null = null;
    private cachedClientSecret: string | null | undefined = undefined; // undefined = not yet loaded


    /**
     * Sanitize a JSON response object for logging - removes sensitive fields
     */
    private sanitizeResponseForLogging(json: any): string {
        if (!json) return '[empty]';
        // Create a copy and remove sensitive fields
        const sanitized = { ...json };
        if (sanitized.access_token) sanitized.access_token = '[REDACTED]';
        if (sanitized.refresh_token) sanitized.refresh_token = '[REDACTED]';
        if (sanitized.id_token) sanitized.id_token = '[REDACTED]';
        if (sanitized.error_description) {
            sanitized.error_description = LogUtils.sanitize(sanitized.error_description);
        }
        return JSON.stringify(sanitized);
    }

    constructor(plugin: GoogleCalendarSyncPlugin) {
        this.plugin = plugin;
        this.app = plugin.app;

        // Client ID is not secret; read it directly. Client Secret is loaded
        // lazily via getClientSecret() (decrypted from encryptedClientSecret).
        this.clientId = plugin.settings.clientId || loadGoogleCredentials().clientId;
        // On desktop the redirect URI is regenerated per auth attempt to include
        // a path nonce; placeholder here is overwritten in `authorize()`.
        this.redirectUri = Platform.isMobile ? REDIRECT_URL_MOBILE : DESKTOP_REDIRECT_BASE;
    }

    /**
     * Re-read the client ID from settings. Call after the user updates
     * credentials in the settings UI without reloading the plugin.
     */
    refreshClientId(): void {
        this.clientId = this.plugin.settings.clientId || loadGoogleCredentials().clientId;
    }

    /**
     * Lazily decrypt the stored client secret. Migrates legacy plaintext
     * (`settings.clientSecret`) to `encryptedClientSecret` on first call.
     */
    async getClientSecret(): Promise<string | null> {
        if (this.cachedClientSecret !== undefined) {
            return this.cachedClientSecret;
        }

        const settings = this.plugin.settings;

        // Migrate legacy plaintext: encrypt and remove.
        if (settings.clientSecret && !settings.encryptedClientSecret) {
            try {
                await this.setClientSecret(settings.clientSecret);
                console.log('Migrated client secret from plaintext to encrypted storage');
            } catch (e) {
                console.error('Failed to migrate client secret:', e);
                // Use plaintext for this session, leave migration for next load
                this.cachedClientSecret = settings.clientSecret;
                return this.cachedClientSecret;
            }
        }

        if (settings.encryptedClientSecret) {
            try {
                const fallbackKey = await this.getEncryptionKey();
                this.cachedClientSecret = await SecureStorage.decrypt(settings.encryptedClientSecret, fallbackKey);
                return this.cachedClientSecret;
            } catch (e) {
                console.error('Failed to decrypt client secret:', e);
                this.cachedClientSecret = null;
                return null;
            }
        }

        this.cachedClientSecret = null;
        return null;
    }

    async setClientSecret(plaintext: string): Promise<void> {
        const fallbackKey = await this.getEncryptionKey();
        const encrypted = await SecureStorage.encrypt(plaintext, fallbackKey);
        this.plugin.settings.encryptedClientSecret = encrypted;
        this.plugin.settings.clientSecret = undefined; // Drop any legacy plaintext
        await this.plugin.saveSettings();
        this.cachedClientSecret = plaintext;
    }

    async clearClientSecret(): Promise<void> {
        this.plugin.settings.encryptedClientSecret = undefined;
        this.plugin.settings.clientSecret = undefined;
        await this.plugin.saveSettings();
        this.cachedClientSecret = null;
    }

    hasClientSecret(): boolean {
        return !!(this.plugin.settings.encryptedClientSecret || this.plugin.settings.clientSecret);
    }

    /**
     * Gets or derives the encryption key for token storage
     * Uses vault path as salt to tie tokens to this specific vault
     */
    private async getEncryptionKey(): Promise<CryptoKey> {
        if (this.encryptionKey) {
            return this.encryptionKey;
        }

        // Use vault path + plugin ID as salt for key derivation
        // This ties the encrypted tokens to this specific vault installation
        const vaultPath = (this.app.vault.adapter as any).basePath || this.app.vault.getName();
        const salt = CryptoUtils.generateVaultSalt(vaultPath, 'obsidian-gcal-sync');

        this.encryptionKey = await CryptoUtils.deriveKey(salt);
        return this.encryptionKey;
    }

    async authorize(): Promise<void> {
        try {
            console.log('🔐 Starting OAuth flow');

            // Clean up any existing auth state
            await this.cleanup();

            if (Platform.isMobile) {
                await this.handleMobileAuth();
                // Don't initialize calendar sync here - it'll be done by protocol handler
                // after the authentication completes
                return;
            } else {
                // Desktop flow:
                // - PKCE (code_verifier + S256 challenge) protects the auth code in
                //   transit, matching the mobile flow.
                // - A per-flow random path nonce on the loopback redirect URI means
                //   another local process that can hit 127.0.0.1:8085 can't blindly
                //   inject an attacker-controlled code at /callback.
                // - State and code_verifier live only in memory for the duration
                //   of the flow; they are never written to data.json.
                const state = this.generateRandomState();
                const pathNonce = this.generateRandomState();
                this.codeVerifier = this.generateCodeVerifier();
                const codeChallenge = await this.generateCodeChallenge(this.codeVerifier);
                const callbackPath = `${DESKTOP_PATH_PREFIX}/${pathNonce}`;
                this.redirectUri = `${DESKTOP_REDIRECT_BASE}${callbackPath}`;

                const params = new URLSearchParams({
                    client_id: this.clientId,
                    redirect_uri: this.redirectUri,
                    response_type: 'code',
                    scope: 'https://www.googleapis.com/auth/calendar.events',
                    access_type: 'offline',
                    prompt: 'consent',
                    state: state,
                    code_challenge: codeChallenge,
                    code_challenge_method: 'S256',
                });

                const authUrl = `https://accounts.google.com/o/oauth2/v2/auth?${params}`;
                console.log('🔐 Auth URL generated (parameters redacted for security)');

                try {
                    console.log('🔐 Waiting for auth code...');
                    const { code, returnedState } = await this.handleDesktopAuth(authUrl, callbackPath);

                    if (!returnedState || returnedState !== state) {
                        throw new Error('Invalid state parameter. Authentication failed (possible CSRF attack).');
                    }

                    console.log('🔐 Exchanging auth code for tokens (PKCE)...');
                    await this.handlePKCEAuthCode(code);
                    console.log('🔐 Token exchange completed successfully');

                    console.log('✅ Authorization successful, initializing calendar sync');
                    this.plugin.initializeCalendarSync();
                    new Notice('Successfully connected to Google Calendar!');
                } catch (authError) {
                    console.error('Error during auth process:', authError);
                    await this.cleanup();
                    throw authError;
                }
            }
        } catch (error: any) {
            console.error('Authorization failed:', error);

            // Enhanced error handling
            if (error.code === 'EADDRINUSE') {
                console.log('Port already in use, running cleanup...');
                await this.cleanup();
                new Notice('Port 8085 is already in use. We attempted to free it. Please try again in a moment.');
            } else if (error.code === 'EACCES') {
                new Notice('Permission denied to use port 8085. Please try running Obsidian with elevated privileges.');
            } else if (error.message && error.message.includes('redirect_uri_mismatch')) {
                new Notice('Google OAuth error: Redirect URI mismatch. This is likely a configuration issue with the plugin.');
                console.error('Redirect URI mismatch. The URI used was:', this.redirectUri);
            } else if (error.message && error.message.includes('Authentication timed out')) {
                new Notice('Authentication timed out. Please try again.');
            } else if (error.message && error.message.includes('User closed the auth window')) {
                new Notice('Authentication was cancelled. Please try again if you want to connect to Google Calendar.');
            } else {
                new Notice('Failed to authorize with Google Calendar: ' + (error.message || 'Unknown error'));
            }

            // Ensure cleanup after any error
            await this.cleanup();
            throw error;
        }
    }

    /**
     * Handles the mobile OAuth flow using PKCE (Proof Key for Code Exchange)
     * 
     * The flow works as follows:
     * 1. Generate a code verifier (random string) and code challenge (SHA-256 hash of verifier)
     * 2. Open the Google authorization URL with the code challenge
     * 3. User authenticates in their browser
     * 4. Google redirects to https://obsidian.md/auth/gcalsync
     * 5. Obsidian app intercepts this URL and triggers our protocol handler
     * 6. We exchange the code + verifier for access and refresh tokens
     * 
     * This approach is more secure than the standard OAuth flow because:
     * - The code verifier never leaves the device
     * - Even if the authorization code is intercepted, it can't be used without the verifier
     * - Uses a standard https URL that Obsidian can intercept
     */
    private async handleMobileAuth(): Promise<void> {
        try {
            // Set flag to indicate mobile auth is in progress
            this.plugin.mobileAuthInitiated = true;

            // Generate PKCE code verifier and challenge
            this.codeVerifier = this.generateCodeVerifier();
            const codeChallenge = await this.generateCodeChallenge(this.codeVerifier);

            // Generate a random state value to prevent CSRF attacks
            const state = this.generateRandomState();

            // Store the state and code verifier in plugin settings for persistence across app restarts
            this.plugin.settings.tempAuthState = state;
            this.plugin.settings.tempCodeVerifier = this.codeVerifier;
            await this.plugin.saveSettings();

            console.log('🔐 Stored auth state and code verifier in plugin settings for persistence');

            // Build authorization URL with PKCE parameters
            const params = new URLSearchParams({
                client_id: this.clientId,
                redirect_uri: this.redirectUri,
                response_type: 'code',
                scope: 'https://www.googleapis.com/auth/calendar.events',
                access_type: 'offline',
                prompt: 'consent',
                code_challenge: codeChallenge,
                code_challenge_method: 'S256',
                state: state
            });

            const authUrl = `https://accounts.google.com/o/oauth2/v2/auth?${params}`;
            console.log('🔐 Mobile auth URL generated (details redacted for security)');
            console.log('🔐 Redirect URI:', this.redirectUri);

            // Open the authorization URL in the browser
            window.open(authUrl, '_blank');

            new Notice('Please complete authentication in your browser and return to Obsidian when finished.');

            // When Google redirects to the redirect URI, the page will send the user back to Obsidian
            // which will trigger our protocol handler with the auth code

        } catch (error) {
            console.error('Mobile auth error:', error);
            this.plugin.mobileAuthInitiated = false;
            throw error;
        }
    }

    private async handlePKCEAuthCode(code: string): Promise<void> {
        try {
            if (!this.codeVerifier) {
                throw new Error('Code verifier not found. Please restart the authentication process.');
            }

            console.log('🔄 Exchanging auth code for tokens using PKCE flow');
            console.log('Redirect URI:', this.redirectUri);

            const clientSecret = await this.getClientSecret();
            if (!clientSecret) {
                throw new Error('Client Secret is required. Please configure it in plugin settings.');
            }

            console.log('🔄 Exchanging auth code with PKCE');
            const response = await requestUrl({
                url: GOOGLE_TOKEN_ENDPOINT,
                method: 'POST',
                headers: {
                    'Content-Type': 'application/x-www-form-urlencoded',
                },
                body: new URLSearchParams({
                    code: code,
                    client_id: this.clientId,
                    client_secret: clientSecret,
                    redirect_uri: this.redirectUri,
                    grant_type: 'authorization_code',
                    code_verifier: this.codeVerifier,
                }).toString()
            });

            console.log('Token exchange response status:', response.status);

            if (response.status >= 400) {
                console.error('❌ Error response from token exchange:', response.status, LogUtils.sanitize(response.text));
                throw new Error(`Token exchange failed with status ${response.status}`);
            }

            if (!response.json.access_token) {
                console.error('❌ No access token in response:', this.sanitizeResponseForLogging(response.json));
                throw new Error('Failed to get access token');
            }

            const tokens: OAuth2Tokens = {
                access_token: response.json.access_token,
                refresh_token: response.json.refresh_token,
                scope: response.json.scope,
                token_type: response.json.token_type,
                expiry_date: Date.now() + response.json.expires_in * 1000
            };

            await this.saveTokens(tokens);
            this.plugin.mobileAuthInitiated = false;
            console.log('✅ Successfully exchanged code for tokens using PKCE flow');

        } catch (error) {
            console.error('❌ PKCE token exchange failed:', error instanceof Error ? error.message : 'Unknown error');
            this.plugin.mobileAuthInitiated = false;
            throw error;
        }
    }

    // PKCE helper functions
    private generateCodeVerifier(): string {
        const array = new Uint8Array(32);
        crypto.getRandomValues(array);
        return this.base64UrlEncode(array);
    }

    private base64UrlEncode(buffer: Uint8Array): string {
        return btoa(String.fromCharCode.apply(null, [...buffer]))
            .replace(/\+/g, '-')
            .replace(/\//g, '_')
            .replace(/=+$/, '');
    }

    private async generateCodeChallenge(verifier: string): Promise<string> {
        const encoder = new TextEncoder();
        const data = encoder.encode(verifier);
        const digest = await crypto.subtle.digest('SHA-256', data);
        return this.base64UrlEncode(new Uint8Array(digest));
    }

    private async handleDesktopAuth(
        authUrl: string,
        expectedPath: string
    ): Promise<{ code: string; returnedState: string | null }> {
        return new Promise((resolve, reject) => {
            console.log('🔍 Starting local auth server on port', DESKTOP_PORT);

            try {
                let server: any;
                let authCancelled = false;
                let authWindow: Window | null = null;
                let authTimeoutId: ReturnType<typeof setTimeout> | null = null;

                // Helper to clean up all timers and resources
                const cleanup = (interval: ReturnType<typeof setInterval>) => {
                    clearInterval(interval);
                    if (authTimeoutId) clearTimeout(authTimeoutId);
                };

                const windowCheckInterval = setInterval(() => {
                    // Check if auth window was closed prematurely by user
                    if (authWindow && authWindow.closed && !authCancelled) {
                        authCancelled = true;
                        cleanup(windowCheckInterval);
                        console.log('Auth window was closed prematurely by user');
                        try {
                            if (server) {
                                server.close(() => console.log('Server closed after user closed auth window'));
                            }
                        } catch (e) {
                            console.log('Error closing server after auth window closed:', e);
                        }
                        reject(new Error('User closed the auth window'));
                    }
                }, 1000);

                // Clean up any existing servers on port 8085
                const http = require('http');
                const net = require('net');

                try {
                    server = http.createServer(async (req: any, res: any) => {
                        try {
                            const url = new URL(req.url, `http://localhost:${DESKTOP_PORT}`);

                            // Reject any path that doesn't match this flow's nonce.
                            // This thwarts co-resident processes that might race
                            // legitimate callbacks at a known /callback endpoint.
                            if (url.pathname !== expectedPath) {
                                res.writeHead(404, { 'Content-Type': 'text/plain' });
                                res.end('Not found');
                                return;
                            }

                            const code = url.searchParams.get('code');
                            const returnedState = url.searchParams.get('state');
                            const error = url.searchParams.get('error');

                            if (error) {
                                console.error('❌ Auth error received:', error);
                                res.writeHead(400, { 'Content-Type': 'text/html' });
                                res.end(`<html><body><h1>Authentication failed</h1><p>Error: ${error}</p></body></html>`);
                                cleanup(windowCheckInterval);
                                server.close(() => console.log('🔒 Server closed after error'));
                                reject(new Error(`Authentication error: ${error}`));
                                return;
                            }

                            if (code) {
                                console.log('✅ Received auth code via loopback');
                                res.writeHead(200, { 'Content-Type': 'text/html' });
                                res.end(`<html><body><h1>Authentication successful!</h1><p>You can now close this window and return to Obsidian.</p></body></html>`);
                                cleanup(windowCheckInterval);
                                server.close(() => console.log('🔒 Server closed successfully'));
                                resolve({ code, returnedState });
                            }
                        } catch (error) {
                            console.error('Error handling auth callback:', error);
                            cleanup(windowCheckInterval);
                            res.writeHead(500, { 'Content-Type': 'text/plain' });
                            res.end('Internal server error');
                            reject(error);
                        }
                    });

                    server.listen(DESKTOP_PORT, DESKTOP_HOST)
                        .once('listening', () => {
                            console.log(`✅ Server listening on ${DESKTOP_HOST}:${DESKTOP_PORT}`);
                            console.log('🌐 Opening auth URL in browser (URL redacted)');

                            // Try to open auth window using shell.openExternal for desktop
                            try {
                                const { shell } = require('electron');
                                shell.openExternal(authUrl);
                                new Notice('Authentication opened in your browser. Please complete the process there.');
                                try {
                                    authWindow = window.open('', 'googleAuth');
                                } catch (trackErr) {
                                    console.log('Unable to track auth window:', trackErr);
                                }
                            } catch (e) {
                                console.log('Failed to open with electron shell, falling back to window.open:', e);
                                try {
                                    authWindow = window.open(authUrl, 'googleAuth', 'width=800,height=600');
                                    if (!authWindow) {
                                        const link = document.createElement('a');
                                        link.href = authUrl;
                                        link.target = '_blank';
                                        link.rel = 'noopener noreferrer';
                                        document.body.appendChild(link);
                                        link.click();
                                        document.body.removeChild(link);
                                    }
                                    new Notice('Authentication opened in your browser. Please complete the process there.');
                                } catch (e2) {
                                    console.error('❌ Failed to open auth window:', e2);
                                    new Notice('Failed to open authentication window. Please check popup blockers.');
                                    cleanup(windowCheckInterval);
                                    server.close();
                                    reject(new Error('Failed to open authentication window'));
                                }
                            }
                        })
                        .once('error', (error: any) => {
                            console.error('❌ Server error:', error);
                            reject(error);
                        });

                } catch (error) {
                    console.error('Error in server setup:', error);
                    reject(error);
                }

                // Set a timeout for the entire auth process
                authTimeoutId = setTimeout(() => {
                    if (!authCancelled) {
                        authCancelled = true;
                        cleanup(windowCheckInterval);
                        try {
                            if (server) {
                                server.close(() => console.log('🔒 Server closed after timeout'));
                            }
                        } catch (e) {
                            console.log('Error closing server:', e);
                        }
                        console.log('⏱️ Authentication timed out');
                        new Notice('Authentication timed out. Please try again.');
                        reject(new Error('Authentication timed out'));
                    }
                }, 300000);

                // Add event listener to cleanup when Obsidian closes
                window.addEventListener('beforeunload', () => {
                    if (!authCancelled) {
                        authCancelled = true;
                        cleanup(windowCheckInterval);
                        try {
                            if (server) {
                                server.close();
                            }
                        } catch (e) {
                            // Ignore errors during shutdown
                        }
                    }
                }, { once: true });

            } catch (error) {
                console.error('Error in handleDesktopAuth:', error);
                reject(error);
            }
        });
    }

    async refreshAccessToken(): Promise<OAuth2Tokens> {
        if (!this.refreshToken) {
            throw new Error('No refresh token available');
        }

        try {
            const clientSecret = await this.getClientSecret();
            if (!clientSecret) {
                throw new Error('Client Secret is required. Please configure it in plugin settings.');
            }

            console.log('🔄 Refreshing access token');
            const response = await requestUrl({
                url: GOOGLE_TOKEN_ENDPOINT,
                method: 'POST',
                headers: {
                    'Content-Type': 'application/x-www-form-urlencoded',
                },
                body: new URLSearchParams({
                    refresh_token: this.refreshToken,
                    client_id: this.clientId,
                    client_secret: clientSecret,
                    grant_type: 'refresh_token',
                }).toString()
            });
            console.log('🔄 Google OAuth response status:', response.status);
            if (response.status >= 400) {
                console.error('Token refresh failed with status', response.status, LogUtils.sanitize(response.text));
                throw new Error(`Token refresh failed with status ${response.status}`);
            }

            if (!response.json || !response.json.access_token) {
                console.error('Token refresh response missing access_token:', this.sanitizeResponseForLogging(response.json));
                throw new Error('Failed to refresh access token');
            }

            const tokens: OAuth2Tokens = {
                access_token: response.json.access_token,
                refresh_token: this.refreshToken,
                scope: response.json.scope,
                token_type: response.json.token_type,
                expiry_date: Date.now() + response.json.expires_in * 1000
            };

            console.log('Successfully refreshed access token, expires in:', response.json.expires_in);
            await this.saveTokens(tokens);
            return tokens;
        } catch (error) {
            console.error('Failed to refresh access token:', error);
            throw error;
        }
    }

    private async saveTokens(tokens: OAuth2Tokens): Promise<void> {
        this.accessToken = tokens.access_token;
        this.refreshToken = tokens.refresh_token || this.refreshToken;
        this.tokenExpiry = tokens.expiry_date;

        // Save to plugin settings with encryption
        if (this.accessToken && this.refreshToken) {
            try {
                // Add a timestamp for token age tracking
                const securedTokens: OAuth2Tokens = {
                    access_token: this.accessToken,
                    refresh_token: this.refreshToken,
                    expiry_date: this.tokenExpiry || 0,
                    token_type: tokens.token_type,
                    scope: tokens.scope,
                    stored_at: Date.now(), // Track when the tokens were saved
                };

                // Encrypt tokens. SecureStorage uses Electron safeStorage on
                // desktop (real OS-keychain protection) and falls back to AES
                // with a vault-derived key on mobile (obfuscation only).
                const fallbackKey = await this.getEncryptionKey();
                const encryptedTokens = await SecureStorage.encrypt(
                    JSON.stringify(securedTokens),
                    fallbackKey
                );

                this.plugin.settings.encryptedOAuth2Tokens = encryptedTokens;
                this.plugin.settings.tokensEncrypted = true;
                this.plugin.settings.oauth2Tokens = undefined; // Clear any legacy plaintext
                await this.plugin.saveSettings();

                console.log(`Tokens saved. Access token valid until: ${new Date(this.tokenExpiry || 0).toLocaleString()}`);
            } catch (error) {
                console.error('Error saving authentication tokens:', error);
                LogUtils.error('Failed to save authentication tokens');
                throw new Error('Failed to securely store authentication tokens');
            }
        }
    }

    async loadSavedTokens(): Promise<boolean> {
        try {
            let tokens: OAuth2Tokens | undefined;
            let needsResave = false;

            if (this.plugin.settings.tokensEncrypted && this.plugin.settings.encryptedOAuth2Tokens) {
                try {
                    const fallbackKey = await this.getEncryptionKey();
                    const decrypted = await SecureStorage.decrypt(
                        this.plugin.settings.encryptedOAuth2Tokens,
                        fallbackKey
                    );
                    tokens = JSON.parse(decrypted) as OAuth2Tokens;
                    // Re-save so legacy v1 blobs (or AES blobs on devices that
                    // now support safeStorage) get rewritten in the strongest
                    // method available on this platform.
                    needsResave = true;
                } catch (decryptError) {
                    console.error('Failed to decrypt tokens:', decryptError);
                    LogUtils.error('Token decryption failed. Please reconnect to Google Calendar.');
                    this.plugin.settings.encryptedOAuth2Tokens = undefined;
                    this.plugin.settings.tokensEncrypted = false;
                    await this.plugin.saveSettings();
                    return false;
                }
            } else if (this.plugin.settings.oauth2Tokens?.access_token) {
                console.log('Migrating legacy plaintext tokens to encrypted storage');
                tokens = this.plugin.settings.oauth2Tokens;
                needsResave = true;
            }

            if (!tokens?.refresh_token || !tokens?.access_token) {
                return false;
            }

            this.refreshToken = tokens.refresh_token;
            this.accessToken = tokens.access_token;
            this.tokenExpiry = tokens.expiry_date;

            // Migrate legacy/weaker storage format to whatever's strongest on
            // this platform (e.g. v1 PBKDF2 → safeStorage on desktop).
            if (needsResave) {
                try {
                    await this.saveTokens(tokens);
                } catch (e) {
                    console.error('Failed to re-save tokens in new format:', e);
                }
            }

            if (this.tokenExpiry && Date.now() >= this.tokenExpiry) {
                console.log('Saved token expired, refreshing...');
                try {
                    const newTokens = await this.refreshAccessToken();
                    return !!newTokens.access_token;
                } catch (refreshError) {
                    console.error('Token refresh failed, clearing tokens:', refreshError);
                    await this.clearStoredTokens();
                    new Notice('Your Google authentication has expired. Please reconnect.');
                    return false;
                }
            }

            return true;
        } catch (error) {
            console.error('Failed to load saved tokens:', error);
            return false;
        }
    }

    async getValidAccessToken(): Promise<string> {
        if (!this.accessToken || !this.tokenExpiry) {
            if (await this.loadSavedTokens()) {
                if (this.tokenExpiry && Date.now() >= this.tokenExpiry) {
                    const tokens = await this.deduplicatedRefresh();
                    return tokens.access_token;
                }
                return this.accessToken!;
            }
            throw new Error('Not authenticated');
        }

        if (Date.now() >= this.tokenExpiry) {
            const tokens = await this.deduplicatedRefresh();
            return tokens.access_token;
        }

        return this.accessToken;
    }

    /**
     * Deduplicates concurrent refresh calls so only one HTTP request is made.
     * Subsequent callers await the same in-flight promise.
     */
    private async deduplicatedRefresh(): Promise<OAuth2Tokens> {
        if (this.refreshPromise) {
            return this.refreshPromise;
        }

        this.refreshPromise = this.refreshAccessToken().finally(() => {
            this.refreshPromise = null;
        });

        return this.refreshPromise;
    }

    async revokeAccess(): Promise<void> {
        if (this.accessToken) {
            try {
                await requestUrl({
                    url: `https://oauth2.googleapis.com/revoke?token=${this.accessToken}`,
                    method: 'POST'
                });
                console.log('Successfully revoked access token');
            } catch (error) {
                console.error('Error revoking token:', error);
            }
        }

        // Clear tokens from memory
        this.accessToken = null;
        this.refreshToken = null;
        this.tokenExpiry = null;

        // Clear tokens from settings (both encrypted and unencrypted)
        if (this.plugin.settings.oauth2Tokens || this.plugin.settings.encryptedOAuth2Tokens) {
            this.plugin.settings.oauth2Tokens = undefined;
            this.plugin.settings.encryptedOAuth2Tokens = undefined;
            this.plugin.settings.tokensEncrypted = false;
            await this.plugin.saveSettings();
            console.log('Cleared tokens from settings');
        }
    }

    public async cleanup(): Promise<void> {
        console.log('🧹 Starting cleanup process');

        try {
            // Reset mobile auth state if needed
            if (Platform.isMobile && this.plugin.mobileAuthInitiated) {
                this.plugin.mobileAuthInitiated = false;
                this.codeVerifier = null;

                // Clear any stored auth state from settings
                if (this.plugin.settings.tempAuthState || this.plugin.settings.tempCodeVerifier) {
                    console.log('🧹 Cleaning up mobile auth state from settings');
                    this.plugin.settings.tempAuthState = undefined;
                    this.plugin.settings.tempCodeVerifier = undefined;
                    await this.plugin.saveSettings();
                }
            }

            // On desktop platforms, we can use Node's net module for server cleanup
            if (!Platform.isMobile) {
                const net = require('net');

                // Try more aggressive socket connection to force close the port
                console.log('Attempting to connect to port to force it closed');
                const client = new net.Socket();

                // Set a very short timeout for the connection
                client.setTimeout(1000);

                await new Promise<void>((resolve) => {
                    client.once('error', (err: NodeJS.ErrnoException) => {
                        console.log(`Socket connection error (expected if port not in use): ${err.code}`);
                        resolve();
                    });

                    client.once('timeout', () => {
                        console.log('Socket connection timeout');
                        client.destroy();
                        resolve();
                    });

                    client.once('connect', () => {
                        console.log('Successfully connected to server, sending FIN packet');
                        // Send RST packet to forcibly close the connection
                        client.destroy();
                        resolve();
                    });

                    try {
                        client.connect(DESKTOP_PORT, DESKTOP_HOST);
                    } catch (e) {
                        console.log('Error during connect attempt:', e);
                        resolve();
                    }
                });

                // Close any existing auth windows
                try {
                    const existingWindow = window.open('', 'googleAuth');
                    if (existingWindow) {
                        console.log('Found existing auth window, closing it');
                        existingWindow.close();
                    }
                } catch (e) {
                    console.log('Error closing existing auth window:', e);
                }
            }

        } catch (e) {
            console.log('Error during server cleanup:', e);
        }

        console.log('🧹 Cleanup process completed');
    }

    isAuthenticated(): boolean {
        // A valid refresh token means the user is authenticated — an expired
        // access token is normal and gets refreshed lazily via getValidAccessToken().
        // Treating expired-access as logged-out caused spurious re-auth prompts
        // after the laptop slept for >1h (Google access tokens expire in ~1h).
        if (this.refreshToken) {
            return true;
        }
        // Memory not populated yet (e.g. settings just loaded) — fall back to stored tokens.
        if (this.plugin.settings.oauth2Tokens?.refresh_token) {
            return true;
        }
        if (this.plugin.settings.tokensEncrypted && this.plugin.settings.encryptedOAuth2Tokens) {
            return true;
        }
        return false;
    }

    /**
     * Probe stored tokens on plugin load. Returns 'valid' if the refresh path works
     * (or wasn't needed because the access token is still good), 'revoked' if Google
     * rejected the refresh token (clears stored state), and 'transient' for network
     * errors (leaves state intact — we'll retry on the next sync).
     */
    async validateOnLoad(): Promise<'valid' | 'revoked' | 'transient'> {
        try {
            await this.getValidAccessToken();
            return 'valid';
        } catch (e) {
            const message = e instanceof Error ? e.message : String(e);
            // 400/401 from the token endpoint means the refresh token itself is no
            // longer accepted (revoked, expired idle for >6mo, scope changes, etc.).
            // Network errors and other failures should not log the user out.
            if (/status (400|401)/.test(message) || message.includes('No refresh token')) {
                console.log('Refresh token rejected on load — clearing stored auth state');
                await this.clearStoredTokens();
                return 'revoked';
            }
            console.log('Token validation failed transiently, keeping stored state:', message);
            return 'transient';
        }
    }

    private async clearStoredTokens(): Promise<void> {
        this.accessToken = null;
        this.refreshToken = null;
        this.tokenExpiry = null;
        this.plugin.settings.oauth2Tokens = undefined;
        this.plugin.settings.encryptedOAuth2Tokens = undefined;
        this.plugin.settings.tokensEncrypted = false;
        await this.plugin.saveSettings();
    }

    // Generate a random state value for CSRF protection
    private generateRandomState(): string {
        const array = new Uint8Array(16);
        crypto.getRandomValues(array);
        return this.base64UrlEncode(array);
    }

    // This method should be called by the plugin when it receives a protocol callback
    public async handleProtocolCallback(params: Record<string, string>): Promise<void> {
        console.log('🔐 Received protocol callback (params redacted):', LogUtils.redact(params));

        try {
            const savedState = this.plugin.settings.tempAuthState;

            if (!savedState || savedState !== params.state) {
                throw new Error('Invalid state parameter. Authentication failed.');
            }

            const storedVerifier = this.plugin.settings.tempCodeVerifier;

            if (!storedVerifier) {
                throw new Error('Code verifier not found. Please restart the authentication process.');
            }
            this.codeVerifier = storedVerifier;

            if (params.code) {
                await this.handlePKCEAuthCode(params.code);

                // Clean up settings after successful auth
                this.plugin.settings.tempAuthState = undefined;
                this.plugin.settings.tempCodeVerifier = undefined;
                await this.plugin.saveSettings();
            } else if (params.error) {
                throw new Error(`Authentication error: ${params.error}`);
            } else {
                throw new Error('No authorization code received');
            }
        } catch (error) {
            console.error('Protocol callback error:', error);
            this.plugin.mobileAuthInitiated = false;
            new Notice(`Authentication failed: ${error.message}`);
            throw error;
        }
    }
}