import { describe, expect, it } from 'vitest';
import { issueUpdateInput } from './issue.ts';

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
    for (const field of [
      'description',
      'workspaceId',
      'teamId',
      'number',
      'creatorId',
      'archivedAt',
    ]) {
      const result = issueUpdateInput.safeParse({ title: 'ok', [field]: 'x' });
      expect(result.success, field).toBe(false);
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
