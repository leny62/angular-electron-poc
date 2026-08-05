/**
 * Narrow type shim for better-sqlite3-multiple-ciphers.
 *
 * The upstream declaration is namespace-based and fights `esModuleInterop`, so
 * we declare the surface we actually use and cast the import once, at the single
 * point where the driver is constructed. Everything downstream depends on this
 * interface rather than on the driver, which is also what lets the operation
 * tests run against `:memory:` without touching the cipher.
 */

export interface SqliteStatement {
  run(...params: readonly unknown[]): SqliteRunResult;
  get(...params: readonly unknown[]): Record<string, unknown> | undefined;
  all(...params: readonly unknown[]): Record<string, unknown>[];
  iterate(...params: readonly unknown[]): IterableIterator<Record<string, unknown>>;
}

export interface SqliteRunResult {
  changes: number;
  lastInsertRowid: number | bigint;
}

export interface SqliteDatabase {
  pragma(sql: string): unknown;
  exec(sql: string): void;
  prepare(sql: string): SqliteStatement;
  /**
   * Wraps `fn` in a transaction. better-sqlite3 returns a callable that accepts
   * the same arguments as `fn`, and rolls back if `fn` throws — which is why the
   * operations throw `EngineError` rather than returning failures.
   */
  transaction<A extends readonly unknown[], R>(fn: (...args: A) => R): (...args: A) => R;
  close(): void;
  readonly open: boolean;
  readonly inTransaction: boolean;
}
