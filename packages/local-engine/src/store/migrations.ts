/**
 * Migration runner.
 *
 * This is the implementation of plan §4.4 and §6.2, and it is the piece that
 * makes "offline for three weeks, then the app updates" safe.
 *
 * ─── Why the app never downloads DDL ─────────────────────────────────────────
 * Migrations ship inside the binary, generated from the same descriptors the
 * readers are generated from. The alternative (fetch DDL from the server) is
 * tempting because it decouples releases, but it means the local schema and the
 * code that reads it can disagree at runtime, on a device we cannot inspect,
 * holding money that has not been pushed. Shipping them together makes that
 * disagreement impossible.
 *
 * ─── Why outbox payloads are never rewritten ─────────────────────────────────
 * An outbox row is immutable and self-describing: it carries the
 * `contract_version` it was written under, and the server upcasts on receipt.
 * So a migration never has to reach into a queued sale and reshape it. That
 * property is what lets this runner be simple, and it is the reason the
 * versioned-envelope design in §4.2 exists at all.
 *
 * ─── The replica shortcut ────────────────────────────────────────────────────
 * A `replica` table whose DDL hash changed is dropped and re-hydrated, because
 * by definition it holds nothing the server does not already have. Only
 * `write-through` tables need real migration care. That is what keeps this
 * runner from growing a migration per contract release: ~80% of tables opt out
 * of migration entirely.
 */

import {
  emitCreateTable,
  hashTable,
  LOCAL_SCHEMA_VERSION,
  TABLES,
  type TableDescriptor,
} from '@bizuri/local-store';
import type { SqliteDatabase } from './types';

// ---------------------------------------------------------------------------
// Meta tables
//
// Bootstrapped by hand rather than generated: the runner needs them to exist
// before it can consult them about anything, including itself.
// ---------------------------------------------------------------------------

const META_DDL = `
CREATE TABLE IF NOT EXISTS schema_version (
  version     INTEGER NOT NULL,
  applied_at  TEXT    NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS schema_table_hash (
  table_name  TEXT NOT NULL PRIMARY KEY,
  ddl_hash    TEXT NOT NULL,
  applied_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
`;

// ---------------------------------------------------------------------------
// Results
// ---------------------------------------------------------------------------

export interface MigrationResult {
  readonly fromVersion: number;
  readonly toVersion: number;
  /** Tables created for the first time. */
  readonly created: readonly string[];
  /** Replica tables dropped because their shape changed. Need re-hydration. */
  readonly rebuilt: readonly string[];
  /** Write-through tables whose shape changed and were migrated in place. */
  readonly migrated: readonly string[];
  /** Tables that must be re-hydrated before the engine reports READY. */
  readonly needsHydration: readonly string[];
  /** Name of the outbox backup table, when one was taken. */
  readonly outboxBackup: string | null;
}

export class SchemaDowngradeError extends Error {
  constructor(readonly diskVersion: number, readonly buildVersion: number) {
    super(
      `Database schema v${diskVersion} is newer than this build (v${buildVersion}). ` +
        'Refusing to start: downgrade is not supported and would risk unsynced data.',
    );
    this.name = 'SchemaDowngradeError';
  }
}

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

export function runMigrations(db: SqliteDatabase): MigrationResult {
  db.exec(META_DDL);

  const diskVersion = readVersion(db);

  // Refuse to run against a newer schema. An older binary writing into a newer
  // schema is how you lose columns, and the rows at risk are unsynced sales.
  if (diskVersion > LOCAL_SCHEMA_VERSION) {
    throw new SchemaDowngradeError(diskVersion, LOCAL_SCHEMA_VERSION);
  }

  const existing = listTables(db);
  const recordedHashes = readTableHashes(db);

  const created: string[] = [];
  const rebuilt: string[] = [];
  const migrated: string[] = [];

  // Back up the outbox before any DDL runs, but only when there is something to
  // lose and DDL is actually going to run. Cheap insurance against a migration
  // bug destroying queued money; dropped after two clean sync cycles.
  const willChangeSchema =
    diskVersion < LOCAL_SCHEMA_VERSION ||
    TABLES.some((t) => !existing.has(t.table) || recordedHashes[t.table] !== hashTable(t));

  const outboxBackup =
    willChangeSchema && existing.has('outbox') && countRows(db, 'outbox') > 0
      ? backupOutbox(db, diskVersion)
      : null;

  const apply = db.transaction(() => {
    for (const table of TABLES) {
      const currentHash = hashTable(table);

      if (!existing.has(table.table)) {
        db.exec(emitCreateTable(table));
        created.push(table.table);
        recordHash(db, table.table, currentHash);
        continue;
      }

      if (recordedHashes[table.table] === currentHash) {
        continue; // unchanged
      }

      // Shape changed. What that costs depends entirely on the mode.
      if (table.mode === 'replica' || table.mode === 'cache') {
        rebuildReplica(db, table);
        rebuilt.push(table.table);
      } else {
        migrateInPlace(db, table);
        migrated.push(table.table);
      }
      recordHash(db, table.table, currentHash);
    }

    if (diskVersion < LOCAL_SCHEMA_VERSION) {
      db.prepare('INSERT INTO schema_version (version) VALUES (?)').run(
        LOCAL_SCHEMA_VERSION,
      );
    }
  });

  apply();

  // Anything created or rebuilt has no data, so it must be hydrated before the
  // POS can trust it.
  const needsHydration = [...new Set([...created, ...rebuilt])].filter((name) => {
    const t = TABLES.find((x) => x.table === name);
    return t?.mode === 'replica' || t?.mode === 'cache';
  });

  return {
    fromVersion: diskVersion,
    toVersion: LOCAL_SCHEMA_VERSION,
    created,
    rebuilt,
    migrated,
    needsHydration,
    outboxBackup,
  };
}

// ---------------------------------------------------------------------------
// Replica rebuild
// ---------------------------------------------------------------------------

/**
 * Drop and recreate a replica table, and reset its pull cursor so the sync
 * worker knows to re-hydrate it from scratch.
 *
 * Safe by definition: a replica holds nothing the server does not have. This is
 * the whole reason `mode` is part of the contract rather than a runtime detail.
 */
function rebuildReplica(db: SqliteDatabase, table: TableDescriptor): void {
  db.exec(`DROP TABLE IF EXISTS ${table.table};`);
  db.exec(emitCreateTable(table));

  // Clear the watermark. Leaving a stale cursor would make the pull worker ask
  // for "changes since yesterday" against an empty table and never backfill.
  db.prepare(
    `INSERT INTO sync_cursor (entity, cursor, last_pulled_at, rows_pulled, hydrated)
     VALUES (?, NULL, NULL, 0, 0)
     ON CONFLICT(entity) DO UPDATE SET
       cursor = NULL, last_pulled_at = NULL, rows_pulled = 0, hydrated = 0`,
  ).run(table.table);
}

// ---------------------------------------------------------------------------
// Write-through migration
// ---------------------------------------------------------------------------

/**
 * Migrate a write-through table in place, preserving every row.
 *
 * Only additive changes are handled automatically: a new nullable column, or a
 * new index. That covers the realistic majority, and anything else has to be an
 * explicit, reviewed migration rather than something this function guesses at,
 * because the rows here are sales that have not reached the server.
 *
 * A destructive change reaching this function is a release-process failure, so
 * it throws rather than improvising.
 */
function migrateInPlace(db: SqliteDatabase, table: TableDescriptor): void {
  const actual = describeColumns(db, table.table);
  const expected = new Map(table.columns.map((c) => [c.name, c]));

  // Removed or renamed columns: refuse. Dropping a column from a table holding
  // unsynced sales silently discards data that exists nowhere else.
  for (const name of actual.keys()) {
    if (!expected.has(name)) {
      throw new Error(
        `Migration for "${table.table}" would drop column "${name}". ` +
          'Destructive migrations on write-through tables must be explicit. ' +
          'Add a reviewed migration step rather than relying on the automatic path.',
      );
    }
  }

  for (const [name, col] of expected) {
    if (actual.has(name)) continue;

    // A new NOT NULL column with no default cannot be added to a table with
    // existing rows: SQLite has nothing to put in them.
    if (!col.nullable && col.defaultSql === undefined) {
      throw new Error(
        `Migration for "${table.table}" adds NOT NULL column "${name}" with no default. ` +
          'Give it a default, or make it nullable, or write an explicit backfill.',
      );
    }

    const storage =
      col.type === 'INTEGER' || col.type === 'BOOLEAN' ? 'INTEGER' : 'TEXT';
    const notNull = col.nullable ? '' : ' NOT NULL';
    const def = col.defaultSql !== undefined ? ` DEFAULT ${col.defaultSql}` : '';

    // No CHECK constraint here: SQLite's ALTER TABLE ADD COLUMN cannot add one,
    // and rewriting the table to attach it is not worth the risk on a table
    // holding unsynced money. The constraint applies from the next rebuild.
    db.exec(`ALTER TABLE ${table.table} ADD COLUMN ${name} ${storage}${notNull}${def};`);
  }

  // Indexes are IF NOT EXISTS, so re-running the create statements is enough to
  // pick up new ones.
  for (const stmt of indexStatements(table)) {
    db.exec(stmt);
  }
}

/** Just the index-creation statements from a table's DDL. */
function indexStatements(table: TableDescriptor): string[] {
  return emitCreateTable(table)
    .split('\n')
    .filter((line) => line.startsWith('CREATE INDEX') || line.startsWith('CREATE UNIQUE INDEX'));
}

// ---------------------------------------------------------------------------
// Outbox backup
// ---------------------------------------------------------------------------

/**
 * Copy the outbox to a versioned side table before any DDL runs.
 *
 * Named by the version being migrated FROM, so a support engineer looking at a
 * device can tell which build produced the rows.
 */
function backupOutbox(db: SqliteDatabase, fromVersion: number): string {
  const name = `outbox_backup_v${fromVersion}`;
  db.exec(`DROP TABLE IF EXISTS ${name};`);
  db.exec(`CREATE TABLE ${name} AS SELECT * FROM outbox;`);
  return name;
}

/**
 * Drop outbox backups once the queue they protected has drained.
 *
 * Called by the sync worker after a clean cycle with an empty outbox, not by the
 * migration runner: the backup has to outlive the migration that created it.
 */
export function pruneOutboxBackups(db: SqliteDatabase): string[] {
  const rows = db
    .prepare(
      `SELECT name FROM sqlite_master
        WHERE type = 'table' AND name LIKE 'outbox_backup_v%'`,
    )
    .all() as { name: string }[];

  const dropped: string[] = [];
  for (const { name } of rows) {
    db.exec(`DROP TABLE IF EXISTS ${name};`);
    dropped.push(name);
  }
  return dropped;
}

// ---------------------------------------------------------------------------
// Introspection
// ---------------------------------------------------------------------------

function readVersion(db: SqliteDatabase): number {
  const row = db.prepare('SELECT MAX(version) AS version FROM schema_version').get() as
    | { version: number | null }
    | undefined;
  return row?.version ?? 0;
}

function readTableHashes(db: SqliteDatabase): Record<string, string> {
  const rows = db
    .prepare('SELECT table_name, ddl_hash FROM schema_table_hash')
    .all() as { table_name: string; ddl_hash: string }[];

  const out: Record<string, string> = {};
  for (const r of rows) out[r.table_name] = r.ddl_hash;
  return out;
}

function recordHash(db: SqliteDatabase, table: string, hash: string): void {
  db.prepare(
    `INSERT INTO schema_table_hash (table_name, ddl_hash) VALUES (?, ?)
     ON CONFLICT(table_name) DO UPDATE SET ddl_hash = excluded.ddl_hash,
                                          applied_at = datetime('now')`,
  ).run(table, hash);
}

function listTables(db: SqliteDatabase): Set<string> {
  const rows = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
    .all() as { name: string }[];
  return new Set(rows.map((r) => r.name));
}

interface ColumnInfo {
  readonly name: string;
  readonly notnull: number;
}

function describeColumns(db: SqliteDatabase, table: string): Map<string, ColumnInfo> {
  const rows = db.prepare(`PRAGMA table_info(${table})`).all() as {
    name: string;
    notnull: number;
  }[];
  return new Map(rows.map((r) => [r.name, { name: r.name, notnull: r.notnull }]));
}

function countRows(db: SqliteDatabase, table: string): number {
  const row = db.prepare(`SELECT count(*) AS c FROM ${table}`).get() as
    | { c: number }
    | undefined;
  return row?.c ?? 0;
}
