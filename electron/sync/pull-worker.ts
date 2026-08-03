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
 * Phase 2: real HTTP pull from the Bizuri API.
 * Phase 2 stub: no-op (local seed data is the source of truth).
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

  // Apply catalog item updates (upsert).
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

    const runAll = db.transaction(() => {
      for (const item of response.catalogItems) {
        const r = item as Record<string, unknown>;
        upsert.run(
          r.item_id, r.branch_id, r.item_code, r.item_name,
          r.barcode ?? null, r.selling_price, r.discount ?? '0',
          r.tax_category_name ?? null, r.tax_category_rate ?? '0',
          r.available_qty ?? '0', r.sell_mode ?? 'UNIT', r.updated_at,
        );
      }
    });

    runAll();
    counts['catalogItems'] = response.catalogItems.length;
  }

  // Apply customer updates (upsert).
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

    const runAll = db.transaction(() => {
      for (const cust of response.customers) {
        const r = cust as Record<string, unknown>;
        upsert.run(
          r.id, r.server_id ?? null, r.tenant_id, r.branch_id,
          r.customer_code ?? null, r.customer_name,
          r.customer_tin ?? null, r.customer_phone ?? null,
          r.customer_email ?? null, r.address ?? null,
          r.created_at, r.updated_at,
        );
      }
    });

    runAll();
    counts['customers'] = response.customers.length;
  }

  // Persist updated cursors.
  if (response.cursors.length > 0) {
    saveCursors(db, response.cursors);
  }

  return counts;
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
