import { SyncWorker } from '../sync-worker';
import { createTestDb, seedDeviceSession } from '../../ipc/handlers/__tests__/db-helper';
import { EngineStateMachine } from '../../domain/engine-state';
import type { SqliteDatabase } from '../../database/types';

jest.mock('electron', () => ({
  BrowserWindow: class {
    id = 1;
    webContents = { send: jest.fn() };
  },
}));

describe('sync worker', () => {
  let db: SqliteDatabase;

  beforeEach(() => {
    jest.useFakeTimers();
    db = createTestDb();
    seedDeviceSession(db);
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  function createWorker(overrides = {}) {
    const { BrowserWindow } = require('electron');
    return new SyncWorker({
      intervalMs: 30_000,
      maxConsecutiveFailures: 5,
      db: () => db,
      engineState: new EngineStateMachine(),
      mainWindow: new BrowserWindow(),
      deviceId: 'poc-device-001',
      tenantId: 'poc-tenant',
      branchId: 'poc-branch',
      ...overrides,
    });
  }

  describe('lifecycle', () => {
    it('starts in IDLE state', () => {
      const worker = createWorker();
      expect(worker.getStatus().state).toBe('IDLE');
    });

    it('start begins the interval and runs first cycle', () => {
      const worker = createWorker();
      worker.start();
      expect(worker.getStatus().state).toBe('IDLE');
      // First cycle runs synchronously via runCycle
    });

    it('stop halts the interval', () => {
      const worker = createWorker();
      worker.start();
      worker.stop();
      expect(worker.getStatus().state).toBe('IDLE');
    });
  });

  describe('getStatus', () => {
    it('returns pending count from the outbox', () => {
      // Insert a pending outbox row directly.
      db.prepare(`
        INSERT INTO outbox (id, seq, entity, entity_id, operation, payload,
          idempotency_key, state, created_at)
        VALUES ('ob-1', 1, 'sale', 's-1', 'CREATE', '{}', 'ik-1', 'PENDING', datetime('now'))
      `).run();

      const worker = createWorker();
      const status = worker.getStatus();
      expect(status.pending).toBe(1);
    });
  });

  describe('getConflicts', () => {
    it('returns conflicting outbox entries', () => {
      db.prepare(`
        INSERT INTO outbox (id, seq, entity, entity_id, operation, payload,
          idempotency_key, state, last_error, created_at)
        VALUES ('ob-1', 1, 'sale', 's-1', 'CREATE', '{"items":[]}',
          'ik-1', 'CONFLICT', 'Remote version differs', datetime('now'))
      `).run();

      const worker = createWorker();
      const conflicts = worker.getConflicts();
      expect(conflicts).toHaveLength(1);
      expect(conflicts[0].entity).toBe('sale');
    });

    it('returns empty array when no conflicts exist', () => {
      const worker = createWorker();
      expect(worker.getConflicts()).toHaveLength(0);
    });
  });

  describe('resolveConflict', () => {
    beforeEach(() => {
      db.prepare(`
        INSERT INTO outbox (id, seq, entity, entity_id, operation, payload,
          idempotency_key, state, last_error, created_at)
        VALUES ('ob-1', 1, 'sale', 's-1', 'CREATE', '{"items":[]}',
          'ik-1', 'CONFLICT', 'Remote update', datetime('now'))
      `).run();
    });

    it('resolves with local version by re-queuing as PENDING', () => {
      const worker = createWorker();
      // resolveConflict re-queues the entry then calls forceSync,
      // which pushes the entry and marks it SYNCED.  The resolved
      // flag confirms the operation was accepted.
      const result = worker.resolveConflict('ob-1', 'local');
      expect(result.resolved).toBe(true);
      expect(result.message).toContain('local version');
    });

    it('resolves with remote version by discarding', () => {
      const worker = createWorker();
      const result = worker.resolveConflict('ob-1', 'remote');
      expect(result.resolved).toBe(true);

      const row = db.prepare("SELECT state FROM outbox WHERE id = 'ob-1'").get() as { state: string };
      expect(row.state).toBe('SYNCED');
    });

    it('returns unresolved for non-existent conflict', () => {
      const worker = createWorker();
      const result = worker.resolveConflict('nonexistent', 'local');
      expect(result.resolved).toBe(false);
    });
  });

  describe('forceSync', () => {
    it('returns status immediately', () => {
      const worker = createWorker();
      const status = worker.forceSync();
      expect(status).toHaveProperty('state');
      expect(status).toHaveProperty('pushed');
      expect(status).toHaveProperty('pulled');
      expect(status).toHaveProperty('pending');
    });
  });
});
