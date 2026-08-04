import { RateLimiter } from '../rate-limiter';

describe('RateLimiter', () => {
  let limiter: RateLimiter;

  beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-08-03T12:00:00Z'));
    limiter = new RateLimiter({ windowMs: 60_000, maxCalls: 5 });
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('allows calls within the limit', () => {
    for (let i = 0; i < 5; i++) {
      const result = limiter.check('test');
      expect(result.allowed).toBe(true);
    }
  });

  it('rejects calls beyond the limit', () => {
    for (let i = 0; i < 5; i++) {
      limiter.check('test');
    }
    const result = limiter.check('test');
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain('Rate limit exceeded');
  });

  it('tracks limits independently per key', () => {
    for (let i = 0; i < 5; i++) {
      limiter.check('cmd-a');
    }
    const result = limiter.check('cmd-b');
    expect(result.allowed).toBe(true);
  });

  it('allows calls again after the window expires', () => {
    for (let i = 0; i < 5; i++) {
      limiter.check('test');
    }
    expect(limiter.check('test').allowed).toBe(false);

    jest.advanceTimersByTime(61_000);
    expect(limiter.check('test').allowed).toBe(true);
  });

  it('uses per-command max when provided', () => {
    limiter = new RateLimiter({ windowMs: 60_000, maxCalls: 100 });
    for (let i = 0; i < 5; i++) {
      expect(limiter.check('restricted', 5).allowed).toBe(true);
    }
    expect(limiter.check('restricted', 5).allowed).toBe(false);
  });

  it('reports reason with retry-after guidance', () => {
    for (let i = 0; i < 5; i++) {
      limiter.check('test');
    }
    const result = limiter.check('test');
    expect(result.reason).toContain('Retry after');
  });

  it('reset clears all counters', () => {
    for (let i = 0; i < 5; i++) {
      limiter.check('test');
    }
    limiter.reset();
    expect(limiter.check('test').allowed).toBe(true);
  });

  it('count returns current active calls', () => {
    expect(limiter.count('test')).toBe(0);
    limiter.check('test');
    limiter.check('test');
    expect(limiter.count('test')).toBe(2);
  });

  it('count trims expired entries', () => {
    limiter.check('test');
    limiter.check('test');
    expect(limiter.count('test')).toBe(2);

    jest.advanceTimersByTime(61_000);
    expect(limiter.count('test')).toBe(0);
  });

  it('uses global defaults when no config provided', () => {
    const defaultLimiter = new RateLimiter();
    for (let i = 0; i < 60; i++) {
      expect(defaultLimiter.check('x').allowed).toBe(true);
    }
    expect(defaultLimiter.check('x').allowed).toBe(false);
  });

  it('falls back to global maxCalls when perCommandMax is 0', () => {
    limiter = new RateLimiter({ maxCalls: 3 });
    for (let i = 0; i < 3; i++) {
      expect(limiter.check('x', 0).allowed).toBe(true);
    }
    expect(limiter.check('x', 0).allowed).toBe(false);
  });

  it('supports multiple keys with different activity levels', () => {
    // Saturate key-a
    for (let i = 0; i < 5; i++) limiter.check('a');
    // Light use on key-b
    limiter.check('b');
    limiter.check('b');
    // count before the extra check() call below
    expect(limiter.count('b')).toBe(2);

    expect(limiter.check('a').allowed).toBe(false);
    expect(limiter.check('b').allowed).toBe(true); // this is the 3rd call
    expect(limiter.count('a')).toBe(5);
    expect(limiter.count('b')).toBe(3);
  });
});
