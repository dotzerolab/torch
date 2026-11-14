// In-memory sliding-window rate limit (per process; one instance per customer is the P0 deployment) and the
// client IP it keys on.

export type RateLimitResult = { allowed: true } | { allowed: false; retryAfterSeconds: number };

export function createRateLimiter(opts: {
  limit: number;
  windowMs: number;
  now?: () => number;
  /** Idle keys are dropped once the map grows past this many keys. */
  pruneAbove?: number;
}) {
  const now = opts.now ?? Date.now;
  const pruneAbove = opts.pruneAbove ?? 10_000;
  const hits = new Map<string, number[]>();

  function prune(at: number) {
    for (const [key, times] of hits) {
      const newest = times[times.length - 1];
      if (newest === undefined || newest <= at - opts.windowMs) hits.delete(key);
    }
  }

  return {
    /** Records a hit for `key`. A blocked hit is not recorded, so retrying cannot extend the block. */
    hit(key: string): RateLimitResult {
      const at = now();
      if (hits.size > pruneAbove) prune(at);
      const recent = (hits.get(key) ?? []).filter((time) => time > at - opts.windowMs);
      if (recent.length >= opts.limit) {
        hits.set(key, recent);
        const oldest = recent[0] as number;
        return {
          allowed: false,
          retryAfterSeconds: Math.max(1, Math.ceil((oldest + opts.windowMs - at) / 1000)),
        };
      }
      recent.push(at);
      hits.set(key, recent);
      return { allowed: true };
    },
    size: () => hits.size,
  };
}

/**
 * Address the request comes from. `x-forwarded-for` is client-controlled unless a proxy we trust appends to
 * it, so it is read only when `trustProxy` is set, and then only its last entry (the one our proxy added;
 * assumes one trusted proxy). Otherwise the socket address, which Node's server puts in the Hono env.
 */
export function clientIp(req: Request, env: unknown, trustProxy: boolean): string {
  if (trustProxy) {
    const entries = (req.headers.get('x-forwarded-for') ?? '')
      .split(',')
      .map((entry) => entry.trim())
      .filter(Boolean);
    const last = entries[entries.length - 1];
    if (last) return last;
  }
  const socketAddress = (env as { incoming?: { socket?: { remoteAddress?: unknown } } } | undefined)
    ?.incoming?.socket?.remoteAddress;
  return typeof socketAddress === 'string' && socketAddress !== '' ? socketAddress : 'unknown';
}
