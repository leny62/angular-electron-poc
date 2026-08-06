/**
 * Remote client for the real Bizuri API.
 *
 * ─── Why this exists, and why it needs no new backend endpoints ──────────────
 * The plan (§5–§7) specifies four new `/core/sync/*` endpoints. Those are
 * optimisations: a snapshot bundle instead of paging, cursor deltas instead of
 * full refresh, batched push instead of per-sale POSTs. None of them is a
 * prerequisite, because the existing contract already supports the whole Wave 1
 * loop:
 *
 *   hydrate   GET /core/sales/catalog, /core/stock-balances,
 *             /core/customers, /core/tax-categories        (paged, exists today)
 *   push      POST /core/sales with Idempotency-Key        (exists today)
 *   auth      POST /identity/auth/login                    (exists today)
 *
 * `POST /core/sales` already accepts `Idempotency-Key` and `deviceId`, so offline
 * sale replay was designed for. That means the POC can drive the real API end to
 * end now, and the sync endpoints become a measured optimisation rather than a
 * speculative one. This is the paged-REST fallback path from §5.1, promoted to
 * the primary path until the snapshot endpoint exists.
 *
 * No Angular, no rxjs: this runs in the Electron main process and uses global
 * fetch, which Electron's bundled Node provides.
 */

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

export interface RemoteConfig {
  /**
   * API base URL, no trailing slash.
   *
   * Set via `BIZURI_API`; there is no default so deployment targets are never
   * committed to the repo.
   */
  readonly baseUrl: string;
  readonly timeoutMs?: number;
  readonly maxRetries?: number;
  /** Injectable for tests. Defaults to global fetch. */
  readonly fetchImpl?: typeof fetch;
}

export interface Credentials {
  readonly email: string;
  readonly password: string;
  /** Tenant subdomain slug. Required by LoginRequest. */
  readonly subdomainSlug: string;
}

export interface Session {
  readonly accessToken: string;
  readonly refreshToken: string;
  readonly tenantId: string;
  readonly branchId: string;
  readonly userId?: string;
  readonly displayName?: string;
  /** Absolute epoch ms when the access token expires. */
  readonly expiresAt: number;
  readonly mfaRequired: boolean;
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export class RemoteError extends Error {
  constructor(
    readonly status: number,
    message: string,
    /** Server's machine-readable code from ErrorResponse, when present. */
    readonly errorCode?: string,
    readonly retryable = false,
    readonly body?: unknown,
  ) {
    super(message);
    this.name = 'RemoteError';
  }
}

export class MfaRequiredError extends Error {
  constructor(readonly challenge: unknown) {
    super('Multi-factor authentication is required for this account.');
    this.name = 'MfaRequiredError';
  }
}

/** Network-level failure: no response at all. Always retryable, and it is also how we detect "offline". */
export class OfflineError extends Error {
  constructor(cause: string) {
    super(`Network unreachable: ${cause}`);
    this.name = 'OfflineError';
  }
}

// ---------------------------------------------------------------------------
// Envelope handling
// ---------------------------------------------------------------------------

/**
 * The core API uses two different response envelopes, so the client has to cope
 * with both:
 *
 *   SuccessResponse wrapper  { success, message, data, meta }
 *                            customers, tax-categories, sales, receipts
 *
 *   Bare page object         { data, page, size, totalElements, totalPages,
 *                              hasNext, hasPrevious }
 *                            sales/catalog, stock-balances
 *
 * That inconsistency is in the published contract, not something introduced
 * here. Normalising it in one place keeps it out of the hydration code.
 */
export interface Page<T> {
  readonly items: readonly T[];
  readonly page: number;
  readonly size: number;
  readonly totalElements: number;
  readonly totalPages: number;
  readonly hasNext: boolean;
}

interface BarePage {
  data?: unknown;
  page?: number;
  size?: number;
  totalElements?: number;
  totalPages?: number;
  hasNext?: boolean;
}

interface WrappedPage {
  success?: boolean;
  message?: string;
  data?: unknown;
  meta?: {
    page?: number;
    size?: number;
    totalElements?: number;
    totalPages?: number;
    hasNext?: boolean;
    currentPage?: number;
    pageSize?: number;
  };
}

export function normalisePage<T>(body: unknown, requestedSize: number): Page<T> {
  const b = (body ?? {}) as BarePage & WrappedPage;
  const items = (Array.isArray(b.data) ? b.data : []) as readonly T[];

  // Bare page shape carries pagination at the top level.
  if (typeof b.totalElements === 'number' && b.meta === undefined) {
    return {
      items,
      page: b.page ?? 0,
      size: b.size ?? requestedSize,
      totalElements: b.totalElements,
      totalPages: b.totalPages ?? 1,
      hasNext: b.hasNext ?? false,
    };
  }

  // Wrapped shape carries it under `meta`, with field names that vary.
  const meta = b.meta ?? {};
  const page = meta.page ?? meta.currentPage ?? 0;
  const size = meta.size ?? meta.pageSize ?? requestedSize;
  const totalElements = meta.totalElements ?? items.length;
  const totalPages = meta.totalPages ?? (size > 0 ? Math.ceil(totalElements / size) : 1);

  return {
    items,
    page,
    size,
    totalElements,
    totalPages,
    // Derived rather than trusted: `hasNext` is absent from PaginationMeta on
    // some endpoints, and a wrong `false` silently truncates hydration.
    hasNext: meta.hasNext ?? page + 1 < totalPages,
  };
}

/** Unwrap a single-resource response from either envelope. */
export function unwrapData<T>(body: unknown): T {
  const b = (body ?? {}) as { data?: unknown };
  return (b.data !== undefined ? b.data : body) as T;
}

// ---------------------------------------------------------------------------
// Client
// ---------------------------------------------------------------------------

export interface RequestOptions {
  readonly method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  readonly query?: Record<string, string | number | boolean | undefined>;
  readonly body?: unknown;
  readonly idempotencyKey?: string;
  /** Overrides the session's branch, for a device pinned to a specific branch. */
  readonly branchId?: string;
  /** Skip retries. Used by the connectivity probe so it fails fast. */
  readonly noRetry?: boolean;
}

export class RemoteClient {
  private session: Session | null = null;
  private credentials: Credentials | null = null;
  /** In-flight refresh, so a burst of 401s triggers one refresh, not twenty. */
  private refreshInFlight: Promise<void> | null = null;

  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly maxRetries: number;
  private readonly doFetch: typeof fetch;

  constructor(config: RemoteConfig) {
    this.baseUrl = config.baseUrl.replace(/\/+$/, '');
    this.timeoutMs = config.timeoutMs ?? 20_000;
    this.maxRetries = config.maxRetries ?? 3;
    this.doFetch = config.fetchImpl ?? globalThis.fetch;

    if (!this.doFetch) {
      throw new Error('No fetch implementation available. Pass fetchImpl explicitly.');
    }
  }

  // -------------------------------------------------------------------------
  // Auth
  // -------------------------------------------------------------------------

  async login(credentials: Credentials): Promise<Session> {
    const body = await this.raw('/identity/auth/login', {
      method: 'POST',
      body: credentials,
      // Login failures are not retried: a wrong password retried three times
      // just gets the account locked faster.
      noRetry: true,
    });

    const data = unwrapData<{
      accessToken?: string;
      refreshToken?: string;
      tenantId?: string;
      branchId?: string;
      userId?: string;
      displayName?: string;
      accessTokenExpiresIn?: number;
      mfaRequired?: boolean;
      mfaChallenge?: unknown;
    }>(body);

    if (data.mfaRequired) {
      // Surfaced rather than swallowed: an account with 2FA cannot be used for
      // unattended sync, and the operator needs to know that explicitly.
      throw new MfaRequiredError(data.mfaChallenge);
    }

    if (!data.accessToken || !data.tenantId) {
      throw new RemoteError(200, 'Login succeeded but returned no usable session.');
    }

    this.credentials = credentials;
    this.session = {
      accessToken: data.accessToken,
      refreshToken: data.refreshToken ?? '',
      tenantId: data.tenantId,
      branchId: data.branchId ?? '',
      ...(data.userId ? { userId: data.userId } : {}),
      ...(data.displayName ? { displayName: data.displayName } : {}),
      // Renew a minute early so a request cannot start on a token that expires
      // mid-flight.
      expiresAt: Date.now() + (data.accessTokenExpiresIn ?? 900) * 1000 - 60_000,
      mfaRequired: false,
    };

    return this.session;
  }

  get currentSession(): Session | null {
    return this.session;
  }

  /** Adopt a session obtained elsewhere, e.g. handed over by the renderer. */
  adoptSession(session: Session, credentials?: Credentials): void {
    this.session = session;
    if (credentials) this.credentials = credentials;
  }

  private async refresh(): Promise<void> {
    // Single-flight. Twenty parallel hydration requests hitting an expired token
    // must not fire twenty refreshes, because the server may rotate the refresh
    // token and all but one would then be invalid.
    if (this.refreshInFlight) return this.refreshInFlight;

    this.refreshInFlight = (async () => {
      try {
        if (this.session?.refreshToken) {
          try {
            const body = await this.raw('/identity/auth/token/refresh', {
              method: 'POST',
              body: { refreshToken: this.session.refreshToken },
              noRetry: true,
            });
            const data = unwrapData<{
              accessToken?: string;
              refreshToken?: string;
              accessTokenExpiresIn?: number;
            }>(body);

            if (data.accessToken) {
              this.session = {
                ...this.session,
                accessToken: data.accessToken,
                refreshToken: data.refreshToken ?? this.session.refreshToken,
                expiresAt: Date.now() + (data.accessTokenExpiresIn ?? 900) * 1000 - 60_000,
              };
              return;
            }
          } catch {
            // Refresh token rejected or expired. Fall through to a full login.
          }
        }

        if (!this.credentials) {
          throw new RemoteError(401, 'Session expired and no credentials are held.');
        }
        await this.login(this.credentials);
      } finally {
        this.refreshInFlight = null;
      }
    })();

    return this.refreshInFlight;
  }

  // -------------------------------------------------------------------------
  // Requests
  // -------------------------------------------------------------------------

  /** Authenticated request. Refreshes once on 401 and replays. */
  async request<T>(path: string, options: RequestOptions = {}): Promise<T> {
    if (this.session && Date.now() >= this.session.expiresAt) {
      await this.refresh();
    }

    try {
      return (await this.raw(path, options)) as T;
    } catch (err) {
      // One retry after a refresh. Not a loop: if the second attempt also 401s,
      // the credentials or the account are the problem, not the token.
      if (err instanceof RemoteError && err.status === 401) {
        await this.refresh();
        return (await this.raw(path, options)) as T;
      }
      throw err;
    }
  }

  /** Paged GET, normalised across both envelope styles. */
  async getPage<T>(
    path: string,
    options: RequestOptions & { page: number; size: number },
  ): Promise<Page<T>> {
    const body = await this.request<unknown>(path, {
      ...options,
      method: 'GET',
      query: { ...options.query, page: options.page, size: options.size },
    });
    return normalisePage<T>(body, options.size);
  }

  /**
   * Page through everything, invoking `onPage` per page.
   *
   * Bounded by `maxPages` because offset pagination over a mutating table cannot
   * be trusted to terminate: if rows are inserted while we page, `totalPages`
   * grows and a naive loop follows it forever. This is one of the concrete costs
   * of the contract's offset pagination that cursor-based sync (§7.2) removes.
   */
  async getAllPages<T>(
    path: string,
    options: RequestOptions & { size?: number; maxPages?: number } = {},
  ): Promise<{ items: T[]; pagesFetched: number; truncated: boolean }> {
    const size = options.size ?? 100;
    const maxPages = options.maxPages ?? 200;

    const items: T[] = [];
    let page = 0;
    let truncated = false;

    for (;;) {
      const result = await this.getPage<T>(path, { ...options, page, size });
      items.push(...result.items);
      page++;

      if (!result.hasNext || result.items.length === 0) break;
      if (page >= maxPages) {
        truncated = true;
        break;
      }
    }

    return { items, pagesFetched: page, truncated };
  }

  /** Is the API reachable and healthy? Used to decide online vs offline. */
  async probe(): Promise<{ online: boolean; status?: number; detail?: string }> {
    try {
      await this.raw('/actuator/health', { method: 'GET', noRetry: true });
      return { online: true, status: 200 };
    } catch (err) {
      if (err instanceof RemoteError) {
        // A 4xx means the host answered, so the network is up even if the probe
        // path is not exposed. Only 5xx and network errors mean unusable.
        return {
          online: err.status < 500,
          status: err.status,
          detail: err.message,
        };
      }
      return { online: false, detail: err instanceof Error ? err.message : String(err) };
    }
  }

  // -------------------------------------------------------------------------
  // Transport
  // -------------------------------------------------------------------------

  private async raw(path: string, options: RequestOptions): Promise<unknown> {
    const url = this.buildUrl(path, options.query);
    const maxAttempts = options.noRetry ? 1 : this.maxRetries;

    let lastError: unknown;

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      if (attempt > 0) await sleep(backoffMs(attempt));

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.timeoutMs);

      try {
        const response = await this.doFetch(url, {
          method: options.method ?? 'GET',
          headers: this.buildHeaders(options),
          ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}),
          signal: controller.signal,
        });

        const text = await response.text();
        const parsed = text ? safeJsonParse(text) : null;

        if (response.ok) return parsed;

        const error = toRemoteError(response.status, parsed, text);

        // Retry only what can plausibly succeed on a second attempt. A 400 will
        // fail identically every time and retrying it wastes a shop's bandwidth.
        if (!error.retryable || attempt === maxAttempts - 1) throw error;
        lastError = error;
      } catch (err) {
        if (err instanceof RemoteError) {
          if (!err.retryable || attempt === maxAttempts - 1) throw err;
          lastError = err;
          continue;
        }

        const offline = new OfflineError(
          err instanceof Error ? err.message : String(err),
        );
        if (attempt === maxAttempts - 1) throw offline;
        lastError = offline;
      } finally {
        clearTimeout(timer);
      }
    }

    throw lastError ?? new OfflineError('exhausted retries');
  }

  private buildUrl(
    path: string,
    query?: Record<string, string | number | boolean | undefined>,
  ): string {
    const url = new URL(this.baseUrl + (path.startsWith('/') ? path : `/${path}`));
    for (const [key, value] of Object.entries(query ?? {})) {
      if (value !== undefined && value !== '') url.searchParams.set(key, String(value));
    }
    return url.toString();
  }

  /**
   * Headers.
   *
   * `X-Tenant-Id` and `X-Branch-Id` are what the gateway injects for the real
   * frontend and what every core endpoint scopes on, so the local engine has to
   * send them too. Getting them wrong reads tenant data from the wrong schema,
   * so they are never defaulted silently.
   */
  private buildHeaders(options: RequestOptions): Record<string, string> {
    const headers: Record<string, string> = {
      Accept: 'application/json',
      'Content-Type': 'application/json',
    };

    if (this.session) {
      headers['Authorization'] = `Bearer ${this.session.accessToken}`;
      if (this.session.tenantId) headers['X-Tenant-Id'] = this.session.tenantId;

      const branch = options.branchId ?? this.session.branchId;
      if (branch) headers['X-Branch-Id'] = branch;
    }

    if (options.idempotencyKey) headers['Idempotency-Key'] = options.idempotencyKey;

    return headers;
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function safeJsonParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    // An HTML error page from a proxy, for example a Cloudflare 5xx interstitial.
    return { raw: text.slice(0, 500) };
  }
}

function toRemoteError(status: number, parsed: unknown, text: string): RemoteError {
  const body = (parsed ?? {}) as { message?: string; errorCode?: string };
  const message = body.message ?? `HTTP ${status}`;

  // 408 timeout, 429 rate limited, and 5xx are worth another attempt.
  // 409 is not: a conflict is a decision the server has already made.
  const retryable = status === 408 || status === 429 || status >= 500;

  return new RemoteError(status, message, body.errorCode, retryable, parsed ?? text);
}

/** Exponential backoff with full jitter, capped at 30s. */
export function backoffMs(attempt: number): number {
  const base = Math.min(30_000, 500 * 2 ** attempt);
  // Full jitter: without it, every device in a branch retries in lockstep after
  // an outage and the server gets a thundering herd at reconnect.
  return Math.floor(Math.random() * base);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
