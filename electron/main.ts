/**
 * Electron entry point for the POC harness.
 *
 * All offline behaviour lives in @bizuri/local-engine. This file only owns the
 * window and the app lifecycle, which is what makes the same wiring a small
 * change in BIZURI-Frontend.
 */

import { app, BrowserWindow, safeStorage } from 'electron';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { createLocalEngine, type LocalEngine } from '@bizuri/local-engine';

const DEV_PORT = 4200;
const isDev = !app.isPackaged;

const API_BASE_URL =
  process.env['BIZURI_API'] ?? 'https://api.bizuri.testing.eccellenza.tech';

let mainWindow: BrowserWindow | null = null;
let engine: LocalEngine | null = null;

/**
 * Machine salt, persisted so the same passphrase derives the same key on every
 * launch. Encrypted with the OS keystore where available.
 */
function loadMachineSalt(dir: string): Buffer {
  const file = join(dir, 'device.salt');

  if (existsSync(file)) {
    const stored = readFileSync(file);
    return safeStorage.isEncryptionAvailable()
      ? Buffer.from(safeStorage.decryptString(stored), 'base64')
      : stored;
  }

  const salt = Buffer.from(crypto.getRandomValues(new Uint8Array(32)));
  writeFileSync(
    file,
    safeStorage.isEncryptionAvailable()
      ? safeStorage.encryptString(salt.toString('base64'))
      : salt,
    { mode: 0o600 },
  );
  return salt;
}

function deviceId(dir: string): string {
  const file = join(dir, 'device.id');
  if (existsSync(file)) return readFileSync(file, 'utf8').trim();

  const id = crypto.randomUUID();
  writeFileSync(file, id, { mode: 0o600 });
  return id;
}

/**
 * Startup credentials from the environment, so the first hydration runs without
 * a login screen the POC does not have.
 */
function devCredentials() {
  const email = process.env['BIZURI_EMAIL'];
  const password = process.env['BIZURI_PASSWORD'];
  const subdomainSlug = process.env['BIZURI_SLUG'];
  return email && password && subdomainSlug ? { email, password, subdomainSlug } : null;
}

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 860,
    title: 'Bizuri PoC',
    backgroundColor: '#16697A',
    webPreferences: {
      preload: join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  if (app.isPackaged) {
    mainWindow.loadFile(join(__dirname, '..', 'angular-electron-poc', 'browser', 'index.html'));
  } else {
    mainWindow.loadURL(`http://localhost:${DEV_PORT}`);
    mainWindow.webContents.openDevTools({ mode: 'detach' });
  }

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

app.whenReady().then(() => {
  const dataDir = app.getPath('userData');
  mkdirSync(dataDir, { recursive: true });

  // The window opens before the engine starts, and stays open even if the
  // engine fails: a silent crash on double-click generates zero-information
  // support calls.
  createWindow();

  try {
    engine = createLocalEngine({
      mainWindow: mainWindow!,
      dbPath: join(dataDir, 'bizuri-local.sqlite'),
      deviceId: deviceId(dataDir),
      apiBaseUrl: API_BASE_URL,
      isDev,
      devPort: DEV_PORT,
      machineSalt: loadMachineSalt(dataDir),
      // The POC has no passphrase UI; BIZURI-Frontend supplies one and drops
      // both flags. SQLCipher is implemented and tested either way.
      unencrypted: isDev,
      autoUnlock: isDev,
      ...(devCredentials() ? { credentials: devCredentials()! } : {}),
      autoStartSync: true,
      syncIntervalMs: 30_000,
    });

    console.log(`[main] engine ready, api ${API_BASE_URL}`);
  } catch (err) {
    console.error('[main] engine failed to start:', err);
  }

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', () => {
  engine?.dispose();
  engine = null;
});
