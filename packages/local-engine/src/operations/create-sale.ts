/**
 * createSale: the local write path.
 *
 * One of the six hand-written operations. Everything it does happens inside a
 * single SQLite transaction, so a crash mid-sale leaves no partial sale, no
 * orphaned stock deduction, and no gap in the receipt chain.
 *
 * Steps, in order, and the order matters:
 *   1. Idempotency check      a double-tap must return the first sale, not make two
 *   2. Resolve each line      price, tax rate, and FEFO batch from the local catalog
 *   3. Validate stock         refuse before writing anything
 *   4. Compute totals         decimal arithmetic, tax extracted from gross
 *   5. Validate payment       CONFIRM must be covered; CREDIT becomes balance due
 *   6. Write sale + children
 *   7. Deduct stock           local projection, so the next sale sees it
 *   8. Issue receipt          hash-chained, sequence never reused (ADR-05)
 *   9. Enqueue outbox        payload frozen with the contract version
 *
 * The outbox payload is the ORIGINAL request body, not our computed sale. The
 * server recomputes totals authoritatively; sending our numbers would invite a
 * silent disagreement where the receipt says one thing and the back office says
 * another. What we compute locally is what the cashier and the customer see now,
 * and the server's version wins on reconciliation.
 */

import { randomUUID } from 'crypto';
import {
  EngineError,
  insufficientStock,
  notFound,
  type OperationContext,
  type OperationResult,
} from '../contracts';
import * as D from '../domain/decimal';
import { getLogger } from '../logging/logger';
import type { SqliteDatabase } from '../store/types';
import { issueReceipt } from './receipt-chain';

const log = getLogger('create-sale');
import { rowToSale, type SaleDto } from '@bizuri/local-store';
import type { SaleLineRow, SalePaymentRow, SaleRow } from '@bizuri/local-store';

// ---------------------------------------------------------------------------
// Request shape (already validated by gate 4)
// ---------------------------------------------------------------------------

interface CreateSaleBody {
  intent?: 'DRAFT' | 'CONFIRM';
  customerId?: string;
  client?: { fullName?: string; tin?: string; phone?: string };
  payments?: { method: string; amount: string }[];
  creditDueDate?: string;
  deviceId?: string;
  currencyCode?: string;
  lines: {
    itemId: string;
    batchId?: string;
    quantity: string;
    unitPrice?: string;
    discountPercentage?: string;
  }[];
}

interface CatalogLookup {
  item_id: string;
  item_name: string;
  sell_mode: string;
  selling_price: string | null;
  discount: string | null;
  tax_category_rate: string | null;
  unit_of_measure_name: string | null;
  current_batch_id: string | null;
  available_qty: string | null;
}

export interface CreateSaleDeps {
  readonly db: SqliteDatabase;
  readonly deviceId: string;
  readonly contractVersion: string;
  /** Injectable so tests are deterministic. */
  readonly now?: () => string;
  readonly newId?: () => string;
}

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

export function makeCreateSale(deps: CreateSaleDeps) {
  const now = deps.now ?? (() => new Date().toISOString());
  const newId = deps.newId ?? (() => randomUUID());

  return function createSale(ctx: OperationContext): OperationResult<unknown> {
    const { db } = deps;
    const body = ctx.request.body as CreateSaleBody;
    const tenantId = ctx.tenantId;
    const branchId = ctx.branchId;

    if (!branchId) {
      throw new EngineError('E_SCHEMA', 'X-Branch-Id is required to create a sale.');
    }

    // Idempotency key comes from the caller when present, so a retried IPC call
    // is deduplicated. When absent we mint one, because the outbox needs a stable
    // key to send to the server regardless.
    const idempotencyKey = ctx.idempotencyKey ?? `local-${newId()}`;
    const intent = body.intent ?? 'CONFIRM';

    const run = db.transaction((): SaleDto => {
      // --- 1. Idempotency -------------------------------------------------
      const existing = db
        .prepare('SELECT id FROM sales WHERE idempotency_key = ?')
        .get(idempotencyKey) as { id: string } | undefined;

      if (existing) {
        // Return the original rather than erroring: a double submit is the UI
        // being retried, and the cashier should see the sale they already made.
        return loadSale(db, existing.id);
      }

      // --- 2. Resolve lines ------------------------------------------------
      const resolved = body.lines.map((line, index) => {
        const catalog = db
          .prepare(
            `SELECT item_id, item_name, sell_mode, selling_price, discount,
                    tax_category_rate, unit_of_measure_name, current_batch_id,
                    available_qty
               FROM sales_catalog
              WHERE tenant_id = ? AND branch_id = ? AND item_id = ? AND deleted = 0`,
          )
          .get(tenantId, branchId, line.itemId) as CatalogLookup | undefined;

        if (!catalog) throw notFound(`Item ${line.itemId}`);

        const quantity = D.parse(line.quantity);
        if (!D.gt(quantity, D.ZERO)) {
          throw new EngineError('E_SCHEMA', `Line ${index + 1}: quantity must be positive.`);
        }

        // An explicit unitPrice overrides the catalog price. The contract allows
        // this for authorised users; authorisation is the server's call, and it
        // will reject on push if the operator was not permitted.
        const unitPrice = line.unitPrice
          ? D.parse(line.unitPrice)
          : D.parse(catalog.selling_price);

        if (D.isZero(unitPrice)) {
          throw new EngineError(
            'E_SCHEMA',
            `Line ${index + 1}: no price available for "${catalog.item_name}".`,
          );
        }

        // Line discount falls back to the batch discount carried on the catalog
        // row, matching what the sales screen shows.
        const discountPct = line.discountPercentage
          ? D.parse(line.discountPercentage)
          : D.parse(catalog.discount);

        const taxRate = D.parse(catalog.tax_category_rate);

        // FEFO: the catalog row already carries the first-expiring active batch,
        // so honouring an explicit batchId and otherwise taking that is the same
        // selection the server would make.
        const batchId = line.batchId ?? catalog.current_batch_id;

        return {
          index,
          itemId: catalog.item_id,
          itemName: catalog.item_name,
          sellMode: catalog.sell_mode,
          batchId,
          quantity,
          unitPrice,
          discountPct,
          taxRate,
          uom: catalog.unit_of_measure_name,
          availableQty: D.parse(catalog.available_qty),
        };
      });

      // --- 3. Validate stock ----------------------------------------------
      // Before any write. MADE_TO_ORDER items hold no finished-goods stock, so
      // they are exempt: that is the whole point of the sell mode.
      const shortfalls = resolved
        .filter((l) => l.sellMode === 'IN_STOCK' && D.gt(l.quantity, l.availableQty))
        .map((l) => ({
          itemId: l.itemId,
          itemName: l.itemName,
          requested: D.format(l.quantity),
          available: D.format(l.availableQty),
        }));

      if (shortfalls.length > 0) {
        throw insufficientStock({ lines: shortfalls });
      }

      // --- 4. Totals -------------------------------------------------------
      const lines = resolved.map((l) => {
        const grossBeforeDiscount = D.mul(l.unitPrice, l.quantity);
        const discountAmount = D.percentOf(grossBeforeDiscount, l.discountPct);
        const lineTotal = D.sub(grossBeforeDiscount, discountAmount);

        // unitPrice is tax-inclusive per the contract, so net is extracted from
        // the discounted gross rather than added on top.
        const lineSubtotal = D.netFromGross(lineTotal, l.taxRate);
        const taxAmount = D.sub(lineTotal, lineSubtotal);

        return { ...l, discountAmount, lineSubtotal, taxAmount, lineTotal };
      });

      const subtotal = D.sum(lines.map((l) => l.lineSubtotal));
      const taxTotal = D.sum(lines.map((l) => l.taxAmount));
      const discountTotal = D.sum(lines.map((l) => l.discountAmount));
      const grandTotal = D.sum(lines.map((l) => l.lineTotal));
      const totalItems = D.sum(lines.map((l) => l.quantity));

      // --- 5. Payments -----------------------------------------------------
      const payments = body.payments ?? [];
      const creditAmount = D.sum(
        payments.filter((p) => p.method === 'CREDIT').map((p) => D.parse(p.amount)),
      );
      const tendered = D.sum(
        payments.filter((p) => p.method !== 'CREDIT').map((p) => D.parse(p.amount)),
      );
      const totalAllocated = D.add(tendered, creditAmount);

      if (intent === 'CONFIRM') {
        if (payments.length === 0) {
          throw new EngineError('E_SCHEMA', 'Confirming a sale requires at least one payment.');
        }
        if (D.lt(totalAllocated, grandTotal)) {
          throw new EngineError('E_SCHEMA', 'Payments do not cover the sale total.', false, {
            grandTotal: D.format(grandTotal),
            allocated: D.format(totalAllocated),
          });
        }
        if (!D.isZero(creditAmount) && !body.creditDueDate) {
          throw new EngineError('E_SCHEMA', 'creditDueDate is required when paying on credit.');
        }
      }

      // Change is only ever given against non-credit tender, and never negative.
      const changeGiven = D.max(D.sub(tendered, D.sub(grandTotal, creditAmount)), D.ZERO);
      const balanceDue = creditAmount;
      const amountPaid = D.sub(tendered, changeGiven);

      // --- 6. Write --------------------------------------------------------
      const saleId = newId();
      const createdAt = now();
      const localSeq = nextLocalSeq(db);

      // Provisional, prefixed so it is unmistakably device-issued. Replaced with
      // the server's saleNumber when the push acknowledgement arrives.
      const saleNumber = `L-${deps.deviceId.slice(0, 6)}-${localSeq}`;

      db.prepare(
        `INSERT INTO sales (
           tenant_id, branch_id, id, sale_number, status, customer_id,
           client_name, client_tin, client_phone, credit_due_date, device_id,
           currency_code, subtotal, discount_total, tax_total, grand_total,
           amount_paid, change_given, balance_due, total_items, confirmed_at,
           created_at, idempotency_key, server_id, sync_state, local_seq
         ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,NULL,'PENDING',?)`,
      ).run(
        tenantId, branchId, saleId, saleNumber,
        intent === 'CONFIRM' ? 'CONFIRMED' : 'DRAFT',
        body.customerId ?? null,
        body.client?.fullName ?? null,
        body.client?.tin ?? null,
        body.client?.phone ?? null,
        body.creditDueDate ?? null,
        body.deviceId ?? deps.deviceId,
        body.currencyCode ?? null,
        D.format(subtotal), D.format(discountTotal), D.format(taxTotal),
        D.format(grandTotal), D.format(amountPaid), D.format(changeGiven),
        D.format(balanceDue), D.format(totalItems),
        intent === 'CONFIRM' ? createdAt : null,
        createdAt, idempotencyKey, localSeq,
      );

      const insertLine = db.prepare(
        `INSERT INTO sale_lines (
           id, sale_id, line_no, item_id, item_name, batch_id, quantity,
           unit_price, discount_percentage, discount_amount, tax_amount,
           line_subtotal, line_total, uom
         ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      );

      for (const l of lines) {
        insertLine.run(
          newId(), saleId, l.index + 1, l.itemId, l.itemName, l.batchId,
          D.format(l.quantity), D.format(l.unitPrice),
          D.isZero(l.discountPct) ? null : D.format(l.discountPct),
          D.format(l.discountAmount), D.format(l.taxAmount),
          D.format(l.lineSubtotal), D.format(l.lineTotal), l.uom,
        );
      }

      const insertPayment = db.prepare(
        `INSERT INTO sale_payments (id, sale_id, method, amount) VALUES (?,?,?,?)`,
      );
      for (const p of payments) {
        insertPayment.run(newId(), saleId, p.method, D.format(D.parse(p.amount)));
      }

      // --- 7. Deduct stock -------------------------------------------------
      // The local projection only. The server recomputes from its own ledger; this
      // exists so the next sale in the same shift sees the reduced quantity.
      if (intent === 'CONFIRM') {
        deductStock(db, tenantId, branchId, lines);
      }

      // --- 8. Receipt ------------------------------------------------------
      if (intent === 'CONFIRM') {
        issueReceipt(db, {
          tenantId,
          saleId,
          deviceId: deps.deviceId,
          grandTotal: D.format(grandTotal),
          issuedAt: createdAt,
          newId,
        });
      }

      // --- 9. Outbox -------------------------------------------------------
      // The original body, frozen, tagged with the contract version. Never
      // reshaped by a later build: that is what makes the server's upcaster
      // chain correct for a device that has been offline for weeks.
      db.prepare(
        `INSERT INTO outbox (
           tenant_id, id, seq, aggregate_type, aggregate_id, operation_id,
           contract_version, payload, idempotency_key, state, attempts,
           batch_id, leased_until, last_error, created_at
         ) VALUES (?,?,?,?,?,?,?,?,?,'PENDING',0,NULL,NULL,NULL,?)`,
      ).run(
        tenantId, newId(), localSeq, 'Sale', saleId, 'createSale',
        deps.contractVersion, JSON.stringify(body), idempotencyKey, createdAt,
      );

      return loadSale(db, saleId);
    });

    const sale = run();

    // The money line. A sale that exists locally but never reaches the server
    // is the failure this whole architecture is built to survive, so the local
    // commit is recorded at INFO with everything needed to trace it: the sale
    // number the cashier read off the screen, and the idempotency key the
    // outbox will push under.
    log.info(`Sale ${sale.saleNumber} committed locally`, {
      code: '201',
      tenantId,
      context: {
        saleId: sale.id,
        saleNumber: sale.saleNumber,
        status: sale.status,
        grandTotal: sale.grandTotal,
        lines: sale.lines.length,
        idempotencyKey,
        branchId,
      },
    });

    // Wrap in the same envelope the real API uses so the renderer's
    // `res?.data` accessor works identically for local and remote responses.
    return {
      status: 201,
      data: { success: true, message: 'Request successful', data: sale },
      durableAt: now(),
    };
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function deductStock(
  db: SqliteDatabase,
  tenantId: string,
  branchId: string,
  lines: readonly { itemId: string; quantity: D.Decimal; sellMode: string }[],
): void {
  const readCatalog = db.prepare(
    `SELECT available_qty FROM sales_catalog
      WHERE tenant_id = ? AND branch_id = ? AND item_id = ?`,
  );
  const writeCatalog = db.prepare(
    `UPDATE sales_catalog SET available_qty = ?
      WHERE tenant_id = ? AND branch_id = ? AND item_id = ?`,
  );
  const readBalance = db.prepare(
    `SELECT on_hand_qty, available_qty FROM stock_balances
      WHERE tenant_id = ? AND branch_id = ? AND item_id = ?`,
  );
  const writeBalance = db.prepare(
    `UPDATE stock_balances SET on_hand_qty = ?, available_qty = ?
      WHERE tenant_id = ? AND branch_id = ? AND item_id = ?`,
  );

  for (const line of lines) {
    if (line.sellMode !== 'IN_STOCK') continue;

    const cat = readCatalog.get(tenantId, branchId, line.itemId) as
      | { available_qty: string | null }
      | undefined;
    if (cat) {
      // Clamped at zero: a negative available quantity would render as a negative
      // stock figure on the sales screen, which reads as a bug to the cashier.
      const next = D.max(D.sub(D.parse(cat.available_qty), line.quantity), D.ZERO);
      writeCatalog.run(D.format(next), tenantId, branchId, line.itemId);
    }

    const bal = readBalance.get(tenantId, branchId, line.itemId) as
      | { on_hand_qty: string; available_qty: string }
      | undefined;
    if (bal) {
      writeBalance.run(
        D.format(D.max(D.sub(D.parse(bal.on_hand_qty), line.quantity), D.ZERO)),
        D.format(D.max(D.sub(D.parse(bal.available_qty), line.quantity), D.ZERO)),
        tenantId,
        branchId,
        line.itemId,
      );
    }
  }
}

/**
 * Next device-local sequence.
 *
 * Taken from the outbox rather than a counter table, so it cannot drift from the
 * rows it orders. Called inside the caller's transaction, so two concurrent sales
 * cannot both read the same maximum.
 */
function nextLocalSeq(db: SqliteDatabase): number {
  const row = db.prepare('SELECT COALESCE(MAX(seq), 0) AS seq FROM outbox').get() as
    | { seq: number }
    | undefined;
  return (row?.seq ?? 0) + 1;
}

export function loadSale(db: SqliteDatabase, saleId: string): SaleDto {
  const sale = db.prepare('SELECT * FROM sales WHERE id = ?').get(saleId) as
    | SaleRow
    | undefined;
  if (!sale) throw notFound(`Sale ${saleId}`);

  const lines = db
    .prepare('SELECT * FROM sale_lines WHERE sale_id = ? ORDER BY line_no')
    .all(saleId) as unknown as SaleLineRow[];
  const payments = db
    .prepare('SELECT * FROM sale_payments WHERE sale_id = ?')
    .all(saleId) as unknown as SalePaymentRow[];

  return rowToSale(sale, lines, payments);
}
