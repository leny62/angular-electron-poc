/**
 * Test helpers for local-store.
 *
 * An in-memory, unencrypted database is deliberate here: these tests exercise
 * DDL shape, not the cipher. Encryption is covered in the engine's connection
 * tests, where it belongs.
 */

import Database from 'better-sqlite3-multiple-ciphers';

export interface SqliteLike {
  exec(sql: string): void;
  pragma(sql: string): unknown;
  prepare(sql: string): {
    run(...p: unknown[]): { changes: number };
    get(...p: unknown[]): unknown;
    all(...p: unknown[]): unknown[];
  };
  close(): void;
}

export function openMemoryDb(): SqliteLike {
  const db = new Database(':memory:') as unknown as SqliteLike;
  db.pragma('foreign_keys = ON');
  return db;
}
