/**
 * Route table tests.
 *
 * The specificity-ordering tests here guard a real bug: `/core/sales/catalog`
 * and `/core/sales/{saleId}` both match a request for the catalog, and if the
 * parameterised route wins, the cashier's catalog search silently becomes a
 * sale lookup for a sale whose id is the string "catalog". It would return an
 * empty result rather than an error, so nothing would look broken.
 */

import {
  ALL_ROUTES,
  compileRoutes,
  ENGINE_ROUTES,
  OFFLINE_OPERATION_IDS,
  REQUEST_SCHEMAS,
  ROUTES,
  routeFor,
  TABLES_BY_NAME,
} from '../index';
import type { CompiledRoute } from '../index';

/** Resolve a method + path the way OfflineHttpBackend will. */
function match(
  compiled: readonly CompiledRoute[],
  method: string,
  path: string,
): { operationId: string; params: Record<string, string> } | null {
  for (const c of compiled) {
    if (c.route.method !== method) continue;
    const m = c.regex.exec(path);
    if (!m) continue;
    const params: Record<string, string> = {};
    c.paramNames.forEach((n, i) => {
      params[n] = decodeURIComponent(m[i + 1] ?? '');
    });
    return { operationId: c.route.operationId, params };
  }
  return null;
}

describe('path specificity', () => {
  const compiled = compileRoutes();

  it('resolves /core/sales/catalog to listSalesCatalog, not getSale', () => {
    const r = match(compiled, 'GET', '/core/sales/catalog');
    expect(r?.operationId).toBe('listSalesCatalog');
    expect(r?.params).toEqual({});
  });

  it('still resolves a real sale id to getSale', () => {
    const r = match(compiled, 'GET', '/core/sales/9f2b1c44-0000-4000-8000-000000000001');
    expect(r?.operationId).toBe('getSale');
    expect(r?.params['saleId']).toBe('9f2b1c44-0000-4000-8000-000000000001');
  });

  it('resolves /core/stock-balances/lookup ahead of the list route', () => {
    expect(match(compiled, 'GET', '/core/stock-balances/lookup')?.operationId).toBe(
      'lookupStockBalance',
    );
    expect(match(compiled, 'GET', '/core/stock-balances')?.operationId).toBe(
      'listStockBalances',
    );
  });

  it('resolves the deeper confirm and cancel routes over getSale', () => {
    expect(match(compiled, 'POST', '/core/sales/abc/confirm')?.operationId).toBe(
      'confirmSale',
    );
    expect(match(compiled, 'POST', '/core/sales/abc/cancel')?.operationId).toBe(
      'cancelSale',
    );
  });

  it('distinguishes methods on the same path', () => {
    expect(match(compiled, 'GET', '/core/sales')?.operationId).toBe('listSales');
    expect(match(compiled, 'POST', '/core/sales')?.operationId).toBe('createSale');
  });

  it('returns null for a path with no offline route', () => {
    // Purchases are explicitly never offline, so this must fall through to the
    // network rather than being served from a stale local table.
    expect(match(compiled, 'GET', '/core/purchase-orders')).toBeNull();
    expect(match(compiled, 'GET', '/core/goods-received-notes')).toBeNull();
    expect(match(compiled, 'DELETE', '/core/customers/abc')).toBeNull();
  });

  it('does not match a path that merely starts with a route path', () => {
    // Anchoring matters: an unanchored regex would let /core/sales/abc/refunds
    // be served locally as getSale, and refunds are not in the Wave 1 slice.
    expect(match(compiled, 'GET', '/core/sales/abc/refunds')).toBeNull();
    expect(match(compiled, 'GET', '/core/sales/catalog/extra')).toBeNull();
  });

  it('does not let a path parameter span a segment boundary', () => {
    // `[^/]+` rather than `.+`, so a two-segment tail cannot be captured as one
    // parameter value.
    const r = match(compiled, 'GET', '/core/customers/a/b');
    expect(r).toBeNull();
  });

  it('url-decodes path parameters', () => {
    const r = match(compiled, 'GET', '/core/receipts/RCP%2F001');
    expect(r?.operationId).toBe('getReceipt');
    expect(r?.params['receiptNumber']).toBe('RCP/001');
  });
});

describe('route table integrity', () => {
  it('has no duplicate operationIds', () => {
    const ids = ALL_ROUTES.map((r) => r.operationId);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('has no duplicate method + path pairs', () => {
    const keys = ALL_ROUTES.map((r) => `${r.method} ${r.path}`);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('gives every route a request schema', () => {
    // Gate 4 has nothing to validate against otherwise, so an operation with no
    // schema would accept arbitrary renderer input.
    for (const r of ALL_ROUTES) {
      expect(REQUEST_SCHEMAS[r.operationId]).toBeDefined();
    }
  });

  it('has no request schema without a route', () => {
    for (const operationId of Object.keys(REQUEST_SCHEMAS)) {
      expect(routeFor(operationId)).toBeDefined();
    }
  });

  it('points every route table at a declared table', () => {
    for (const r of ALL_ROUTES) {
      if (!r.table) continue;
      expect(TABLES_BY_NAME.has(r.table)).toBe(true);
    }
  });

  it('gives generated operations a table to read from', () => {
    for (const r of ALL_ROUTES) {
      if (r.kind === 'generated-list' || r.kind === 'generated-get') {
        expect(r.table).toBeDefined();
      }
    }
  });

  it('gives every route a positive rate limit', () => {
    for (const r of ALL_ROUTES) {
      expect(r.rateLimit).toBeGreaterThan(0);
    }
  });

  it('exposes exactly the declared operationIds as the allow-list', () => {
    expect(OFFLINE_OPERATION_IDS.size).toBe(ALL_ROUTES.length);
    for (const r of ALL_ROUTES) {
      expect(OFFLINE_OPERATION_IDS.has(r.operationId)).toBe(true);
    }
  });
});

describe('unlock requirements', () => {
  it('requires unlock for every contract-derived operation', () => {
    // Nothing that touches tenant data may be reachable while LOCKED.
    for (const r of ROUTES) {
      expect(r.requiresUnlock).toBe(true);
    }
  });

  it('allows only engine status and unlock while locked', () => {
    const open = ENGINE_ROUTES.filter((r) => !r.requiresUnlock).map((r) => r.operationId);
    expect(open.sort()).toEqual(['engineStatus', 'engineUnlock']);
  });

  it('keeps the unlock rate limit low enough to blunt guessing', () => {
    // 600k-iteration PBKDF2 already makes each attempt slow; this bounds the
    // attempt rate too, so a scripted renderer cannot grind the passphrase.
    const unlock = routeFor('engineUnlock');
    expect(unlock?.rateLimit).toBeLessThanOrEqual(10);
  });
});

describe('handwritten surface stays small', () => {
  it('keeps handwritten operations to the transactional ones', () => {
    const handwritten = ROUTES.filter((r) => r.kind === 'handwritten').map(
      (r) => r.operationId,
    );
    // If this list grows, the generated-read design has stopped paying for
    // itself and the route needs re-examining.
    expect(handwritten.sort()).toEqual(
      ['cancelSale', 'confirmSale', 'createCustomer', 'createSale'].sort(),
    );
  });

  it('serves the majority of the surface from generated readers', () => {
    const generated = ROUTES.filter((r) => r.kind !== 'handwritten').length;
    expect(generated).toBeGreaterThan(ROUTES.length / 2);
  });
});
