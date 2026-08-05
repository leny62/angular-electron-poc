/**
 * @bizuri/local-engine
 *
 * The offline engine. Runs entirely in the Electron main process and has no
 * Angular coupling of any kind, which is what makes it portable into
 * `BIZURI-Frontend` as a dependency rather than as a merge.
 *
 * Its only dependencies are `electron`, `better-sqlite3-multiple-ciphers`, node
 * builtins, and the generated `@bizuri/local-store`. Nothing here knows the
 * renderer's framework or version.
 *
 * Integration is `createLocalEngine(win)` plus a contextBridge exposure. See
 * docs/offline-architecture-plan.md §11.3.
 */

// Contract
export {
  ENVELOPE_VERSION,
  ERROR_CODES,
  ERROR_STATUS,
  EVENT_CHANNEL,
  EVENT_TOPICS,
  EngineError,
  REQUEST_CHANNEL,
  insufficientStock,
  notFound,
} from './contracts';
export type {
  BizuriLocalBridge,
  BridgeEvent,
  EngineState,
  ErrorCode,
  EventTopic,
  HttpMethod,
  LocalErr,
  LocalOk,
  LocalRequest,
  LocalResponse,
  OperationContext,
  OperationDefinition,
  OperationHandler,
  OperationResult,
  ValidationFailure,
} from './contracts';

// Engine state
export { EngineStateMachine } from './domain/engine-state';
export type { StateChange } from './domain/engine-state';

// Gateway
export {
  buildRegistry,
  emitEvent,
  isRegistryBuilt,
  registerGateway,
  resetRegistry,
  sanitiseMessage,
} from './gateway/gateway';
export type { GatewayConfig, RegistryEntry } from './gateway/gateway';
export {
  buildErrorResponse,
  resetRateLimiter,
  validateRequest,
} from './gateway/validation-pipeline';
export type { ValidationContext, ValidationOutcome } from './gateway/validation-pipeline';
export { RateLimiter } from './gateway/rate-limiter';
export type { RateLimitConfig, RateLimitResult } from './gateway/rate-limiter';
export { expectedOrigin, verifySender } from './gateway/sender-verification';
export type { SenderRejection } from './gateway/sender-verification';
export {
  isValid,
  resetPatternCache,
  validateSchema,
} from './gateway/json-schema-validator';
export type { SchemaValidationError } from './gateway/json-schema-validator';

// Store
export { ConnectionManager, DatabaseKeyError } from './store/connection';
export type { ConnectionConfig } from './store/connection';
export {
  pruneOutboxBackups,
  runMigrations,
  SchemaDowngradeError,
} from './store/migrations';
export type { MigrationResult } from './store/migrations';
export type { SqliteDatabase, SqliteRunResult, SqliteStatement } from './store/types';

// Security
export {
  deriveKey,
  generateMachineSalt,
  keyToHex,
  verifyPassphrase,
  zeroBuffer,
} from './security/key-derivation';
export type { KeyMaterial } from './security/key-derivation';

// Decimal arithmetic
export * as Decimal from './domain/decimal';

// Operations
export { loadSale, makeCreateSale } from './operations/create-sale';
export type { CreateSaleDeps } from './operations/create-sale';
export {
  computeReceiptHash,
  issueReceipt,
  verifyReceiptChain,
} from './operations/receipt-chain';
export type { ChainVerification, IssuedReceipt } from './operations/receipt-chain';

// Remote: the real API
export {
  backoffMs,
  MfaRequiredError,
  normalisePage,
  OfflineError,
  RemoteClient,
  RemoteError,
  unwrapData,
} from './remote/remote-client';
export type {
  Credentials,
  Page,
  RemoteConfig,
  RequestOptions,
  Session,
} from './remote/remote-client';
export { hydrate, HYDRATION_ENDPOINTS, hydratedTables } from './remote/hydrate';
export type {
  HydrationEndpoint,
  HydrationOptions,
  HydrationScope,
  HydrationStats,
  TableHydrationStats,
} from './remote/hydrate';
export {
  DEFAULT_PUSH_CONFIG,
  pushOutbox,
  summariseOutbox,
} from './remote/push-outbox';
export type {
  OutboxSummary,
  PushConfig,
  PushedRow,
  PushOutcome,
  PushStats,
} from './remote/push-outbox';

// Preload
export { exposeLocalBridge } from './gateway/preload';
export type { ExposeOptions } from './gateway/preload';

// Bootstrap
export { createLocalEngine } from './engine';
export type { LocalEngine, LocalEngineConfig } from './engine';

// Operations
export { makeCancelSale, makeConfirmSale, makeCreateCustomer } from './operations/sale-ops';
export type { WriteDeps } from './operations/sale-ops';
export { makeEngineOps } from './operations/engine-ops';
export type { EngineOpsDeps } from './operations/engine-ops';
export { buildReaders } from './operations/read-configs';
export { makeReplicaGet, makeReplicaList } from './operations/replica-readers';
export type { Envelope, GetConfig, ListConfig } from './operations/replica-readers';

// Sync
export { SyncWorker } from './sync/sync-worker';
export type { SyncResult, SyncState, SyncWorkerConfig } from './sync/sync-worker';
