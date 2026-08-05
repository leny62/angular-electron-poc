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
import type { LocalStoreManifest } from './types';

/**
 * Bumped by the generator when emitted DDL changes.
 *
 * Independent of `CONTRACT_VERSION` on purpose.  An additive contract change
 * (a new optional response field) bumps the contract version but not this;
 * adding a local index bumps this but not the contract version.  Coupling them
 * would force pointless migrations on every contract release.
 */
export const LOCAL_SCHEMA_VERSION = 1;

/**
 * The `@bizuri/api-client` version this store was generated against.
 *
 * Read from the npm/Maven artifact version, NOT from the spec's `info.version`.
 * The core contract's `info.version` is stale at `1.0.0` while the published
 * artifact is at `1.2.29` — trusting `info.version` would make every handshake
 * compare against a constant and the compatibility gate would never fire.
 * That mismatch is contract gap #5 in the plan.
 */
export const CONTRACT_VERSION = '1.2.29';

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
