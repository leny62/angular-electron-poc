/**
 * contextBridge surface. Import and call from the host's preload script.
 *
 * Only serialisable values cross the bridge, and the renderer gets functions
 * rather than the ipcRenderer handle, so it cannot reach channels the engine
 * does not expose.
 */

import { contextBridge, ipcRenderer } from 'electron';
import { ENVELOPE_VERSION, EVENT_CHANNEL, REQUEST_CHANNEL } from '../contracts';

export interface ExposeOptions {
  readonly contractVersion: string;
  /** Global name. Defaults to `bizuriLocal`. */
  readonly key?: string;
}

export function exposeLocalBridge(options: ExposeOptions): void {
  const handlers = new Map<string, Set<(event: unknown) => void>>();

  ipcRenderer.on(EVENT_CHANNEL, (_event, payload: { topic?: string }) => {
    if (!payload?.topic) return;
    for (const handler of handlers.get(payload.topic) ?? []) {
      try {
        handler(payload);
      } catch {
        // One bad subscriber must not stop the others receiving the event.
      }
    }
  });

  contextBridge.exposeInMainWorld(options.key ?? 'bizuriLocal', {
    available: true,
    envelopeVersion: ENVELOPE_VERSION,
    contractVersion: options.contractVersion,

    request(req: Record<string, unknown>) {
      return ipcRenderer.invoke(REQUEST_CHANNEL, { ...req, v: ENVELOPE_VERSION });
    },

    subscribe(topic: string, handler: (event: unknown) => void) {
      let set = handlers.get(topic);
      if (!set) {
        set = new Set();
        handlers.set(topic, set);
      }
      set.add(handler);
      return () => set!.delete(handler);
    },
  });
}
