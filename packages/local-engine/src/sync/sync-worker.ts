/**
 * Push-then-pull sync cycle.
 *
 * Push first: a stale pull must not overwrite a local row whose write has not
 * reached the server yet.
 */

import { TIER_1_TABLES } from '@bizuri/local-store';
import type { EngineStateMachine } from '../domain/engine-state';
import { getLogger, pruneLogs, withLogContext } from '../logging/logger';
import { hydrate, hydratedTables, type HydrationStats } from '../remote/hydrate';
import { pushOutbox, summariseOutbox, type PushStats } from '../remote/push-outbox';
import { OfflineError, type RemoteClient } from '../remote/remote-client';
import { pruneOutboxBackups } from '../store/migrations';
import type { SqliteDatabase } from '../store/types';

const log = getLogger('sync-worker', 'QUEUE_SERVICE');

export type SyncState = 'IDLE' | 'SYNCING' | 'OFFLINE' | 'ERROR';

export interface SyncResult {
  readonly at: string;
  readonly durationMs: number;
  readonly push?: PushStats;
  readonly pull?: HydrationStats;
  readonly error?: string;
  readonly offline: boolean;
}

export interface SyncWorkerConfig {
  readonly db: () => SqliteDatabase;
  readonly client: () => RemoteClient | null;
  readonly engineState: EngineStateMachine;
  readonly deviceId: string;
  readonly scope: () => { tenantId: string; branchId: string } | null;
  readonly intervalMs?: number;
  /** Consecutive failures before the engine is marked DEGRADED. */
  readonly degradeAfter?: number;
  readonly onEvent?: (topic: 'sync.state' | 'sync.progress', data: unknown) => void;
}

export class SyncWorker {
  private state: SyncState = 'IDLE';
  private timer: ReturnType<typeof setInterval> | null = null;
  private running: Promise<SyncResult> | null = null;
  private consecutiveFailures = 0;
  private last: SyncResult | null = null;

  constructor(private readonly config: SyncWorkerConfig) {}

  get currentState(): SyncState {
    return this.state;
  }

  get lastResult(): SyncResult | null {
    return this.last;
  }

  start(): void {
    if (this.timer) return;
    const interval = this.config.intervalMs ?? 30_000;
    this.timer = setInterval(() => {
      void this.run().catch(() => undefined);
    }, interval);
    // Node keeps the process alive for pending timers; a sync loop should not
    // be the reason Electron refuses to quit.
    this.timer.unref?.();
  }

  stop(): void {
    if (!this.timer) return;
    clearInterval(this.timer);
    this.timer = null;
  }

  /** Single cycle. Concurrent callers share the in-flight run. */
  run(): Promise<SyncResult> {
    if (this.running) return this.running;
    this.running = this.cycle().finally(() => {
      this.running = null;
    });
    return this.running;
  }

  private cycle(): Promise<SyncResult> {
    // One correlation id per cycle, so every push, pull, and failure entry from
    // this run can be pulled up together in the viewer by request id.
    const cycleId = `sync-${Date.now().toString(36)}`;
    return withLogContext({ requestId: cycleId, thread: 'sync-worker' }, () =>
      this.runCycle(),
    );
  }

  private async runCycle(): Promise<SyncResult> {
    const started = Date.now();
    const at = new Date().toISOString();

    const client = this.config.client();
    const scope = this.config.scope();

    if (!client || !scope) {
      // DEBUG, not WARN: before sign-in this is every cycle, and a warning that
      // fires on a timer trains people to ignore warnings.
      log.debug('Cycle skipped: no session', { code: 'NO_SESSION' });
      return this.finish({ at, durationMs: 0, offline: true, error: 'No session' });
    }

    this.setState('SYNCING');

    try {
      const db = this.config.db();

      const push = await pushOutbox(db, client, {
        batchSize: 50,
        maxAttempts: 5,
        leaseMs: 90_000,
        deviceId: this.config.deviceId,
      });

      if (push.wentOffline) {
        this.setState('OFFLINE');
        log.warn('Push stopped: device is offline', {
          code: 'OFFLINE',
          tenantId: scope.tenantId,
          context: { applied: push.applied, durationMs: Date.now() - started },
        });
        return this.finish({ at, durationMs: Date.now() - started, push, offline: true });
      }

      this.config.onEvent?.('sync.progress', { phase: 'push', ...push });

      const pull = await hydrate(db, client, scope, {
        onProgress: (t) => this.config.onEvent?.('sync.progress', { phase: 'pull', ...t }),
      });

      // Backups exist to protect a queue across a migration. Once the queue is
      // empty they are dead weight.
      if (summariseOutbox(db).pending === 0) pruneOutboxBackups(db);

      // Log retention rides along with the cycle rather than owning a timer:
      // it is housekeeping, and this is when the device is already awake and
      // holding the write lock.
      pruneLogs(db);

      this.consecutiveFailures = 0;
      this.setState('IDLE');

      if (this.config.engineState.state === 'DEGRADED') {
        this.config.engineState.markReady();
      }
      this.promoteIfHydrated(db);

      log.info('Cycle complete', {
        code: 'OK',
        tenantId: scope.tenantId,
        context: {
          pushed: push.applied,
          pulledRows: pull.totalRows,
          pulledPages: pull.totalPages,
          durationMs: Date.now() - started,
        },
      });

      return this.finish({ at, durationMs: Date.now() - started, push, pull, offline: false });
    } catch (err) {
      const offline = err instanceof OfflineError;
      this.setState(offline ? 'OFFLINE' : 'ERROR');

      if (!offline) {
        this.consecutiveFailures++;
        const threshold = this.config.degradeAfter ?? 3;
        if (this.consecutiveFailures >= threshold) {
          this.config.engineState.markDegraded(
            `Sync has failed ${this.consecutiveFailures} times in a row.`,
          );
        }
      }

      // An outage is expected operation for this app and logs as a warning; a
      // real failure is an error. Conflating them makes the ERROR filter
      // useless in exactly the shops that lose connectivity most.
      const fields = {
        exception: err,
        code: offline ? 'OFFLINE' : 'E_INTERNAL',
        tenantId: scope.tenantId,
        context: {
          consecutiveFailures: this.consecutiveFailures,
          durationMs: Date.now() - started,
        },
      };

      if (offline) log.warn('Cycle stopped: device is offline', fields);
      else log.error('Cycle failed', err, fields);

      return this.finish({
        at,
        durationMs: Date.now() - started,
        offline,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /** Leave HYDRATING once tier 1 is present. */
  private promoteIfHydrated(db: SqliteDatabase): void {
    if (this.config.engineState.state !== 'HYDRATING') return;
    const hydrated = hydratedTables(db);
    if (TIER_1_TABLES.every((t) => hydrated.has(t))) {
      this.config.engineState.markReady();
    }
  }

  private setState(state: SyncState): void {
    if (this.state === state) return;
    this.state = state;
    this.config.onEvent?.('sync.state', { state });
  }

  private finish(result: SyncResult): SyncResult {
    this.last = result;
    return result;
  }
}
