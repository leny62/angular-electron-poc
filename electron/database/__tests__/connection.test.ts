import { ConnectionManager } from '../connection';

const mockPrepare = jest.fn();
const mockPragma = jest.fn();
const mockClose = jest.fn();

const mockDbInstance = {
  pragma: mockPragma,
  prepare: mockPrepare,
  close: mockClose,
};

jest.mock('better-sqlite3-multiple-ciphers', () => {
  return jest.fn().mockImplementation(() => mockDbInstance);
});

jest.mock('../migrations', () => ({
  runMigrations: jest.fn(),
}));

const mockExistsSync = jest.fn();
const mockReadSync = jest.fn();

jest.mock('fs', () => ({
  ...jest.requireActual('fs'),
  existsSync: (p: string) => mockExistsSync(p),
  openSync: () => 42,
  closeSync: () => undefined,
  readSync: (...args: unknown[]) => mockReadSync(...args),
}));

import Database from 'better-sqlite3-multiple-ciphers';
import { runMigrations } from '../migrations';

const SQLITE_MAGIC = 'SQLite format 3\0';

/** Make the next canReadSchema() call fail, as a wrong key would. */
function failKeyVerificationOnce(): void {
  mockPrepare.mockImplementationOnce(() => ({
    get: () => {
      throw new Error('file is not a database');
    },
  }));
}

/** Present the file on disk as an unencrypted SQLite database. */
function presentPlaintextFileOnDisk(): void {
  mockExistsSync.mockReturnValue(true);
  mockReadSync.mockImplementation((_fd: number, buf: Buffer) => {
    buf.write(SQLITE_MAGIC, 'latin1');
    return SQLITE_MAGIC.length;
  });
}

describe('ConnectionManager', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockPrepare.mockReturnValue({
      get: jest.fn().mockReturnValue({ c: 1 }),
    });
    // Default: no file on disk, so a failed key check is a wrong key
    // rather than a plaintext database awaiting encryption.
    mockExistsSync.mockReturnValue(false);
    mockReadSync.mockReturnValue(0);
  });

  it('opens a database and runs migrations', () => {
    const manager = new ConnectionManager({ dbPath: '/tmp/test.db' });
    manager.open();

    expect(Database).toHaveBeenCalledWith('/tmp/test.db');
    expect(mockPragma).toHaveBeenCalledWith('journal_mode = WAL');
    expect(mockPragma).toHaveBeenCalledWith('foreign_keys = ON');
    expect(runMigrations).toHaveBeenCalled();
  });

  it('does not reopen if already open', () => {
    const manager = new ConnectionManager({ dbPath: '/tmp/test.db' });
    manager.open();
    manager.open();

    expect(Database).toHaveBeenCalledTimes(1);
  });

  it('throws when get() called before open()', () => {
    const manager = new ConnectionManager({ dbPath: '/tmp/test.db' });
    expect(() => manager.get()).toThrow('Database not open');
  });

  it('returns the database after open', () => {
    const manager = new ConnectionManager({ dbPath: '/tmp/test.db' });
    manager.open();
    expect(manager.get()).toBe(mockDbInstance);
  });

  it('reports isOpen correctly', () => {
    const manager = new ConnectionManager({ dbPath: '/tmp/test.db' });
    expect(manager.isOpen).toBe(false);
    manager.open();
    expect(manager.isOpen).toBe(true);
  });

  it('closes the database', () => {
    const manager = new ConnectionManager({ dbPath: '/tmp/test.db' });
    manager.open();
    manager.close();

    expect(mockClose).toHaveBeenCalled();
    expect(manager.isOpen).toBe(false);
  });

  it('sets encryption key when passphrase is provided', () => {
    const manager = new ConnectionManager({
      dbPath: '/tmp/test.db',
      passphrase: 'abc123hexkey',
    });
    manager.open();

    expect(mockPragma).toHaveBeenCalledWith(`key = "x'abc123hexkey'"`);
  });

  it('verifies the encryption key by reading sqlite_master', () => {
    const getMock = jest.fn().mockReturnValue({ c: 1 });
    mockPrepare.mockReturnValue({ get: getMock });

    const manager = new ConnectionManager({
      dbPath: '/tmp/test.db',
      passphrase: 'valid-key',
    });
    manager.open();

    expect(mockPrepare).toHaveBeenCalledWith(
      'SELECT count(*) AS c FROM sqlite_master',
    );
  });

  it('throws on wrong passphrase', () => {
    failKeyVerificationOnce();

    const manager = new ConnectionManager({
      dbPath: '/tmp/test.db',
      passphrase: 'wrong-key',
    });

    expect(() => manager.open()).toThrow('wrong passphrase');
  });

  it('sanitises single quotes in passphrase', () => {
    const manager = new ConnectionManager({
      dbPath: '/tmp/test.db',
      passphrase: "key'with'quotes",
    });
    manager.open();

    expect(mockPragma).toHaveBeenCalledWith(
      `key = "x'key''with''quotes'"`,
    );
  });

  // -------------------------------------------------------------------------
  // Pragma ordering
  //
  // journal_mode before key makes SQLite write a plaintext header before
  // the cipher is configured; every keyed read then fails with
  // SQLITE_NOTADB, even on a brand-new file.
  // -------------------------------------------------------------------------

  it('applies the key before any other pragma', () => {
    const manager = new ConnectionManager({
      dbPath: '/tmp/test.db',
      passphrase: 'abc123hexkey',
    });
    manager.open();

    const order = mockPragma.mock.calls.map((call) => String(call[0]));
    const keyIndex = order.findIndex((sql) => sql.startsWith('key ='));
    const journalIndex = order.findIndex((sql) => sql.startsWith('journal_mode'));
    const foreignKeyIndex = order.findIndex((sql) => sql.startsWith('foreign_keys'));

    expect(keyIndex).toBe(0);
    expect(keyIndex).toBeLessThan(journalIndex);
    expect(keyIndex).toBeLessThan(foreignKeyIndex);
  });

  it('does not read the schema before the key is applied', () => {
    const manager = new ConnectionManager({
      dbPath: '/tmp/test.db',
      passphrase: 'abc123hexkey',
    });
    manager.open();

    expect(mockPragma.mock.invocationCallOrder[0]).toBeLessThan(
      mockPrepare.mock.invocationCallOrder[0],
    );
  });

  // -------------------------------------------------------------------------
  // Adopting a pre-encryption (plaintext) database
  // -------------------------------------------------------------------------

  it('encrypts an existing plaintext database in place instead of failing', () => {
    presentPlaintextFileOnDisk();
    failKeyVerificationOnce();

    const manager = new ConnectionManager({
      dbPath: '/tmp/legacy.db',
      passphrase: 'abc123hexkey',
    });

    expect(() => manager.open()).not.toThrow();

    const order = mockPragma.mock.calls.map((call) => String(call[0]));
    expect(order).toContain('journal_mode = DELETE');
    expect(order).toContain(`rekey = "x'abc123hexkey'"`);
    // WAL is restored after re-keying.
    expect(order.lastIndexOf('journal_mode = WAL')).toBeGreaterThan(
      order.indexOf('journal_mode = DELETE'),
    );
    expect(runMigrations).toHaveBeenCalled();
    expect(manager.isOpen).toBe(true);
  });

  it('reopens the connection when adopting a plaintext database', () => {
    presentPlaintextFileOnDisk();
    failKeyVerificationOnce();

    const manager = new ConnectionManager({
      dbPath: '/tmp/legacy.db',
      passphrase: 'abc123hexkey',
    });
    manager.open();

    // Once for the failed keyed attempt, once for the re-key attempt.
    expect(Database).toHaveBeenCalledTimes(2);
    expect(mockClose).toHaveBeenCalledTimes(1);
  });

  it('throws when the file is encrypted with a different key', () => {
    // File exists but carries no plaintext SQLite magic — a real
    // encrypted database that this key cannot open.
    mockExistsSync.mockReturnValue(true);
    mockReadSync.mockImplementation((_fd: number, buf: Buffer) => {
      buf.write('random-bytes', 'latin1');
      return 16;
    });
    failKeyVerificationOnce();

    const manager = new ConnectionManager({
      dbPath: '/tmp/other.db',
      passphrase: 'abc123hexkey',
    });

    expect(() => manager.open()).toThrow('wrong passphrase');
    // No attempt to re-key someone else's encrypted database.
    expect(mockPragma).not.toHaveBeenCalledWith(
      expect.stringContaining('rekey'),
    );
  });

  it('throws when re-keying a plaintext database fails', () => {
    presentPlaintextFileOnDisk();
    failKeyVerificationOnce();
    mockPragma.mockImplementation((sql: string) => {
      if (String(sql).startsWith('rekey')) {
        throw new Error('disk I/O error');
      }
    });

    const manager = new ConnectionManager({
      dbPath: '/tmp/legacy.db',
      passphrase: 'abc123hexkey',
    });

    expect(() => manager.open()).toThrow('Failed to encrypt existing plaintext database');
    expect(manager.isOpen).toBe(false);
  });

  it('leaves an unencrypted database untouched when no passphrase is given', () => {
    presentPlaintextFileOnDisk();

    const manager = new ConnectionManager({ dbPath: '/tmp/plain.db' });
    manager.open();

    const order = mockPragma.mock.calls.map((call) => String(call[0]));
    expect(order.some((sql) => sql.startsWith('key ='))).toBe(false);
    expect(order.some((sql) => sql.startsWith('rekey'))).toBe(false);
  });
});
