/**
 * SQLite connection manager.
 *
 * Owns the lifecycle of the encrypted database: open, migrate, close.
 * The connection is opened once at startup and held for the session
 * lifetime.  When encryption is enabled every page is AES-256 encrypted
 * at rest.
 */

import Database from 'better-sqlite3-multiple-ciphers';
import { join } from 'path';
import { runMigrations } from './migrations';
import type { SqliteDatabase } from './types';

export interface ConnectionConfig {
  readonly dbPath: string;
  readonly passphrase?: string;
}

export class ConnectionManager {
  private db: SqliteDatabase | null = null;

  constructor(private readonly config: ConnectionConfig) {}

  open(): SqliteDatabase {
    if (this.db) {
      return this.db;
    }

    const { dbPath, passphrase } = this.config;

    const rawDb = new Database(dbPath) as unknown as SqliteDatabase;

    rawDb.pragma('journal_mode = WAL');
    rawDb.pragma('foreign_keys = ON');

    if (passphrase) {
      rawDb.pragma(`key = '${passphrase.replace(/'/g, "''")}'`);
      // Verify the key by reading sqlite_master, which always exists.
      try {
        rawDb.prepare("SELECT count(*) AS c FROM sqlite_master").get();
      } catch {
        rawDb.close();
        this.db = null;
        throw new Error(
          'Database key verification failed — wrong passphrase or corrupt file.',
        );
      }
    }

    runMigrations(rawDb);

    this.db = rawDb;
    return this.db;
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
