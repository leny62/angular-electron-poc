/**
 * Gate 1 — Sender identity verification.
 *
 * Every IPC handler receives an IpcMainInvokeEvent.  This module
 * verifies that the sender's webContents belongs to our own
 * BrowserWindow and that the frame's origin matches the application
 * origin.  This stops commands arriving from iframes, webviews,
 * devtools consoles, or secondary windows.
 *
 * @see docs/Bizuri-Secure-IPC-Offline-Design.docx  Section 5.6
 */

import { BrowserWindow, type IpcMainInvokeEvent } from 'electron';

/**
 * Verify that `event` was sent by a frame inside `mainWindow` and
 * that the frame's origin is the expected application origin.
 *
 * Returns `null` on success, or an error message string on failure.
 * The caller should never expose the failure reason to untrusted code.
 */
export function verifySender(
  event: IpcMainInvokeEvent,
  mainWindow: BrowserWindow,
  allowedOrigin: string,
): string | null {
  // 1. The sender's webContents must belong to our main window.
  const senderWindow = BrowserWindow.fromWebContents(event.sender);
  if (senderWindow?.id !== mainWindow.id) {
    return 'E_SENDER: frame not from main window';
  }

  // 2. The frame's origin must be the expected app origin.
  //    senderFrame.origin is available in Electron ≥ 14.
  const origin = (event.senderFrame as { origin?: string } | null)?.origin;
  if (origin && origin !== allowedOrigin) {
    return 'E_SENDER: origin mismatch';
  }

  return null;
}
