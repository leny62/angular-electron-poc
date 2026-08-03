/**
 * TransportRouter — decides which data path a request takes.
 *
 * This is the seam where Angular components stop caring about online
 * vs offline.  The router inspects network state and platform tier,
 * then routes the call to either:
 *   - HttpClient (online path — direct to server)
 *   - LocalBridgeService (offline path — through the IPC bridge)
 *
 * Components inject this service and call the same method regardless
 * of connectivity.  They never branch on `navigator.onLine`.
 *
 * Phase 1: always routes to the local bridge (no HTTP integration).
 * Phase 2: adds online detection and HTTP fallback.
 *
 * SOLID: Single Responsibility — this service is only about routing
 * decisions.  It delegates actual work to HttpClient or LocalBridgeService.
 *
 * @see docs/Bizuri-Secure-IPC-Offline-Design.docx  Section 4.2, Figure 2
 */

import { Injectable } from '@angular/core';
import { Observable, of } from 'rxjs';
import type { CommandName, CommandResult } from '../interfaces/local-bridge.interface';
import { LocalBridgeService } from './local-bridge.service';

export type TransportMode = 'online' | 'offline';

@Injectable({ providedIn: 'root' })
export class TransportRouter {
  constructor(private readonly bridge: LocalBridgeService) {}

  /** Current transport mode.  Phase 1: always offline (local bridge). */
  get mode(): TransportMode {
    return this.bridge.isAvailable ? 'offline' : 'online';
  }

  /**
   * Execute a command through the appropriate transport.
   *
   * In Phase 1 this always goes through the local bridge.
   * In Phase 2, when `mode === 'online'`, it would go through
   * HttpClient instead, using the same api-client request types.
   */
  execute<T = unknown>(
    name: CommandName,
    payload?: unknown,
  ): Observable<CommandResult<T>> {
    // Phase 1: always local.
    // Phase 2: inspect this.mode and route accordingly.
    return this.bridge.invoke<T>(name, payload);
  }

  /**
   * True when the transport is ready to accept commands.
   * In Phase 1 this means the bridge is available.
   * In Phase 2 it also means the network is up when online.
   */
  get isReady(): boolean {
    return this.bridge.isAvailable;
  }
}
