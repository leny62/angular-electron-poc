import { handleEngineHealth } from '../engine-handlers';
import type { EngineContext } from '../engine-handlers';
import { EngineStateMachine } from '../../../domain/engine-state';

function makeEnvelope() {
  return {
    v: 1 as const,
    id: 'req-001',
    name: 'engine.health' as const,
    issuedAt: new Date().toISOString(),
    payload: {},
  };
}

describe('handleEngineHealth', () => {
  it('returns engine state and description', () => {
    const engineState = new EngineStateMachine();
    const ctx: EngineContext = {
      engineState,
      syncWorker: () => null,
      databaseOpen: true,
    };
    const result = handleEngineHealth({}, makeEnvelope(), ctx);
    expect(result.engineState).toBe('LOCKED');
    expect(result.engineDescription).toContain('LOCKED');
    expect(result.contractVersion).toBe(1);
    expect(result.databaseOpen).toBe(true);
  });

  it('returns null sync when worker is not available', () => {
    const ctx: EngineContext = {
      engineState: new EngineStateMachine(),
      syncWorker: () => null,
      databaseOpen: false,
    };
    const result = handleEngineHealth({}, makeEnvelope(), ctx);
    expect(result.sync).toBeNull();
  });

  it('returns sync status when worker is available', () => {
    const mockWorker = {
      getStatus: () => ({
        state: 'IDLE' as const,
        lastSyncAt: '2026-08-03T12:00:00Z',
        lastError: null,
        pushed: 5,
        pulled: 10,
        pending: 2,
      }),
    };
    const ctx: EngineContext = {
      engineState: new EngineStateMachine(),
      syncWorker: () => mockWorker as never,
      databaseOpen: true,
    };
    const result = handleEngineHealth({}, makeEnvelope(), ctx);
    expect(result.sync).not.toBeNull();
    expect(result.sync!.state).toBe('IDLE');
    expect(result.sync!.pushed).toBe(5);
    expect(result.sync!.pulled).toBe(10);
    expect(result.sync!.pending).toBe(2);
  });

  it('returns uptime information', () => {
    const ctx: EngineContext = {
      engineState: new EngineStateMachine(),
      syncWorker: () => null,
      databaseOpen: true,
    };
    const result = handleEngineHealth({}, makeEnvelope(), ctx);
    expect(result.uptime.seconds).toBeGreaterThanOrEqual(0);
    expect(result.uptime.nodeVersion).toBeDefined();
    expect(result.uptime.platform).toBeDefined();
  });
});
