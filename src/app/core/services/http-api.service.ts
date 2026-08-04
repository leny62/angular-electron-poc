/**
 * HttpApiService — online transport path.
 *
 * Mirrors the LocalBridgeService interface but routes commands over
 * HTTP to the Bizuri backend API.  Used by TransportRouter when the
 * app has network connectivity.
 *
 * Responsibilities:
 *   - Map CommandName → HTTP endpoint
 *   - Serialise the command envelope to the server's wire format
 *   - Return CommandResult<T> in the same shape as the local bridge
 *
 * Components never inject this directly — they use TransportRouter,
 * which selects the transport based on connectivity.
 *
 * SOLID: Single Responsibility — this service is only about HTTP
 * transport.  It does not decide when to use HTTP (that's
 * TransportRouter) and it does not know about business entities.
 */

import { Injectable } from '@angular/core';
import { HttpClient, HttpErrorResponse } from '@angular/common/http';
import { Observable, of, throwError } from 'rxjs';
import { catchError, map, timeout } from 'rxjs/operators';
import type { CommandName, CommandResult, CommandErr } from '../interfaces/local-bridge.interface';

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

export interface HttpApiConfig {
  /** Base URL of the Bizuri API (no trailing slash). */
  readonly baseUrl: string;
  /** Request timeout in milliseconds. */
  readonly timeoutMs: number;
}

const DEFAULT_CONFIG: HttpApiConfig = {
  baseUrl: 'http://localhost:8080/api',
  timeoutMs: 15_000,
};

// ---------------------------------------------------------------------------
// Endpoint mapping
// ---------------------------------------------------------------------------

/**
 * Maps command names to HTTP endpoints.
 * Commands not in this map are routed to POST /command/:name as a fallback.
 */
const ENDPOINT_MAP: Partial<Record<CommandName, { method: string; path: string }>> = {
  'session.unlock': { method: 'POST', path: '/session/unlock' },
  'session.state': { method: 'GET', path: '/session/state' },
  'catalog.search': { method: 'GET', path: '/catalog' },
  'stock.balance': { method: 'GET', path: '/stock/balance' },
  'stock.adjust': { method: 'POST', path: '/stock/adjust' },
  'customer.create': { method: 'POST', path: '/customers' },
  'customer.search': { method: 'GET', path: '/customers' },
  'sale.create': { method: 'POST', path: '/sales' },
  'sale.get': { method: 'GET', path: '/sales' },
  'sale.list': { method: 'GET', path: '/sales' },
  'sync.now': { method: 'POST', path: '/sync/trigger' },
  'sync.conflicts': { method: 'GET', path: '/sync/conflicts' },
  'sync.resolve': { method: 'POST', path: '/sync/resolve' },
};

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

@Injectable({ providedIn: 'root' })
export class HttpApiService {
  private readonly config: HttpApiConfig;

  constructor(private readonly http: HttpClient) {
    this.config = { ...DEFAULT_CONFIG };
  }

  /**
   * Configure the base URL at runtime (called once during app startup).
   */
  configure(overrides: Partial<HttpApiConfig>): void {
    Object.assign(this.config, overrides);
  }

  /**
   * True when the service has been configured with a reachable base URL.
   */
  get isConfigured(): boolean {
    return this.config.baseUrl.length > 0;
  }

  /**
   * Execute a command against the remote API.
   *
   * Returns an Observable that emits exactly one CommandResult and
   * completes.  HTTP errors are converted to CommandErr so the caller
   * never deals with raw HTTP responses.
   */
  execute<T = unknown>(
    name: CommandName,
    payload: unknown = null,
  ): Observable<CommandResult<T>> {
    const endpoint = ENDPOINT_MAP[name];
    const method = endpoint?.method ?? 'POST';
    const path = endpoint?.path ?? `/command/${name}`;

    const url = `${this.config.baseUrl}${path}`;
    const body = method === 'GET' ? undefined : { name, payload };
    const params = method === 'GET' ? this.payloadToParams(payload) : undefined;

    const request$ =
      method === 'GET'
        ? this.http.get<T>(url, { params })
        : method === 'PUT'
          ? this.http.put<T>(url, body)
          : this.http.post<T>(url, body);

    return request$.pipe(
      timeout({
        each: this.config.timeoutMs,
        with: () =>
          throwError(
            (): CommandErr => ({
              v: 1,
              id: 'http-timeout',
              ok: false,
              code: 'E_INTERNAL',
              message: `HTTP request to ${url} timed out after ${this.config.timeoutMs}ms.`,
              retryable: true,
            }),
          ),
      }),
      map(
        (data): CommandResult<T> => ({
          v: 1,
          id: this.generateId(),
          ok: true,
          data: data as T,
          durableAt: new Date().toISOString(),
        }),
      ),
      catchError((err) => {
        if (err && typeof err === 'object' && 'ok' in err && (err as CommandErr).ok === false) {
          // Already a CommandErr (from timeout) — pass through.
          return of(err as CommandErr);
        }

        const message =
          err instanceof HttpErrorResponse
            ? `HTTP ${err.status}: ${err.statusText || 'Unknown error'}`
            : err instanceof Error
              ? err.message
              : String(err);

        const isRetryable =
          err instanceof HttpErrorResponse
            ? err.status >= 500 || err.status === 0 || err.status === 429
            : false;

        return of<CommandErr>({
          v: 1,
          id: 'http-error',
          ok: false,
          code: 'E_INTERNAL',
          message,
          retryable: isRetryable,
        });
      }),
    );
  }

  // -------------------------------------------------------------------
  // Helpers
  // -------------------------------------------------------------------

  /**
   * Convert a payload object to HTTP query params for GET requests.
   */
  private payloadToParams(
    payload: unknown,
  ): Record<string, string> | undefined {
    if (!payload || typeof payload !== 'object') return undefined;

    const params: Record<string, string> = {};
    const obj = payload as Record<string, unknown>;

    for (const [key, value] of Object.entries(obj)) {
      if (value !== undefined && value !== null && value !== '') {
        params[key] = String(value);
      }
    }

    return Object.keys(params).length > 0 ? params : undefined;
  }

  private generateId(): string {
    const now = Date.now().toString(36);
    const rand = Math.random().toString(36).slice(2, 8);
    return `http-${now}-${rand}`;
  }
}
