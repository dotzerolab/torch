import { describe, expect, it } from 'vitest';
import {
  documentCreateInput,
  documentUpdateInput,
  MAX_DOCUMENT_LENGTH,
  MAX_DOCUMENT_TITLE_LENGTH,
} from './document.ts';

const TEAM = '3f2b8c1e-9d4a-4e6b-8a7c-1b2d3e4f5a6b';

describe('documentCreateInput', () => {
  it('trims the title and leaves the body as typed', () => {
    const parsed = documentCreateInput.parse({
      teamId: TEAM,
      title: '  Runbook ',
      body: ' text\n',
    });

    expect(parsed).toEqual({ teamId: TEAM, title: 'Runbook', body: ' text\n' });
  });

  it('works without a body', () => {
    expect(documentCreateInput.safeParse({ teamId: TEAM, title: 'Notes' }).success).toBe(true);
  });

  it('wants a title of 1..255 characters after trimming', () => {
    expect(documentCreateInput.safeParse({ teamId: TEAM, title: '   ' }).success).toBe(false);
    expect(
      documentCreateInput.safeParse({ teamId: TEAM, title: 'a'.repeat(MAX_DOCUMENT_TITLE_LENGTH) })
        .success,
    ).toBe(true);
    expect(
      documentCreateInput.safeParse({
        teamId: TEAM,
        title: 'a'.repeat(MAX_DOCUMENT_TITLE_LENGTH + 1),
      }).success,
    ).toBe(false);
    expect(MAX_DOCUMENT_TITLE_LENGTH).toBe(255);
  });

  it('caps the body at 100,000 characters', () => {
    expect(MAX_DOCUMENT_LENGTH).toBe(100_000);
    expect(
      documentCreateInput.safeParse({ teamId: TEAM, title: 'x', body: 'a'.repeat(100_000) })
        .success,
    ).toBe(true);
    expect(
      documentCreateInput.safeParse({ teamId: TEAM, title: 'x', body: 'a'.repeat(100_001) })
        .success,
    ).toBe(false);
  });

  it('refuses an unknown key and a team that is not a guid', () => {
    expect(
      documentCreateInput.safeParse({ teamId: TEAM, title: 'x', createdBy: TEAM }).success,
    ).toBe(false);
    expect(documentCreateInput.safeParse({ teamId: 'ENG', title: 'x' }).success).toBe(false);
  });
});

describe('documentUpdateInput', () => {
  it('takes a title, a body or both', () => {
    expect(documentUpdateInput.parse({ title: ' New ' })).toEqual({ title: 'New' });
    expect(documentUpdateInput.parse({ body: '' })).toEqual({ body: '' });
    expect(documentUpdateInput.safeParse({ title: 'a', body: 'b' }).success).toBe(true);
  });

  it('refuses an update with no key and one with only undefined values', () => {
    expect(documentUpdateInput.safeParse({}).success).toBe(false);
    expect(documentUpdateInput.safeParse({ title: undefined }).success).toBe(false);
  });

  it('refuses an empty title, an oversize body and an unknown key', () => {
    expect(documentUpdateInput.safeParse({ title: ' ' }).success).toBe(false);
    expect(documentUpdateInput.safeParse({ body: 'a'.repeat(100_001) }).success).toBe(false);
    expect(documentUpdateInput.safeParse({ teamId: TEAM }).success).toBe(false);
  });
});
