/**
 * Handler registration.
 *
 * Maps every command name to its handler and dependencies.
 * This is the single place where commands are wired to their
 * implementations — the gateway never knows about specific handlers.
 */

import type { SqliteDatabase } from '../../database/types';
import type { CommandDefinition } from '../../shared/contracts';
import type { EngineStateMachine } from '../../domain/engine-state';

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

  return [
    // Session
    {
      name: 'session.unlock',
      handler: (payload, env) => handleSessionUnlock(payload, env, sessionCtx),
      requiresUnlock: false,
    },
    {
      name: 'session.state',
      handler: (payload, env) => handleSessionState(payload, env, sessionCtx),
      requiresUnlock: false,
    },

    // Catalog
    {
      name: 'catalog.search',
      handler: (payload, env) => handleCatalogSearch(payload, env, catalogCtx),
      requiresUnlock: true,
    },

    // Sale
    {
      name: 'sale.create',
      handler: (payload, env) => handleSaleCreate(payload, env, saleCtx),
      requiresUnlock: true,
    },
    {
      name: 'sale.get',
      handler: (payload, env) => handleSaleGet(payload, env, saleCtx),
      requiresUnlock: true,
    },
    {
      name: 'sale.list',
      handler: (payload, env) => handleSaleList(payload, env, saleCtx),
      requiresUnlock: true,
    },

    // Sync (stubs for Phase 2)
    {
      name: 'sync.now',
      handler: (_payload, _env) => ({
        pushed: 0,
        pulled: 0,
        message: 'Sync worker not yet integrated (Phase 2).',
      }),
      requiresUnlock: true,
    },
    {
      name: 'sync.conflicts',
      handler: (_payload, _env) => ({ conflicts: [] }),
      requiresUnlock: true,
    },
    {
      name: 'sync.resolve',
      handler: (_payload, _env) => ({
        resolved: false,
        message: 'Conflict resolution not yet integrated (Phase 2).',
      }),
      requiresUnlock: true,
    },

    // Stock (stubs for Phase 2)
    {
      name: 'stock.balance',
      handler: (_payload, _env) => ({ items: [] }),
      requiresUnlock: true,
    },
    {
      name: 'stock.adjust',
      handler: (_payload, _env) => {
        throw Object.assign(
          new Error('Stock adjustment not yet implemented (Phase 2).'),
          { code: 'E_INTERNAL', retryable: false },
        );
      },
      requiresUnlock: true,
    },

    // Customer (stubs for Phase 2)
    {
      name: 'customer.create',
      handler: (_payload, _env) => {
        throw Object.assign(
          new Error('Customer creation not yet implemented (Phase 2).'),
          { code: 'E_INTERNAL', retryable: false },
        );
      },
      requiresUnlock: true,
    },
    {
      name: 'customer.search',
      handler: (_payload, _env) => ({ customers: [], total: 0 }),
      requiresUnlock: true,
    },
  ];
}
