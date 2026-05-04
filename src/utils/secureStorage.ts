/**
 * SecureStorage — secret-at-rest encryption via Electron `safeStorage`.
 *
 * Desktop-only: uses the OS keychain (macOS Keychain, Windows DPAPI,
 * Linux libsecret). Keys never touch disk.
 *
 * Wire format (v2): JSON `{ v, method, payload }`.
 *   - method 'safeStorage' — payload is base64 of safeStorage ciphertext
 *
 * Legacy decode: a non-JSON blob or a v2 blob with method 'aes-pbkdf2'
 * is decrypted via CryptoUtils for one-time migration, then re-saved in
 * the safeStorage format on next write.
 */

import { CryptoUtils } from './cryptoUtils';

const FORMAT_VERSION = 2;

type SecureMethod = 'safeStorage' | 'aes-pbkdf2';

interface SecureBlob {
    v: number;
    method: SecureMethod;
    payload: string;
}

export class SecureStorage {
    private static safeStorage: any = null;
    private static safeStorageProbed = false;

    /**
     * Returns Electron's safeStorage if available and currently usable on this
     * machine (e.g. on Linux a working keyring is required), otherwise null.
     * Result is memoised — probing requires `require('electron')`.
     */
    private static getSafeStorage(): any | null {
        if (this.safeStorageProbed) return this.safeStorage;
        this.safeStorageProbed = true;

        try {
            const electron = require('electron');
            const safeStorage = electron?.safeStorage || electron?.remote?.safeStorage;
            if (
                safeStorage &&
                typeof safeStorage.isEncryptionAvailable === 'function' &&
                safeStorage.isEncryptionAvailable()
            ) {
                this.safeStorage = safeStorage;
            }
        } catch {
            // Electron not available, or context isolation blocks it.
        }
        return this.safeStorage;
    }

    static isHardwareBacked(): boolean {
        return this.getSafeStorage() !== null;
    }

    /**
     * Encrypt a plaintext string. `fallbackKey` is accepted for API
     * compatibility but is not used — desktop always has safeStorage.
     */
    static async encrypt(plaintext: string, fallbackKey: CryptoKey): Promise<string> {
        const safeStorage = this.getSafeStorage();
        if (!safeStorage) {
            throw new Error(
                'OS keychain (safeStorage) is not available. This plugin requires desktop Obsidian.'
            );
        }

        const encrypted: Buffer = safeStorage.encryptString(plaintext);
        return JSON.stringify({
            v: FORMAT_VERSION,
            method: 'safeStorage',
            payload: encrypted.toString('base64'),
        } satisfies SecureBlob);
    }

    /**
     * Decrypt a blob produced by `encrypt`. Also accepts legacy blobs
     * (v1 raw PBKDF2 ciphertext or v2 aes-pbkdf2) for one-time migration.
     */
    static async decrypt(blob: string, fallbackKey: CryptoKey): Promise<string> {
        let parsed: SecureBlob | null = null;
        if (blob.startsWith('{')) {
            try {
                parsed = JSON.parse(blob) as SecureBlob;
            } catch {
                parsed = null;
            }
        }

        if (!parsed) {
            // Legacy v1: opaque base64 PBKDF2 ciphertext — migrate on next save.
            return CryptoUtils.decrypt(blob, fallbackKey);
        }

        if (parsed.method === 'safeStorage') {
            const safeStorage = this.getSafeStorage();
            if (!safeStorage) {
                throw new Error(
                    'Stored data was encrypted with the OS keychain, but the keychain is not available on this device.'
                );
            }
            const buffer = Buffer.from(parsed.payload, 'base64');
            return safeStorage.decryptString(buffer);
        }

        if (parsed.method === 'aes-pbkdf2') {
            // Legacy v2 mobile format — decrypt for migration, next save
            // will re-encrypt with safeStorage.
            return CryptoUtils.decrypt(parsed.payload, fallbackKey);
        }

        throw new Error(`Unknown SecureStorage method: ${(parsed as SecureBlob).method}`);
    }
}
