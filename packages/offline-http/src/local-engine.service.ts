import { Injectable, NgZone, signal, inject } from '@angular/core';
import type { LocalBridge, LocalResponse } from './offline-http.backend';

export interface EngineStatus {
  state: string;
  reason: string | null;
  deviceId: string;
  contractVersion: string;
  localSchemaVersion: number;
  tenantId: string | null;
  branchId: string | null;
  hydration: { tier1Complete: boolean; hydrated: string[]; pending: string[] };
  outbox: {
    pending: number;
    inflight: number;
    synced: number;
    failed: number;
    conflict: number;
    oldestPendingAt: string | null;
  };
}

const EMPTY_STATUS: EngineStatus = {
  state: 'UNAVAILABLE',
  reason: 'Local engine not present',
  deviceId: '',
  contractVersion: '',
  localSchemaVersion: 0,
  tenantId: null,
  branchId: null,
  hydration: { tier1Complete: false, hydrated: [], pending: [] },
  outbox: { pending: 0, inflight: 0, synced: 0, failed: 0, conflict: 0, oldestPendingAt: null },
};

@Injectable({ providedIn: 'root' })
export class LocalEngineService {
  private readonly zone = inject(NgZone);
  private readonly bridge: LocalBridge | undefined = window.bizuriLocal;

  readonly status = signal<EngineStatus>(EMPTY_STATUS);
  readonly syncState = signal<string>('IDLE');
  readonly lastSyncAt = signal<string | null>(null);
  readonly hydrationProgress = signal<{ table: string; rows: number } | null>(null);

  get available(): boolean {
    return this.bridge?.available === true;
  }

  constructor() {
    if (!this.bridge) return;

    // Events arrive from ipcRenderer outside Angular's zone, so signal writes
    // would not schedule change detection without this.
    const inZone = <T>(fn: (data: T) => void) => (event: unknown) =>
      this.zone.run(() => fn((event as { data: T }).data));

    this.bridge.subscribe('engine.state', inZone<{ to: string; reason: string | null }>((d) => {
      this.status.update((s) => ({ ...s, state: d.to, reason: d.reason }));
      void this.refresh();
    }));

    this.bridge.subscribe('sync.state', inZone<{ state: string }>((d) => {
      this.syncState.set(d.state);
      if (d.state === 'IDLE') this.lastSyncAt.set(new Date().toISOString());
    }));

    this.bridge.subscribe('sync.progress', inZone<{ phase: string }>(() => void this.refresh()));

    this.bridge.subscribe('hydration.progress', inZone<{ table: string; rows: number }>((d) => {
      this.hydrationProgress.set({ table: d.table, rows: d.rows });
    }));

    void this.refresh();
  }

  async unlock(passphrase: string): Promise<void> {
    const res = await this.invoke('engineUnlock', 'POST', { body: { passphrase } });
    if (!res.ok) throw new Error(res.message ?? 'Unlock failed');
    this.status.set(res.data as EngineStatus);
  }

  async refresh(): Promise<void> {
    const res = await this.invoke('engineStatus', 'GET');
    if (res.ok) this.status.set(res.data as EngineStatus);
  }

  async signIn(credentials: {
    email: string;
    password: string;
    subdomainSlug: string;
  }): Promise<void> {
    const res = await this.invoke('engineSignIn', 'POST', { body: credentials });
    if (!res.ok) throw new Error(res.message ?? 'Sign-in failed');
    await this.refresh();
  }

  async syncNow(): Promise<void> {
    const res = await this.invoke('engineSyncNow', 'POST', { body: {} });
    if (!res.ok) throw new Error(res.message ?? 'Sync failed');
    await this.refresh();
  }

  private async invoke(
    operationId: string,
    method: string,
    extra: { body?: unknown } = {},
  ): Promise<LocalResponse> {
    if (!this.bridge) {
      return { ok: false, id: '', status: 503, message: 'Local engine unavailable' };
    }
    return this.bridge.request({
      id: crypto.randomUUID(),
      operationId,
      method,
      pathParams: {},
      query: {},
      headers: {},
      issuedAt: new Date().toISOString(),
      ...extra,
    });
  }
}
