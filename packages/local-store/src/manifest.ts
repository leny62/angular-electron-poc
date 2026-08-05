/**
 * Local-store manifest.
 *
 * GENERATOR TARGET.  The generator writes this as a JSON file plus a typed
 * accessor; here it is computed from the descriptors so the hand-written phase
 * cannot drift from its own DDL.
 *
 * Three values, each with a distinct job:
 *
 *   localSchemaVersion  Compared against `schema_version` on disk. Drives the
 *                       migration runner. Bumped whenever emitted DDL changes.
 *
 *   contractVersion     Sent as `X-Bizuri-Contract-Version` on every sync
 *                       request. Drives the server's compatibility verdict and
 *                       selects the upcaster chain for queued outbox payloads.
 *
 *   tableHashes         Per-table DDL fingerprints. Startup compares these to
 *                       decide, per table, between "drop and re-hydrate" (free,
 *                       for replicas) and "migrate carefully" (write-through
 *                       rows hold unsynced money).
 */

import { hashAllTables } from './ddl';
import { CONTRACT_VERSION, LOCAL_SCHEMA_VERSION } from './manifest-constants';
import type { LocalStoreManifest } from './types';

export { CONTRACT_VERSION, LOCAL_SCHEMA_VERSION } from './manifest-constants';

let cached: LocalStoreManifest | null = null;

/** The manifest. Hashes are computed once and memoised. */
export function manifest(): LocalStoreManifest {
  if (!cached) {
    cached = {
      localSchemaVersion: LOCAL_SCHEMA_VERSION,
      contractVersion: CONTRACT_VERSION,
      tableHashes: Object.freeze(hashAllTables()),
    };
  }
  return cached;
}
