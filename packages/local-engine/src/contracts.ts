/**
 * Local engine IPC contract.
 *
 * Replaces the POC's 14 bespoke `bizuri.*` command names with the contract's own
 * `operationId` vocabulary. The reason is not tidiness: a bespoke vocabulary is
 * a second API surface that has to be kept in step with the real one by hand,
 * and it drifts. Using `operationId` means the allow-list, the request schemas,
 * and the route table all come from the same generated artifact.
 *
 * One request channel and one event channel, as before. Adding a channel per
 * feature would multiply the number of places sender verification has to be
 * done correctly.
 */

import type { JsonSchema } from '@bizuri/local-store';

// ---------------------------------------------------------------------------
// Channels
// ---------------------------------------------------------------------------

export const REQUEST_CHANNEL = 'bizuri.local.request' as const;
export const EVENT_CHANNEL = 'bizuri.local.event' as const;

/**
 * Envelope version. Bumped only for a breaking change to the envelope itself,
 * not for contract changes — those travel in `contractVersion`.
 *
 * Gate 3 rejects a mismatch outright. That is what makes an app update safe: a
 * renderer served from a stale cache cannot talk to a newer main process.
 */
export const ENVELOPE_VERSION = 1 as const;

// ---------------------------------------------------------------------------
// Request
// ---------------------------------------------------------------------------

export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

/**
 * A request as it crosses the bridge.
 *
 * Shaped like an HTTP request on purpose: `OfflineHttpBackend` builds it
 * directly from an Angular `HttpRequest`, and the engine's readers consume the
 * same fields a Spring controller would. That symmetry is what lets a local
 * operation and a server operation share a request schema.
 */
export interface LocalRequest {
  readonly v: typeof ENVELOPE_VERSION;
  /** Correlation id, echoed on the response. */
  readonly id: string;
  /** Contract operationId. Gate 2 checks this against the route table. */
  readonly operationId: string;
  readonly method: HttpMethod;
  /** Values captured from the path template, already URL-decoded. */
  readonly pathParams: Readonly<Record<string, string>>;
  /** Query string, flattened. Repeated keys arrive as arrays. */
  readonly query: Readonly<Record<string, string | string[]>>;
  /**
   * Only the headers the engine needs. The renderer's Authorization header is
   * deliberately NOT forwarded: the local engine authenticates by unlock, and
   * carrying a bearer token across the bridge would put it in main-process
   * memory for no benefit.
   */
  readonly headers: Readonly<Record<string, string>>;
  readonly body?: unknown;
  readonly issuedAt: string;
}

// ---------------------------------------------------------------------------
// Response
// ---------------------------------------------------------------------------

/**
 * Success. `status` lets the renderer's HttpBackend synthesise a faithful
 * HttpResponse, so an interceptor written against the real API keeps working.
 */
export interface LocalOk<T = unknown> {
  readonly v: typeof ENVELOPE_VERSION;
  readonly id: string;
  readonly ok: true;
  readonly status: number;
  readonly data: T;
  /**
   * When the write became durable on disk. Absent for reads. Present so the UI
   * can tell "saved locally" from "saved to the server", which is a distinction
   * cashiers need to trust the app.
   */
  readonly durableAt?: string;
}

export const ERROR_CODES = [
  'E_SENDER',
  'E_UNKNOWN_OPERATION',
  'E_ENVELOPE',
  'E_SCHEMA',
  'E_LOCKED',
  'E_HYDRATING',
  'E_FORBIDDEN',
  'E_RATE_LIMIT',
  'E_NOT_FOUND',
  'E_STOCK',
  'E_CONFLICT',
  'E_STORAGE',
  'E_INTEGRITY',
  'E_CONTRACT_INCOMPATIBLE',
  'E_INTERNAL',
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];

/**
 * Failure.
 *
 * `errorCode` mirrors the server's `ErrorResponse.errorCode` convention
 * (UPPER_SNAKE_CASE) so the renderer's existing error interceptor can handle a
 * local failure and a server failure with the same code path.
 */
export interface LocalErr {
  readonly v: typeof ENVELOPE_VERSION;
  readonly id: string;
  readonly ok: false;
  readonly status: number;
  readonly code: ErrorCode;
  readonly message: string;
  readonly retryable: boolean;
  readonly details?: Record<string, unknown>;
}

export type LocalResponse<T = unknown> = LocalOk<T> | LocalErr;

/** HTTP status for each error code, so the renderer sees a plausible response. */
export const ERROR_STATUS: Readonly<Record<ErrorCode, number>> = {
  E_SENDER: 403,
  E_UNKNOWN_OPERATION: 404,
  E_ENVELOPE: 400,
  E_SCHEMA: 400,
  E_LOCKED: 423, // Locked
  E_HYDRATING: 503, // Service Unavailable: retry once hydration completes
  E_FORBIDDEN: 403,
  E_RATE_LIMIT: 429,
  E_NOT_FOUND: 404,
  E_STOCK: 400,
  E_CONFLICT: 409,
  E_STORAGE: 500,
  E_INTEGRITY: 500,
  E_CONTRACT_INCOMPATIBLE: 409,
  E_INTERNAL: 500,
};

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

export const EVENT_TOPICS = [
  'engine.state',
  'hydration.progress',
  'sync.state',
  'sync.progress',
  'sync.conflict',
  'catalog.updated',
  'update.required',
] as const;

export type EventTopic = (typeof EVENT_TOPICS)[number];

export interface BridgeEvent<T = unknown> {
  readonly v: typeof ENVELOPE_VERSION;
  readonly topic: EventTopic;
  readonly at: string;
  readonly data: T;
}

// ---------------------------------------------------------------------------
// Engine state
// ---------------------------------------------------------------------------

/**
 * Engine lifecycle.
 *
 * Extends the POC's machine with two states the sync design needs:
 *
 *   HYDRATING  Cold start in progress. The window is open and showing progress;
 *              tier-1 tables are still loading. Reads fail with E_HYDRATING
 *              rather than returning an empty result, because an empty catalog
 *              looks like "this shop has no stock" and that is worse than an
 *              honest "still loading".
 *
 *   PUSH_ONLY  The server says this client is too old to pull but recent enough
 *              to push. Selling continues from the existing local replica, the
 *              outbox drains, and a forced update is pending. Refusing a shop's
 *              queued sales because the client is a version behind is the one
 *              failure mode we will not ship.
 */
export type EngineState =
  | 'LOCKED'
  | 'HYDRATING'
  | 'READY'
  | 'DEGRADED'
  | 'PUSH_ONLY'
  | 'FATAL'
  | 'DRAINING';

// ---------------------------------------------------------------------------
// Renderer-facing bridge surface
// ---------------------------------------------------------------------------

/** What `preload.ts` exposes on `window.bizuriLocal` via contextBridge. */
export interface BizuriLocalBridge {
  readonly available: true;
  readonly envelopeVersion: typeof ENVELOPE_VERSION;
  readonly contractVersion: string;
  request<T = unknown>(req: Omit<LocalRequest, 'v'>): Promise<LocalResponse<T>>;
  subscribe(topic: EventTopic, handler: (e: BridgeEvent) => void): () => void;
}

// ---------------------------------------------------------------------------
// Operation handlers
// ---------------------------------------------------------------------------

export interface ValidationFailure {
  readonly code: ErrorCode;
  readonly message: string;
  readonly retryable: boolean;
  readonly details?: Record<string, unknown>;
}

/**
 * A resolved operation: the request plus everything the pipeline established
 * about it. Handlers receive this rather than a raw payload, so a handler can
 * never accidentally read an unvalidated field.
 */
export interface OperationContext {
  readonly request: LocalRequest;
  /** From X-Tenant-Id. Every query is scoped by this. */
  readonly tenantId: string;
  /** From X-Branch-Id. Undefined for tenant-scoped operations. */
  readonly branchId?: string;
  readonly idempotencyKey?: string;
}

export interface OperationResult<T = unknown> {
  readonly status: number;
  readonly data: T;
  readonly durableAt?: string;
}

export type OperationHandler<T = unknown> = (
  ctx: OperationContext,
) => OperationResult<T> | Promise<OperationResult<T>>;

export interface OperationDefinition {
  readonly operationId: string;
  readonly handler: OperationHandler;
  readonly schema?: JsonSchema;
  readonly rateLimit: number;
  readonly requiresUnlock: boolean;
}

// ---------------------------------------------------------------------------
// Tagged errors
// ---------------------------------------------------------------------------

/**
 * An error a handler can throw to produce a specific response code.
 *
 * Handlers throw these rather than returning error results so that a failure
 * mid-transaction unwinds the SQLite transaction naturally instead of needing
 * every caller to check a return value.
 */
export class EngineError extends Error {
  constructor(
    readonly code: ErrorCode,
    message: string,
    readonly retryable = false,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'EngineError';
  }
}

export const notFound = (what: string) =>
  new EngineError('E_NOT_FOUND', `${what} not found.`, false);

export const insufficientStock = (details: Record<string, unknown>) =>
  new EngineError('E_STOCK', 'Insufficient stock for one or more lines.', false, details);
