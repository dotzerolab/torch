import { describe, expect, it } from 'vitest';
import { issueCreateInput, issueUpdateInput } from './issue.ts';

const ID = '3f2b8c1e-9d4a-4e6b-8a7c-1b2d3e4f5a6b';

describe('issueUpdateInput', () => {
  it('accepts each updatable field on its own', () => {
    expect(issueUpdateInput.safeParse({ title: 'Fix login' }).success).toBe(true);
    expect(issueUpdateInput.safeParse({ priority: 0 }).success).toBe(true);
    expect(issueUpdateInput.safeParse({ priority: 4 }).success).toBe(true);
    expect(issueUpdateInput.safeParse({ stateId: ID }).success).toBe(true);
    expect(issueUpdateInput.safeParse({ assigneeId: ID }).success).toBe(true);
    // null un-assigns.
    expect(issueUpdateInput.safeParse({ assigneeId: null }).success).toBe(true);
  });

  it('accepts several fields at once and returns them typed', () => {
    const parsed = issueUpdateInput.parse({
      title: 'A',
      priority: 2,
      stateId: ID,
      assigneeId: null,
    });

    expect(parsed).toEqual({ title: 'A', priority: 2, stateId: ID, assigneeId: null });
  });

  it('trims the title and rejects an empty or too long one', () => {
    expect(issueUpdateInput.parse({ title: '  Fix login  ' })).toEqual({ title: 'Fix login' });
    expect(issueUpdateInput.safeParse({ title: '   ' }).success).toBe(false);
    expect(issueUpdateInput.safeParse({ title: '' }).success).toBe(false);
    expect(issueUpdateInput.safeParse({ title: 'x'.repeat(255) }).success).toBe(true);
    expect(issueUpdateInput.safeParse({ title: 'x'.repeat(256) }).success).toBe(false);
  });

  it('priority is an integer from 0 to 4', () => {
    for (const bad of [-1, 5, 1.5, '2', null, Number.NaN]) {
      expect(issueUpdateInput.safeParse({ priority: bad }).success, String(bad)).toBe(false);
    }
  });

  it('ids must be uuids', () => {
    expect(issueUpdateInput.safeParse({ stateId: 'not-a-uuid' }).success).toBe(false);
    expect(issueUpdateInput.safeParse({ stateId: null }).success).toBe(false);
    expect(issueUpdateInput.safeParse({ assigneeId: '1234' }).success).toBe(false);
  });

  it('is strict: unknown fields, among them description and protected columns, are rejected', () => {
    for (const field of ['workspaceId', 'teamId', 'number', 'creatorId', 'archivedAt']) {
      const result = issueUpdateInput.safeParse({ title: 'ok', [field]: 'x' });
      expect(result.success, field).toBe(false);
    }
  });

  it('takes every field an issue can change, labels as add and remove lists', () => {
    const parsed = issueUpdateInput.parse({
      description: 'Body',
      estimate: null,
      dueDate: '2026-12-31',
      parentId: ID.toUpperCase(),
      sortOrder: -2.5,
      addLabelIds: [ID],
      removeLabelIds: [ID],
    });
    expect(parsed.parentId).toBe(ID);
    expect(issueUpdateInput.safeParse({ dueDate: '2026-02-30' }).success).toBe(false);
    expect(issueUpdateInput.safeParse({ estimate: 65 }).success).toBe(false);
    expect(issueUpdateInput.safeParse({ addLabelIds: ['x'] }).success).toBe(false);
    expect(issueUpdateInput.safeParse({ description: 'x'.repeat(100_001) }).success).toBe(false);
    expect(issueUpdateInput.safeParse({ sortOrder: Number.POSITIVE_INFINITY }).success).toBe(false);
    for (const field of ['teamId', 'externalRef', 'subscriberIds', 'links', 'labelIds']) {
      expect(issueUpdateInput.safeParse({ title: 'ok', [field]: ID }).success, field).toBe(false);
    }
  });

  it('needs at least one field', () => {
    expect(issueUpdateInput.safeParse({}).success).toBe(false);
    expect(issueUpdateInput.safeParse({ title: undefined }).success).toBe(false);
  });

  it('rejects non-objects', () => {
    for (const bad of [null, 'title', 3, [], [{ title: 'x' }]]) {
      expect(issueUpdateInput.safeParse(bad).success, JSON.stringify(bad)).toBe(false);
    }
  });
});

describe('issueCreateInput', () => {
  const minimal = { teamId: ID, title: 'Fix login' };

  it('needs a team and a title and nothing else', () => {
    expect(issueCreateInput.safeParse(minimal).success).toBe(true);
    expect(issueCreateInput.safeParse({ title: 'No team' }).success).toBe(false);
    expect(issueCreateInput.safeParse({ teamId: ID }).success).toBe(false);
    expect(issueCreateInput.safeParse({ teamId: ID, title: '   ' }).success).toBe(false);
    expect(issueCreateInput.safeParse({ teamId: 'not-a-uuid', title: 'X' }).success).toBe(false);
  });

  it('accepts every field of an issue in one call', () => {
    const parsed = issueCreateInput.parse({
      ...minimal,
      description: '# Heading\n\nBody',
      stateId: ID,
      priority: 2,
      estimate: 5,
      assigneeId: ID,
      labelIds: [ID],
      dueDate: '2026-12-31',
      parentId: ID,
      subscriberIds: [ID],
      links: [{ url: 'https://example.test/a', title: 'Spec' }, { url: 'http://example.test/b' }],
      sortOrder: -3.5,
      externalRef: { source: 'tracker', id: 'REQ-1', url: 'https://example.test/r/1' },
    });
    expect(parsed.externalRef).toEqual({
      source: 'tracker',
      id: 'REQ-1',
      url: 'https://example.test/r/1',
    });
    expect(parsed.links).toHaveLength(2);
  });

  it('lower-cases ids and trims the title', () => {
    const parsed = issueCreateInput.parse({
      teamId: ID.toUpperCase(),
      title: '  Padded  ',
      labelIds: [ID.toUpperCase()],
    });
    expect(parsed.teamId).toBe(ID);
    expect(parsed.title).toBe('Padded');
    expect(parsed.labelIds).toEqual([ID]);
  });

  it('refuses unknown keys, so a protected column is never set by accident', () => {
    for (const key of ['number', 'creatorId', 'workspaceId', 'archivedAt', 'startedAt']) {
      expect(issueCreateInput.safeParse({ ...minimal, [key]: ID }).success, key).toBe(false);
    }
  });

  it.each([
    ['priority 5', { priority: 5 }],
    ['priority 1.5', { priority: 1.5 }],
    ['estimate -1', { estimate: -1 }],
    ['estimate 65', { estimate: 65 }],
    ['title over 255', { title: 'x'.repeat(256) }],
    ['description over 100000', { description: 'x'.repeat(100_001) }],
    ['due date with a time', { dueDate: '2026-12-31T10:00:00Z' }],
    ['due date that does not exist', { dueDate: '2026-02-30' }],
    ['label that is not an id', { labelIds: ['x'] }],
    ['more than 50 labels', { labelIds: Array.from({ length: 51 }, () => ID) }],
    [
      'more than 20 links',
      { links: Array.from({ length: 21 }, () => ({ url: 'https://e.test/' })) },
    ],
    ['sort order NaN', { sortOrder: Number.NaN }],
    ['sort order infinite', { sortOrder: Number.POSITIVE_INFINITY }],
  ])('refuses %s', (_name, patch) => {
    expect(issueCreateInput.safeParse({ ...minimal, ...patch }).success).toBe(false);
  });

  it.each([
    'javascript:alert(1)',
    'data:text/html,hi',
    'ftp://example.test/file',
    'file:///etc/passwd',
    'example.test/no-scheme',
    'https://',
    `https://example.test/${'a'.repeat(2048)}`,
  ])('refuses the link %s', (url) => {
    expect(issueCreateInput.safeParse({ ...minimal, links: [{ url }] }).success).toBe(false);
    expect(
      issueCreateInput.safeParse({ ...minimal, externalRef: { source: 'x', id: '1', url } })
        .success,
    ).toBe(false);
  });

  it.each([
    ['Upper', 'REQ-1'],
    ['-leading', 'REQ-1'],
    ['has space', 'REQ-1'],
    ['a'.repeat(65), 'REQ-1'],
    ['tracker', ''],
    ['tracker', 'x'.repeat(256)],
  ])('refuses the external reference %s / %s', (source, id) => {
    expect(issueCreateInput.safeParse({ ...minimal, externalRef: { source, id } }).success).toBe(
      false,
    );
  });
});
