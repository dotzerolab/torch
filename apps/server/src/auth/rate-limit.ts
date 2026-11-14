// In-memory sliding-window rate limit (per process; one instance per customer is the P0 deployment) and the
// client IP it keys on.

export type RateLimitResult = { allowed: true } | { allowed: false; retryAfterSeconds: number };

/** The most keys one limiter holds: a flood of distinct addresses cannot grow memory past this. */
const MAX_KEYS = 50_000;
/** How often idle keys are dropped, at most (a window shorter than this prunes at its own pace). */
const PRUNE_INTERVAL_MS = 60_000;

export function createRateLimiter(opts: {
  limit: number;
  windowMs: number;
  now?: () => number;
  /** Most keys held at once; inserting past it evicts the key seen least recently. */
  maxKeys?: number;
  /** Period of the timer that drops keys with no hit inside the window. */
  pruneIntervalMs?: number;
}) {
  const now = opts.now ?? Date.now;
  const maxKeys = opts.maxKeys ?? MAX_KEYS;
  // A Map iterates in insertion order and `hit` re-inserts the key it touches, so its first key is always the one
  // seen least recently.
  const hits = new Map<string, number[]>();

  function prune() {
    const at = now();
    for (const [key, times] of hits) {
      const newest = times[times.length - 1];
      if (newest === undefined || newest <= at - opts.windowMs) hits.delete(key);
    }
  }
  // Pruning is a timer's job, not every request's: a hit stays O(1) however many keys there are. `unref`: the
  // timer never keeps the process (or a test run) alive.
  setInterval(prune, opts.pruneIntervalMs ?? Math.min(opts.windowMs, PRUNE_INTERVAL_MS)).unref();

  return {
    /** Records a hit for `key`. A blocked hit is not recorded, so retrying cannot extend the block. */
    hit(key: string): RateLimitResult {
      const at = now();
      const known = hits.get(key);
      const recent = (known ?? []).filter((time) => time > at - opts.windowMs);
      if (known) {
        hits.delete(key);
      } else if (hits.size >= maxKeys) {
        const oldest = hits.keys().next().value;
        if (oldest !== undefined) hits.delete(oldest);
      }
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

const MAX_KEY_LENGTH = 64;

/** The four decimal groups of an IPv4 address, or null. */
function parseIpv4(text: string): number[] | null {
  const parts = text.split('.');
  if (parts.length !== 4) return null;
  const octets = parts.map((part) => (/^\d{1,3}$/.test(part) ? Number(part) : Number.NaN));
  return octets.every((octet) => octet <= 255) ? octets : null;
}

/** The eight 16-bit groups of an IPv6 address (`::` expanded, a trailing dotted IPv4 folded in), or null. */
function parseIpv6(text: string): number[] | null {
  let address = text;
  const tail = address.slice(address.lastIndexOf(':') + 1);
  if (tail.includes('.')) {
    const octets = parseIpv4(tail);
    if (!octets) return null;
    const [a = 0, b = 0, c = 0, d = 0] = octets;
    address = `${address.slice(0, address.lastIndexOf(':') + 1)}${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
  }
  const halves = address.split('::');
  if (halves.length > 2) return null;
  const groupsOf = (part: string | undefined) => (part ? part.split(':') : []);
  const head = groupsOf(halves[0]);
  const rest = halves.length === 2 ? groupsOf(halves[1]) : [];
  if (halves.length === 1 ? head.length !== 8 : head.length + rest.length > 7) return null;
  const filler = halves.length === 2 ? Array<string>(8 - head.length - rest.length).fill('0') : [];
  const groups = [...head, ...filler, ...rest];
  if (!groups.every((group) => /^[0-9a-f]{1,4}$/.test(group))) return null;
  return groups.map((group) => Number.parseInt(group, 16));
}

/**
 * What a rate limit counts as one client. An IPv4 address is its own key; an IPv4-mapped IPv6 address
 * (`::ffff:a.b.c.d`) is the IPv4 address it wraps; any other IPv6 address becomes its /64 (the first four groups,
 * expanded, lower-case, then `/64`), because a client owns a whole /64 and could otherwise rotate addresses inside it
 * without ever meeting a limit. A value that is not an address ("unknown") is kept as it is, cut to 64 characters.
 */
export function clientKey(ip: string): string {
  let address = ip.trim().toLowerCase();
  if (address.startsWith('[') && address.endsWith(']')) address = address.slice(1, -1);
  const zone = address.indexOf('%');
  if (zone !== -1) address = address.slice(0, zone);
  if (!address.includes(':')) return address.slice(0, MAX_KEY_LENGTH);

  const groups = parseIpv6(address);
  if (!groups) return address.slice(0, MAX_KEY_LENGTH);
  const [g0 = 0, g1 = 0, g2 = 0, g3 = 0, g4 = 0, g5 = 0, g6 = 0, g7 = 0] = groups;
  if (g0 === 0 && g1 === 0 && g2 === 0 && g3 === 0 && g4 === 0 && g5 === 0xffff) {
    return `${g6 >> 8}.${g6 & 0xff}.${g7 >> 8}.${g7 & 0xff}`;
  }
  return `${[g0, g1, g2, g3].map((group) => group.toString(16)).join(':')}::/64`;
}
