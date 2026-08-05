/**
 * The two log operations: read the table, and accept entries from the renderer.
 *
 * Both are handwritten rather than generated because `system_logs` is not a
 * contract table. It has no tenant scope (see the descriptor for why), and the
 * write path is the only place in the engine that turns renderer-supplied text
 * into rows, so it sanitises rather than trusting gate 4 alone.
 */

import {
  LOG_COMPONENTS,
  LOG_LEVELS,
  rowToSystemLog,
  type LogComponent,
  type LogLevel,
  type SystemLogRow,
} from '@bizuri/local-store';
import type { OperationContext, OperationResult } from '../contracts';
import { flush, recordExternal, type LogEntry } from '../logging/logger';
import type { SqliteDatabase } from '../store/types';

export interface LogOpsDeps {
  /** Null while the engine is locked. Reads return empty rather than failing. */
  readonly db: () => SqliteDatabase | null;
  readonly deviceId: string;
}

const MAX_PAGE_SIZE = 200;
const DEFAULT_PAGE_SIZE = 50;

export function makeLogOps(deps: LogOpsDeps) {
  return {
    /**
     * GET /_engine/logs
     *
     * Ordered by `logged_at DESC, seq DESC`. The `seq` tiebreak is what makes
     * pagination stable: a burst of entries sharing a millisecond would
     * otherwise let rows drift between pages as the table grows underneath the
     * reader.
     */
    listSystemLogs: (ctx: OperationContext): OperationResult<unknown> => {
      const db = deps.db();

      const page = readInt(ctx, 'page', 0);
      const size = Math.min(readInt(ctx, 'size', DEFAULT_PAGE_SIZE), MAX_PAGE_SIZE);

      // Locked, or opened for the first time this launch. The viewer shows an
      // empty table rather than an error: "no logs yet" is the truth, and the
      // entries explaining the lock are buffered and land on the next flush.
      if (!db) {
        return { status: 200, data: emptyPage(page, size) };
      }

      // Anything buffered is invisible to a SELECT, and the newest entries are
      // the ones a support engineer just came here to read.
      flush();

      const where: string[] = [];
      const params: unknown[] = [];

      const eq = (param: string, column: string) => {
        const value = readParam(ctx, param);
        if (value) {
          where.push(`${column} = ?`);
          params.push(value);
        }
      };

      eq('level', 'level');
      eq('component', 'component');
      eq('source', 'source');
      eq('logger', 'logger');
      eq('requestId', 'request_id');

      const from = readParam(ctx, 'fromDate');
      if (from) {
        where.push('logged_at >= ?');
        params.push(from);
      }
      const to = readParam(ctx, 'toDate');
      if (to) {
        where.push('logged_at <= ?');
        params.push(to);
      }

      const search = readParam(ctx, 'search');
      if (search) {
        where.push('(message LIKE ? OR logger LIKE ? OR exception LIKE ? OR url LIKE ?)');
        // Bound parameters, and gate 4 caps the length, so no escaping needed.
        for (let i = 0; i < 4; i++) params.push(`%${search}%`);
      }

      const whereSql = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';

      const { total } = db
        .prepare(`SELECT count(*) AS total FROM system_logs ${whereSql}`)
        .get(...params) as { total: number };

      const rows = db
        .prepare(
          `SELECT * FROM system_logs ${whereSql}
            ORDER BY logged_at DESC, seq DESC
            LIMIT ? OFFSET ?`,
        )
        .all(...params, size, page * size) as unknown as SystemLogRow[];

      const totalPages = Math.max(1, Math.ceil(total / Math.max(size, 1)));

      return {
        status: 200,
        data: {
          success: true,
          message: 'Request successful',
          data: rows.map(rowToSystemLog),
          meta: { page, size, totalElements: total, totalPages },
        },
      };
    },

    /**
     * POST /_engine/logs
     *
     * The renderer ships its own entries here so browser and engine logs share
     * one table, one sequence, and one retention policy. The alternative,
     * a separate browser-side store, means correlating two timelines by hand
     * during an incident.
     *
     * Entries are re-stamped rather than trusted: `source` is forced to BROWSER
     * regardless of what arrived, and `loggedAt` is only honoured when it
     * parses as a real date. A renderer that can backdate its own entries can
     * hide them at the bottom of the table.
     */
    writeSystemLogs: (ctx: OperationContext): OperationResult<unknown> => {
      const body = ctx.request.body as { entries?: IncomingEntry[] } | undefined;
      const incoming = body?.entries ?? [];

      const now = new Date().toISOString();
      const entries: Omit<LogEntry, 'id'>[] = incoming.map((raw) => ({
        loggedAt: validTimestamp(raw.loggedAt) ?? now,
        level: normaliseLevel(raw.level),
        component: normaliseComponent(raw.component),
        source: 'BROWSER',
        logger: clamp(raw.logger, 120) ?? 'renderer',
        message: clamp(raw.message, 4000) ?? '(empty)',
        exception: clamp(raw.exception, 8000),
        userName: clamp(raw.userName, 200),
        url: clamp(raw.url, 1000),
        requestId: clamp(raw.requestId, 100),
        code: clamp(raw.code, 60),
        deviceId: deps.deviceId,
        thread: clamp(raw.thread, 60) ?? 'renderer',
        tenantId: ctx.tenantId ?? null,
        context: serialise(raw.context),
      }));

      const accepted = recordExternal(entries, { source: 'BROWSER' });

      return {
        status: 202,
        data: { success: true, message: 'Accepted', data: { accepted } },
      };
    },
  };
}

// ---------------------------------------------------------------------------
// Incoming shape (already bounded by gate 4; normalised again here)
// ---------------------------------------------------------------------------

interface IncomingEntry {
  loggedAt?: string;
  level?: string;
  component?: string;
  logger?: string;
  message?: string;
  exception?: string;
  userName?: string;
  url?: string;
  requestId?: string;
  code?: string;
  thread?: string;
  context?: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function emptyPage(page: number, size: number) {
  return {
    success: true,
    message: 'Request successful',
    data: [],
    meta: { page, size, totalElements: 0, totalPages: 1 },
  };
}

function readParam(ctx: OperationContext, name: string): string | undefined {
  const q = ctx.request.query?.[name];
  const value = Array.isArray(q) ? q[0] : q;
  return value === '' ? undefined : value;
}

function readInt(ctx: OperationContext, name: string, fallback: number): number {
  const raw = readParam(ctx, name);
  if (raw === undefined) return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : fallback;
}

function clamp(value: string | undefined, max: number): string | null {
  if (typeof value !== 'string' || value.length === 0) return null;
  return value.length <= max ? value : value.slice(0, max);
}

/**
 * A CHECK constraint rejects an unknown level, and one bad entry would fail the
 * whole insert transaction. Normalising here keeps a malformed batch from
 * taking the well-formed entries down with it.
 */
function normaliseLevel(value: string | undefined): LogLevel {
  const upper = (value ?? '').toUpperCase() as LogLevel;
  return (LOG_LEVELS as readonly string[]).includes(upper) ? upper : 'INFO';
}

function normaliseComponent(value: string | undefined): LogComponent {
  const upper = (value ?? '').toUpperCase() as LogComponent;
  return (LOG_COMPONENTS as readonly string[]).includes(upper) ? upper : 'APPLICATION';
}

function validTimestamp(value: string | undefined): string | null {
  if (!value) return null;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? null : new Date(parsed).toISOString();
}

function serialise(context: Record<string, unknown> | undefined): string | null {
  if (!context || Object.keys(context).length === 0) return null;
  try {
    const json = JSON.stringify(context);
    return json.length <= 4000 ? json : json.slice(0, 4000);
  } catch {
    return null;
  }
}
