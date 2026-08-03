/**
 * Command validation pipeline.
 *
 * Six gates run before a handler sees a payload.  They run in order,
 * cheap first and expensive last, and none can be skipped.
 *
 * Phase 1 implements gates 1–3:
 *   Gate 1 — sender identity (is this frame ours?)
 *   Gate 2 — command allow-list (do we know this name?)
 *   Gate 3 — envelope shape (are all required fields present and typed?)
 *
 * Gates 4–6 are stubbed for Phase 2:
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
  ErrorCode,
  ValidationFailure,
} from '../shared/contracts';
import { COMMAND_NAMES, ERROR_CODES } from '../shared/contracts';
import { verifySender } from '../security/sender-verification';

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

// ---------------------------------------------------------------------------
// Pipeline runner
// ---------------------------------------------------------------------------

export interface ValidationContext {
  readonly event: IpcMainInvokeEvent;
  readonly mainWindow: BrowserWindow;
  readonly allowedOrigin: string;
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
 * Gates 1–3 run in Phase 1.  Gates 4–6 are stubbed (no-op) and will
 * be activated in Phase 2 when JSON Schema compilation and session
 * management are integrated.
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

  // Gates 4–6 (Phase 2 stubs — pass through)
  // TODO(Phase 2): JSON Schema validation
  // TODO(Phase 2): Session / permission scope
  // TODO(Phase 2): Rate and size limiting

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
