/**
 * Engine state machine.
 *
 * Tracks the lifecycle of the local engine and enforces which
 * commands are permitted in each state.
 *
 *   READY     — database open, all systems operational.
 *   DEGRADED  — sync worker has failed repeatedly; local ops continue.
 *   LOCKED    — vault is locked; only session.unlock / session.state accepted.
 *   FATAL     — unrecoverable error (migration failure, DB corruption).
 *   DRAINING  — app is quitting; in-flight sync entries completing.
 *
 * State transitions are synchronous and intentional.  There is no
 * automatic recovery from FATAL.
 *
 * @see docs/Bizuri-Secure-IPC-Offline-Design.docx  Section 9.2
 */

import type { EngineState } from '../shared/contracts';

const COMMANDS_ALWAYS_ALLOWED: ReadonlySet<string> = new Set([
  'session.unlock',
  'session.state',
  'engine.health',
]);

export class EngineStateMachine {
  private _state: EngineState = 'LOCKED';
  private _errorMessage: string | null = null;

  /** Current state. */
  get state(): EngineState {
    return this._state;
  }

  /** Human-readable description of the last error (FATAL / DEGRADED). */
  get errorMessage(): string | null {
    return this._errorMessage;
  }

  /** Transition to READY after successful unlock and migration. */
  markReady(): void {
    this._state = 'READY';
    this._errorMessage = null;
  }

  /** Transition to LOCKED (vault closed, explicit lock or idle timeout). */
  markLocked(): void {
    this._state = 'LOCKED';
    this._errorMessage = null;
  }

  /** Transition to DEGRADED with a reason. */
  markDegraded(reason: string): void {
    this._state = 'DEGRADED';
    this._errorMessage = reason;
  }

  /** Transition to FATAL.  The app window stays open but rejects all commands. */
  markFatal(reason: string): void {
    this._state = 'FATAL';
    this._errorMessage = reason;
  }

  /** Transition to DRAINING during graceful shutdown. */
  markDraining(): void {
    this._state = 'DRAINING';
    this._errorMessage = null;
  }

  /**
   * True when the given command is allowed in the current state.
   * In LOCKED and FATAL, only the whitelisted commands pass.
   * In DRAINING, all write commands are rejected.
   */
  isCommandAllowed(commandName: string): boolean {
    switch (this._state) {
      case 'READY':
      case 'DEGRADED':
        return true;

      case 'LOCKED':
      case 'FATAL':
        return COMMANDS_ALWAYS_ALLOWED.has(commandName);

      case 'DRAINING':
        // In draining, reads are OK; writes are rejected.
        return (
          COMMANDS_ALWAYS_ALLOWED.has(commandName) ||
          commandName.startsWith('catalog.') ||
          commandName.startsWith('stock.balance') ||
          commandName === 'sale.get' ||
          commandName === 'sale.list' ||
          commandName === 'customer.search' ||
          commandName === 'sync.conflicts'
        );

      default:
        return false;
    }
  }

  /**
   * Human-readable summary for diagnostics and the renderer's status bar.
   */
  describe(): string {
    const base = `Engine: ${this._state}`;
    return this._errorMessage ? `${base} — ${this._errorMessage}` : base;
  }
}
