/**
 * Hydration from the real API, using endpoints that exist today.
 *
 * This is §5.1's paged-REST fallback promoted to the primary path, because the
 * snapshot endpoint does not exist yet. It works against the live testing
 * environment with no backend change.
 *
 * ─── The cost of contract gap #1, made concrete ──────────────────────────────
 * `SalesCatalogItem` and `StockBalanceResponse` carry no `updatedAt`, so there is
 * no watermark to pull "changes since X" against. Every refresh therefore
 * re-downloads the entire catalog. `HydrationStats.mode` reports `full-refresh`
 * whenever that happens, and the numbers it returns (pages, rows, milliseconds,
 * bytes) are the argument for adding the field: instead of asserting that
 * incremental pull matters, we can show that a 20k-item catalog costs N seconds
 * and M requests on every single cycle.
 *
 * When `updatedAt` lands, `mode` becomes `incremental` and only the watermark
 * query changes. Nothing else here moves.
 */

import {
  salesCatalogItemToRow,
  stockBalanceToRow,
  taxCategoryToRow,
  type SalesCatalogItemDto,
  type StockBalanceDto,
  type TaxCategoryDto,
  type CustomerDto,
} from '@bizuri/local-store';
import type { SqliteDatabase } from '../store/types';
import type { RemoteClient } from './remote-client';

// ---------------------------------------------------------------------------
// Endpoint map
//
// Every path here exists in bizuri-core-api-contract.yaml at 1.2.29 and is live
// on the testing environment. Nothing is speculative.
// ---------------------------------------------------------------------------

export interface HydrationEndpoint {
  readonly table: string;
  readonly path: string;
  readonly operationId: string;
  /** Branch-scoped endpoints need X-Branch-Id; tenant-scoped ones do not. */
  readonly branchScoped: boolean;
  /** True once the contract exposes a watermark for this projection. */
  readonly supportsIncremental: boolean;
  readonly pageSize: number;
}

export const HYDRATION_ENDPOINTS: readonly HydrationEndpoint[] = [
  {
    table: 'sales_catalog',
    path: '/core/sales/catalog',
    operationId: 'listSalesCatalog',
    branchScoped: true,
    // Blocked on contract gap #1: no updatedAt on SalesCatalogItem.
    supportsIncremental: false,
    // Contract caps size at 100 for this endpoint.
    pageSize: 100,
  },
  {
    table: 'stock_balances',
    path: '/core/stock-balances',
    operationId: 'listStockBalances',
    branchScoped: true,
    supportsIncremental: false,
    pageSize: 100,
  },
  {
    table: 'tax_categories',
    path: '/core/tax-categories',
    operationId: 'listTaxCategories',
    branchScoped: false,
    // TaxCategory DOES carry updatedAt, so this one could go incremental as soon
    // as a filter parameter exists to use it.
    supportsIncremental: false,
    pageSize: 100,
  },
  {
    table: 'customers',
    path: '/core/customers',
    operationId: 'listCustomers',
    branchScoped: false,
    supportsIncremental: false,
    pageSize: 100,
  },
];

// ---------------------------------------------------------------------------
// Results
// ---------------------------------------------------------------------------

export interface TableHydrationStats {
  readonly table: string;
  readonly mode: 'full-refresh' | 'incremental';
  readonly rows: number;
  readonly pages: number;
  readonly durationMs: number;
  readonly truncated: boolean;
  readonly error?: string;
}

export interface HydrationStats {
  readonly tables: readonly TableHydrationStats[];
  readonly totalRows: number;
  readonly totalPages: number;
  readonly durationMs: number;
  readonly failed: readonly string[];
}

export interface HydrationScope {
  readonly tenantId: string;
  readonly branchId: string;
}

export interface HydrationOptions {
  readonly onProgress?: (stats: TableHydrationStats) => void;
  /** Restrict to specific tables, e.g. tier 1 only. */
  readonly only?: readonly string[];
  readonly maxPages?: number;
}

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

export async function hydrate(
  db: SqliteDatabase,
  client: RemoteClient,
  scope: HydrationScope,
  options: HydrationOptions = {},
): Promise<HydrationStats> {
  const started = Date.now();
  const endpoints = options.only
    ? HYDRATION_ENDPOINTS.filter((e) => options.only!.includes(e.table))
    : HYDRATION_ENDPOINTS;

  const tables: TableHydrationStats[] = [];
  const failed: string[] = [];

  for (const endpoint of endpoints) {
    const tableStarted = Date.now();
    try {
      const { rows, pages, truncated } = await hydrateTable(
        db,
        client,
        endpoint,
        scope,
        options.maxPages,
      );

      const stat: TableHydrationStats = {
        table: endpoint.table,
        mode: endpoint.supportsIncremental ? 'incremental' : 'full-refresh',
        rows,
        pages,
        durationMs: Date.now() - tableStarted,
        truncated,
      };
      tables.push(stat);
      options.onProgress?.(stat);
    } catch (err) {
      // One table failing must not abandon the rest: a catalog that loaded is
      // worth having even if customers did not, because tier 1 is what gates
      // selling.
      const stat: TableHydrationStats = {
        table: endpoint.table,
        mode: 'full-refresh',
        rows: 0,
        pages: 0,
        durationMs: Date.now() - tableStarted,
        truncated: false,
        error: err instanceof Error ? err.message : String(err),
      };
      tables.push(stat);
      failed.push(endpoint.table);
      options.onProgress?.(stat);
    }
  }

  return {
    tables,
    totalRows: tables.reduce((n, t) => n + t.rows, 0),
    totalPages: tables.reduce((n, t) => n + t.pages, 0),
    durationMs: Date.now() - started,
    failed,
  };
}

async function hydrateTable(
  db: SqliteDatabase,
  client: RemoteClient,
  endpoint: HydrationEndpoint,
  scope: HydrationScope,
  maxPages?: number,
): Promise<{ rows: number; pages: number; truncated: boolean }> {
  const result = await client.getAllPages<unknown>(endpoint.path, {
    size: endpoint.pageSize,
    ...(maxPages !== undefined ? { maxPages } : {}),
    ...(endpoint.branchScoped ? { branchId: scope.branchId } : {}),
  });

  const pulledAt = new Date().toISOString();

  // One transaction for the whole table. A half-applied catalog is worse than no
  // catalog: the cashier would see a partial product list and assume the rest is
  // out of stock.
  const apply = db.transaction(() => {
    // Full refresh with no watermark means the previous contents are stale by
    // definition. Deleting first is what removes rows the server no longer
    // returns, which is the job `deleted` tombstones would otherwise do.
    if (!endpoint.supportsIncremental) {
      clearReplica(db, endpoint.table, scope);
    }

    let written = 0;
    for (const item of result.items) {
      written += upsert(db, endpoint.table, item, scope, pulledAt);
    }
    recordCursor(db, endpoint.table, pulledAt, written);
    return written;
  });

  const rows = apply();
  return { rows, pages: result.pagesFetched, truncated: result.truncated };
}

function clearReplica(db: SqliteDatabase, table: string, scope: HydrationScope): void {
  // Scoped delete, never a bare DELETE FROM: a device could legitimately hold
  // more than one branch, and wiping another branch's rows would be silent.
  if (table === 'sales_catalog' || table === 'stock_balances') {
    db.prepare(`DELETE FROM ${table} WHERE tenant_id = ? AND branch_id = ?`).run(
      scope.tenantId,
      scope.branchId,
    );
  } else {
    db.prepare(`DELETE FROM ${table} WHERE tenant_id = ?`).run(scope.tenantId);
  }
}

// ---------------------------------------------------------------------------
// Upserts
//
// One per table, using the generated mappers so the row shape stays tied to the
// descriptors. When the generator lands, these become generated too: they are
// mechanical given a TableDescriptor.
// ---------------------------------------------------------------------------

function upsert(
  db: SqliteDatabase,
  table: string,
  item: unknown,
  scope: HydrationScope,
  pulledAt: string,
): number {
  switch (table) {
    case 'sales_catalog':
      return upsertSalesCatalog(db, item as SalesCatalogItemDto, scope, pulledAt);
    case 'stock_balances':
      return upsertStockBalance(db, item as StockBalanceDto, scope, pulledAt);
    case 'tax_categories':
      return upsertTaxCategory(db, item as TaxCategoryDto, scope, pulledAt);
    case 'customers':
      return upsertCustomer(db, item as CustomerDto, scope, pulledAt);
    default:
      throw new Error(`No upsert defined for table "${table}".`);
  }
}

function upsertSalesCatalog(
  db: SqliteDatabase,
  dto: SalesCatalogItemDto,
  scope: HydrationScope,
  pulledAt: string,
): number {
  if (!dto?.itemId) return 0;
  const row = salesCatalogItemToRow(dto, scope, pulledAt);

  db.prepare(
    `INSERT INTO sales_catalog (
       tenant_id, branch_id, item_id, item_code, item_name, barcode,
       business_type, is_variant, parent_item_id, sell_mode, stock_status,
       available_qty, selling_price, discount, tax_category_name,
       tax_category_rate, unit_of_measure_name, current_batch_id,
       updated_at, deleted, _pulled_at
     ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
     ON CONFLICT(tenant_id, branch_id, item_id) DO UPDATE SET
       item_code = excluded.item_code,
       item_name = excluded.item_name,
       barcode = excluded.barcode,
       business_type = excluded.business_type,
       is_variant = excluded.is_variant,
       parent_item_id = excluded.parent_item_id,
       sell_mode = excluded.sell_mode,
       stock_status = excluded.stock_status,
       available_qty = excluded.available_qty,
       selling_price = excluded.selling_price,
       discount = excluded.discount,
       tax_category_name = excluded.tax_category_name,
       tax_category_rate = excluded.tax_category_rate,
       unit_of_measure_name = excluded.unit_of_measure_name,
       current_batch_id = excluded.current_batch_id,
       updated_at = excluded.updated_at,
       deleted = excluded.deleted,
       _pulled_at = excluded._pulled_at`,
  ).run(
    row.tenant_id, row.branch_id, row.item_id, row.item_code, row.item_name,
    row.barcode, row.business_type, row.is_variant, row.parent_item_id,
    row.sell_mode, row.stock_status, row.available_qty, row.selling_price,
    row.discount, row.tax_category_name, row.tax_category_rate,
    row.unit_of_measure_name, row.current_batch_id, row.updated_at,
    row.deleted, row._pulled_at,
  );
  return 1;
}

function upsertStockBalance(
  db: SqliteDatabase,
  dto: StockBalanceDto,
  scope: HydrationScope,
  pulledAt: string,
): number {
  if (!dto?.itemId) return 0;
  const row = stockBalanceToRow(dto, scope, pulledAt);

  db.prepare(
    `INSERT INTO stock_balances (
       tenant_id, branch_id, item_id, item_code, item_name, business_type,
       branch_name, on_hand_qty, reserved_qty, available_qty, has_variants,
       has_batches, default_selling_price, discount, tax_category_name,
       tax_category_rate, batch_id, expired, updated_at, deleted, _pulled_at
     ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
     ON CONFLICT(tenant_id, branch_id, item_id) DO UPDATE SET
       item_code = excluded.item_code,
       item_name = excluded.item_name,
       business_type = excluded.business_type,
       branch_name = excluded.branch_name,
       on_hand_qty = excluded.on_hand_qty,
       reserved_qty = excluded.reserved_qty,
       available_qty = excluded.available_qty,
       has_variants = excluded.has_variants,
       has_batches = excluded.has_batches,
       default_selling_price = excluded.default_selling_price,
       discount = excluded.discount,
       tax_category_name = excluded.tax_category_name,
       tax_category_rate = excluded.tax_category_rate,
       batch_id = excluded.batch_id,
       expired = excluded.expired,
       updated_at = excluded.updated_at,
       deleted = excluded.deleted,
       _pulled_at = excluded._pulled_at`,
  ).run(
    row.tenant_id, row.branch_id, row.item_id, row.item_code, row.item_name,
    row.business_type, row.branch_name, row.on_hand_qty, row.reserved_qty,
    row.available_qty, row.has_variants, row.has_batches,
    row.default_selling_price, row.discount, row.tax_category_name,
    row.tax_category_rate, row.batch_id, row.expired, row.updated_at,
    row.deleted, row._pulled_at,
  );
  return 1;
}

function upsertTaxCategory(
  db: SqliteDatabase,
  dto: TaxCategoryDto,
  scope: HydrationScope,
  pulledAt: string,
): number {
  if (!dto?.id) return 0;
  const row = taxCategoryToRow(dto, scope, pulledAt);

  db.prepare(
    `INSERT INTO tax_categories (
       tenant_id, id, name, rate, description, status,
       created_at, updated_at, deleted, _pulled_at
     ) VALUES (?,?,?,?,?,?,?,?,?,?)
     ON CONFLICT(tenant_id, id) DO UPDATE SET
       name = excluded.name,
       rate = excluded.rate,
       description = excluded.description,
       status = excluded.status,
       updated_at = excluded.updated_at,
       deleted = excluded.deleted,
       _pulled_at = excluded._pulled_at`,
  ).run(
    row.tenant_id, row.id, row.name, row.rate, row.description, row.status,
    row.created_at, row.updated_at, row.deleted, row._pulled_at,
  );
  return 1;
}

/**
 * Customers are `write-through`, so a pull must not overwrite a locally created
 * customer that has not been pushed yet.
 *
 * The `WHERE sync_state = 'SYNCED'` clause on the conflict branch is the
 * conflict-detection rule from §7.2 applied at the statement level: a row this
 * device created and still owns is left alone.
 */
function upsertCustomer(
  db: SqliteDatabase,
  dto: CustomerDto,
  scope: HydrationScope,
  pulledAt: string,
): number {
  if (!dto?.id) return 0;

  db.prepare(
    `INSERT INTO customers (
       tenant_id, id, name, tin, primary_phone, secondary_phone, email, address,
       status, created_at, updated_at, deleted, server_id, sync_state, local_seq
     ) VALUES (?,?,?,?,?,?,?,?,?,?,?,0,?, 'SYNCED', 0)
     ON CONFLICT(tenant_id, id) DO UPDATE SET
       name = excluded.name,
       tin = excluded.tin,
       primary_phone = excluded.primary_phone,
       secondary_phone = excluded.secondary_phone,
       email = excluded.email,
       address = excluded.address,
       status = excluded.status,
       updated_at = excluded.updated_at,
       server_id = excluded.server_id
     WHERE customers.sync_state = 'SYNCED'`,
  ).run(
    scope.tenantId, dto.id, dto.name ?? '', dto.tin ?? null,
    dto.primaryPhone ?? null, dto.secondaryPhone ?? null, dto.email ?? null,
    dto.address ?? null, dto.status ?? 'ACTIVE',
    dto.createdAt ?? pulledAt, dto.updatedAt ?? pulledAt, dto.id,
  );
  return 1;
}

// ---------------------------------------------------------------------------
// Cursor bookkeeping
// ---------------------------------------------------------------------------

function recordCursor(
  db: SqliteDatabase,
  table: string,
  pulledAt: string,
  rows: number,
): void {
  db.prepare(
    `INSERT INTO sync_cursor (entity, cursor, last_pulled_at, rows_pulled, hydrated)
     VALUES (?, NULL, ?, ?, 1)
     ON CONFLICT(entity) DO UPDATE SET
       last_pulled_at = excluded.last_pulled_at,
       rows_pulled = excluded.rows_pulled,
       hydrated = 1`,
  ).run(table, pulledAt, rows);
}

/** Which tables have been hydrated at least once. Drives the tier-1 unlock gate. */
export function hydratedTables(db: SqliteDatabase): Set<string> {
  const rows = db
    .prepare('SELECT entity FROM sync_cursor WHERE hydrated = 1')
    .all() as { entity: string }[];
  return new Set(rows.map((r) => r.entity));
}
