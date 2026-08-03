/**
 * Sliding-window rate limiter for IPC commands (Gate 6).
 *
 * Each command can declare a `rateLimit` (max calls per window).
 * Commands without a rate limit fall back to a global default.
 *
 * The limiter uses a per-command FIFO queue of timestamps.
 * Overhead is O(1) amortised — old entries are trimmed on each check.
 *
 * Thread safety: this runs in the main process's single-threaded
 * event loop, so no locking is required.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface RateLimitConfig {
  /** Window duration in milliseconds (default 60_000). */
  readonly windowMs: number;
  /** Maximum calls per window (default 60). */
  readonly maxCalls: number;
}

export interface RateLimitResult {
  readonly allowed: boolean;
  /** Human-readable reason when denied. */
  readonly reason?: string;
}

// ---------------------------------------------------------------------------
// Limiter
// ---------------------------------------------------------------------------

export class RateLimiter {
  private readonly windows = new Map<string, number[]>();
  private readonly globalConfig: RateLimitConfig;

  constructor(globalConfig?: Partial<RateLimitConfig>) {
    this.globalConfig = {
      windowMs: globalConfig?.windowMs ?? 60_000,
      maxCalls: globalConfig?.maxCalls ?? 60,
    };
  }

  /**
   * Attempt to record a call for `key` with an optional per-command limit.
   * Returns `{ allowed: true }` when the call should proceed, or a
   * descriptive denial otherwise.
   *
   * `perCommandMax` overrides the global `maxCalls` for this key.
   * Pass `undefined` or `0` to use the global default.
   */
  check(key: string, perCommandMax?: number): RateLimitResult {
    const maxCalls = perCommandMax && perCommandMax > 0
      ? perCommandMax
      : this.globalConfig.maxCalls;

    const now = Date.now();
    const cutoff = now - this.globalConfig.windowMs;

    let timestamps = this.windows.get(key);

    if (!timestamps) {
      timestamps = [];
      this.windows.set(key, timestamps);
    }

    // Trim expired entries.
    while (timestamps.length > 0 && timestamps[0] <= cutoff) {
      timestamps.shift();
    }

    if (timestamps.length >= maxCalls) {
      const retryAfterMs = timestamps[0] - cutoff;
      return {
        allowed: false,
        reason: `Rate limit exceeded for "${key}" (${maxCalls} per ${this.globalConfig.windowMs / 1000}s). Retry after ${Math.ceil(retryAfterMs / 1000)}s.`,
      };
    }

    timestamps.push(now);
    return { allowed: true };
  }

  /**
   * Reset all counters.  Useful for testing or after an engine state
   * transition.
   */
  reset(): void {
    this.windows.clear();
  }

  /**
   * Current call count for a key within the active window (for diagnostics).
   */
  count(key: string): number {
    const now = Date.now();
    const cutoff = now - this.globalConfig.windowMs;
    const timestamps = this.windows.get(key);
    if (!timestamps) return 0;

    while (timestamps.length > 0 && timestamps[0] <= cutoff) {
      timestamps.shift();
    }
    return timestamps.length;
  }
}
