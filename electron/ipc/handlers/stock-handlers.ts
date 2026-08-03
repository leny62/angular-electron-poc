/**
 * Stock command handlers.
 *
 * stock.balance — read current inventory levels from the catalog
 *   snapshot.  Returns item ID, available quantity, and sell mode.
 *
 * stock.adjust — write a stock adjustment (positive or negative
 *   quantity change) with an outbox row for server sync.  Runs in
 *   a transaction with stock validation.
 */

import type { CommandEnvelope } from '../../shared/contracts';
import type { SqliteDatabase } from '../../database/types';
import { randomUUID } from 'crypto';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface StockBalanceRow {
  itemId: string;
  itemCode: string;
  itemName: string;
  availableQty: string;
  sellMode: string;
}

export interface StockAdjustPayload {
  itemId: string;
  quantity: number; // positive = add, negative = remove
  reason?: string;
}

export interface StockContext {
  readonly db: () => SqliteDatabase;
  readonly deviceId: string;
  readonly branchId: string;
}

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

/**
 * Return current stock balance for the given items, or all items
 * when no filter is provided.
 */
export function handleStockBalance(
  payload: unknown,
  _envelope: CommandEnvelope,
  ctx: StockContext,
): { items: StockBalanceRow[] } {
  const db = ctx.db();
  const { itemIds } = (payload as { itemIds?: string[] }) ?? {};

  if (itemIds && itemIds.length > 0) {
    const placeholders = itemIds.map(() => '?').join(', ');
    const sql = `
      SELECT item_id AS itemId, item_code AS itemCode,
        item_name AS itemName, available_qty AS availableQty,
        sell_mode AS sellMode
      FROM catalog_item
      WHERE branch_id = ? AND item_id IN (${placeholders})
      ORDER BY item_name ASC
    `;
    const items = db.prepare(sql).all(ctx.branchId, ...itemIds) as unknown as StockBalanceRow[];
    return { items };
  }

  const items = db.prepare(`
    SELECT item_id AS itemId, item_code AS itemCode,
      item_name AS itemName, available_qty AS availableQty,
      sell_mode AS sellMode
    FROM catalog_item
    WHERE branch_id = ?
    ORDER BY item_name ASC
  `).all(ctx.branchId) as unknown as StockBalanceRow[];

  return { items };
}

/**
 * Adjust stock for a single item.
 *
 * Validates that the adjustment does not bring available quantity
 * below zero.  Writes an outbox row for server synchronisation.
 */
export function handleStockAdjust(
  payload: unknown,
  envelope: CommandEnvelope,
  ctx: StockContext,
): { itemId: string; previousQty: string; newQty: string } {
  const db = ctx.db();
  const input = payload as StockAdjustPayload;

  // Read current stock.
  const row = db.prepare(`
    SELECT item_id AS itemId, available_qty AS availableQty
    FROM catalog_item
    WHERE item_id = ? AND branch_id = ?
  `).get(input.itemId, ctx.branchId) as
    | { itemId: string; availableQty: string }
    | undefined;

  if (!row) {
    throw Object.assign(
      new Error(`Item not found in catalog: ${input.itemId}`),
      { code: 'E_SCHEMA', retryable: false },
    );
  }

  const previous = BigInt(row.availableQty);
  const delta = BigInt(input.quantity);
  const next = previous + delta;

  if (next < 0n) {
    throw Object.assign(
      new Error(
        `Insufficient stock for ${input.itemId}: available ${previous}, adjustment ${delta}`,
      ),
      {
        code: 'E_STOCK',
        retryable: false,
        details: {
          itemId: input.itemId,
          available: previous.toString(),
          adjustment: delta.toString(),
        },
      },
    );
  }

  const now = new Date().toISOString();
  const idempotencyKey = envelope.idempotencyKey || randomUUID();
  const adjustId = randomUUID();

  // Atomic: update catalog + write outbox.
  const commit = db.transaction(() => {
    db.prepare(`
      UPDATE catalog_item
      SET available_qty = ?, updated_at = ?
      WHERE item_id = ? AND branch_id = ?
    `).run(next.toString(), now, input.itemId, ctx.branchId);

    const outboxSeq = db.prepare(
      'SELECT COALESCE(MAX(seq), 0) + 1 AS next_seq FROM outbox',
    ).get() as { next_seq: number };

    db.prepare(`
      INSERT INTO outbox (id, seq, entity, entity_id, operation, payload,
        idempotency_key, state, created_at)
      VALUES (?, ?, 'stock', ?, 'ADJUST', ?, ?, 'PENDING', ?)
    `).run(
      adjustId,
      outboxSeq.next_seq,
      input.itemId,
      JSON.stringify({
        itemId: input.itemId,
        quantity: input.quantity,
        reason: input.reason ?? null,
        previousQty: previous.toString(),
        newQty: next.toString(),
      }),
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
    throw err;
  }

  return {
    itemId: input.itemId,
    previousQty: previous.toString(),
    newQty: next.toString(),
  };
}
