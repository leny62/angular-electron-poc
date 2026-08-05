/**
 * DDL emitter tests.
 *
 * These are the tests that make the hand-written phase safe to build on, and
 * they are the acceptance suite the Java generator must also pass. When
 * `bizuri-sqlite` replaces this package, these tests run unchanged against its
 * output — that is how "the diff must be empty" gets enforced mechanically
 * rather than by eyeballing.
 */

import Database from 'better-sqlite3-multiple-ciphers';
import {
  emitBaselineDdl,
  emitCreateTable,
  hashAllTables,
  hashTable,
  PULLABLE_TABLES,
  SALES,
  SALES_CATALOG,
  TABLES,
  tableFor,
} from '../index';
import type { SqliteLike } from './helpers';
import { openMemoryDb } from './helpers';

describe('DDL emission', () => {
  it('produces SQL that SQLite actually accepts', () => {
    const db = openMemoryDb();
    // The real assertion: if any descriptor emits invalid SQL, this throws.
    expect(() => db.exec(emitBaselineDdl())).not.toThrow();
    db.close();
  });

  it('creates every declared table', () => {
    const db = openMemoryDb();
    db.exec(emitBaselineDdl());

    const rows = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
      .all() as { name: string }[];
    const created = new Set(rows.map((r) => r.name));

    for (const t of TABLES) {
      expect(created.has(t.table)).toBe(true);
    }
    db.close();
  });

  it('is idempotent: applying the baseline twice is a no-op', () => {
    const db = openMemoryDb();
    const ddl = emitBaselineDdl();
    db.exec(ddl);
    // Every statement uses IF NOT EXISTS, so a re-run must not throw. This is
    // what lets the migration runner be safely re-entrant after a crash.
    expect(() => db.exec(ddl)).not.toThrow();
    db.close();
  });

  it('is deterministic across calls', () => {
    // If this fails, the manifest hash is unstable and startup would think
    // every table changed shape on every launch.
    expect(emitBaselineDdl()).toBe(emitBaselineDdl());
    expect(hashAllTables()).toEqual(hashAllTables());
  });
});

describe('column type mapping', () => {
  it('stores DECIMAL as TEXT, never REAL', () => {
    // Money as SQLite REAL is IEEE-754 and a shop's daily total drifts by
    // cents. This test is the guard on that decision.
    for (const t of TABLES) {
      const sql = emitCreateTable(t);
      for (const c of t.columns) {
        if (c.type === 'DECIMAL') {
          expect(sql).toContain(`${c.name} TEXT`);
          expect(sql).not.toContain(`${c.name} REAL`);
        }
      }
    }
  });

  it('never emits REAL anywhere in the schema', () => {
    expect(emitBaselineDdl()).not.toMatch(/\bREAL\b/);
  });

  it('constrains BOOLEAN columns to 0 or 1', () => {
    const sql = emitCreateTable(SALES_CATALOG);
    expect(sql).toContain('is_variant INTEGER NOT NULL DEFAULT 0 CHECK (is_variant IN (0, 1))');
  });

  it('emits a CHECK constraint for every enum column', () => {
    const sql = emitCreateTable(SALES_CATALOG);
    expect(sql).toContain("CHECK (sell_mode IN ('IN_STOCK', 'MADE_TO_ORDER'))");
    expect(sql).toContain(
      "CHECK (business_type IN ('FINISHED_PRODUCT', 'RAW_MATERIAL'))",
    );
  });

  it('rejects a value outside an enum at the database level', () => {
    const db = openMemoryDb();
    db.exec(emitBaselineDdl());

    const insert = () =>
      db
        .prepare(
          `INSERT INTO sales_catalog
             (tenant_id, branch_id, item_id, item_code, item_name,
              business_type, sell_mode, updated_at, _pulled_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run('t1', 'b1', 'i1', 'C1', 'Item', 'FINISHED_PRODUCT', 'NOT_A_MODE', 'x', 'x');

    // A bad pull should fail loudly rather than corrupt the catalog silently.
    expect(insert).toThrow(/CHECK constraint failed/);
    db.close();
  });
});

describe('table invariants', () => {
  it('gives every replica and write-through table a watermark', () => {
    // Without a watermark there is no incremental pull, so the table would be
    // fully re-downloaded on every sync cycle.
    for (const t of PULLABLE_TABLES) {
      if (t.parent) continue; // children sync with their parent aggregate
      expect(t.watermark).toBeDefined();
      expect(t.columns.some((c) => c.name === t.watermark)).toBe(true);
    }
  });

  it('declares every primary-key column on the table', () => {
    for (const t of TABLES) {
      for (const pk of t.primaryKey) {
        expect(t.columns.some((c) => c.name === pk)).toBe(true);
      }
    }
  });

  it('declares every indexed column on the table', () => {
    for (const t of TABLES) {
      for (const idx of [...t.indexes, ...t.uniqueIndexes]) {
        for (const c of idx) {
          expect(t.columns.some((col) => col.name === c)).toBe(true);
        }
      }
    }
  });

  it('declares every scope column on the table', () => {
    for (const t of TABLES) {
      for (const s of t.scope) {
        expect(t.columns.some((c) => c.name === s)).toBe(true);
      }
    }
  });

  it('gives replica tables a deleted tombstone column', () => {
    // Without this a discontinued item stays sellable offline forever.
    for (const t of TABLES.filter((x) => x.mode === 'replica')) {
      expect(t.columns.some((c) => c.name === 'deleted')).toBe(true);
    }
  });

  it('gives write-through tables their sync bookkeeping', () => {
    for (const t of TABLES.filter((x) => x.mode === 'write-through')) {
      if (t.parent) continue; // children inherit the parent's sync state
      const names = t.columns.map((c) => c.name);
      expect(names).toContain('sync_state');
      expect(names).toContain('server_id');
      expect(names).toContain('local_seq');
    }
  });

  it('points every child table at a table that exists', () => {
    for (const t of TABLES) {
      if (!t.parent) continue;
      expect(() => tableFor(t.parent!.table)).not.toThrow();
      expect(t.columns.some((c) => c.name === t.parent!.fk)).toBe(true);
    }
  });

  it('orders TABLES so a child never precedes its parent', () => {
    // Foreign keys are emitted inline, so parent tables must be created first.
    const seen = new Set<string>();
    for (const t of TABLES) {
      if (t.parent) expect(seen.has(t.parent.table)).toBe(true);
      seen.add(t.table);
    }
  });
});

describe('foreign keys and cascade', () => {
  it('cascades sale line deletion from the parent sale', () => {
    const db = openMemoryDb();
    db.exec(emitBaselineDdl());
    db.pragma('foreign_keys = ON');

    insertSale(db, 's1');
    db.prepare(
      `INSERT INTO sale_lines
         (id, sale_id, line_no, item_id, item_name, quantity, unit_price,
          discount_amount, tax_amount, line_subtotal, line_total)
       VALUES ('l1','s1',1,'i1','Item','1','100','0','0','100','100')`,
    ).run();

    db.prepare('DELETE FROM sales WHERE id = ?').run('s1');

    const remaining = db
      .prepare('SELECT count(*) AS c FROM sale_lines')
      .get() as { c: number };
    expect(remaining.c).toBe(0);
    db.close();
  });

  it('rejects a sale line with no parent sale', () => {
    const db = openMemoryDb();
    db.exec(emitBaselineDdl());
    db.pragma('foreign_keys = ON');

    expect(() =>
      db
        .prepare(
          `INSERT INTO sale_lines
             (id, sale_id, line_no, item_id, item_name, quantity, unit_price,
              discount_amount, tax_amount, line_subtotal, line_total)
           VALUES ('l1','nope',1,'i1','Item','1','100','0','0','100','100')`,
        )
        .run(),
    ).toThrow(/FOREIGN KEY constraint failed/);
    db.close();
  });
});

describe('uniqueness guarantees', () => {
  it('enforces one sale per idempotency key', () => {
    // This is the local half of exactly-once: a double-submit from the UI must
    // not create two sales, independently of what the server does.
    const db = openMemoryDb();
    db.exec(emitBaselineDdl());

    insertSale(db, 's1', { idempotencyKey: 'key-1' });
    expect(() => insertSale(db, 's2', { idempotencyKey: 'key-1' })).toThrow(
      /UNIQUE constraint failed/,
    );
    db.close();
  });

  it('enforces one outbox entry per idempotency key', () => {
    const db = openMemoryDb();
    db.exec(emitBaselineDdl());

    const ins = (id: string, key: string) =>
      db
        .prepare(
          `INSERT INTO outbox
             (tenant_id, id, seq, aggregate_type, aggregate_id, operation_id,
              contract_version, payload, idempotency_key, state, attempts, created_at)
           VALUES ('t1', ?, 1, 'Sale', 'a1', 'createSale', '1.2.29', '{}', ?, 'PENDING', 0, 'now')`,
        )
        .run(id, key);

    ins('o1', 'key-1');
    expect(() => ins('o2', 'key-1')).toThrow(/UNIQUE constraint failed/);
    db.close();
  });
});

describe('hashing', () => {
  it('changes a table hash when that table changes', () => {
    const before = hashTable(SALES_CATALOG);
    const mutated = {
      ...SALES_CATALOG,
      columns: [...SALES_CATALOG.columns, { name: 'zz', type: 'TEXT' as const, nullable: true }],
    };
    expect(hashTable(mutated)).not.toBe(before);
  });

  it('keeps other table hashes stable when one changes', () => {
    // This is what makes per-table drop-and-rehydrate possible: a catalog
    // change must not force a migration on the sales table.
    const salesBefore = hashTable(SALES);
    const mutatedCatalog = {
      ...SALES_CATALOG,
      indexes: [...SALES_CATALOG.indexes, ['item_code'] as readonly string[]],
    };
    expect(hashTable(mutatedCatalog)).not.toBe(hashTable(SALES_CATALOG));
    expect(hashTable(SALES)).toBe(salesBefore);
  });

  it('covers every table in the manifest hash set', () => {
    const hashes = hashAllTables();
    expect(Object.keys(hashes).sort()).toEqual(TABLES.map((t) => t.table).sort());
  });
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function insertSale(
  db: SqliteLike,
  id: string,
  opts: { idempotencyKey?: string } = {},
): void {
  db.prepare(
    `INSERT INTO sales
       (tenant_id, branch_id, id, sale_number, status, subtotal, discount_total,
        tax_total, grand_total, amount_paid, change_given, balance_due,
        total_items, created_at, idempotency_key, sync_state, local_seq)
     VALUES ('t1','b1', ?, ?, 'CONFIRMED','100','0','0','100','100','0','0','1',
             'now', ?, 'PENDING', 1)`,
  ).run(id, `SN-${id}`, opts.idempotencyKey ?? `key-${id}`);
}

// Keep the direct Database import used, so the helper module stays honest about
// what it wraps.
void Database;
