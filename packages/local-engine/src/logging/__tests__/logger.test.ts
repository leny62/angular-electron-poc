/**
 * Logger behaviour.
 *
 * The properties under test are the ones that decide whether a log is worth
 * having during an incident: entries survive a database that is not open yet,
 * ordering is stable enough to paginate, the request id follows the call
 * without being threaded through it, and a hostile renderer cannot use the
 * write path to corrupt the table or fill the disk.
 */

import Database from 'better-sqlite3-multiple-ciphers';
import type { SystemLogRow } from '@bizuri/local-store';
import { runMigrations } from '../../store/migrations';
import type { SqliteDatabase } from '../../store/types';
import {
  configureLogging,
  flush,
  getLogger,
  pruneLogs,
  resetLogging,
  withLogContext,
} from '../logger';
import { makeLogOps } from '../../operations/log-ops';
import type { OperationContext } from '../../contracts';

const DEVICE = 'device-logger-01';

let db: SqliteDatabase;

const open = (): SqliteDatabase => {
  const handle = new Database(':memory:') as unknown as SqliteDatabase;
  handle.pragma('foreign_keys = ON');
  runMigrations(handle);
  return handle;
};

const allRows = () =>
  db
    .prepare('SELECT * FROM system_logs ORDER BY seq ASC')
    .all() as unknown as SystemLogRow[];

beforeEach(() => {
  resetLogging();
  db = open();
});

afterEach(() => {
  resetLogging();
  db.close();
});

// ---------------------------------------------------------------------------

describe('sink configuration', () => {
  it('writes buffered entries once flushed', () => {
    configureLogging({ db: () => db, deviceId: DEVICE, console: false });

    getLogger('unit').info('hello');
    flush();

    const rows = allRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      level: 'INFO',
      logger: 'unit',
      message: 'hello',
      source: 'SERVER',
      component: 'APPLICATION',
      device_id: DEVICE,
    });
  });

  it('holds entries logged before the database opens, then writes them', () => {
    // The engine logs its own startup before it has anywhere to put the lines.
    // Dropping them would remove exactly the entries that explain a failed
    // start, which is the one failure nobody can reproduce on demand.
    let handle: SqliteDatabase | null = null;
    configureLogging({ db: () => handle, console: false });

    getLogger('boot').info('engine starting');
    flush();

    handle = db;
    getLogger('boot').info('store opened');
    flush();

    expect(allRows().map((r) => r.message)).toEqual(['engine starting', 'store opened']);
  });

  it('does not throw when the database getter itself throws', () => {
    // `requireDb` throws while locked rather than returning null.
    configureLogging({
      db: () => {
        throw new Error('Engine is locked.');
      },
      console: false,
    });

    expect(() => {
      getLogger('unit').error('boom', new Error('inner'));
    }).not.toThrow();
  });

  it('respects the minimum level', () => {
    configureLogging({ db: () => db, console: false, minLevel: 'WARN' });

    const log = getLogger('unit');
    log.debug('dropped');
    log.info('dropped');
    log.warn('kept');
    flush();

    expect(allRows().map((r) => r.message)).toEqual(['kept']);
  });

  it('flushes immediately on ERROR without waiting for the buffer', () => {
    configureLogging({ db: () => db, console: false, bufferSize: 100 });

    getLogger('unit').info('buffered');
    expect(allRows()).toHaveLength(0);

    getLogger('unit').error('now', new Error('bang'));

    // The error forces the whole buffer out, so the INFO ahead of it lands too.
    expect(allRows().map((r) => r.message)).toEqual(['buffered', 'now']);
  });

  it('writes automatically once the buffer fills', () => {
    configureLogging({ db: () => db, console: false, bufferSize: 3 });

    const log = getLogger('unit');
    log.info('one');
    log.info('two');
    expect(allRows()).toHaveLength(0);

    log.info('three');
    expect(allRows()).toHaveLength(3);
  });
});

describe('sequence', () => {
  it('assigns a strictly increasing seq so pages cannot repeat rows', () => {
    configureLogging({ db: () => db, console: false, bufferSize: 1 });

    const log = getLogger('unit');
    for (let i = 0; i < 10; i++) log.info(`entry ${i}`);
    flush();

    const seqs = allRows().map((r) => Number(r.seq));
    expect(seqs).toEqual([...seqs].sort((a, b) => a - b));
    expect(new Set(seqs).size).toBe(10);
  });

  it('continues the sequence across a restart rather than restarting at zero', () => {
    configureLogging({ db: () => db, console: false });
    getLogger('unit').info('first session');
    flush();

    const firstMax = Math.max(...allRows().map((r) => Number(r.seq)));

    // A new process against the same file.
    resetLogging();
    configureLogging({ db: () => db, console: false });
    getLogger('unit').info('second session');
    flush();

    const seqs = allRows().map((r) => Number(r.seq));
    expect(Math.max(...seqs)).toBeGreaterThan(firstMax);
    expect(new Set(seqs).size).toBe(seqs.length);
  });
});

describe('ambient context', () => {
  it('attaches the request id to entries logged inside the scope', () => {
    configureLogging({ db: () => db, console: false });

    withLogContext({ requestId: 'req-42', url: 'createSale', tenantId: 'tenant-a' }, () => {
      // A logger from a different module, with no idea a request is in flight.
      getLogger('create-sale').info('committed');
    });
    flush();

    expect(allRows()[0]).toMatchObject({
      request_id: 'req-42',
      url: 'createSale',
      tenant_id: 'tenant-a',
    });
  });

  it('does not leak context to entries logged outside the scope', () => {
    configureLogging({ db: () => db, console: false });

    withLogContext({ requestId: 'req-1' }, () => getLogger('a').info('inside'));
    getLogger('b').info('outside');
    flush();

    const rows = allRows();
    expect(rows[0]?.['request_id']).toBe('req-1');
    expect(rows[1]?.['request_id']).toBeNull();
  });

  it('survives an await, so async handlers keep their correlation id', async () => {
    configureLogging({ db: () => db, console: false });

    await withLogContext({ requestId: 'req-async' }, async () => {
      await Promise.resolve();
      getLogger('handler').info('after await');
    });
    flush();

    expect(allRows()[0]?.['request_id']).toBe('req-async');
  });

  it('lets an explicit field win over the ambient one', () => {
    configureLogging({ db: () => db, console: false });

    withLogContext({ requestId: 'ambient' }, () => {
      getLogger('unit').info('explicit', { requestId: 'override' });
    });
    flush();

    expect(allRows()[0]?.['request_id']).toBe('override');
  });
});

describe('exception formatting', () => {
  it('records type, message, and stack', () => {
    configureLogging({ db: () => db, console: false });

    getLogger('unit').error('failed', new TypeError('bad shape'));
    flush();

    const exception = String(allRows()[0]?.['exception']);
    expect(exception).toContain('TypeError: bad shape');
    expect(exception).toContain('logger.test.ts');
  });

  it('handles a thrown non-Error without losing the entry', () => {
    configureLogging({ db: () => db, console: false });

    getLogger('unit').error('failed', { code: 42 });
    flush();

    expect(allRows()).toHaveLength(1);
    expect(String(allRows()[0]?.['exception'])).toContain('42');
  });
});

describe('retention', () => {
  it('drops entries past the row cap, keeping the newest', () => {
    configureLogging({ db: () => db, console: false, maxRows: 5, bufferSize: 1 });

    const log = getLogger('unit');
    for (let i = 0; i < 12; i++) log.info(`entry ${i}`);
    flush();
    expect(allRows()).toHaveLength(12);

    pruneLogs(db);

    const kept = allRows().map((r) => r.message);
    expect(kept).toHaveLength(5);
    expect(kept).toEqual(['entry 7', 'entry 8', 'entry 9', 'entry 10', 'entry 11']);
  });

  it('drops entries older than the retention window', () => {
    configureLogging({ db: () => db, console: false, retentionDays: 7, maxRows: 1000 });

    getLogger('unit').info('recent');
    flush();

    db.prepare(
      `INSERT INTO system_logs (
         id, seq, logged_at, level, component, source, logger, message,
         exception, user_name, url, request_id, code, device_id, thread,
         tenant_id, context
       ) VALUES (?,?,?,'INFO','APPLICATION','SERVER','old','ancient',
                 NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL)`,
    ).run('old-id', 0, new Date(Date.now() - 30 * 86_400_000).toISOString());

    pruneLogs(db);

    expect(allRows().map((r) => r.message)).toEqual(['recent']);
  });
});

// ---------------------------------------------------------------------------
// Renderer write path
// ---------------------------------------------------------------------------

describe('writeSystemLogs', () => {
  const ops = () => makeLogOps({ db: () => db, deviceId: DEVICE });

  const ctx = (body: unknown): OperationContext =>
    ({
      request: {
        v: 1,
        id: 'req-1',
        operationId: 'writeSystemLogs',
        method: 'POST',
        pathParams: {},
        query: {},
        headers: {},
        issuedAt: new Date().toISOString(),
        body,
      },
      tenantId: 'tenant-a',
    }) as OperationContext;

  beforeEach(() => configureLogging({ db: () => db, deviceId: DEVICE, console: false }));

  it('stamps renderer entries as BROWSER regardless of what was sent', () => {
    ops().writeSystemLogs(
      ctx({ entries: [{ level: 'INFO', logger: 'pos', message: 'clicked', source: 'SERVER' }] }),
    );

    expect(allRows()[0]).toMatchObject({
      source: 'BROWSER',
      logger: 'pos',
      message: 'clicked',
      thread: 'renderer',
      device_id: DEVICE,
      tenant_id: 'tenant-a',
    });
  });

  it('normalises an unknown level rather than failing the whole batch', () => {
    // The column has a CHECK constraint, so one bad value would otherwise roll
    // back every well-formed entry alongside it.
    ops().writeSystemLogs(
      ctx({
        entries: [
          { level: 'TRACE', logger: 'a', message: 'first' },
          { level: 'ERROR', logger: 'b', message: 'second' },
        ],
      }),
    );

    const rows = allRows();
    expect(rows).toHaveLength(2);
    expect(rows[0]?.['level']).toBe('INFO');
    expect(rows[1]?.['level']).toBe('ERROR');
  });

  it('rejects a backdated timestamp it cannot parse', () => {
    ops().writeSystemLogs(
      ctx({ entries: [{ level: 'INFO', logger: 'a', message: 'x', loggedAt: 'not-a-date' }] }),
    );

    const loggedAt = String(allRows()[0]?.['logged_at']);
    expect(Number.isNaN(Date.parse(loggedAt))).toBe(false);
  });

  it('truncates an oversized message instead of storing it whole', () => {
    ops().writeSystemLogs(
      ctx({ entries: [{ level: 'INFO', logger: 'a', message: 'x'.repeat(10_000) }] }),
    );

    expect(String(allRows()[0]?.['message']).length).toBeLessThanOrEqual(4000);
  });

  it('reports how many entries it accepted', () => {
    const result = ops().writeSystemLogs(
      ctx({
        entries: [
          { level: 'INFO', logger: 'a', message: 'one' },
          { level: 'WARN', logger: 'a', message: 'two' },
        ],
      }),
    );

    expect(result.status).toBe(202);
    expect(result.data).toMatchObject({ data: { accepted: 2 } });
  });
});

describe('listSystemLogs', () => {
  const ops = () => makeLogOps({ db: () => db, deviceId: DEVICE });

  const ctx = (query: Record<string, string>): OperationContext =>
    ({
      request: {
        v: 1,
        id: 'req-read',
        operationId: 'listSystemLogs',
        method: 'GET',
        pathParams: {},
        query,
        headers: {},
        issuedAt: new Date().toISOString(),
      },
      tenantId: 'tenant-a',
    }) as OperationContext;

  interface Page {
    data: { message: string; level: string }[];
    meta: { page: number; size: number; totalElements: number; totalPages: number };
  }

  beforeEach(() => {
    configureLogging({ db: () => db, deviceId: DEVICE, console: false, bufferSize: 1 });
    const app = getLogger('catalog');
    const queue = getLogger('sync-worker', 'QUEUE_SERVICE');
    app.info('catalog loaded');
    app.warn('slow query');
    queue.error('push failed', new Error('offline'));
    flush();
  });

  it('returns newest first', () => {
    const page = ops().listSystemLogs(ctx({})).data as Page;
    expect(page.data[0]?.message).toBe('push failed');
    expect(page.meta.totalElements).toBe(3);
  });

  it('filters by component', () => {
    const page = ops().listSystemLogs(ctx({ component: 'QUEUE_SERVICE' })).data as Page;
    expect(page.data.map((r) => r.message)).toEqual(['push failed']);
  });

  it('filters by level', () => {
    const page = ops().listSystemLogs(ctx({ level: 'WARN' })).data as Page;
    expect(page.data.map((r) => r.message)).toEqual(['slow query']);
  });

  it('searches message text', () => {
    const page = ops().listSystemLogs(ctx({ search: 'loaded' })).data as Page;
    expect(page.data.map((r) => r.message)).toEqual(['catalog loaded']);
  });

  it('searches the logger name too, so one term finds a module', () => {
    // Both entries below came from the `catalog` logger; only one says
    // "catalog" in its message. Searching the logger name is what makes
    // "show me everything this module did" a single query.
    const page = ops().listSystemLogs(ctx({ search: 'catalog' })).data as Page;
    expect(page.data.map((r) => r.message).sort()).toEqual(['catalog loaded', 'slow query']);
  });

  it('searches exception text, so a stack fragment finds its entry', () => {
    const page = ops().listSystemLogs(ctx({ search: 'offline' })).data as Page;
    expect(page.data.map((r) => r.message)).toEqual(['push failed']);
  });

  it('paginates without repeating a row', () => {
    const first = ops().listSystemLogs(ctx({ page: '0', size: '2' })).data as Page;
    const second = ops().listSystemLogs(ctx({ page: '1', size: '2' })).data as Page;

    expect(first.data).toHaveLength(2);
    expect(second.data).toHaveLength(1);
    expect(first.meta.totalPages).toBe(2);

    const seen = [...first.data, ...second.data].map((r) => r.message);
    expect(new Set(seen).size).toBe(3);
  });

  it('returns an empty page rather than failing while the store is closed', () => {
    const locked = makeLogOps({ db: () => null, deviceId: DEVICE });
    const result = locked.listSystemLogs(ctx({}));

    expect(result.status).toBe(200);
    expect((result.data as Page).data).toEqual([]);
  });
});
