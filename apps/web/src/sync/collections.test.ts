// @vitest-environment jsdom
import { FetchError, ShapeStream } from '@electric-sql/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../api.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../api.ts')>()),
  apiFetch: vi.fn(),
}));

import { apiFetch } from '../api.ts';
import { BACKOFF_OPTIONS, handleShapeError, sendIssueMutations } from './collections.ts';

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
  it('sends one PATCH per mutation in order and awaits every txid', async () => {
    const api = vi.mocked(apiFetch);
    api.mockReset();
    api.mockResolvedValueOnce({ txid: 11 }).mockResolvedValueOnce({ txid: 12 });
    const awaitTxId = vi.fn().mockResolvedValue(true);
    await sendIssueMutations(
      'w1',
      [
        { key: 'i1', changes: { title: 'One' } },
        { key: 'i2', changes: { priority: 2 } },
      ],
      awaitTxId,
    );
    expect(api.mock.calls.map(([path]) => path)).toEqual([
      '/api/w/w1/issues/i1',
      '/api/w/w1/issues/i2',
    ]);
    expect(JSON.parse(String(api.mock.calls[1]?.[1]?.body))).toEqual({ priority: 2 });
    expect(awaitTxId.mock.calls.map(([txid]) => txid)).toEqual([11, 12]);
  });

  it('stops at the first refused write and awaits nothing', async () => {
    const api = vi.mocked(apiFetch);
    api.mockReset();
    api.mockRejectedValueOnce(new Error('refused'));
    const awaitTxId = vi.fn();
    await expect(
      sendIssueMutations(
        'w1',
        [
          { key: 'i1', changes: { title: 'A' } },
          { key: 'i2', changes: { title: 'B' } },
        ],
        awaitTxId,
      ),
    ).rejects.toThrow('refused');
    expect(api).toHaveBeenCalledTimes(1);
    expect(awaitTxId).not.toHaveBeenCalled();
  });
});
