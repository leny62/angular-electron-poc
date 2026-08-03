/**
 * Engine command handlers.
 *
 * engine.health — return a diagnostic snapshot of the engine,
 *   database, and sync worker.  Always allowed, even when the
 *   engine is LOCKED or FATAL, because diagnostics are the first
 *   thing you need when something is wrong.
 */

import type { CommandEnvelope } from '../../shared/contracts';
import type { EngineStateMachine } from '../../domain/engine-state';
import type { SyncWorker } from '../../sync/sync-worker';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface EngineHealthData {
  engineState: string;
  engineDescription: string;
  contractVersion: number;
  databaseOpen: boolean;
  sync: {
    state: string;
    lastSyncAt: string | null;
    lastError: string | null;
    pushed: number;
    pulled: number;
    pending: number;
  } | null;
  uptime: {
    seconds: number;
    nodeVersion: string;
    electronVersion: string;
    platform: string;
  };
}

export interface EngineContext {
  readonly engineState: EngineStateMachine;
  readonly syncWorker: () => SyncWorker | null;
  readonly databaseOpen: boolean;
}

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

export function handleEngineHealth(
  _payload: unknown,
  _envelope: CommandEnvelope,
  ctx: EngineContext,
): EngineHealthData {
  const worker = ctx.syncWorker();
  const syncStatus = worker?.getStatus() ?? null;

  return {
    engineState: ctx.engineState.state,
    engineDescription: ctx.engineState.describe(),
    contractVersion: 1,
    databaseOpen: ctx.databaseOpen,
    sync: syncStatus
      ? {
          state: syncStatus.state,
          lastSyncAt: syncStatus.lastSyncAt,
          lastError: syncStatus.lastError,
          pushed: syncStatus.pushed,
          pulled: syncStatus.pulled,
          pending: syncStatus.pending,
        }
      : null,
    uptime: {
      seconds: Math.floor(process.uptime()),
      nodeVersion: process.versions.node,
      electronVersion: process.versions.electron ?? 'unknown',
      platform: process.platform,
    },
  };
}
