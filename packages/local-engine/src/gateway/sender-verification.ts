/**
 * Gate 1: sender identity.
 *
 * Ported from the POC with two hardening fixes. Both matter because this gate is
 * the only thing standing between injected page content and the money database.
 *
 *   1. Fail closed on a missing origin. The POC wrote:
 *
 *          if (origin && origin !== allowedOrigin) reject
 *
 *      so an absent or empty origin PASSED. An opaque origin is exactly what a
 *      sandboxed iframe or a `data:` / `about:blank` document reports, which
 *      inverted the check for the cases it most needed to catch.
 *
 *   2. Require the main frame specifically. Checking only that the sender's
 *      webContents belongs to our window is not enough: an iframe inside our
 *      own page shares that webContents. Comparing against
 *      `webContents.mainFrame` is what actually excludes subframes.
 */

import { BrowserWindow, type IpcMainInvokeEvent } from 'electron';

export type SenderRejection =
  | 'no-sender-window'
  | 'wrong-window'
  | 'not-main-frame'
  | 'missing-origin'
  | 'origin-mismatch'
  | 'destroyed';

/**
 * Verify that `event` came from the main frame of `mainWindow` at the expected
 * origin.
 *
 * Returns `null` on success, or a machine-readable reason. The caller logs the
 * reason and returns a generic `E_SENDER` to the renderer: telling a caller
 * *why* it was rejected is a probing aid.
 */
export function verifySender(
  event: IpcMainInvokeEvent,
  mainWindow: BrowserWindow,
  allowedOrigin: string,
): SenderRejection | null {
  if (mainWindow.isDestroyed() || event.sender.isDestroyed()) {
    return 'destroyed';
  }

  const senderWindow = BrowserWindow.fromWebContents(event.sender);
  if (!senderWindow) return 'no-sender-window';
  if (senderWindow.id !== mainWindow.id) return 'wrong-window';

  const frame = event.senderFrame;
  if (!frame) return 'missing-origin';

  // Subframe exclusion. An iframe in our page has the same webContents, so the
  // window check above does not catch it.
  const mainFrame = event.sender.mainFrame;
  if (mainFrame && frame !== mainFrame) return 'not-main-frame';

  const origin = (frame as { origin?: string }).origin;

  // Fail closed. An opaque origin ('', 'null', undefined) is a rejection.
  if (!origin || origin === 'null') return 'missing-origin';
  if (origin !== allowedOrigin) return 'origin-mismatch';

  return null;
}

/**
 * The origin the renderer is expected to report.
 *
 * Dev serves from the Angular dev server over http; production loads the built
 * bundle from disk, which reports the `file://` origin. Getting this wrong fails
 * closed, so a misconfiguration shows up as "every command rejected" rather than
 * as a silent hole.
 */
export function expectedOrigin(isDev: boolean, devPort = 4200): string {
  return isDev ? `http://localhost:${devPort}` : 'file://';
}
