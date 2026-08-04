/**
 * Preload script — the bridge surface exposed to the Angular renderer.
 *
 * Design rules:
 *   - Expose behaviour, not capability.
 *   - One channel per direction (bizuri.command, bizuri.event).
 *   - No logic, no validation, no state.
 *   - The set of channels is fixed at build time.
 *
 * This file should stay under 30 lines.  Every line added here is a
 * line running with more privilege than it needs.
 */

import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('bizuriLocal', {
  available: true,
  contractVersion: 1,

  invoke: (name: string, payload: unknown): Promise<unknown> => {
    const envelope = {
      v: 1,
      id: `${name}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`,
      name,
      issuedAt: new Date().toISOString(),
      payload: payload ?? null,
    };
    return ipcRenderer.invoke('bizuri.command', envelope);
  },

  subscribe: (topic: string, handler: (message: unknown) => void): (() => void) => {
    const listener = (_event: Electron.IpcRendererEvent, message: unknown): void =>
      handler(message);
    ipcRenderer.on('bizuri.event', listener);
    return () => {
      ipcRenderer.removeListener('bizuri.event', listener);
    };
  },
});
