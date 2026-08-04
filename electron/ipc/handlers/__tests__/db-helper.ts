import Database from 'better-sqlite3-multiple-ciphers';
import { runMigrations } from '../../../database/migrations';
import type { SqliteDatabase } from '../../../database/types';

export function createTestDb(): SqliteDatabase {
  const raw = new Database(':memory:') as unknown as SqliteDatabase;
  raw.pragma('journal_mode = WAL');
  raw.pragma('foreign_keys = ON');
  runMigrations(raw);
  return raw;
}

export function seedCatalog(db: SqliteDatabase): void {
  const now = new Date().toISOString();
  const items = [
    ['cat-001', 'poc-branch', 'ITEM-001', 'Cement 50kg', 'BRC001', '12000', '0', 'VAT', '18', '500', 'UNIT', now],
    ['cat-002', 'poc-branch', 'ITEM-002', 'Steel Bar 12mm', 'BRC002', '8500', '0', 'VAT', '18', '200', 'UNIT', now],
  ];

  const insert = db.prepare(`
    INSERT INTO catalog_item (item_id, branch_id, item_code, item_name, barcode,
      selling_price, discount, tax_category_name, tax_category_rate,
      available_qty, sell_mode, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  for (const row of items) {
    insert.run(...row);
  }
}

export function seedDeviceSession(db: SqliteDatabase): void {
  db.prepare(`
    INSERT INTO device_session (device_id, tenant_id, branch_id, receipt_prefix, receipt_seq, activated_at)
    VALUES ('poc-device-001', 'poc-tenant', 'poc-branch', 'RCP', 0, ?)
  `).run(new Date().toISOString());
}
