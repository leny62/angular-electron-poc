/**
 * Handler registration.
 *
 * Maps every command name to its handler, JSON Schema, rate limit,
 * and session scope.  This is the single place where commands are
 * wired to their implementations — the gateway and pipeline never
 * know about specific handlers.
 *
 * SOLID: Open/Closed — new commands are added by writing a handler
 * and registering it here; the gateway never changes.
 */

import type { SqliteDatabase } from '../../database/types';
import type { CommandDefinition } from '../../shared/contracts';
import type { EngineStateMachine } from '../../domain/engine-state';
import type { JsonSchema } from '../../domain/json-schema-validator';
import type { SyncWorker } from '../../sync/sync-worker';
import { COMMAND_SCHEMAS } from '../../domain/command-schemas';

import { handleSessionUnlock, handleSessionState } from './session-handlers';
import type { SessionContext } from './session-handlers';
import { handleCatalogSearch } from './catalog-handlers';
import type { CatalogContext } from './catalog-handlers';
import { handleSaleCreate, handleSaleGet, handleSaleList } from './sale-handlers';
import type { SaleContext } from './sale-handlers';

// ---------------------------------------------------------------------------
// Shared context
// ---------------------------------------------------------------------------

export interface HandlerContext {
  readonly db: () => SqliteDatabase;
  readonly engineState: EngineStateMachine;
  /** Lazy getter — SyncWorker is created after the window opens. */
  readonly syncWorker: () => SyncWorker | null;
  readonly deviceId: string;
  readonly tenantId: string;
  readonly branchId: string;
  readonly receiptPrefix: string;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createCommandDefinitions(
  ctx: HandlerContext,
): readonly CommandDefinition[] {
  const sessionCtx: SessionContext = {
    engineState: ctx.engineState,
    unlockFn: (_passphrase: string) => {
      // Phase 0: accept any non-empty passphrase.
      // Phase 2: derive key from device secret + machine binding.
      return true;
    },
  };

  const catalogCtx: CatalogContext = {
    db: ctx.db,
    branchId: ctx.branchId,
  };

  const saleCtx: SaleContext = {
    db: ctx.db,
    deviceId: ctx.deviceId,
    tenantId: ctx.tenantId,
    branchId: ctx.branchId,
    receiptPrefix: ctx.receiptPrefix,
  };

  // -----------------------------------------------------------------------
  // Rate-limit tiers (calls per 60s window)
  // -----------------------------------------------------------------------

  const RATE_FREQUENT = 120; // search, list — called often by the UI
  const RATE_WRITE = 20; // mutations — rare but expensive

  // -----------------------------------------------------------------------
  // Helper: build a definition with its JSON Schema
  // -----------------------------------------------------------------------

  const def = (
    name: CommandDefinition['name'],
    handler: CommandDefinition['handler'],
    opts: {
      requiresUnlock?: boolean;
      rateLimit?: number;
    } = {},
  ): CommandDefinition => {
    const schema: JsonSchema | undefined = COMMAND_SCHEMAS.get(name);
    return {
      name,
      handler,
      requiresUnlock: opts.requiresUnlock ?? true,
      rateLimit: opts.rateLimit,
      schema,
    };
  };

  // -----------------------------------------------------------------------
  // Sync handlers (wired to the SyncWorker when available)
  // -----------------------------------------------------------------------

  const syncHandlers = {
    syncNow: (_payload: unknown, _env: unknown) => {
      const worker = ctx.syncWorker();
      if (!worker) {
        return { pushed: 0, pulled: 0, pending: 0, message: 'Sync worker not initialised.' };
      }
      const status = worker.forceSync();
      return {
        pushed: status.pushed,
        pulled: status.pulled,
        pending: status.pending,
        state: status.state,
        message: `Sync cycle triggered. State: ${status.state}.`,
      };
    },
    syncConflicts: (_payload: unknown, _env: unknown) => {
      const worker = ctx.syncWorker();
      if (!worker) {
        return { conflicts: [], total: 0 };
      }
      const conflicts = worker.getConflicts();
      return { conflicts, total: conflicts.length };
    },
    syncResolve: (payload: unknown, _env: unknown) => {
      const worker = ctx.syncWorker();
      if (!worker) {
        return { resolved: false, message: 'Sync worker not initialised.' };
      }
      const { conflictId, resolution } = payload as {
        conflictId?: string;
        resolution?: string;
      };
      if (!conflictId || !resolution) {
        throw Object.assign(
          new Error('conflictId and resolution are required.'),
          { code: 'E_SCHEMA', retryable: false },
        );
      }
      if (resolution !== 'local' && resolution !== 'remote') {
        throw Object.assign(
          new Error('resolution must be "local" or "remote".'),
          { code: 'E_SCHEMA', retryable: false },
        );
      }
      return worker.resolveConflict(conflictId, resolution as 'local' | 'remote');
    },
  };

  return [
    // Session -----------------------------------------------------------
    def('session.unlock',
      (payload, env) => handleSessionUnlock(payload, env, sessionCtx),
      { requiresUnlock: false, rateLimit: 10 },
    ),
    def('session.state',
      (payload, env) => handleSessionState(payload, env, sessionCtx),
      { requiresUnlock: false, rateLimit: RATE_FREQUENT },
    ),

    // Catalog ------------------------------------------------------------
    def('catalog.search',
      (payload, env) => handleCatalogSearch(payload, env, catalogCtx),
      { requiresUnlock: true, rateLimit: RATE_FREQUENT },
    ),

    // Stock --------------------------------------------------------------
    def('stock.balance',
      (_payload, _env) => ({ items: [] }),
      { requiresUnlock: true, rateLimit: RATE_FREQUENT },
    ),
    def('stock.adjust',
      (_payload, _env) => {
        throw Object.assign(
          new Error('Stock adjustment not yet implemented.'),
          { code: 'E_INTERNAL', retryable: false },
        );
      },
      { requiresUnlock: true, rateLimit: RATE_WRITE },
    ),

    // Customer -----------------------------------------------------------
    def('customer.create',
      (_payload, _env) => {
        throw Object.assign(
          new Error('Customer creation not yet implemented.'),
          { code: 'E_INTERNAL', retryable: false },
        );
      },
      { requiresUnlock: true, rateLimit: RATE_WRITE },
    ),
    def('customer.search',
      (_payload, _env) => ({ customers: [], total: 0 }),
      { requiresUnlock: true, rateLimit: RATE_FREQUENT },
    ),

    // Sale ---------------------------------------------------------------
    def('sale.create',
      (payload, env) => handleSaleCreate(payload, env, saleCtx),
      { requiresUnlock: true, rateLimit: RATE_WRITE },
    ),
    def('sale.get',
      (payload, env) => handleSaleGet(payload, env, saleCtx),
      { requiresUnlock: true, rateLimit: RATE_FREQUENT },
    ),
    def('sale.list',
      (payload, env) => handleSaleList(payload, env, saleCtx),
      { requiresUnlock: true, rateLimit: RATE_FREQUENT },
    ),

    // Sync ---------------------------------------------------------------
    def('sync.now', syncHandlers.syncNow, { requiresUnlock: true, rateLimit: 6 }),
    def('sync.conflicts', syncHandlers.syncConflicts, { requiresUnlock: true, rateLimit: RATE_FREQUENT }),
    def('sync.resolve', syncHandlers.syncResolve, { requiresUnlock: true, rateLimit: RATE_WRITE }),
  ];
}
