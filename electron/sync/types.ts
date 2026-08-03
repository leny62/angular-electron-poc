/**
 * Sync worker types.
 *
 * Defines the data structures for outbox entries, sync batches,
 * pull results, and worker state transitions.
 */

// ---------------------------------------------------------------------------
// Worker state machine
// ---------------------------------------------------------------------------

export type SyncWorkerState = 'IDLE' | 'SYNCING' | 'ERROR';

export interface SyncStatus {
  readonly state: SyncWorkerState;
  readonly lastSyncAt: string | null;
  readonly lastError: string | null;
  readonly pushed: number;
  readonly pulled: number;
  readonly pending: number;
}

// ---------------------------------------------------------------------------
// Outbox
// ---------------------------------------------------------------------------

export interface OutboxEntry {
  readonly id: string;
  readonly seq: number;
  readonly entity: string;
  readonly entityId: string;
  readonly operation: string;
  readonly payload: string; // JSON string
  readonly idempotencyKey: string;
  readonly state: string;
  readonly attempts: number;
  readonly batchId: string | null;
  readonly leasedUntil: string | null;
  readonly lastError: string | null;
  readonly createdAt: string;
}

export interface OutboxPushResult {
  readonly pushed: number;
  readonly failed: number;
  readonly batchId: string;
  readonly errors: string[];
}

// ---------------------------------------------------------------------------
// Pull
// ---------------------------------------------------------------------------

export interface SyncCursor {
  readonly entity: string;
  readonly cursor: string;
  readonly updatedAt: string;
}

export interface PullResult {
  readonly pulled: number;
  readonly entities: Record<string, number>; // entity → count
}

// ---------------------------------------------------------------------------
// Conflict
// ---------------------------------------------------------------------------

export interface SyncConflict {
  readonly id: string;
  readonly entity: string;
  readonly entityId: string;
  readonly localVersion: string;
  readonly remoteVersion: string;
  readonly detectedAt: string;
}

// ---------------------------------------------------------------------------
// Server contract (stubs — real server integration replaces these)
// ---------------------------------------------------------------------------

export interface PushBatchRequest {
  readonly deviceId: string;
  readonly tenantId: string;
  readonly branchId: string;
  readonly batchId: string;
  readonly entries: Array<{
    readonly id: string;
    readonly entity: string;
    readonly entityId: string;
    readonly operation: string;
    readonly payload: unknown;
    readonly idempotencyKey: string;
  }>;
}

export interface PushBatchResponse {
  readonly accepted: string[]; // entry IDs accepted by the server
  readonly conflicts: Array<{ entryId: string; reason: string }>;
}

export interface PullBatchRequest {
  readonly deviceId: string;
  readonly cursors: SyncCursor[];
  readonly limit: number;
}

export interface PullBatchResponse {
  readonly catalogItems: unknown[];
  readonly customers: unknown[];
  readonly cursors: SyncCursor[];
}
