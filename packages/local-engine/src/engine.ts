/**
 * Engine bootstrap. The single entry point a host application calls.
 */

import type { BrowserWindow } from 'electron';
import { CONTRACT_VERSION } from '@bizuri/local-store';
import { EngineStateMachine } from './domain/engine-state';
import {
  buildRegistry,
  emitEvent,
  registerGateway,
  resetRegistry,
  type RegistryEntry,
} from './gateway/gateway';
import { expectedOrigin } from './gateway/sender-verification';
import {
  configureLogging,
  getLogger,
  shutdownLogging,
  type LoggingConfig,
} from './logging/logger';
import { makeCreateSale } from './operations/create-sale';
import { makeEngineOps } from './operations/engine-ops';
import { makeLogOps } from './operations/log-ops';
import { buildReaders } from './operations/read-configs';
import { makeCancelSale, makeConfirmSale, makeCreateCustomer } from './operations/sale-ops';
import { hydrate } from './remote/hydrate';
import { RemoteClient, type Credentials, type Session } from './remote/remote-client';
import { deriveKey, generateMachineSalt, keyToHex, zeroBuffer } from './security/key-derivation';
import { ConnectionManager } from './store/connection';
import type { MigrationResult } from './store/migrations';
import type { SqliteDatabase } from './store/types';
import { SyncWorker } from './sync/sync-worker';

interface SeedDeviceSessionInput {
  deviceId: string;
  tenantId: string;
  branchId: string;
  tenantSlug: string;
  contractVersion: string;
}

/** Create the device_session row if it does not already exist. */
function seedDeviceSession(db: SqliteDatabase, input: SeedDeviceSessionInput): void {
  const existing = db
    .prepare('SELECT device_id FROM device_session WHERE device_id = ?')
    .get(input.deviceId);

  if (existing) return;

  const prefix =
    input.tenantSlug.slice(0, 3).toUpperCase() +
    input.deviceId.slice(0, 3).toUpperCase();

  db.prepare(
    `INSERT INTO device_session
       (device_id, tenant_id, branch_id, tenant_slug, receipt_prefix,
        receipt_seq, last_receipt_hash, contract_version, activated_at)
     VALUES (?,?,?,?,?,0,NULL,?,?)`,
  ).run(
    input.deviceId, input.tenantId, input.branchId, input.tenantSlug,
    prefix, input.contractVersion, new Date().toISOString(),
  );
}

export interface LocalEngineConfig {
  readonly mainWindow: BrowserWindow;
  readonly dbPath: string;
  readonly deviceId: string;
  readonly apiBaseUrl: string;
  readonly isDev: boolean;
  readonly devPort?: number;
  /**
   * Persisted machine salt. A fresh one each launch would derive a different
   * key from the same passphrase and make the database unreadable.
   */
  readonly machineSalt?: Buffer;
  /** Skip SQLCipher. Development only. */
  readonly unencrypted?: boolean;
  readonly syncIntervalMs?: number;
  /**
   * Open the database at startup without a passphrase. Only meaningful with
   * `unencrypted`, where there is no key for a passphrase to protect.
   */
  readonly autoUnlock?: boolean;
  /** Sign in at startup so the first hydration can run unattended. */
  readonly credentials?: Credentials;
  /** Start the periodic sync cycle once the engine is operational. */
  readonly autoStartSync?: boolean;
  /**
   * Diagnostic logging. Defaults are production-sane, so a host that does not
   * care passes nothing; `db` and `deviceId` are supplied by the engine.
   */
  readonly logging?: Omit<LoggingConfig, 'db' | 'deviceId'>;
}

export interface LocalEngine {
  readonly state: EngineStateMachine;
  readonly sync: SyncWorker;
  db(): SqliteDatabase;
  client(): RemoteClient | null;
  signIn(credentials: Credentials): Promise<Session>;
  migration(): MigrationResult | null;
  dispose(): void;
}

export function createLocalEngine(config: LocalEngineConfig): LocalEngine {
  const state = new EngineStateMachine();
  const salt = config.machineSalt ?? generateMachineSalt();

  let connection: ConnectionManager | null = null;
  let db: SqliteDatabase | null = null;
  let migration: MigrationResult | null = null;
  let client: RemoteClient | null = null;
  let session: Session | null = null;

  // First thing, before anything can fail. Entries logged while the database is
  // still closed are held in memory and written once it opens, so a failure
  // during startup is still readable in the viewer afterwards.
  configureLogging({
    ...config.logging,
    db: () => db,
    deviceId: config.deviceId,
  });

  const log = getLogger('engine');
  const deviceLog = getLogger('engine.device', 'DEVICE_SERVICE');

  const requireDb = (): SqliteDatabase => {
    if (!db) throw new Error('Engine is locked. Unlock before use.');
    return db;
  };

  const scope = () =>
    session ? { tenantId: session.tenantId, branchId: session.branchId } : null;

  const sync = new SyncWorker({
    db: requireDb,
    client: () => client,
    engineState: state,
    deviceId: config.deviceId,
    scope,
    ...(config.syncIntervalMs !== undefined ? { intervalMs: config.syncIntervalMs } : {}),
    onEvent: (topic, data) => emitEvent(config.mainWindow, topic, data),
  });

  state.onChange((change) => emitEvent(config.mainWindow, 'engine.state', change));

  async function unlock(passphrase: string): Promise<void> {
    if (db) return;

    const startedAt = Date.now();
    const material = deriveKey(passphrase, salt);
    try {
      connection = new ConnectionManager({
        dbPath: config.dbPath,
        ...(config.unencrypted ? {} : { keyHex: keyToHex(material.key) }),
      });
      const opened = connection.open();
      db = opened.db;
      migration = opened.migration;
    } catch (err) {
      deviceLog.error('Failed to open the local store', err, {
        code: 'E_STORAGE',
        context: { encrypted: !config.unencrypted },
      });
      throw err;
    } finally {
      zeroBuffer(material.key);
      zeroBuffer(material.verifier);
    }

    deviceLog.info('Local store opened', {
      code: 'OK',
      context: {
        encrypted: !config.unencrypted,
        durationMs: Date.now() - startedAt,
        schemaFrom: migration.fromVersion,
        schemaTo: migration.toVersion,
        created: migration.created,
        rebuilt: migration.rebuilt,
        migrated: migration.migrated,
        needsHydration: migration.needsHydration,
      },
    });

    // Tables that were just created or rebuilt hold nothing, so the POS must not
    // read them as though they were current.
    state.markHydrating(
      migration.needsHydration.length > 0
        ? 'Loading catalog and stock'
        : 'Checking for updates',
    );

    if (client && scope()) {
      void hydrateThenReady();
    } else {
      // No session yet: the local store may still hold a previous shift's data,
      // so allow trading rather than blocking on a login that may not come.
      state.markReady();
    }
  }

  async function hydrateThenReady(): Promise<void> {
    const activeClient = client;
    const activeScope = scope();
    if (!activeClient || !activeScope || !db) return;

    const startedAt = Date.now();
    try {
      const result = await hydrate(db, activeClient, activeScope, {
        onProgress: (t) => emitEvent(config.mainWindow, 'hydration.progress', t),
      });
      log.info('Hydration complete', {
        code: 'OK',
        context: {
          rows: result.totalRows,
          pages: result.totalPages,
          failed: result.failed,
          durationMs: Date.now() - startedAt,
        },
      });
      state.markReady();
    } catch (err) {
      // Hydration failing is not fatal. Whatever is already local is still
      // sellable, and the sync worker will retry.
      log.warn('Hydration failed; selling from the existing local replica', {
        exception: err,
        code: 'E_STORAGE',
        context: { durationMs: Date.now() - startedAt },
      });
      state.markReady();
    }
  }

  async function signIn(credentials: Credentials): Promise<Session> {
    client ??= new RemoteClient({ baseUrl: config.apiBaseUrl });

    try {
      session = await client.login(credentials);
    } catch (err) {
      // The email is recorded; the password is not, and never reaches a field
      // that is written to disk.
      log.warn('Sign-in failed', {
        exception: err,
        code: 'E_FORBIDDEN',
        userName: credentials.email,
        context: { slug: credentials.subdomainSlug, api: config.apiBaseUrl },
      });
      throw err;
    }

    log.info('Signed in', {
      code: 'OK',
      userName: credentials.email,
      tenantId: session.tenantId,
      context: { branchId: session.branchId, slug: credentials.subdomainSlug },
    });

    // Seed the device_session row so the receipt chain can issue receipts.
    // In production this row comes from a device-registration API call; for
    // the POC we create it on first sign-in with a deterministic prefix.
    if (db && session.tenantId) {
      seedDeviceSession(db, {
        deviceId: config.deviceId,
        tenantId: session.tenantId,
        branchId: session.branchId,
        tenantSlug: credentials.subdomainSlug,
        contractVersion: CONTRACT_VERSION,
      });
    }

    // When the engine started with credentials, unlock() already left it
    // HYDRATING and this triggers the first pull. When the user signs in
    // interactively through the UI, the engine is already READY and needs
    // the same initial hydration to fill the catalog and stock tables.
    if (db && (state.state === 'HYDRATING' || state.state === 'READY')) void hydrateThenReady();
    return session;
  }

  const engineOps = makeEngineOps({
    engineState: state,
    db: () => db,
    deviceId: config.deviceId,
    unlock,
    syncNow: () => sync.run(),
    scope,
    signIn,
  });

  const writeDeps = {
    get db() {
      return requireDb();
    },
    deviceId: config.deviceId,
    contractVersion: CONTRACT_VERSION,
  };

  const readers = buildReaders(requireDb);

  const logOps = makeLogOps({ db: () => db, deviceId: config.deviceId });

  const entries: RegistryEntry[] = [
    ...Object.entries(readers).map(([operationId, handler]) => ({ operationId, handler })),
    { operationId: 'listSystemLogs', handler: logOps.listSystemLogs },
    { operationId: 'writeSystemLogs', handler: logOps.writeSystemLogs },
    { operationId: 'createSale', handler: makeCreateSale(writeDeps) },
    { operationId: 'confirmSale', handler: makeConfirmSale(writeDeps) },
    { operationId: 'cancelSale', handler: makeCancelSale(writeDeps) },
    { operationId: 'createCustomer', handler: makeCreateCustomer(writeDeps) },
    { operationId: 'engineUnlock', handler: engineOps.engineUnlock },
    { operationId: 'engineSignIn', handler: engineOps.engineSignIn },
    { operationId: 'engineStatus', handler: engineOps.engineStatus },
    { operationId: 'engineSyncNow', handler: engineOps.engineSyncNow },
  ];

  resetRegistry();
  buildRegistry(entries);

  const unregister = registerGateway({
    mainWindow: config.mainWindow,
    allowedOrigin: expectedOrigin(config.isDev, config.devPort),
    engineState: state,
  });

  async function start(): Promise<void> {
    log.info('Engine starting', {
      code: 'OK',
      context: {
        api: config.apiBaseUrl,
        dev: config.isDev,
        encrypted: !config.unencrypted,
        contractVersion: CONTRACT_VERSION,
      },
    });

    if (config.credentials) {
      try {
        await signIn(config.credentials);
      } catch {
        // Selling from whatever is already local beats refusing to start.
        // `signIn` already logged the cause.
      }
    }

    if (config.autoUnlock) {
      if (!config.unencrypted) {
        throw new Error('autoUnlock requires unencrypted; there is no passphrase to skip.');
      }
      await unlock('');
    }

    // When credentials were supplied at startup, signIn ran before unlock and
    // could not seed device_session because the database was not open yet. Do
    // it now so the receipt chain works from the first sale.
    if (db && session && session.tenantId) {
      seedDeviceSession(db, {
        deviceId: config.deviceId,
        tenantId: session.tenantId,
        branchId: session.branchId,
        tenantSlug: config.credentials?.subdomainSlug ?? '',
        contractVersion: CONTRACT_VERSION,
      });
    }

    if (config.autoStartSync) sync.start();
  }

  void start().catch((err: unknown) => {
    log.fatal('Engine failed to start', err, { code: 'E_INTERNAL' });
  });

  return {
    state,
    sync,
    db: requireDb,
    client: () => client,
    signIn,
    migration: () => migration,
    dispose() {
      sync.stop();
      unregister();
      state.markDraining();
      log.info('Engine shutting down', { code: 'OK' });
      // Before the connection closes: the flush needs an open database, and
      // "shutting down" is the line that tells a support engineer the previous
      // session ended cleanly rather than crashing.
      shutdownLogging();
      connection?.close();
      db = null;
    },
  };
}
