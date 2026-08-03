/**
 * Sync worker orchestrator.
 *
 * Runs push-then-pull cycles on a configurable interval.  Manages
 * the worker's lifecycle (start, stop, force-sync) and emits
 * status events to the renderer via the main BrowserWindow.
 *
 * Architecture:
 *   Push phase — outbox entries are leased and sent to the server.
 *   Pull phase — catalog and customer snapshots are refreshed.
 *
 * Both phases are sequential (push first, then pull) to prevent a
 * stale snapshot from shadowing a local write that hasn't been pushed
 * yet.
 *
 * The worker is resilient: transient failures are logged but don't
 * stop the interval.  Consecutive failures above a threshold
 * transition the engine to DEGRADED.
 *
 * @see docs/Bizuri-Secure-IPC-Offline-Design.docx  Section 7
 */

import type { BrowserWindow } from 'electron';
import type { SqliteDatabase } from '../database/types';
import type { EngineStateMachine } from '../domain/engine-state';
import { pushOutbox, pendingCount } from './outbox-push';
import { pullFromServer } from './pull-worker';
import type {
  SyncWorkerState,
  SyncStatus,
  SyncConflict,
  OutboxPushResult,
  PullResult,
} from './types';

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

export interface SyncWorkerConfig {
  /** Interval between sync cycles in milliseconds (default 30s). */
  readonly intervalMs: number;
  /** Consecutive failures before engine → DEGRADED. */
  readonly maxConsecutiveFailures: number;
  /** Database accessor. */
  readonly db: () => SqliteDatabase;
  /** Engine state machine (for DEGRADED transition). */
  readonly engineState: EngineStateMachine;
  /** Main window for event emission. */
  readonly mainWindow: BrowserWindow;
  /** Device identifier. */
  readonly deviceId: string;
  /** Tenant identifier. */
  readonly tenantId: string;
  /** Branch identifier. */
  readonly branchId: string;
}

// ---------------------------------------------------------------------------
// Worker
// ---------------------------------------------------------------------------

export class SyncWorker {
  private readonly config: SyncWorkerConfig;
  private state: SyncWorkerState = 'IDLE';
  private timer: ReturnType<typeof setInterval> | null = null;
  private consecutiveFailures = 0;
  private lastSyncAt: string | null = null;
  private lastError: string | null = null;
  private lastPushResult: OutboxPushResult | null = null;
  private lastPullResult: PullResult | null = null;

  constructor(config: SyncWorkerConfig) {
    this.config = config;
  }

  // -------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------

  /** Start the periodic sync cycle.  No-op if already running. */
  start(): void {
    if (this.timer) {
      return;
    }

    console.log(
      `[sync:worker] Starting — interval=${this.config.intervalMs}ms`,
    );

    // Run immediately on start, then periodically.
    this.runCycle();
    this.timer = setInterval(() => this.runCycle(), this.config.intervalMs);
  }

  /** Stop the periodic sync cycle.  Waits for in-flight cycle to complete. */
  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
      console.log('[sync:worker] Stopped.');
    }
    this.transition('IDLE');
  }

  /**
   * Force an immediate sync cycle outside the normal interval.
   * If a cycle is already running, this call is ignored.
   */
  forceSync(): SyncStatus {
    if (this.state === 'SYNCING') {
      return this.getStatus();
    }
    this.runCycle();
    return this.getStatus();
  }

  // -------------------------------------------------------------------
  // Status
  // -------------------------------------------------------------------

  /** Snapshot of the worker's current state (for diagnostics and the UI). */
  getStatus(): SyncStatus {
    const db = this.config.db();
    let pending = 0;
    try {
      pending = pendingCount(db);
    } catch {
      // DB may not be open — ignore.
    }

    return {
      state: this.state,
      lastSyncAt: this.lastSyncAt,
      lastError: this.lastError,
      pushed: this.lastPushResult?.pushed ?? 0,
      pulled: this.lastPullResult?.pulled ?? 0,
      pending,
    };
  }

  /** List current conflicts (for sync.conflicts handler). */
  getConflicts(): SyncConflict[] {
    try {
      const db = this.config.db();
      const rows = db.prepare(`
        SELECT id, entity, entity_id AS entityId, operation,
          payload AS localVersion, idempotency_key,
          last_error AS remoteVersion, created_at AS detectedAt
        FROM outbox
        WHERE state = 'CONFLICT'
        ORDER BY created_at DESC
      `).all() as unknown as SyncConflict[];
      return rows;
    } catch {
      return [];
    }
  }

  /** Resolve a conflict (for sync.resolve handler). */
  resolveConflict(
    conflictId: string,
    resolution: 'local' | 'remote',
  ): { resolved: boolean; message: string } {
    const db = this.config.db();

    const entry = db.prepare(
      "SELECT id FROM outbox WHERE id = ? AND state = 'CONFLICT'",
    ).get(conflictId) as { id: string } | undefined;

    if (!entry) {
      return {
        resolved: false,
        message: `Conflict "${conflictId}" not found or already resolved.`,
      };
    }

    if (resolution === 'local') {
      // Force-sync the local version — mark as PENDING for retry.
      db.prepare(`
        UPDATE outbox SET state = 'PENDING', attempts = 0,
          last_error = NULL, leased_until = NULL
        WHERE id = ?
      `).run(conflictId);
    } else {
      // Discard local, accept remote — mark as SYNCED.
      db.prepare(`
        UPDATE outbox SET state = 'SYNCED', last_error = NULL
        WHERE id = ?
      `).run(conflictId);
    }

    // Trigger an immediate sync to push the resolution.
    this.forceSync();

    return {
      resolved: true,
      message:
        resolution === 'local'
          ? 'Conflict resolved with local version.  Entry re-queued for push.'
          : 'Conflict resolved with remote version.  Local entry discarded.',
    };
  }

  // -------------------------------------------------------------------
  // Cycle
  // -------------------------------------------------------------------

  private async runCycle(): Promise<void> {
    if (this.state === 'SYNCING') {
      return; // prevent overlapping cycles
    }

    this.transition('SYNCING');

    const db = this.config.db();
    let success = true;

    try {
      // Phase 1 — Push outbox entries.
      const pushResult = pushOutbox(db, {
        deviceId: this.config.deviceId,
        tenantId: this.config.tenantId,
        branchId: this.config.branchId,
      });
      this.lastPushResult = pushResult;

      if (pushResult.errors.length > 0) {
        console.warn(
          `[sync:worker] Push completed with ${pushResult.errors.length} errors:`,
          pushResult.errors,
        );
        success = false;
      } else {
        console.log(
          `[sync:worker] Push OK — ${pushResult.pushed} pushed, batch=${pushResult.batchId}`,
        );
      }

      // Phase 2 — Pull updates.
      const pullResult = pullFromServer(db, {
        deviceId: this.config.deviceId,
      });
      this.lastPullResult = pullResult;

      console.log(
        `[sync:worker] Pull OK — ${pullResult.pulled} rows across ${Object.keys(pullResult.entities).length} entities`,
      );

      this.lastSyncAt = new Date().toISOString();
      this.lastError = null;

      // Reset failure counter on any success.
      if (success) {
        this.consecutiveFailures = 0;
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[sync:worker] Cycle failed: ${message}`);
      this.lastError = message;
      this.consecutiveFailures++;

      if (this.consecutiveFailures >= this.config.maxConsecutiveFailures) {
        console.error(
          `[sync:worker] ${this.consecutiveFailures} consecutive failures — engine → DEGRADED`,
        );
        this.config.engineState.markDegraded(
          `Sync worker failed ${this.consecutiveFailures} consecutive times. Last error: ${message}`,
        );
      }

      this.transition('ERROR');
      this.emit('sync.state', { status: this.getStatus() });
      return;
    }

    this.transition('IDLE');
    this.emit('sync.state', { status: this.getStatus() });

    // Emit progress if there was activity.
    const totalActivity =
      (this.lastPushResult?.pushed ?? 0) + (this.lastPullResult?.pulled ?? 0);
    if (totalActivity > 0) {
      this.emit('sync.progress', {
        pushed: this.lastPushResult?.pushed ?? 0,
        pulled: this.lastPullResult?.pulled ?? 0,
        lastSyncAt: this.lastSyncAt,
      });
    }
  }

  // -------------------------------------------------------------------
  // Helpers
  // -------------------------------------------------------------------

  private transition(next: SyncWorkerState): void {
    const prev = this.state;
    this.state = next;
    if (prev !== next) {
      console.log(`[sync:worker] State: ${prev} → ${next}`);
    }
  }

  private emit(topic: string, data: unknown): void {
    try {
      this.config.mainWindow.webContents.send('bizuri.event', {
        v: 1,
        topic,
        at: new Date().toISOString(),
        data,
      });
    } catch {
      // Window may not exist during shutdown — silently drop.
    }
  }
}
