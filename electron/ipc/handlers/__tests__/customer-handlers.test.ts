import { handleCustomerCreate, handleCustomerSearch } from '../customer-handlers';
import type { CustomerContext } from '../customer-handlers';
import { createTestDb, seedDeviceSession } from './db-helper';
import type { SqliteDatabase } from '../../../database/types';

function makeEnvelope(overrides = {}) {
  return {
    v: 1 as const,
    id: 'req-001',
    name: 'customer.create' as const,
    issuedAt: new Date().toISOString(),
    payload: {},
    ...overrides,
  };
}

describe('customer handlers', () => {
  let db: SqliteDatabase;

  beforeEach(() => {
    db = createTestDb();
    seedDeviceSession(db);
  });

  function ctx(): CustomerContext {
    return { db: () => db, deviceId: 'poc-device-001', tenantId: 'poc-tenant', branchId: 'poc-branch' };
  }

  describe('handleCustomerCreate', () => {
    it('creates a customer and returns the row', () => {
      const result = handleCustomerCreate(
        { customerName: 'Alice Umutoni', customerPhone: '0788000000' },
        makeEnvelope(),
        ctx(),
      );
      expect(result.customerName).toBe('Alice Umutoni');
      expect(result.customerPhone).toBe('0788000000');
      expect(result.syncState).toBe('PENDING');
    });

    it('persists the customer to the database', () => {
      const result = handleCustomerCreate(
        { customerName: 'Bob' },
        makeEnvelope(),
        ctx(),
      );
      const row = db.prepare('SELECT * FROM customer WHERE id = ?').get(result.id) as Record<string, unknown>;
      expect(row).toBeDefined();
      expect(row.customer_name).toBe('Bob');
    });

    it('writes an outbox row', () => {
      handleCustomerCreate({ customerName: 'Charlie' }, makeEnvelope(), ctx());
      const count = db.prepare("SELECT COUNT(*) AS c FROM outbox WHERE entity = 'customer'").get() as { c: number };
      expect(count.c).toBe(1);
    });

    it('accepts all optional fields', () => {
      const result = handleCustomerCreate(
        {
          customerName: 'Diana',
          customerTin: 'TIN-001',
          customerPhone: '0788111222',
          customerEmail: 'diana@example.com',
          address: 'Kigali, Rwanda',
        },
        makeEnvelope(),
        ctx(),
      );
      expect(result.customerTin).toBe('TIN-001');
      expect(result.customerEmail).toBe('diana@example.com');
      expect(result.address).toBe('Kigali, Rwanda');
    });

    it('uses idempotency key from envelope', () => {
      const result = handleCustomerCreate(
        { customerName: 'Eve' },
        makeEnvelope({ idempotencyKey: 'ik-cust-001' }),
        ctx(),
      );
      expect(result.id).toBe('ik-cust-001');
    });
  });

  describe('handleCustomerSearch', () => {
    beforeEach(() => {
      handleCustomerCreate({ customerName: 'Alice Umutoni', customerTin: 'TIN-A', customerPhone: '0788000001' }, makeEnvelope(), ctx());
      handleCustomerCreate({ customerName: 'Bob Habimana', customerTin: 'TIN-B', customerPhone: '0788000002' }, makeEnvelope(), ctx());
      handleCustomerCreate({ customerName: 'Carol Iribagiza', customerTin: 'TIN-C', customerEmail: 'carol@test.com' }, makeEnvelope(), ctx());
    });

    it('returns all customers with no query', () => {
      const result = handleCustomerSearch({}, makeEnvelope(), ctx());
      expect(result.total).toBe(3);
      expect(result.customers).toHaveLength(3);
    });

    it('searches by name', () => {
      const result = handleCustomerSearch({ query: 'Alice' }, makeEnvelope(), ctx());
      expect(result.total).toBe(1);
      expect(result.customers[0].customerName).toBe('Alice Umutoni');
    });

    it('searches by TIN', () => {
      const result = handleCustomerSearch({ query: 'TIN-B' }, makeEnvelope(), ctx());
      expect(result.total).toBe(1);
      expect(result.customers[0].customerTin).toBe('TIN-B');
    });

    it('searches by phone', () => {
      const result = handleCustomerSearch({ query: '0788000002' }, makeEnvelope(), ctx());
      expect(result.total).toBe(1);
    });

    it('searches by email', () => {
      const result = handleCustomerSearch({ query: 'carol@test.com' }, makeEnvelope(), ctx());
      expect(result.total).toBe(1);
    });

    it('supports pagination with limit and offset', () => {
      const result = handleCustomerSearch({ limit: 2, offset: 1 }, makeEnvelope(), ctx());
      expect(result.customers).toHaveLength(2);
      expect(result.total).toBe(3);
    });

    it('returns empty when no customers match', () => {
      const result = handleCustomerSearch({ query: 'nonexistent' }, makeEnvelope(), ctx());
      expect(result.customers).toHaveLength(0);
      expect(result.total).toBe(0);
    });

    it('orders results by name ascending', () => {
      const result = handleCustomerSearch({}, makeEnvelope(), ctx());
      const names = result.customers.map((c) => c.customerName);
      const sorted = [...names].sort();
      expect(names).toEqual(sorted);
    });
  });
});
