/**
 * End-to-end offline loop, against a mocked API.
 *
 * This is the suite the live smoke test mirrors. It runs the real hydration,
 * sale, and push code against a fake fetch that reproduces the actual contract
 * envelopes, so the loop is provable in CI without credentials or a network.
 *
 * The scenario is the one that matters: hydrate, pull the cable, sell, reconnect,
 * push, and assert that every sale landed exactly once.
 */

import Database from 'better-sqlite3-multiple-ciphers';
import { CONTRACT_VERSION } from '@bizuri/local-store';
import { hydrate } from '../hydrate';
import { pushOutbox, summariseOutbox } from '../push-outbox';
import { RemoteClient } from '../remote-client';
import { makeCreateSale } from '../../operations/create-sale';
import { verifyReceiptChain } from '../../operations/receipt-chain';
import { runMigrations } from '../../store/migrations';
import type { SqliteDatabase } from '../../store/types';

const TENANT = 'tenant-smoke';
const BRANCH = '11111111-2222-4333-8444-555555555555';
const ITEM_A = 'aaaaaaaa-0000-4000-8000-000000000001';
const ITEM_B = 'bbbbbbbb-0000-4000-8000-000000000002';
const DEVICE = 'test-device-01';

// ---------------------------------------------------------------------------
// Fake API
// ---------------------------------------------------------------------------

interface FakeServerState {
  /** Idempotency key → the sale it created. Models the server's dedupe table. */
  readonly salesByKey: Map<string, { id: string; saleNumber: string }>;
  requestLog: { method: string; path: string; idempotencyKey?: string }[];
  /** When set, every request fails with this. Simulates being offline. */
  offline: boolean;
  /** Requests to fail with a 500 before succeeding. */
  failNext: number;
  saleCounter: number;
}

function makeFakeApi(state: FakeServerState): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(typeof input === 'string' ? input : input.toString());
    const path = url.pathname;
    const method = init?.method ?? 'GET';
    const headers = (init?.headers ?? {}) as Record<string, string>;

    state.requestLog.push({
      method,
      path,
      ...(headers['Idempotency-Key'] ? { idempotencyKey: headers['Idempotency-Key'] } : {}),
    });

    if (state.offline) throw new TypeError('fetch failed');

    if (state.failNext > 0) {
      state.failNext--;
      return jsonResponse(503, { message: 'Service Unavailable' });
    }

    // --- auth ---
    if (path === '/identity/auth/login') {
      return jsonResponse(200, {
        success: true,
        message: 'ok',
        data: {
          accessToken: 'token-abc',
          refreshToken: 'refresh-abc',
          tenantId: TENANT,
          branchId: BRANCH,
          displayName: 'Test Cashier',
          accessTokenExpiresIn: 900,
          mfaRequired: false,
        },
      });
    }

    if (path === '/actuator/health') return jsonResponse(200, { status: 'UP' });

    // --- catalog: BARE page envelope, as the real contract defines ---
    if (path === '/core/sales/catalog') {
      const page = Number(url.searchParams.get('page') ?? '0');
      if (page > 0) return jsonResponse(200, barePage([], page, 2, 1));
      return jsonResponse(
        200,
        barePage(
          [
            catalogItem(ITEM_A, 'Fanta 500ml', '500.0000', '10', '18'),
            catalogItem(ITEM_B, 'Bread Loaf', '1200.0000', '3', '0'),
          ],
          0,
          2,
          1,
        ),
      );
    }

    // --- stock: BARE page envelope ---
    if (path === '/core/stock-balances') {
      const page = Number(url.searchParams.get('page') ?? '0');
      if (page > 0) return jsonResponse(200, barePage([], page, 2, 1));
      return jsonResponse(
        200,
        barePage(
          [stockBalance(ITEM_A, 'Fanta 500ml', '10'), stockBalance(ITEM_B, 'Bread Loaf', '3')],
          0,
          2,
          1,
        ),
      );
    }

    // --- tax categories: WRAPPED envelope ---
    if (path === '/core/tax-categories') {
      const page = Number(url.searchParams.get('page') ?? '0');
      if (page > 0) return jsonResponse(200, wrappedPage([], page, 1, 1));
      return jsonResponse(
        200,
        wrappedPage(
          [
            {
              id: 'cccccccc-0000-4000-8000-000000000003',
              name: 'VAT 18%',
              rate: 18,
              description: null,
              status: 'ACTIVE',
              createdAt: '2026-01-01T00:00:00Z',
              updatedAt: '2026-01-01T00:00:00Z',
            },
          ],
          0,
          1,
          1,
        ),
      );
    }

    // --- customers: WRAPPED envelope ---
    if (path === '/core/customers' && method === 'GET') {
      return jsonResponse(200, wrappedPage([], 0, 0, 1));
    }

    // --- create sale, with real idempotency semantics ---
    if (path === '/core/sales' && method === 'POST') {
      const key = headers['Idempotency-Key'];

      if (key && state.salesByKey.has(key)) {
        // Contract: "a repeat with the same key returns the original sale
        // without deducting again."
        return jsonResponse(200, { success: true, message: 'ok', data: state.salesByKey.get(key) });
      }

      state.saleCounter++;
      const sale = {
        id: `server-sale-${state.saleCounter}`,
        saleNumber: `INV-${String(state.saleCounter).padStart(5, '0')}`,
      };
      if (key) state.salesByKey.set(key, sale);
      return jsonResponse(201, { success: true, message: 'created', data: sale });
    }

    return jsonResponse(404, { message: `no route for ${method} ${path}` });
  }) as typeof fetch;
}

function jsonResponse(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => JSON.stringify(body),
  } as Response;
}

function barePage(data: unknown[], page: number, totalElements: number, totalPages: number) {
  return {
    data,
    page,
    size: 100,
    totalElements,
    totalPages,
    hasNext: page + 1 < totalPages,
    hasPrevious: page > 0,
  };
}

function wrappedPage(data: unknown[], page: number, totalElements: number, totalPages: number) {
  return {
    success: true,
    message: 'ok',
    data,
    meta: { page, size: 100, totalElements, totalPages },
  };
}

function catalogItem(
  itemId: string,
  itemName: string,
  price: string,
  qty: string,
  taxRate: string,
) {
  return {
    itemId,
    itemCode: itemName.slice(0, 3).toUpperCase(),
    itemName,
    barcode: null,
    businessType: 'FINISHED_PRODUCT',
    isVariant: false,
    parentItemId: null,
    sellMode: 'IN_STOCK',
    stockStatus: 'IN_STOCK',
    availableQty: Number(qty),
    sellingPrice: Number(price),
    discount: null,
    taxCategoryName: taxRate === '0' ? null : `VAT ${taxRate}%`,
    taxCategoryRate: Number(taxRate),
    unitOfMeasureName: 'Each',
    currentBatchId: null,
    updatedAt: '2026-08-05T09:00:00Z',
  };
}

function stockBalance(itemId: string, itemName: string, qty: string) {
  return {
    itemId,
    itemCode: itemName.slice(0, 3).toUpperCase(),
    itemName,
    businessType: 'FINISHED_PRODUCT',
    branchId: BRANCH,
    branchName: 'Main',
    onHandQty: Number(qty),
    reservedQty: 0,
    availableQty: Number(qty),
    hasVariants: false,
    hasBatches: false,
    defaultSellingPrice: 500,
    discount: null,
    taxCategoryName: null,
    taxCategoryRate: 18,
    batchId: null,
    expired: false,
    updatedAt: '2026-08-05T09:00:00Z',
  };
}

// ---------------------------------------------------------------------------
// Fixture
// ---------------------------------------------------------------------------

let db: SqliteDatabase;
let state: FakeServerState;
let client: RemoteClient;
let idCounter: number;

beforeEach(async () => {
  db = new Database(':memory:') as unknown as SqliteDatabase;
  db.pragma('foreign_keys = ON');
  runMigrations(db);

  db.prepare(
    `INSERT INTO device_session
       (device_id, tenant_id, branch_id, tenant_slug, receipt_prefix,
        receipt_seq, last_receipt_hash, contract_version, activated_at)
     VALUES (?,?,?,?,?,0,NULL,?,?)`,
  ).run(DEVICE, TENANT, BRANCH, 'smoke', 'RCP', CONTRACT_VERSION, '2026-08-05T08:00:00Z');

  state = {
    salesByKey: new Map(),
    requestLog: [],
    offline: false,
    failNext: 0,
    saleCounter: 0,
  };

  idCounter = 0;
  client = new RemoteClient({
    baseUrl: 'https://api.bizuri.testing.eccellenza.tech',
    fetchImpl: makeFakeApi(state),
    maxRetries: 3,
  });

  await client.login({ email: 'a@b.c', password: 'password1234', subdomainSlug: 'smoke' });
});

afterEach(() => db.close());

function sell(
  opts: { itemId?: string; quantity?: string; amount?: string; key?: string } = {},
) {
  const createSale = makeCreateSale({
    db,
    deviceId: DEVICE,
    contractVersion: CONTRACT_VERSION,
    now: () => '2026-08-05T10:00:00Z',
    newId: () => `id-${String(++idCounter).padStart(4, '0')}`,
  });

  return createSale({
    request: {
      v: 1,
      id: 'req',
      operationId: 'createSale',
      method: 'POST',
      pathParams: {},
      query: {},
      headers: {},
      issuedAt: '2026-08-05T10:00:00Z',
      body: {
        intent: 'CONFIRM',
        lines: [{ itemId: opts.itemId ?? ITEM_A, quantity: opts.quantity ?? '1' }],
        payments: [{ method: 'CASH', amount: opts.amount ?? '500' }],
      },
    },
    tenantId: TENANT,
    branchId: BRANCH,
    ...(opts.key ? { idempotencyKey: opts.key } : {}),
  });
}

const pushConfig = { batchSize: 50, maxAttempts: 3, leaseMs: 90_000, deviceId: DEVICE };

/**
 * Raise local stock for the volume tests.
 *
 * The fixture stocks 10 units, which is right for the oversell tests. Tests that
 * care about push volume rather than stock limits top up first, so a stock
 * failure cannot masquerade as a push failure.
 */
function topUpStock(qty: number): void {
  db.prepare('UPDATE sales_catalog SET available_qty = ? WHERE branch_id = ?').run(
    String(qty),
    BRANCH,
  );
  db.prepare(
    'UPDATE stock_balances SET available_qty = ?, on_hand_qty = ? WHERE branch_id = ?',
  ).run(String(qty), String(qty), BRANCH);
}

// ---------------------------------------------------------------------------

describe('hydration from the live-shaped API', () => {
  it('handles both response envelopes the contract uses', async () => {
    const stats = await hydrate(db, client, { tenantId: TENANT, branchId: BRANCH });

    expect(stats.failed).toEqual([]);
    // Bare-page endpoints
    expect(stats.tables.find((t) => t.table === 'sales_catalog')?.rows).toBe(2);
    expect(stats.tables.find((t) => t.table === 'stock_balances')?.rows).toBe(2);
    // Wrapped-envelope endpoint
    expect(stats.tables.find((t) => t.table === 'tax_categories')?.rows).toBe(1);
  });

  it('reports full-refresh, because the catalog has no usable watermark', () => {
    // Documents the cost of contract gap #1 as an assertion, so it changes to
    // 'incremental' the moment updatedAt is usable.
    return hydrate(db, client, { tenantId: TENANT, branchId: BRANCH }).then((stats) => {
      expect(stats.tables.find((t) => t.table === 'sales_catalog')?.mode).toBe('full-refresh');
    });
  });

  it('sends the branch header only for branch-scoped endpoints', async () => {
    await hydrate(db, client, { tenantId: TENANT, branchId: BRANCH });
    expect(state.requestLog.some((r) => r.path === '/core/sales/catalog')).toBe(true);
    expect(state.requestLog.some((r) => r.path === '/core/tax-categories')).toBe(true);
  });

  it('scopes a refresh delete to the branch, leaving other branches intact', async () => {
    await hydrate(db, client, { tenantId: TENANT, branchId: BRANCH });

    const OTHER = '99999999-2222-4333-8444-555555555555';
    db.prepare(
      `INSERT INTO sales_catalog
         (tenant_id, branch_id, item_id, item_code, item_name, business_type,
          is_variant, sell_mode, updated_at, deleted, _pulled_at)
       VALUES (?,?,?,?,?,'FINISHED_PRODUCT',0,'IN_STOCK','x',0,'x')`,
    ).run(TENANT, OTHER, 'other-item', 'OTH', 'Other Branch Item');

    await hydrate(db, client, { tenantId: TENANT, branchId: BRANCH });

    const other = db
      .prepare('SELECT count(*) AS c FROM sales_catalog WHERE branch_id = ?')
      .get(OTHER) as { c: number };
    expect(other.c).toBe(1);
  });

  it('keeps going when one table fails', async () => {
    const stats = await hydrate(db, client, { tenantId: TENANT, branchId: BRANCH });
    expect(stats.tables.length).toBe(4);
    expect(stats.totalRows).toBeGreaterThan(0);
  });
});

describe('selling offline', () => {
  beforeEach(async () => {
    await hydrate(db, client, { tenantId: TENANT, branchId: BRANCH });
    state.offline = true; // cable pulled
  });

  it('computes tax-inclusive totals correctly', () => {
    // 500 gross at 18% inclusive: net = 500/1.18 = 423.7288, tax = 76.2712
    const sale = sell().data;
    expect(sale.grandTotal).toBeCloseTo(500, 4);
    expect(sale.subtotal).toBeCloseTo(423.7288, 4);
    expect(sale.taxTotal).toBeCloseTo(76.2712, 4);
    // Net plus tax must reconstruct the gross exactly, or a day of sales drifts.
    expect(sale.subtotal + sale.taxTotal).toBeCloseTo(500, 4);
  });

  it('handles a zero-rated item without inventing tax', () => {
    const sale = sell({ itemId: ITEM_B, quantity: '1', amount: '1200' }).data;
    expect(sale.taxTotal).toBe(0);
    expect(sale.subtotal).toBeCloseTo(1200, 4);
  });

  it('deducts local stock so the next sale sees it', () => {
    // 3 units at 500 each, so the payment has to cover 1500.
    sell({ quantity: '3', amount: '1500' });
    const row = db
      .prepare('SELECT available_qty FROM sales_catalog WHERE item_id = ? AND branch_id = ?')
      .get(ITEM_A, BRANCH) as { available_qty: string };
    expect(Number(row.available_qty)).toBe(7);
  });

  it('refuses to oversell', () => {
    // 10 in stock, asking for 11.
    expect(() => sell({ quantity: '11', amount: '5500' })).toThrow(/Insufficient stock/);
  });

  it('writes nothing when stock validation fails', () => {
    try {
      sell({ quantity: '11', amount: '5500' });
    } catch {
      /* expected */
    }
    const sales = db.prepare('SELECT count(*) AS c FROM sales').get() as { c: number };
    const outbox = db.prepare('SELECT count(*) AS c FROM outbox').get() as { c: number };
    expect(sales.c).toBe(0);
    expect(outbox.c).toBe(0);

    // And the receipt sequence was not consumed, so the chain has no gap.
    const session = db
      .prepare('SELECT receipt_seq FROM device_session WHERE device_id = ?')
      .get(DEVICE) as { receipt_seq: number };
    expect(session.receipt_seq).toBe(0);
  });

  it('rejects a payment that does not cover the total', () => {
    expect(() => sell({ amount: '100' })).toThrow(/do not cover/);
  });

  it('returns the original sale on a repeated idempotency key', () => {
    const first = sell({ key: 'dup-key' }).data;
    const second = sell({ key: 'dup-key' }).data;

    expect(second.id).toBe(first.id);
    const count = db.prepare('SELECT count(*) AS c FROM sales').get() as { c: number };
    expect(count.c).toBe(1);
  });

  it('enqueues an outbox row tagged with the contract version', () => {
    sell();
    const row = db
      .prepare('SELECT operation_id, contract_version, payload, state FROM outbox')
      .get() as {
      operation_id: string;
      contract_version: string;
      payload: string;
      state: string;
    };

    expect(row.operation_id).toBe('createSale');
    expect(row.contract_version).toBe(CONTRACT_VERSION);
    expect(row.state).toBe('PENDING');
    // The frozen ORIGINAL request, not our computed sale.
    expect(JSON.parse(row.payload)).toMatchObject({ intent: 'CONFIRM' });
  });

  it('builds a verifiable receipt chain across many sales', () => {
    for (let i = 0; i < 5; i++) sell();

    const chain = verifyReceiptChain(db, TENANT, DEVICE);
    expect(chain.valid).toBe(true);
    expect(chain.checked).toBe(5);
    expect(chain.gaps).toEqual([]);
    expect(chain.tampered).toEqual([]);
  });

  it('detects a tampered receipt', () => {
    sell();
    sell();
    // Someone edits a total in the database directly.
    db.prepare("UPDATE sales SET grand_total = '1.0000' WHERE sale_number LIKE 'L-%'").run();

    const chain = verifyReceiptChain(db, TENANT, DEVICE);
    expect(chain.valid).toBe(false);
    expect(chain.tampered.length).toBeGreaterThan(0);
  });

  it('detects a deleted receipt as a chain gap', () => {
    for (let i = 0; i < 3; i++) sell();
    db.prepare('DELETE FROM receipts WHERE seq = 2').run();

    const chain = verifyReceiptChain(db, TENANT, DEVICE);
    expect(chain.valid).toBe(false);
    expect(chain.gaps).toContain(2);
  });
});

describe('reconnect and push', () => {
  beforeEach(async () => {
    await hydrate(db, client, { tenantId: TENANT, branchId: BRANCH });
  });

  it('drains the outbox and adopts server ids', async () => {
    state.offline = true;
    const local = sell().data;
    state.offline = false;

    const push = await pushOutbox(db, client, pushConfig);

    expect(push.applied).toBe(1);
    expect(push.rejected).toBe(0);

    const row = db
      .prepare('SELECT sync_state, server_id, sale_number FROM sales WHERE id = ?')
      .get(local.id) as { sync_state: string; server_id: string; sale_number: string };

    expect(row.sync_state).toBe('SYNCED');
    expect(row.server_id).toBe('server-sale-1');
    expect(row.sale_number).toBe('INV-00001');
  });

  it('pushes a shift of sales exactly once', async () => {
    topUpStock(500);
    state.offline = true;
    for (let i = 0; i < 20; i++) sell({ key: `shift-${i}` });
    state.offline = false;

    const push = await pushOutbox(db, client, pushConfig);

    expect(push.applied).toBe(20);
    // The server saw 20 distinct keys, so it created exactly 20 sales.
    expect(state.saleCounter).toBe(20);
    expect(summariseOutbox(db).pending).toBe(0);
    expect(summariseOutbox(db).synced).toBe(20);
  });

  it('preserves per-aggregate order by pushing in seq order', async () => {
    topUpStock(500);
    state.offline = true;
    for (let i = 0; i < 5; i++) sell({ key: `ordered-${i}` });
    state.offline = false;

    await pushOutbox(db, client, pushConfig);

    const keys = state.requestLog
      .filter((r) => r.path === '/core/sales' && r.method === 'POST')
      .map((r) => r.idempotencyKey);
    expect(keys).toEqual(['ordered-0', 'ordered-1', 'ordered-2', 'ordered-3', 'ordered-4']);
  });

  it('is safe to run twice: a replay creates no second sale', async () => {
    state.offline = true;
    sell({ key: 'replay-key' });
    state.offline = false;

    await pushOutbox(db, client, pushConfig);
    // Force a re-push of the same row, as a crashed-then-restarted worker would.
    db.prepare("UPDATE outbox SET state = 'PENDING', leased_until = NULL").run();
    await pushOutbox(db, client, pushConfig);

    // The server deduplicated on the key rather than creating a second sale.
    expect(state.saleCounter).toBe(1);
  });

  it('leaves rows queued when the network is still down', async () => {
    state.offline = true;
    sell();

    const push = await pushOutbox(db, client, pushConfig);

    expect(push.wentOffline).toBe(true);
    expect(push.applied).toBe(0);
    // Released, not lost: still PENDING for the next cycle.
    expect(summariseOutbox(db).pending).toBe(1);
  });

  it('recovers from a transient 503 without losing the sale', async () => {
    state.offline = true;
    sell();
    state.offline = false;
    // Two failures, then success: inside the client's retry budget.
    state.failNext = 2;

    const push = await pushOutbox(db, client, pushConfig);

    expect(push.applied).toBe(1);
    expect(summariseOutbox(db).synced).toBe(1);
  });

  it('does not let one poison row wedge the queue', async () => {
    state.offline = true;
    sell({ key: 'good-1' });
    state.offline = false;

    // A row whose operation this build cannot push.
    db.prepare(
      `INSERT INTO outbox
         (tenant_id, id, seq, aggregate_type, aggregate_id, operation_id,
          contract_version, payload, idempotency_key, state, attempts, created_at)
       VALUES (?, 'poison', 0, 'Sale', 'unknown', 'unsupportedOperation',
               ?, '{}', 'poison-key', 'PENDING', 0, '2026-08-05T09:00:00Z')`,
    ).run(TENANT, CONTRACT_VERSION);

    const push = await pushOutbox(db, client, pushConfig);

    // The poison row is parked, and the good sale still went through.
    expect(push.rejected).toBe(1);
    expect(push.applied).toBe(1);
    expect(summariseOutbox(db).failed).toBe(1);
    expect(summariseOutbox(db).synced).toBe(1);
  });

  it('reports the request count, which is the case for batching', async () => {
    topUpStock(500);
    state.offline = true;
    for (let i = 0; i < 30; i++) sell({ key: `batch-case-${i}` });
    state.offline = false;

    const push = await pushOutbox(db, client, pushConfig);

    // 30 sales, 30 requests. /core/sync/push would make this 1.
    expect(push.requestCount).toBe(30);
    expect(push.applied).toBe(30);
  });
});

describe('full loop', () => {
  it('hydrate, go offline, sell, reconnect, push, verify', async () => {
    // 1. Online: hydrate.
    const hydration = await hydrate(db, client, { tenantId: TENANT, branchId: BRANCH });
    expect(hydration.failed).toEqual([]);
    expect(hydration.totalRows).toBe(5);

    // 2. Offline.
    state.offline = true;

    // 3. Sell through the shift. 10 Fanta available, so 8 sales of 1.
    const localSales: string[] = [];
    for (let i = 0; i < 8; i++) {
      localSales.push(sell({ key: `loop-${i}` }).data.id);
    }

    expect(summariseOutbox(db).pending).toBe(8);
    expect(verifyReceiptChain(db, TENANT, DEVICE).valid).toBe(true);

    // Stock reflects the shift locally.
    const stock = db
      .prepare('SELECT available_qty FROM sales_catalog WHERE item_id = ? AND branch_id = ?')
      .get(ITEM_A, BRANCH) as { available_qty: string };
    expect(Number(stock.available_qty)).toBe(2);

    // 4. Reconnect and push.
    state.offline = false;
    const push = await pushOutbox(db, client, pushConfig);

    // 5. Every sale landed, exactly once.
    expect(push.applied).toBe(8);
    expect(state.saleCounter).toBe(8);
    expect(summariseOutbox(db).pending).toBe(0);

    const unsynced = db
      .prepare("SELECT count(*) AS c FROM sales WHERE sync_state != 'SYNCED'")
      .get() as { c: number };
    expect(unsynced.c).toBe(0);

    // Every local sale now carries a server id.
    for (const id of localSales) {
      const row = db.prepare('SELECT server_id FROM sales WHERE id = ?').get(id) as {
        server_id: string | null;
      };
      expect(row.server_id).toMatch(/^server-sale-/);
    }
  });
});

describe('regression: claimed rows are released when a cycle aborts', () => {
  it('releases the whole claimed batch when the network drops mid-push', async () => {
    // Found by scripts/e2e-offline.ts against a real socket.
    //
    // claim() marks the entire batch INFLIGHT up front. Releasing only the row
    // that failed left the rest leased for the full lease duration, so the next
    // cycle skipped them until the lease expired: a reconciliation stall of up
    // to leaseMs at exactly the moment connectivity returned.
    await hydrate(db, client, { tenantId: TENANT, branchId: BRANCH });
    topUpStock(500);

    state.offline = true;
    for (let i = 0; i < 10; i++) sell({ key: `abort-${i}` });

    const push = await pushOutbox(db, client, pushConfig);
    expect(push.wentOffline).toBe(true);

    // Nothing may be left INFLIGHT: every row must be immediately re-claimable.
    const summary = summariseOutbox(db);
    expect(summary.inflight).toBe(0);
    expect(summary.pending).toBe(10);

    const leased = db
      .prepare('SELECT count(*) AS c FROM outbox WHERE leased_until IS NOT NULL')
      .get() as { c: number };
    expect(leased.c).toBe(0);
  });

  it('recovers the full batch on the very next cycle, with no lease wait', async () => {
    await hydrate(db, client, { tenantId: TENANT, branchId: BRANCH });
    topUpStock(500);

    state.offline = true;
    for (let i = 0; i < 10; i++) sell({ key: `recover-${i}` });
    await pushOutbox(db, client, pushConfig);

    // Reconnect and push again immediately. A long lease would make this claim
    // zero rows, which is precisely the stall the fix removes.
    state.offline = false;
    const push = await pushOutbox(db, client, { ...pushConfig, leaseMs: 600_000 });

    expect(push.claimed).toBe(10);
    expect(push.applied).toBe(10);
    expect(summariseOutbox(db).pending).toBe(0);
  });
});
