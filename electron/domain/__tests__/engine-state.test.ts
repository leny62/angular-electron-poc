import { EngineStateMachine } from '../engine-state';

describe('EngineStateMachine', () => {
  let engine: EngineStateMachine;

  beforeEach(() => {
    engine = new EngineStateMachine();
  });

  it('starts in LOCKED state', () => {
    expect(engine.state).toBe('LOCKED');
  });

  describe('state transitions', () => {
    it('transitions from LOCKED to READY via markReady', () => {
      engine.markReady();
      expect(engine.state).toBe('READY');
      expect(engine.errorMessage).toBeNull();
    });

    it('transitions to LOCKED via markLocked', () => {
      engine.markReady();
      engine.markLocked();
      expect(engine.state).toBe('LOCKED');
    });

    it('transitions to DEGRADED with a reason', () => {
      engine.markReady();
      engine.markDegraded('Sync worker failed');
      expect(engine.state).toBe('DEGRADED');
      expect(engine.errorMessage).toBe('Sync worker failed');
    });

    it('transitions to FATAL with a reason', () => {
      engine.markFatal('Database corruption');
      expect(engine.state).toBe('FATAL');
      expect(engine.errorMessage).toBe('Database corruption');
    });

    it('transitions to DRAINING', () => {
      engine.markReady();
      engine.markDraining();
      expect(engine.state).toBe('DRAINING');
      expect(engine.errorMessage).toBeNull();
    });

    it('clears error message on READY transition', () => {
      engine.markFatal('error');
      engine.markReady();
      expect(engine.errorMessage).toBeNull();
    });

    it('clears error message on LOCKED transition', () => {
      engine.markDegraded('error');
      engine.markLocked();
      expect(engine.errorMessage).toBeNull();
    });
  });

  describe('isCommandAllowed', () => {
    it('allows all commands in READY state', () => {
      engine.markReady();
      expect(engine.isCommandAllowed('sale.create')).toBe(true);
      expect(engine.isCommandAllowed('catalog.search')).toBe(true);
      expect(engine.isCommandAllowed('sync.now')).toBe(true);
    });

    it('allows all commands in DEGRADED state', () => {
      engine.markReady();
      engine.markDegraded('sync failed');
      expect(engine.isCommandAllowed('sale.create')).toBe(true);
    });

    it('only allows whitelisted commands in LOCKED state', () => {
      expect(engine.isCommandAllowed('session.unlock')).toBe(true);
      expect(engine.isCommandAllowed('session.state')).toBe(true);
      expect(engine.isCommandAllowed('engine.health')).toBe(true);
      expect(engine.isCommandAllowed('sale.create')).toBe(false);
      expect(engine.isCommandAllowed('catalog.search')).toBe(false);
    });

    it('only allows whitelisted commands in FATAL state', () => {
      engine.markFatal('db gone');
      expect(engine.isCommandAllowed('session.unlock')).toBe(true);
      expect(engine.isCommandAllowed('session.state')).toBe(true);
      expect(engine.isCommandAllowed('engine.health')).toBe(true);
      expect(engine.isCommandAllowed('sale.create')).toBe(false);
    });

    it('allows read commands in DRAINING but rejects writes', () => {
      engine.markReady();
      engine.markDraining();

      // Always allowed
      expect(engine.isCommandAllowed('session.unlock')).toBe(true);
      expect(engine.isCommandAllowed('session.state')).toBe(true);
      expect(engine.isCommandAllowed('engine.health')).toBe(true);

      // Reads allowed
      expect(engine.isCommandAllowed('catalog.search')).toBe(true);
      expect(engine.isCommandAllowed('stock.balance')).toBe(true);
      expect(engine.isCommandAllowed('sale.get')).toBe(true);
      expect(engine.isCommandAllowed('sale.list')).toBe(true);
      expect(engine.isCommandAllowed('customer.search')).toBe(true);
      expect(engine.isCommandAllowed('sync.conflicts')).toBe(true);

      // Writes blocked
      expect(engine.isCommandAllowed('sale.create')).toBe(false);
      expect(engine.isCommandAllowed('stock.adjust')).toBe(false);
      expect(engine.isCommandAllowed('customer.create')).toBe(false);
      expect(engine.isCommandAllowed('sync.resolve')).toBe(false);
    });
  });

  describe('describe', () => {
    it('returns state without error when no error is set', () => {
      expect(engine.describe()).toBe('Engine: LOCKED');
    });

    it('returns state with error message when error is set', () => {
      engine.markFatal('DB failure');
      expect(engine.describe()).toContain('FATAL');
      expect(engine.describe()).toContain('DB failure');
    });

    it('updates describe output after state transition', () => {
      expect(engine.describe()).toBe('Engine: LOCKED');
      engine.markReady();
      expect(engine.describe()).toBe('Engine: READY');
    });
  });
});
