import { afterEach, describe, expect, it, vi } from 'vitest';
import { detectLocale, missingKeys, t } from './index.ts';

afterEach(() => vi.restoreAllMocks());

describe('t', () => {
  it('fills the brand placeholder in English', () => {
    expect(t('en', 'app.welcome', { brand: 'Acme' })).toBe('Welcome to Acme');
  });

  it('fills the brand placeholder in Italian', () => {
    expect(t('it', 'app.welcome', { brand: 'Acme' })).toBe('Benvenuto in Acme');
  });

  it('returns the key for an unknown key and logs it once', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    expect(t('en', 'does.not.exist')).toBe('does.not.exist');
    expect(t('en', 'does.not.exist')).toBe('does.not.exist');

    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]?.[0]).toContain('does.not.exist');
  });

  it('treats an inherited object property name as an unknown key', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});

    expect(t('en', 'constructor')).toBe('constructor');
    expect(t('en', 'toString')).toBe('toString');
  });

  it('leaves a placeholder without a value visible instead of printing "undefined"', () => {
    expect(t('en', 'app.welcome')).toBe('Welcome to {brand}');
  });

  it('does not read placeholder values from the prototype', () => {
    expect(t('en', 'app.welcome', {})).toBe('Welcome to {brand}');
  });
});

describe('missingKeys', () => {
  it('is empty for the shipped catalogs', () => {
    expect(missingKeys()).toEqual([]);
  });

  it('lists a key present in en and absent in it', () => {
    const gap = missingKeys({ en: { a: 'A', b: 'B' }, it: { a: 'A' } });

    expect(gap).toEqual([{ locale: 'it', key: 'b' }]);
  });

  it('counts an empty translation as missing', () => {
    const gap = missingKeys({ en: { a: 'A' }, it: { a: '  ' } });

    expect(gap).toEqual([{ locale: 'it', key: 'a' }]);
  });
});

describe('detectLocale', () => {
  it.each([
    ['it', 'it'],
    ['it-IT', 'it'],
    ['it-CH', 'it'],
    ['en-US', 'en'],
    ['fr-FR', 'en'],
    ['', 'en'],
    [undefined, 'en'],
  ])('maps %s to %s', (language, expected) => {
    expect(detectLocale(language)).toBe(expected);
  });
});
