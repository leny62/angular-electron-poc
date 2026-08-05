/**
 * Deterministic DDL emitter.
 *
 * GENERATOR TARGET.  The Java generator emits `.sql` files directly; this
 * TypeScript emitter exists so the hand-written phase has one source of truth
 * and so the migration runner can assert that the DDL on disk matches the DDL
 * this build expects.
 *
 * Determinism matters: the per-table hash in the manifest is what tells startup
 * which `replica` tables changed shape and can be dropped and re-hydrated
 * rather than migrated.  Two builds of the same descriptors must produce
 * byte-identical SQL, so nothing here may depend on map iteration order,
 * timestamps, or locale.
 */

import { createHash } from 'crypto';
import type { ColumnDescriptor, TableDescriptor } from './types';
import { TABLES } from './tables';

// ---------------------------------------------------------------------------
// Type mapping
// ---------------------------------------------------------------------------

/**
 * Logical type to SQLite storage class.
 *
 * DECIMAL → TEXT is the load-bearing entry.  SQLite REAL is IEEE-754 binary
 * floating point: storing 0.1 and 0.2 and adding them does not give 0.3, and a
 * shop's daily total drifts.  Money and quantities are stored as decimal
 * strings and computed with a decimal library.
 */
const STORAGE_CLASS: Readonly<Record<ColumnDescriptor['type'], string>> = {
  TEXT: 'TEXT',
  UUID: 'TEXT',
  DECIMAL: 'TEXT',
  INTEGER: 'INTEGER',
  BOOLEAN: 'INTEGER',
  TIMESTAMP: 'TEXT',
  JSON: 'TEXT',
};

// ---------------------------------------------------------------------------
// Column emission
// ---------------------------------------------------------------------------

function emitColumn(c: ColumnDescriptor): string {
  const parts: string[] = [c.name, STORAGE_CLASS[c.type]];

  if (!c.nullable) parts.push('NOT NULL');
  if (c.defaultSql !== undefined) parts.push(`DEFAULT ${c.defaultSql}`);

  // Enum values become a CHECK constraint.  Cheap, and it turns a bad pull or
  // a bad local write into an immediate error rather than silent corruption.
  if (c.enumValues && c.enumValues.length > 0) {
    const list = c.enumValues.map((v) => `'${v}'`).join(', ');
    parts.push(`CHECK (${c.name} IN (${list}))`);
  }

  // BOOLEAN is stored as INTEGER; constrain it so nothing writes a 2.
  if (c.type === 'BOOLEAN') {
    parts.push(`CHECK (${c.name} IN (0, 1))`);
  }

  return parts.join(' ');
}

// ---------------------------------------------------------------------------
// Table emission
// ---------------------------------------------------------------------------

export function emitCreateTable(t: TableDescriptor): string {
  const lines: string[] = [];

  lines.push(`-- ${t.table}  (mode: ${t.mode}${t.schema ? `, schema: ${t.schema}` : ''})`);
  lines.push(`CREATE TABLE IF NOT EXISTS ${t.table} (`);

  const body: string[] = t.columns.map((c) => `  ${emitColumn(c)}`);

  body.push(`  PRIMARY KEY (${t.primaryKey.join(', ')})`);

  if (t.parent) {
    body.push(
      `  FOREIGN KEY (${t.parent.fk}) REFERENCES ${t.parent.table}(id) ON DELETE CASCADE`,
    );
  }

  lines.push(body.join(',\n'));
  lines.push(');');

  // Indexes.  Names are derived from table + columns so they are stable and
  // collision-free without a counter.
  for (const idx of t.uniqueIndexes) {
    lines.push(
      `CREATE UNIQUE INDEX IF NOT EXISTS ${indexName(t.table, idx, true)} ` +
        `ON ${t.table} (${idx.join(', ')});`,
    );
  }
  for (const idx of t.indexes) {
    lines.push(
      `CREATE INDEX IF NOT EXISTS ${indexName(t.table, idx, false)} ` +
        `ON ${t.table} (${idx.join(', ')});`,
    );
  }

  return lines.join('\n');
}

function indexName(table: string, columns: readonly string[], unique: boolean): string {
  return `${unique ? 'uq' : 'idx'}_${table}__${columns.join('_')}`;
}

// ---------------------------------------------------------------------------
// Full schema
// ---------------------------------------------------------------------------

/** Complete baseline DDL for every table, in registry order. */
export function emitBaselineDdl(): string {
  const header = [
    '-- ─────────────────────────────────────────────────────────────────────',
    '-- Bizuri local store: baseline schema',
    '--',
    '-- GENERATED SHAPE. Do not hand-edit once bizuri-sqlite codegen is live.',
    '-- Emitted from packages/local-store/src/tables.ts',
    '-- ─────────────────────────────────────────────────────────────────────',
    '',
  ].join('\n');

  return header + TABLES.map(emitCreateTable).join('\n\n') + '\n';
}

// ---------------------------------------------------------------------------
// Hashing
// ---------------------------------------------------------------------------

/**
 * Stable hash of one table's DDL.  Startup compares this against the value
 * recorded on disk: a changed hash on a `replica` table means DROP and
 * re-hydrate, which is free.  A changed hash on `write-through` means a real
 * migration is required, because those rows hold unsynced money.
 */
export function hashTable(t: TableDescriptor): string {
  return createHash('sha256').update(emitCreateTable(t), 'utf8').digest('hex').slice(0, 16);
}

export function hashAllTables(): Record<string, string> {
  const out: Record<string, string> = {};
  // TABLES is an ordered array, so insertion order is deterministic.
  for (const t of TABLES) {
    out[t.table] = hashTable(t);
  }
  return out;
}
