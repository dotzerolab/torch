import { afterEach, describe, expect, it, vi } from 'vitest';
import { clientIp, clientKey, createRateLimiter } from './rate-limit.ts';

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('createRateLimiter', () => {
  it('allows `limit` hits per window and then blocks with the seconds until the oldest hit expires', () => {
    let now = 1_000_000;
    const limiter = createRateLimiter({ limit: 3, windowMs: 60_000, now: () => now });

    expect(limiter.hit('a')).toEqual({ allowed: true });
    now += 10_000;
    expect(limiter.hit('a')).toEqual({ allowed: true });
    expect(limiter.hit('a')).toEqual({ allowed: true });
    now += 5_000;
    expect(limiter.hit('a')).toEqual({ allowed: false, retryAfterSeconds: 45 });
  });

  it('counts keys separately and lets hits through again once the window has passed', () => {
    let now = 0;
    const limiter = createRateLimiter({ limit: 1, windowMs: 1_000, now: () => now });

    expect(limiter.hit('a').allowed).toBe(true);
    expect(limiter.hit('a').allowed).toBe(false);
    expect(limiter.hit('b').allowed).toBe(true);
    now += 1_001;
    expect(limiter.hit('a').allowed).toBe(true);
  });

  it('does not count blocked hits against the key', () => {
    let now = 0;
    const limiter = createRateLimiter({ limit: 1, windowMs: 1_000, now: () => now });

    limiter.hit('a');
    for (let i = 0; i < 50; i++) limiter.hit('a');
    now += 1_001;

    expect(limiter.hit('a').allowed).toBe(true);
  });

  it('forgets idle keys on a timer, not on every hit', () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    let now = 0;
    const limiter = createRateLimiter({
      limit: 1,
      windowMs: 1_000,
      now: () => now,
      pruneIntervalMs: 10_000,
    });

    for (let i = 0; i < 100; i++) limiter.hit(`k${i}`);
    now += 2_000;
    limiter.hit('fresh');
    // Hits never walk the map: the idle keys are still there until the timer runs.
    expect(limiter.size()).toBe(101);
    vi.advanceTimersByTime(10_000);

    expect(limiter.size()).toBe(1);
  });

  it('keeps a key that is still inside its window when the timer prunes', () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    let now = 0;
    const limiter = createRateLimiter({
      limit: 2,
      windowMs: 60_000,
      now: () => now,
      pruneIntervalMs: 10_000,
    });
    limiter.hit('busy');
    limiter.hit('idle');
    now = 40_000;
    limiter.hit('busy');
    now = 70_000; // 'idle' was seen 70 s ago, 'busy' 30 s ago

    vi.advanceTimersByTime(10_000);

    expect(limiter.size()).toBe(1);
    expect(limiter.hit('busy')).toEqual({ allowed: true });
    expect(limiter.hit('busy').allowed).toBe(false);
  });

  it('the prune timer does not keep the process alive', () => {
    const interval = vi.spyOn(globalThis, 'setInterval');

    createRateLimiter({ limit: 1, windowMs: 1_000 });

    const handle = interval.mock.results[0]?.value as NodeJS.Timeout;
    expect(handle.hasRef()).toBe(false);
    clearInterval(handle);
  });

  it('never holds more than 50,000 keys, whatever the load', () => {
    const limiter = createRateLimiter({ limit: 5, windowMs: 900_000 });

    for (let i = 0; i < 60_000; i++) limiter.hit(`k${i}`);

    expect(limiter.size()).toBe(50_000);
  });

  it('at the cap the oldest key goes first: a recently seen key survives a flood of new ones', () => {
    const limiter = createRateLimiter({ limit: 1, windowMs: 900_000, maxKeys: 3 });
    limiter.hit('a');
    limiter.hit('b');
    limiter.hit('c');
    limiter.hit('a'); // blocked, but seen again: no longer the oldest

    limiter.hit('d'); // evicts 'b', the least recently seen

    expect(limiter.size()).toBe(3);
    expect(limiter.hit('a').allowed).toBe(false);
    expect(limiter.hit('c').allowed).toBe(false);
    expect(limiter.hit('b').allowed).toBe(true);
  });

  it('a key evicted at the cap starts a fresh window (the only loosening a flood can cause)', () => {
    const limiter = createRateLimiter({ limit: 1, windowMs: 900_000, maxKeys: 2 });
    limiter.hit('a');
    limiter.hit('b');
    limiter.hit('c');

    expect(limiter.hit('a').allowed).toBe(true);
  });
});

describe('clientKey', () => {
  it('leaves an IPv4 address as it is', () => {
    expect(clientKey('203.0.113.7')).toBe('203.0.113.7');
  });

  it('turns an IPv4-mapped IPv6 address into the IPv4 address (dotted or hex form, any case)', () => {
    expect(clientKey('::ffff:203.0.113.7')).toBe('203.0.113.7');
    expect(clientKey('::FFFF:203.0.113.7')).toBe('203.0.113.7');
    expect(clientKey('::ffff:cb00:7107')).toBe('203.0.113.7');
    expect(clientKey('0:0:0:0:0:ffff:cb00:7107')).toBe('203.0.113.7');
  });

  it('keys any other IPv6 address by its /64: the same key inside one /64, another across /64s', () => {
    const key = clientKey('2001:db8:1:2:aaaa:bbbb:cccc:dddd');

    expect(clientKey('2001:db8:1:2:1::9')).toBe(key);
    expect(clientKey('2001:db8:1:2::')).toBe(key);
    expect(clientKey('2001:DB8:1:2:ffff:ffff:ffff:ffff')).toBe(key);
    expect(clientKey('2001:0db8:0001:0002:0000:0000:0000:0001')).toBe(key);
    expect(clientKey('2001:db8:1:3:aaaa:bbbb:cccc:dddd')).not.toBe(key);
    expect(clientKey('2001:db8:2:2:aaaa:bbbb:cccc:dddd')).not.toBe(key);
    expect(key).toMatch(/\/64$/);
  });

  it('expands a :: that stands inside the first four groups', () => {
    expect(clientKey('2001:db8::1')).toBe(clientKey('2001:db8:0:0:5::1'));
    expect(clientKey('2001::1')).toBe(clientKey('2001:0:0:0::7'));
    expect(clientKey('::1')).toBe(clientKey('0:0:0:0:9:9:9:9'));
    expect(clientKey('::')).toBe(clientKey('0:0:0:0::'));
  });

  it('an IPv6 key never collides with an IPv4 address', () => {
    expect(clientKey('::1')).not.toBe(clientKey('0.0.0.1'));
    expect(clientKey('2001:db8:1:2::1')).not.toMatch(/^\d+\.\d+\.\d+\.\d+$/);
  });

  it('drops a zone id and a bracket pair', () => {
    expect(clientKey('fe80::1%en0')).toBe(clientKey('fe80::2'));
    expect(clientKey('[2001:db8:1:2::1]')).toBe(clientKey('2001:db8:1:2::9'));
  });

  it('passes through what is not an address ("unknown", garbage) unchanged and bounded', () => {
    expect(clientKey('unknown')).toBe('unknown');
    expect(clientKey('not-an-ip')).toBe('not-an-ip');
    expect(clientKey('1:2:3')).toBe('1:2:3');
    expect(clientKey('x'.repeat(500)).length).toBeLessThanOrEqual(64);
  });
});

describe('clientIp', () => {
  const req = (headers: Record<string, string> = {}) => new Request('http://x.test/', { headers });
  const env = (ip: string) => ({ incoming: { socket: { remoteAddress: ip } } });

  it('uses the socket address and ignores x-forwarded-for when no proxy is trusted', () => {
    expect(clientIp(req({ 'x-forwarded-for': '1.1.1.1' }), env('10.0.0.5'), false)).toBe(
      '10.0.0.5',
    );
  });

  it('behind a trusted proxy takes the last x-forwarded-for entry (the one the proxy added)', () => {
    expect(clientIp(req({ 'x-forwarded-for': '6.6.6.6, 9.9.9.9' }), env('10.0.0.5'), true)).toBe(
      '9.9.9.9',
    );
  });

  it('falls back to the socket when the trusted header is missing, and to "unknown" without a socket', () => {
    expect(clientIp(req(), env('10.0.0.5'), true)).toBe('10.0.0.5');
    expect(clientIp(req(), undefined, false)).toBe('unknown');
  });
});
