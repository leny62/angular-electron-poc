import { randomUUID } from 'crypto';
import { rowToCustomer, type CustomerRow, type SaleRow } from '@bizuri/local-store';
import { EngineError, notFound, type OperationContext, type OperationResult } from '../contracts';
import * as D from '../domain/decimal';
import type { SqliteDatabase } from '../store/types';
import { issueReceipt } from './receipt-chain';
import { loadSale } from './create-sale';

export interface WriteDeps {
  readonly db: SqliteDatabase;
  readonly deviceId: string;
  readonly contractVersion: string;
  readonly now?: () => string;
  readonly newId?: () => string;
}

function nextSeq(db: SqliteDatabase): number {
  const row = db.prepare('SELECT COALESCE(MAX(seq), 0) AS seq FROM outbox').get() as
    | { seq: number }
    | undefined;
  return (row?.seq ?? 0) + 1;
}

function enqueue(
  db: SqliteDatabase,
  args: {
    tenantId: string;
    id: string;
    seq: number;
    aggregateType: string;
    aggregateId: string;
    operationId: string;
    contractVersion: string;
    payload: unknown;
    idempotencyKey: string;
    createdAt: string;
  },
): void {
  db.prepare(
    `INSERT INTO outbox (
       tenant_id, id, seq, aggregate_type, aggregate_id, operation_id,
       contract_version, payload, idempotency_key, state, attempts,
       batch_id, leased_until, last_error, created_at
     ) VALUES (?,?,?,?,?,?,?,?,?,'PENDING',0,NULL,NULL,NULL,?)`,
  ).run(
    args.tenantId, args.id, args.seq, args.aggregateType, args.aggregateId,
    args.operationId, args.contractVersion, JSON.stringify(args.payload),
    args.idempotencyKey, args.createdAt,
  );
}

function findSale(db: SqliteDatabase, tenantId: string, saleId: string): SaleRow {
  const row = db
    .prepare('SELECT * FROM sales WHERE tenant_id = ? AND (id = ? OR server_id = ?) LIMIT 1')
    .get(tenantId, saleId, saleId) as unknown as SaleRow | undefined;
  if (!row) throw notFound(`Sale ${saleId}`);
  return row;
}

// ---------------------------------------------------------------------------

export function makeConfirmSale(deps: WriteDeps) {
  const now = deps.now ?? (() => new Date().toISOString());
  const newId = deps.newId ?? (() => randomUUID());

  return function confirmSale(ctx: OperationContext): OperationResult<unknown> {
    const { db } = deps;
    const saleId = ctx.request.pathParams['saleId'] as string;

    const run = db.transaction(() => {
      const sale = findSale(db, ctx.tenantId, saleId);

      if (sale.status === 'CONFIRMED') {
        return loadSale(db, sale.id);
      }
      if (sale.status !== 'DRAFT') {
        throw new EngineError('E_CONFLICT', `Cannot confirm a ${sale.status} sale.`);
      }

      const paid = db
        .prepare('SELECT COALESCE(SUM(CAST(amount AS REAL)), 0) AS total FROM sale_payments WHERE sale_id = ?')
        .get(sale.id) as { total: number };

      if (D.lt(D.parse(String(paid.total)), D.parse(sale.grand_total))) {
        throw new EngineError('E_SCHEMA', 'Payments do not cover the sale total.');
      }

      const confirmedAt = now();
      db.prepare(
        `UPDATE sales SET status = 'CONFIRMED', confirmed_at = ?, sync_state = 'PENDING' WHERE id = ?`,
      ).run(confirmedAt, sale.id);

      // Draft holds were already deducted at DRAFT time, so confirming does not
      // deduct again. Reversal happens only on cancel.
      issueReceipt(db, {
        tenantId: ctx.tenantId,
        saleId: sale.id,
        deviceId: deps.deviceId,
        grandTotal: sale.grand_total,
        issuedAt: confirmedAt,
        newId,
      });

      enqueue(db, {
        tenantId: ctx.tenantId,
        id: newId(),
        seq: nextSeq(db),
        aggregateType: 'Sale',
        aggregateId: sale.id,
        operationId: 'confirmSale',
        contractVersion: deps.contractVersion,
        payload: { saleId: sale.server_id ?? sale.id },
        idempotencyKey: `confirm-${sale.id}`,
        createdAt: confirmedAt,
      });

      return loadSale(db, sale.id);
    });

    return { status: 200, data: { success: true, message: 'Sale confirmed', data: run() }, durableAt: now() };
  };
}

export function makeCancelSale(deps: WriteDeps) {
  const now = deps.now ?? (() => new Date().toISOString());
  const newId = deps.newId ?? (() => randomUUID());

  return function cancelSale(ctx: OperationContext): OperationResult<unknown> {
    const { db } = deps;
    const saleId = ctx.request.pathParams['saleId'] as string;

    const run = db.transaction(() => {
      const sale = findSale(db, ctx.tenantId, saleId);

      if (sale.status === 'CANCELLED') return loadSale(db, sale.id);
      if (sale.status === 'REFUNDED' || sale.status === 'CREDITED') {
        throw new EngineError('E_CONFLICT', `Cannot cancel a ${sale.status} sale.`);
      }

      const lines = db
        .prepare('SELECT item_id, quantity FROM sale_lines WHERE sale_id = ?')
        .all(sale.id) as unknown as { item_id: string; quantity: string }[];

      // Return stock to the local projection. The server reverses its own ledger
      // on push; this keeps the sales screen honest in the meantime.
      const bumpCatalog = db.prepare(
        `UPDATE sales_catalog SET available_qty = ?
          WHERE tenant_id = ? AND branch_id = ? AND item_id = ?`,
      );
      const readCatalog = db.prepare(
        `SELECT available_qty FROM sales_catalog
          WHERE tenant_id = ? AND branch_id = ? AND item_id = ?`,
      );

      for (const line of lines) {
        const current = readCatalog.get(ctx.tenantId, sale.branch_id, line.item_id) as
          | { available_qty: string | null }
          | undefined;
        if (!current) continue;
        bumpCatalog.run(
          D.format(D.add(D.parse(current.available_qty), D.parse(line.quantity))),
          ctx.tenantId,
          sale.branch_id,
          line.item_id,
        );
      }

      const cancelledAt = now();
      db.prepare(
        `UPDATE sales SET status = 'CANCELLED', sync_state = 'PENDING' WHERE id = ?`,
      ).run(sale.id);

      enqueue(db, {
        tenantId: ctx.tenantId,
        id: newId(),
        seq: nextSeq(db),
        aggregateType: 'Sale',
        aggregateId: sale.id,
        operationId: 'cancelSale',
        contractVersion: deps.contractVersion,
        payload: { saleId: sale.server_id ?? sale.id },
        idempotencyKey: `cancel-${sale.id}`,
        createdAt: cancelledAt,
      });

      return loadSale(db, sale.id);
    });

    return { status: 200, data: { success: true, message: 'Sale cancelled', data: run() }, durableAt: now() };
  };
}

export function makeCreateCustomer(deps: WriteDeps) {
  const now = deps.now ?? (() => new Date().toISOString());
  const newId = deps.newId ?? (() => randomUUID());

  return function createCustomer(ctx: OperationContext): OperationResult<unknown> {
    const { db } = deps;
    const body = ctx.request.body as {
      name: string;
      tin?: string;
      primaryPhone?: string;
      secondaryPhone?: string;
      email?: string;
      address?: string;
    };

    const idempotencyKey = ctx.idempotencyKey ?? `customer-${newId()}`;

    const run = db.transaction(() => {
      const existing = db
        .prepare('SELECT aggregate_id FROM outbox WHERE idempotency_key = ?')
        .get(idempotencyKey) as { aggregate_id: string } | undefined;

      if (existing) {
        const row = db
          .prepare('SELECT * FROM customers WHERE id = ?')
          .get(existing.aggregate_id) as unknown as CustomerRow | undefined;
        if (row) return rowToCustomer(row);
      }

      const id = newId();
      const createdAt = now();
      const seq = nextSeq(db);

      db.prepare(
        `INSERT INTO customers (
           tenant_id, id, name, tin, primary_phone, secondary_phone, email,
           address, status, created_at, updated_at, deleted, server_id,
           sync_state, local_seq
         ) VALUES (?,?,?,?,?,?,?,?, 'ACTIVE', ?, ?, 0, NULL, 'PENDING', ?)`,
      ).run(
        ctx.tenantId, id, body.name, body.tin ?? null, body.primaryPhone ?? null,
        body.secondaryPhone ?? null, body.email ?? null, body.address ?? null,
        createdAt, createdAt, seq,
      );

      enqueue(db, {
        tenantId: ctx.tenantId,
        id: newId(),
        seq,
        aggregateType: 'Customer',
        aggregateId: id,
        operationId: 'createCustomer',
        contractVersion: deps.contractVersion,
        payload: body,
        idempotencyKey,
        createdAt,
      });

      const row = db.prepare('SELECT * FROM customers WHERE id = ?').get(id) as unknown as CustomerRow;
      return rowToCustomer(row);
    });

    return {
      status: 201,
      data: { success: true, message: 'Customer created', data: run() },
      durableAt: now(),
    };
  };
}
