/**
 * Encryption key derivation with machine binding.
 *
 * Converts a user passphrase into a 256-bit AES key suitable for
 * SQLCipher (via PRAGMA key).  The derivation uses PBKDF2-HMAC-SHA256
 * at 600 000 iterations with a salt that binds the key to this
 * specific device and application installation.
 *
 *   passphrase + machineSalt → PBKDF2(600k iter) → 256-bit key
 *
 * Two-factor binding means:
 *   - Copying the database file to another machine is useless without
 *     the passphrase AND the machine fingerprint.
 *   - The passphrase alone is insufficient (an attacker needs the
 *     device salt too).
 *
 * The derived key lives in main-process memory for the session and is
 * zeroed on shutdown.  It never crosses the bridge into the renderer.
 *
 * @see docs/Bizuri-Secure-IPC-Offline-Design.docx  Section 5.4
 */

import { pbkdf2Sync, randomBytes } from 'crypto';
import * as os from 'os';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** PBKDF2 iterations (OWASP 2023 recommendation for HMAC-SHA256). */
const PBKDF2_ITERATIONS = 600_000;

/** Output key length in bytes (256 bits). */
const KEY_LENGTH = 32;

/** Hash algorithm for PBKDF2. */
const HASH_ALGORITHM = 'sha256';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface KeyMaterial {
  /** Raw bytes of the derived key (session lifetime). */
  readonly key: Buffer;
  /** Human-readable source description for audit logs. */
  readonly source: 'plaintext-sha256' | 'pbkdf2-machine-bound';
}

// ---------------------------------------------------------------------------
// SHA-256 fallback (development without machine binding)
// ---------------------------------------------------------------------------

/**
 * Derive a 256-bit key from a plaintext passphrase using a single
 * SHA-256 hash.  Retained for development when machine binding is
 * not configured.
 *
 * Production paths use `deriveFromSecrets()` instead.
 */
export function deriveFromPassphrase(passphrase: string): KeyMaterial {
  const hash = require('crypto').createHash('sha256').update(passphrase, 'utf8').digest();
  return {
    key: hash,
    source: 'plaintext-sha256',
  };
}

// ---------------------------------------------------------------------------
// PBKDF2 + machine binding (default path)
// ---------------------------------------------------------------------------

/**
 * Derive a 256-bit AES key from a passphrase and a machine-binding salt.
 *
 * The salt should be generated once per installation via
 * `generateMachineSalt()` and stored in the OS credential store.
 * For the PoC the salt is derived from hardware characteristics at
 * startup — see `getMachineFingerprint()`.
 *
 * @param passphrase  User-provided vault passphrase.
 * @param salt        Machine-binding salt (32+ bytes recommended).
 * @returns           KeyMaterial with the derived 256-bit key.
 */
export function deriveFromSecrets(
  passphrase: string,
  salt: Buffer,
): KeyMaterial {
  const key = pbkdf2Sync(passphrase, salt, PBKDF2_ITERATIONS, KEY_LENGTH, HASH_ALGORITHM);

  return {
    key,
    source: 'pbkdf2-machine-bound',
  };
}

/**
 * Generate a cryptographically random salt for first-time setup.
 * Store this in the OS credential store (`keychain` on macOS,
 * `libsecret` on Linux, Credential Manager on Windows).
 *
 * For the PoC, the salt is regenerated at each startup from the
 * machine fingerprint — see `getMachineFingerprint()`.
 */
export function generateMachineSalt(): Buffer {
  return randomBytes(32);
}

/**
 * Build a machine fingerprint for PoC key binding.
 *
 * Combines:
 *   - Hostname (tied to the specific device)
 *   - CPU model (stable hardware identifier)
 *   - Application data path (tied to this installation)
 *   - A compile-time pepper (constant secret)
 *
 * This fingerprint is NOT a secret — it is a salt.  The passphrase
 * provides the secrecy; the fingerprint provides binding.
 *
 * In production, replace this with a stable salt read from the OS
 * credential store (macOS Keychain, Windows Credential Manager).
 */
export function getMachineFingerprint(appDataPath: string): Buffer {
  const hostname = os.hostname();
  const cpuModel = os.cpus()[0]?.model ?? 'unknown-cpu';
  const pepper = 'bizuri-poc-v1.0.0'; // compile-time constant

  const canonical = `${hostname}|${cpuModel}|${appDataPath}|${pepper}`;

  // Use SHA-256 to produce a fixed-width 32-byte salt from the
  // variable-length fingerprint.  This is deterministic for the
  // same machine + app installation.
  return require('crypto').createHash('sha256').update(canonical, 'utf8').digest();
}

// ---------------------------------------------------------------------------
// Key lifecycle
// ---------------------------------------------------------------------------

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
