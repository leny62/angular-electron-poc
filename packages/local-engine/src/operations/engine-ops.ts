import { CONTRACT_VERSION, LOCAL_SCHEMA_VERSION, TIER_1_TABLES } from '@bizuri/local-store';
import { EngineError, type OperationContext, type OperationResult } from '../contracts';
import type { EngineStateMachine } from '../domain/engine-state';
import { hydratedTables } from '../remote/hydrate';
import { summariseOutbox } from '../remote/push-outbox';
import type { Credentials, Session } from '../remote/remote-client';
import type { SqliteDatabase } from '../store/types';

export interface EngineOpsDeps {
  readonly engineState: EngineStateMachine;
  readonly db: () => SqliteDatabase | null;
  readonly deviceId: string;
  readonly unlock: (passphrase: string) => Promise<void>;
  readonly syncNow: () => Promise<unknown>;
  /** Current tenant/branch scope, or null before sign-in. */
  readonly scope: () => { tenantId: string; branchId: string } | null;
  /** Sign in to the remote API. Called once from the unlock screen. */
  readonly signIn: (credentials: Credentials) => Promise<Session>;
}

export function makeEngineOps(deps: EngineOpsDeps) {
  return {
    engineUnlock: async (ctx: OperationContext): Promise<OperationResult<unknown>> => {
      const { passphrase } = ctx.request.body as { passphrase: string };

      try {
        await deps.unlock(passphrase);
      } catch (err) {
        // A wrong passphrase and a corrupt file are told apart in the log, not
        // in the response: distinguishing them for the caller confirms that a
        // guessed passphrase was merely wrong rather than unusable.
        console.warn('[engine] unlock failed:', err);
        throw new EngineError('E_FORBIDDEN', 'Unable to unlock. Check the passphrase.');
      }

      return { status: 200, data: buildStatus(deps), durableAt: new Date().toISOString() };
    },

    engineSignIn: async (ctx: OperationContext): Promise<OperationResult<unknown>> => {
      const body = ctx.request.body as { email: string; password: string; subdomainSlug: string };

      try {
        await deps.signIn(body);
      } catch (err) {
        console.warn('[engine] sign-in failed:', err);
        const message =
          err instanceof Error ? err.message : 'Sign-in failed. Check your credentials.';
        throw new EngineError('E_FORBIDDEN', message);
      }

      return { status: 200, data: buildStatus(deps), durableAt: new Date().toISOString() };
    },

    engineStatus: (): OperationResult<unknown> => ({
      status: 200,
      data: buildStatus(deps),
    }),

    engineSyncNow: async (): Promise<OperationResult<unknown>> => {
      if (!deps.engineState.isOperational) {
        throw new EngineError('E_LOCKED', `Engine is ${deps.engineState.state}.`);
      }
      const result = await deps.syncNow();
      return { status: 200, data: { success: true, message: 'Sync complete', data: result } };
    },
  };
}

function buildStatus(deps: EngineOpsDeps) {
  const db = deps.db();
  const currentScope = deps.scope();

  const hydrated = db ? hydratedTables(db) : new Set<string>();
  const outbox = db
    ? summariseOutbox(db)
    : { pending: 0, inflight: 0, synced: 0, failed: 0, conflict: 0, oldestPendingAt: null };

  return {
    state: deps.engineState.state,
    reason: deps.engineState.reason,
    deviceId: deps.deviceId,
    contractVersion: CONTRACT_VERSION,
    localSchemaVersion: LOCAL_SCHEMA_VERSION,
    tenantId: currentScope?.tenantId ?? null,
    branchId: currentScope?.branchId ?? null,
    hydration: {
      tier1Complete: TIER_1_TABLES.every((t) => hydrated.has(t)),
      hydrated: [...hydrated],
      pending: TIER_1_TABLES.filter((t) => !hydrated.has(t)),
    },
    outbox,
  };
}
