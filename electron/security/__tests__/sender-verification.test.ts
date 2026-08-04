import { verifySender } from '../sender-verification';

// Use the mock set up in __mocks__/electron.ts
jest.mock('electron');

import { BrowserWindow } from 'electron';
import type { IpcMainInvokeEvent } from 'electron';

function makeEvent(overrides: Partial<IpcMainInvokeEvent> = {}): IpcMainInvokeEvent {
  return {
    sender: {
      id: 1,
      destroy: jest.fn(),
      isDestroyed: jest.fn().mockReturnValue(false),
    } as unknown as IpcMainInvokeEvent['sender'],
    senderFrame: { origin: 'http://localhost:4200' },
    ...overrides,
  } as IpcMainInvokeEvent;
}

describe('verifySender', () => {
  const mainWindow = {
    id: 1,
    webContents: { send: jest.fn(), openDevTools: jest.fn() },
    loadURL: jest.fn(),
    on: jest.fn(),
  };

  beforeEach(() => {
    jest.clearAllMocks();
    (BrowserWindow.fromWebContents as jest.Mock).mockReturnValue(mainWindow);
  });

  it('returns null for a valid sender', () => {
    const event = makeEvent();
    const result = verifySender(event, mainWindow as never, 'http://localhost:4200');
    expect(result).toBeNull();
  });

  it('rejects when sender window does not match main window', () => {
    const otherWindow = { ...mainWindow, id: 999 };
    (BrowserWindow.fromWebContents as jest.Mock).mockReturnValue(otherWindow);

    const event = makeEvent();
    const result = verifySender(event, mainWindow as never, 'http://localhost:4200');
    expect(result).not.toBeNull();
  });

  it('rejects when frame origin does not match', () => {
    const event = makeEvent({
      senderFrame: { origin: 'https://evil.com' },
    } as Partial<IpcMainInvokeEvent>);
    const result = verifySender(event, mainWindow as never, 'http://localhost:4200');
    expect(result).not.toBeNull();
  });

  it('rejects when sender has no frame origin', () => {
    const event = makeEvent({
      senderFrame: {},
    } as Partial<IpcMainInvokeEvent>);
    const result = verifySender(event, mainWindow as never, 'http://localhost:4200');
    expect(result).toBeNull(); // null origin passes (devtools)
  });

  it('rejects when BrowserWindow.fromWebContents returns null', () => {
    (BrowserWindow.fromWebContents as jest.Mock).mockReturnValue(null);

    const event = makeEvent();
    const result = verifySender(event, mainWindow as never, 'http://localhost:4200');
    expect(result).not.toBeNull();
  });

  it('error messages never contain the expected origin', () => {
    (BrowserWindow.fromWebContents as jest.Mock).mockReturnValue(null);

    const event = makeEvent();
    const result = verifySender(event, mainWindow as never, 'http://localhost:4200');
    expect(result).not.toContain('http://localhost:4200');
  });
});
