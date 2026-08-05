/**
 * Outbox push against the real API.
 *
 * Uses `POST /core/sales` with `Idempotency-Key`, which exists today and already
 * documents the exact semantics we need: "a repeat with the same key returns the
 * original sale without deducting again." Offline replay was designed for.
 *
 * ─── What the batch endpoint would add ───────────────────────────────────────
 * This pushes one sale per request. `POST /core/sync/push` (§7.1) would send up
 * to 200 in one round trip with per-operation results. On a shop reconnecting
 * with three weeks of sales that is the difference between ~2000 requests and
 * ~10, so it matters, but it is an optimisation: correctness here does not depend
 * on it. `PushStats.requestCount` is the number that will justify building it.
 *
 * ─── Lease-based claiming ────────────────────────────────────────────────────
 * Rows are claimed with a lease before being sent, so two windows (or a retry
 * overlapping a slow request) cannot push the same sale twice. Combined with the
 * server's idempotency key that gives exactly-once from both ends: the lease
 * prevents the duplicate request, and the key makes it harmless if one escapes.
 */

import { randomUUID } from 'crypto';
import type { SqliteDatabase } from '../store/types';
import { OfflineError, RemoteError, type RemoteClient } from './remote-client';

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

export interface PushConfig {
  /** Rows claimed per cycle. */
  readonly batchSize: number;
  /** Attempts before a row is parked as FAILED. */
  readonly maxAttempts: number;
  /** Lease duration. Must exceed the request timeout or a slow push self-steals. */
  readonly leaseMs: number;
  readonly deviceId: string;
}

export const DEFAULT_PUSH_CONFIG: Omit<PushConfig, 'deviceId'> = {
  batchSize: 50,
  maxAttempts: 5,
  // 90s against a 20s request timeout: room for retries inside one claim.
  leaseMs: 90_000,
};

// ---------------------------------------------------------------------------
// Results
// ---------------------------------------------------------------------------

export type PushOutcome = 'APPLIED' | 'DUPLICATE' | 'REJECTED' | 'DEFERRED';

export interface PushedRow {
  readonly outboxId: string;
  readonly aggregateId: string;
  readonly outcome: PushOutcome;
  readonly serverId?: string;
  readonly serverNumber?: string;
  readonly error?: string;
}

export interface PushStats {
  readonly claimed: number;
  readonly applied: number;
  readonly duplicates: number;
  readonly rejected: number;
  readonly deferred: number;
  readonly requestCount: number;
  readonly durationMs: number;
  readonly rows: readonly PushedRow[];
  /** True when the network went away mid-cycle. Not a failure, just "still offline". */
  readonly wentOffline: boolean;
}

interface ClaimedRow {
  id: string;
  seq: number;
  aggregate_type: string;
  aggregate_id: string;
  operation_id: string;
  contract_version: string;
  payload: string;
  idempotency_key: string;
  attempts: number;
}

// ---------------------------------------------------------------------------
// Push
// ---------------------------------------------------------------------------

export async function pushOutbox(
  db: SqliteDatabase,
  client: RemoteClient,
  config: PushConfig,
): Promise<PushStats> {
  const started = Date.now();
  const batchId = cryptoRandomId();

  const claimed = claim(db, config, batchId);
  const rows: PushedRow[] = [];
  let requestCount = 0;
  let wentOffline = false;

  for (const [index, row] of claimed.entries()) {
    try {
      const result = await pushOne(client, row, config);
      requestCount++;
      rows.push(result);

      if (result.outcome === 'APPLIED' || result.outcome === 'DUPLICATE') {
        markSynced(db, row, result);
      } else if (result.outcome === 'REJECTED') {
        // Permanent. Park it and keep draining: one bad sale must never wedge the
        // queue, which is the classic offline failure where a shop silently stops
        // syncing for a month behind a single poison row.
        markFailed(db, row, result.error ?? 'rejected by server');
      } else {
        release(db, row);
      }
    } catch (err) {
      requestCount++;

      if (err instanceof OfflineError) {
        // Still offline. Stop, and release EVERY row this cycle claimed, not just
        // the one that failed.
        //
        // claim() marks the whole batch INFLIGHT up front, so releasing only the
        // current row would leave the rest leased for the full lease duration.
        // They are not lost, but the next cycle skips them until the lease
        // expires, which stalls reconciliation for up to `leaseMs` at exactly the
        // moment connectivity has returned. Found by the e2e scenario: a real
        // socket failure mid-batch, which a mocked fetch does not reproduce.
        releaseAll(db, claimed.slice(index));
        wentOffline = true;
        break;
      }

      const message = err instanceof Error ? err.message : String(err);
      const retryable = err instanceof RemoteError ? err.retryable : true;

      if (!retryable) {
        markFailed(db, row, message);
        rows.push({
          outboxId: row.id,
          aggregateId: row.aggregate_id,
          outcome: 'REJECTED',
          error: message,
        });
      } else if (row.attempts + 1 >= config.maxAttempts) {
        markFailed(db, row, `giving up after ${row.attempts + 1} attempts: ${message}`);
        rows.push({
          outboxId: row.id,
          aggregateId: row.aggregate_id,
          outcome: 'REJECTED',
          error: message,
        });
      } else {
        bumpAttempts(db, row, message);
        rows.push({
          outboxId: row.id,
          aggregateId: row.aggregate_id,
          outcome: 'DEFERRED',
          error: message,
        });
      }
    }
  }

  const tally = (o: PushOutcome) => rows.filter((r) => r.outcome === o).length;

  return {
    claimed: claimed.length,
    applied: tally('APPLIED'),
    duplicates: tally('DUPLICATE'),
    rejected: tally('REJECTED'),
    deferred: tally('DEFERRED'),
    requestCount,
    durationMs: Date.now() - started,
    rows,
    wentOffline,
  };
}

async function pushOne(
  client: RemoteClient,
  row: ClaimedRow,
  config: PushConfig,
): Promise<PushedRow> {
  const payload = JSON.parse(row.payload) as Record<string, unknown>;

  switch (row.operation_id) {
    case 'createSale': {
      const body = await client.request<unknown>('/core/sales', {
        method: 'POST',
        // The payload is sent exactly as it was frozen at write time. No
        // reshaping: that is the §4.2 invariant, and it is what lets a
        // server-side upcaster handle an old device correctly.
        body: payload,
        idempotencyKey: row.idempotency_key,
      });

      const sale = unwrap(body) as { id?: string; saleNumber?: string };
      return {
        outboxId: row.id,
        aggregateId: row.aggregate_id,
        // The server treats a repeated key as a success and returns the original
        // sale, so we cannot distinguish APPLIED from DUPLICATE without a flag
        // it does not send. Both mean "the server has it", which is all the
        // device needs to stop retrying.
        outcome: 'APPLIED',
        ...(sale?.id ? { serverId: sale.id } : {}),
        ...(sale?.saleNumber ? { serverNumber: sale.saleNumber } : {}),
      };
    }

    case 'createCustomer': {
      const body = await client.request<unknown>('/core/customers', {
        method: 'POST',
        body: payload,
        idempotencyKey: row.idempotency_key,
      });
      const customer = unwrap(body) as { id?: string };
      return {
        outboxId: row.id,
        aggregateId: row.aggregate_id,
        outcome: 'APPLIED',
        ...(customer?.id ? { serverId: customer.id } : {}),
      };
    }

    default:
      // An operation queued by a build that knew how to create it but this build
      // does not know how to push. Park it rather than dropping it: the payload
      // is intact and a later build can send it.
      return {
        outboxId: row.id,
        aggregateId: row.aggregate_id,
        outcome: 'REJECTED',
        error: `No push route for operation "${row.operation_id}" (device ${config.deviceId}).`,
      };
  }
}

function unwrap(body: unknown): unknown {
  const b = (body ?? {}) as { data?: unknown };
  return b.data !== undefined ? b.data : body;
}

// ---------------------------------------------------------------------------
// Claiming and state transitions
// ---------------------------------------------------------------------------

/**
 * Claim up to `batchSize` rows with a lease.
 *
 * Ordered by `seq` so per-aggregate ordering is preserved: a customer created
 * before the sale that references it is pushed first.
 *
 * The lease check reclaims rows whose previous claim expired, which is what
 * recovers work abandoned by a crash mid-push.
 */
function claim(db: SqliteDatabase, config: PushConfig, batchId: string): ClaimedRow[] {
  const now = new Date().toISOString();
  const leaseUntil = new Date(Date.now() + config.leaseMs).toISOString();

  const doClaim = db.transaction(() => {
    const candidates = db
      .prepare(
        `SELECT id, seq, aggregate_type, aggregate_id, operation_id,
                contract_version, payload, idempotency_key, attempts
           FROM outbox
          WHERE state IN ('PENDING', 'INFLIGHT')
            AND (leased_until IS NULL OR leased_until < ?)
          ORDER BY seq ASC
          LIMIT ?`,
      )
      .all(now, config.batchSize) as unknown as ClaimedRow[];

    const update = db.prepare(
      `UPDATE outbox
          SET state = 'INFLIGHT', leased_until = ?, batch_id = ?
        WHERE id = ?`,
    );
    for (const row of candidates) update.run(leaseUntil, batchId, row.id);

    return candidates;
  });

  return doClaim();
}

function markSynced(db: SqliteDatabase, row: ClaimedRow, result: PushedRow): void {
  const apply = db.transaction(() => {
    db.prepare(
      `UPDATE outbox
          SET state = 'SYNCED', leased_until = NULL, last_error = NULL
        WHERE id = ?`,
    ).run(row.id);

    // Adopt the server's id so a reprinted receipt shows the same identifier the
    // back office sees.
    if (row.aggregate_type === 'Sale') {
      db.prepare(
        `UPDATE sales
            SET sync_state = 'SYNCED',
                server_id = COALESCE(?, server_id),
                sale_number = COALESCE(?, sale_number)
          WHERE id = ?`,
      ).run(result.serverId ?? null, result.serverNumber ?? null, row.aggregate_id);
    } else if (row.aggregate_type === 'Customer') {
      db.prepare(
        `UPDATE customers
            SET sync_state = 'SYNCED', server_id = COALESCE(?, server_id)
          WHERE id = ?`,
      ).run(result.serverId ?? null, row.aggregate_id);
    }
  });
  apply();
}

function markFailed(db: SqliteDatabase, row: ClaimedRow, error: string): void {
  const apply = db.transaction(() => {
    db.prepare(
      `UPDATE outbox
          SET state = 'FAILED', leased_until = NULL,
              attempts = attempts + 1, last_error = ?
        WHERE id = ?`,
    ).run(error.slice(0, 500), row.id);

    // Surfaced in the UI as "needs attention" rather than hidden: money the
    // server refused is something a human has to look at.
    if (row.aggregate_type === 'Sale') {
      db.prepare(`UPDATE sales SET sync_state = 'FAILED' WHERE id = ?`).run(
        row.aggregate_id,
      );
    } else if (row.aggregate_type === 'Customer') {
      db.prepare(`UPDATE customers SET sync_state = 'FAILED' WHERE id = ?`).run(
        row.aggregate_id,
      );
    }
  });
  apply();
}

function bumpAttempts(db: SqliteDatabase, row: ClaimedRow, error: string): void {
  db.prepare(
    `UPDATE outbox
        SET state = 'PENDING', leased_until = NULL,
            attempts = attempts + 1, last_error = ?
      WHERE id = ?`,
  ).run(error.slice(0, 500), row.id);
}

function release(db: SqliteDatabase, row: ClaimedRow): void {
  db.prepare(
    `UPDATE outbox SET state = 'PENDING', leased_until = NULL WHERE id = ?`,
  ).run(row.id);
}

/**
 * Release a set of claimed rows in one transaction.
 *
 * Used when a cycle aborts part-way, so the unprocessed remainder becomes
 * immediately claimable again instead of waiting out its lease. One transaction
 * rather than a loop of them, so an abort during shutdown cannot leave half the
 * batch released and half leased.
 */
function releaseAll(db: SqliteDatabase, rows: readonly ClaimedRow[]): void {
  if (rows.length === 0) return;

  const stmt = db.prepare(
    `UPDATE outbox SET state = 'PENDING', leased_until = NULL WHERE id = ?`,
  );
  const apply = db.transaction(() => {
    for (const row of rows) stmt.run(row.id);
  });
  apply();
}

// ---------------------------------------------------------------------------
// Diagnostics
// ---------------------------------------------------------------------------

export interface OutboxSummary {
  readonly pending: number;
  readonly inflight: number;
  readonly synced: number;
  readonly failed: number;
  readonly conflict: number;
  readonly oldestPendingAt: string | null;
}

export function summariseOutbox(db: SqliteDatabase): OutboxSummary {
  const rows = db
    .prepare('SELECT state, count(*) AS c FROM outbox GROUP BY state')
    .all() as { state: string; c: number }[];

  const by = (s: string) => rows.find((r) => r.state === s)?.c ?? 0;

  const oldest = db
    .prepare(
      `SELECT min(created_at) AS at FROM outbox WHERE state IN ('PENDING','INFLIGHT')`,
    )
    .get() as { at: string | null } | undefined;

  return {
    pending: by('PENDING'),
    inflight: by('INFLIGHT'),
    synced: by('SYNCED'),
    failed: by('FAILED'),
    conflict: by('CONFLICT'),
    oldestPendingAt: oldest?.at ?? null,
  };
}

function cryptoRandomId(): string {
  return randomUUID();
}
