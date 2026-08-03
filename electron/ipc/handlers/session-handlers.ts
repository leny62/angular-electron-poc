/**
 * Session command handlers.
 *
 * session.unlock — accept a passphrase, derive the database key via
 *   PBKDF2 with machine binding, verify it against the active
 *   database, and transition the engine to READY on success.
 *
 * session.state  — return the current engine state and metadata.
 *   Always allowed, even when locked.
 */

import type { CommandEnvelope, EngineState } from '../../shared/contracts';
import type { EngineStateMachine } from '../../domain/engine-state';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface SessionContext {
  readonly engineState: EngineStateMachine;
  /**
   * Attempt to unlock the vault with a passphrase.
   * Returns true when the derived key matches the active database key.
   *
   * In production this function runs PBKDF2 derivation and verifies
   * the key against SQLCipher.  The implementation is provided by
   * the main process at startup.
   */
  readonly unlockFn: (passphrase: string) => boolean;
}

export interface SessionStateData {
  readonly engineState: EngineState;
  readonly contractVersion: number;
  readonly databaseOpen: boolean;
}

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

/**
 * Attempt to unlock the vault with a passphrase.
 *
 * The passphrase goes through PBKDF2-HMAC-SHA256 (600 000 iterations)
 * with a machine-binding salt.  The derived key is compared against
 * the key that opened the database at startup.
 *
 * On success the engine transitions to READY and the vault is open
 * for the remainder of the session.
 */
export function handleSessionUnlock(
  payload: unknown,
  _envelope: CommandEnvelope,
  ctx: SessionContext,
): Record<string, unknown> {
  const { passphrase } = (payload as { passphrase?: string }) ?? {};

  if (typeof passphrase !== 'string' || passphrase.length === 0) {
    throw Object.assign(new Error('passphrase is required'), {
      code: 'E_SCHEMA' as const,
      retryable: false,
    });
  }

  const ok = ctx.unlockFn(passphrase);
  if (!ok) {
    throw Object.assign(
      new Error('Invalid passphrase — key derivation mismatch.'),
      {
        code: 'E_LOCKED' as const,
        retryable: true,
      },
    );
  }

  ctx.engineState.markReady();

  return {
    engineState: ctx.engineState.state,
    message: 'Engine unlocked and ready.',
  };
}

/**
 * Return the current engine state.  Always allowed, even when locked.
 */
export function handleSessionState(
  _payload: unknown,
  _envelope: CommandEnvelope,
  ctx: SessionContext,
): SessionStateData {
  return {
    engineState: ctx.engineState.state,
    contractVersion: 1,
    databaseOpen:
      ctx.engineState.state === 'READY' || ctx.engineState.state === 'DEGRADED',
  };
}
