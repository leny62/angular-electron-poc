/**
 * Command validation pipeline.
 *
 * Six gates run before a handler sees a payload.  They run in order,
 * cheap first and expensive last, and none can be skipped.
 *
 *   Gate 1 — sender identity (is this frame ours?)
 *   Gate 2 — command allow-list (do we know this name?)
 *   Gate 3 — envelope shape (are all required fields present and typed?)
 *   Gate 4 — payload schema validation against JSON Schema
 *   Gate 5 — session / permission scope
 *   Gate 6 — rate and size limiting
 *
 * @see docs/Bizuri-Secure-IPC-Offline-Design.docx  Section 5.6
 */

import type { IpcMainInvokeEvent } from 'electron';
import type { BrowserWindow } from 'electron';
import type {
  CommandEnvelope,
  CommandDefinition,
  ValidationFailure,
} from '../shared/contracts';
import { COMMAND_NAMES } from '../shared/contracts';
import { verifySender } from '../security/sender-verification';
import { validateSchema } from './json-schema-validator';
import type { JsonSchema } from './json-schema-validator';
import { COMMAND_SCHEMAS } from './command-schemas';
import { RateLimiter } from './rate-limiter';
import type { EngineStateMachine } from './engine-state';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Maximum envelope size in bytes (64 KB). */
const MAX_ENVELOPE_SIZE = 65_536;

// ---------------------------------------------------------------------------
// Rate limiter (session lifetime)
// ---------------------------------------------------------------------------

const rateLimiter = new RateLimiter({
  windowMs: 60_000,
  maxCalls: 60,
});

// ---------------------------------------------------------------------------
// Gate implementations
// ---------------------------------------------------------------------------

/**
 * Gate 1 — Sender identity.
 * Rejects any command that didn't originate from our own window's frame.
 */
function gateSenderIdentity(
  event: IpcMainInvokeEvent,
  mainWindow: BrowserWindow,
  allowedOrigin: string,
): ValidationFailure | null {
  const error = verifySender(event, mainWindow, allowedOrigin);
  if (error) {
    return {
      code: 'E_SENDER',
      message: 'Command rejected by sender identity check.',
      retryable: false,
    };
  }
  return null;
}

/**
 * Gate 2 — Command allow-list.
 * The name must be in the frozen registry.  The error message deliberately
 * does not echo the name back, so probing the surface tells an attacker nothing.
 */
function gateCommandAllowList(name: unknown): ValidationFailure | null {
  if (typeof name !== 'string' || !(COMMAND_NAMES as readonly string[]).includes(name)) {
    return {
      code: 'E_UNKNOWN_COMMAND',
      message: 'Unknown command.',
      retryable: false,
    };
  }
  return null;
}

/**
 * Gate 3 — Envelope shape.
 * Version, identifier, name, issuedAt, and payload must all be present
 * and of the expected types.  The version check is what makes an update
 * safe: a renderer with a newer contract version cannot send commands
 * to an older main process.
 */
function gateEnvelopeShape(body: unknown): ValidationFailure | null {
  if (typeof body !== 'object' || body === null) {
    return { code: 'E_ENVELOPE', message: 'Envelope must be an object.', retryable: false };
  }

  const env = body as Record<string, unknown>;

  // version — must be exactly 1 (this build's contract version)
  if (env.v !== 1) {
    return {
      code: 'E_ENVELOPE',
      message: 'Unsupported contract version.',
      retryable: false,
      details: { expected: 1, received: env.v },
    };
  }

  // identifier — must be a non-empty string
  if (typeof env.id !== 'string' || env.id.length === 0) {
    return {
      code: 'E_ENVELOPE',
      message: 'Missing or invalid command identifier.',
      retryable: false,
    };
  }

  // name — must be a non-empty string (allow-list is gate 2)
  if (typeof env.name !== 'string' || env.name.length === 0) {
    return { code: 'E_ENVELOPE', message: 'Missing command name.', retryable: false };
  }

  // issuedAt — must be an ISO-8601 string
  if (typeof env.issuedAt !== 'string' || isNaN(Date.parse(env.issuedAt))) {
    return {
      code: 'E_ENVELOPE',
      message: 'Missing or invalid issuedAt timestamp.',
      retryable: false,
    };
  }

  // payload — must be present (may be null for parameterless commands)
  if (!('payload' in env)) {
    return { code: 'E_ENVELOPE', message: 'Missing payload field.', retryable: false };
  }

  return null;
}

/**
 * Gate 4 — Payload schema validation.
 *
 * Validates the payload against the JSON Schema registered for this
 * command.  Commands without a schema pass through (no validation).
 *
 * Error messages are deliberately generic — the renderer sees
 * "Schema validation failed" and the detailed path is logged to the
 * main-process console for debugging, never sent to the client.
 */
function gatePayloadSchema(
  envelope: CommandEnvelope,
  command: CommandDefinition,
): ValidationFailure | null {
  const schema: JsonSchema | undefined =
    command.schema ?? COMMAND_SCHEMAS.get(envelope.name);

  if (!schema) {
    return null; // no schema means no validation
  }

  const payload = envelope.payload ?? {};
  const errors = validateSchema(payload, schema);

  if (errors.length > 0) {
    // Log details server-side for debugging; never expose paths to the renderer.
    console.warn(
      `[gate:4] Schema validation failed for "${envelope.name}":`,
      errors.map((e) => `${e.path}: ${e.message}`).join('; '),
    );

    return {
      code: 'E_SCHEMA',
      message: 'Schema validation failed.',
      retryable: false,
      details: {
        errorCount: errors.length,
        // Only surface the first path, sanitised.
        hint: sanitisePath(errors[0].path),
      },
    };
  }

  return null;
}

/**
 * Gate 5 — Session / permission scope.
 *
 * Rejects commands that require an unlocked vault when the engine is
 * in a locked or fatal state.  Commands with `requiresUnlock: false`
 * always pass this gate regardless of engine state.
 */
function gateSessionScope(
  command: CommandDefinition,
  engineState: EngineStateMachine,
): ValidationFailure | null {
  if (command.requiresUnlock !== true) {
    return null;
  }

  const blockedStates: readonly string[] = ['LOCKED', 'FATAL'];
  if (blockedStates.includes(engineState.state)) {
    return {
      code: 'E_LOCKED',
      message: `Engine is ${engineState.state}. Vault must be unlocked to execute this command.`,
      retryable: false,
    };
  }

  return null;
}

/**
 * Gate 6 — Rate and size limiting.
 *
 *   a. Envelope size: rejects payloads larger than MAX_ENVELOPE_SIZE.
 *   b. Rate limiting: rejects calls that exceed the per-command rate.
 *
 * Size check runs first because it is cheaper (JSON.stringify on the
 * raw body) and protects the rate-limiter data structures from
 * oversized input.
 */
function gateRateAndSizeLimit(
  rawBody: unknown,
  command: CommandDefinition,
): ValidationFailure | null {
  // 6a — size limit
  try {
    const size = JSON.stringify(rawBody).length;
    if (size > MAX_ENVELOPE_SIZE) {
      return {
        code: 'E_RATE_LIMIT',
        message: `Envelope exceeds maximum size of ${MAX_ENVELOPE_SIZE} bytes.`,
        retryable: false,
        details: { size, limit: MAX_ENVELOPE_SIZE },
      };
    }
  } catch {
    return {
      code: 'E_ENVELOPE',
      message: 'Unable to serialise envelope.',
      retryable: false,
    };
  }

  // 6b — rate limit
  const effectiveRateLimit = command.rateLimit;
  const result = rateLimiter.check(command.name, effectiveRateLimit);

  if (!result.allowed) {
    return {
      code: 'E_RATE_LIMIT',
      message: result.reason ?? 'Rate limit exceeded.',
      retryable: true,
    };
  }

  return null;
}

// ---------------------------------------------------------------------------
// Pipeline runner
// ---------------------------------------------------------------------------

export interface ValidationContext {
  readonly event: IpcMainInvokeEvent;
  readonly mainWindow: BrowserWindow;
  readonly allowedOrigin: string;
  readonly engineState: EngineStateMachine;
}

export interface ValidationResult {
  /** True when all gates passed. */
  readonly valid: boolean;
  /** The parsed envelope (available only when valid). */
  readonly envelope?: CommandEnvelope;
  /** The registered command definition (available only when valid). */
  readonly command?: CommandDefinition;
  /** The failure that stopped the pipeline (available only when invalid). */
  readonly failure?: ValidationFailure;
}

/**
 * Run the full validation pipeline against a raw IPC payload.
 *
 * Gates run cheapest-first.  Each gate returns either `null` (pass)
 * or a `ValidationFailure` (stop).  The pipeline short-circuits on
 * the first failure.
 *
 * IMPORTANT: This function depends on a rate-limiter singleton.
 * It is NOT pure, but the side effects (rate-limit counters) are
 * confined, deterministic, and the same across all callers.
 */
export function validateCommand(
  rawBody: unknown,
  context: ValidationContext,
  findCommand: (name: string) => CommandDefinition | undefined,
): ValidationResult {
  // Gate 1 — sender identity
  const senderFailure = gateSenderIdentity(
    context.event,
    context.mainWindow,
    context.allowedOrigin,
  );
  if (senderFailure) return { valid: false, failure: senderFailure };

  // Extract the name early for gate 2 (before full envelope parsing,
  // so we reject unknown commands without processing the body).
  const bodyObj = rawBody as Record<string, unknown> | null | undefined;
  const rawName = bodyObj?.name;

  // Gate 2 — command allow-list
  const allowListFailure = gateCommandAllowList(rawName);
  if (allowListFailure) return { valid: false, failure: allowListFailure };

  // Gate 3 — envelope shape
  const shapeFailure = gateEnvelopeShape(rawBody);
  if (shapeFailure) return { valid: false, failure: shapeFailure };

  // At this point the envelope is structurally valid.
  const envelope = rawBody as CommandEnvelope;
  const command = findCommand(envelope.name);
  if (!command) {
    return {
      valid: false,
      failure: {
        code: 'E_UNKNOWN_COMMAND',
        message: 'Unknown command.',
        retryable: false,
      },
    };
  }

  // Gate 4 — payload schema validation
  const schemaFailure = gatePayloadSchema(envelope, command);
  if (schemaFailure) return { valid: false, failure: schemaFailure };

  // Gate 5 — session / permission scope
  const sessionFailure = gateSessionScope(command, context.engineState);
  if (sessionFailure) return { valid: false, failure: sessionFailure };

  // Gate 6 — rate and size limiting (must run AFTER gate 4 so schema
  // validation rejects malformed payloads before we count a call).
  const rateFailure = gateRateAndSizeLimit(rawBody, command);
  if (rateFailure) return { valid: false, failure: rateFailure };

  return { valid: true, envelope, command };
}

/**
 * Build a CommandErr from a ValidationFailure, preserving the command
 * identifier so the renderer can correlate the response.
 */
export function buildErrorResponse(
  failure: ValidationFailure,
  commandId?: string,
): import('../shared/contracts').CommandErr {
  return {
    v: 1,
    id: commandId ?? 'unknown',
    ok: false,
    code: failure.code,
    message: failure.message,
    retryable: failure.retryable,
    details: failure.details,
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Strip payload paths of internal detail before surfacing to the renderer.
 * Example: "$.items[0].itemId" → "items[0].itemId"
 */
function sanitisePath(path: string): string {
  return path.startsWith('$.') ? path.slice(2) : path;
}
