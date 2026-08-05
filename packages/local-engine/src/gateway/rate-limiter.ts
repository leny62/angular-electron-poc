/**
 * Sliding-window rate limiter for gate 6.
 *
 * Ported from the POC with two fixes:
 *
 *   1. `count()` no longer mutates. The POC's version trimmed the window as a
 *      side effect of being asked for a number, so calling a diagnostic changed
 *      limiter state. That made the diagnostic itself unsafe to call.
 *
 *   2. Idle keys are evicted. The POC's map grew one entry per distinct key for
 *      the process lifetime. With ~19 operations that is harmless, but the
 *      limiter is also the natural place to key by operation *and* tenant later,
 *      and an unbounded map keyed by anything request-derived is a slow leak.
 *
 * Single-threaded main process, so no locking.
 */

export interface RateLimitConfig {
  readonly windowMs: number;
  readonly maxCalls: number;
}

export interface RateLimitResult {
  readonly allowed: boolean;
  readonly reason?: string;
  /** Seconds until the next call would be permitted. For a Retry-After header. */
  readonly retryAfterSec?: number;
}

/** Keys untouched for this long are dropped on the next sweep. */
const IDLE_EVICTION_MS = 10 * 60_000;

export class RateLimiter {
  private readonly windows = new Map<string, number[]>();
  private readonly lastSeen = new Map<string, number>();
  private lastSweep = 0;
  private readonly config: RateLimitConfig;

  constructor(config?: Partial<RateLimitConfig>) {
    this.config = {
      windowMs: config?.windowMs ?? 60_000,
      maxCalls: config?.maxCalls ?? 60,
    };
  }

  /**
   * Record a call against `key`. `perKeyMax` overrides the global maximum, and
   * is where a route's own `rateLimit` from the generated table arrives.
   */
  check(key: string, perKeyMax?: number): RateLimitResult {
    const now = Date.now();
    const maxCalls = perKeyMax && perKeyMax > 0 ? perKeyMax : this.config.maxCalls;
    const cutoff = now - this.config.windowMs;

    this.maybeSweep(now);

    let timestamps = this.windows.get(key);
    if (!timestamps) {
      timestamps = [];
      this.windows.set(key, timestamps);
    }
    this.lastSeen.set(key, now);

    // Drop expired entries from the front. Amortised O(1).
    let drop = 0;
    while (drop < timestamps.length && (timestamps[drop] as number) <= cutoff) drop++;
    if (drop > 0) timestamps.splice(0, drop);

    if (timestamps.length >= maxCalls) {
      const oldest = timestamps[0] as number;
      const retryAfterSec = Math.max(1, Math.ceil((oldest - cutoff) / 1000));
      return {
        allowed: false,
        reason: `Rate limit exceeded: ${maxCalls} calls per ${
          this.config.windowMs / 1000
        }s. Retry in ${retryAfterSec}s.`,
        retryAfterSec,
      };
    }

    timestamps.push(now);
    return { allowed: true };
  }

  /** Current count in the active window. Does not mutate limiter state. */
  count(key: string): number {
    const timestamps = this.windows.get(key);
    if (!timestamps) return 0;
    const cutoff = Date.now() - this.config.windowMs;
    let i = 0;
    while (i < timestamps.length && (timestamps[i] as number) <= cutoff) i++;
    return timestamps.length - i;
  }

  reset(): void {
    this.windows.clear();
    this.lastSeen.clear();
    this.lastSweep = 0;
  }

  /** Number of tracked keys. Diagnostics, and the leak test asserts on it. */
  get trackedKeys(): number {
    return this.windows.size;
  }

  /** Evict idle keys, at most once per window. */
  private maybeSweep(now: number): void {
    if (now - this.lastSweep < this.config.windowMs) return;
    this.lastSweep = now;

    for (const [key, seen] of this.lastSeen) {
      if (now - seen > IDLE_EVICTION_MS) {
        this.windows.delete(key);
        this.lastSeen.delete(key);
      }
    }
  }
}
