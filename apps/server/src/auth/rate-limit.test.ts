import { describe, expect, it } from 'vitest';
import { clientIp, createRateLimiter } from './rate-limit.ts';

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

  it('forgets idle keys so memory stays bounded', () => {
    let now = 0;
    const limiter = createRateLimiter({
      limit: 1,
      windowMs: 1_000,
      now: () => now,
      pruneAbove: 10,
    });

    for (let i = 0; i < 100; i++) limiter.hit(`k${i}`);
    now += 2_000;
    limiter.hit('fresh');

    expect(limiter.size()).toBeLessThanOrEqual(2);
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
