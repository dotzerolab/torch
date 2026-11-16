import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../api.ts';
import {
  createOutbox,
  memoryStorage,
  OUTBOX_BACKOFF,
  type OutboxWrite,
  WriteDropped,
} from './outbox.ts';
import { runSignOut } from './sign-out.ts';

const WS = '11111111-1111-4111-8111-111111111111';
const TEAM = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

const write = (n: number, extra: Partial<OutboxWrite> = {}): OutboxWrite => ({
  workspaceId: WS,
  teamId: TEAM,
  method: 'PATCH',
  path: `/api/w/${WS}/issues/${n}`,
  body: { title: `edit ${n}` },
  idempotencyKey: `key-${n}`,
  ...extra,
});

/** A server that is offline until `goOnline()`, and the pause the outbox takes between tries. */
function network() {
  let online = false;
  const sent: OutboxWrite[] = [];
  const naps: Array<() => void> = [];
  return {
    sent,
    send: async (w: OutboxWrite) => {
      if (!online) throw new ApiError(0, 'network', 'The server could not be reached.');
      sent.push(w);
      return { txid: sent.length };
    },
    sleep: (_ms: number) => new Promise<void>((resolve) => naps.push(resolve)),
    goOnline() {
      online = true;
      for (const wake of naps.splice(0)) wake();
    },
  };
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));
afterEach(() => vi.unstubAllGlobals());

describe('outbox', () => {
  it('announces a queued write only once it is saved on the device', async () => {
    const net = network();
    const storage = memoryStorage();
    let finishSave: () => void = () => {};
    const slow = {
      ...storage,
      save: (workspaceId: string, writes: OutboxWrite[]) =>
        new Promise<void>((resolve) => {
          finishSave = () => resolve(storage.save(workspaceId, writes));
        }),
    };
    const box = createOutbox({ storage: slow, send: net.send, sleep: net.sleep });
    await box.resume(WS);
    const heard = vi.fn();
    box.subscribe(heard);
    void box.enqueueWrite(write(1)).catch(() => {});
    await flush();
    expect(heard).not.toHaveBeenCalled();
    finishSave();
    await flush();
    expect(heard).toHaveBeenCalled();
  });

  it('three offline edits replay in order on reconnect', async () => {
    const net = network();
    const box = createOutbox({ storage: memoryStorage(), send: net.send, sleep: net.sleep });
    const done = [1, 2, 3].map((n) => box.enqueueWrite(write(n)));
    await flush();
    expect(box.pendingCount(WS)).toBe(3);
    expect(net.sent).toEqual([]);

    net.goOnline();
    const results = await Promise.all(done);

    expect(net.sent.map((w) => w.idempotencyKey)).toEqual(['key-1', 'key-2', 'key-3']);
    expect(results.map((r) => r.txid)).toEqual([1, 2, 3]);
    expect(box.pendingCount(WS)).toBe(0);
  });

  it('same Idempotency-Key on replay', async () => {
    const calls: Array<{ key: string | null; path: string }> = [];
    let attempts = 0;
    vi.stubGlobal('fetch', async (path: string, init: RequestInit) => {
      calls.push({ key: new Headers(init.headers).get('idempotency-key'), path });
      attempts += 1;
      if (attempts < 3) throw new TypeError('Failed to fetch');
      return new Response(JSON.stringify({ txid: 9 }), { status: 200 });
    });
    const box = createOutbox({ storage: memoryStorage(), sleep: async () => {} });

    await expect(box.enqueueWrite(write(1))).resolves.toEqual({ txid: 9 });

    expect(calls).toHaveLength(3);
    expect(new Set(calls.map((c) => c.key))).toEqual(new Set(['key-1']));
  });

  it('waits with the same backoff as the shape client between tries', async () => {
    const waits: number[] = [];
    let attempts = 0;
    const box = createOutbox({
      storage: memoryStorage(),
      send: async () => {
        attempts += 1;
        if (attempts <= 7) throw new ApiError(503, 'unavailable', 'Try again.');
        return { txid: 1 };
      },
      sleep: async (ms) => {
        waits.push(ms);
      },
    });
    await box.enqueueWrite(write(1));
    expect(waits).toEqual([1000, 2000, 4000, 8000, 16_000, 30_000, 30_000]);
    expect(OUTBOX_BACKOFF.maxDelay).toBe(30_000);
  });

  it('4xx rolls back with message', async () => {
    const dropped: string[] = [];
    const sent: string[] = [];
    const box = createOutbox({
      storage: memoryStorage(),
      send: async (w) => {
        sent.push(w.idempotencyKey);
        if (w.idempotencyKey === 'key-1')
          throw new ApiError(422, 'invalid', 'The title is too long.');
        return { txid: 2 };
      },
      sleep: async () => {},
      onDropped: (_w, error) => dropped.push(error.message),
    });
    const first = box.enqueueWrite(write(1));
    const second = box.enqueueWrite(write(2));

    // An ApiError with the server's code, so the page can show its translated text.
    await expect(first).rejects.toBeInstanceOf(ApiError);
    await expect(first).rejects.toMatchObject({
      name: 'WriteDropped',
      code: 'invalid',
      kind: 'rejected',
      message: 'The title is too long.',
    });
    // The refusal does not block the writes behind it, and the refused one is not sent again.
    await expect(second).resolves.toEqual({ txid: 2 });
    expect(sent).toEqual(['key-1', 'key-2']);
    expect(dropped).toEqual(['The title is too long.']);
    expect(box.pendingCount(WS)).toBe(0);
  });

  it('write to a lost team is dropped', async () => {
    let calls = 0;
    const box = createOutbox({
      storage: memoryStorage(),
      send: async () => {
        calls += 1;
        throw new ApiError(404, 'not_found', 'Not found.');
      },
      sleep: async () => {},
    });
    const lost = box.enqueueWrite(write(1));
    await expect(lost).rejects.toBeInstanceOf(WriteDropped);
    await expect(lost).rejects.toMatchObject({ kind: 'lost-access', status: 404 });
    expect(calls).toBe(1);
    expect(box.pendingCount(WS)).toBe(0);
  });

  it('tells subscribers about a dropped write, for as long as they listen', async () => {
    const box = createOutbox({
      storage: memoryStorage(),
      send: async () => {
        throw new ApiError(422, 'invalid', 'The title is too long.');
      },
      sleep: async () => {},
    });
    const heard: string[] = [];
    const handled: boolean[] = [];
    const stop = box.subscribeDropped((_w, error, isHandled) => {
      heard.push(error.message);
      handled.push(isHandled);
    });
    await expect(box.enqueueWrite(write(1))).rejects.toBeInstanceOf(WriteDropped);
    expect(heard).toEqual(['The title is too long.']);
    // A caller was waiting on it, so the screen shows the refusal itself.
    expect(handled).toEqual([true]);
    stop();
    await expect(box.enqueueWrite(write(2))).rejects.toBeInstanceOf(WriteDropped);
    expect(heard).toHaveLength(1);
  });

  it('a write left by an earlier visit has no caller: the listener is told it is not handled', async () => {
    const storage = memoryStorage();
    await storage.save(WS, [write(1)]);
    const box = createOutbox({
      storage,
      send: async () => {
        throw new ApiError(404, 'not_found', 'Not found.');
      },
      sleep: async () => {},
    });
    const handled: boolean[] = [];
    box.subscribeDropped((_w, _e, isHandled) => handled.push(isHandled));
    await box.resume(WS);
    await flush();
    expect(handled).toEqual([false]);
    expect(box.pendingCount(WS)).toBe(0);
  });

  it('drops the queued writes of a team the person lost, and keeps the others', async () => {
    const net = network();
    const storage = memoryStorage();
    const box = createOutbox({ storage, send: net.send, sleep: net.sleep });
    const other = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
    const head = box.enqueueWrite(write(1, { teamId: other }));
    const lost = box.enqueueWrite(write(2));
    const lost2 = box.enqueueWrite(write(3));
    await flush();

    await box.dropTeamWrites(WS, TEAM);

    await expect(lost).rejects.toMatchObject({ kind: 'lost-access' });
    await expect(lost2).rejects.toMatchObject({ kind: 'lost-access' });
    expect(box.pendingCount(WS)).toBe(1);
    expect(storage.records.get(WS)?.map((w) => w.idempotencyKey)).toEqual(['key-1']);
    net.goOnline();
    await expect(head).resolves.toEqual({ txid: 1 });
  });

  it('reload while offline keeps the queue', async () => {
    const storage = memoryStorage();
    const offline = network();
    const before = createOutbox({ storage, send: offline.send, sleep: offline.sleep });
    void before.enqueueWrite(write(1)).catch(() => {});
    void before.enqueueWrite(write(2)).catch(() => {});
    await flush();

    // The page reloads: a new outbox reads what the old one stored, in order.
    const net = network();
    const after = createOutbox({ storage, send: net.send, sleep: net.sleep });
    await after.resume(WS);
    expect(after.pendingCount(WS)).toBe(2);

    net.goOnline();
    await flush();
    await flush();
    expect(net.sent.map((w) => w.idempotencyKey)).toEqual(['key-1', 'key-2']);
    expect(after.pendingCount(WS)).toBe(0);
    expect(storage.records.get(WS)).toEqual([]);
  });
});

describe('sign-out', () => {
  const deps = (pending: number, confirm: (n: number) => Promise<boolean>) => {
    const calls: string[] = [];
    return {
      calls,
      deps: {
        workspaceIds: ['a', 'b'],
        pendingCount: (id: string) => (id === 'a' ? pending : 0),
        confirm: async (n: number) => {
          calls.push(`confirm:${n}`);
          return confirm(n);
        },
        logout: async () => {
          calls.push('logout');
        },
        wipeWorkspace: async (id: string) => {
          calls.push(`wipe:${id}`);
        },
        navigate: () => {
          calls.push('navigate');
        },
      },
    };
  };

  it('sign-out with pending writes asks', async () => {
    const declined = deps(3, async () => false);
    await expect(runSignOut(declined.deps)).resolves.toBe('cancelled');
    // Told how many would be lost, and nothing was ended or wiped.
    expect(declined.calls).toEqual(['confirm:3']);

    const accepted = deps(3, async () => true);
    await expect(runSignOut(accepted.deps)).resolves.toBe('signed-out');
    expect(accepted.calls).toEqual(['confirm:3', 'logout', 'wipe:a', 'wipe:b', 'navigate']);
  });

  it('does not ask when nothing is waiting', async () => {
    const quiet = deps(0, async () => false);
    await expect(runSignOut(quiet.deps)).resolves.toBe('signed-out');
    expect(quiet.calls).toEqual(['logout', 'wipe:a', 'wipe:b', 'navigate']);
  });

  it('wipes and leaves even when the server cannot be reached', async () => {
    const calls: string[] = [];
    await expect(
      runSignOut({
        workspaceIds: ['a'],
        pendingCount: () => 0,
        confirm: async () => true,
        logout: async () => {
          throw new Error('offline');
        },
        wipeWorkspace: async (id) => {
          calls.push(`wipe:${id}`);
        },
        navigate: () => {
          calls.push('navigate');
        },
      }),
    ).rejects.toThrow('offline');
    expect(calls).toEqual(['wipe:a', 'navigate']);
  });
});
