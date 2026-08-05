/**
 * Six-gate validation pipeline.
 *
 * Structure is the POC's, and it was right: cheapest gate first, short-circuit on
 * the first failure, no gate skippable. What changed is where two of the gates
 * get their data.
 *
 *   Gate 1  sender identity        unchanged (hardened, see sender-verification)
 *   Gate 2  operation allow-list   NOW from the generated route table
 *   Gate 3  envelope shape         unchanged in spirit, reshaped for LocalRequest
 *   Gate 4  request schema         NOW from generated REQUEST_SCHEMAS
 *   Gate 5  session scope          extended for HYDRATING / PUSH_ONLY
 *   Gate 6  size and rate limit    unchanged
 *
 * Gates 2 and 4 reading generated artifacts is the point: the allow-list and the
 * schemas cannot drift from the contract, because nobody maintains them.
 *
 * ─── On gate ordering ────────────────────────────────────────────────────────
 * Gate 6 stays last, after schema validation, so a malformed request does not
 * consume a legitimate user's rate budget. The cost is that gates 1 through 5
 * are reachable without rate limiting, which is why gate 4 bounds its own input
 * (see MAX_PATTERN_INPUT in json-schema-validator) and why gate 6's size check
 * is cheap. Gate 3 also caps the envelope before anything walks it.
 */

import type { BrowserWindow, IpcMainInvokeEvent } from 'electron';
import { OFFLINE_OPERATION_IDS, requestSchemaFor, routeFor } from '@bizuri/local-store';
import type { RouteDescriptor } from '@bizuri/local-store';
import {
  ENVELOPE_VERSION,
  ERROR_STATUS,
  type LocalErr,
  type LocalRequest,
  type OperationContext,
  type ValidationFailure,
} from '../contracts';
import type { EngineStateMachine } from '../domain/engine-state';
import { verifySender } from './sender-verification';
import { validateSchema } from './json-schema-validator';
import { RateLimiter } from './rate-limiter';

// ---------------------------------------------------------------------------
// Limits
// ---------------------------------------------------------------------------

/**
 * Maximum serialised request size, 256 KB.
 *
 * Larger than the POC's 64 KB because a real sale can legitimately be big: 500
 * lines at ~300 bytes each is ~150 KB, and the schema allows 500 lines. Too low
 * a cap would reject a genuine wholesale transaction, which is worse than
 * accepting a slightly larger envelope.
 */
const MAX_REQUEST_BYTES = 262_144;

const rateLimiter = new RateLimiter({ windowMs: 60_000, maxCalls: 60 });

/** Exposed for tests. */
export function resetRateLimiter(): void {
  rateLimiter.reset();
}

// ---------------------------------------------------------------------------
// Gates
// ---------------------------------------------------------------------------

/** Gate 1: did this come from our own main frame, at our own origin? */
function gateSender(
  event: IpcMainInvokeEvent,
  mainWindow: BrowserWindow,
  allowedOrigin: string,
): ValidationFailure | null {
  const rejection = verifySender(event, mainWindow, allowedOrigin);
  if (!rejection) return null;

  // Logged with the reason; the response carries none of it.
  console.warn(`[gate:1] sender rejected: ${rejection}`);
  return {
    code: 'E_SENDER',
    message: 'Request rejected.',
    retryable: false,
  };
}

/**
 * Gate 2: is this a known offline operation?
 *
 * The message never echoes the operationId, so probing the surface reveals
 * nothing about which operations exist.
 */
function gateAllowList(operationId: unknown): ValidationFailure | null {
  if (typeof operationId !== 'string' || !OFFLINE_OPERATION_IDS.has(operationId)) {
    return { code: 'E_UNKNOWN_OPERATION', message: 'Unknown operation.', retryable: false };
  }
  return null;
}

/** Gate 3: is the envelope structurally sound, and small enough to walk? */
function gateEnvelope(raw: unknown): ValidationFailure | null {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return { code: 'E_ENVELOPE', message: 'Envelope must be an object.', retryable: false };
  }

  const env = raw as Record<string, unknown>;

  // Version first. A renderer served from a stale cache after an app update must
  // not be able to talk to the new main process at all.
  if (env['v'] !== ENVELOPE_VERSION) {
    return {
      code: 'E_ENVELOPE',
      message: 'Unsupported envelope version. Reload the application.',
      retryable: false,
      details: { expected: ENVELOPE_VERSION, received: env['v'] },
    };
  }

  if (typeof env['id'] !== 'string' || env['id'].length === 0 || env['id'].length > 128) {
    return { code: 'E_ENVELOPE', message: 'Invalid request id.', retryable: false };
  }

  const method = env['method'];
  if (
    typeof method !== 'string' ||
    !['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].includes(method)
  ) {
    return { code: 'E_ENVELOPE', message: 'Invalid method.', retryable: false };
  }

  if (typeof env['issuedAt'] !== 'string' || Number.isNaN(Date.parse(env['issuedAt']))) {
    return { code: 'E_ENVELOPE', message: 'Invalid issuedAt timestamp.', retryable: false };
  }

  for (const key of ['pathParams', 'query', 'headers'] as const) {
    const v = env[key];
    if (v !== undefined && (typeof v !== 'object' || v === null || Array.isArray(v))) {
      return { code: 'E_ENVELOPE', message: `Invalid ${key}.`, retryable: false };
    }
  }

  return null;
}

/**
 * Gate 3b: does the envelope's method match the route's?
 *
 * Without this, a GET-only route could be invoked with POST and the body would
 * reach a reader that never expected one.
 */
function gateMethodMatch(
  request: LocalRequest,
  route: RouteDescriptor,
): ValidationFailure | null {
  if (request.method !== route.method) {
    return { code: 'E_ENVELOPE', message: 'Method not allowed for this operation.', retryable: false };
  }
  return null;
}

/** Gate 4: does the request satisfy the generated schema for this operation? */
function gateSchema(request: LocalRequest): ValidationFailure | null {
  const schema = requestSchemaFor(request.operationId);

  // Absent schema is a build error, not a pass. `routes.test.ts` asserts every
  // route has one, so reaching here means the generated artifacts disagree with
  // each other and we must not guess.
  if (!schema) {
    console.error(
      `[gate:4] no request schema for "${request.operationId}" — generated artifacts are inconsistent`,
    );
    return { code: 'E_INTERNAL', message: 'Operation is not configured.', retryable: false };
  }

  // Validate the addressable surface as one object so the schema can express
  // cross-field requirements (for example: body required, query forbidden).
  const subject = {
    headers: request.headers ?? {},
    pathParams: request.pathParams ?? {},
    query: request.query ?? {},
    ...(request.body !== undefined ? { body: request.body } : {}),
  };

  const errors = validateSchema(subject, schema);
  if (errors.length === 0) return null;

  console.warn(
    `[gate:4] schema validation failed for "${request.operationId}": ` +
      errors.map((e) => `${e.path}: ${e.message}`).join('; '),
  );

  return {
    code: 'E_SCHEMA',
    message: 'Request validation failed.',
    retryable: false,
    details: {
      errorCount: errors.length,
      // First path only, with the `$.` root stripped. Enough for a developer to
      // find the bug, not enough to enumerate the schema.
      hint: (errors[0]?.path ?? '').replace(/^\$\./, ''),
    },
  };
}

/** Gate 5: is the engine in a state that permits this operation? */
function gateSession(
  request: LocalRequest,
  route: RouteDescriptor,
  engineState: EngineStateMachine,
): ValidationFailure | null {
  if (!route.requiresUnlock) return null;

  if (!engineState.isOperationAllowed(request.operationId)) {
    const code = engineState.denialCode();
    return {
      code,
      message:
        code === 'E_HYDRATING'
          ? 'Local data is still loading. Retry shortly.'
          : `Engine is ${engineState.state}. Unlock required.`,
      // HYDRATING resolves on its own; LOCKED needs the user.
      retryable: code === 'E_HYDRATING',
      details: { engineState: engineState.state },
    };
  }
  return null;
}

/** Gate 6: size then rate. Size first, because it is cheaper. */
function gateRateAndSize(
  raw: unknown,
  route: RouteDescriptor,
): ValidationFailure | null {
  let bytes: number;
  try {
    bytes = Buffer.byteLength(JSON.stringify(raw) ?? '', 'utf8');
  } catch {
    // Circular structure, or a BigInt. Either way it is not a request we sent.
    return { code: 'E_ENVELOPE', message: 'Unable to serialise request.', retryable: false };
  }

  if (bytes > MAX_REQUEST_BYTES) {
    return {
      code: 'E_RATE_LIMIT',
      message: `Request exceeds the maximum size of ${MAX_REQUEST_BYTES} bytes.`,
      retryable: false,
      details: { bytes, limit: MAX_REQUEST_BYTES },
    };
  }

  const result = rateLimiter.check(route.operationId, route.rateLimit);
  if (!result.allowed) {
    return {
      code: 'E_RATE_LIMIT',
      message: result.reason ?? 'Rate limit exceeded.',
      retryable: true,
      ...(result.retryAfterSec !== undefined
        ? { details: { retryAfterSec: result.retryAfterSec } }
        : {}),
    };
  }

  return null;
}

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

export interface ValidationContext {
  readonly event: IpcMainInvokeEvent;
  readonly mainWindow: BrowserWindow;
  readonly allowedOrigin: string;
  readonly engineState: EngineStateMachine;
}

export type ValidationOutcome =
  | { readonly valid: true; readonly request: LocalRequest; readonly route: RouteDescriptor; readonly ctx: OperationContext }
  | { readonly valid: false; readonly failure: ValidationFailure };

export function validateRequest(raw: unknown, context: ValidationContext): ValidationOutcome {
  // Gate 1
  const senderFailure = gateSender(context.event, context.mainWindow, context.allowedOrigin);
  if (senderFailure) return { valid: false, failure: senderFailure };

  // Gate 2 — before parsing the rest, so an unknown operation costs nothing.
  const rawObj = raw as Record<string, unknown> | null | undefined;
  const allowFailure = gateAllowList(rawObj?.['operationId']);
  if (allowFailure) return { valid: false, failure: allowFailure };

  // Gate 3
  const envelopeFailure = gateEnvelope(raw);
  if (envelopeFailure) return { valid: false, failure: envelopeFailure };

  const request = raw as LocalRequest;
  const route = routeFor(request.operationId);
  if (!route) {
    // Gate 2 passed but no route exists: the allow-list and the route table
    // disagree, which is a build inconsistency rather than a bad request.
    return {
      valid: false,
      failure: { code: 'E_INTERNAL', message: 'Operation is not configured.', retryable: false },
    };
  }

  const methodFailure = gateMethodMatch(request, route);
  if (methodFailure) return { valid: false, failure: methodFailure };

  // Gate 4
  const schemaFailure = gateSchema(request);
  if (schemaFailure) return { valid: false, failure: schemaFailure };

  // Gate 5
  const sessionFailure = gateSession(request, route, context.engineState);
  if (sessionFailure) return { valid: false, failure: sessionFailure };

  // Gate 6 — last, so malformed requests do not consume the caller's budget.
  const rateFailure = gateRateAndSize(raw, route);
  if (rateFailure) return { valid: false, failure: rateFailure };

  // Scope is read from validated headers. Gate 4 has already guaranteed that
  // X-Tenant-Id is present, and X-Branch-Id too for branch-scoped operations,
  // so the non-null assertion below is backed by the schema.
  const headers = request.headers ?? {};
  const ctx: OperationContext = {
    request,
    tenantId: headers['X-Tenant-Id'] as string,
    ...(headers['X-Branch-Id'] ? { branchId: headers['X-Branch-Id'] } : {}),
    ...(headers['Idempotency-Key'] ? { idempotencyKey: headers['Idempotency-Key'] } : {}),
  };

  return { valid: true, request, route, ctx };
}

// ---------------------------------------------------------------------------
// Error shaping
// ---------------------------------------------------------------------------

export function buildErrorResponse(failure: ValidationFailure, requestId?: string): LocalErr {
  return {
    v: ENVELOPE_VERSION,
    id: requestId ?? 'unknown',
    ok: false,
    status: ERROR_STATUS[failure.code],
    code: failure.code,
    message: failure.message,
    retryable: failure.retryable,
    ...(failure.details ? { details: failure.details } : {}),
  };
}
