// @vitest-environment jsdom
import { FetchError, ShapeStream } from '@electric-sql/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../api.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../api.ts')>()),
  apiFetch: vi.fn(),
}));

import {
  BACKOFF_OPTIONS,
  handleShapeError,
  observeSync,
  sendIssueMutations,
} from './collections.ts';
import type { OutboxWrite } from './outbox.ts';
import { markSigningOut, resetSigningOut } from './signing-out.ts';

const actions = () => ({ signIn: vi.fn(), dropTeam: vi.fn() });
const fetchError = (status: number) =>
  new FetchError(status, undefined, undefined, {}, 'http://x/', '');

describe('handleShapeError', () => {
  it('sends a 401 to sign-in', () => {
    const a = actions();
    handleShapeError(fetchError(401), { workspaceId: 'w' }, a);
    expect(a.signIn).toHaveBeenCalledOnce();
    expect(a.dropTeam).not.toHaveBeenCalled();
  });

  it('does not send the page to sign-in on a 401 while it signs the person out', () => {
    markSigningOut();
    try {
      const a = actions();
      handleShapeError(fetchError(401), { workspaceId: 'w' }, a);
      expect(a.signIn).not.toHaveBeenCalled();
    } finally {
      resetSigningOut();
    }
  });

  it('drops the team on a 404 of a team-scoped shape', () => {
    const a = actions();
    handleShapeError(fetchError(404), { workspaceId: 'w', teamId: 't' }, a);
    expect(a.dropTeam).toHaveBeenCalledWith('w', 't');
  });

  it('does not drop anything on a 404 of a workspace-scoped shape, and ignores other errors', () => {
    const a = actions();
    handleShapeError(fetchError(404), { workspaceId: 'w' }, a);
    handleShapeError(fetchError(400), { workspaceId: 'w', teamId: 't' }, a);
    handleShapeError(new Error('boom'), { workspaceId: 'w', teamId: 't' }, a);
    expect(a.signIn).not.toHaveBeenCalled();
    expect(a.dropTeam).not.toHaveBeenCalled();
  });
});

describe('429 and 5xx', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('429 waits Retry-After before the client asks again', async () => {
    const upToDate = () =>
      new Response(JSON.stringify([{ headers: { control: 'up-to-date' } }]), {
        status: 200,
        headers: {
          'electric-handle': 'h1',
          'electric-offset': '0_0',
          'electric-schema': '{}',
          'content-type': 'application/json',
        },
      });
    const fetchClient = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response('', { status: 429, headers: { 'retry-after': '1' } }))
      .mockImplementation(async () => upToDate());
    const onError = vi.fn();
    const stream = new ShapeStream({
      url: 'http://localhost/api/sync/w/x/teams',
      fetchClient,
      backoffOptions: { ...BACKOFF_OPTIONS },
      onError,
      subscribe: false,
    });
    const unsubscribe = stream.subscribe(() => {});
    await vi.advanceTimersByTimeAsync(0);
    expect(fetchClient).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(990);
    expect(fetchClient).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(31_000);
    expect(fetchClient.mock.calls.length).toBeGreaterThanOrEqual(2);
    // The throttling never reached the error policy: the client's own backoff absorbed it.
    expect(onError).not.toHaveBeenCalled();
    unsubscribe();
  });
});

describe('sendIssueMutations (M9)', () => {
  const queued = () =>
    vi.fn<(write: OutboxWrite) => Promise<{ txid: number }>>().mockResolvedValue({ txid: 0 });

  it('queues one PATCH per mutation in order and awaits every txid', async () => {
    const enqueue = queued();
    enqueue.mockResolvedValueOnce({ txid: 11 }).mockResolvedValueOnce({ txid: 12 });
    const awaitTxId = vi.fn().mockResolvedValue(true);
    await sendIssueMutations(
      'w1',
      't1',
      [
        { key: 'i1', changes: { title: 'One' } },
        { key: 'i2', changes: { priority: 2 } },
      ],
      awaitTxId,
      enqueue,
    );
    expect(enqueue.mock.calls.map(([w]) => w.path)).toEqual([
      '/api/w/w1/issues/i1',
      '/api/w/w1/issues/i2',
    ]);
    expect(enqueue.mock.calls.map(([w]) => [w.method, w.workspaceId, w.teamId])).toEqual([
      ['PATCH', 'w1', 't1'],
      ['PATCH', 'w1', 't1'],
    ]);
    expect(enqueue.mock.calls[1]?.[0].body).toEqual({ priority: 2 });
    // Each write has its own key, made once here (the outbox keeps it on every replay).
    const keys = enqueue.mock.calls.map(([w]) => w.idempotencyKey);
    expect(new Set(keys).size).toBe(2);
    expect(awaitTxId.mock.calls.map(([txid]) => txid)).toEqual([11, 12]);
  });

  it('stops at the first refused write and awaits nothing', async () => {
    const enqueue = queued();
    enqueue.mockRejectedValueOnce(new Error('refused'));
    const awaitTxId = vi.fn();
    await expect(
      sendIssueMutations(
        'w1',
        't1',
        [
          { key: 'i1', changes: { title: 'A' } },
          { key: 'i2', changes: { title: 'B' } },
        ],
        awaitTxId,
        enqueue,
      ),
    ).rejects.toThrow('refused');
    expect(enqueue).toHaveBeenCalledTimes(1);
    expect(awaitTxId).not.toHaveBeenCalled();
  });
});

describe('observeSync', () => {
  /** A sync like the electric one: it reports ready after every answer and truncates on a must-refetch. */
  function fakeSync(result: unknown) {
    const seen: { params?: Parameters<ReturnType<typeof build>['sync']['sync']>[0] } = {};
    const build = () => ({
      id: 'c',
      sync: {
        getSyncMetadata: () => ({ relation: undefined }),
        sync: (params: { markReady: () => void; truncate: () => void; collection: unknown }) => {
          seen.params = params;
          return result;
        },
      },
    });
    return { build, seen };
  }
  const hooks = () => ({ settled: vi.fn(), truncated: vi.fn(), cleanup: vi.fn() });

  it('reports every markReady after the library took it, with the collection', () => {
    const { build, seen } = fakeSync(undefined);
    const h = hooks();
    const order: string[] = [];
    h.settled.mockImplementation(() => order.push('settled'));
    const observed = observeSync(build(), h);
    const collection = { keys: () => ['a'] };
    const markReady = vi.fn(() => order.push('markReady'));
    (observed.sync as { sync: (params: unknown) => unknown }).sync({
      markReady,
      truncate: vi.fn(),
      collection,
    });
    seen.params?.markReady();
    seen.params?.markReady();
    expect(order).toEqual(['markReady', 'settled', 'markReady', 'settled']);
    expect(h.settled).toHaveBeenCalledWith(collection);
  });

  it('reports a truncate and still truncates', () => {
    const { build, seen } = fakeSync(undefined);
    const h = hooks();
    const observed = observeSync(build(), h);
    const truncate = vi.fn();
    (observed.sync as { sync: (params: unknown) => unknown }).sync({
      markReady: vi.fn(),
      truncate,
      collection: {},
    });
    seen.params?.truncate();
    expect(truncate).toHaveBeenCalledOnce();
    expect(h.truncated).toHaveBeenCalledOnce();
  });

  it('keeps the other parts of the sync, and runs both cleanups (object result)', () => {
    const cleanup = vi.fn();
    const loadSubset = vi.fn();
    const { build } = fakeSync({ cleanup, loadSubset });
    const h = hooks();
    const observed = observeSync(build(), h);
    expect((observed.sync as { getSyncMetadata: unknown }).getSyncMetadata).toBeTypeOf('function');
    const result = (observed.sync as { sync: (params: unknown) => unknown }).sync({
      markReady: vi.fn(),
      truncate: vi.fn(),
      collection: {},
    }) as { cleanup: () => void; loadSubset: unknown };
    expect(result.loadSubset).toBe(loadSubset);
    result.cleanup();
    expect(h.cleanup).toHaveBeenCalledOnce();
    expect(cleanup).toHaveBeenCalledOnce();
  });

  it('runs both cleanups for a sync that returns a function, and for one that returns nothing', () => {
    const cleanup = vi.fn();
    const fnResult = fakeSync(cleanup);
    const h1 = hooks();
    const run = (o: ReturnType<typeof observeSync>) =>
      (o.sync as { sync: (params: unknown) => unknown }).sync({
        markReady: vi.fn(),
        truncate: vi.fn(),
        collection: {},
      });
    (run(observeSync(fnResult.build(), h1)) as () => void)();
    expect(h1.cleanup).toHaveBeenCalledOnce();
    expect(cleanup).toHaveBeenCalledOnce();
    const h2 = hooks();
    (run(observeSync(fakeSync(undefined).build(), h2)) as { cleanup: () => void }).cleanup();
    expect(h2.cleanup).toHaveBeenCalledOnce();
  });
});
