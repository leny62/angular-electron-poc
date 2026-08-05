/**
 * Engine state machine.
 *
 * Ported from the POC and extended with HYDRATING and PUSH_ONLY, and with
 * permission driven by the generated route table instead of a hand-maintained
 * list of command-name prefixes. The POC's `isCommandAllowed` matched on strings
 * like `commandName.startsWith('catalog.')`, which silently grants or denies the
 * wrong thing the moment a name is added.
 *
 * Transitions are explicit and synchronous. There is no automatic recovery from
 * FATAL: a corrupt database or a failed migration needs a human, and retrying it
 * in a loop just hides the problem.
 */

import { routeFor } from '@bizuri/local-store';
import type { EngineState } from '../contracts';

/** Operations reachable while the vault is locked or the engine is dead. */
const ALWAYS_ALLOWED: ReadonlySet<string> = new Set(['engineUnlock', 'engineStatus']);

export interface StateChange {
  readonly from: EngineState;
  readonly to: EngineState;
  readonly reason: string | null;
  readonly at: string;
}

export class EngineStateMachine {
  private _state: EngineState = 'LOCKED';
  private _reason: string | null = null;
  private readonly listeners = new Set<(c: StateChange) => void>();

  get state(): EngineState {
    return this._state;
  }

  get reason(): string | null {
    return this._reason;
  }

  /** True when local reads and writes are permitted. */
  get isOperational(): boolean {
    return (
      this._state === 'READY' || this._state === 'DEGRADED' || this._state === 'PUSH_ONLY'
    );
  }

  // -------------------------------------------------------------------------
  // Transitions
  // -------------------------------------------------------------------------

  markLocked(): void {
    this.transition('LOCKED', null);
  }

  /** Cold start: tier-1 tables are still loading. */
  markHydrating(reason = 'Loading catalog and stock'): void {
    this.transition('HYDRATING', reason);
  }

  markReady(): void {
    this.transition('READY', null);
  }

  /** Sync has failed repeatedly. Local operation continues unaffected. */
  markDegraded(reason: string): void {
    this.transition('DEGRADED', reason);
  }

  /**
   * The server accepts our writes but not our reads: this client is behind the
   * minimum contract version but still inside the grace window.
   *
   * Deliberately not DEGRADED. DEGRADED means "sync is flaky, it will probably
   * recover"; PUSH_ONLY means "this will not recover without an app update", and
   * the UI has to say so with a deadline.
   */
  markPushOnly(reason: string): void {
    this.transition('PUSH_ONLY', reason);
  }

  markFatal(reason: string): void {
    this.transition('FATAL', reason);
  }

  markDraining(): void {
    this.transition('DRAINING', null);
  }

  private transition(to: EngineState, reason: string | null): void {
    // FATAL is terminal. Swallowing a later transition is safer than letting a
    // background worker paper over a corrupt database by marking it READY.
    if (this._state === 'FATAL' && to !== 'DRAINING') return;
    if (this._state === to && this._reason === reason) return;

    const change: StateChange = {
      from: this._state,
      to,
      reason,
      at: new Date().toISOString(),
    };

    this._state = to;
    this._reason = reason;

    for (const l of this.listeners) {
      try {
        l(change);
      } catch {
        // A misbehaving listener must not prevent the state from changing, and
        // must not prevent the other listeners from being told.
      }
    }
  }

  onChange(listener: (c: StateChange) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  // -------------------------------------------------------------------------
  // Permission
  // -------------------------------------------------------------------------

  /**
   * Whether an operation may run in the current state.
   *
   * Read/write classification comes from the route's HTTP method, which the
   * generator already knows, rather than from a name prefix. GET is a read;
   * everything else is a write.
   */
  isOperationAllowed(operationId: string): boolean {
    if (ALWAYS_ALLOWED.has(operationId)) return true;

    switch (this._state) {
      case 'READY':
      case 'DEGRADED':
      case 'PUSH_ONLY':
        return true;

      case 'LOCKED':
      case 'FATAL':
      case 'HYDRATING':
        return false;

      case 'DRAINING':
        // Shutting down: let in-flight reads finish, refuse new writes so the
        // outbox does not grow while we are trying to drain it.
        return routeFor(operationId)?.method === 'GET';

      default:
        return false;
    }
  }

  /**
   * The error code to return when `isOperationAllowed` says no. HYDRATING gets
   * its own code because it is transient and the renderer should retry, whereas
   * LOCKED needs the user to do something.
   */
  denialCode(): 'E_LOCKED' | 'E_HYDRATING' {
    return this._state === 'HYDRATING' ? 'E_HYDRATING' : 'E_LOCKED';
  }

  describe(): string {
    return this._reason ? `Engine: ${this._state} (${this._reason})` : `Engine: ${this._state}`;
  }
}
