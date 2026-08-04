import { handleSaleCreate, handleSaleGet, handleSaleList } from '../sale-handlers';
import type { SaleContext } from '../sale-handlers';
import { createTestDb, seedCatalog, seedDeviceSession } from './db-helper';
import type { SqliteDatabase } from '../../../database/types';

function makeEnvelope(overrides = {}) {
  return {
    v: 1 as const,
    id: 'req-001',
    name: 'sale.create' as const,
    issuedAt: new Date().toISOString(),
    payload: {},
    ...overrides,
  };
}

describe('sale handlers', () => {
  let db: SqliteDatabase;

  beforeEach(() => {
    db = createTestDb();
    seedDeviceSession(db);
    seedCatalog(db);
  });

  function ctx(): SaleContext {
    return {
      db: () => db,
      deviceId: 'poc-device-001',
      tenantId: 'poc-tenant',
      branchId: 'poc-branch',
      receiptPrefix: 'RCP',
    };
  }

  describe('handleSaleCreate', () => {
    const payload = {
      items: [
        { itemId: 'cat-001', quantity: 2 },
        { itemId: 'cat-002', quantity: 1 },
      ],
      amountPaid: '32500',
    };

    it('creates a sale and returns sale row with receipt number', () => {
      const result = handleSaleCreate(payload, makeEnvelope(), ctx());
      expect(result.sale.saleNumber).toBeDefined();
      expect(result.receiptNumber).toBeDefined();
      expect(result.sale.status).toBe('CONFIRMED');
      expect(result.sale.syncState).toBe('PENDING');
    });

    it('persists the sale to the database', () => {
      const result = handleSaleCreate(payload, makeEnvelope(), ctx());
      const row = db.prepare('SELECT * FROM sale WHERE id = ?').get(result.sale.id) as Record<string, unknown>;
      expect(row).toBeDefined();
      expect(row.status).toBe('CONFIRMED');
    });

    it('creates a receipt row', () => {
      const result = handleSaleCreate(payload, makeEnvelope(), ctx());
      const receipt = db.prepare('SELECT * FROM receipt WHERE sale_id = ?').get(result.sale.id) as Record<string, unknown>;
      expect(receipt).toBeDefined();
      expect(receipt.receipt_number).toBe(result.receiptNumber);
    });

    it('writes an outbox row', () => {
      handleSaleCreate(payload, makeEnvelope(), ctx());
      const count = db.prepare("SELECT COUNT(*) AS c FROM outbox WHERE entity = 'sale'").get() as { c: number };
      expect(count.c).toBe(1);
    });

    it('increments the receipt sequence', () => {
      handleSaleCreate(payload, makeEnvelope(), ctx());
      const session = db.prepare('SELECT receipt_seq FROM device_session').get() as { receipt_seq: number };
      expect(session.receipt_seq).toBe(1);
    });

    it('throws when items array is empty', () => {
      expect(() =>
        handleSaleCreate({ items: [], amountPaid: '1000' }, makeEnvelope(), ctx()),
      ).toThrow();
    });

    it('throws for unknown catalog item', () => {
      expect(() =>
        handleSaleCreate(
          { items: [{ itemId: 'unknown', quantity: 1 }], amountPaid: '1000' },
          makeEnvelope(),
          ctx(),
        ),
      ).toThrow();
    });

    it('throws when stock is insufficient', () => {
      expect(() =>
        handleSaleCreate(
          { items: [{ itemId: 'cat-001', quantity: 9999 }], amountPaid: '1000' },
          makeEnvelope(),
          ctx(),
        ),
      ).toThrow();
      try {
        handleSaleCreate(
          { items: [{ itemId: 'cat-001', quantity: 9999 }], amountPaid: '1000' },
          makeEnvelope(),
          ctx(),
        );
      } catch (err: unknown) {
        const e = err as Error & { code: string };
        expect(e.code).toBe('E_STOCK');
      }
    });

    it('computed grand total includes tax', () => {
      const result = handleSaleCreate(payload, makeEnvelope(), ctx());
      // Cement: 12000.00 * 2 = 24000.00, tax 18% = 4320.00
      // Steel:  8500.00 * 1 =  8500.00, tax 18% = 1530.00
      // Grand total: 28320.00 + 10030.00 = 38350.00
      expect(result.sale.grandTotal).toBe('38350.00');
    });
  });

  describe('handleSaleGet', () => {
    it('returns a sale by ID', () => {
      const created = handleSaleCreate(
        { items: [{ itemId: 'cat-001', quantity: 1 }], amountPaid: '12000' },
        makeEnvelope(),
        ctx(),
      );
      const result = handleSaleGet({ saleId: created.sale.id }, makeEnvelope(), ctx());
      expect(result).not.toBeNull();
      expect(result!.id).toBe(created.sale.id);
    });

    it('returns null for unknown saleId', () => {
      const result = handleSaleGet({ saleId: 'nonexistent' }, makeEnvelope(), ctx());
      expect(result).toBeNull();
    });

    it('throws when saleId is missing', () => {
      expect(() => handleSaleGet({}, makeEnvelope(), ctx())).toThrow();
    });
  });

  describe('handleSaleList', () => {
    beforeEach(() => {
      handleSaleCreate(
        { items: [{ itemId: 'cat-001', quantity: 1 }], amountPaid: '12000' },
        makeEnvelope(),
        ctx(),
      );
      handleSaleCreate(
        { items: [{ itemId: 'cat-002', quantity: 1 }], amountPaid: '8500' },
        makeEnvelope(),
        ctx(),
      );
    });

    it('lists all sales', () => {
      const result = handleSaleList({}, makeEnvelope(), ctx());
      expect(result.total).toBe(2);
      expect(result.sales).toHaveLength(2);
    });

    it('filters by syncState', () => {
      const result = handleSaleList({ syncState: 'PENDING' }, makeEnvelope(), ctx());
      expect(result.total).toBe(2);
    });

    it('supports pagination', () => {
      const result = handleSaleList({ limit: 1, offset: 0 }, makeEnvelope(), ctx());
      expect(result.sales).toHaveLength(1);
      expect(result.total).toBe(2);
    });
  });
});
