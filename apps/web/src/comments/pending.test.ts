import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SyncedComment } from '../sync/collections.ts';
import {
  addPending,
  applyPending,
  GIVE_UP_AFTER_MS,
  markDone,
  pendingFor,
  removePending,
  resetPendingForTests,
  settlePending,
} from './pending.ts';

const row = (id: string, over: Partial<SyncedComment> = {}): SyncedComment => ({
  id,
  workspace_id: 'w1',
  team_id: 't1',
  issue_id: 'i1',
  parent_id: null,
  author_id: 'm1',
  body: `body ${id}`,
  reactions: {},
  created_at: '2026-11-26T10:00:00Z',
  edited_at: null,
  resolved_at: null,
  resolved_by: null,
  deleted_at: null,
  ...over,
});
const create = {
  kind: 'create',
  workspaceId: 'w1',
  teamId: 't1',
  issueId: 'i1',
  body: 'Hello',
  parentId: null,
  authorId: 'm2',
  createdAt: '2026-11-26T11:00:00Z',
} as const;

beforeEach(() => resetPendingForTests());
afterEach(() => vi.useRealTimers());

describe('applyPending', () => {
  it('shows an unsent comment after the synced ones, marked pending', () => {
    addPending('i1', create);
    const view = applyPending([row('c1')], pendingFor('i1'));
    expect(view.map((c) => [c.id.startsWith('pending:') ? 'pending' : c.id, c.pending])).toEqual([
      ['c1', undefined],
      ['pending', true],
    ]);
    expect(view[1]).toMatchObject({
      body: 'Hello',
      author_id: 'm2',
      issue_id: 'i1',
      parent_id: null,
    });
  });

  it('yields to the real row once the server gave its id and the rows hold it', () => {
    const id = addPending('i1', create);
    markDone('i1', id, {}, { serverId: 'c9' });
    expect(applyPending([row('c1')], pendingFor('i1'))).toHaveLength(2);
    const view = applyPending([row('c1'), row('c9', { body: 'Hello' })], pendingFor('i1'));
    expect(view.map((c) => c.id)).toEqual(['c1', 'c9']);
  });

  it('lays an edit, a delete, a resolve and reactions over the row, and leaves the rows alone', () => {
    const rows = [row('c1', { reactions: { '👍': ['m3'] } }), row('c2')];
    addPending('i1', { kind: 'edit', commentId: 'c1', body: 'New', at: 'T' });
    addPending('i1', { kind: 'delete', commentId: 'c2', at: 'T' });
    addPending('i1', { kind: 'resolve', commentId: 'c1', resolved: true, by: 'm2', at: 'T' });
    addPending('i1', { kind: 'react', commentId: 'c1', emoji: '👍', memberId: 'm2', on: true });
    addPending('i1', { kind: 'react', commentId: 'c1', emoji: '🎉', memberId: 'm2', on: true });
    const [c1, c2] = applyPending(rows, pendingFor('i1'));
    expect(c1).toMatchObject({
      body: 'New',
      edited_at: 'T',
      resolved_at: 'T',
      resolved_by: 'm2',
      pending: true,
    });
    expect(c1?.reactions).toEqual({ '👍': ['m3', 'm2'], '🎉': ['m2'] });
    expect(c2).toMatchObject({ body: '', deleted_at: 'T', reactions: {}, pending: true });
    expect(rows[0]?.body).toBe('body c1');
    expect(rows[0]?.reactions).toEqual({ '👍': ['m3'] });
  });

  it('takes a reaction back, dropping an emoji nobody gave', () => {
    addPending('i1', { kind: 'react', commentId: 'c1', emoji: '👍', memberId: 'm3', on: false });
    const [c1] = applyPending([row('c1', { reactions: { '👍': ['m3'] } })], pendingFor('i1'));
    expect(c1?.reactions).toEqual({});
  });

  it('reopens a resolved thread', () => {
    addPending('i1', { kind: 'resolve', commentId: 'c1', resolved: false, by: 'm2', at: 'T' });
    const [c1] = applyPending(
      [row('c1', { resolved_at: 'before', resolved_by: 'm1' })],
      pendingFor('i1'),
    );
    expect(c1?.resolved_at).toBeNull();
    expect(c1?.resolved_by).toBeNull();
  });
});

describe('the pending store', () => {
  it('keeps a confirmed write until another shape instance has settled, and not for another issue', () => {
    const before = {};
    const after = {};
    const mine = addPending('i1', { kind: 'delete', commentId: 'c1', at: 'T' });
    const other = addPending('i2', { kind: 'delete', commentId: 'c7', at: 'T' });
    markDone('i1', mine, before);
    markDone('i2', other, before);

    settlePending('i1', before);
    expect(pendingFor('i1')).toHaveLength(1);
    settlePending('i1', after);
    expect(pendingFor('i1')).toHaveLength(0);
    expect(pendingFor('i2')).toHaveLength(1);
  });

  it('never ends a write the server has not answered', () => {
    addPending('i1', { kind: 'delete', commentId: 'c1', at: 'T' });
    settlePending('i1', {});
    expect(pendingFor('i1')).toHaveLength(1);
  });

  it('gives up on a confirmed write when no newer instance ever settles', () => {
    vi.useFakeTimers();
    const id = addPending('i1', { kind: 'delete', commentId: 'c1', at: 'T' });
    markDone('i1', id, {});
    vi.advanceTimersByTime(GIVE_UP_AFTER_MS - 1);
    expect(pendingFor('i1')).toHaveLength(1);
    vi.advanceTimersByTime(1);
    expect(pendingFor('i1')).toHaveLength(0);
  });

  it('removing a write that is gone is quiet', () => {
    expect(() => removePending('i1', 99)).not.toThrow();
  });
});
