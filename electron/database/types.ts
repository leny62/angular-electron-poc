/**
 * Minimal type shim for better-sqlite3-multiple-ciphers.
 *
 * The upstream package uses a namespace-based type declaration that
 * does not play well with `esModuleInterop`.  Rather than fight the
 * declaration file, we define the narrow interface the PoC actually
 * uses and cast the import to it.
 *
 * Phase 2: replace with proper types from the BIZURI-Frontend shared
 * package when the shared-typings library is extracted.
 */

export interface SqliteDatabase {
  pragma(sql: string): void;
  exec(sql: string): void;
  prepare(sql: string): SqliteStatement;
  transaction<R>(fn: () => R): () => R;
  close(): void;
}

export interface SqliteStatement {
  run(...params: unknown[]): SqliteRunResult;
  get(...params: unknown[]): Record<string, unknown> | undefined;
  all(...params: unknown[]): Record<string, unknown>[];
}

export interface SqliteRunResult {
  changes: number;
  lastInsertRowid: number | bigint;
}
