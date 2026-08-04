/**
 * SQLite connection manager.
 *
 * Owns the lifecycle of the encrypted database: open, migrate, close.
 * The connection is opened once at startup and held for the session
 * lifetime.  When encryption is enabled every page is AES-256 encrypted
 * at rest.
 */

import Database from 'better-sqlite3-multiple-ciphers';
import { closeSync, existsSync, openSync, readSync } from 'fs';
import { join } from 'path';
import { runMigrations } from './migrations';
import type { SqliteDatabase } from './types';

export interface ConnectionConfig {
  readonly dbPath: string;
  readonly passphrase?: string;
}

/** First 16 bytes of every unencrypted SQLite file. */
const SQLITE_MAGIC = 'SQLite format 3\0';

/**
 * True when the file on disk is a readable, unencrypted SQLite database.
 *
 * An encrypted database has a random-looking first page, so the magic
 * string is absent.  Used to distinguish "database predates encryption"
 * (recoverable by re-keying) from "wrong key" (not recoverable).
 */
function isPlaintextDatabase(dbPath: string): boolean {
  if (!existsSync(dbPath)) {
    return false;
  }

  let fd: number | undefined;
  try {
    fd = openSync(dbPath, 'r');
    const buf = Buffer.alloc(SQLITE_MAGIC.length);
    const bytesRead = readSync(fd, buf, 0, buf.length, 0);
    return bytesRead === buf.length && buf.toString('latin1') === SQLITE_MAGIC;
  } catch {
    return false;
  } finally {
    if (fd !== undefined) {
      closeSync(fd);
    }
  }
}

/**
 * Escape a hex key for interpolation into a PRAGMA statement.
 *
 * The pragma parser needs the blob literal wrapped in double quotes:
 * `PRAGMA key = "x'<hex>'"`.
 */
function quoteKey(passphrase: string): string {
  return `"x'${passphrase.replace(/'/g, "''")}'"`;
}

/** Can we decrypt and read the schema with the key currently applied? */
function canReadSchema(db: SqliteDatabase): boolean {
  try {
    db.prepare('SELECT count(*) AS c FROM sqlite_master').get();
    return true;
  } catch {
    return false;
  }
}

export class ConnectionManager {
  private db: SqliteDatabase | null = null;

  constructor(private readonly config: ConnectionConfig) {}

  open(): SqliteDatabase {
    if (this.db) {
      return this.db;
    }

    const { dbPath, passphrase } = this.config;

    let rawDb = new Database(dbPath) as unknown as SqliteDatabase;

    if (passphrase) {
      // PRAGMA key MUST be the very first statement on the connection.
      //
      // Any pragma that touches the database header first — journal_mode
      // above all — makes SQLite materialise a *plaintext* header before
      // the cipher is configured.  Every subsequent keyed read then fails
      // with SQLITE_NOTADB, even on a brand-new empty file.  journal_mode
      // and foreign_keys are therefore applied after the key is in place.
      //
      // The x'...' hex literal tells the cipher to use the raw 256-bit key
      // directly, skipping its own internal KDF (we already ran PBKDF2).
      rawDb.pragma(`key = ${quoteKey(passphrase)}`);

      if (!canReadSchema(rawDb)) {
        rawDb.close();

        // A database created before encryption was correctly wired up sits
        // on disk in plaintext.  Adopt it by encrypting in place: the
        // alternative is a FATAL engine on every launch and an install
        // that can only be fixed by deleting the user's data.
        if (isPlaintextDatabase(dbPath)) {
          rawDb = this.encryptPlaintextDatabase(dbPath, passphrase);
        } else {
          this.db = null;
          throw new Error(
            'Database key verification failed — wrong passphrase or corrupt file.',
          );
        }
      }
    }

    rawDb.pragma('journal_mode = WAL');
    rawDb.pragma('foreign_keys = ON');

    runMigrations(rawDb);

    this.db = rawDb;
    return this.db;
  }

  /**
   * Encrypt an existing unencrypted database in place, preserving its
   * contents, and return the open connection.
   *
   * Re-keying rewrites every page, which SQLite will not do while the
   * database is in WAL mode — hence the switch to a rollback journal
   * first.  `open()` restores WAL afterwards.
   */
  private encryptPlaintextDatabase(
    dbPath: string,
    passphrase: string,
  ): SqliteDatabase {
    const db = new Database(dbPath) as unknown as SqliteDatabase;

    try {
      db.pragma('journal_mode = DELETE');
      db.pragma(`rekey = ${quoteKey(passphrase)}`);
    } catch (err) {
      db.close();
      this.db = null;
      throw new Error(
        `Failed to encrypt existing plaintext database: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }

    if (!canReadSchema(db)) {
      db.close();
      this.db = null;
      throw new Error(
        'Database key verification failed after encrypting existing plaintext database.',
      );
    }

    console.log(
      '[db] Existing plaintext database encrypted in place with the derived key.',
    );

    return db;
  }

  get(): SqliteDatabase {
    if (!this.db) {
      throw new Error('Database not open — call open() first.');
    }
    return this.db;
  }

  get isOpen(): boolean {
    return this.db !== null;
  }

  close(): void {
    if (this.db) {
      this.db.close();
      this.db = null;
    }
  }
}
