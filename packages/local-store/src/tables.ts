/**
 * Table descriptors for the offline sales slice.
 *
 * GENERATOR TARGET. Every descriptor here is derivable from
 * `bizuri-core-api-contract.yaml` plus an `x-offline` block on the schema.
 * Column names, types, and nullability were transcribed from the real contract
 * at version 1.2.29 — see the `schema:` field on each table for the source.
 *
 * Two kinds of column appear that are NOT in the contract today:
 *
 *   updated_at / deleted   Proposed additions to `mode: replica` schemas.
 *                          Marked PROPOSED below.  Without `updated_at`
 *                          incremental pull is impossible; without `deleted`
 *                          a discontinued item stays sellable offline forever.
 *                          These are contract gaps #1 and #2 in
 *                          docs/offline-architecture-plan.md §2.4.
 *
 *   scope + sync columns   Injected by the generator from `x-offline.scope`
 *                          and from `mode`.  Not present in any DTO.
 */

import { LOG_COMPONENTS, LOG_LEVELS, LOG_SOURCES } from './log-vocabulary';
import type { ColumnDescriptor, TableDescriptor } from './types';

// ---------------------------------------------------------------------------
// Column shorthands
//
// Terse constructors so the descriptors stay reviewable.  A generator emits
// calls in exactly this form; there is nothing here it cannot produce.
// ---------------------------------------------------------------------------

const col = (
  name: string,
  field: string | undefined,
  type: ColumnDescriptor['type'],
  nullable: boolean,
  extra: Partial<ColumnDescriptor> = {},
): ColumnDescriptor => ({ name, field, type, nullable, ...extra });

const uuid = (n: string, f: string, nullable = false) => col(n, f, 'UUID', nullable);
const text = (n: string, f: string, nullable = false) => col(n, f, 'TEXT', nullable);
const dec = (n: string, f: string, nullable = false) => col(n, f, 'DECIMAL', nullable);
const int = (n: string, f: string, nullable = false) => col(n, f, 'INTEGER', nullable);
const ts = (n: string, f: string, nullable = false) => col(n, f, 'TIMESTAMP', nullable);
const bool = (n: string, f: string, defaultSql = '0') =>
  col(n, f, 'BOOLEAN', false, { defaultSql });
const enumCol = (n: string, f: string, values: readonly string[], nullable = false) =>
  col(n, f, 'TEXT', nullable, { enumValues: values });

// ---------------------------------------------------------------------------
// Enum value sets, transcribed from the contract's enum schemas
// ---------------------------------------------------------------------------

const BUSINESS_TYPE = ['FINISHED_PRODUCT', 'RAW_MATERIAL'] as const;
const SELL_MODE = ['IN_STOCK', 'MADE_TO_ORDER'] as const;
const STOCK_STATUS = ['IN_STOCK', 'LOW_STOCK', 'OUT_OF_STOCK'] as const;
const CUSTOMER_STATUS = ['ACTIVE', 'INACTIVE'] as const;
const PAYMENT_METHOD = ['CASH', 'BANK', 'MOBILE_MONEY', 'CREDIT'] as const;
const SALE_STATUS = [
  'DRAFT',
  'CONFIRMED',
  'CREDITED',
  'CANCELLED',
  'EXPIRED',
  'REFUNDED',
] as const;

/** Local-only. Tracks whether a write-through row has reached the server. */
const SYNC_STATE = ['PENDING', 'SYNCED', 'CONFLICT', 'FAILED'] as const;

/** Local-only. Outbox lifecycle. */
const OUTBOX_STATE = ['PENDING', 'INFLIGHT', 'SYNCED', 'CONFLICT', 'FAILED'] as const;

/**
 * Local-only. Diagnostic vocabulary, shared with the gate-4 schemas and the log
 * viewer's filters so the three cannot drift. See `log-vocabulary.ts`.
 */
const LOG_LEVEL = LOG_LEVELS;
const LOG_COMPONENT = LOG_COMPONENTS;
const LOG_SOURCE = LOG_SOURCES;

// ---------------------------------------------------------------------------
// Injected column groups, added by the generator based on `mode`
// ---------------------------------------------------------------------------

/** Scope columns. Populated from X-Tenant-Id / X-Branch-Id, never from a DTO. */
const SCOPE_COLUMNS: readonly ColumnDescriptor[] = [
  col('tenant_id', undefined, 'TEXT', false, {
    comment: 'From X-Tenant-Id. Enforces tenant isolation on every local read.',
  }),
  col('branch_id', undefined, 'UUID', false, {
    comment: 'From X-Branch-Id. Selling branch context.',
  }),
];

/** Bookkeeping added to every `replica` table. */
const REPLICA_COLUMNS: readonly ColumnDescriptor[] = [
  col('_pulled_at', undefined, 'TIMESTAMP', false, {
    comment: 'When the pull worker last wrote this row. Drives staleness display.',
  }),
];

/** Bookkeeping added to every `write-through` table. */
const WRITE_THROUGH_COLUMNS: readonly ColumnDescriptor[] = [
  col('server_id', undefined, 'UUID', true, {
    comment: 'Server-assigned id, adopted from the push response. NULL until pushed.',
  }),
  col('sync_state', undefined, 'TEXT', false, {
    enumValues: SYNC_STATE,
    defaultSql: "'PENDING'",
  }),
  col('local_seq', undefined, 'INTEGER', false, {
    comment: 'Device-local monotonic sequence. Preserves per-aggregate push order.',
  }),
];

// ---------------------------------------------------------------------------
// replica: sales_catalog  ←  SalesCatalogItem
// ---------------------------------------------------------------------------

export const SALES_CATALOG: TableDescriptor = {
  table: 'sales_catalog',
  schema: 'SalesCatalogItem',
  mode: 'replica',
  primaryKey: ['item_id', 'branch_id'],
  watermark: 'updated_at',
  scope: ['tenant_id', 'branch_id'],
  columns: [
    ...SCOPE_COLUMNS,
    uuid('item_id', 'itemId'),
    text('item_code', 'itemCode'),
    text('item_name', 'itemName'),
    text('barcode', 'barcode', true),
    enumCol('business_type', 'businessType', BUSINESS_TYPE),
    bool('is_variant', 'isVariant'),
    uuid('parent_item_id', 'parentItemId', true),
    enumCol('sell_mode', 'sellMode', SELL_MODE),
    enumCol('stock_status', 'stockStatus', STOCK_STATUS, true),
    dec('available_qty', 'availableQty', true),
    dec('selling_price', 'sellingPrice', true),
    dec('discount', 'discount', true),
    text('tax_category_name', 'taxCategoryName', true),
    dec('tax_category_rate', 'taxCategoryRate', true),
    text('unit_of_measure_name', 'unitOfMeasureName', true),
    uuid('current_batch_id', 'currentBatchId', true),
    // PROPOSED (contract gap #1): required for incremental pull.
    ts('updated_at', 'updatedAt'),
    // PROPOSED (contract gap #2): tombstone marker.
    bool('deleted', 'deleted'),
    ...REPLICA_COLUMNS,
  ],
  indexes: [
    ['tenant_id', 'branch_id', 'item_name'],
    ['tenant_id', 'branch_id', 'barcode'],
    ['tenant_id', 'branch_id', 'updated_at'],
  ],
  uniqueIndexes: [],
};

// ---------------------------------------------------------------------------
// replica: stock_balances  ←  StockBalanceResponse
// ---------------------------------------------------------------------------

export const STOCK_BALANCES: TableDescriptor = {
  table: 'stock_balances',
  schema: 'StockBalanceResponse',
  mode: 'replica',
  primaryKey: ['item_id', 'branch_id'],
  watermark: 'updated_at',
  scope: ['tenant_id', 'branch_id'],
  columns: [
    ...SCOPE_COLUMNS,
    uuid('item_id', 'itemId'),
    text('item_code', 'itemCode'),
    text('item_name', 'itemName'),
    enumCol('business_type', 'businessType', BUSINESS_TYPE),
    text('branch_name', 'branchName', true),
    dec('on_hand_qty', 'onHandQty'),
    dec('reserved_qty', 'reservedQty'),
    dec('available_qty', 'availableQty'),
    bool('has_variants', 'hasVariants'),
    bool('has_batches', 'hasBatches'),
    dec('default_selling_price', 'defaultSellingPrice', true),
    dec('discount', 'discount', true),
    text('tax_category_name', 'taxCategoryName', true),
    dec('tax_category_rate', 'taxCategoryRate', true),
    uuid('batch_id', 'batchId', true),
    bool('expired', 'expired'),
    // PROPOSED (contract gaps #1, #2).
    ts('updated_at', 'updatedAt'),
    bool('deleted', 'deleted'),
    ...REPLICA_COLUMNS,
  ],
  indexes: [['tenant_id', 'branch_id', 'updated_at']],
  uniqueIndexes: [],
};

// ---------------------------------------------------------------------------
// replica: tax_categories  ←  TaxCategory
// ---------------------------------------------------------------------------

export const TAX_CATEGORIES: TableDescriptor = {
  table: 'tax_categories',
  schema: 'TaxCategory',
  mode: 'replica',
  primaryKey: ['id'],
  watermark: 'updated_at',
  scope: ['tenant_id'],
  columns: [
    col('tenant_id', undefined, 'TEXT', false),
    uuid('id', 'id'),
    text('name', 'name'),
    dec('rate', 'rate'),
    text('description', 'description', true),
    enumCol('status', 'status', ['ACTIVE', 'INACTIVE']),
    ts('created_at', 'createdAt'),
    ts('updated_at', 'updatedAt'),
    // PROPOSED (contract gap #2).
    bool('deleted', 'deleted'),
    ...REPLICA_COLUMNS,
  ],
  indexes: [['tenant_id', 'updated_at']],
  uniqueIndexes: [],
};

// ---------------------------------------------------------------------------
// write-through: customers  ←  Customer
//
// Both pulled and written locally.  `createCustomer` runs offline, and pulls
// still apply, but only to rows with no PENDING outbox entry.
// ---------------------------------------------------------------------------

export const CUSTOMERS: TableDescriptor = {
  table: 'customers',
  schema: 'Customer',
  mode: 'write-through',
  primaryKey: ['id'],
  watermark: 'updated_at',
  scope: ['tenant_id'],
  columns: [
    col('tenant_id', undefined, 'TEXT', false),
    uuid('id', 'id'),
    text('name', 'name'),
    text('tin', 'tin', true),
    text('primary_phone', 'primaryPhone', true),
    text('secondary_phone', 'secondaryPhone', true),
    text('email', 'email', true),
    text('address', 'address', true),
    enumCol('status', 'status', CUSTOMER_STATUS),
    ts('created_at', 'createdAt'),
    ts('updated_at', 'updatedAt'),
    bool('deleted', 'deleted'),
    ...WRITE_THROUGH_COLUMNS,
  ],
  indexes: [
    ['tenant_id', 'name'],
    ['tenant_id', 'primary_phone'],
    ['tenant_id', 'sync_state'],
  ],
  uniqueIndexes: [],
};

// ---------------------------------------------------------------------------
// write-through: sales (+ sale_lines, sale_payments)  ←  Sale
//
// The money table.  Locally authoritative until pushed.  Column names match
// the backend's `sales` table (verified against Sale.java) so the push payload
// needs no renaming.
// ---------------------------------------------------------------------------

export const SALES: TableDescriptor = {
  table: 'sales',
  schema: 'Sale',
  mode: 'write-through',
  primaryKey: ['id'],
  watermark: 'created_at',
  scope: ['tenant_id', 'branch_id'],
  columns: [
    ...SCOPE_COLUMNS,
    uuid('id', 'id'),
    text('sale_number', 'saleNumber'),
    enumCol('status', 'status', SALE_STATUS),
    uuid('customer_id', 'customerId', true),
    text('client_name', 'clientName', true),
    text('client_tin', 'clientTin', true),
    text('client_phone', 'clientPhone', true),
    text('credit_due_date', 'creditDueDate', true),
    text('device_id', 'deviceId', true),
    text('currency_code', 'currencyCode', true),
    dec('subtotal', 'subtotal'),
    dec('discount_total', 'discountTotal'),
    dec('tax_total', 'taxTotal'),
    dec('grand_total', 'grandTotal'),
    dec('amount_paid', 'amountPaid'),
    dec('change_given', 'changeGiven'),
    dec('balance_due', 'balanceDue'),
    dec('total_items', 'totalItems'),
    ts('confirmed_at', 'confirmedAt', true),
    ts('created_at', 'createdAt'),
    col('idempotency_key', undefined, 'TEXT', false, {
      comment: 'Generated locally. Sent as Idempotency-Key so replay is safe.',
    }),
    ...WRITE_THROUGH_COLUMNS,
  ],
  indexes: [
    ['tenant_id', 'branch_id', 'created_at'],
    ['tenant_id', 'sync_state', 'local_seq'],
    ['tenant_id', 'branch_id', 'status'],
  ],
  uniqueIndexes: [['idempotency_key'], ['tenant_id', 'sale_number']],
};

export const SALE_LINES: TableDescriptor = {
  table: 'sale_lines',
  schema: 'SaleLine',
  mode: 'write-through',
  primaryKey: ['id'],
  scope: [],
  parent: { table: 'sales', fk: 'sale_id' },
  columns: [
    uuid('id', 'id'),
    col('sale_id', undefined, 'UUID', false),
    col('line_no', undefined, 'INTEGER', false),
    uuid('item_id', 'itemId'),
    text('item_name', 'itemName'),
    uuid('batch_id', 'batchId', true),
    dec('quantity', 'quantity'),
    dec('unit_price', 'unitPrice'),
    dec('discount_percentage', 'discountPercentage', true),
    dec('discount_amount', 'discountAmount'),
    dec('tax_amount', 'taxAmount'),
    dec('line_subtotal', 'lineSubtotal'),
    dec('line_total', 'lineTotal'),
    text('uom', 'uom', true),
  ],
  indexes: [['sale_id', 'line_no']],
  uniqueIndexes: [],
};

export const SALE_PAYMENTS: TableDescriptor = {
  table: 'sale_payments',
  schema: 'SalePayment',
  mode: 'write-through',
  primaryKey: ['id'],
  scope: [],
  parent: { table: 'sales', fk: 'sale_id' },
  columns: [
    uuid('id', 'id'),
    col('sale_id', undefined, 'UUID', false),
    enumCol('method', 'method', PAYMENT_METHOD),
    dec('amount', 'amount'),
  ],
  indexes: [['sale_id']],
  uniqueIndexes: [],
};

// ---------------------------------------------------------------------------
// System tables
//
// Not derived from the contract.  The generator emits these from a fixed
// built-in list so that the engine's bookkeeping is versioned alongside the
// contract-derived tables and shares one migration runner.
// ---------------------------------------------------------------------------

/**
 * Receipt hash chain (ADR-05).  Strictly sequential per device, initialised at
 * registration, never reset.  `prev_hash` + `hash` make tampering detectable.
 */
export const RECEIPTS: TableDescriptor = {
  table: 'receipts',
  schema: null,
  mode: 'system',
  primaryKey: ['id'],
  scope: ['tenant_id'],
  columns: [
    col('tenant_id', undefined, 'TEXT', false),
    uuid('id', 'id'),
    col('sale_id', undefined, 'UUID', false),
    text('receipt_number', 'receiptNumber'),
    int('seq', 'seq'),
    col('prev_hash', undefined, 'TEXT', false),
    col('hash', undefined, 'TEXT', false),
    ts('issued_at', 'issuedAt'),
  ],
  indexes: [['tenant_id', 'seq']],
  uniqueIndexes: [['tenant_id', 'receipt_number'], ['sale_id']],
};

/**
 * The outbox.  Rows are IMMUTABLE and SELF-DESCRIBING: `payload` is frozen at
 * write time and `contract_version` records the version it was written under.
 * The server upcasts on receipt.  This is what makes a long offline window
 * followed by an app upgrade safe, because migrations never rewrite payloads.
 */
export const OUTBOX: TableDescriptor = {
  table: 'outbox',
  schema: null,
  mode: 'system',
  primaryKey: ['id'],
  scope: ['tenant_id'],
  columns: [
    col('tenant_id', undefined, 'TEXT', false),
    uuid('id', 'id'),
    int('seq', 'seq'),
    text('aggregate_type', 'aggregateType'),
    col('aggregate_id', undefined, 'UUID', false),
    text('operation_id', 'operationId'),
    col('contract_version', undefined, 'TEXT', false, {
      comment: 'Version at write time. Selects the server-side upcaster chain.',
    }),
    col('payload', undefined, 'JSON', false, {
      comment: 'Frozen request body. Never re-serialised by a later app version.',
    }),
    text('idempotency_key', 'idempotencyKey'),
    enumCol('state', 'state', OUTBOX_STATE, false),
    int('attempts', 'attempts'),
    text('batch_id', 'batchId', true),
    ts('leased_until', 'leasedUntil', true),
    text('last_error', 'lastError', true),
    ts('created_at', 'createdAt'),
  ],
  indexes: [
    ['state', 'seq'],
    ['aggregate_type', 'aggregate_id'],
  ],
  uniqueIndexes: [['idempotency_key']],
};

/** Per-entity pull cursors. One row per replica/write-through table. */
export const SYNC_CURSOR: TableDescriptor = {
  table: 'sync_cursor',
  schema: null,
  mode: 'system',
  primaryKey: ['entity'],
  scope: [],
  columns: [
    text('entity', 'entity'),
    text('cursor', 'cursor', true),
    ts('last_pulled_at', 'lastPulledAt', true),
    int('rows_pulled', 'rowsPulled'),
    bool('hydrated', 'hydrated'),
  ],
  indexes: [],
  uniqueIndexes: [],
};

/** Device identity and receipt-sequence state. Exactly one row. */
export const DEVICE_SESSION: TableDescriptor = {
  table: 'device_session',
  schema: null,
  mode: 'system',
  primaryKey: ['device_id'],
  scope: [],
  columns: [
    text('device_id', 'deviceId'),
    text('tenant_id', 'tenantId'),
    col('branch_id', undefined, 'UUID', false),
    text('tenant_slug', 'tenantSlug', true),
    text('receipt_prefix', 'receiptPrefix'),
    int('receipt_seq', 'receiptSeq'),
    text('last_receipt_hash', 'lastReceiptHash', true),
    text('contract_version', 'contractVersion', true),
    ts('activated_at', 'activatedAt'),
  ],
  indexes: [],
  uniqueIndexes: [],
};

/**
 * Diagnostic log, modelled on the Fionet `ActivityLog` table that log4net's
 * `AdoNetAppender` writes to.
 *
 * Deliberately NOT scoped to a tenant. The entries worth having are the ones
 * written before a tenant is known: startup, migration, unlock failure. A
 * `tenant_id` column exists for filtering when one happens to be in context,
 * but it is nullable and never part of a WHERE clause the reader forces.
 *
 * `seq` is a device-global monotonic counter assigned by the main process,
 * which owns every write including the ones shipped over from the renderer.
 * Ordering by `logged_at` alone is not enough: a burst writes many entries in
 * the same millisecond, and a paginated view over a non-unique sort key
 * repeats and skips rows between pages.
 */
export const SYSTEM_LOGS: TableDescriptor = {
  table: 'system_logs',
  schema: null,
  mode: 'system',
  primaryKey: ['id'],
  scope: [],
  columns: [
    uuid('id', 'id'),
    int('seq', 'seq'),
    ts('logged_at', 'loggedAt'),
    enumCol('level', 'level', LOG_LEVEL, false),
    enumCol('component', 'component', LOG_COMPONENT, false),
    enumCol('source', 'source', LOG_SOURCE, false),
    col('logger', 'logger', 'TEXT', false, {
      comment: 'Module that emitted the entry, e.g. "gateway" or "pos.component".',
    }),
    text('message', 'message'),
    col('exception', 'exception', 'TEXT', true, {
      comment: 'Error name, message, and stack. NULL when nothing was thrown.',
    }),
    text('user_name', 'userName', true),
    col('url', 'url', 'TEXT', true, {
      comment: 'Operation path or renderer route the entry was produced under.',
    }),
    col('request_id', 'requestId', 'TEXT', true, {
      comment: 'Bridge correlation id. Joins a renderer entry to its engine entries.',
    }),
    col('code', 'code', 'TEXT', true, {
      comment: 'Error code or HTTP status, e.g. "E_SCHEMA" or "201".',
    }),
    text('device_id', 'deviceId', true),
    col('thread', 'thread', 'TEXT', true, {
      comment: 'Logical execution context: "main", "renderer", "sync-worker".',
    }),
    text('tenant_id', 'tenantId', true),
    col('context', 'context', 'JSON', true, {
      comment: 'Extra structured fields, serialised. Never holds secrets.',
    }),
  ],
  indexes: [
    ['logged_at', 'seq'],
    ['level'],
    ['component'],
    ['source'],
    ['request_id'],
  ],
  uniqueIndexes: [],
};

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

/**
 * All tables, in dependency order.  DDL is emitted in this order so foreign
 * keys always reference an existing table, and the order is stable so the
 * manifest hash is deterministic.
 */
export const TABLES: readonly TableDescriptor[] = [
  // system first: no dependencies, and the engine needs them to start
  DEVICE_SESSION,
  SYNC_CURSOR,
  OUTBOX,
  SYSTEM_LOGS,
  // replicas
  SALES_CATALOG,
  STOCK_BALANCES,
  TAX_CATEGORIES,
  // write-through
  CUSTOMERS,
  SALES,
  SALE_LINES,
  SALE_PAYMENTS,
  // depends on sales
  RECEIPTS,
];

export const TABLES_BY_NAME: ReadonlyMap<string, TableDescriptor> = new Map(
  TABLES.map((t) => [t.table, t]),
);

/** Tables the pull worker syncs, in hydration-tier order. */
export const PULLABLE_TABLES: readonly TableDescriptor[] = TABLES.filter(
  (t) => t.mode === 'replica' || t.mode === 'write-through',
);

export function tableFor(name: string): TableDescriptor {
  const t = TABLES_BY_NAME.get(name);
  if (!t) throw new Error(`Unknown local-store table: ${name}`);
  return t;
}
