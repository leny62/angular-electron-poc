/**
 * TransportRouter — decides which data path a request takes.
 *
 * This is the seam where Angular components stop caring about online
 * vs offline.  The router inspects network state and platform context
 * (Electron vs browser), then routes the call to either:
 *   - HttpApiService (online path — direct to server)
 *   - LocalBridgeService (offline path — through the IPC bridge)
 *
 * Components inject this service and call the same method regardless
 * of connectivity.  They never branch on `navigator.onLine`.
 *
 * Routing logic:
 *   - Electron + offline → LocalBridgeService (always available)
 *   - Electron + online  → HttpApiService (real-time server sync)
 *   - Browser + online   → HttpApiService (server-only, no local DB)
 *   - Browser + offline  → LocalBridgeService (if available; errors if not)
 *
 * Preference: when the local bridge IS available, we prefer it even
 * when online, because it offers offline resilience.  The sync worker
 * pushes local writes to the server in the background.  Set
 * `preferOnline: true` to reverse this (useful for read-heavy UIs
 * that need real-time data).
 *
 * SOLID: Single Responsibility — this service is only about routing
 * decisions.  It delegates actual work to HttpApiService or
 * LocalBridgeService.
 *
 * @see docs/Bizuri-Secure-IPC-Offline-Design.docx  Section 4.2, Figure 2
 */

import { Injectable, NgZone, OnDestroy } from '@angular/core';
import { Observable, from, of } from 'rxjs';
import type { CommandName, CommandResult } from '../interfaces/local-bridge.interface';
import { LocalBridgeService } from './local-bridge.service';
import { HttpApiService } from './http-api.service';

export type TransportMode = 'online' | 'offline' | 'hybrid';

@Injectable({ providedIn: 'root' })
export class TransportRouter implements OnDestroy {
  private online = typeof navigator !== 'undefined' ? navigator.onLine : true;
  private cleanupFns: Array<() => void> = [];

  constructor(
    private readonly bridge: LocalBridgeService,
    private readonly httpApi: HttpApiService,
    private readonly zone: NgZone,
  ) {
    this.listenToNetwork();
  }

  // -------------------------------------------------------------------
  // Configuration
  // -------------------------------------------------------------------

  /**
   * When true (and the local bridge is available), the router prefers
   * the HTTP path when online.  Defaults to false — local-first for
   * offline resilience.
   */
  preferOnline = false;

  /**
   * Configure the HTTP API base URL.  Call once during app startup.
   */
  configureHttpApi(baseUrl: string, timeoutMs?: number): void {
    this.httpApi.configure({ baseUrl, timeoutMs });
  }

  // -------------------------------------------------------------------
  // State
  // -------------------------------------------------------------------

  /** True when the browser/device reports network connectivity. */
  get isOnline(): boolean {
    return this.online;
  }

  /** Current transport mode based on connectivity and bridge availability. */
  get mode(): TransportMode {
    if (this.online && this.bridge.isAvailable) {
      return 'hybrid';
    }
    return this.online ? 'online' : 'offline';
  }

  /**
   * The active transport path for the next command.
   *   - 'bridge' — LocalBridgeService (Electron IPC)
   *   - 'http'   — HttpApiService (HTTP to server)
   */
  get activePath(): 'bridge' | 'http' {
    // When the bridge is available, prefer it (offline-first).
    if (this.bridge.isAvailable) {
      return this.preferOnline && this.online ? 'http' : 'bridge';
    }
    // No bridge — must use HTTP.
    return this.online ? 'http' : 'bridge'; // bridge will error gracefully
  }

  /** True when the transport is ready to accept commands. */
  get isReady(): boolean {
    if (this.activePath === 'bridge') {
      return this.bridge.isAvailable;
    }
    return this.online && this.httpApi.isConfigured;
  }

  // -------------------------------------------------------------------
  // Command execution
  // -------------------------------------------------------------------

  /**
   * Execute a command through the appropriate transport.
   *
   * The caller receives a CommandResult regardless of which transport
   * was used — success and error shapes are identical across paths.
   */
  execute<T = unknown>(
    name: CommandName,
    payload?: unknown,
  ): Observable<CommandResult<T>> {
    if (this.activePath === 'http') {
      return this.httpApi.execute<T>(name, payload);
    }
    return this.bridge.invoke<T>(name, payload);
  }

  // -------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------

  ngOnDestroy(): void {
    for (const fn of this.cleanupFns) {
      fn();
    }
    this.cleanupFns = [];
  }

  // -------------------------------------------------------------------
  // Network detection
  // -------------------------------------------------------------------

  private listenToNetwork(): void {
    this.zone.runOutsideAngular(() => {
      const onOnline = (): void => {
        this.online = true;
        this.zone.run(() => { /* trigger change detection if needed */ });
      };

      const onOffline = (): void => {
        this.online = false;
        this.zone.run(() => { /* trigger change detection if needed */ });
      };

      window.addEventListener('online', onOnline);
      window.addEventListener('offline', onOffline);

      this.cleanupFns.push(() => {
        window.removeEventListener('online', onOnline);
        window.removeEventListener('offline', onOffline);
      });
    });
  }
}
