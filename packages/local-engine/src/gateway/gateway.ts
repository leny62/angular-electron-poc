/**
 * IPC gateway.
 *
 * Registers the single request channel and routes everything through the
 * validation pipeline before a handler sees it. Ported from the POC's gateway,
 * which had the right shape; the changes are the operationId vocabulary, the
 * frozen operation registry, and error sanitisation that also strips the things
 * the POC's version missed.
 *
 * The gateway knows about the pipeline, the registry, and the window. It knows
 * nothing about tables, SQL, or business rules.
 */

import { ipcMain, type BrowserWindow } from 'electron';
import { ALL_ROUTES, requestSchemaFor, routeFor } from '@bizuri/local-store';
import {
  ENVELOPE_VERSION,
  EVENT_CHANNEL,
  EngineError,
  ERROR_STATUS,
  REQUEST_CHANNEL,
  type BridgeEvent,
  type EventTopic,
  type LocalErr,
  type LocalOk,
  type LocalRequest,
  type LocalResponse,
  type OperationDefinition,
  type OperationHandler,
} from '../contracts';
import type { EngineStateMachine } from '../domain/engine-state';
import { getLogger, withLogContext } from '../logging/logger';
import { buildErrorResponse, validateRequest, type ValidationContext } from './validation-pipeline';

const log = getLogger('gateway');

// ---------------------------------------------------------------------------
// Operation registry
//
// Built once at startup and frozen, as in the POC. Nothing can register an
// operation after the window loads, so a compromised renderer cannot introduce
// one. The registry is now checked against the generated route table, so a
// handler for an operation the contract does not declare is a startup error.
// ---------------------------------------------------------------------------

let registry: ReadonlyMap<string, OperationDefinition> | null = null;

/**
 * Operations that must not produce a request log line of their own.
 *
 * The viewer polls `listSystemLogs`, so logging that call writes a row that the
 * next poll reads and logs again. `writeSystemLogs` is worse: it would record
 * the act of recording.
 */
const SELF_LOGGING_OPERATIONS: ReadonlySet<string> = new Set([
  'listSystemLogs',
  'writeSystemLogs',
  // Polled by the status bar several times a minute and says nothing useful.
  'engineStatus',
]);

export interface RegistryEntry {
  readonly operationId: string;
  readonly handler: OperationHandler;
}

export function buildRegistry(entries: readonly RegistryEntry[]): void {
  if (registry) {
    throw new Error('Operation registry is already built. It is frozen for the process lifetime.');
  }

  const map = new Map<string, OperationDefinition>();

  for (const entry of entries) {
    const route = routeFor(entry.operationId);
    if (!route) {
      throw new Error(
        `Handler registered for "${entry.operationId}", which is not in the generated route table.`,
      );
    }
    if (map.has(entry.operationId)) {
      throw new Error(`Duplicate handler for "${entry.operationId}".`);
    }

    const schema = requestSchemaFor(entry.operationId);
    map.set(entry.operationId, {
      operationId: entry.operationId,
      handler: entry.handler,
      ...(schema ? { schema } : {}),
      rateLimit: route.rateLimit,
      requiresUnlock: route.requiresUnlock,
    });
  }

  // Fail fast on an unimplemented route. Discovering this at startup beats
  // discovering it when a cashier taps a button, because the alternative is a
  // request that falls through to the network while the device is offline.
  const missing = ALL_ROUTES.filter((r) => !map.has(r.operationId)).map((r) => r.operationId);
  if (missing.length > 0) {
    throw new Error(
      `No handler registered for declared offline operations: ${missing.join(', ')}. ` +
        'Either implement them or remove them from the route table.',
    );
  }

  registry = Object.freeze(map);
}

/** Test-only: allows a fresh registry per test. */
export function resetRegistry(): void {
  registry = null;
}

export function isRegistryBuilt(): boolean {
  return registry !== null;
}

// ---------------------------------------------------------------------------
// Gateway
// ---------------------------------------------------------------------------

export interface GatewayConfig {
  readonly mainWindow: BrowserWindow;
  readonly allowedOrigin: string;
  readonly engineState: EngineStateMachine;
}

export function registerGateway(config: GatewayConfig): () => void {
  const { mainWindow, allowedOrigin, engineState } = config;

  const handler = async (
    event: Electron.IpcMainInvokeEvent,
    raw: unknown,
  ): Promise<LocalResponse> => {
    const requestId = readRequestId(raw);

    // The registry is built before the window loads. If it is not built, the
    // engine failed to start and every request must be refused rather than
    // silently doing nothing.
    if (!registry) {
      log.error('Request refused: engine not initialised', undefined, { requestId });
      return buildErrorResponse(
        {
          code: 'E_INTERNAL',
          message: 'Engine is not initialised. Restart the application.',
          retryable: false,
        },
        requestId,
      );
    }

    const ctx: ValidationContext = { event, mainWindow, allowedOrigin, engineState };
    const outcome = validateRequest(raw, ctx);

    if (!outcome.valid) {
      // A rejected request never reaches a handler, so this is the only place
      // it is ever recorded. Gate failures are the highest-value line in the
      // table: they are how a renderer bug looks from the engine's side.
      log.warn(`Rejected ${readOperationId(raw) ?? 'unknown operation'}`, {
        requestId,
        code: outcome.failure.code,
        url: readOperationId(raw) ?? null,
        context: { retryable: outcome.failure.retryable, ...outcome.failure.details },
      });
      return buildErrorResponse(outcome.failure, requestId);
    }

    const { request } = outcome;
    const definition = registry.get(request.operationId);
    if (!definition) {
      log.error('Operation has no handler', undefined, {
        requestId,
        url: request.operationId,
        code: 'E_INTERNAL',
      });
      return buildErrorResponse(
        { code: 'E_INTERNAL', message: 'Operation is not configured.', retryable: false },
        requestId,
      );
    }

    // The log operations are excluded from request logging. The viewer polls
    // `listSystemLogs`, and a poll that writes a row is a table that fills with
    // records of itself being read.
    const traced = !SELF_LOGGING_OPERATIONS.has(request.operationId);
    const started = Date.now();

    // Ambient context, so an entry written deep inside a handler still carries
    // the request id without the handler being passed one.
    return withLogContext(
      {
        requestId: request.id,
        url: request.operationId,
        ...(outcome.ctx.tenantId ? { tenantId: outcome.ctx.tenantId } : {}),
        thread: 'main',
      },
      async () => {
        try {
          const result = await Promise.resolve(definition.handler(outcome.ctx));

          if (traced) {
            log.debug(`${request.method} ${request.operationId}`, {
              code: result.status,
              context: { durationMs: Date.now() - started },
            });
          }

          const ok: LocalOk = {
            v: ENVELOPE_VERSION,
            id: request.id,
            ok: true,
            status: result.status,
            data: result.data,
            ...(result.durableAt ? { durableAt: result.durableAt } : {}),
          };
          return ok;
        } catch (err) {
          const shaped = shapeHandlerError(err, request);
          log.error(`Failed ${request.operationId}`, err, {
            code: shaped.code,
            context: { durationMs: Date.now() - started, status: shaped.status },
          });
          return shaped;
        }
      },
    );
  };

  ipcMain.handle(REQUEST_CHANNEL, handler);

  return () => {
    ipcMain.removeHandler(REQUEST_CHANNEL);
  };
}

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

/**
 * Push an event to the renderer.
 *
 * Guarded against a destroyed window: emitting during shutdown is normal, and it
 * must not throw inside a sync worker's error handler and mask the real problem.
 */
export function emitEvent<T>(
  mainWindow: BrowserWindow,
  topic: EventTopic,
  data: T,
): void {
  if (mainWindow.isDestroyed() || mainWindow.webContents.isDestroyed()) return;

  const event: BridgeEvent<T> = {
    v: ENVELOPE_VERSION,
    topic,
    at: new Date().toISOString(),
    data,
  };
  mainWindow.webContents.send(EVENT_CHANNEL, event);
}

// ---------------------------------------------------------------------------
// Error shaping
// ---------------------------------------------------------------------------

function readRequestId(raw: unknown): string | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined;
  const id = (raw as Record<string, unknown>)['id'];
  return typeof id === 'string' ? id : undefined;
}

function readOperationId(raw: unknown): string | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined;
  const value = (raw as Record<string, unknown>)['operationId'];
  // Bounded: this string reaches the log table, and gate 2 rejected it precisely
  // because it is not one of ours, so nothing about it can be assumed.
  return typeof value === 'string' ? value.slice(0, 80) : undefined;
}

function shapeHandlerError(err: unknown, request: LocalRequest): LocalErr {
  if (err instanceof EngineError) {
    return {
      v: ENVELOPE_VERSION,
      id: request.id,
      ok: false,
      status: ERROR_STATUS[err.code],
      code: err.code,
      message: err.message,
      retryable: err.retryable,
      ...(err.details ? { details: err.details } : {}),
    };
  }

  // Anything else is a bug. Log it in full, return nothing useful to an attacker.
  console.error(`[gateway] unhandled error in "${request.operationId}":`, err);

  return {
    v: ENVELOPE_VERSION,
    id: request.id,
    ok: false,
    status: 500,
    code: 'E_INTERNAL',
    message: sanitiseMessage(err instanceof Error ? err.message : 'An internal error occurred.'),
    retryable: false,
  };
}

/**
 * Strip anything from an error message that helps map the host or the schema.
 *
 * Broader than the POC's version, which missed table names and constraint text.
 * A raw SQLite error like
 *   "UNIQUE constraint failed: sales.idempotency_key"
 * tells a caller the table, the column, and the constraint, which is a free
 * schema dump. The order matters: table names are redacted before the generic
 * SQL-keyword pass, so the specific rule wins.
 */
export function sanitiseMessage(message: string): string {
  return message
    // "UNIQUE constraint failed: sales.idempotency_key"
    .replace(/(UNIQUE|CHECK|FOREIGN KEY|NOT NULL) constraint failed:?[^\n]*/gi, 'constraint violation')
    // POSIX and Windows paths
    .replace(/\/[^\s'"]*\.(ts|js|sqlite|db|node|map)/g, '[path]')
    .replace(/[A-Za-z]:\\[^\s'"]*/g, '[path]')
    // SQL fragments
    .replace(/\b(SELECT|INSERT INTO|UPDATE|DELETE FROM|CREATE|DROP|ALTER|PRAGMA)\b[^\n]*/gi, '[sql]')
    // Stack traces
    .replace(/\n\s+at\s.*/gs, '')
    .trim();
}
