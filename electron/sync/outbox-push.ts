/**
 * Outbox push worker.
 *
 * Reads PENDING entries from the local outbox table, batches them,
 * and sends them to the remote server.  On success, entries are
 * marked SYNCED.  On failure, the attempt count is incremented and
 * entries above the retry threshold are moved to FAILED.
 *
 * The push is idempotent: the server deduplicates by idempotencyKey.
 *
 * Phase 2: real HTTP push to the Bizuri API.
 * Phase 2 stub: marks entries as SYNCED locally (simulates success).
 */

import type { SqliteDatabase } from '../database/types';
import type {
  OutboxEntry,
  OutboxPushResult,
  PushBatchRequest,
  PushBatchResponse,
} from './types';

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

export interface PushConfig {
  /** Maximum entries per batch. */
  readonly batchSize: number;
  /** Maximum retry attempts before marking FAILED. */
  readonly maxAttempts: number;
  /** Lease duration in milliseconds (prevents double-processing). */
  readonly leaseMs: number;
  /** Device identifier for the push request. */
  readonly deviceId: string;
  /** Tenant identifier. */
  readonly tenantId: string;
  /** Branch identifier. */
  readonly branchId: string;
}

const DEFAULT_CONFIG: PushConfig = {
  batchSize: 50,
  maxAttempts: 5,
  leaseMs: 60_000,
  deviceId: 'poc-device-001',
  tenantId: 'poc-tenant',
  branchId: 'poc-branch',
};

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Attempt to push all pending outbox entries to the remote server.
 *
 * Returns a summary of what was pushed, what failed, and any errors.
 * This function never throws — errors are captured in the result.
 */
export function pushOutbox(
  db: SqliteDatabase,
  config: Partial<PushConfig> = {},
): OutboxPushResult {
  const cfg = { ...DEFAULT_CONFIG, ...config };
  const batchId = generateBatchId();
  const errors: string[] = [];

  // Acquire a lease on pending entries.
  const leaseUntil = new Date(Date.now() + cfg.leaseMs).toISOString();
  db.prepare(`
    UPDATE outbox
    SET batch_id = ?, leased_until = ?, attempts = attempts + 1
    WHERE state = 'PENDING'
      AND (leased_until IS NULL OR leased_until < datetime('now'))
    LIMIT ?
  `).run(batchId, leaseUntil, cfg.batchSize);

  // Read the leased entries.
  const entries = db.prepare(`
    SELECT id, seq, entity, entity_id AS entityId, operation,
      payload, idempotency_key AS idempotencyKey,
      state, attempts, batch_id AS batchId,
      leased_until AS leasedUntil, last_error AS lastError,
      created_at AS createdAt
    FROM outbox
    WHERE batch_id = ? AND state = 'PENDING'
    ORDER BY seq ASC
  `).all(batchId) as unknown as OutboxEntry[];

  if (entries.length === 0) {
    return { pushed: 0, failed: 0, batchId, errors: [] };
  }

  // Build the push request.
  const request: PushBatchRequest = {
    deviceId: cfg.deviceId,
    tenantId: cfg.tenantId,
    branchId: cfg.branchId,
    batchId,
    entries: entries.map((e) => ({
      id: e.id,
      entity: e.entity,
      entityId: e.entityId,
      operation: e.operation,
      payload: safeParse(e.payload),
      idempotencyKey: e.idempotencyKey,
    })),
  };

  // Push to the server (stubbed — always succeeds).
  const response = pushToServer(request);

  // Mark accepted entries as SYNCED.
  const acceptedSet = new Set(response.accepted);
  let pushed = 0;
  let failed = 0;

  for (const entry of entries) {
    if (acceptedSet.has(entry.id)) {
      db.prepare(`
        UPDATE outbox SET state = 'SYNCED', leased_until = NULL, last_error = NULL
        WHERE id = ?
      `).run(entry.id);
      pushed++;
    } else {
      // Entry not accepted — increment attempts, maybe mark FAILED.
      const newAttempts = entry.attempts + 1;
      if (newAttempts >= cfg.maxAttempts) {
        db.prepare(`
          UPDATE outbox SET state = 'FAILED', leased_until = NULL,
            last_error = ?, attempts = ?
          WHERE id = ?
        `).run('Max attempts exceeded', newAttempts, entry.id);
        errors.push(`Entry ${entry.id} exceeded max attempts (${cfg.maxAttempts})`);
      } else {
        db.prepare(`
          UPDATE outbox SET leased_until = NULL, attempts = ?
          WHERE id = ?
        `).run(newAttempts, entry.id);
      }
      failed++;
    }
  }

  // Handle server-reported conflicts.
  for (const conflict of response.conflicts) {
    db.prepare(`
      UPDATE outbox SET state = 'CONFLICT', leased_until = NULL,
        last_error = ?
      WHERE id = ?
    `).run(conflict.reason, conflict.entryId);
    errors.push(`Conflict on ${conflict.entryId}: ${conflict.reason}`);
    failed++;
  }

  return { pushed, failed, batchId, errors };
}

/**
 * Count pending entries in the outbox (for diagnostics).
 */
export function pendingCount(db: SqliteDatabase): number {
  const row = db.prepare(
    "SELECT COUNT(*) AS c FROM outbox WHERE state = 'PENDING'",
  ).get() as { c: number };
  return row.c;
}

// ---------------------------------------------------------------------------
// Server stub
// ---------------------------------------------------------------------------

/**
 * Push a batch to the remote server.
 *
 * Phase 2: replace with an HTTP POST to the Bizuri API.
 * Phase 2 stub: accepts all entries unconditionally.
 */
function pushToServer(request: PushBatchRequest): PushBatchResponse {
  console.log(
    `[sync:push] Stub push: ${request.entries.length} entries, batch=${request.batchId}`,
  );

  // Stub: accept everything.  No conflicts, no rejections.
  return {
    accepted: request.entries.map((e) => e.id),
    conflicts: [],
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function generateBatchId(): string {
  const now = Date.now().toString(36);
  const rand = Math.random().toString(36).slice(2, 8);
  return `batch-${now}-${rand}`;
}

function safeParse(json: string): unknown {
  try {
    return JSON.parse(json);
  } catch {
    return json;
  }
}
