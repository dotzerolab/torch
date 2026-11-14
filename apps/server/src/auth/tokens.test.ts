import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { generateToken, hashToken, isWellFormedToken } from './tokens.ts';

describe('tokens', () => {
  it('generates 32 random bytes as base64url, different every time', () => {
    const a = generateToken();
    const b = generateToken();

    expect(a).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(Buffer.from(a, 'base64url')).toHaveLength(32);
    expect(a).not.toBe(b);
  });

  it('hashes with SHA-256 as 64 lower-case hex characters, never the input', () => {
    const token = generateToken();

    const hash = hashToken(token);

    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(hash).toBe(createHash('sha256').update(token).digest('hex'));
    expect(hash).not.toBe(token);
  });

  it('only accepts strings shaped like a generated token', () => {
    expect(isWellFormedToken(generateToken())).toBe(true);
    for (const bad of [
      undefined,
      null,
      42,
      '',
      'short',
      `${generateToken()}x`,
      `${'!'.repeat(43)}`,
    ]) {
      expect(isWellFormedToken(bad)).toBe(false);
    }
  });
});
