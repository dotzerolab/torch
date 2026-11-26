// @vitest-environment jsdom
import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SyncedComment, SyncedIssue } from '../sync/collections.ts';
import { manualCollection } from '../test/collections.ts';

const mocks = vi.hoisted(() => ({ collections: {} as Record<string, unknown> }));
vi.mock('../sync/shapes.ts', () => ({
  syncRegistry: { get: () => ({}), refresh: () => {} },
  useShape: (key: { kind: string }) => mocks.collections[key.kind],
}));

import { addPending, markDone, pendingFor, resetPendingForTests } from './pending.ts';
import { useIssueComments } from './useIssueComments.ts';

const comment = (id: string, created_at: string, over: Partial<SyncedComment> = {}) =>
  ({
    id,
    workspace_id: 'w1',
    team_id: 't1',
    issue_id: 'i1',
    parent_id: null,
    author_id: 'm1',
    body: `Body ${id}`,
    reactions: {},
    created_at,
    edited_at: null,
    resolved_at: null,
    resolved_by: null,
    deleted_at: null,
    ...over,
  }) satisfies SyncedComment;

function world() {
  const issues = manualCollection<SyncedIssue>('issues', (row) => row.id);
  issues.set({ id: 'i1', updated_at: 'a' } as SyncedIssue);
  issues.ready();
  const comments = manualCollection<SyncedComment>(`c-${Math.random()}`, (row) => row.id);
  mocks.collections.issues = issues.collection;
  mocks.collections.issueComments = comments.collection;
  return { issues, comments };
}

beforeEach(() => resetPendingForTests());

describe('useIssueComments', () => {
  it('is not ready before the shape answered, then lists the comments oldest first', async () => {
    const { comments } = world();
    const { result } = renderHook(() => useIssueComments('w1', 't1', 'i1'));
    expect(result.current.ready).toBe(false);
    expect(result.current.comments).toEqual([]);

    await act(async () => {
      comments.set(
        comment('c2', '2026-11-26T10:02:00Z'),
        comment('c1', '2026-11-26T10:01:00Z'),
        comment('c3', '2026-11-26T10:03:00Z'),
      );
      comments.ready();
    });
    expect(result.current.ready).toBe(true);
    expect(result.current.comments.map((c) => c.id)).toEqual(['c1', 'c2', 'c3']);
  });

  it('shows an unconfirmed write of this person on top of the rows', async () => {
    const { comments } = world();
    const { result } = renderHook(() => useIssueComments('w1', 't1', 'i1'));
    await act(async () => {
      comments.set(comment('c1', '2026-11-26T10:01:00Z'));
      comments.ready();
    });
    await act(async () => {
      addPending('i1', { kind: 'delete', commentId: 'c1', at: 'T' });
    });
    expect(result.current.comments[0]).toMatchObject({ id: 'c1', body: '', pending: true });
  });

  it('keeps the rows on screen while the refreshed shape has not answered, then shows the new ones', async () => {
    const first = world();
    const { result, rerender } = renderHook(() => useIssueComments('w1', 't1', 'i1'));
    await act(async () => {
      first.comments.set(comment('c1', '2026-11-26T10:01:00Z'));
      first.comments.ready();
    });
    expect(result.current.comments.map((c) => c.id)).toEqual(['c1']);

    // The registry replaced the instance (a refresh): the new collection is empty until it answers.
    const next = manualCollection<SyncedComment>('c-next', (row) => row.id);
    mocks.collections.issueComments = next.collection;
    await act(async () => rerender());
    expect(result.current.ready).toBe(true);
    expect(result.current.comments.map((c) => c.id)).toEqual(['c1']);

    await act(async () => {
      next.set(comment('c1', '2026-11-26T10:01:00Z'), comment('c2', '2026-11-26T10:02:00Z'));
      next.ready();
    });
    expect(result.current.comments.map((c) => c.id)).toEqual(['c1', 'c2']);
  });

  it('ends an acknowledged write once a newer instance has answered, not before', async () => {
    const first = world();
    const { rerender } = renderHook(() => useIssueComments('w1', 't1', 'i1'));
    await act(async () => {
      first.comments.set(comment('c1', '2026-11-26T10:01:00Z'));
      first.comments.ready();
    });
    const id = addPending('i1', { kind: 'delete', commentId: 'c1', at: 'T' });
    // The write was acknowledged while this instance was current.
    markDone('i1', id, first.comments.collection);
    await act(async () => rerender());
    expect(pendingFor('i1')).toHaveLength(1);

    const next = manualCollection<SyncedComment>('c-after', (row) => row.id);
    mocks.collections.issueComments = next.collection;
    await act(async () => rerender());
    expect(pendingFor('i1')).toHaveLength(1);
    await act(async () => {
      next.set(comment('c1', '2026-11-26T10:01:00Z', { deleted_at: 'T', body: '' }));
      next.ready();
    });
    expect(pendingFor('i1')).toHaveLength(0);
  });
});
