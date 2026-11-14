import { describe, expect, it } from 'vitest';
import { readLinkToken } from './link-token.ts';

const TOKEN = 'abcDEF123_-abcDEF123_-abcDEF123_-abcDEF123_-';

describe('readLinkToken', () => {
  it('reads the token from the fragment of the emailed link', () => {
    expect(readLinkToken(`#token=${TOKEN}`)).toBe(TOKEN);
  });

  it('finds it among other fragment parameters', () => {
    expect(readLinkToken(`#utm=x&token=${TOKEN}&y=1`)).toBe(TOKEN);
  });

  it('is null for no fragment, an empty one, or no token in it', () => {
    expect(readLinkToken('')).toBeNull();
    expect(readLinkToken('#')).toBeNull();
    expect(readLinkToken('#token=')).toBeNull();
    expect(readLinkToken('#other=1')).toBeNull();
  });

  it('is null for a value that cannot be a token (nothing odd is sent to the server)', () => {
    expect(readLinkToken('#token=has space')).toBeNull();
    expect(readLinkToken('#token=a%2Fb')).toBeNull();
    expect(readLinkToken(`#token=${'a'.repeat(300)}`)).toBeNull();
  });

  it('never reads a token from a query string', () => {
    expect(readLinkToken(`?token=${TOKEN}`)).toBeNull();
  });
});
