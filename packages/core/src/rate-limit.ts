export interface RateLimiterOptions {
  /** Allowed requests per key within the window. */
  limit: number;
  windowMs: number;
  now?: () => number;
  /** Upper bound on tracked keys; when full, unknown keys are refused (fail-closed). */
  maxKeys?: number;
}

export type RateLimitResult = { allowed: true; remaining: number } | { allowed: false; retryAfterMs: number };

export interface RateLimiter {
  /** Counts the request for `key` if allowed. Rejected requests are not counted. */
  check(key: string): RateLimitResult;
  /** Gives back the newest slot of `key` (a request that turned out to be harmless). Never resets older hits. */
  release(key: string): void;
  size(): number;
}

/** In-memory sliding-window limiter per identity (D20). Holds only keys and timestamps. */
export function createRateLimiter(opts: RateLimiterOptions): RateLimiter {
  if (!Number.isInteger(opts.limit) || opts.limit < 1) throw new Error("limit must be a positive integer");
  if (!(opts.windowMs > 0)) throw new Error("windowMs must be positive");
  const now = opts.now ?? Date.now;
  const maxKeys = opts.maxKeys ?? 1000;
  const hits = new Map<string, number[]>();

  const active = (list: number[], t: number) => list.filter((h) => h > t - opts.windowMs);
  const sweep = (t: number) => {
    for (const [k, list] of hits) {
      const left = active(list, t);
      if (left.length === 0) hits.delete(k);
      else hits.set(k, left);
    }
  };

  return {
    check(key) {
      const t = now();
      if (!hits.has(key) && hits.size >= maxKeys) {
        sweep(t);
        if (hits.size >= maxKeys) return { allowed: false, retryAfterMs: opts.windowMs };
      }
      const list = active(hits.get(key) ?? [], t);
      if (list.length >= opts.limit) {
        hits.set(key, list);
        return { allowed: false, retryAfterMs: list[0] + opts.windowMs - t };
      }
      list.push(t);
      hits.set(key, list);
      return { allowed: true, remaining: opts.limit - list.length };
    },
    release(key) {
      const list = hits.get(key);
      if (!list) return;
      list.pop();
      if (list.length === 0) hits.delete(key);
    },
    size: () => hits.size,
  };
}
