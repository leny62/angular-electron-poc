/**
 * The system-log vocabulary, in one place.
 *
 * Three consumers need these exact strings and must not drift: `tables.ts`
 * turns them into CHECK constraints, `schemas.ts` turns them into gate-4 enums,
 * and the renderer builds its filter dropdowns from them. A value that exists
 * in one but not another is either a log line that cannot be written or a
 * filter that matches nothing, and both fail silently.
 */

/** Severity, in log4net's order so it sorts as it reads. */
export const LOG_LEVELS = ['DEBUG', 'INFO', 'WARN', 'ERROR', 'FATAL'] as const;

/**
 * Emitting subsystem.
 *
 *   APPLICATION     the POS itself: UI, IPC gateway, sale and catalog operations
 *   QUEUE_SERVICE   background sync: outbox push, pull worker, sync scheduler
 *   DEVICE_SERVICE  the device and its store: SQLite, migrations, key derivation
 */
export const LOG_COMPONENTS = ['APPLICATION', 'QUEUE_SERVICE', 'DEVICE_SERVICE'] as const;

/** Which side of the bridge produced the entry. */
export const LOG_SOURCES = ['BROWSER', 'SERVER'] as const;

export type LogLevel = (typeof LOG_LEVELS)[number];
export type LogComponent = (typeof LOG_COMPONENTS)[number];
export type LogSource = (typeof LOG_SOURCES)[number];

/** Rank for threshold comparisons: an entry is kept when rank >= the minimum. */
export const LOG_LEVEL_RANK: Readonly<Record<LogLevel, number>> = {
  DEBUG: 10,
  INFO: 20,
  WARN: 30,
  ERROR: 40,
  FATAL: 50,
};
