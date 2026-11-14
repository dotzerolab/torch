import { describe, expect, it } from 'vitest';
import { ApiError } from './api.ts';
import { mutationErrorMessage } from './errors.ts';

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
