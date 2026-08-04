const mockIpcMain = {
  handle: jest.fn(),
  removeHandler: jest.fn(),
};

const mockIpcRenderer = {
  invoke: jest.fn(),
  on: jest.fn(),
  removeListener: jest.fn(),
};

const mockWebContents = {
  send: jest.fn(),
  openDevTools: jest.fn(),
};

const mockBrowserWindow = {
  id: 1,
  webContents: mockWebContents,
  loadURL: jest.fn(),
  on: jest.fn(),
};

export const BrowserWindow = {
  fromWebContents: jest.fn().mockReturnValue(mockBrowserWindow),
  getAllWindows: jest.fn().mockReturnValue([]),
};

export const ipcMain = mockIpcMain;
export const ipcRenderer = mockIpcRenderer;

export const contextBridge = {
  exposeInMainWorld: jest.fn(),
};

export const app = {
  getPath: jest.fn().mockReturnValue('/tmp/bizuri-test'),
  whenReady: jest.fn().mockResolvedValue(undefined),
  on: jest.fn(),
  quit: jest.fn(),
};
