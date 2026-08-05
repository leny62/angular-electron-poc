/**
 * Row types.
 *
 * GENERATOR TARGET.  One interface per table, mirroring `tables.ts` exactly.
 *
 * Conventions, all mechanically derivable:
 *   - snake_case property names, because these are SQLite rows, not DTOs
 *   - DECIMAL columns are `string`, never `number` (see ddl.ts on why)
 *   - BOOLEAN columns are `0 | 1`, because SQLite has no boolean
 *   - nullable columns are `| null`, not `| undefined`: a SQLite read returns
 *     null, never undefined, and conflating the two hides bugs
 *
 * These types weigh nothing at runtime — TypeScript erases them entirely — so
 * they are the cheapest part of the generated artifact.
 */

// ---------------------------------------------------------------------------
// replica rows
// ---------------------------------------------------------------------------

export interface SalesCatalogRow {
  tenant_id: string;
  branch_id: string;
  item_id: string;
  item_code: string;
  item_name: string;
  barcode: string | null;
  business_type: 'FINISHED_PRODUCT' | 'RAW_MATERIAL';
  is_variant: 0 | 1;
  parent_item_id: string | null;
  sell_mode: 'IN_STOCK' | 'MADE_TO_ORDER';
  stock_status: 'IN_STOCK' | 'LOW_STOCK' | 'OUT_OF_STOCK' | null;
  available_qty: string | null;
  selling_price: string | null;
  discount: string | null;
  tax_category_name: string | null;
  tax_category_rate: string | null;
  unit_of_measure_name: string | null;
  current_batch_id: string | null;
  updated_at: string;
  deleted: 0 | 1;
  _pulled_at: string;
}

export interface StockBalanceRow {
  tenant_id: string;
  branch_id: string;
  item_id: string;
  item_code: string;
  item_name: string;
  business_type: 'FINISHED_PRODUCT' | 'RAW_MATERIAL';
  branch_name: string | null;
  on_hand_qty: string;
  reserved_qty: string;
  available_qty: string;
  has_variants: 0 | 1;
  has_batches: 0 | 1;
  default_selling_price: string | null;
  discount: string | null;
  tax_category_name: string | null;
  tax_category_rate: string | null;
  batch_id: string | null;
  expired: 0 | 1;
  updated_at: string;
  deleted: 0 | 1;
  _pulled_at: string;
}

export interface TaxCategoryRow {
  tenant_id: string;
  id: string;
  name: string;
  rate: string;
  description: string | null;
  status: 'ACTIVE' | 'INACTIVE';
  created_at: string;
  updated_at: string;
  deleted: 0 | 1;
  _pulled_at: string;
}

// ---------------------------------------------------------------------------
// write-through rows
// ---------------------------------------------------------------------------

export type SyncState = 'PENDING' | 'SYNCED' | 'CONFLICT' | 'FAILED';

export interface CustomerRow {
  tenant_id: string;
  id: string;
  name: string;
  tin: string | null;
  primary_phone: string | null;
  secondary_phone: string | null;
  email: string | null;
  address: string | null;
  status: 'ACTIVE' | 'INACTIVE';
  created_at: string;
  updated_at: string;
  deleted: 0 | 1;
  server_id: string | null;
  sync_state: SyncState;
  local_seq: number;
}

export type SaleStatus =
  | 'DRAFT'
  | 'CONFIRMED'
  | 'CREDITED'
  | 'CANCELLED'
  | 'EXPIRED'
  | 'REFUNDED';

export interface SaleRow {
  tenant_id: string;
  branch_id: string;
  id: string;
  sale_number: string;
  status: SaleStatus;
  customer_id: string | null;
  client_name: string | null;
  client_tin: string | null;
  client_phone: string | null;
  credit_due_date: string | null;
  device_id: string | null;
  currency_code: string | null;
  subtotal: string;
  discount_total: string;
  tax_total: string;
  grand_total: string;
  amount_paid: string;
  change_given: string;
  balance_due: string;
  total_items: string;
  confirmed_at: string | null;
  created_at: string;
  idempotency_key: string;
  server_id: string | null;
  sync_state: SyncState;
  local_seq: number;
}

export interface SaleLineRow {
  id: string;
  sale_id: string;
  line_no: number;
  item_id: string;
  item_name: string;
  batch_id: string | null;
  quantity: string;
  unit_price: string;
  discount_percentage: string | null;
  discount_amount: string;
  tax_amount: string;
  line_subtotal: string;
  line_total: string;
  uom: string | null;
}

export type PaymentMethod = 'CASH' | 'BANK' | 'MOBILE_MONEY' | 'CREDIT';

export interface SalePaymentRow {
  id: string;
  sale_id: string;
  method: PaymentMethod;
  amount: string;
}

// ---------------------------------------------------------------------------
// system rows
// ---------------------------------------------------------------------------

export interface ReceiptRow {
  tenant_id: string;
  id: string;
  sale_id: string;
  receipt_number: string;
  seq: number;
  prev_hash: string;
  hash: string;
  issued_at: string;
}

export type OutboxState = 'PENDING' | 'INFLIGHT' | 'SYNCED' | 'CONFLICT' | 'FAILED';

export interface OutboxRow {
  tenant_id: string;
  id: string;
  seq: number;
  aggregate_type: string;
  aggregate_id: string;
  operation_id: string;
  contract_version: string;
  payload: string;
  idempotency_key: string;
  state: OutboxState;
  attempts: number;
  batch_id: string | null;
  leased_until: string | null;
  last_error: string | null;
  created_at: string;
}

export interface SyncCursorRow {
  entity: string;
  cursor: string | null;
  last_pulled_at: string | null;
  rows_pulled: number;
  hydrated: 0 | 1;
}

export interface DeviceSessionRow {
  device_id: string;
  tenant_id: string;
  branch_id: string;
  tenant_slug: string | null;
  receipt_prefix: string;
  receipt_seq: number;
  last_receipt_hash: string | null;
  contract_version: string | null;
  activated_at: string;
}
