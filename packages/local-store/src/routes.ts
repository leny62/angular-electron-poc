/**
 * Offline route table.
 *
 * GENERATOR TARGET.  Every `operationId`, `method`, and `path` below was read
 * out of `bizuri-core-api-contract.yaml` at 1.2.29 — none are invented.  The
 * generator emits one entry per operation whose schema carries `x-offline`, or
 * whose path is one of the four new `/core/sync/*` endpoints.
 *
 * This table serves three consumers, which is why it exists as data rather
 * than as a switch statement:
 *
 *   1. `packages/offline-http`  matches an outgoing HttpRequest against it to
 *                               decide local-vs-network.
 *   2. gate 2 (allow-list)      rejects any operationId not present here.
 *   3. gate 6 (rate limit)      reads `rateLimit` per operation.
 *
 * `kind` is what keeps the hand-written surface small: `generated-*` operations
 * are emitted whole by the generator, and only `handwritten` ones need a human.
 * Six of the nineteen entries below are handwritten.
 */

import type { RouteDescriptor } from './types';

// ---------------------------------------------------------------------------
// Sales slice (Wave 1)
// ---------------------------------------------------------------------------

export const ROUTES: readonly RouteDescriptor[] = [
  // --- catalog & stock: pure replica reads, fully generated ---------------
  {
    operationId: 'listSalesCatalog',
    method: 'GET',
    path: '/core/sales/catalog',
    kind: 'generated-list',
    table: 'sales_catalog',
    // High: this is the cashier typing in a search box, one call per keystroke
    // after debounce. 600/min is ~10/s, comfortably above human typing speed.
    rateLimit: 600,
    requiresUnlock: true,
  },
  {
    operationId: 'listStockBalances',
    method: 'GET',
    path: '/core/stock-balances',
    kind: 'generated-list',
    table: 'stock_balances',
    rateLimit: 300,
    requiresUnlock: true,
  },
  {
    operationId: 'lookupStockBalance',
    method: 'GET',
    path: '/core/stock-balances/lookup',
    kind: 'generated-get',
    table: 'stock_balances',
    // Barcode scanner: one call per scan, and a scanner can fire fast.
    rateLimit: 600,
    requiresUnlock: true,
  },

  // --- reference data: replica reads --------------------------------------
  {
    operationId: 'listTaxCategories',
    method: 'GET',
    path: '/core/tax-categories',
    kind: 'generated-list',
    table: 'tax_categories',
    rateLimit: 120,
    requiresUnlock: true,
  },
  {
    operationId: 'getTaxCategory',
    method: 'GET',
    path: '/core/tax-categories/{taxCategoryId}',
    kind: 'generated-get',
    table: 'tax_categories',
    rateLimit: 120,
    requiresUnlock: true,
  },

  // --- customers: write-through -------------------------------------------
  {
    operationId: 'listCustomers',
    method: 'GET',
    path: '/core/customers',
    kind: 'generated-list',
    table: 'customers',
    rateLimit: 300,
    requiresUnlock: true,
  },
  {
    operationId: 'getCustomer',
    method: 'GET',
    path: '/core/customers/{customerId}',
    kind: 'generated-get',
    table: 'customers',
    rateLimit: 300,
    requiresUnlock: true,
  },
  {
    operationId: 'createCustomer',
    method: 'POST',
    path: '/core/customers',
    // Handwritten: local UUID allocation plus outbox enqueue, and the
    // server_id has to be adopted from the push acknowledgement later.
    kind: 'handwritten',
    table: 'customers',
    rateLimit: 60,
    requiresUnlock: true,
  },

  // --- sales: the money path ----------------------------------------------
  {
    operationId: 'createSale',
    method: 'POST',
    path: '/core/sales',
    // Handwritten: stock validation, FEFO batch pick, ledger writes, receipt
    // hash chain, and outbox enqueue, all inside one SQLite transaction.
    kind: 'handwritten',
    table: 'sales',
    rateLimit: 120,
    requiresUnlock: true,
  },
  {
    operationId: 'listSales',
    method: 'GET',
    path: '/core/sales',
    kind: 'generated-list',
    table: 'sales',
    rateLimit: 120,
    requiresUnlock: true,
  },
  {
    operationId: 'getSale',
    method: 'GET',
    path: '/core/sales/{saleId}',
    kind: 'generated-get',
    table: 'sales',
    rateLimit: 300,
    requiresUnlock: true,
  },
  {
    operationId: 'confirmSale',
    method: 'POST',
    path: '/core/sales/{saleId}/confirm',
    // Handwritten: releases DRAFT_HOLD_OUT and posts SALE_DEDUCT_OUT.
    kind: 'handwritten',
    table: 'sales',
    rateLimit: 120,
    requiresUnlock: true,
  },
  {
    operationId: 'cancelSale',
    method: 'POST',
    path: '/core/sales/{saleId}/cancel',
    // Handwritten: reverses holds with opposing ledger entries.
    kind: 'handwritten',
    table: 'sales',
    rateLimit: 60,
    requiresUnlock: true,
  },

  // --- receipts: locally generated, hash-chained ---------------------------
  {
    operationId: 'listReceipts',
    method: 'GET',
    path: '/core/receipts',
    kind: 'generated-list',
    table: 'receipts',
    rateLimit: 120,
    requiresUnlock: true,
  },
  {
    operationId: 'getReceipt',
    method: 'GET',
    path: '/core/receipts/{receiptNumber}',
    kind: 'generated-get',
    table: 'receipts',
    rateLimit: 120,
    requiresUnlock: true,
  },
];

// ---------------------------------------------------------------------------
// Engine-local operations
//
// These have no OpenAPI counterpart: they are the renderer asking the engine
// about itself.  They are the only operations with `requiresUnlock: false`,
// because the unlock screen has to be able to call them.
// ---------------------------------------------------------------------------

export const ENGINE_ROUTES: readonly RouteDescriptor[] = [
  {
    operationId: 'engineUnlock',
    method: 'POST',
    path: '/_engine/unlock',
    kind: 'handwritten',
    rateLimit: 10, // deliberately low: this is a passphrase attempt
    requiresUnlock: false,
  },
  {
    operationId: 'engineStatus',
    method: 'GET',
    path: '/_engine/status',
    kind: 'handwritten',
    rateLimit: 240, // polled by the status bar
    requiresUnlock: false,
  },
  {
    operationId: 'engineSignIn',
    method: 'POST',
    path: '/_engine/signin',
    kind: 'handwritten',
    rateLimit: 10, // deliberately low: this is an authentication attempt
    requiresUnlock: false,
  },
  {
    operationId: 'engineSyncNow',
    method: 'POST',
    path: '/_engine/sync',
    kind: 'handwritten',
    rateLimit: 20,
    requiresUnlock: true,
  },
];

// ---------------------------------------------------------------------------
// Lookup helpers
// ---------------------------------------------------------------------------

export const ALL_ROUTES: readonly RouteDescriptor[] = [...ROUTES, ...ENGINE_ROUTES];

export const ROUTES_BY_OPERATION: ReadonlyMap<string, RouteDescriptor> = new Map(
  ALL_ROUTES.map((r) => [r.operationId, r]),
);

/** Gate 2's allow-list. Anything absent is rejected without echoing the name. */
export const OFFLINE_OPERATION_IDS: ReadonlySet<string> = new Set(
  ALL_ROUTES.map((r) => r.operationId),
);

export function routeFor(operationId: string): RouteDescriptor | undefined {
  return ROUTES_BY_OPERATION.get(operationId);
}

// ---------------------------------------------------------------------------
// Path matching
// ---------------------------------------------------------------------------

/**
 * Compiled matcher for one route.  Path templates become anchored regexes with
 * named capture groups, so `/core/sales/{saleId}` matches `/core/sales/abc-123`
 * and yields `{ saleId: 'abc-123' }`.
 *
 * Longest literal prefix wins, which is why ordering matters: `/core/sales`
 * must not shadow `/core/sales/catalog`.  `compileRoutes` sorts to guarantee
 * that regardless of the order routes are declared in.
 */
export interface CompiledRoute {
  readonly route: RouteDescriptor;
  readonly regex: RegExp;
  readonly paramNames: readonly string[];
}

export function compileRoute(route: RouteDescriptor): CompiledRoute {
  const paramNames: string[] = [];

  const pattern = route.path
    // Escape regex metacharacters that legitimately appear in paths.
    .replace(/[.+*?^$()[\]|\\]/g, '\\$&')
    // Replace {param} with a segment matcher.
    .replace(/\{(\w+)\}/g, (_m, name: string) => {
      paramNames.push(name);
      return '([^/]+)';
    });

  return {
    route,
    regex: new RegExp(`^${pattern}$`),
    paramNames,
  };
}

/**
 * Compile every route, ordered so that more specific paths are tried first.
 *
 * Sort key is (number of path segments desc, number of `{params}` asc). A
 * literal segment is always more specific than a parameter at the same depth,
 * so `/core/sales/catalog` is tested before `/core/sales/{saleId}` and a
 * request for the catalog can never be mistaken for a sale lookup with
 * `saleId === 'catalog'`.
 */
export function compileRoutes(
  routes: readonly RouteDescriptor[] = ALL_ROUTES,
): readonly CompiledRoute[] {
  return [...routes]
    .sort((a, b) => {
      const segs = (p: string) => p.split('/').length;
      const params = (p: string) => (p.match(/\{/g) ?? []).length;
      return segs(b.path) - segs(a.path) || params(a.path) - params(b.path);
    })
    .map(compileRoute);
}
