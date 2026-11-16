import { afterEach, describe, expect, it, vi } from 'vitest';
import { checkSyncHealth } from './health.ts';

const electric = { url: 'http://sync.example.test:3000', secret: 'topsecret-value' };

const answer = (body: unknown, status = 200): typeof fetch =>
  (async () => Response.json(body, { status })) as typeof fetch;

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('checkSyncHealth', () => {
  it('is disabled, without any request, when no sync service is configured', async () => {
    const fetchFn = vi.fn() as unknown as typeof fetch;

    expect(await checkSyncHealth(undefined, fetchFn)).toEqual({ status: 'disabled' });
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it('asks GET /v1/health of the sync service and is ok when it is active', async () => {
    const fetchFn = vi.fn(answer({ status: 'active' }));

    expect(await checkSyncHealth(electric, fetchFn)).toEqual({ status: 'ok' });
    expect(String(fetchFn.mock.calls[0]?.[0])).toBe('http://sync.example.test:3000/v1/health');
  });

  it.each(['waiting', 'starting'])('is an error while the sync service is "%s"', async (state) => {
    expect(await checkSyncHealth(electric, answer({ status: state }))).toEqual({
      status: 'error',
      reason: `sync service is not replicating yet (${state})`,
    });
  });

  it('is an error on a state it does not know', async () => {
    const health = await checkSyncHealth(electric, answer({ status: 'sideways' }));

    expect(health).toEqual({
      status: 'error',
      reason: 'sync service answered an unexpected state',
    });
  });

  it('is an error on a body that is not JSON', async () => {
    const fetchFn = (async () => new Response('<html>', { status: 200 })) as typeof fetch;

    expect(await checkSyncHealth(electric, fetchFn)).toEqual({
      status: 'error',
      reason: 'sync service answered an unexpected state',
    });
  });

  it('is an error, with the HTTP status only, on a non-2xx answer', async () => {
    const health = await checkSyncHealth(electric, answer({ message: 'topsecret-value' }, 500));

    expect(health).toEqual({ status: 'error', reason: 'sync service answered HTTP 500' });
  });

  it('is an error, with a category only, when the sync service cannot be reached', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    const refused = (async () => {
      throw new TypeError(
        `fetch failed: connect ECONNREFUSED http://sync.example.test:3000/?secret=topsecret-value`,
      );
    }) as typeof fetch;

    const health = await checkSyncHealth(electric, refused);

    expect(health).toEqual({ status: 'error', reason: 'sync service is unreachable' });
    expect(JSON.stringify(log.mock.calls)).not.toContain('topsecret-value');
    expect(JSON.stringify(log.mock.calls)).not.toContain('sync.example.test');
  });

  it('gives up after 2 seconds instead of hanging', async () => {
    vi.useFakeTimers();
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const hangs = ((_url: URL | string, init?: RequestInit) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () =>
          reject(new DOMException('The operation was aborted.', 'AbortError')),
        );
      })) as typeof fetch;

    const pending = checkSyncHealth(electric, hangs);
    await vi.advanceTimersByTimeAsync(2000);

    expect(await pending).toEqual({
      status: 'error',
      reason: 'sync service did not answer within 2 seconds',
    });
  });

  it('never puts the secret or the URL in the result', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const results = await Promise.all([
      checkSyncHealth(electric, answer({ status: 'waiting' })),
      checkSyncHealth(electric, answer({}, 502)),
      checkSyncHealth(electric, (async () => {
        throw new Error('boom topsecret-value http://sync.example.test:3000');
      }) as typeof fetch),
    ]);

    for (const result of results) {
      expect(JSON.stringify(result)).not.toContain('topsecret-value');
      expect(JSON.stringify(result)).not.toContain('sync.example.test');
    }
  });
});
