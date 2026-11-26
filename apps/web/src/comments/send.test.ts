import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../api.ts';
import type { OutboxWrite } from '../sync/outbox.ts';
import { pendingFor, resetPendingForTests } from './pending.ts';

vi.mock('../sync/shapes.ts', () => ({ syncRegistry: {}, useShape: () => ({}) }));

import {
  deleteComment,
  editComment,
  sendComment,
  setReaction,
  setResolved,
  type WriteContext,
  type WriteDeps,
} from './send.ts';

const ctx: WriteContext = { workspaceId: 'w1', teamId: 't1', memberId: 'm2' };
const instance = {};

function deps(over: Partial<WriteDeps> = {}) {
  const writes: OutboxWrite[] = [];
  const made: WriteDeps = {
    enqueue: vi.fn(async (write: OutboxWrite) => {
      writes.push(write);
      return { txid: 7, comment: { id: 'c-server' } } as { txid: number };
    }),
    refresh: vi.fn(() => instance),
    now: () => '2026-11-26T11:00:00Z',
    newKey: () => 'key-1',
    ...over,
  };
  return { made, writes };
}

beforeEach(() => resetPendingForTests());
afterEach(() => vi.useRealTimers());

describe('sendComment', () => {
  it('queues a POST with an Idempotency-Key, shows the comment before the server answers, then reads the shape again', async () => {
    let answer!: (value: { txid: number }) => void;
    const { made, writes } = deps({
      enqueue: vi.fn((write: OutboxWrite) => {
        writes.push(write);
        return new Promise<{ txid: number }>((resolve) => {
          answer = resolve;
        });
      }),
    });
    const sent = sendComment(ctx, { issueId: 'i1', body: '  Hello  ' }, made);
    await vi.waitFor(() => expect(writes).toHaveLength(1));

    expect(writes[0]).toEqual({
      workspaceId: 'w1',
      teamId: 't1',
      idempotencyKey: 'key-1',
      method: 'POST',
      path: '/api/w/w1/issues/i1/comments',
      body: { body: 'Hello' },
    });
    expect(pendingFor('i1')).toHaveLength(1);
    expect(made.refresh).not.toHaveBeenCalled();

    answer({ txid: 7, comment: { id: 'c-server' } } as { txid: number });
    await sent;
    expect(made.refresh).toHaveBeenCalledWith(ctx, 'i1');
    const [entry] = pendingFor('i1');
    expect(entry?.doneOn).toBe(instance);
    expect(entry?.op).toMatchObject({ kind: 'create', serverId: 'c-server', body: 'Hello' });
  });

  it('carries the parent of a reply', async () => {
    const { made, writes } = deps();
    const parent = '2c6bccd5-9fdc-4eb7-8d50-f2e19358a8b9';
    await sendComment(ctx, { issueId: 'i1', body: 'Re', parentId: parent }, made);
    expect(writes[0]?.body).toEqual({ body: 'Re', parentId: parent });
  });

  it('a refused write rolls the overlay back and rejects with the server code', async () => {
    const { made } = deps({
      enqueue: vi.fn(async () => {
        throw new ApiError(409, 'issue_archived', 'An archived issue cannot be changed.');
      }),
    });
    await expect(sendComment(ctx, { issueId: 'i1', body: 'Hi' }, made)).rejects.toMatchObject({
      status: 409,
      code: 'issue_archived',
    });
    expect(pendingFor('i1')).toHaveLength(0);
    expect(made.refresh).not.toHaveBeenCalled();
  });

  it('a 403 rolls back too', async () => {
    const { made } = deps({
      enqueue: vi.fn(async () => {
        throw new ApiError(403, 'forbidden', 'no');
      }),
    });
    await expect(sendComment(ctx, { issueId: 'i1', body: 'Hi' }, made)).rejects.toMatchObject({
      status: 403,
    });
    expect(pendingFor('i1')).toHaveLength(0);
  });

  it('a comment written offline is queued once and stays on screen until it is sent', async () => {
    let answer!: (value: { txid: number }) => void;
    const enqueue = vi.fn(
      () =>
        new Promise<{ txid: number }>((resolve) => {
          answer = resolve;
        }),
    );
    const { made } = deps({ enqueue });
    const sent = sendComment(ctx, { issueId: 'i1', body: 'Later' }, made);
    await vi.waitFor(() => expect(enqueue).toHaveBeenCalledTimes(1));
    expect(pendingFor('i1')).toHaveLength(1);
    expect(pendingFor('i1')[0]?.doneOn).toBeNull();

    answer({ txid: 9, comment: { id: 'c-later' } } as { txid: number });
    await sent;
    expect(enqueue).toHaveBeenCalledTimes(1);
    expect(pendingFor('i1')[0]?.op).toMatchObject({ serverId: 'c-later' });
  });

  it('refuses a blank or oversized comment before it is queued', async () => {
    const { made } = deps();
    await expect(sendComment(ctx, { issueId: 'i1', body: '   ' }, made)).rejects.toMatchObject({
      code: 'invalid_input',
    });
    await expect(
      sendComment(ctx, { issueId: 'i1', body: 'x'.repeat(20_001) }, made),
    ).rejects.toMatchObject({ code: 'invalid_input' });
    expect(made.enqueue).not.toHaveBeenCalled();
    expect(pendingFor('i1')).toHaveLength(0);
  });
});

describe('the other comment writes', () => {
  it('edit is a PATCH with the trimmed body', async () => {
    const { made, writes } = deps();
    await editComment(ctx, { issueId: 'i1', commentId: 'c1', body: ' Better ' }, made);
    expect(writes[0]).toMatchObject({
      method: 'PATCH',
      path: '/api/w/w1/comments/c1',
      body: { body: 'Better' },
    });
    expect(pendingFor('i1')[0]?.op).toMatchObject({
      kind: 'edit',
      commentId: 'c1',
      body: 'Better',
    });
  });

  it('delete is a DELETE', async () => {
    const { made, writes } = deps();
    await deleteComment(ctx, { issueId: 'i1', commentId: 'c1' }, made);
    expect(writes[0]).toMatchObject({ method: 'DELETE', path: '/api/w/w1/comments/c1' });
  });

  it('resolve and reopen are POSTs to their own routes', async () => {
    const { made, writes } = deps();
    await setResolved(ctx, { issueId: 'i1', commentId: 'c1', resolved: true }, made);
    await setResolved(ctx, { issueId: 'i1', commentId: 'c1', resolved: false }, made);
    expect(writes.map((w) => [w.method, w.path])).toEqual([
      ['POST', '/api/w/w1/comments/c1/resolve'],
      ['POST', '/api/w/w1/comments/c1/unresolve'],
    ]);
  });

  it('a reaction is a PUT, taken back a DELETE, with the emoji in the address', async () => {
    const { made, writes } = deps();
    await setReaction(ctx, { issueId: 'i1', commentId: 'c1', emoji: '👍', on: true }, made);
    await setReaction(ctx, { issueId: 'i1', commentId: 'c1', emoji: '👍', on: false }, made);
    const path = `/api/w/w1/comments/c1/reactions/${encodeURIComponent('👍')}`;
    expect(writes.map((w) => [w.method, w.path])).toEqual([
      ['PUT', path],
      ['DELETE', path],
    ]);
  });

  it('refuses an emoji outside the fixed set', async () => {
    const { made } = deps();
    await expect(
      setReaction(ctx, { issueId: 'i1', commentId: 'c1', emoji: '🦄', on: true }, made),
    ).rejects.toMatchObject({ code: 'invalid_input' });
    expect(made.enqueue).not.toHaveBeenCalled();
  });
});
