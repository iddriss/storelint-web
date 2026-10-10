export interface RateLimiter {
  /** Records a hit for `key` and reports whether it is still within the limit. */
  hit(key: string): { allowed: boolean; remaining: number; retryAfterSec: number };
  reset(): void;
}

export interface RateLimiterOptions {
  limit: number;
  windowMs: number;
  now?: () => number;
}

/**
 * Sliding-window in-memory limiter. Good enough for a single-process app behind
 * Traefik; keys are client IPs. Old timestamps are pruned per key on access and
 * the whole table is swept occasionally so it cannot grow without bound.
 */
export function createRateLimiter(opts: RateLimiterOptions): RateLimiter {
  const now = opts.now ?? Date.now;
  const hits = new Map<string, number[]>();
  let lastSweep = now();

  function sweep(t: number): void {
    if (t - lastSweep < opts.windowMs && hits.size < 10_000) return;
    lastSweep = t;
    for (const [key, stamps] of hits) {
      const fresh = stamps.filter((s) => t - s < opts.windowMs);
      if (fresh.length === 0) hits.delete(key);
      else hits.set(key, fresh);
    }
  }

  return {
    hit(key) {
      const t = now();
      sweep(t);
      const fresh = (hits.get(key) ?? []).filter((s) => t - s < opts.windowMs);
      if (fresh.length >= opts.limit) {
        hits.set(key, fresh);
        const oldest = fresh[0] ?? t;
        return { allowed: false, remaining: 0, retryAfterSec: Math.max(1, Math.ceil((oldest + opts.windowMs - t) / 1000)) };
      }
      fresh.push(t);
      hits.set(key, fresh);
      return { allowed: true, remaining: opts.limit - fresh.length, retryAfterSec: 0 };
    },
    reset() {
      hits.clear();
    },
  };
}
