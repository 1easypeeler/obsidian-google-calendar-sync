/**
 * SecureStorage — secret-at-rest encryption with platform-appropriate backends.
 *
 * Desktop: Electron `safeStorage` (OS keychain on macOS, DPAPI on Windows,
 *          libsecret on Linux). Real protection — keys never touch disk.
 *
 * Mobile:  AES-256-GCM with a key derived from the vault path. This is
 *          *obfuscation*, not protection — anyone who can read the vault
 *          can re-derive the key. Mobile platforms expose no equivalent
 *          to safeStorage from a plugin sandbox; honest naming and a
 *          documented fallback are the best we can do.
 *
 * Wire format (v2): JSON `{ v, method, payload }`.
 *   - method 'safeStorage' — payload is base64 of safeStorage ciphertext
 *   - method 'aes-pbkdf2'  — payload is the legacy PBKDF2/AES-GCM string
 *
 * Legacy decode: a non-JSON blob is treated as a v1 PBKDF2 ciphertext
 * (the format used before this module existed) and decrypted accordingly.
 */

import { Platform } from 'obsidian';
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

        if (Platform.isMobile) return null;

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
            // Electron not available, or context isolation blocks it. Fall back.
        }
        return this.safeStorage;
    }

    static isHardwareBacked(): boolean {
        return this.getSafeStorage() !== null;
    }

    /**
     * Encrypt a plaintext string. `fallbackKey` is only used when safeStorage
     * is unavailable (mobile, or desktop without a working keyring).
     */
    static async encrypt(plaintext: string, fallbackKey: CryptoKey): Promise<string> {
        const safeStorage = this.getSafeStorage();
        if (safeStorage) {
            const encrypted: Buffer = safeStorage.encryptString(plaintext);
            return JSON.stringify({
                v: FORMAT_VERSION,
                method: 'safeStorage',
                payload: encrypted.toString('base64'),
            } satisfies SecureBlob);
        }

        const obfuscated = await CryptoUtils.encrypt(plaintext, fallbackKey);
        return JSON.stringify({
            v: FORMAT_VERSION,
            method: 'aes-pbkdf2',
            payload: obfuscated,
        } satisfies SecureBlob);
    }

    /**
     * Decrypt a blob produced by `encrypt`. Also accepts legacy v1 blobs
     * (raw PBKDF2 ciphertext, not JSON) for one-time migration.
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
            // Legacy v1: opaque base64 PBKDF2 ciphertext.
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
            return CryptoUtils.decrypt(parsed.payload, fallbackKey);
        }

        throw new Error(`Unknown SecureStorage method: ${(parsed as SecureBlob).method}`);
    }
}
