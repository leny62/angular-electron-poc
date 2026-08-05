/**
 * Encryption key derivation with machine binding.
 *
 *   passphrase + machine salt → PBKDF2-HMAC-SHA256(600k) → 256-bit key
 *
 * The key goes to SQLCipher as a raw key via `PRAGMA key = "x'<hex>'"`, which
 * skips the cipher's own KDF because we have already done the work. It lives in
 * main-process memory for the session and never crosses the bridge.
 *
 * Ported from the POC with three changes:
 *
 *   1. The SHA-256 "development" path is gone. A single unsalted SHA-256 over a
 *      passphrase is a few GPU-seconds from a wordlist, and a dev shortcut that
 *      produces a working database is exactly the kind of thing that survives to
 *      production because everything appears to function.
 *
 *   2. The salt is persisted, not recomputed. The POC derived it from
 *      `os.hostname()` and `os.cpus()[0].model` on every launch, which means a
 *      hostname change (DHCP, a rename, a corporate policy) silently produces a
 *      different key and the database becomes unreadable with the correct
 *      passphrase. A random salt stored in the OS credential store binds to the
 *      installation without being hostage to mutable machine facts.
 *
 *   3. A verifier is derived alongside the key, so a wrong passphrase is
 *      detected by a constant-time comparison instead of by SQLCipher failing to
 *      parse the header.
 */

import { pbkdf2Sync, randomBytes, timingSafeEqual, createHash } from 'crypto';

/** OWASP's floor for PBKDF2-HMAC-SHA256. Deliberately slow. */
const PBKDF2_ITERATIONS = 600_000;
const KEY_LENGTH = 32;
const HASH = 'sha256';

/** Domain separation, so the verifier can never equal the encryption key. */
const KEY_INFO = 'bizuri:sqlcipher-key:v1';
const VERIFIER_INFO = 'bizuri:passphrase-verifier:v1';

export interface KeyMaterial {
  /** Raw 256-bit key for SQLCipher. Zero this on lock and on shutdown. */
  readonly key: Buffer;
  /**
   * Value stored in the credential store to check a passphrase without opening
   * the database. Derived from the same PBKDF2 output under a different domain
   * label, so possessing it does not reveal the key.
   */
  readonly verifier: Buffer;
}

/**
 * Derive the key and verifier from a passphrase and a persisted salt.
 *
 * Both are derived from one PBKDF2 run, split by a domain label, so the 600k
 * iterations are paid once rather than twice.
 */
export function deriveKey(passphrase: string, salt: Buffer): KeyMaterial {
  if (salt.length < 16) {
    throw new Error(`Machine salt must be at least 16 bytes, got ${salt.length}.`);
  }

  const master = pbkdf2Sync(passphrase, salt, PBKDF2_ITERATIONS, KEY_LENGTH, HASH);

  return {
    key: hkdfLike(master, KEY_INFO),
    verifier: hkdfLike(master, VERIFIER_INFO),
  };
}

/**
 * Split one PBKDF2 output into independent subkeys by domain label.
 *
 * A full HKDF would be more standard, but the extract step is redundant here:
 * the PBKDF2 output is already a uniformly distributed 256-bit secret, which is
 * exactly what HKDF-Extract exists to produce. This is the expand step.
 */
function hkdfLike(master: Buffer, info: string): Buffer {
  return createHash('sha256').update(master).update(info, 'utf8').digest();
}

/** Fresh salt for first-time setup. Store it in the OS credential store. */
export function generateMachineSalt(): Buffer {
  return randomBytes(32);
}

/**
 * Constant-time verifier comparison.
 *
 * `timingSafeEqual` throws on a length mismatch, which would itself leak, so the
 * lengths are checked first and a mismatch returns false rather than throwing.
 */
export function verifyPassphrase(candidate: Buffer, expected: Buffer): boolean {
  if (candidate.length !== expected.length) return false;
  return timingSafeEqual(candidate, expected);
}

/** Hex encoding for `PRAGMA key = "x'<hex>'"`. */
export function keyToHex(key: Buffer): string {
  if (key.length !== KEY_LENGTH) {
    throw new Error(`Key must be ${KEY_LENGTH} bytes, got ${key.length}.`);
  }
  return key.toString('hex');
}

/**
 * Zero key material in place.
 *
 * Best-effort: V8 may have copied the buffer's contents during GC, and there is
 * no way to reach those copies. It still closes the window where a core dump or
 * a swapped page exposes the key, which is worth having.
 */
export function zeroBuffer(buf: Buffer): void {
  buf.fill(0);
}
