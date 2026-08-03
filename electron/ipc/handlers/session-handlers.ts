/**
 * Session command handlers.
 *
 * session.unlock — accept a passphrase, derive the database key, and
 *   transition the engine to READY.
 * session.state  — return the current engine state and metadata.
 */

import type { CommandEnvelope, EngineState } from '../../shared/contracts';
import type { EngineStateMachine } from '../../domain/engine-state';

export interface SessionContext {
  readonly engineState: EngineStateMachine;
  readonly unlockFn: (passphrase: string) => boolean;
}

export interface SessionStateData {
  readonly engineState: EngineState;
  readonly contractVersion: number;
  readonly databaseOpen: boolean;
}

/**
 * Attempt to unlock the vault with a passphrase.
 * On success the engine transitions to READY.
 */
export function handleSessionUnlock(
  payload: unknown,
  _envelope: CommandEnvelope,
  ctx: SessionContext,
): Record<string, unknown> {
  const { passphrase } = payload as { passphrase?: string } ?? {};

  if (typeof passphrase !== 'string' || passphrase.length === 0) {
    throw Object.assign(new Error('passphrase is required'), {
      code: 'E_SCHEMA' as const,
      retryable: false,
    });
  }

  const ok = ctx.unlockFn(passphrase);
  if (!ok) {
    throw Object.assign(new Error('Invalid passphrase'), {
      code: 'E_LOCKED' as const,
      retryable: true,
    });
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
    databaseOpen: ctx.engineState.state === 'READY' || ctx.engineState.state === 'DEGRADED',
  };
}
