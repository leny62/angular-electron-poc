/**
 * Generated-style readers for replica and write-through tables.
 *
 * The generator will emit these from a TableDescriptor plus the operation's
 * query parameters. Hand-written here to pin the shape.
 */

import { notFound, type OperationContext, type OperationResult } from '../contracts';
import type { SqliteDatabase } from '../store/types';

export type Envelope = 'bare-page' | 'wrapped-page' | 'wrapped-object';

export interface FilterSpec {
  /** LIKE across these columns, OR'd together. */
  readonly search?: readonly string[];
  /** Query param to column, exact match. */
  readonly equals?: Readonly<Record<string, string>>;
  /** Query param to column, `>=`. Dates. */
  readonly from?: Readonly<Record<string, string>>;
  /** Query param to column, `<=`. */
  readonly to?: Readonly<Record<string, string>>;
}

export interface ListConfig<Row, Dto> {
  readonly table: string;
  readonly scope: readonly ('tenant' | 'branch')[];
  readonly filters?: FilterSpec;
  readonly orderBy: string;
  readonly envelope: Envelope;
  readonly map: (row: Row) => Dto;
  /** Applied on every query. Excludes tombstones and, for sales, drafts. */
  readonly baseWhere?: string;
  readonly defaultSize?: number;
  readonly maxSize?: number;
}

export interface GetConfig<Row, Dto> {
  readonly table: string;
  readonly scope: readonly ('tenant' | 'branch')[];
  /** Path or query param to column. First match wins. */
  readonly lookup: readonly { readonly param: string; readonly column: string }[];
  readonly envelope: Envelope;
  readonly map: (row: Row) => Dto;
  readonly baseWhere?: string;
  readonly notFoundLabel: string;
}

// ---------------------------------------------------------------------------

function scopeClause(
  scope: readonly ('tenant' | 'branch')[],
  ctx: OperationContext,
): { sql: string; params: unknown[] } {
  const sql: string[] = [];
  const params: unknown[] = [];

  if (scope.includes('tenant')) {
    sql.push('tenant_id = ?');
    params.push(ctx.tenantId);
  }
  if (scope.includes('branch')) {
    sql.push('branch_id = ?');
    params.push(ctx.branchId);
  }
  return { sql: sql.join(' AND '), params };
}

function readParam(ctx: OperationContext, name: string): string | undefined {
  const fromPath = ctx.request.pathParams?.[name];
  if (fromPath !== undefined) return fromPath;
  const q = ctx.request.query?.[name];
  return Array.isArray(q) ? q[0] : q;
}

function readInt(ctx: OperationContext, name: string, fallback: number): number {
  const raw = readParam(ctx, name);
  if (raw === undefined) return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : fallback;
}

function wrap<T>(envelope: Envelope, items: T[], page: number, size: number, total: number) {
  const totalPages = Math.max(1, Math.ceil(total / Math.max(size, 1)));

  if (envelope === 'bare-page') {
    return {
      data: items,
      page,
      size,
      totalElements: total,
      totalPages,
      hasNext: page + 1 < totalPages,
      hasPrevious: page > 0,
    };
  }

  return {
    success: true,
    message: 'Request successful',
    data: items,
    meta: { page, size, totalElements: total, totalPages },
  };
}

// ---------------------------------------------------------------------------

export function makeReplicaList<Row, Dto>(
  db: () => SqliteDatabase,
  config: ListConfig<Row, Dto>,
) {
  const defaultSize = config.defaultSize ?? 20;
  const maxSize = config.maxSize ?? 100;

  return function list(ctx: OperationContext): OperationResult<unknown> {
    const page = readInt(ctx, 'page', 0);
    const size = Math.min(readInt(ctx, 'size', defaultSize), maxSize);

    const where: string[] = [];
    const params: unknown[] = [];

    const scoped = scopeClause(config.scope, ctx);
    if (scoped.sql) {
      where.push(scoped.sql);
      params.push(...scoped.params);
    }
    if (config.baseWhere) where.push(config.baseWhere);

    const f = config.filters;
    if (f?.search) {
      const term = readParam(ctx, 'search');
      if (term) {
        where.push(`(${f.search.map((c) => `${c} LIKE ?`).join(' OR ')})`);
        // Escaping is unnecessary: values are bound, and gate 4 caps length.
        for (const _ of f.search) params.push(`%${term}%`);
      }
    }
    for (const [param, column] of Object.entries(f?.equals ?? {})) {
      const v = readParam(ctx, param);
      if (v !== undefined && v !== '') {
        where.push(`${column} = ?`);
        params.push(v);
      }
    }
    for (const [param, column] of Object.entries(f?.from ?? {})) {
      const v = readParam(ctx, param);
      if (v) {
        where.push(`${column} >= ?`);
        params.push(v);
      }
    }
    for (const [param, column] of Object.entries(f?.to ?? {})) {
      const v = readParam(ctx, param);
      if (v) {
        where.push(`${column} <= ?`);
        params.push(v);
      }
    }

    const whereSql = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';
    const handle = db();

    const { total } = handle
      .prepare(`SELECT count(*) AS total FROM ${config.table} ${whereSql}`)
      .get(...params) as { total: number };

    const rows = handle
      .prepare(
        `SELECT * FROM ${config.table} ${whereSql}
         ORDER BY ${config.orderBy} LIMIT ? OFFSET ?`,
      )
      .all(...params, size, page * size) as unknown as Row[];

    return {
      status: 200,
      data: wrap(config.envelope, rows.map(config.map), page, size, total),
    };
  };
}

export function makeReplicaGet<Row, Dto>(
  db: () => SqliteDatabase,
  config: GetConfig<Row, Dto>,
) {
  return function get(ctx: OperationContext): OperationResult<unknown> {
    const where: string[] = [];
    const params: unknown[] = [];

    const scoped = scopeClause(config.scope, ctx);
    if (scoped.sql) {
      where.push(scoped.sql);
      params.push(...scoped.params);
    }
    if (config.baseWhere) where.push(config.baseWhere);

    const matched = config.lookup
      .map((l) => ({ ...l, value: readParam(ctx, l.param) }))
      .filter((l) => l.value !== undefined && l.value !== '');

    if (matched.length === 0) {
      throw notFound(config.notFoundLabel);
    }

    where.push(`(${matched.map((m) => `${m.column} = ?`).join(' OR ')})`);
    params.push(...matched.map((m) => m.value));

    const row = db()
      .prepare(`SELECT * FROM ${config.table} WHERE ${where.join(' AND ')} LIMIT 1`)
      .get(...params) as unknown as Row | undefined;

    if (!row) throw notFound(config.notFoundLabel);

    const dto = config.map(row);
    return {
      status: 200,
      data: config.envelope === 'bare-page' ? dto : { success: true, message: 'Request successful', data: dto },
    };
  };
}
