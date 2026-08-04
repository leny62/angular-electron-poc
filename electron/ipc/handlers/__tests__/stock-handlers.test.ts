import { handleStockBalance, handleStockAdjust } from '../stock-handlers';
import type { StockContext } from '../stock-handlers';
import { createTestDb, seedCatalog, seedDeviceSession } from './db-helper';
import type { SqliteDatabase } from '../../../database/types';

function makeEnvelope(overrides = {}) {
  return {
    v: 1 as const,
    id: 'req-001',
    name: 'stock.balance' as const,
    issuedAt: new Date().toISOString(),
    payload: {},
    ...overrides,
  };
}

describe('stock handlers', () => {
  let db: SqliteDatabase;

  beforeEach(() => {
    db = createTestDb();
    seedDeviceSession(db);
    seedCatalog(db);
  });

  function ctx(): StockContext {
    return { db: () => db, deviceId: 'poc-device-001', branchId: 'poc-branch' };
  }

  describe('handleStockBalance', () => {
    it('returns all items when no filter is provided', () => {
      const result = handleStockBalance({}, makeEnvelope(), ctx());
      expect(result.items).toHaveLength(2);
    });

    it('filters by itemIds', () => {
      const result = handleStockBalance({ itemIds: ['cat-001'] }, makeEnvelope(), ctx());
      expect(result.items).toHaveLength(1);
      expect(result.items[0].itemId).toBe('cat-001');
    });

    it('returns empty array for unknown itemIds', () => {
      const result = handleStockBalance({ itemIds: ['nonexistent'] }, makeEnvelope(), ctx());
      expect(result.items).toHaveLength(0);
    });

    it('returns itemId, itemCode, itemName, availableQty, sellMode', () => {
      const result = handleStockBalance({}, makeEnvelope(), ctx());
      expect(result.items[0]).toHaveProperty('itemId');
      expect(result.items[0]).toHaveProperty('itemCode');
      expect(result.items[0]).toHaveProperty('itemName');
      expect(result.items[0]).toHaveProperty('availableQty');
      expect(result.items[0]).toHaveProperty('sellMode');
    });
  });

  describe('handleStockAdjust', () => {
    it('adjusts stock upward and returns new quantity', () => {
      const result = handleStockAdjust(
        { itemId: 'cat-001', quantity: 10 },
        makeEnvelope(),
        ctx(),
      );
      expect(result.itemId).toBe('cat-001');
      expect(result.previousQty).toBe('500');
      expect(result.newQty).toBe('510');
    });

    it('adjusts stock downward and returns new quantity', () => {
      const result = handleStockAdjust(
        { itemId: 'cat-001', quantity: -5 },
        makeEnvelope(),
        ctx(),
      );
      expect(result.newQty).toBe('495');
    });

    it('persists the adjustment to the catalog', () => {
      handleStockAdjust({ itemId: 'cat-001', quantity: 5 }, makeEnvelope(), ctx());
      const row = db.prepare(
        'SELECT available_qty FROM catalog_item WHERE item_id = ?',
      ).get('cat-001') as { available_qty: string };
      expect(row.available_qty).toBe('505');
    });

    it('writes an outbox row for the adjustment', () => {
      handleStockAdjust({ itemId: 'cat-001', quantity: 5 }, makeEnvelope(), ctx());
      const count = db.prepare(
        "SELECT COUNT(*) AS c FROM outbox WHERE entity = 'stock'",
      ).get() as { c: number };
      expect(count.c).toBe(1);
    });

    it('throws for unknown itemId', () => {
      expect(() =>
        handleStockAdjust({ itemId: 'unknown', quantity: 1 }, makeEnvelope(), ctx()),
      ).toThrow();
    });

    it('throws when adjustment would make stock negative', () => {
      expect(() =>
        handleStockAdjust({ itemId: 'cat-001', quantity: -9999 }, makeEnvelope(), ctx()),
      ).toThrow();
      try {
        handleStockAdjust({ itemId: 'cat-001', quantity: -9999 }, makeEnvelope(), ctx());
      } catch (err: unknown) {
        const e = err as Error & { code: string };
        expect(e.code).toBe('E_STOCK');
      }
    });

    it('rolls back on error without persisting changes', () => {
      const before = db.prepare(
        'SELECT available_qty FROM catalog_item WHERE item_id = ?',
      ).get('cat-001') as { available_qty: string };

      try {
        handleStockAdjust({ itemId: 'cat-001', quantity: -9999 }, makeEnvelope(), ctx());
      } catch { /* expected */ }

      const after = db.prepare(
        'SELECT available_qty FROM catalog_item WHERE item_id = ?',
      ).get('cat-001') as { available_qty: string };
      expect(after.available_qty).toBe(before.available_qty);
    });

    it('uses idempotency key from envelope when provided', () => {
      handleStockAdjust(
        { itemId: 'cat-001', quantity: 1 },
        makeEnvelope({ idempotencyKey: 'ik-001' }),
        ctx(),
      );
      const row = db.prepare(
        "SELECT idempotency_key FROM outbox WHERE entity = 'stock'",
      ).get() as { idempotency_key: string };
      expect(row.idempotency_key).toBe('ik-001');
    });
  });
});
