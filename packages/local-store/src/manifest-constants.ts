/** Split from manifest.ts so the renderer can read versions without node crypto. */

/** Bumped to 2 by the addition of `system_logs`. */
export const LOCAL_SCHEMA_VERSION = 2;

/**
 * The `@bizuri/api-client` version this store was generated against. Read from
 * the artifact version, not the spec's `info.version`, which is stale at 1.0.0.
 */
export const CONTRACT_VERSION = '1.2.29';
