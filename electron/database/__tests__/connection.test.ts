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

import Database from 'better-sqlite3-multiple-ciphers';
import { runMigrations } from '../migrations';

describe('ConnectionManager', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockPrepare.mockReturnValue({
      get: jest.fn().mockReturnValue({ c: 1 }),
    });
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

    expect(mockPragma).toHaveBeenCalledWith("key = 'abc123hexkey'");
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
      "SELECT count(*) AS c FROM sqlite_master",
    );
  });

  it('throws on wrong passphrase', () => {
    mockPrepare
      .mockReturnValueOnce({ get: jest.fn().mockReturnValue({ c: 1 }) }) // sqlite_master check
      .mockReturnValueOnce({ get: jest.fn().mockReturnValue({ c: 1 }) }); // migrations

    // Override just the key verification call to throw
    const verifyMock = jest.fn().mockImplementation(() => {
      throw new Error('file is not a database');
    });
    mockPrepare
      .mockReset()
      .mockReturnValueOnce({ get: verifyMock });

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
      "key = 'key''with''quotes'",
    );
  });
});
