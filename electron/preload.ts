/**
 * Preload script. Exposes behaviour, not capability: the renderer receives
 * functions, never the ipcRenderer handle.
 *
 * Imports use deep entry points, not the package barrels. This runs in the
 * sandboxed preload context, and pulling the engine barrel in would bundle
 * SQLite and the sync worker into the most privileged script in the app.
 */

import { CONTRACT_VERSION } from '@bizuri/local-store/constants';
import { exposeLocalBridge } from '@bizuri/local-engine/preload';

exposeLocalBridge({ contractVersion: CONTRACT_VERSION });
