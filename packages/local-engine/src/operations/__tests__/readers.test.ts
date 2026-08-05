import Database from 'better-sqlite3-multiple-ciphers';
import { ALL_ROUTES, CONTRACT_VERSION } from '@bizuri/local-store';
import type { OperationContext } from '../../contracts';
import { buildReaders } from '../read-configs';
import { makeCreateSale } from '../create-sale';
import { makeCancelSale, makeConfirmSale, makeCreateCustomer } from '../sale-ops';
import { runMigrations } from '../../store/migrations';
import type { SqliteDatabase } from '../../store/types';

const TENANT = 't1';
const BRANCH = '11111111-2222-4333-8444-555555555555';
const ITEM = 'aaaaaaaa-0000-4000-8000-000000000001';
const DEVICE = 'dev-1';

let db: SqliteDatabase;
let readers: ReturnType<typeof buildReaders>;
let idCounter: number;

function ctx(overrides: Partial<OperationContext> = {}): OperationContext {
  return {
    request: {
      v: 1,
      id: 'r1',
      operationId: 'x',
      method: 'GET',
      pathParams: {},
      query: {},
      headers: {},
      issuedAt: new Date().toISOString(),
      ...(overrides.request ?? {}),
    },
    tenantId: TENANT,
    branchId: BRANCH,
    ...overrides,
  } as OperationContext;
}

function seedCatalog(itemId: string, name: string, price: string, qty: string, rate = '18') {
  db.prepare(
    `INSERT INTO sales_catalog
       (tenant_id, branch_id, item_id, item_code, item_name, barcode, business_type,
        is_variant, parent_item_id, sell_mode, stock_status, available_qty,
        selling_price, discount, tax_category_name, tax_category_rate,
        unit_of_measure_name, current_batch_id, updated_at, deleted, _pulled_at)
     VALUES (?,?,?,?,?,NULL,'FINISHED_PRODUCT',0,NULL,'IN_STOCK','IN_STOCK',?,?,NULL,
             NULL,?,'Each',NULL,'2026-08-05T09:00:00Z',0,'2026-08-05T09:00:00Z')`,
  ).run(TENANT, BRANCH, itemId, name.slice(0, 3).toUpperCase(), name, qty, price, rate);
}

beforeEach(() => {
  db = new Database(':memory:') as unknown as SqliteDatabase;
  db.pragma('foreign_keys = ON');
  runMigrations(db);

  db.prepare(
    `INSERT INTO device_session
       (device_id, tenant_id, branch_id, tenant_slug, receipt_prefix,
        receipt_seq, last_receipt_hash, contract_version, activated_at)
     VALUES (?,?,?,'t','RCP',0,NULL,?,?)`,
  ).run(DEVICE, TENANT, BRANCH, CONTRACT_VERSION, '2026-08-05T08:00:00Z');

  idCounter = 0;
  readers = buildReaders(() => db);
});

afterEach(() => db.close());

const deps = () => ({
  db,
  deviceId: DEVICE,
  contractVersion: CONTRACT_VERSION,
  now: () => '2026-08-05T10:00:00Z',
  newId: () => `id-${String(++idCounter).padStart(4, '0')}`,
});

// ---------------------------------------------------------------------------

describe('registry completeness', () => {
  it('implements every declared route', () => {
    const implemented = new Set([
      ...Object.keys(readers),
      'createSale',
      'confirmSale',
      'cancelSale',
      'createCustomer',
      'engineUnlock',
      'engineSignIn',
      'engineStatus',
      'engineSyncNow',
    ]);
    const missing = ALL_ROUTES.filter((r) => !implemented.has(r.operationId));
    expect(missing.map((r) => r.operationId)).toEqual([]);
  });
});

describe('generated list readers', () => {
  beforeEach(() => {
    seedCatalog(ITEM, 'Fanta 500ml', '500', '10');
    seedCatalog('bbbbbbbb-0000-4000-8000-000000000002', 'Bread Loaf', '1200', '5', '0');
  });

  it('returns the bare-page envelope for the catalog', () => {
    const res = readers['listSalesCatalog']!(ctx());
    const body = res.data as { data: unknown[]; totalElements: number; hasNext: boolean };

    expect(res.status).toBe(200);
    expect(body.data).toHaveLength(2);
    expect(body.totalElements).toBe(2);
    expect(body.hasNext).toBe(false);
  });

  it('returns the wrapped envelope for tax categories', () => {
    const res = readers['listTaxCategories']!(ctx());
    const body = res.data as { success: boolean; data: unknown[]; meta: unknown };

    expect(body.success).toBe(true);
    expect(Array.isArray(body.data)).toBe(true);
    expect(body.meta).toBeDefined();
  });

  it('filters by search across the declared columns', () => {
    const res = readers['listSalesCatalog']!(
      ctx({ request: { query: { search: 'Bread' } } as never }),
    );
    const body = res.data as { data: { itemName: string }[] };

    expect(body.data).toHaveLength(1);
    expect(body.data[0]!.itemName).toBe('Bread Loaf');
  });

  it('paginates', () => {
    const res = readers['listSalesCatalog']!(
      ctx({ request: { query: { page: '0', size: '1' } } as never }),
    );
    const body = res.data as { data: unknown[]; totalElements: number; hasNext: boolean };

    expect(body.data).toHaveLength(1);
    expect(body.totalElements).toBe(2);
    expect(body.hasNext).toBe(true);
  });

  it('caps page size so a renderer cannot ask for everything', () => {
    const res = readers['listSalesCatalog']!(
      ctx({ request: { query: { size: '99999' } } as never }),
    );
    expect((res.data as { size: number }).size).toBe(100);
  });

  it('excludes tombstoned rows', () => {
    db.prepare('UPDATE sales_catalog SET deleted = 1 WHERE item_id = ?').run(ITEM);
    const res = readers['listSalesCatalog']!(ctx());
    expect((res.data as { data: unknown[] }).data).toHaveLength(1);
  });

  it('scopes to the caller tenant and branch', () => {
    seedCatalogForOtherTenant();
    const res = readers['listSalesCatalog']!(ctx());
    expect((res.data as { totalElements: number }).totalElements).toBe(2);
  });

  function seedCatalogForOtherTenant() {
    db.prepare(
      `INSERT INTO sales_catalog
         (tenant_id, branch_id, item_id, item_code, item_name, business_type,
          is_variant, sell_mode, updated_at, deleted, _pulled_at)
       VALUES ('other', ?, 'zzz', 'ZZZ', 'Other tenant item', 'FINISHED_PRODUCT',
               0, 'IN_STOCK', 'x', 0, 'x')`,
    ).run(BRANCH);
  }
});

describe('generated get readers', () => {
  beforeEach(() => seedCatalog(ITEM, 'Fanta 500ml', '500', '10'));

  it('looks up stock by item id', () => {
    db.prepare(
      `INSERT INTO stock_balances
         (tenant_id, branch_id, item_id, item_code, item_name, business_type,
          branch_name, on_hand_qty, reserved_qty, available_qty, has_variants,
          has_batches, default_selling_price, discount, tax_category_name,
          tax_category_rate, batch_id, expired, updated_at, deleted, _pulled_at)
       VALUES (?,?,?,'FAN','Fanta 500ml','FINISHED_PRODUCT','Main','10','0','10',
               0,0,'500',NULL,NULL,'18',NULL,0,'x',0,'x')`,
    ).run(TENANT, BRANCH, ITEM);

    const res = readers['lookupStockBalance']!(
      ctx({ request: { query: { itemId: ITEM } } as never }),
    );
    expect((res.data as { itemId: string }).itemId).toBe(ITEM);
  });

  it('throws not found for a missing row', () => {
    expect(() =>
      readers['getTaxCategory']!(
        ctx({ request: { pathParams: { taxCategoryId: 'missing' } } as never }),
      ),
    ).toThrow(/not found/i);
  });

  it('throws not found when no lookup parameter is supplied', () => {
    expect(() => readers['lookupStockBalance']!(ctx())).toThrow(/not found/i);
  });
});

describe('sale lifecycle operations', () => {
  beforeEach(() => seedCatalog(ITEM, 'Fanta 500ml', '500', '10'));

  function draft() {
    const res = makeCreateSale(deps())({
      ...ctx(),
      request: {
        ...ctx().request,
        operationId: 'createSale',
        method: 'POST',
        body: {
          intent: 'DRAFT',
          lines: [{ itemId: ITEM, quantity: '1' }],
          payments: [{ method: 'CASH', amount: '500' }],
        },
      },
      idempotencyKey: 'k-draft',
    } as OperationContext);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return (res.data as any).data;
  }

  it('confirms a draft and issues a receipt', () => {
    const sale = draft();
    expect(sale.status).toBe('DRAFT');

    const res = makeConfirmSale(deps())(
      ctx({ request: { pathParams: { saleId: sale.id }, method: 'POST' } as never }),
    );
    const confirmed = (res.data as { data: { status: string } }).data;
    expect(confirmed.status).toBe('CONFIRMED');

    const receipt = db.prepare('SELECT seq FROM receipts WHERE sale_id = ?').get(sale.id);
    expect(receipt).toBeDefined();
  });

  it('is idempotent when confirming twice', () => {
    const sale = draft();
    const confirm = makeConfirmSale(deps());
    confirm(ctx({ request: { pathParams: { saleId: sale.id } } as never }));
    confirm(ctx({ request: { pathParams: { saleId: sale.id } } as never }));

    const count = db
      .prepare('SELECT count(*) AS c FROM receipts WHERE sale_id = ?')
      .get(sale.id) as { c: number };
    expect(count.c).toBe(1);
  });

  it('returns stock when a sale is cancelled', () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const sale = (makeCreateSale(deps())({
      ...ctx(),
      request: {
        ...ctx().request,
        method: 'POST',
        body: {
          intent: 'CONFIRM',
          lines: [{ itemId: ITEM, quantity: '3' }],
          payments: [{ method: 'CASH', amount: '1500' }],
        },
      },
      idempotencyKey: 'k-cancel',
    } as OperationContext).data as any).data;

    const before = db
      .prepare('SELECT available_qty FROM sales_catalog WHERE item_id = ?')
      .get(ITEM) as { available_qty: string };
    expect(Number(before.available_qty)).toBe(7);

    makeCancelSale(deps())(
      ctx({ request: { pathParams: { saleId: sale.id }, method: 'POST' } as never }),
    );

    const after = db
      .prepare('SELECT available_qty FROM sales_catalog WHERE item_id = ?')
      .get(ITEM) as { available_qty: string };
    expect(Number(after.available_qty)).toBe(10);
  });

  it('refuses to cancel a refunded sale', () => {
    const sale = draft();
    db.prepare("UPDATE sales SET status = 'REFUNDED' WHERE id = ?").run(sale.id);

    expect(() =>
      makeCancelSale(deps())(
        ctx({ request: { pathParams: { saleId: sale.id } } as never }),
      ),
    ).toThrow(/Cannot cancel/);
  });
});

describe('createCustomer', () => {
  it('writes locally and queues an outbox row', () => {
    const res = makeCreateCustomer(deps())({
      ...ctx(),
      request: { ...ctx().request, method: 'POST', body: { name: 'Ange Uwase' } },
      idempotencyKey: 'cust-1',
    } as OperationContext);

    const customer = (res.data as { data: { id: string; name: string } }).data;
    expect(customer.name).toBe('Ange Uwase');

    const outbox = db
      .prepare("SELECT operation_id, state FROM outbox WHERE aggregate_type = 'Customer'")
      .get() as { operation_id: string; state: string };
    expect(outbox.operation_id).toBe('createCustomer');
    expect(outbox.state).toBe('PENDING');
  });

  it('returns the original on a repeated idempotency key', () => {
    const create = makeCreateCustomer(deps());
    const first = create({
      ...ctx(),
      request: { ...ctx().request, method: 'POST', body: { name: 'Ange' } },
      idempotencyKey: 'cust-dup',
    } as OperationContext);
    const second = create({
      ...ctx(),
      request: { ...ctx().request, method: 'POST', body: { name: 'Ange' } },
      idempotencyKey: 'cust-dup',
    } as OperationContext);

    const a = (first.data as { data: { id: string } }).data;
    const b = (second.data as { data: { id: string } }).data;
    expect(b.id).toBe(a.id);

    const count = db.prepare('SELECT count(*) AS c FROM customers').get() as { c: number };
    expect(count.c).toBe(1);
  });
});
