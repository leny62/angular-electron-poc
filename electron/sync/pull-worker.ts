/**
 * Pull worker.
 *
 * Downloads catalog snapshots, customer records, and sync cursors
 * from the remote server and applies them to the local database.
 *
 * Pulls are incremental: the worker sends the last cursor for each
 * entity type and the server returns only rows that have changed
 * since that cursor.
 *
 * Conflict detection: before applying a pulled row, the worker checks
 * whether a PENDING outbox entry exists for the same entity.  If one
 * does, the local write has not been pushed yet and the remote update
 * may conflict.  The outbox entry is marked CONFLICT and the remote
 * version is NOT applied — the conflict must be resolved explicitly
 * via sync.resolve.
 */

import type { SqliteDatabase } from '../database/types';
import type {
  SyncCursor,
  PullResult,
  PullBatchRequest,
  PullBatchResponse,
} from './types';

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

export interface PullConfig {
  /** Maximum rows per pull batch. */
  readonly batchSize: number;
  /** Device identifier. */
  readonly deviceId: string;
}

const DEFAULT_CONFIG: PullConfig = {
  batchSize: 200,
  deviceId: 'poc-device-001',
};

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Pull updates from the remote server and apply them to the local
 * database.  Each entity type is pulled independently using its
 * last known cursor.
 *
 * Returns a summary of what was pulled.  Never throws — errors are
 * captured in the result.
 */
export function pullFromServer(
  db: SqliteDatabase,
  config: Partial<PullConfig> = {},
): PullResult {
  const cfg = { ...DEFAULT_CONFIG, ...config };

  // Read current cursors from the local database.
  const cursors = getCursors(db);

  // Build the pull request.
  const request: PullBatchRequest = {
    deviceId: cfg.deviceId,
    cursors,
    limit: cfg.batchSize,
  };

  // Pull from server (stubbed — returns empty).
  const response = pullBatch(request);

  // Apply pulled data to local tables.
  const counts = applyPullResponse(db, response);

  const totalPulled = Object.values(counts).reduce((sum, n) => sum + n, 0);

  return {
    pulled: totalPulled,
    entities: counts,
  };
}

// ---------------------------------------------------------------------------
// Cursor management
// ---------------------------------------------------------------------------

function getCursors(db: SqliteDatabase): SyncCursor[] {
  const sessions = db.prepare(
    'SELECT sync_cursor FROM device_session WHERE device_id = ?',
  ).get('poc-device-001') as { sync_cursor: string | null } | undefined;

  if (!sessions?.sync_cursor) {
    // First sync — no cursors yet.
    return [];
  }

  try {
    return JSON.parse(sessions.sync_cursor) as SyncCursor[];
  } catch {
    return [];
  }
}

function saveCursors(db: SqliteDatabase, cursors: SyncCursor[]): void {
  db.prepare(
    'UPDATE device_session SET sync_cursor = ? WHERE device_id = ?',
  ).run(JSON.stringify(cursors), 'poc-device-001');
}

// ---------------------------------------------------------------------------
// Apply pulled data
// ---------------------------------------------------------------------------

function applyPullResponse(
  db: SqliteDatabase,
  response: PullBatchResponse,
): Record<string, number> {
  const counts: Record<string, number> = {};
  let applied = 0;
  let conflicted = 0;

  // Apply catalog item updates, skipping those with pending local writes.
  if (response.catalogItems.length > 0) {
    const upsert = db.prepare(`
      INSERT INTO catalog_item (item_id, branch_id, item_code, item_name, barcode,
        selling_price, discount, tax_category_name, tax_category_rate,
        available_qty, sell_mode, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(item_id) DO UPDATE SET
        item_code = excluded.item_code,
        item_name = excluded.item_name,
        barcode = excluded.barcode,
        selling_price = excluded.selling_price,
        discount = excluded.discount,
        tax_category_name = excluded.tax_category_name,
        tax_category_rate = excluded.tax_category_rate,
        available_qty = excluded.available_qty,
        sell_mode = excluded.sell_mode,
        updated_at = excluded.updated_at
    `);

    for (const item of response.catalogItems) {
      const r = item as Record<string, unknown>;
      const itemId = r.item_id as string;

      // Conflict check: is there a pending local write for this catalog item?
      if (hasPendingOutboxEntry(db, 'catalog', itemId)) {
        flagConflict(db, 'catalog', itemId, r);
        conflicted++;
        continue;
      }

      upsert.run(
        itemId, r.branch_id, r.item_code, r.item_name,
        r.barcode ?? null, r.selling_price, r.discount ?? '0',
        r.tax_category_name ?? null, r.tax_category_rate ?? '0',
        r.available_qty ?? '0', r.sell_mode ?? 'UNIT', r.updated_at,
      );
      applied++;
    }

    counts['catalogItems'] = applied;
    if (conflicted > 0) {
      console.log(
        `[sync:pull] ${conflicted} catalog items conflicted — local writes take precedence.`,
      );
    }
  }

  applied = 0;
  conflicted = 0;

  // Apply customer updates, skipping those with pending local writes.
  if (response.customers.length > 0) {
    const upsert = db.prepare(`
      INSERT INTO customer (id, server_id, tenant_id, branch_id,
        customer_code, customer_name, customer_tin, customer_phone,
        customer_email, address, sync_state, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'SYNCED', ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        customer_name = excluded.customer_name,
        customer_tin = excluded.customer_tin,
        customer_phone = excluded.customer_phone,
        customer_email = excluded.customer_email,
        address = excluded.address,
        sync_state = 'SYNCED',
        updated_at = excluded.updated_at
    `);

    for (const cust of response.customers) {
      const r = cust as Record<string, unknown>;
      const custId = r.id as string;

      if (hasPendingOutboxEntry(db, 'customer', custId)) {
        flagConflict(db, 'customer', custId, r);
        conflicted++;
        continue;
      }

      upsert.run(
        custId, r.server_id ?? null, r.tenant_id, r.branch_id,
        r.customer_code ?? null, r.customer_name,
        r.customer_tin ?? null, r.customer_phone ?? null,
        r.customer_email ?? null, r.address ?? null,
        r.created_at, r.updated_at,
      );
      applied++;
    }

    counts['customers'] = applied;
    if (conflicted > 0) {
      console.log(
        `[sync:pull] ${conflicted} customers conflicted — local writes take precedence.`,
      );
    }
  }

  // Persist updated cursors.
  if (response.cursors.length > 0) {
    saveCursors(db, response.cursors);
  }

  return counts;
}

// ---------------------------------------------------------------------------
// Conflict detection helpers
// ---------------------------------------------------------------------------

/**
 * True when a PENDING outbox entry exists for the given entity.
 * A pending entry means a local write has not been pushed yet,
 * and the remote update may conflict with it.
 */
function hasPendingOutboxEntry(
  db: SqliteDatabase,
  entity: string,
  entityId: string,
): boolean {
  const row = db.prepare(`
    SELECT COUNT(*) AS c FROM outbox
    WHERE entity = ? AND entity_id = ? AND state = 'PENDING'
  `).get(entity, entityId) as { c: number };
  return row.c > 0;
}

/**
 * Mark an outbox entry as CONFLICT because a remote update arrived
 * for the same entity before the local write was pushed.
 */
function flagConflict(
  db: SqliteDatabase,
  entity: string,
  entityId: string,
  remoteRow: Record<string, unknown>,
): void {
  const now = new Date().toISOString();

  db.prepare(`
    UPDATE outbox
    SET state = 'CONFLICT',
        last_error = ?,
        leased_until = NULL
    WHERE entity = ? AND entity_id = ? AND state = 'PENDING'
  `).run(
    `Remote update arrived before local push. Remote version: ${JSON.stringify(remoteRow)}`,
    entity,
    entityId,
  );

  console.log(
    `[sync:pull] CONFLICT flagged: ${entity}/${entityId} at ${now}`,
  );
}

// ---------------------------------------------------------------------------
// Server stub
// ---------------------------------------------------------------------------

/**
 * Pull a batch from the remote server.
 *
 * Phase 2: replace with HTTP POST to the Bizuri API.
 * Phase 2 stub: returns empty — local seed data is the source of truth.
 */
function pullBatch(_request: PullBatchRequest): PullBatchResponse {
  console.log('[sync:pull] Stub pull: no remote server configured.');
  return {
    catalogItems: [],
    customers: [],
    cursors: [],
  };
}
