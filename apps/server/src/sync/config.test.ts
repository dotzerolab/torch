import { describe, expect, it } from 'vitest';
import { ElectricConfigError, readElectricConfig } from './config.ts';

describe('readElectricConfig', () => {
  it('is off when ELECTRIC_URL is not set (the server then serves no sync routes)', () => {
    expect(readElectricConfig({})).toBeUndefined();
    expect(readElectricConfig({ ELECTRIC_URL: '', ELECTRIC_SECRET: 'x' })).toBeUndefined();
  });

  it('reads url and secret', () => {
    expect(
      readElectricConfig({ ELECTRIC_URL: 'http://localhost:3010', ELECTRIC_SECRET: 's3cret' }),
    ).toEqual({ url: 'http://localhost:3010', secret: 's3cret' });
  });

  it('drops a trailing slash so the shape path joins cleanly', () => {
    expect(
      readElectricConfig({ ELECTRIC_URL: 'http://electric:3000/', ELECTRIC_SECRET: 'x' })?.url,
    ).toBe('http://electric:3000');
  });

  it('fails startup, naming the variable only, when the secret is missing', () => {
    expect(() => readElectricConfig({ ELECTRIC_URL: 'http://localhost:3010' })).toThrow(
      ElectricConfigError,
    );
    expect(() => readElectricConfig({ ELECTRIC_URL: 'http://localhost:3010' })).toThrow(
      /ELECTRIC_SECRET/,
    );
  });

  it('fails startup when ELECTRIC_URL is not an http(s) URL, without echoing the secret', () => {
    for (const url of ['not a url', 'ftp://electric:3000', 'localhost:3010']) {
      let message = '';
      try {
        readElectricConfig({ ELECTRIC_URL: url, ELECTRIC_SECRET: 'TOPSECRET' });
      } catch (error) {
        message = (error as Error).message;
      }
      expect(message, url).toMatch(/ELECTRIC_URL/);
      expect(message, url).not.toContain('TOPSECRET');
    }
  });
});
