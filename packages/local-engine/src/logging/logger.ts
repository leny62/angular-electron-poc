/**
 * The logger. One per process, configured once, used everywhere.
 *
 * Modelled on the arrangement Fionet gets from log4net, because that
 * arrangement is right and the reasons are worth restating:
 *
 *   - A call site names a logger and logs. It does not know where entries go,
 *     whether a database is open, or what the current severity threshold is.
 *     Adding a feature therefore adds zero logging configuration, which is the
 *     property that makes people actually log things.
 *
 *   - Writes are buffered, like `AdoNetAppender` with `bufferSize`. A sale must
 *     not pay for a synchronous INSERT into a diagnostics table.
 *
 *   - The console appender is immediate while the database appender lags. When
 *     the two disagree, the console is the one that saw the crash. This mirrors
 *     Fionet's `QueueService.log` being ahead of its `ActivityLog` rows, which
 *     is exactly the property that makes a buffered DB appender safe to use.
 *
 * Two things are deliberately different.
 *
 *   ERROR and FATAL flush immediately. log4net's buffer will happily lose the
 *   last 49 entries when the process dies, and the entries you lose are the
 *   ones describing why it died. Buffering the boring levels gets the
 *   throughput; flushing the loud ones gets the diagnosis.
 *
 *   Entries logged before the database exists are held in memory and written
 *   once it opens, rather than dropped. Startup, migration, and unlock failures
 *   all happen before there is anywhere to put them, and those are precisely
 *   the failures nobody can reproduce on request.
 */

import { AsyncLocalStorage } from 'async_hooks';
import { randomUUID } from 'crypto';
import {
  LOG_LEVEL_RANK,
  type LogComponent,
  type LogLevel,
  type LogSource,
} from '@bizuri/local-store';
import type { SqliteDatabase } from '../store/types';

// ---------------------------------------------------------------------------
// Entry
// ---------------------------------------------------------------------------

/** Fields a call site may attach. All optional; the logger fills the rest. */
export interface LogFields {
  readonly exception?: unknown;
  readonly userName?: string | null;
  readonly url?: string | null;
  readonly requestId?: string | null;
  readonly code?: string | number | null;
  readonly thread?: string | null;
  readonly tenantId?: string | null;
  readonly deviceId?: string | null;
  /** Anything else worth keeping. Serialised to JSON; never put secrets here. */
  readonly context?: Record<string, unknown>;
}

export interface LogEntry {
  readonly id: string;
  readonly loggedAt: string;
  readonly level: LogLevel;
  readonly component: LogComponent;
  readonly source: LogSource;
  readonly logger: string;
  readonly message: string;
  readonly exception: string | null;
  readonly userName: string | null;
  readonly url: string | null;
  readonly requestId: string | null;
  readonly code: string | null;
  readonly deviceId: string | null;
  readonly thread: string | null;
  readonly tenantId: string | null;
  readonly context: string | null;
}

// ---------------------------------------------------------------------------
// Ambient request context
//
// The alternative is threading a requestId through every function signature
// down to the SQL layer, which nobody sustains past the second refactor. An
// AsyncLocalStorage store survives awaits and is scoped to the one request, so
// a log line written six frames deep still correlates with the IPC call that
// caused it.
// ---------------------------------------------------------------------------

export interface AmbientContext {
  readonly requestId?: string;
  readonly userName?: string;
  readonly url?: string;
  readonly tenantId?: string;
  readonly thread?: string;
}

const ambient = new AsyncLocalStorage<AmbientContext>();

/** Run `fn` with these fields attached to every entry logged inside it. */
export function withLogContext<T>(context: AmbientContext, fn: () => T): T {
  const merged = { ...(ambient.getStore() ?? {}), ...context };
  return ambient.run(merged, fn);
}

export function currentLogContext(): AmbientContext {
  return ambient.getStore() ?? {};
}

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

export interface LoggingConfig {
  /**
   * Returns the open database, or null while locked. A getter rather than a
   * handle because the engine opens the database after the first entries have
   * already been logged.
   */
  readonly db: () => SqliteDatabase | null;
  readonly deviceId?: string;
  /** Entries below this are discarded before any work is done. */
  readonly minLevel?: LogLevel;
  /** Entries held before a write is attempted. */
  readonly bufferSize?: number;
  /** Milliseconds between periodic flushes of a partial buffer. */
  readonly flushIntervalMs?: number;
  /** Rows to keep. The oldest beyond this are pruned. */
  readonly maxRows?: number;
  /** Days to keep. Entries older than this are pruned. */
  readonly retentionDays?: number;
  /** Mirror to stdout/stderr. Off in tests to keep output readable. */
  readonly console?: boolean;
}

interface ResolvedConfig extends Required<Omit<LoggingConfig, 'db' | 'deviceId'>> {
  readonly db: () => SqliteDatabase | null;
  readonly deviceId: string | null;
}

const DEFAULTS = {
  minLevel: 'DEBUG' as LogLevel,
  bufferSize: 25,
  flushIntervalMs: 2_000,
  // ~30 MB of log at a generous 250 bytes per row, on a device whose whole
  // database is a few hundred MB. Large enough to hold a bad week, small
  // enough that it cannot be the reason a shop runs out of disk.
  maxRows: 20_000,
  retentionDays: 14,
  // Off under Jest. Operations log at INFO by design, and a suite that makes a
  // few hundred sales would bury its own failures in successful sale lines. A
  // test that cares about a log line configures the sink and asserts on rows.
  console: process.env['JEST_WORKER_ID'] === undefined,
};

/**
 * Held in memory before the sink is configured or while the database is
 * locked. Bounded: an engine that never opens its database must not grow this
 * array until the process dies.
 */
const PENDING_LIMIT = 500;

let config: ResolvedConfig | null = null;
let buffer: LogEntry[] = [];
let pending: LogEntry[] = [];
let flushTimer: ReturnType<typeof setInterval> | null = null;
let seq = 0;
let seqPrimed = false;

/**
 * Install the sink. Called once, from `createLocalEngine`.
 *
 * Everything logged before this call is kept and written on the first
 * successful flush, so the ordering of startup code does not decide which
 * failures are diagnosable.
 */
export function configureLogging(options: LoggingConfig): void {
  config = {
    db: options.db,
    deviceId: options.deviceId ?? null,
    minLevel: options.minLevel ?? DEFAULTS.minLevel,
    bufferSize: options.bufferSize ?? DEFAULTS.bufferSize,
    flushIntervalMs: options.flushIntervalMs ?? DEFAULTS.flushIntervalMs,
    maxRows: options.maxRows ?? DEFAULTS.maxRows,
    retentionDays: options.retentionDays ?? DEFAULTS.retentionDays,
    console: options.console ?? DEFAULTS.console,
  };

  if (flushTimer) clearInterval(flushTimer);
  flushTimer = setInterval(() => flush(), config.flushIntervalMs);
  // A pending flush must never be the only thing keeping Electron alive.
  flushTimer.unref?.();
}

/** Stop the timer and write whatever is buffered. Called on engine dispose. */
export function shutdownLogging(): void {
  if (flushTimer) {
    clearInterval(flushTimer);
    flushTimer = null;
  }
  flush();
}

/** Test-only: drop all state so each test starts from a known logger. */
export function resetLogging(): void {
  if (flushTimer) clearInterval(flushTimer);
  flushTimer = null;
  config = null;
  buffer = [];
  pending = [];
  seq = 0;
  seqPrimed = false;
}

// ---------------------------------------------------------------------------
// Logger handles
// ---------------------------------------------------------------------------

export interface Logger {
  debug(message: string, fields?: LogFields): void;
  info(message: string, fields?: LogFields): void;
  warn(message: string, fields?: LogFields): void;
  error(message: string, exception?: unknown, fields?: LogFields): void;
  fatal(message: string, exception?: unknown, fields?: LogFields): void;
  /** A logger with the same sink but a different name, for a sub-module. */
  child(suffix: string, component?: LogComponent): Logger;
}

/**
 * Get a logger.
 *
 * `name` is the log4net "Logger" column: the module that emitted the entry.
 * Use the file's own name, so a line in the viewer points at the code that
 * wrote it without anyone having to grep for the message text.
 */
export function getLogger(name: string, component: LogComponent = 'APPLICATION'): Logger {
  const write = (level: LogLevel, message: string, fields?: LogFields) =>
    record(level, component, name, message, fields);

  return {
    debug: (m, f) => write('DEBUG', m, f),
    info: (m, f) => write('INFO', m, f),
    warn: (m, f) => write('WARN', m, f),
    error: (m, e, f) => write('ERROR', m, { ...f, exception: e ?? f?.exception }),
    fatal: (m, e, f) => write('FATAL', m, { ...f, exception: e ?? f?.exception }),
    child: (suffix, childComponent) =>
      getLogger(`${name}.${suffix}`, childComponent ?? component),
  };
}

// ---------------------------------------------------------------------------
// Recording
// ---------------------------------------------------------------------------

function record(
  level: LogLevel,
  component: LogComponent,
  logger: string,
  message: string,
  fields?: LogFields,
): void {
  // Logging must never be the reason an operation fails. Every path below is
  // best-effort, and the outermost catch is the guarantee.
  try {
    const minLevel = config?.minLevel ?? DEFAULTS.minLevel;
    if (LOG_LEVEL_RANK[level] < LOG_LEVEL_RANK[minLevel]) return;

    const ctx = currentLogContext();

    const entry: LogEntry = {
      id: randomUUID(),
      loggedAt: new Date().toISOString(),
      level,
      component,
      source: 'SERVER',
      logger,
      message: truncate(message, 4000),
      exception: formatException(fields?.exception),
      userName: fields?.userName ?? ctx.userName ?? null,
      url: fields?.url ?? ctx.url ?? null,
      requestId: fields?.requestId ?? ctx.requestId ?? null,
      code: fields?.code === undefined || fields.code === null ? null : String(fields.code),
      deviceId: fields?.deviceId ?? config?.deviceId ?? null,
      thread: fields?.thread ?? ctx.thread ?? 'main',
      tenantId: fields?.tenantId ?? ctx.tenantId ?? null,
      context: serialiseContext(fields?.context),
    };

    if (config?.console ?? DEFAULTS.console) mirrorToConsole(entry);

    buffer.push(entry);

    // The loud levels do not wait for the buffer: a process that is about to
    // die owes the operator the reason.
    if (level === 'ERROR' || level === 'FATAL') {
      flush();
      return;
    }
    if (buffer.length >= (config?.bufferSize ?? DEFAULTS.bufferSize)) flush();
  } catch {
    // Nothing to do. Reporting a logging failure through the logger recurses.
  }
}

/** Accept entries that were produced elsewhere, e.g. shipped by the renderer. */
export function recordExternal(
  entries: readonly Omit<LogEntry, 'id'>[],
  overrides: { source: LogSource },
): number {
  let accepted = 0;
  for (const raw of entries) {
    try {
      buffer.push({ ...raw, id: randomUUID(), source: overrides.source });
      accepted++;
    } catch {
      // Skip the bad entry, keep the batch.
    }
  }
  flush();
  return accepted;
}

// ---------------------------------------------------------------------------
// Flushing
// ---------------------------------------------------------------------------

const INSERT_SQL = `
INSERT INTO system_logs (
  id, seq, logged_at, level, component, source, logger, message, exception,
  user_name, url, request_id, code, device_id, thread, tenant_id, context
) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`;

/**
 * Write everything buffered.
 *
 * Safe to call at any time: with no database the entries move to `pending` and
 * are written by a later flush. Failure never propagates and never loses more
 * than the batch that failed.
 */
export function flush(): void {
  if (buffer.length === 0 && pending.length === 0) return;

  const db = safeDb();
  if (!db) {
    // No sink yet. Keep the newest, because during a startup failure the last
    // entries are the ones that explain it.
    pending = [...pending, ...buffer].slice(-PENDING_LIMIT);
    buffer = [];
    return;
  }

  const batch = [...pending, ...buffer];
  pending = [];
  buffer = [];

  try {
    primeSeq(db);
    const insert = db.prepare(INSERT_SQL);
    const writeAll = db.transaction(() => {
      for (const e of batch) {
        insert.run(
          e.id, ++seq, e.loggedAt, e.level, e.component, e.source, e.logger,
          e.message, e.exception, e.userName, e.url, e.requestId, e.code,
          e.deviceId, e.thread, e.tenantId, e.context,
        );
      }
    });
    writeAll();
  } catch (err) {
    // The batch is gone rather than retried forever: a poison entry that fails
    // every flush would block every later entry behind it, which is worse than
    // losing it. The console appender already has these lines.
    console.error('[logging] flush failed, dropped', batch.length, 'entries:', err);
  }
}

/**
 * Continue the sequence from what is already on disk.
 *
 * Restarting at zero would interleave this session's entries with the previous
 * session's under the viewer's `logged_at, seq` sort, which reads as time
 * travel to whoever is debugging.
 */
function primeSeq(db: SqliteDatabase): void {
  if (seqPrimed) return;
  const row = db.prepare('SELECT COALESCE(MAX(seq), 0) AS seq FROM system_logs').get() as
    | { seq: number }
    | undefined;
  seq = row?.seq ?? 0;
  seqPrimed = true;
}

function safeDb(): SqliteDatabase | null {
  try {
    return config?.db() ?? null;
  } catch {
    // The engine's `requireDb` throws while locked rather than returning null.
    return null;
  }
}

// ---------------------------------------------------------------------------
// Retention
// ---------------------------------------------------------------------------

/**
 * Drop entries beyond the retention window and the row cap.
 *
 * Called from the sync worker rather than on a timer of its own: it is
 * housekeeping, and it belongs next to the other housekeeping that already
 * runs on a cycle the device is awake for.
 */
export function pruneLogs(db: SqliteDatabase): number {
  const maxRows = config?.maxRows ?? DEFAULTS.maxRows;
  const retentionDays = config?.retentionDays ?? DEFAULTS.retentionDays;

  try {
    const cutoff = new Date(Date.now() - retentionDays * 86_400_000).toISOString();
    const byAge = db.prepare('DELETE FROM system_logs WHERE logged_at < ?').run(cutoff);

    // Cap by sequence rather than by OFFSET: seq is monotonic and indexed, so
    // this is one range delete instead of a sort over the whole table.
    const row = db
      .prepare(
        `SELECT seq FROM system_logs ORDER BY seq DESC LIMIT 1 OFFSET ?`,
      )
      .get(maxRows) as { seq: number } | undefined;

    const byCount = row
      ? db.prepare('DELETE FROM system_logs WHERE seq <= ?').run(row.seq)
      : { changes: 0 };

    return (byAge.changes ?? 0) + (byCount.changes ?? 0);
  } catch (err) {
    console.warn('[logging] prune failed:', err);
    return 0;
  }
}

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

function truncate(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max - 1)}…`;
}

/**
 * Render a thrown value the way the `Exception` column in `ActivityLog` reads:
 * type, message, then stack.
 */
function formatException(err: unknown): string | null {
  if (err === undefined || err === null) return null;

  if (err instanceof Error) {
    const head = `${err.name}: ${err.message}`;
    const body = err.stack ? `\n${err.stack}` : '';
    const cause =
      'cause' in err && err.cause ? `\nCaused by: ${formatException(err.cause)}` : '';
    return truncate(head + body + cause, 8000);
  }

  if (typeof err === 'string') return truncate(err, 8000);

  try {
    return truncate(JSON.stringify(err), 8000);
  } catch {
    return truncate(String(err), 8000);
  }
}

function serialiseContext(context: Record<string, unknown> | undefined): string | null {
  if (!context || Object.keys(context).length === 0) return null;
  try {
    return truncate(JSON.stringify(context), 4000);
  } catch {
    // Circular, or a BigInt. Record the shape rather than dropping the entry.
    return JSON.stringify({ unserialisable: Object.keys(context) });
  }
}

const CONSOLE_METHOD: Readonly<Record<LogLevel, 'debug' | 'log' | 'warn' | 'error'>> = {
  DEBUG: 'debug',
  INFO: 'log',
  WARN: 'warn',
  ERROR: 'error',
  FATAL: 'error',
};

function mirrorToConsole(e: LogEntry): void {
  const tag = `[${e.level}] ${e.logger}`;
  const suffix = [
    e.code ? `code=${e.code}` : '',
    e.requestId ? `req=${e.requestId.slice(0, 8)}` : '',
  ]
    .filter(Boolean)
    .join(' ');

  const line = suffix ? `${tag} ${e.message} (${suffix})` : `${tag} ${e.message}`;
  const method = CONSOLE_METHOD[e.level];

  if (e.exception) console[method](line, '\n', e.exception);
  else console[method](line);
}
