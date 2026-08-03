/**
 * Encryption key derivation.
 *
 * Phase 0: Accepts a plaintext passphrase for development.
 * Phase 2 (per design): Two-factor derivation from device secret
 * (OS credential store) + machine binding (hardware serial + app data
 * path), combined via PBKDF2-HMAC-SHA256 at 600 000 iterations.
 *
 * The derived key lives in main-process memory for the session and is
 * zeroed on shutdown.  It never crosses the bridge into the renderer.
 */

import { createHash } from 'crypto';

// ---------------------------------------------------------------------------
// Phase-0 interface (passphrase only)
// ---------------------------------------------------------------------------

export interface KeyMaterial {
  /** Raw bytes of the derived key (session lifetime). */
  readonly key: Buffer;
  /** Human-readable source description for audit logs. */
  readonly source: 'passphrase' | 'pbkdf2-device-secret';
}

/**
 * Phase 0: derive a 256-bit key from a plaintext passphrase.
 * This is acceptable for the PoC.  Production MUST use deriveFromSecrets().
 */
export function deriveFromPassphrase(passphrase: string): KeyMaterial {
  const hash = createHash('sha256').update(passphrase, 'utf8').digest();
  return {
    key: hash,
    source: 'passphrase',
  };
}

/**
 * Zero a buffer in place so sensitive material does not linger in memory.
 * Call this before the main process exits or when the session locks.
 */
export function zeroBuffer(buf: Buffer): void {
  buf.fill(0);
}

/**
 * Convert a 32-byte key to a hex string suitable for the SQLCipher
 * `PRAGMA key` statement.
 */
export function keyToHex(key: Buffer): string {
  if (key.length !== 32) {
    throw new Error(`Key must be 32 bytes (256 bits), got ${key.length}.`);
  }
  return key.toString('hex');
}
