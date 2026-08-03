/**
 * Customer command handlers.
 *
 * customer.create — write a new customer to the local database with
 *   an outbox row for server synchronisation.  The server-assigned
 *   ID is unknown at creation time, so we generate a local UUID and
 *   store `server_id` as null until the first pull reconciles it.
 *
 * customer.search — full-text search across customer name, TIN,
 *   phone, and email.  Returns a paginated result set.
 */

import type { CommandEnvelope } from '../../shared/contracts';
import type { SqliteDatabase } from '../../database/types';
import { randomUUID } from 'crypto';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface CustomerRow {
  id: string;
  serverId: string | null;
  tenantId: string;
  branchId: string;
  customerCode: string | null;
  customerName: string;
  customerTin: string | null;
  customerPhone: string | null;
  customerEmail: string | null;
  address: string | null;
  syncState: string;
  createdAt: string;
  updatedAt: string;
}

export interface CustomerCreatePayload {
  customerName: string;
  customerTin?: string;
  customerPhone?: string;
  customerEmail?: string;
  address?: string;
}

export interface CustomerSearchResult {
  customers: CustomerRow[];
  total: number;
}

export interface CustomerContext {
  readonly db: () => SqliteDatabase;
  readonly deviceId: string;
  readonly tenantId: string;
  readonly branchId: string;
}

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

/**
 * Create a new customer.
 *
 * The customer is written locally and an outbox row is created for
 * server sync.  The `server_id` is null until the pull worker
 * reconciles it with the server-assigned identifier.
 */
export function handleCustomerCreate(
  payload: unknown,
  envelope: CommandEnvelope,
  ctx: CustomerContext,
): CustomerRow {
  const db = ctx.db();
  const input = payload as CustomerCreatePayload;
  const now = new Date().toISOString();
  const customerId = envelope.idempotencyKey || randomUUID();
  const idempotencyKey = envelope.idempotencyKey || customerId;

  const commit = db.transaction(() => {
    db.prepare(`
      INSERT INTO customer (id, server_id, tenant_id, branch_id,
        customer_code, customer_name, customer_tin, customer_phone,
        customer_email, address, sync_state, created_at, updated_at)
      VALUES (?, NULL, ?, ?, NULL, ?, ?, ?, ?, ?, 'PENDING', ?, ?)
    `).run(
      customerId,
      ctx.tenantId,
      ctx.branchId,
      input.customerName,
      input.customerTin ?? null,
      input.customerPhone ?? null,
      input.customerEmail ?? null,
      input.address ?? null,
      now,
      now,
    );

    const outboxSeq = db.prepare(
      'SELECT COALESCE(MAX(seq), 0) + 1 AS next_seq FROM outbox',
    ).get() as { next_seq: number };

    db.prepare(`
      INSERT INTO outbox (id, seq, entity, entity_id, operation, payload,
        idempotency_key, state, created_at)
      VALUES (?, ?, 'customer', ?, 'CREATE', ?, ?, 'PENDING', ?)
    `).run(
      randomUUID(),
      outboxSeq.next_seq,
      customerId,
      JSON.stringify(input),
      idempotencyKey,
      now,
    );
  });

  db.exec('BEGIN IMMEDIATE');
  try {
    commit();
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');

    // UNIQUE constraint on some field — likely duplicate.
    const message = err instanceof Error ? err.message : String(err);
    if (message.includes('UNIQUE')) {
      throw Object.assign(
        new Error('A customer with these details already exists.'),
        { code: 'E_CONFLICT', retryable: false },
      );
    }
    throw err;
  }

  return {
    id: customerId,
    serverId: null,
    tenantId: ctx.tenantId,
    branchId: ctx.branchId,
    customerCode: null,
    customerName: input.customerName,
    customerTin: input.customerTin ?? null,
    customerPhone: input.customerPhone ?? null,
    customerEmail: input.customerEmail ?? null,
    address: input.address ?? null,
    syncState: 'PENDING',
    createdAt: now,
    updatedAt: now,
  };
}

/**
 * Search customers by name, TIN, phone, or email.
 *
 * Results are ordered by name and paginated.  An empty or missing
 * query returns all customers ordered by name.
 */
export function handleCustomerSearch(
  payload: unknown,
  _envelope: CommandEnvelope,
  ctx: CustomerContext,
): CustomerSearchResult {
  const db = ctx.db();
  const { query = '', limit = 25, offset = 0 } = (payload as {
    query?: string;
    limit?: number;
    offset?: number;
  }) ?? {};

  const searchPattern = `%${query}%`;

  const baseWhere = `
    WHERE tenant_id = ? AND branch_id = ?
      AND (customer_name LIKE ? OR customer_tin LIKE ?
           OR customer_phone LIKE ? OR customer_email LIKE ?)
  `;
  const baseParams: unknown[] = [
    ctx.tenantId,
    ctx.branchId,
    searchPattern,
    searchPattern,
    searchPattern,
    searchPattern,
  ];

  const sql = `
    SELECT id, server_id AS serverId, tenant_id AS tenantId,
      branch_id AS branchId, customer_code AS customerCode,
      customer_name AS customerName, customer_tin AS customerTin,
      customer_phone AS customerPhone, customer_email AS customerEmail,
      address, sync_state AS syncState,
      created_at AS createdAt, updated_at AS updatedAt
    FROM customer
    ${baseWhere}
    ORDER BY customer_name ASC
    LIMIT ? OFFSET ?
  `;

  const customers = db.prepare(sql).all(
    ...baseParams,
    limit,
    offset,
  ) as unknown as CustomerRow[];

  const countRow = db.prepare(
    `SELECT COUNT(*) AS total FROM customer ${baseWhere}`,
  ).get(...baseParams) as { total: number };

  return { customers, total: countRow.total };
}
