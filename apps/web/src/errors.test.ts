import { LOCALES, t } from '@torch/shared/i18n';
import { ADMIN_ERROR_CODES } from '@torch/shared/mutations/admin';
import { describe, expect, it } from 'vitest';
import { ApiError } from './api.ts';
import { adminErrorMessage, adminFailureMessage, mutationErrorMessage } from './errors.ts';

const CODES = [
  'unauthenticated',
  'not_found',
  'forbidden',
  'invalid_input',
  'invalid_state',
  'invalid_assignee',
] as const;

describe('mutationErrorMessage', () => {
  it.each(CODES)('shows a translated text for the server code %s, not the server text', (code) => {
    const error = new ApiError(400, code, 'developer text');

    const en = mutationErrorMessage('en', error);
    const it_ = mutationErrorMessage('it', error);

    expect(en).not.toBe('developer text');
    expect(it_).not.toBe('developer text');
    expect(it_).not.toBe(en);
    expect(en).not.toMatch(/^mutation\.error\./);
  });

  it('says the server could not be reached when there was no answer', () => {
    expect(mutationErrorMessage('en', new ApiError(0, 'network', 'x'))).toBe(
      'Could not reach the server. Your change was not saved.',
    );
  });

  it('falls back to the server text for a code it does not know', () => {
    expect(mutationErrorMessage('en', new ApiError(409, 'something_new', 'Try later.'))).toBe(
      'Try later.',
    );
  });

  it('shows a generic text for anything that is not an API error', () => {
    expect(mutationErrorMessage('en', new Error('boom'))).toBe('The change could not be saved.');
  });
});

describe('adminErrorMessage', () => {
  const ALL_KEYS = [
    ...ADMIN_ERROR_CODES.map((code) => `admin.error.${code}`),
    'admin.error.network',
    'admin.error.unknown',
  ];

  it.each(LOCALES.flatMap((locale) => ALL_KEYS.map((key) => [locale, key] as const)))(
    'has a text for %s %s',
    (locale, key) => {
      const text = t(locale, key);
      expect(text).not.toBe(key);
      expect(text.trim()).not.toBe('');
    },
  );

  it.each(ADMIN_ERROR_CODES)('translates %s: the text exists in EN and IT and differs', (code) => {
    const en = adminErrorMessage('en', code);
    const it_ = adminErrorMessage('it', code);
    expect(en).toBe(t('en', `admin.error.${code}`));
    expect(it_).toBe(t('it', `admin.error.${code}`));
    expect(it_).not.toBe(en);
  });
});

describe('adminFailureMessage', () => {
  it('turns a known server code into its translated text, ignoring the server text', () => {
    const error = new ApiError(409, 'last_owner', 'developer text');
    expect(adminFailureMessage('en', error)).toBe('A workspace needs at least one active owner.');
  });

  it('says the server could not be reached when there was no answer', () => {
    expect(adminFailureMessage('en', new ApiError(0, 'network', 'x'))).toBe(
      'Could not reach the server. Nothing was changed.',
    );
  });

  it('shows the server text for a code it does not know, and a generic one for anything else', () => {
    expect(adminFailureMessage('en', new ApiError(500, 'something_new', 'Try later.'))).toBe(
      'Try later.',
    );
    expect(adminFailureMessage('en', new Error('boom'))).toBe('The change could not be saved.');
  });
});
