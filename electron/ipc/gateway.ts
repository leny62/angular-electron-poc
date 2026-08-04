/**
 * IPC Gateway.
 *
 * Registers the single `bizuri.command` channel on ipcMain and routes
 * every incoming message through the validation pipeline before it
 * reaches a handler.
 *
 * The gateway is deliberately small.  It knows about:
 *   - The ipcMain handle
 *   - The validation pipeline
 *   - The command registry
 *   - The BrowserWindow (for event emission)
 *
 * It does NOT know about specific commands, database tables, or
 * business rules.  Those live behind the CommandDefinition interface.
 */

import { ipcMain, type BrowserWindow } from 'electron';
import type { CommandDefinition, CommandEnvelope, CommandOk, CommandErr } from '../shared/contracts';
import { validateCommand, buildErrorResponse } from '../domain/validation-pipeline';
import type { ValidationContext, ValidationResult } from '../domain/validation-pipeline';
import { findCommand, isRegistryInitialised } from '../domain/command-registry';
import type { EngineStateMachine } from '../domain/engine-state';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface GatewayConfig {
  readonly mainWindow: BrowserWindow;
  readonly allowedOrigin: string;
  readonly engineState: EngineStateMachine;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Register the bizuri.command IPC handler.
 *
 * Must be called once, after the command registry is initialised and
 * before the window loads its first page.
 *
 * Returns an unsubscribe function for graceful shutdown.
 */
export function registerIpcGateway(config: GatewayConfig): () => void {
  const { mainWindow, allowedOrigin, engineState } = config;

  const handler = async (
    _event: Electron.IpcMainInvokeEvent,
    rawBody: unknown,
  ): Promise<CommandErr | CommandOk<unknown>> => {
    // Guard: reject all commands when the registry was never initialised
    // (engine started in FATAL state after DB migration failure).
    if (!isRegistryInitialised()) {
      const envelope = rawBody as { id?: string } | null | undefined;
      return buildErrorResponse(
        {
          code: 'E_INTERNAL',
          message: 'Engine is not initialised. Restart the application.',
          retryable: false,
        },
        envelope?.id,
      );
    }

    const ctx: ValidationContext = {
      event: _event,
      mainWindow,
      allowedOrigin,
      engineState,
    };

    // --- Validation pipeline (gates 1–6) ---
    const result: ValidationResult = validateCommand(rawBody, ctx, findCommand);

    if (!result.valid) {
      const envelope = rawBody as { id?: string } | null | undefined;
      return buildErrorResponse(result.failure!, envelope?.id);
    }

    const envelope = result.envelope!;
    const command = result.command!;

    // --- Engine lifecycle check (DRAINING edge case) ---
    // Gate 5 covers LOCKED/FATAL via requiresUnlock.  This check
    // catches the DRAINING state where writes are rejected but reads
    // are still permitted.
    if (!engineState.isCommandAllowed(envelope.name)) {
      return buildErrorResponse(
        {
          code: 'E_LOCKED',
          message: `Engine is ${engineState.state}. Command not allowed.`,
          retryable: false,
        },
        envelope.id,
      );
    }

    // --- Execute handler ---
    try {
      const data = await Promise.resolve(command.handler(envelope.payload, envelope));
      return {
        v: 1,
        id: envelope.id,
        ok: true,
        data,
        durableAt: new Date().toISOString(),
      };
    } catch (err: unknown) {
      return handleHandlerError(err, envelope);
    }
  };

  ipcMain.handle('bizuri.command', handler);

  return () => {
    ipcMain.removeHandler('bizuri.command');
  };
}

// ---------------------------------------------------------------------------
// Error handling
// ---------------------------------------------------------------------------

/**
 * Convert a thrown error from a handler into a CommandErr.
 *
 * Handlers throw enriched errors with `code` and `retryable` properties.
 * Unanticipated errors (bugs) produce E_INTERNAL with a sanitised message
 * that never contains file paths, SQL fragments, or stack traces.
 */
function handleHandlerError(err: unknown, envelope: CommandEnvelope): CommandErr {
  const isTaggedError = (
    e: unknown,
  ): e is Error & { code: string; retryable?: boolean; details?: Record<string, unknown> } =>
    e instanceof Error && 'code' in e;

  if (isTaggedError(err)) {
    return {
      v: 1,
      id: envelope.id,
      ok: false,
      code: (err as Error & { code: string }).code as CommandErr['code'],
      message: err.message,
      retryable: (err as Error & { retryable?: boolean }).retryable ?? false,
      details: (err as Error & { details?: Record<string, unknown> }).details,
    };
  }

  // Untagged error — sanitise before crossing the bridge.
  const message = err instanceof Error ? err.message : 'An internal error occurred.';

  return {
    v: 1,
    id: envelope.id,
    ok: false,
    code: 'E_INTERNAL',
    message: sanitiseErrorMessage(message),
    retryable: false,
  };
}

/**
 * Strip file paths, SQL fragments, and stack traces from error messages
 * before they cross the bridge into the renderer.
 */
function sanitiseErrorMessage(message: string): string {
  return (
    message
      // Absolute paths
      .replace(/\/[^\s]*?\.(ts|js|sqlite|db)/g, '[path]')
      // Windows paths
      .replace(/[A-Z]:\\[^\s]*?\.(ts|js|sqlite|db)/gi, '[path]')
      // SQL fragments
      .replace(/\b(SELECT|INSERT|UPDATE|DELETE|CREATE|DROP|ALTER)\b/gi, '[sql]')
      // Stack traces
      .replace(/\n\s+at .*/gs, '')
      .trim()
  );
}
