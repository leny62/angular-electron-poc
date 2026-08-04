import { handleSessionUnlock, handleSessionState } from '../session-handlers';
import type { SessionContext } from '../session-handlers';
import { EngineStateMachine } from '../../../domain/engine-state';

function makeEnvelope(overrides = {}) {
  return {
    v: 1 as const,
    id: 'req-001',
    name: 'session.unlock' as const,
    issuedAt: new Date().toISOString(),
    payload: {},
    ...overrides,
  };
}

function makeContext(overrides: Partial<SessionContext> = {}): SessionContext {
  return {
    engineState: new EngineStateMachine(),
    unlockFn: () => true,
    ...overrides,
  };
}

describe('handleSessionUnlock', () => {
  it('transitions engine to READY on successful unlock', () => {
    const ctx = makeContext({ unlockFn: () => true });
    const result = handleSessionUnlock({ passphrase: 'correct' }, makeEnvelope(), ctx);
    expect(result.engineState).toBe('READY');
    expect(ctx.engineState.state).toBe('READY');
  });

  it('throws E_SCHEMA when passphrase is missing', () => {
    const ctx = makeContext();
    expect(() => handleSessionUnlock({}, makeEnvelope(), ctx)).toThrow();
    try {
      handleSessionUnlock({}, makeEnvelope(), ctx);
    } catch (err: unknown) {
      const e = err as Error & { code: string };
      expect(e.code).toBe('E_SCHEMA');
    }
  });

  it('throws E_SCHEMA when passphrase is empty string', () => {
    const ctx = makeContext();
    expect(() => handleSessionUnlock({ passphrase: '' }, makeEnvelope(), ctx)).toThrow();
    try {
      handleSessionUnlock({ passphrase: '' }, makeEnvelope(), ctx);
    } catch (err: unknown) {
      const e = err as Error & { code: string };
      expect(e.code).toBe('E_SCHEMA');
    }
  });

  it('throws E_LOCKED when unlockFn returns false', () => {
    const ctx = makeContext({ unlockFn: () => false });
    expect(() => handleSessionUnlock({ passphrase: 'wrong' }, makeEnvelope(), ctx)).toThrow();
    try {
      handleSessionUnlock({ passphrase: 'wrong' }, makeEnvelope(), ctx);
    } catch (err: unknown) {
      const e = err as Error & { code: string; retryable: boolean };
      expect(e.code).toBe('E_LOCKED');
      expect(e.retryable).toBe(true);
    }
  });

  it('engine remains LOCKED after failed unlock', () => {
    const ctx = makeContext({ unlockFn: () => false });
    expect(() => handleSessionUnlock({ passphrase: 'wrong' }, makeEnvelope(), ctx)).toThrow();
    expect(ctx.engineState.state).toBe('LOCKED');
  });
});

describe('handleSessionState', () => {
  it('returns LOCKED state when engine is locked', () => {
    const ctx = makeContext();
    const result = handleSessionState({}, makeEnvelope(), ctx);
    expect(result.engineState).toBe('LOCKED');
    expect(result.contractVersion).toBe(1);
    expect(result.databaseOpen).toBe(false);
  });

  it('returns READY state when engine is ready', () => {
    const ctx = makeContext();
    ctx.engineState.markReady();
    const result = handleSessionState({}, makeEnvelope(), ctx);
    expect(result.engineState).toBe('READY');
    expect(result.databaseOpen).toBe(true);
  });

  it('reports databaseOpen as true in DEGRADED state', () => {
    const ctx = makeContext();
    ctx.engineState.markReady();
    ctx.engineState.markDegraded('sync failure');
    const result = handleSessionState({}, makeEnvelope(), ctx);
    expect(result.engineState).toBe('DEGRADED');
    expect(result.databaseOpen).toBe(true);
  });

  it('reports databaseOpen as false in FATAL state', () => {
    const ctx = makeContext();
    ctx.engineState.markFatal('db corruption');
    const result = handleSessionState({}, makeEnvelope(), ctx);
    expect(result.engineState).toBe('FATAL');
    expect(result.databaseOpen).toBe(false);
  });
});
