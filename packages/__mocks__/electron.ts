/**
 * Electron mock for the packages test suite.
 *
 * Richer than the POC's mock because gate 1 now checks frame identity and
 * destroyed state, so the mock has to be able to represent a subframe, a wrong
 * window, and a destroyed webContents. A mock that cannot express the failure
 * cases would let the hardened sender checks pass untested.
 */

export interface MockFrame {
  origin: string;
}

export interface MockWebContents {
  id: number;
  mainFrame: MockFrame;
  send: jest.Mock;
  isDestroyed: () => boolean;
}

export interface MockWindow {
  id: number;
  webContents: MockWebContents;
  isDestroyed: () => boolean;
  loadURL: jest.Mock;
  loadFile: jest.Mock;
  on: jest.Mock;
  show: jest.Mock;
}

/** Registry backing `BrowserWindow.fromWebContents`. */
const windowsByWebContentsId = new Map<number, MockWindow>();

let nextId = 1;

export function makeMockWindow(
  opts: { origin?: string; destroyed?: boolean; webContentsDestroyed?: boolean } = {},
): MockWindow {
  const id = nextId++;
  const mainFrame: MockFrame = { origin: opts.origin ?? 'http://localhost:4200' };

  const webContents: MockWebContents = {
    id,
    mainFrame,
    send: jest.fn(),
    isDestroyed: () => opts.webContentsDestroyed === true,
  };

  const win: MockWindow = {
    id,
    webContents,
    isDestroyed: () => opts.destroyed === true,
    loadURL: jest.fn(),
    loadFile: jest.fn(),
    on: jest.fn(),
    show: jest.fn(),
  };

  windowsByWebContentsId.set(id, win);
  return win;
}

/**
 * Build an IpcMainInvokeEvent-alike.
 *
 * `frame` defaults to the window's main frame. Pass a different object to
 * simulate an iframe: same webContents, different frame, which is precisely the
 * case the POC's original check let through.
 */
export function makeMockEvent(
  win: MockWindow,
  overrides: { frame?: MockFrame | null; senderWindow?: MockWindow } = {},
): unknown {
  const sender = (overrides.senderWindow ?? win).webContents;
  return {
    sender,
    senderFrame: overrides.frame === undefined ? sender.mainFrame : overrides.frame,
  };
}

export function resetMockWindows(): void {
  windowsByWebContentsId.clear();
  nextId = 1;
}

// ---------------------------------------------------------------------------
// Electron API surface
// ---------------------------------------------------------------------------

export const BrowserWindow = {
  fromWebContents: (wc: { id: number }) => windowsByWebContentsId.get(wc.id) ?? null,
  getAllWindows: () => [...windowsByWebContentsId.values()],
};

export const ipcMain = {
  handle: jest.fn(),
  removeHandler: jest.fn(),
};

export const ipcRenderer = {
  invoke: jest.fn(),
  on: jest.fn(),
  removeListener: jest.fn(),
};

export const contextBridge = {
  exposeInMainWorld: jest.fn(),
};

export const app = {
  getPath: jest.fn().mockReturnValue('/tmp/bizuri-packages-test'),
  getVersion: jest.fn().mockReturnValue('0.0.0-test'),
  whenReady: jest.fn().mockResolvedValue(undefined),
  on: jest.fn(),
  quit: jest.fn(),
  isPackaged: false,
};

export const safeStorage = {
  isEncryptionAvailable: jest.fn().mockReturnValue(true),
  encryptString: jest.fn((s: string) => Buffer.from(s, 'utf8')),
  decryptString: jest.fn((b: Buffer) => b.toString('utf8')),
};
