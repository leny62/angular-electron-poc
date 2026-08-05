/**
 * Renderer-side logger.
 *
 * Same shape as the engine's logger, on purpose: a feature author writes
 * `log.info(...)` and does not have to know which side of the bridge they are
 * on. Entries are batched and shipped to the engine, which writes them to the
 * same `system_logs` table under the same sequence and the same retention.
 *
 * One table rather than two is the whole point. During an incident the question
 * is "what did the UI do, and what did the engine do about it", and answering
 * it from two stores with two clocks is how an afternoon disappears. A shared
 * `requestId` makes a click and the SQL it caused one query apart.
 *
 * Delivery is best-effort. Losing a diagnostic is acceptable; blocking a
 * cashier on one is not.
 */

import { DestroyRef, Injectable, NgZone, inject } from '@angular/core';
import { LOG_LEVEL_RANK, type LogComponent, type LogLevel } from '@bizuri/local-store/browser';
import type { LocalBridge } from './offline-http.backend';

export interface BrowserLogFields {
  readonly exception?: unknown;
  readonly userName?: string | null;
  readonly url?: string | null;
  readonly requestId?: string | null;
  readonly code?: string | number | null;
  readonly context?: Record<string, unknown>;
}

interface OutgoingEntry {
  loggedAt: string;
  level: LogLevel;
  component: LogComponent;
  logger: string;
  message: string;
  exception?: string;
  userName?: string;
  url?: string;
  requestId?: string;
  code?: string;
  thread?: string;
  context?: Record<string, unknown>;
}

export interface BrowserLogger {
  debug(message: string, fields?: BrowserLogFields): void;
  info(message: string, fields?: BrowserLogFields): void;
  warn(message: string, fields?: BrowserLogFields): void;
  error(message: string, exception?: unknown, fields?: BrowserLogFields): void;
}

/** Matches the engine's gate-4 cap, so a batch is never rejected wholesale. */
const MAX_BATCH = 100;
const FLUSH_INTERVAL_MS = 3_000;
/** Bound on what an offline or wedged bridge can accumulate. */
const QUEUE_LIMIT = 500;

@Injectable({ providedIn: 'root' })
export class LoggingService {
  private readonly zone = inject(NgZone);
  private readonly bridge: LocalBridge | undefined = window.bizuriLocal;

  private queue: OutgoingEntry[] = [];
  private timer: ReturnType<typeof setInterval> | null = null;
  private shipping = false;

  /** Attached to every entry once known, so entries carry who did the thing. */
  private userName: string | null = null;

  private minLevel: LogLevel = 'DEBUG';

  constructor() {
    // Outside Angular's zone: a 3s timer inside it keeps change detection
    // running forever and makes zone-based tests never stabilise.
    this.zone.runOutsideAngular(() => {
      this.timer = setInterval(() => this.ship(), FLUSH_INTERVAL_MS);
    });

    this.captureGlobalErrors();

    // Best effort on the way out. `visibilitychange` fires on window close in
    // Chromium where `beforeunload` is not guaranteed to.
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden') this.ship();
    });

    inject(DestroyRef).onDestroy(() => {
      if (this.timer) clearInterval(this.timer);
      this.ship();
    });
  }

  /** Set once after sign-in. Applies to entries from that point on. */
  setUser(userName: string | null): void {
    this.userName = userName;
  }

  setMinLevel(level: LogLevel): void {
    this.minLevel = level;
  }

  /**
   * Get a logger.
   *
   * `name` is the module emitting the entry, and it lands in the viewer's
   * "Logger" column. Use the component's own file name.
   */
  getLogger(name: string, component: LogComponent = 'APPLICATION'): BrowserLogger {
    const write = (level: LogLevel, message: string, fields?: BrowserLogFields) =>
      this.record(level, component, name, message, fields);

    return {
      debug: (m, f) => write('DEBUG', m, f),
      info: (m, f) => write('INFO', m, f),
      warn: (m, f) => write('WARN', m, f),
      error: (m, e, f) => write('ERROR', m, { ...f, exception: e ?? f?.exception }),
    };
  }

  /** Push whatever is queued right now. Safe to call at any time. */
  flush(): void {
    this.ship();
  }

  // -------------------------------------------------------------------------

  private record(
    level: LogLevel,
    component: LogComponent,
    logger: string,
    message: string,
    fields?: BrowserLogFields,
  ): void {
    try {
      if (LOG_LEVEL_RANK[level] < LOG_LEVEL_RANK[this.minLevel]) return;

      const entry: OutgoingEntry = {
        loggedAt: new Date().toISOString(),
        level,
        component,
        logger,
        message: truncate(message, 4000),
        thread: 'renderer',
        ...optional('exception', formatException(fields?.exception)),
        ...optional('userName', fields?.userName ?? this.userName),
        // Defaulting to the current route means every entry answers "where was
        // the user" without a single call site passing it.
        ...optional('url', fields?.url ?? window.location.hash ?? window.location.pathname),
        ...optional('requestId', fields?.requestId),
        ...optional('code', fields?.code === undefined || fields.code === null ? null : String(fields.code)),
        ...(fields?.context ? { context: fields.context } : {}),
      };

      mirrorToConsole(entry);

      // Drop the oldest, not the newest: during a failure the recent entries
      // are the ones describing it.
      this.queue.push(entry);
      if (this.queue.length > QUEUE_LIMIT) {
        this.queue = this.queue.slice(-QUEUE_LIMIT);
      }

      // Errors do not wait for the timer. The renderer may be about to reload.
      if (level === 'ERROR' || level === 'FATAL') this.ship();
    } catch {
      // Logging must never break a component's render.
    }
  }

  private ship(): void {
    if (this.shipping || this.queue.length === 0 || !this.bridge?.available) return;

    const batch = this.queue.slice(0, MAX_BATCH);
    this.queue = this.queue.slice(batch.length);
    this.shipping = true;

    this.bridge
      .request({
        id: randomId(),
        operationId: 'writeSystemLogs',
        method: 'POST',
        pathParams: {},
        query: {},
        headers: {},
        body: { entries: batch },
        issuedAt: new Date().toISOString(),
      })
      .catch(() => {
        // The bridge refused. These entries are already on the console, and
        // re-queueing a batch the engine rejected would retry it forever.
      })
      .finally(() => {
        this.shipping = false;
      });
  }

  /**
   * Catch what no component catches.
   *
   * An unhandled rejection in a renderer is invisible in production: there is no
   * terminal to watch. These two handlers are the difference between "a user
   * says the button did nothing" and a row with a stack trace.
   */
  private captureGlobalErrors(): void {
    const log = this.getLogger('window');

    window.addEventListener('error', (event: ErrorEvent) => {
      log.error(event.message || 'Uncaught error', event.error, {
        code: 'UNCAUGHT',
        context: { file: event.filename, line: event.lineno, column: event.colno },
      });
    });

    window.addEventListener('unhandledrejection', (event: PromiseRejectionEvent) => {
      log.error('Unhandled promise rejection', event.reason, { code: 'UNHANDLED_REJECTION' });
    });
  }
}

// ---------------------------------------------------------------------------

function optional<K extends string>(key: K, value: string | null | undefined) {
  return value ? ({ [key]: value } as Record<K, string>) : ({} as Record<K, never>);
}

function truncate(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max - 1)}…`;
}

function formatException(err: unknown): string | null {
  if (err === undefined || err === null) return null;
  if (err instanceof Error) {
    return truncate(`${err.name}: ${err.message}${err.stack ? `\n${err.stack}` : ''}`, 8000);
  }
  if (typeof err === 'string') return truncate(err, 8000);
  try {
    return truncate(JSON.stringify(err), 8000);
  } catch {
    return truncate(String(err), 8000);
  }
}

function randomId(): string {
  return globalThis.crypto?.randomUUID?.() ?? `log-${Date.now()}-${Math.random()}`;
}

const CONSOLE_METHOD: Readonly<Record<LogLevel, 'debug' | 'log' | 'warn' | 'error'>> = {
  DEBUG: 'debug',
  INFO: 'log',
  WARN: 'warn',
  ERROR: 'error',
  FATAL: 'error',
};

function mirrorToConsole(e: OutgoingEntry): void {
  const line = `[${e.level}] ${e.logger} ${e.message}`;
  const method = CONSOLE_METHOD[e.level];
  if (e.exception) console[method](line, '\n', e.exception);
  else console[method](line);
}
