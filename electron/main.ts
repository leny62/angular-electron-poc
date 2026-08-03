/**
 * Electron main process entry point.
 *
 * Startup order (Section 9.1):
 *   1. Open / migrate the encrypted SQLite database.
 *   2. Initialise the command registry (frozen before window opens).
 *   3. Create the BrowserWindow with secure defaults.
 *   4. Register the IPC gateway.
 *   5. Load the Angular application.
 *
 * The database is opened BEFORE the window so the renderer can never
 * issue a command against a half-migrated schema.  If migration fails
 * the engine goes to FATAL and the window still opens (showing a
 * diagnostic screen), because a window that fails silently when
 * double-clicked generates a support call with zero information.
 */

import { app, BrowserWindow } from 'electron';
import { join } from 'path';
import { ConnectionManager } from './database/connection';
import { EngineStateMachine } from './domain/engine-state';
import { initialiseRegistry } from './domain/command-registry';
import { createCommandDefinitions } from './ipc/handlers';
import { registerIpcGateway } from './ipc/gateway';

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const ALLOWED_ORIGIN = 'http://localhost:4200'; // dev server origin

// Phase 0: no encryption (prove IPC pipeline first).
// Phase 2: 'bizuri-poc-dev-key-2026' → PBKDF2 derivation from
// device secret + machine binding.
const DEV_PASSPHRASE: string | undefined = undefined;

// ---------------------------------------------------------------------------
// Globals (session lifetime)
// ---------------------------------------------------------------------------

let mainWindow: BrowserWindow | null = null;
let connectionManager: ConnectionManager | null = null;
let engineState: EngineStateMachine | null = null;
let unregisterIpc: (() => void) | null = null;

// ---------------------------------------------------------------------------
// Startup
// ---------------------------------------------------------------------------

app.whenReady().then(startup);

app.on('window-all-closed', () => {
  // On macOS it's conventional to keep the app running until Cmd+Q.
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('activate', () => {
  // macOS dock click re-creates the window.
  if (BrowserWindow.getAllWindows().length === 0) {
    createWindow();
  }
});

app.on('before-quit', () => {
  shutdown();
});

// ---------------------------------------------------------------------------
// Startup sequence
// ---------------------------------------------------------------------------

async function startup(): Promise<void> {
  engineState = new EngineStateMachine();

  // 1. Open and migrate the database.
  const dbDir = app.getPath('userData');
  const dbPath = join(dbDir, 'bizuri-poc.db');

  connectionManager = new ConnectionManager({
    dbPath,
    passphrase: DEV_PASSPHRASE,
  });

  try {
    connectionManager.open();
    console.log(`[main] Database opened: ${dbPath}`);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[main] Database open failed: ${message}`);
    engineState.markFatal(`Database initialisation failed: ${message}`);
  }

  // 2. Initialise the command registry (frozen).
  if (engineState.state !== 'FATAL') {
    const db = connectionManager!.get();

    // Seed a device session row if this is the first run.
    seedDeviceSession(db);

    const definitions = createCommandDefinitions({
      db: () => {
        if (!connectionManager?.isOpen) {
          throw new Error('Database connection lost.');
        }
        return connectionManager.get();
      },
      engineState: engineState,
      deviceId: 'poc-device-001',
      tenantId: 'poc-tenant',
      branchId: 'poc-branch',
      receiptPrefix: 'RCP',
    });

    initialiseRegistry(definitions);
    console.log(`[main] Command registry initialised with ${definitions.length} commands.`);
  }

  // 3. Create the window.
  createWindow();

  // 4. Register the IPC gateway.
  unregisterIpc = registerIpcGateway({
    mainWindow: mainWindow!,
    allowedOrigin: ALLOWED_ORIGIN,
    engineState: engineState,
  });

  console.log(`[main] IPC gateway registered.`);
  console.log(`[main] Engine state: ${engineState.describe()}`);
}

// ---------------------------------------------------------------------------
// Window creation
// ---------------------------------------------------------------------------

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    title: 'Bizuri PoC — Secure IPC',
    webPreferences: {
      preload: join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  // Load the Angular dev server.
  mainWindow.loadURL(ALLOWED_ORIGIN);

  // Open DevTools in dev mode for diagnostics.
  if (process.env.NODE_ENV !== 'production') {
    mainWindow.webContents.openDevTools();
  }

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

// ---------------------------------------------------------------------------
// Shutdown
// ---------------------------------------------------------------------------

function shutdown(): void {
  if (engineState) {
    engineState.markDraining();
  }

  if (unregisterIpc) {
    unregisterIpc();
    unregisterIpc = null;
  }

  if (connectionManager) {
    connectionManager.close();
    console.log('[main] Database closed.');
  }
}

// ---------------------------------------------------------------------------
// Seed data
// ---------------------------------------------------------------------------

/**
 * Insert bootstrap data on first run so the PoC has something to query.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function seedDeviceSession(db: any): void {
  const existing = db.prepare('SELECT COUNT(*) AS c FROM device_session').get() as { c: number };

  if (existing.c > 0) {
    return;
  }

  const now = new Date().toISOString();

  db.prepare(`
    INSERT INTO device_session (device_id, tenant_id, branch_id, receipt_prefix, receipt_seq, activated_at)
    VALUES ('poc-device-001', 'poc-tenant', 'poc-branch', 'RCP', 0, ?)
  `).run(now);

  // Seed a few catalog items so sale.create has prices to resolve.
  const items = [
    ['cat-001', 'poc-branch', 'ITEM-001', 'Cement 50kg', 'BRC001', '12000', '0', 'VAT', '18', '500', 'UNIT'],
    ['cat-002', 'poc-branch', 'ITEM-002', 'Steel Bar 12mm', 'BRC002', '8500', '0', 'VAT', '18', '200', 'UNIT'],
    ['cat-003', 'poc-branch', 'ITEM-003', 'Paint 20L White', 'BRC003', '45000', '5', 'VAT', '18', '50', 'UNIT'],
    ['cat-004', 'poc-branch', 'ITEM-004', 'Sand 1 Ton', 'BRC004', '25000', '0', 'VAT', '0', '100', 'WEIGHT'],
    ['cat-005', 'poc-branch', 'ITEM-005', 'Nails 5kg Box', 'BRC005', '3200', '0', 'VAT', '18', '1000', 'UNIT'],
  ];

  const insert = db.prepare(`
    INSERT INTO catalog_item (item_id, branch_id, item_code, item_name, barcode,
      selling_price, discount, tax_category_name, tax_category_rate,
      available_qty, sell_mode, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  for (const row of items) {
    insert.run(...row, now);
  }

  console.log('[main] Seeded device session and catalog items.');
}
