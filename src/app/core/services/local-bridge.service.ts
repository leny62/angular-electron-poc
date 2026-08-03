/**
 * LocalBridgeService — Angular wrapper around the Electron IPC bridge.
 *
 * Responsibilities:
 *   - Detect whether the bridge is available (Electron vs browser).
 *   - Turn the promise-based invoke() into RxJS observables.
 *   - Add a configurable timeout to every command.
 *   - Expose engine state and connection status as streams.
 *
 * Components and feature services never touch window.bizuriLocal
 * directly.  They inject this service instead.
 *
 * SOLID: Single Responsibility — this service is only about wrapping
 * the bridge.  It does NOT decide which transport to use (that's
 * TransportRouter) and it does NOT know about business entities.
 */

import { Injectable, NgZone } from '@angular/core';
import { Observable, from, of, throwError, timer } from 'rxjs';
import { catchError, map, timeout, switchMap } from 'rxjs/operators';
import type {
  CommandName,
  CommandResult,
  CommandOk,
  CommandErr,
  BizuriLocalBridge,
  BridgeEvent,
  EventTopic,
  EngineState,
} from '../interfaces/local-bridge.interface';

const DEFAULT_TIMEOUT_MS = 10_000; // 10 seconds — generous for local IPC

@Injectable({ providedIn: 'root' })
export class LocalBridgeService {
  private readonly bridge: BizuriLocalBridge | null;

  constructor(private readonly zone: NgZone) {
    this.bridge = window.bizuriLocal ?? null;
  }

  // -----------------------------------------------------------------------
  // Capability checks
  // -----------------------------------------------------------------------

  /** True when running inside Electron with the bridge available. */
  get isAvailable(): boolean {
    return this.bridge?.available === true;
  }

  /** The contract version the main process is running. */
  get contractVersion(): number | null {
    return this.bridge?.contractVersion ?? null;
  }

  // -----------------------------------------------------------------------
  // Command invocation
  // -----------------------------------------------------------------------

  /**
   * Send a command to the main process and receive a typed result.
   *
   * Returns an Observable that emits exactly one value (success or
   * failure) and then completes.  Never throws — errors are returned
   * as CommandErr values on the stream.
   *
   * The timeout protects against a hung main process.  If the handler
   * does not respond within `timeoutMs`, the command is cancelled and
   * an E_INTERNAL error is emitted.
   */
  invoke<T = unknown>(
    name: CommandName,
    payload: unknown = null,
    timeoutMs: number = DEFAULT_TIMEOUT_MS,
  ): Observable<CommandResult<T>> {
    if (!this.bridge) {
      return of<CommandErr>({
        v: 1,
        id: 'local',
        ok: false,
        code: 'E_INTERNAL',
        message: 'Bridge not available — not running inside Electron.',
        retryable: false,
      });
    }

    // Run the IPC call outside Angular's zone so it doesn't trigger
    // unnecessary change detection.  We re-enter the zone on response.
    const promise = this.zone.runOutsideAngular(() => this.bridge!.invoke<T>(name, payload));

    return from(promise).pipe(
      timeout({
        each: timeoutMs,
        with: () =>
          throwError(
            (): CommandErr => ({
              v: 1,
              id: 'timeout',
              ok: false,
              code: 'E_INTERNAL',
              message: `Command "${name}" timed out after ${timeoutMs}ms.`,
              retryable: true,
            }),
          ),
      }),
      catchError((err) => {
        // If the bridge itself throws (should never happen), wrap it.
        const message = err instanceof Error ? err.message : String(err);
        return of<CommandErr>({
          v: 1,
          id: 'error',
          ok: false,
          code: 'E_INTERNAL',
          message,
          retryable: false,
        });
      }),
      // Re-enter Angular's zone so change detection picks up the result.
      map((result) => this.zone.run(() => result)),
    );
  }

  // -----------------------------------------------------------------------
  // Event subscription
  // -----------------------------------------------------------------------

  /**
   * Subscribe to an event topic from the main process.
   *
   * Returns an Observable that emits whenever the main process sends
   * an event on the given topic.  The subscription is automatically
   * cleaned up when the Observable is unsubscribed.
   */
  subscribe<T = unknown>(topic: EventTopic): Observable<BridgeEvent<T>> {
    if (!this.bridge) {
      return of();
    }

    return new Observable<BridgeEvent<T>>((observer) => {
      const unsubscribe = this.zone.runOutsideAngular(() =>
        this.bridge!.subscribe(topic, (event: BridgeEvent) => {
          this.zone.run(() => observer.next(event as BridgeEvent<T>));
        }),
      );

      return () => {
        unsubscribe();
      };
    });
  }

  // -----------------------------------------------------------------------
  // Convenience: engine state
  // -----------------------------------------------------------------------

  /**
   * Query the current engine state.
   * Always allowed, even when the engine is LOCKED or FATAL.
   */
  getEngineState(): Observable<CommandResult<{ engineState: EngineState }>> {
    return this.invoke<{ engineState: EngineState }>('session.state');
  }

  /**
   * Attempt to unlock the vault with a passphrase.
   * On success the engine transitions to READY.
   */
  unlock(passphrase: string): Observable<CommandResult<{ engineState: EngineState }>> {
    return this.invoke<{ engineState: EngineState }>('session.unlock', { passphrase });
  }
}
