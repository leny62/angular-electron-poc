/**
 * Window type augmentations for the Electron context bridge.
 *
 * In the browser (ng serve) these properties are absent.
 * In Electron they are provided by the preload script.
 *
 * @see electron/preload.ts
 */

import type { BizuriLocalBridge } from './app/core/interfaces/local-bridge.interface';

declare global {
  interface Window {
    /** The secure IPC bridge.  Available only inside Electron. */
    readonly bizuriLocal?: BizuriLocalBridge;
  }
}

export {};
