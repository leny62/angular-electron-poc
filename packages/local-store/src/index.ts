/**
 * @bizuri/local-store
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * HAND-WRITTEN PLACEHOLDER for the output of the `bizuri-sqlite` OpenAPI
 * generator, which will live in `BIZURI-API-Contract/bizuri-codegen`.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * Why hand-written first: writing a Java code generator against a runtime shape
 * nobody has exercised yet is speculative. This package pins the exact target
 * — descriptors, DDL, row types, mappers, routes, request schemas, manifest —
 * by making the local engine actually work against it. Once the generator is
 * built, its output replaces these files and the diff must come out empty.
 *
 * Nothing in this package may require human judgement to produce. Every value
 * is derivable from `bizuri-core-api-contract.yaml` plus an `x-offline` block.
 * If something here cannot be generated mechanically, it is a design bug in
 * this package, not a licence to hand-maintain it.
 *
 * See docs/offline-architecture-plan.md §2 for the `x-offline` schema.
 */

// The schema language the generator emits (types only).
export type { JsonSchema, JsonSchemaType } from './json-schema';

// Diagnostic vocabulary, shared by the DDL, the gate-4 schemas, and the viewer.
export type { LogComponent, LogLevel, LogSource } from './log-vocabulary';
export {
  LOG_COMPONENTS,
  LOG_LEVEL_RANK,
  LOG_LEVELS,
  LOG_SOURCES,
} from './log-vocabulary';

// Descriptor types: the generator's output contract.
export type {
  ColumnDescriptor,
  ColumnType,
  HttpMethod,
  LocalStoreManifest,
  OfflineMode,
  OperationKind,
  ParentRef,
  RouteDescriptor,
  TableDescriptor,
} from './types';

// Table descriptors.
export {
  CUSTOMERS,
  DEVICE_SESSION,
  OUTBOX,
  PULLABLE_TABLES,
  RECEIPTS,
  SALE_LINES,
  SALE_PAYMENTS,
  SALES,
  SALES_CATALOG,
  STOCK_BALANCES,
  SYNC_CURSOR,
  SYSTEM_LOGS,
  TABLES,
  TABLES_BY_NAME,
  TAX_CATEGORIES,
  tableFor,
} from './tables';

// DDL emission and hashing.
export { emitBaselineDdl, emitCreateTable, hashAllTables, hashTable } from './ddl';

// Row types.
export type {
  CustomerRow,
  DeviceSessionRow,
  OutboxRow,
  OutboxState,
  PaymentMethod,
  ReceiptRow,
  SaleLineRow,
  SalePaymentRow,
  SaleRow,
  SaleStatus,
  SalesCatalogRow,
  StockBalanceRow,
  SyncCursorRow,
  SyncState,
  SystemLogRow,
  TaxCategoryRow,
} from './rows';

// Mappers and DTO shapes.
export type {
  CustomerDto,
  ReceiptSummaryDto,
  SaleDto,
  SaleLineDto,
  SalePaymentDto,
  SalesCatalogItemDto,
  StockBalanceDto,
  SystemLogDto,
  TaxCategoryDto,
} from './mappers';
export {
  rowToCustomer,
  rowToReceiptSummary,
  rowToSale,
  rowToSaleLine,
  rowToSalePayment,
  rowToSalesCatalogItem,
  rowToStockBalance,
  rowToSystemLog,
  rowToTaxCategory,
  salesCatalogItemToRow,
  stockBalanceToRow,
  taxCategoryToRow,
} from './mappers';

// Route table.
export type { CompiledRoute } from './routes';
export {
  ALL_ROUTES,
  compileRoute,
  compileRoutes,
  ENGINE_ROUTES,
  OFFLINE_OPERATION_IDS,
  ROUTES,
  ROUTES_BY_OPERATION,
  routeFor,
} from './routes';

// Request schemas for gate 4.
export { REQUEST_SCHEMAS, requestSchemaFor } from './schemas';

// Hydration tiers.
export type { HydrationTier, TierAssignment } from './hydration';
export {
  HYDRATION_PLAN,
  hydrationOrder,
  TIER_1_TABLES,
  TIER_3_HISTORY_DAYS,
  tierFor,
} from './hydration';

// Manifest.
export { CONTRACT_VERSION, LOCAL_SCHEMA_VERSION, manifest } from './manifest';
