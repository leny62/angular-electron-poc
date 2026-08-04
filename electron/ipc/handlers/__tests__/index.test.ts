import { createCommandDefinitions } from '../index';
import type { HandlerContext } from '../index';
import { EngineStateMachine } from '../../../domain/engine-state';

describe('createCommandDefinitions', () => {
  function makeContext(overrides: Partial<HandlerContext> = {}): HandlerContext {
    return {
      db: () => {
        throw new Error('DB not available in test');
      },
      engineState: new EngineStateMachine(),
      syncWorker: () => null,
      unlockFn: () => true,
      deviceId: 'poc-device-001',
      tenantId: 'poc-tenant',
      branchId: 'poc-branch',
      receiptPrefix: 'RCP',
      ...overrides,
    };
  }

  it('returns all 14 command definitions', () => {
    const defs = createCommandDefinitions(makeContext());
    expect(defs).toHaveLength(14);
  });

  it('every definition has name, handler, and requiresUnlock', () => {
    const defs = createCommandDefinitions(makeContext());
    for (const def of defs) {
      expect(def).toHaveProperty('name');
      expect(def).toHaveProperty('handler');
      expect(def).toHaveProperty('requiresUnlock');
    }
  });

  it('unlocked commands have requiresUnlock set to false', () => {
    const defs = createCommandDefinitions(makeContext());
    const unlocked = defs.filter(
      (d) =>
        d.name === 'session.unlock' ||
        d.name === 'session.state' ||
        d.name === 'engine.health',
    );
    expect(unlocked).toHaveLength(3);
    for (const d of unlocked) {
      expect(d.requiresUnlock).toBe(false);
    }
  });

  it('all other commands have requiresUnlock set to true', () => {
    const defs = createCommandDefinitions(makeContext());
    const locked = defs.filter(
      (d) =>
        d.name !== 'session.unlock' &&
        d.name !== 'session.state' &&
        d.name !== 'engine.health',
    );
    expect(locked).toHaveLength(11);
    for (const d of locked) {
      expect(d.requiresUnlock).toBe(true);
    }
  });

  it('every definition has a handler function', () => {
    const defs = createCommandDefinitions(makeContext());
    for (const def of defs) {
      expect(typeof def.handler).toBe('function');
    }
  });

  it('includes rateLimit on all definitions', () => {
    const defs = createCommandDefinitions(makeContext());
    for (const def of defs) {
      expect(def).toHaveProperty('rateLimit');
    }
  });

  it('unlock command has the lowest rate limit', () => {
    const defs = createCommandDefinitions(makeContext());
    const unlock = defs.find((d) => d.name === 'session.unlock');
    expect(unlock!.rateLimit).toBe(10);
  });

  it('sync.now has rate limit of 6', () => {
    const defs = createCommandDefinitions(makeContext());
    const syncNow = defs.find((d) => d.name === 'sync.now');
    expect(syncNow!.rateLimit).toBe(6);
  });

  it('engine.health is in the registry', () => {
    const defs = createCommandDefinitions(makeContext());
    const health = defs.find((d) => d.name === 'engine.health');
    expect(health).toBeDefined();
  });

  it('sync handlers work when syncWorker is null', () => {
    const defs = createCommandDefinitions(makeContext({ syncWorker: () => null }));
    const syncNow = defs.find((d) => d.name === 'sync.now')!;
    const conflicts = defs.find((d) => d.name === 'sync.conflicts')!;
    const resolve = defs.find((d) => d.name === 'sync.resolve')!;

    const nowResult = syncNow.handler({}, {} as never) as Record<string, unknown>;
    expect(nowResult.message).toContain('not initialised');

    const conflictsResult = conflicts.handler({}, {} as never) as Record<string, unknown>;
    expect(conflictsResult.conflicts).toEqual([]);

    expect(() =>
      resolve.handler({ conflictId: 'x', resolution: 'local' }, {} as never),
    ).not.toThrow();
  });

  it('sync handlers work when syncWorker is available', () => {
    const mockWorker = {
      forceSync: () => ({
        pushed: 3,
        pulled: 5,
        pending: 1,
        state: 'IDLE',
      }),
      getConflicts: () => [{ id: 'c1', entity: 'sale', entityId: 's1' }],
      resolveConflict: (id: string, _resolution: string) => ({
        resolved: true,
        message: 'done',
      }),
    };

    const defs = createCommandDefinitions(
      makeContext({ syncWorker: () => mockWorker as never }),
    );

    const syncNow = defs.find((d) => d.name === 'sync.now')!;
    const result = syncNow.handler({}, {} as never) as Record<string, unknown>;
    expect(result.pushed).toBe(3);
    expect(result.pulled).toBe(5);
  });
});
