import { handleCatalogSearch } from '../catalog-handlers';
import type { CatalogContext } from '../catalog-handlers';
import { createTestDb, seedCatalog } from './db-helper';
import type { SqliteDatabase } from '../../../database/types';

function makeEnvelope() {
  return {
    v: 1 as const,
    id: 'req-001',
    name: 'catalog.search' as const,
    issuedAt: new Date().toISOString(),
    payload: {},
  };
}

describe('handleCatalogSearch', () => {
  let db: SqliteDatabase;

  beforeEach(() => {
    db = createTestDb();
    seedCatalog(db);
  });

  function ctx(): CatalogContext {
    return { db: () => db, branchId: 'poc-branch' };
  }

  it('returns all items with empty query', () => {
    const result = handleCatalogSearch({}, makeEnvelope(), ctx());
    expect(result.total).toBe(2);
    expect(result.items).toHaveLength(2);
  });

  it('searches by item name', () => {
    const result = handleCatalogSearch({ query: 'Cement' }, makeEnvelope(), ctx());
    expect(result.total).toBe(1);
    expect(result.items[0].itemName).toBe('Cement 50kg');
  });

  it('searches by item code', () => {
    const result = handleCatalogSearch({ query: 'ITEM-002' }, makeEnvelope(), ctx());
    expect(result.total).toBe(1);
    expect(result.items[0].itemCode).toBe('ITEM-002');
  });

  it('searches by barcode', () => {
    const result = handleCatalogSearch({ query: 'BRC001' }, makeEnvelope(), ctx());
    expect(result.total).toBe(1);
  });

  it('supports pagination with limit and offset', () => {
    const result = handleCatalogSearch({ limit: 1, offset: 0 }, makeEnvelope(), ctx());
    expect(result.items).toHaveLength(1);
    expect(result.total).toBe(2);
  });

  it('returns empty when no items match', () => {
    const result = handleCatalogSearch({ query: 'nonexistent' }, makeEnvelope(), ctx());
    expect(result.items).toHaveLength(0);
  });

  it('returns items sorted by name ascending', () => {
    const result = handleCatalogSearch({}, makeEnvelope(), ctx());
    const names = result.items.map((i) => i.itemName);
    expect(names[0] < names[1]).toBe(true);
  });

  it('maps column names to camelCase', () => {
    const result = handleCatalogSearch({ query: 'Cement' }, makeEnvelope(), ctx());
    const item = result.items[0];
    expect(item).toHaveProperty('itemId');
    expect(item).toHaveProperty('itemCode');
    expect(item).toHaveProperty('itemName');
    expect(item).toHaveProperty('sellingPrice');
    expect(item).toHaveProperty('taxCategoryName');
    expect(item).toHaveProperty('availableQty');
  });
});
