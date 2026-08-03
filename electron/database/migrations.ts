/**
 * Schema migration runner.
 *
 * Migrations are forward-only and idempotent.  Version is stored in a
 * `schema_version` table created by migration 1.  The runner reads the
 * current version, applies every pending migration in order inside a
 * single transaction, and records the new version on success.
 */

import type { SqliteDatabase } from './types';

// ---------------------------------------------------------------------------
// Migration registry
// ---------------------------------------------------------------------------

interface Migration {
  readonly version: number;
  readonly description: string;
  readonly up: (db: SqliteDatabase) => void;
}

const MIGRATIONS: readonly Migration[] = [
  {
    version: 1,
    description: 'Create schema_version table',
    up(db) {
      db.exec(`
        CREATE TABLE IF NOT EXISTS schema_version (
          version     INTEGER NOT NULL,
          applied_at  TEXT    NOT NULL DEFAULT (datetime('now'))
        );
      `);
    },
  },
  {
    version: 2,
    description: 'Create device_session table',
    up(db) {
      db.exec(`
        CREATE TABLE IF NOT EXISTS device_session (
          device_id        TEXT PRIMARY KEY,
          tenant_id        TEXT NOT NULL,
          branch_id        TEXT NOT NULL,
          receipt_prefix   TEXT NOT NULL,
          receipt_seq      INTEGER NOT NULL DEFAULT 0,
          last_receipt_hash TEXT,
          sync_cursor      TEXT,
          activated_at     TEXT NOT NULL
        );
      `);
    },
  },
  {
    version: 3,
    description: 'Create sale, receipt, and outbox tables',
    up(db) {
      db.exec(`
        CREATE TABLE IF NOT EXISTS sale (
          id              TEXT PRIMARY KEY,
          server_id       TEXT,
          tenant_id       TEXT NOT NULL,
          branch_id       TEXT NOT NULL,
          sale_number     TEXT NOT NULL,
          status          TEXT NOT NULL DEFAULT 'CONFIRMED',
          sync_state      TEXT NOT NULL DEFAULT 'PENDING',
          customer_id     TEXT,
          client_name     TEXT,
          client_tin      TEXT,
          client_phone    TEXT,
          currency_code   TEXT NOT NULL DEFAULT 'RWF',
          subtotal        TEXT NOT NULL,
          discount_total  TEXT NOT NULL DEFAULT '0',
          tax_total       TEXT NOT NULL DEFAULT '0',
          grand_total     TEXT NOT NULL,
          amount_paid     TEXT NOT NULL,
          balance_due     TEXT NOT NULL DEFAULT '0',
          device_id       TEXT NOT NULL,
          idempotency_key TEXT NOT NULL UNIQUE,
          created_at      TEXT NOT NULL,
          confirmed_at    TEXT
        );

        CREATE TABLE IF NOT EXISTS receipt (
          id              TEXT PRIMARY KEY,
          sale_id         TEXT NOT NULL REFERENCES sale(id),
          receipt_number  TEXT NOT NULL,
          seq             INTEGER NOT NULL,
          prev_hash       TEXT NOT NULL,
          hash            TEXT NOT NULL,
          issued_at       TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS outbox (
          id              TEXT PRIMARY KEY,
          seq             INTEGER NOT NULL,
          entity          TEXT NOT NULL,
          entity_id       TEXT NOT NULL,
          operation       TEXT NOT NULL,
          payload         TEXT NOT NULL,
          idempotency_key TEXT NOT NULL,
          state           TEXT NOT NULL DEFAULT 'PENDING',
          attempts        INTEGER NOT NULL DEFAULT 0,
          batch_id        TEXT,
          leased_until    TEXT,
          last_error      TEXT,
          created_at      TEXT NOT NULL
        );

        CREATE INDEX IF NOT EXISTS idx_outbox_ready
          ON outbox(state, seq);
      `);
    },
  },
  {
    version: 4,
    description: 'Create catalog_item read-side snapshot',
    up(db) {
      db.exec(`
        CREATE TABLE IF NOT EXISTS catalog_item (
          item_id            TEXT PRIMARY KEY,
          branch_id          TEXT NOT NULL,
          item_code          TEXT NOT NULL,
          item_name          TEXT NOT NULL,
          barcode            TEXT,
          selling_price      TEXT NOT NULL,
          discount           TEXT DEFAULT '0',
          tax_category_name  TEXT,
          tax_category_rate  TEXT DEFAULT '0',
          available_qty      TEXT DEFAULT '0',
          sell_mode          TEXT DEFAULT 'UNIT',
          updated_at         TEXT NOT NULL
        );
      `);
    },
  },
  {
    version: 5,
    description: 'Create customer read-side snapshot',
    up(db) {
      db.exec(`
        CREATE TABLE IF NOT EXISTS customer (
          id              TEXT PRIMARY KEY,
          server_id       TEXT,
          tenant_id       TEXT NOT NULL,
          branch_id       TEXT NOT NULL,
          customer_code   TEXT,
          customer_name   TEXT NOT NULL,
          customer_tin    TEXT,
          customer_phone  TEXT,
          customer_email  TEXT,
          address         TEXT,
          sync_state      TEXT NOT NULL DEFAULT 'PENDING',
          created_at      TEXT NOT NULL,
          updated_at      TEXT NOT NULL
        );
      `);
    },
  },
];

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export const CURRENT_SCHEMA_VERSION: number =
  MIGRATIONS[MIGRATIONS.length - 1]?.version ?? 0;

export function runMigrations(db: SqliteDatabase): void {
  const diskVersion = getCurrentVersion(db);

  if (diskVersion > CURRENT_SCHEMA_VERSION) {
    throw new Error(
      `Database schema v${diskVersion} is newer than this build ` +
        `(v${CURRENT_SCHEMA_VERSION}). Refusing to start — downgrade not supported.`,
    );
  }

  const pending = MIGRATIONS.filter((m) => m.version > diskVersion);

  if (pending.length === 0) {
    return;
  }

  const runAll = db.transaction(() => {
    for (const migration of pending) {
      migration.up(db);
    }
    db.prepare('INSERT INTO schema_version (version) VALUES (?)').run(
      CURRENT_SCHEMA_VERSION,
    );
  });

  runAll();
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function getCurrentVersion(db: SqliteDatabase): number {
  const tableExists = db.prepare(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'schema_version'",
  ).get();

  if (!tableExists) {
    return 0;
  }

  const row = db.prepare('SELECT MAX(version) AS version FROM schema_version').get() as
    | { version: number | null }
    | undefined;

  return row?.version ?? 0;
}
