/**
 * Sale command handlers.
 *
 * sale.create — write a sale, its receipt, and an outbox row in one
 *   BEGIN IMMEDIATE transaction.  Prices are resolved from the local
 *   catalog snapshot, never from values sent by the renderer.
 * sale.get    — fetch a single sale by identifier.
 * sale.list   — list sales with optional filters.
 */

import type { CommandEnvelope } from '../../shared/contracts';
import type { SqliteDatabase } from '../../database/types';
import { randomUUID, createHash } from 'crypto';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface SaleCreatePayload {
  customerId?: string;
  clientName?: string;
  clientTin?: string;
  clientPhone?: string;
  currencyCode?: string;
  items: Array<{
    itemId: string;
    quantity: number;
    unitPrice?: number;
  }>;
  amountPaid: string;
}

export interface SaleRow {
  id: string;
  serverId: string | null;
  saleNumber: string;
  status: string;
  syncState: string;
  customerId: string | null;
  clientName: string | null;
  grandTotal: string;
  amountPaid: string;
  balanceDue: string;
  idempotencyKey: string;
  createdAt: string;
  confirmedAt: string | null;
  receipt?: {
    seq: number;
    prevHash: string;
    hash: string;
    issuedAt: string;
  };
  items?: Array<{
    itemId: string;
    quantity: number;
    unitPrice?: number;
  }>;
}

export interface SaleListResult {
  sales: SaleRow[];
  total: number;
}

export interface SaleContext {
  readonly db: () => SqliteDatabase;
  readonly deviceId: string;
  readonly tenantId: string;
  readonly branchId: string;
  readonly receiptPrefix: string;
}

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

export function handleSaleCreate(
  payload: unknown,
  envelope: CommandEnvelope,
  ctx: SaleContext,
): { sale: SaleRow; receiptNumber: string } {
  const db = ctx.db();
  const input = payload as SaleCreatePayload;

  if (!input?.items?.length) {
    throw Object.assign(new Error('sale must contain at least one item'), {
      code: 'E_SCHEMA',
      retryable: false,
    });
  }

  // Resolve prices from the local catalog snapshot.
  let subtotal = 0n;
  let taxTotal = 0n;

  for (const item of input.items) {
    const catalogRow = db.prepare(
      'SELECT selling_price, tax_category_rate FROM catalog_item WHERE item_id = ? AND branch_id = ?',
    ).get(item.itemId, ctx.branchId) as
      | { selling_price: string; tax_category_rate: string }
      | undefined;

    if (!catalogRow) {
      throw Object.assign(new Error(`Item not found in catalog: ${item.itemId}`), {
        code: 'E_SCHEMA',
        retryable: false,
      });
    }

    const priceCents = decimalToCents(catalogRow.selling_price);
    const taxRateBps = decimalToCents(catalogRow.tax_category_rate);
    const qty = BigInt(item.quantity);
    const lineTotal = priceCents * qty;
    const lineTax = (lineTotal * taxRateBps) / 10000n;

    subtotal += lineTotal;
    taxTotal += lineTax;
  }

  const discountTotal = 0n;
  const grandTotal = subtotal - discountTotal + taxTotal;
  const amountPaid = decimalToCents(input.amountPaid);
  const balanceDue = amountPaid - grandTotal;

  // Validate stock availability.
  for (const item of input.items) {
    const stock = db.prepare(
      'SELECT available_qty FROM catalog_item WHERE item_id = ? AND branch_id = ?',
    ).get(item.itemId, ctx.branchId) as { available_qty: string } | undefined;

    const available = BigInt(stock?.available_qty ?? '0');
    if (available < BigInt(item.quantity)) {
      throw Object.assign(
        new Error(
          `Insufficient stock for ${item.itemId}: requested ${item.quantity}, available ${available}`,
        ),
        {
          code: 'E_STOCK',
          retryable: false,
          details: { itemId: item.itemId, requested: item.quantity, available: available.toString() },
        },
      );
    }
  }

  // Generate identifiers.
  const saleId = envelope.idempotencyKey || randomUUID();
  const now = new Date().toISOString();
  const idempotencyKey = envelope.idempotencyKey || saleId;

  // Build receipt hash-chain.
  const deviceSession = db.prepare(
    'SELECT receipt_prefix, receipt_seq, last_receipt_hash FROM device_session WHERE device_id = ?',
  ).get(ctx.deviceId) as {
    receipt_prefix: string;
    receipt_seq: number;
    last_receipt_hash: string | null;
  } | undefined;

  const receiptSeq = (deviceSession?.receipt_seq ?? 0) + 1;
  const receiptNumber = `${deviceSession?.receipt_prefix ?? 'RCP'}-${String(receiptSeq).padStart(6, '0')}`;
  const prevHash =
    deviceSession?.last_receipt_hash ??
    '0000000000000000000000000000000000000000000000000000000000000000';
  const receiptHash = computeReceiptHash(saleId, receiptNumber, receiptSeq, prevHash);
  const receiptId = randomUUID();
  const saleNumber = receiptNumber;

  // Atomic write: sale + receipt + outbox + device_session update.
  const commit = db.transaction(() => {
    db.prepare(`
      INSERT INTO sale (id, tenant_id, branch_id, sale_number, status, sync_state,
        customer_id, client_name, client_tin, client_phone, currency_code,
        subtotal, discount_total, tax_total, grand_total, amount_paid, balance_due,
        device_id, idempotency_key, created_at, confirmed_at)
      VALUES (?, ?, ?, ?, 'CONFIRMED', 'PENDING',
        ?, ?, ?, ?, ?,
        ?, ?, ?, ?, ?, ?,
        ?, ?, ?, ?)
    `).run(
      saleId, ctx.tenantId, ctx.branchId, saleNumber,
      input.customerId ?? null, input.clientName ?? null,
      input.clientTin ?? null, input.clientPhone ?? null,
      input.currencyCode ?? 'RWF',
      centsToDecimal(subtotal), centsToDecimal(discountTotal),
      centsToDecimal(taxTotal), centsToDecimal(grandTotal),
      centsToDecimal(amountPaid), centsToDecimal(balanceDue),
      ctx.deviceId, idempotencyKey, now, now,
    );

    db.prepare(`
      INSERT INTO receipt (id, sale_id, receipt_number, seq, prev_hash, hash, issued_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(receiptId, saleId, receiptNumber, receiptSeq, prevHash, receiptHash, now);

    const outboxSeq = db.prepare(
      'SELECT COALESCE(MAX(seq), 0) + 1 AS next_seq FROM outbox',
    ).get() as { next_seq: number };

    db.prepare(`
      INSERT INTO outbox (id, seq, entity, entity_id, operation, payload,
        idempotency_key, state, created_at)
      VALUES (?, ?, 'sale', ?, 'CREATE', ?, ?, 'PENDING', ?)
    `).run(randomUUID(), outboxSeq.next_seq, saleId, JSON.stringify(input), idempotencyKey, now);

    db.prepare(`
      UPDATE device_session SET receipt_seq = ?, last_receipt_hash = ? WHERE device_id = ?
    `).run(receiptSeq, receiptHash, ctx.deviceId);
  });

  db.exec('BEGIN IMMEDIATE');
  try {
    commit();
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }

  const durableAt = new Date().toISOString();

  const sale: SaleRow = {
    id: saleId,
    serverId: null,
    saleNumber,
    status: 'CONFIRMED',
    syncState: 'PENDING',
    customerId: input.customerId ?? null,
    clientName: input.clientName ?? null,
    grandTotal: centsToDecimal(grandTotal),
    amountPaid: centsToDecimal(amountPaid),
    balanceDue: centsToDecimal(balanceDue),
    idempotencyKey,
    createdAt: now,
    confirmedAt: now,
  };

  return { sale, receiptNumber };
}

export function handleSaleGet(
  payload: unknown,
  _envelope: CommandEnvelope,
  ctx: SaleContext,
): SaleRow | null {
  const db = ctx.db();
  const { saleId } = (payload as { saleId?: string }) ?? {};

  if (typeof saleId !== 'string') {
    throw Object.assign(new Error('saleId is required'), {
      code: 'E_SCHEMA',
      retryable: false,
    });
  }

  const row = db.prepare(`
    SELECT s.id, s.server_id AS serverId, s.sale_number AS saleNumber,
      s.status, s.sync_state AS syncState,
      s.customer_id AS customerId, s.client_name AS clientName,
      s.grand_total AS grandTotal, s.amount_paid AS amountPaid,
      s.balance_due AS balanceDue, s.idempotency_key AS idempotencyKey,
      s.created_at AS createdAt, s.confirmed_at AS confirmedAt,
      r.seq AS receiptSeq, r.prev_hash AS receiptPrevHash,
      r.hash AS receiptHash, r.issued_at AS receiptIssuedAt,
      o.payload AS outboxPayload
    FROM sale s
    LEFT JOIN receipt r ON r.sale_id = s.id
    LEFT JOIN outbox o ON o.entity_id = s.id AND o.entity = 'sale'
    WHERE s.id = ?
    LIMIT 1
  `).get(saleId) as Record<string, unknown> | undefined;

  if (!row) return null;

  const result: SaleRow = {
    id: row.id as string,
    serverId: row.serverId as string | null,
    saleNumber: row.saleNumber as string,
    status: row.status as string,
    syncState: row.syncState as string,
    customerId: row.customerId as string | null,
    clientName: row.clientName as string | null,
    grandTotal: row.grandTotal as string,
    amountPaid: row.amountPaid as string,
    balanceDue: row.balanceDue as string,
    idempotencyKey: row.idempotencyKey as string,
    createdAt: row.createdAt as string,
    confirmedAt: row.confirmedAt as string | null,
  };

  if (row.receiptSeq != null) {
    result.receipt = {
      seq: row.receiptSeq as number,
      prevHash: row.receiptPrevHash as string,
      hash: row.receiptHash as string,
      issuedAt: row.receiptIssuedAt as string,
    };
  }

  if (row.outboxPayload) {
    try {
      const outboxData = JSON.parse(row.outboxPayload as string) as {
        items?: Array<{ itemId: string; quantity: number; unitPrice?: number }>;
      };
      if (outboxData.items) {
        result.items = outboxData.items;
      }
    } catch {
      // Payload may not be valid JSON — ignore.
    }
  }

  return result;
}

export function handleSaleList(
  payload: unknown,
  _envelope: CommandEnvelope,
  ctx: SaleContext,
): SaleListResult {
  const db = ctx.db();
  const { limit = 50, offset = 0, syncState } = (payload as {
    limit?: number;
    offset?: number;
    syncState?: string;
  }) ?? {};

  let query = `
    SELECT id, server_id AS serverId, sale_number AS saleNumber,
      status, sync_state AS syncState,
      customer_id AS customerId, client_name AS clientName,
      grand_total AS grandTotal, amount_paid AS amountPaid,
      balance_due AS balanceDue, idempotency_key AS idempotencyKey,
      created_at AS createdAt, confirmed_at AS confirmedAt
    FROM sale
  `;
  const params: unknown[] = [];

  if (syncState) {
    query += ' WHERE sync_state = ?';
    params.push(syncState);
  }

  query += ' ORDER BY created_at DESC LIMIT ? OFFSET ?';
  params.push(limit, offset);

  const sales = db.prepare(query).all(...params) as unknown as SaleRow[];

  const countRow = db.prepare(
    syncState
      ? 'SELECT COUNT(*) AS total FROM sale WHERE sync_state = ?'
      : 'SELECT COUNT(*) AS total FROM sale',
  ).get(...(syncState ? [syncState] : [])) as { total: number };

  return { sales, total: countRow.total };
}

// ---------------------------------------------------------------------------
// Fixed-point arithmetic helpers
// ---------------------------------------------------------------------------

function decimalToCents(decimal: string): bigint {
  const parts = decimal.split('.');
  const whole = parts[0] ?? '0';
  const frac = (parts[1] ?? '').padEnd(2, '0').slice(0, 2);
  return BigInt(whole) * 100n + BigInt(frac);
}

function centsToDecimal(cents: bigint): string {
  const sign = cents < 0n ? '-' : '';
  const abs = cents < 0n ? -cents : cents;
  const whole = abs / 100n;
  const frac = abs % 100n;
  return `${sign}${whole}.${String(frac).padStart(2, '0')}`;
}

function computeReceiptHash(
  saleId: string,
  receiptNumber: string,
  seq: number,
  prevHash: string,
): string {
  const canonical = `${saleId}|${receiptNumber}|${seq}|${prevHash}`;
  return createHash('sha256').update(canonical, 'utf8').digest('hex');
}
