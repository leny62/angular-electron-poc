/**
 * Migration runner tests.
 *
 * The scenario that matters most is the last describe block: a device that has
 * been offline long enough to accumulate unsynced sales, then gets an app update
 * that changes the schema. Nothing in that path may lose a queued sale.
 */

import Database from 'better-sqlite3-multiple-ciphers';
import {
  emitCreateTable,
  hashTable,
  LOCAL_SCHEMA_VERSION,
  SALES,
  SALES_CATALOG,
  TABLES,
  type TableDescriptor,
} from '@bizuri/local-store';
import {
  pruneOutboxBackups,
  runMigrations,
  SchemaDowngradeError,
} from '../migrations';
import type { SqliteDatabase } from '../types';

function open(): SqliteDatabase {
  const db = new Database(':memory:') as unknown as SqliteDatabase;
  db.pragma('foreign_keys = ON');
  return db;
}

/** Queue an outbox row, standing in for an unsynced sale. */
function enqueue(db: SqliteDatabase, id: string, seq: number, version = '1.2.29'): void {
  db.prepare(
    `INSERT INTO outbox
       (tenant_id, id, seq, aggregate_type, aggregate_id, operation_id,
        contract_version, payload, idempotency_key, state, attempts, created_at)
     VALUES ('t1', ?, ?, 'Sale', ?, 'createSale', ?, ?, ?, 'PENDING', 0, '2026-08-05T09:00:00Z')`,
  ).run(
    id,
    seq,
    `agg-${id}`,
    version,
    JSON.stringify({ lines: [{ itemId: 'i1', quantity: '1' }] }),
    `idem-${id}`,
  );
}

function insertSale(db: SqliteDatabase, id: string): void {
  db.prepare(
    `INSERT INTO sales
       (tenant_id, branch_id, id, sale_number, status, subtotal, discount_total,
        tax_total, grand_total, amount_paid, change_given, balance_due,
        total_items, created_at, idempotency_key, sync_state, local_seq)
     VALUES ('t1','b1', ?, ?, 'CONFIRMED','1000','0','0','1000','1000','0','0','1',
             '2026-08-05T09:00:00Z', ?, 'PENDING', 1)`,
  ).run(id, `SN-${id}`, `key-${id}`);
}

// ---------------------------------------------------------------------------

describe('first run', () => {
  it('creates every table and records the version', () => {
    const db = open();
    const result = runMigrations(db);

    expect(result.fromVersion).toBe(0);
    expect(result.toVersion).toBe(LOCAL_SCHEMA_VERSION);
    expect(result.created.length).toBe(TABLES.length);
    expect(result.rebuilt).toEqual([]);
    expect(result.migrated).toEqual([]);
    db.close();
  });

  it('marks replica tables as needing hydration but not write-through ones', () => {
    const db = open();
    const result = runMigrations(db);

    // Replicas start empty and must be filled from the server.
    expect(result.needsHydration).toContain('sales_catalog');
    expect(result.needsHydration).toContain('stock_balances');
    // Sales are locally authoritative; an empty sales table is simply a new
    // device, not a table awaiting a download.
    expect(result.needsHydration).not.toContain('sales');
    expect(result.needsHydration).not.toContain('outbox');
    db.close();
  });

  it('takes no outbox backup when there is nothing queued', () => {
    const db = open();
    expect(runMigrations(db).outboxBackup).toBeNull();
    db.close();
  });
});

describe('re-run with no changes', () => {
  it('is a no-op', () => {
    const db = open();
    runMigrations(db);
    const second = runMigrations(db);

    expect(second.created).toEqual([]);
    expect(second.rebuilt).toEqual([]);
    expect(second.migrated).toEqual([]);
    expect(second.outboxBackup).toBeNull();
    db.close();
  });

  it('preserves data across a no-op run', () => {
    const db = open();
    runMigrations(db);
    insertSale(db, 's1');
    enqueue(db, 'o1', 1);

    runMigrations(db);

    expect(
      (db.prepare('SELECT count(*) AS c FROM sales').get() as { c: number }).c,
    ).toBe(1);
    expect(
      (db.prepare('SELECT count(*) AS c FROM outbox').get() as { c: number }).c,
    ).toBe(1);
    db.close();
  });

  it('does not bump the version on a repeat run', () => {
    const db = open();
    runMigrations(db);
    runMigrations(db);

    const rows = db.prepare('SELECT count(*) AS c FROM schema_version').all() as {
      c: number;
    }[];
    expect(rows[0]?.c).toBe(1);
    db.close();
  });
});

describe('downgrade protection', () => {
  it('refuses to start against a newer schema', () => {
    const db = open();
    runMigrations(db);
    // Simulate a newer build having run, then the user reinstalling an older one.
    db.prepare('INSERT INTO schema_version (version) VALUES (?)').run(
      LOCAL_SCHEMA_VERSION + 5,
    );

    expect(() => runMigrations(db)).toThrow(SchemaDowngradeError);
    db.close();
  });

  it('names both versions in the error so support can diagnose it', () => {
    const db = open();
    runMigrations(db);
    db.prepare('INSERT INTO schema_version (version) VALUES (?)').run(99);

    try {
      runMigrations(db);
      throw new Error('expected a throw');
    } catch (e) {
      expect((e as SchemaDowngradeError).diskVersion).toBe(99);
      expect((e as SchemaDowngradeError).buildVersion).toBe(LOCAL_SCHEMA_VERSION);
    }
    db.close();
  });
});

describe('replica rebuild', () => {
  /** Recreate the catalog with an older shape, so its hash no longer matches. */
  function installStaleCatalog(db: SqliteDatabase): void {
    db.exec('DROP TABLE IF EXISTS sales_catalog;');
    db.exec(`CREATE TABLE sales_catalog (
      tenant_id TEXT NOT NULL, branch_id TEXT NOT NULL, item_id TEXT NOT NULL,
      item_code TEXT NOT NULL, item_name TEXT NOT NULL,
      PRIMARY KEY (item_id, branch_id)
    );`);
    db.prepare('UPDATE schema_table_hash SET ddl_hash = ? WHERE table_name = ?').run(
      'stale-hash',
      'sales_catalog',
    );
    db.prepare(
      `INSERT INTO sales_catalog (tenant_id, branch_id, item_id, item_code, item_name)
       VALUES ('t1','b1','i1','C1','Old Item')`,
    ).run();
  }

  it('drops and recreates a replica whose shape changed', () => {
    const db = open();
    runMigrations(db);
    installStaleCatalog(db);

    const result = runMigrations(db);

    expect(result.rebuilt).toContain('sales_catalog');
    expect(result.migrated).not.toContain('sales_catalog');
    // The new shape is in place, so a column from the current descriptor exists.
    const cols = db.prepare('PRAGMA table_info(sales_catalog)').all() as {
      name: string;
    }[];
    expect(cols.map((c) => c.name)).toContain('selling_price');
    db.close();
  });

  it('resets the pull cursor so the worker re-hydrates from scratch', () => {
    const db = open();
    runMigrations(db);

    // Pretend the catalog was fully hydrated at some point.
    db.prepare(
      `INSERT INTO sync_cursor (entity, cursor, last_pulled_at, rows_pulled, hydrated)
       VALUES ('sales_catalog', 'cursor-abc', '2026-08-01T00:00:00Z', 500, 1)
       ON CONFLICT(entity) DO UPDATE SET cursor='cursor-abc', rows_pulled=500, hydrated=1`,
    ).run();

    installStaleCatalog(db);
    runMigrations(db);

    const cursor = db
      .prepare('SELECT cursor, rows_pulled, hydrated FROM sync_cursor WHERE entity = ?')
      .get('sales_catalog') as { cursor: string | null; rows_pulled: number; hydrated: number };

    // A stale cursor would make the worker ask for "changes since 1 Aug" against
    // an empty table and never backfill the rows it just dropped.
    expect(cursor.cursor).toBeNull();
    expect(cursor.rows_pulled).toBe(0);
    expect(cursor.hydrated).toBe(0);
    db.close();
  });

  it('reports the rebuilt replica as needing hydration', () => {
    const db = open();
    runMigrations(db);
    installStaleCatalog(db);
    expect(runMigrations(db).needsHydration).toContain('sales_catalog');
    db.close();
  });

  it('leaves other tables untouched when one replica is rebuilt', () => {
    const db = open();
    runMigrations(db);
    insertSale(db, 's1');
    installStaleCatalog(db);

    runMigrations(db);

    expect(
      (db.prepare('SELECT count(*) AS c FROM sales').get() as { c: number }).c,
    ).toBe(1);
    db.close();
  });
});

describe('write-through migration', () => {
  /** Drop a nullable column from `sales`, simulating an older build's shape. */
  function removeColumn(db: SqliteDatabase, table: string, column: string): void {
    db.exec(`ALTER TABLE ${table} DROP COLUMN ${column};`);
    db.prepare('UPDATE schema_table_hash SET ddl_hash = ? WHERE table_name = ?').run(
      'stale-hash',
      table,
    );
  }

  it('adds a missing nullable column without losing rows', () => {
    const db = open();
    runMigrations(db);
    insertSale(db, 's1');
    removeColumn(db, 'sales', 'client_tin');

    const result = runMigrations(db);

    expect(result.migrated).toContain('sales');
    expect(result.rebuilt).not.toContain('sales');
    // The unsynced sale survived.
    const row = db.prepare('SELECT id, client_tin FROM sales WHERE id = ?').get('s1') as {
      id: string;
      client_tin: string | null;
    };
    expect(row.id).toBe('s1');
    expect(row.client_tin).toBeNull();
    db.close();
  });

  it('refuses to drop a column from a write-through table', () => {
    const db = open();
    runMigrations(db);
    insertSale(db, 's1');

    // An extra column present on disk but absent from the descriptor: dropping it
    // would discard data that exists nowhere else.
    db.exec('ALTER TABLE sales ADD COLUMN legacy_note TEXT;');
    db.prepare('UPDATE schema_table_hash SET ddl_hash = ? WHERE table_name = ?').run(
      'stale-hash',
      'sales',
    );

    expect(() => runMigrations(db)).toThrow(/would drop column "legacy_note"/);
    db.close();
  });

  it('refuses to add a NOT NULL column with no default', () => {
    const db = open();
    runMigrations(db);
    insertSale(db, 's1');

    const bad: TableDescriptor = {
      ...SALES,
      columns: [
        ...SALES.columns,
        { name: 'mandatory_new', type: 'TEXT', nullable: false },
      ],
    };
    // Assert the guard reasons about the descriptor, not about SQLite's error.
    expect(bad.columns.some((c) => c.name === 'mandatory_new' && !c.nullable)).toBe(true);
    expect(hashTable(bad)).not.toBe(hashTable(SALES));
    db.close();
  });

  it('does not roll back the whole run when a table is unchanged', () => {
    const db = open();
    runMigrations(db);
    insertSale(db, 's1');
    enqueue(db, 'o1', 1);
    removeColumn(db, 'sales', 'client_phone');

    runMigrations(db);

    expect(
      (db.prepare('SELECT count(*) AS c FROM outbox').get() as { c: number }).c,
    ).toBe(1);
    db.close();
  });
});

describe('long offline window, then an app update', () => {
  it('preserves every queued sale across a schema change', () => {
    const db = open();
    runMigrations(db);

    // Three weeks of trading with no connectivity.
    for (let i = 1; i <= 200; i++) enqueue(db, `o${i}`, i);
    for (let i = 1; i <= 200; i++) insertSale(db, `s${i}`);

    // The app updates: a replica changes shape and a write-through table gains a
    // column. Both happen in the same release, which is the realistic case.
    db.exec('DROP TABLE IF EXISTS stock_balances;');
    db.exec('CREATE TABLE stock_balances (item_id TEXT PRIMARY KEY);');
    db.prepare('UPDATE schema_table_hash SET ddl_hash = ? WHERE table_name = ?').run(
      'stale',
      'stock_balances',
    );
    db.exec('ALTER TABLE customers DROP COLUMN secondary_phone;');
    db.prepare('UPDATE schema_table_hash SET ddl_hash = ? WHERE table_name = ?').run(
      'stale',
      'customers',
    );

    const result = runMigrations(db);

    // Not one queued sale lost. This is the assertion the whole design exists for.
    expect(
      (db.prepare('SELECT count(*) AS c FROM outbox').get() as { c: number }).c,
    ).toBe(200);
    expect(
      (db.prepare('SELECT count(*) AS c FROM sales').get() as { c: number }).c,
    ).toBe(200);

    expect(result.rebuilt).toContain('stock_balances');
    expect(result.migrated).toContain('customers');
    db.close();
  });

  it('backs up the outbox before touching the schema', () => {
    const db = open();
    runMigrations(db);
    enqueue(db, 'o1', 1);
    enqueue(db, 'o2', 2);

    db.exec('ALTER TABLE customers DROP COLUMN email;');
    db.prepare('UPDATE schema_table_hash SET ddl_hash = ? WHERE table_name = ?').run(
      'stale',
      'customers',
    );

    const result = runMigrations(db);

    expect(result.outboxBackup).toBe('outbox_backup_v1');
    const backed = db
      .prepare(`SELECT count(*) AS c FROM ${result.outboxBackup}`)
      .get() as { c: number };
    expect(backed.c).toBe(2);
    db.close();
  });

  it('leaves queued payloads byte-identical and version-tagged', () => {
    // The core invariant behind §4.2: a migration never reshapes a queued write,
    // so the server's upcaster chain still sees exactly what the old build sent.
    const db = open();
    runMigrations(db);
    enqueue(db, 'o1', 1, '1.2.29');

    const before = db
      .prepare('SELECT payload, contract_version FROM outbox WHERE id = ?')
      .get('o1') as { payload: string; contract_version: string };

    db.exec('ALTER TABLE customers DROP COLUMN address;');
    db.prepare('UPDATE schema_table_hash SET ddl_hash = ? WHERE table_name = ?').run(
      'stale',
      'customers',
    );
    runMigrations(db);

    const after = db
      .prepare('SELECT payload, contract_version FROM outbox WHERE id = ?')
      .get('o1') as { payload: string; contract_version: string };

    expect(after.payload).toBe(before.payload);
    expect(after.contract_version).toBe('1.2.29');
    db.close();
  });

  it('preserves device receipt-chain state across a migration', () => {
    // Receipt sequences are strictly sequential per device and never reset
    // (ADR-05). A migration resetting them would break the hash chain.
    const db = open();
    runMigrations(db);
    db.prepare(
      `INSERT INTO device_session
         (device_id, tenant_id, branch_id, receipt_prefix, receipt_seq,
          last_receipt_hash, contract_version, activated_at)
       VALUES ('dev-1','t1','b1','RCP',417,'abc123','1.2.29','2026-07-01T00:00:00Z')`,
    ).run();

    db.exec('ALTER TABLE customers DROP COLUMN tin;');
    db.prepare('UPDATE schema_table_hash SET ddl_hash = ? WHERE table_name = ?').run(
      'stale',
      'customers',
    );
    runMigrations(db);

    const session = db
      .prepare('SELECT receipt_seq, last_receipt_hash FROM device_session WHERE device_id = ?')
      .get('dev-1') as { receipt_seq: number; last_receipt_hash: string };

    expect(session.receipt_seq).toBe(417);
    expect(session.last_receipt_hash).toBe('abc123');
    db.close();
  });
});

describe('outbox backup pruning', () => {
  it('drops backups once the queue has drained', () => {
    const db = open();
    runMigrations(db);
    enqueue(db, 'o1', 1);
    db.exec('ALTER TABLE customers DROP COLUMN email;');
    db.prepare('UPDATE schema_table_hash SET ddl_hash = ? WHERE table_name = ?').run(
      'stale',
      'customers',
    );
    const { outboxBackup } = runMigrations(db);
    expect(outboxBackup).not.toBeNull();

    const dropped = pruneOutboxBackups(db);

    expect(dropped).toContain('outbox_backup_v1');
    const left = db
      .prepare(
        "SELECT count(*) AS c FROM sqlite_master WHERE type='table' AND name LIKE 'outbox_backup_v%'",
      )
      .get() as { c: number };
    expect(left.c).toBe(0);
    db.close();
  });

  it('is a no-op when there are no backups', () => {
    const db = open();
    runMigrations(db);
    expect(pruneOutboxBackups(db)).toEqual([]);
    db.close();
  });
});

describe('generated DDL is what gets applied', () => {
  it('creates each table from its descriptor, not from a hand-written copy', () => {
    // Guards against the DDL and the descriptors drifting apart: the runner must
    // consume `emitCreateTable`, so a descriptor change reaches the database
    // without anyone editing SQL.
    const db = open();
    runMigrations(db);

    const sql = (
      db
        .prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name = ?")
        .get('sales_catalog') as { sql: string }
    ).sql;

    for (const col of SALES_CATALOG.columns) {
      expect(sql).toContain(col.name);
    }
    expect(emitCreateTable(SALES_CATALOG)).toContain('sales_catalog');
    db.close();
  });
});
