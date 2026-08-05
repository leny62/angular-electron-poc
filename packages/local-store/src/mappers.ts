/**
 * Row ↔ DTO mappers.
 *
 * GENERATOR TARGET.  One pair per contract schema.  The DTO side is shaped to
 * match `@bizuri/api-client` exactly, because the renderer receives these
 * through the generated client's types and must not be able to tell whether a
 * response came from the network or from SQLite.
 *
 * ─── On money crossing the boundary as a JSON number ─────────────────────────
 * Storage is TEXT and arithmetic is decimal (see ddl.ts), but these mappers emit
 * JSON `number` for money.  That is not a contradiction: the contract declares
 * money as `type: number, format: double`, and the real server does exactly the
 * same thing when Jackson serialises a `BigDecimal` into a JSON response.  Being
 * faithful to the wire format is the whole point.
 *
 * The invariant is: decimals are strings everywhere a value is *computed or
 * stored*, and numbers only at the moment of serialisation. A mapper is the
 * serialisation boundary, so this is the one place the conversion is correct.
 */

import type { LogComponent, LogLevel, LogSource } from './log-vocabulary';
import type {
  CustomerRow,
  ReceiptRow,
  SaleLineRow,
  SalePaymentRow,
  SaleRow,
  SalesCatalogRow,
  StockBalanceRow,
  SystemLogRow,
  TaxCategoryRow,
} from './rows';

// ---------------------------------------------------------------------------
// Scalar helpers
// ---------------------------------------------------------------------------

/** TEXT decimal → JSON number. Null-preserving. */
const num = (v: string | null): number | null => (v === null ? null : Number(v));

/** TEXT decimal → JSON number, for NOT NULL columns. */
const numReq = (v: string): number => Number(v);

/** SQLite 0/1 → boolean. */
const flag = (v: 0 | 1): boolean => v === 1;

// ---------------------------------------------------------------------------
// SalesCatalogItem
// ---------------------------------------------------------------------------

export interface SalesCatalogItemDto {
  itemId: string;
  itemCode: string;
  itemName: string;
  barcode: string | null;
  businessType: string;
  isVariant: boolean;
  parentItemId: string | null;
  sellMode: string;
  stockStatus: string | null;
  availableQty: number | null;
  sellingPrice: number | null;
  discount: number | null;
  taxCategoryName: string | null;
  taxCategoryRate: number | null;
  unitOfMeasureName: string | null;
  currentBatchId: string | null;
  updatedAt: string;
}

export function rowToSalesCatalogItem(r: SalesCatalogRow): SalesCatalogItemDto {
  return {
    itemId: r.item_id,
    itemCode: r.item_code,
    itemName: r.item_name,
    barcode: r.barcode,
    businessType: r.business_type,
    isVariant: flag(r.is_variant),
    parentItemId: r.parent_item_id,
    sellMode: r.sell_mode,
    stockStatus: r.stock_status,
    availableQty: num(r.available_qty),
    sellingPrice: num(r.selling_price),
    discount: num(r.discount),
    taxCategoryName: r.tax_category_name,
    taxCategoryRate: num(r.tax_category_rate),
    unitOfMeasureName: r.unit_of_measure_name,
    currentBatchId: r.current_batch_id,
    updatedAt: r.updated_at,
  };
}

/**
 * Pull direction: server DTO → row.
 *
 * `scope` is supplied by the caller rather than read from the DTO, because
 * `SalesCatalogItem` has no tenant or branch field — those come from the
 * request headers.  That is exactly what `x-offline.scope` encodes.
 */
export function salesCatalogItemToRow(
  dto: Partial<SalesCatalogItemDto> & { itemId: string },
  scope: { tenantId: string; branchId: string },
  pulledAt: string,
  deleted = false,
): SalesCatalogRow {
  return {
    tenant_id: scope.tenantId,
    branch_id: scope.branchId,
    item_id: dto.itemId,
    item_code: dto.itemCode ?? '',
    item_name: dto.itemName ?? '',
    barcode: dto.barcode ?? null,
    business_type: (dto.businessType as SalesCatalogRow['business_type']) ?? 'FINISHED_PRODUCT',
    is_variant: dto.isVariant ? 1 : 0,
    parent_item_id: dto.parentItemId ?? null,
    sell_mode: (dto.sellMode as SalesCatalogRow['sell_mode']) ?? 'IN_STOCK',
    stock_status: (dto.stockStatus as SalesCatalogRow['stock_status']) ?? null,
    available_qty: dto.availableQty == null ? null : String(dto.availableQty),
    selling_price: dto.sellingPrice == null ? null : String(dto.sellingPrice),
    discount: dto.discount == null ? null : String(dto.discount),
    tax_category_name: dto.taxCategoryName ?? null,
    tax_category_rate: dto.taxCategoryRate == null ? null : String(dto.taxCategoryRate),
    unit_of_measure_name: dto.unitOfMeasureName ?? null,
    current_batch_id: dto.currentBatchId ?? null,
    updated_at: dto.updatedAt ?? pulledAt,
    deleted: deleted ? 1 : 0,
    _pulled_at: pulledAt,
  };
}

// ---------------------------------------------------------------------------
// StockBalanceResponse
// ---------------------------------------------------------------------------

export interface StockBalanceDto {
  itemId: string;
  itemCode: string;
  itemName: string;
  businessType: string;
  branchId: string;
  branchName: string | null;
  onHandQty: number;
  reservedQty: number;
  availableQty: number;
  hasVariants: boolean;
  hasBatches: boolean;
  defaultSellingPrice: number | null;
  discount: number | null;
  taxCategoryName: string | null;
  taxCategoryRate: number | null;
  batchId: string | null;
  expired: boolean;
  updatedAt: string;
}

export function rowToStockBalance(r: StockBalanceRow): StockBalanceDto {
  return {
    itemId: r.item_id,
    itemCode: r.item_code,
    itemName: r.item_name,
    businessType: r.business_type,
    branchId: r.branch_id,
    branchName: r.branch_name,
    onHandQty: numReq(r.on_hand_qty),
    reservedQty: numReq(r.reserved_qty),
    availableQty: numReq(r.available_qty),
    hasVariants: flag(r.has_variants),
    hasBatches: flag(r.has_batches),
    defaultSellingPrice: num(r.default_selling_price),
    discount: num(r.discount),
    taxCategoryName: r.tax_category_name,
    taxCategoryRate: num(r.tax_category_rate),
    batchId: r.batch_id,
    expired: flag(r.expired),
    updatedAt: r.updated_at,
  };
}

export function stockBalanceToRow(
  dto: Partial<StockBalanceDto> & { itemId: string },
  scope: { tenantId: string; branchId: string },
  pulledAt: string,
  deleted = false,
): StockBalanceRow {
  return {
    tenant_id: scope.tenantId,
    branch_id: dto.branchId ?? scope.branchId,
    item_id: dto.itemId,
    item_code: dto.itemCode ?? '',
    item_name: dto.itemName ?? '',
    business_type: (dto.businessType as StockBalanceRow['business_type']) ?? 'FINISHED_PRODUCT',
    branch_name: dto.branchName ?? null,
    on_hand_qty: String(dto.onHandQty ?? 0),
    reserved_qty: String(dto.reservedQty ?? 0),
    available_qty: String(dto.availableQty ?? 0),
    has_variants: dto.hasVariants ? 1 : 0,
    has_batches: dto.hasBatches ? 1 : 0,
    default_selling_price:
      dto.defaultSellingPrice == null ? null : String(dto.defaultSellingPrice),
    discount: dto.discount == null ? null : String(dto.discount),
    tax_category_name: dto.taxCategoryName ?? null,
    tax_category_rate: dto.taxCategoryRate == null ? null : String(dto.taxCategoryRate),
    batch_id: dto.batchId ?? null,
    expired: dto.expired ? 1 : 0,
    updated_at: dto.updatedAt ?? pulledAt,
    deleted: deleted ? 1 : 0,
    _pulled_at: pulledAt,
  };
}

// ---------------------------------------------------------------------------
// TaxCategory
// ---------------------------------------------------------------------------

export interface TaxCategoryDto {
  id: string;
  name: string;
  rate: number;
  description: string | null;
  status: string;
  createdAt: string;
  updatedAt: string;
}

export function rowToTaxCategory(r: TaxCategoryRow): TaxCategoryDto {
  return {
    id: r.id,
    name: r.name,
    rate: numReq(r.rate),
    description: r.description,
    status: r.status,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

export function taxCategoryToRow(
  dto: Partial<TaxCategoryDto> & { id: string },
  scope: { tenantId: string },
  pulledAt: string,
  deleted = false,
): TaxCategoryRow {
  return {
    tenant_id: scope.tenantId,
    id: dto.id,
    name: dto.name ?? '',
    rate: String(dto.rate ?? 0),
    description: dto.description ?? null,
    status: (dto.status as TaxCategoryRow['status']) ?? 'ACTIVE',
    created_at: dto.createdAt ?? pulledAt,
    updated_at: dto.updatedAt ?? pulledAt,
    deleted: deleted ? 1 : 0,
    _pulled_at: pulledAt,
  };
}

// ---------------------------------------------------------------------------
// Customer
// ---------------------------------------------------------------------------

export interface CustomerDto {
  id: string;
  name: string;
  tin: string | null;
  primaryPhone: string | null;
  secondaryPhone: string | null;
  email: string | null;
  address: string | null;
  status: string;
  createdAt: string;
  updatedAt: string;
}

export function rowToCustomer(r: CustomerRow): CustomerDto {
  return {
    // The server's id wins once known, so a receipt reprinted after sync shows
    // the same customer id the back office sees.
    id: r.server_id ?? r.id,
    name: r.name,
    tin: r.tin,
    primaryPhone: r.primary_phone,
    secondaryPhone: r.secondary_phone,
    email: r.email,
    address: r.address,
    status: r.status,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

// ---------------------------------------------------------------------------
// Sale
// ---------------------------------------------------------------------------

export interface SalePaymentDto {
  method: string;
  amount: number;
}

export interface SaleLineDto {
  id: string;
  itemId: string;
  itemName: string;
  batchId: string | null;
  quantity: number;
  unitPrice: number;
  discountPercentage: number | null;
  discountAmount: number;
  taxAmount: number;
  lineSubtotal: number;
  lineTotal: number;
  uom: string | null;
}

export interface SaleDto {
  id: string;
  saleNumber: string;
  branchId: string;
  status: string;
  customerId: string | null;
  client?: { fullName?: string; tin?: string; phone?: string };
  payments: SalePaymentDto[];
  deviceId: string | null;
  creditDueDate: string | null;
  subtotal: number;
  discountTotal: number;
  taxTotal: number;
  grandTotal: number;
  amountPaid: number;
  changeGiven: number;
  balanceDue: number;
  totalItems: number;
  confirmedAt: string | null;
  createdAt: string;
  currencyCode: string | null;
  lines: SaleLineDto[];
}

export function rowToSaleLine(r: SaleLineRow): SaleLineDto {
  return {
    id: r.id,
    itemId: r.item_id,
    itemName: r.item_name,
    batchId: r.batch_id,
    quantity: numReq(r.quantity),
    unitPrice: numReq(r.unit_price),
    discountPercentage: num(r.discount_percentage),
    discountAmount: numReq(r.discount_amount),
    taxAmount: numReq(r.tax_amount),
    lineSubtotal: numReq(r.line_subtotal),
    lineTotal: numReq(r.line_total),
    uom: r.uom,
  };
}

export function rowToSalePayment(r: SalePaymentRow): SalePaymentDto {
  return { method: r.method, amount: numReq(r.amount) };
}

export function rowToSale(
  r: SaleRow,
  lines: readonly SaleLineRow[],
  payments: readonly SalePaymentRow[],
): SaleDto {
  const client =
    r.client_name || r.client_tin || r.client_phone
      ? {
          ...(r.client_name ? { fullName: r.client_name } : {}),
          ...(r.client_tin ? { tin: r.client_tin } : {}),
          ...(r.client_phone ? { phone: r.client_phone } : {}),
        }
      : undefined;

  return {
    id: r.server_id ?? r.id,
    saleNumber: r.sale_number,
    branchId: r.branch_id,
    status: r.status,
    customerId: r.customer_id,
    ...(client ? { client } : {}),
    payments: payments.map(rowToSalePayment),
    deviceId: r.device_id,
    creditDueDate: r.credit_due_date,
    subtotal: numReq(r.subtotal),
    discountTotal: numReq(r.discount_total),
    taxTotal: numReq(r.tax_total),
    grandTotal: numReq(r.grand_total),
    amountPaid: numReq(r.amount_paid),
    changeGiven: numReq(r.change_given),
    balanceDue: numReq(r.balance_due),
    totalItems: numReq(r.total_items),
    confirmedAt: r.confirmed_at,
    createdAt: r.created_at,
    currencyCode: r.currency_code,
    lines: [...lines]
      .sort((a, b) => a.line_no - b.line_no)
      .map(rowToSaleLine),
  };
}

// ---------------------------------------------------------------------------
// Receipt
// ---------------------------------------------------------------------------

export interface ReceiptSummaryDto {
  receiptNumber: string;
  saleId: string;
  seq: number;
  issuedAt: string;
  /** Local-only. Lets the UI show a tamper warning without a server round trip. */
  hash: string;
}

export function rowToReceiptSummary(r: ReceiptRow): ReceiptSummaryDto {
  return {
    receiptNumber: r.receipt_number,
    saleId: r.sale_id,
    seq: r.seq,
    issuedAt: r.issued_at,
    hash: r.hash,
  };
}

// ---------------------------------------------------------------------------
// System log
// ---------------------------------------------------------------------------

export interface SystemLogDto {
  id: string;
  seq: number;
  loggedAt: string;
  level: LogLevel;
  component: LogComponent;
  source: LogSource;
  logger: string;
  message: string;
  exception: string | null;
  userName: string | null;
  url: string | null;
  requestId: string | null;
  code: string | null;
  deviceId: string | null;
  thread: string | null;
  tenantId: string | null;
  /**
   * Parsed back into an object here rather than left as a string: the log
   * viewer is the only consumer, and making every caller re-parse invites one
   * of them to forget the try/catch and blank the whole table on one bad row.
   */
  context: Record<string, unknown> | null;
}

export function rowToSystemLog(r: SystemLogRow): SystemLogDto {
  return {
    id: r.id,
    seq: r.seq,
    loggedAt: r.logged_at,
    level: r.level,
    component: r.component,
    source: r.source,
    logger: r.logger,
    message: r.message,
    exception: r.exception,
    userName: r.user_name,
    url: r.url,
    requestId: r.request_id,
    code: r.code,
    deviceId: r.device_id,
    thread: r.thread,
    tenantId: r.tenant_id,
    context: parseContext(r.context),
  };
}

function parseContext(raw: string | null): Record<string, unknown> | null {
  if (!raw) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    return typeof parsed === 'object' && parsed !== null
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}
