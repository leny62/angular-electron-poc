/**
 * SQLCipher connection manager.
 *
 * Ported from the POC, whose hard-won ordering comment is preserved because it
 * encodes a real debugging cost. Two changes:
 *
 *   1. The plaintext-adoption path is gone. The POC would silently encrypt an
 *      existing unencrypted database in place. That was a reasonable escape
 *      hatch for a spike, but shipping it means a corrupted or substituted
 *      plaintext file gets adopted and encrypted with our key, which destroys
 *      the evidence that anything was wrong. An unencrypted file is now a hard
 *      failure that says what to do.
 *
 *   2. `busy_timeout` and `synchronous` are set explicitly. Defaults are wrong
 *      for a POS: SQLITE_BUSY must wait rather than fail a sale, and
 *      `synchronous = FULL` is what makes a confirmed sale survive a power cut,
 *      which is not hypothetical in the deployment environment.
 */

import Database from 'better-sqlite3-multiple-ciphers';
import { closeSync, existsSync, openSync, readSync } from 'fs';
import { runMigrations, type MigrationResult } from './migrations';
import type { SqliteDatabase } from './types';

/** First 16 bytes of an unencrypted SQLite file. */
const SQLITE_MAGIC = 'SQLite format 3\0';

export interface ConnectionConfig {
  readonly dbPath: string;
  /** Hex-encoded 256-bit key from `keyToHex`. Omit only in tests. */
  readonly keyHex?: string;
  /** How long to wait on a locked database before failing. */
  readonly busyTimeoutMs?: number;
}

export class DatabaseKeyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DatabaseKeyError';
  }
}

export class ConnectionManager {
  private db: SqliteDatabase | null = null;
  private migration: MigrationResult | null = null;

  constructor(private readonly config: ConnectionConfig) {}

  open(): { db: SqliteDatabase; migration: MigrationResult } {
    if (this.db && this.migration) {
      return { db: this.db, migration: this.migration };
    }

    const { dbPath, keyHex, busyTimeoutMs = 5_000 } = this.config;

    const existedBefore = existsSync(dbPath);
    const db = new Database(dbPath) as unknown as SqliteDatabase;

    if (keyHex) {
      // PRAGMA key MUST be the first statement on the connection.
      //
      // Any pragma that touches the database header first (journal_mode above
      // all) makes SQLite materialise a PLAINTEXT header before the cipher is
      // configured. Every subsequent keyed read then fails with SQLITE_NOTADB,
      // even on a brand-new empty file. journal_mode and foreign_keys are
      // therefore applied after the key is in place. This cost a day to find.
      //
      // The x'...' literal selects raw-key mode, skipping the cipher's own KDF
      // because PBKDF2 already ran.
      db.pragma(`key = "x'${keyHex}'"`);

      if (!this.canRead(db)) {
        db.close();

        // Distinguish "wrong key" from "not encrypted", because the remedies are
        // completely different and the second one means something is wrong that
        // encrypting-in-place would hide.
        if (existedBefore && this.isPlaintext(dbPath)) {
          throw new DatabaseKeyError(
            'The local database is not encrypted. This build refuses to adopt an ' +
              'unencrypted database, because doing so would mask tampering or a ' +
              'substituted file. Move it aside and let the app re-hydrate from the server.',
          );
        }

        throw new DatabaseKeyError(
          'Unable to decrypt the local database: wrong passphrase, or the file is corrupt.',
        );
      }
    }

    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');
    db.pragma(`busy_timeout = ${busyTimeoutMs}`);

    // FULL, not NORMAL. In WAL mode NORMAL lets the OS decide when to flush, so
    // a power cut can lose the last commits. Those commits are confirmed sales
    // with printed receipts, and a receipt the database has never heard of is
    // worse than a slower write.
    db.pragma('synchronous = FULL');

    this.migration = runMigrations(db);
    this.db = db;

    return { db, migration: this.migration };
  }

  /** Can we decrypt and read the schema with the key currently applied? */
  private canRead(db: SqliteDatabase): boolean {
    try {
      db.prepare('SELECT count(*) AS c FROM sqlite_master').get();
      return true;
    } catch {
      return false;
    }
  }

  /**
   * True when the file is a readable, unencrypted SQLite database. An encrypted
   * file has a random-looking first page, so the magic string is absent.
   */
  private isPlaintext(dbPath: string): boolean {
    let fd: number | undefined;
    try {
      fd = openSync(dbPath, 'r');
      const buf = Buffer.alloc(SQLITE_MAGIC.length);
      const read = readSync(fd, buf, 0, buf.length, 0);
      return read === buf.length && buf.toString('latin1') === SQLITE_MAGIC;
    } catch {
      return false;
    } finally {
      if (fd !== undefined) closeSync(fd);
    }
  }

  get(): SqliteDatabase {
    if (!this.db) throw new Error('Database is not open. Call open() first.');
    return this.db;
  }

  get isOpen(): boolean {
    return this.db !== null;
  }

  get migrationResult(): MigrationResult | null {
    return this.migration;
  }

  /**
   * Close the connection, checkpointing the WAL first.
   *
   * Without the checkpoint the -wal file survives alongside the database. That
   * is recoverable, but it means the next launch replays the log, and a partial
   * -wal from a hard kill is the most common source of "database is malformed"
   * reports in the field.
   */
  close(): void {
    if (!this.db) return;
    try {
      this.db.pragma('wal_checkpoint(TRUNCATE)');
    } catch {
      // Already closing, or the disk is gone. Closing still matters more.
    }
    this.db.close();
    this.db = null;
  }
}
