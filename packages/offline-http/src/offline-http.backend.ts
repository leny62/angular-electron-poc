/**
 * HttpBackend that serves offline-capable operations from the local engine.
 *
 * Sits below Angular's interceptor chain, so existing interceptors still run and
 * feature code keeps calling the generated API client unchanged.
 */

import { Injectable, inject } from '@angular/core';
import {
  HttpBackend,
  HttpErrorResponse,
  HttpEvent,
  HttpHeaders,
  HttpRequest,
  HttpResponse,
  HttpXhrBackend,
} from '@angular/common/http';
import { Observable, from, switchMap, throwError } from 'rxjs';
import { compileRoutes, type CompiledRoute } from '@bizuri/local-store/browser';
import { LocalEngineService } from './local-engine.service';

export interface LocalBridge {
  readonly available: true;
  readonly envelopeVersion: number;
  readonly contractVersion: string;
  request(req: Record<string, unknown>): Promise<LocalResponse>;
  subscribe(topic: string, handler: (event: unknown) => void): () => void;
}

export interface LocalResponse {
  readonly ok: boolean;
  readonly id: string;
  readonly status: number;
  readonly data?: unknown;
  readonly code?: string;
  readonly message?: string;
  readonly retryable?: boolean;
  readonly details?: Record<string, unknown>;
}

declare global {
  interface Window {
    bizuriLocal?: LocalBridge;
  }
}

/** Headers the engine needs. Authorization is deliberately not forwarded. */
const FORWARDED_HEADERS = ['X-Tenant-Id', 'X-Branch-Id', 'Idempotency-Key'] as const;

@Injectable()
export class OfflineHttpBackend implements HttpBackend {
  private readonly network = inject(HttpXhrBackend);
  private readonly engine = inject(LocalEngineService);
  private readonly routes: readonly CompiledRoute[] = compileRoutes();

  handle(req: HttpRequest<unknown>): Observable<HttpEvent<unknown>> {
    const bridge = window.bizuriLocal;
    if (!bridge?.available) return this.network.handle(req);

    const match = this.match(req);
    if (!match) return this.network.handle(req);

    // The engine is running but hasn't signed in yet. Falling through to the
    // network in dev hits the Angular dev server, which returns index.html and
    // produces a confusing "Request failed (200)" parse error. Return a clear
    // message instead so the developer knows exactly what's missing.
    if (!this.engine.status().tenantId) {
      return throwError(
        () =>
          new HttpErrorResponse({
            error: {
              message:
                'Engine has no tenant session. Start with BIZURI_EMAIL, ' +
                'BIZURI_PASSWORD, and BIZURI_SLUG, or run: npm run dev:offline',
            },
            status: 503,
            statusText: 'No session',
            url: req.urlWithParams,
          }),
      );
    }

    return from(bridge.request(this.toEnvelope(req, match))).pipe(
      switchMap((response) => this.toHttpEvent(req, response)),
    );
  }

  private match(
    req: HttpRequest<unknown>,
  ): { operationId: string; pathParams: Record<string, string> } | null {
    let path: string;
    try {
      // Relative urls are common once a base-href interceptor has run.
      path = new URL(req.url, window.location.origin).pathname;
    } catch {
      return null;
    }

    for (const compiled of this.routes) {
      if (compiled.route.method !== req.method) continue;
      const m = compiled.regex.exec(path);
      if (!m) continue;

      const pathParams: Record<string, string> = {};
      compiled.paramNames.forEach((name, i) => {
        pathParams[name] = decodeURIComponent(m[i + 1] ?? '');
      });
      return { operationId: compiled.route.operationId, pathParams };
    }
    return null;
  }

  private toEnvelope(
    req: HttpRequest<unknown>,
    match: { operationId: string; pathParams: Record<string, string> },
  ): Record<string, unknown> {
    const query: Record<string, string | string[]> = {};
    for (const key of req.params.keys()) {
      const values = req.params.getAll(key) ?? [];
      const value = values.length > 1 ? values : values[0];
      if (value !== undefined) query[key] = value;
    }

    const headers: Record<string, string> = {};

    // Headers the caller explicitly set take precedence, so feature code can
    // override the engine's defaults for a specific request.
    for (const name of FORWARDED_HEADERS) {
      const value = req.headers.get(name);
      if (value) headers[name] = value;
    }

    // Populate tenant/branch from the engine session when the caller didn't set
    // them. These are required by every business-operation schema, and the caller
    // should not have to thread them through every component manually.
    const status = this.engine.status();
    if (!headers['X-Tenant-Id'] && status.tenantId) {
      headers['X-Tenant-Id'] = status.tenantId;
    }
    if (!headers['X-Branch-Id'] && status.branchId) {
      headers['X-Branch-Id'] = status.branchId;
    }

    return {
      id: cryptoRandomId(),
      operationId: match.operationId,
      method: req.method,
      pathParams: match.pathParams,
      query,
      headers,
      ...(req.body !== null && req.body !== undefined ? { body: req.body } : {}),
      issuedAt: new Date().toISOString(),
    };
  }

  private toHttpEvent(
    req: HttpRequest<unknown>,
    response: LocalResponse,
  ): Observable<HttpEvent<unknown>> {
    if (response.ok) {
      return new Observable<HttpEvent<unknown>>((subscriber) => {
        subscriber.next(
          new HttpResponse({
            body: response.data,
            status: response.status,
            statusText: 'OK',
            url: req.urlWithParams,
            headers: new HttpHeaders({ 'X-Bizuri-Source': 'local' }),
          }),
        );
        subscriber.complete();
      });
    }

    // Shaped like a server error so an existing error interceptor handles it
    // through the same path.
    return throwError(
      () =>
        new HttpErrorResponse({
          error: {
            success: false,
            message: response.message,
            errorCode: response.code,
            statusCode: response.status,
            retryable: response.retryable,
            ...response.details,
          },
          status: response.status,
          statusText: response.code ?? 'Error',
          url: req.urlWithParams,
        }),
    );
  }
}

function cryptoRandomId(): string {
  return globalThis.crypto?.randomUUID?.() ?? `req-${Date.now()}-${Math.random()}`;
}
