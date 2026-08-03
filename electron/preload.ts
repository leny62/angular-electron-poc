/**
 * Preload script — the bridge surface exposed to the Angular renderer.
 *
 * Design rules (Section 5.1):
 *   - Expose behaviour, not capability.
 *   - One channel per direction (bizuri.command, bizuri.event).
 *   - No logic, no validation, no state.
 *   - The set of channels is fixed at build time.
 *
 * This file should stay under 30 lines.  Every line added here is a
 * line running with more privilege than it needs.
 *
 * @see docs/Bizuri-Secure-IPC-Offline-Design.docx  Section 5.2
 */

import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('bizuriLocal', {
  available: true,
  contractVersion: 1,

  invoke: (name: string, payload: unknown): Promise<unknown> =>
    ipcRenderer.invoke('bizuri.command', { name, payload }),

  subscribe: (topic: string, handler: (message: unknown) => void): (() => void) => {
    const listener = (_event: Electron.IpcRendererEvent, message: unknown): void =>
      handler(message);
    ipcRenderer.on('bizuri.event', listener);
    return () => {
      ipcRenderer.removeListener('bizuri.event', listener);
    };
  },
});
