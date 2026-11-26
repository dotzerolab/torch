import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../api.ts';
import { bindTestSession, resetIdentityForTests } from './identity.ts';
import {
  createOutbox as createOutboxOnPlatform,
  memoryStorage,
  OUTBOX_BACKOFF,
  type OutboxStorage,
  type OutboxWrite,
  outboxDatabaseName,
  WriteDropped,
} from './outbox.ts';
import { LOCAL_SCHEMA_VERSION } from './persistence.ts';
import { runSignOut } from './sign-out.ts';
import type { TabPlatform } from './tabs.ts';

/** The tests that are not about several tabs run on a browser without Web Locks and channels. */
const noChannel = () =>
  ({ postMessage() {}, close() {}, onmessage: null }) as unknown as BroadcastChannel;
const createOutbox = (options: Parameters<typeof createOutboxOnPlatform>[0]) =>
  createOutboxOnPlatform({ platform: { locks: undefined, channel: noChannel }, ...options });

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
afterEach(() => {
  vi.unstubAllGlobals();
  resetIdentityForTests();
});

describe('outbox', () => {
  it('announces a queued write only once it is saved on the device', async () => {
    const net = network();
    const storage = memoryStorage();
    let finishSave: () => void = () => {};
    const slow = {
      ...storage,
      add: (workspaceId: string, item: OutboxWrite) =>
        new Promise<void>((resolve) => {
          finishSave = () => resolve(storage.add(workspaceId, item));
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
    await storage.add(WS, write(1));
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

  it('two tabs that queue while offline do not overwrite each other: every write is its own record', async () => {
    const storage = memoryStorage();
    const offline = network();
    const tabA = createOutbox({ storage, send: offline.send, sleep: offline.sleep });
    const tabB = createOutbox({ storage, send: offline.send, sleep: offline.sleep });
    await tabA.resume(WS);
    await tabB.resume(WS);
    void tabA.enqueueWrite(write(7)).catch(() => {});
    void tabB.enqueueWrite(write(8)).catch(() => {});
    await flush();

    // Both tabs closed; the person comes back: both writes are still there, and both are sent.
    const net = network();
    const reopened = createOutbox({ storage, send: net.send, sleep: net.sleep });
    await reopened.resume(WS);
    expect(reopened.pendingCount(WS)).toBe(2);
    net.goOnline();
    await flush();
    await flush();
    expect(net.sent.map((w) => w.idempotencyKey).sort()).toEqual(['key-7', 'key-8']);
  });

  it('a tab that sends or drops its own writes leaves the writes of the other tab on the device', async () => {
    const storage = memoryStorage();
    const offline = network();
    const tabA = createOutbox({ storage, send: offline.send, sleep: offline.sleep });
    await tabA.resume(WS);
    void tabA.enqueueWrite(write(7, { teamId: 'other-team' })).catch(() => {});
    await flush();

    const net = network();
    const tabB = createOutbox({ storage, send: net.send, sleep: net.sleep });
    await tabB.resume(WS);
    const mine = tabB.enqueueWrite(write(8)).catch(() => {});
    await flush();
    await tabB.dropTeamWrites(WS, TEAM);
    await mine;
    expect((await storage.load(WS)).map((w) => w.idempotencyKey)).toContain('key-7');
  });

  it('counts what the device holds, not only what this tab queued', async () => {
    const storage = memoryStorage();
    const offline = network();
    const tabA = createOutbox({ storage, send: offline.send, sleep: offline.sleep });
    const tabB = createOutbox({ storage, send: offline.send, sleep: offline.sleep });
    void tabA.enqueueWrite(write(7)).catch(() => {});
    await flush();
    expect(tabB.pendingCount(WS)).toBe(0);
    await expect(tabB.storedCount(WS)).resolves.toBe(1);
  });

  it('keeps working in memory when the device storage cannot be read or written', async () => {
    const broken: OutboxStorage = {
      load: async () => {
        throw new Error('no indexedDB');
      },
      add: async () => {
        throw new Error('quota');
      },
      remove: async () => {
        throw new Error('quota');
      },
      count: async () => {
        throw new Error('no indexedDB');
      },
      clear: async () => {},
      claim: async () => {
        throw new Error('no indexedDB');
      },
    };
    const net = network();
    const box = createOutbox({ storage: broken, send: net.send, sleep: net.sleep });
    const done = box.enqueueWrite(write(1));
    net.goOnline();
    // The write is sent, the caller is told, and a failed delete of the record does not leave it hanging.
    await expect(done).resolves.toEqual({ txid: 1 });
    expect(box.pendingCount(WS)).toBe(0);
  });

  it('settles the caller even when the record of a sent write cannot be deleted', async () => {
    const storage = memoryStorage();
    const net = network();
    net.goOnline();
    const box = createOutbox({
      storage: {
        ...storage,
        remove: async () => {
          throw new Error('blocked');
        },
      },
      send: net.send,
      sleep: net.sleep,
    });
    await expect(box.enqueueWrite(write(1))).resolves.toEqual({ txid: 1 });
  });

  it('keeps the outbox database name apart from the store schema version', () => {
    bindTestSession(WS);
    const name = outboxDatabaseName(WS);
    expect(name).toContain(WS);
    expect(name).not.toContain(`-v${LOCAL_SCHEMA_VERSION}-`);
    expect(name).toMatch(/-outbox-v1$/);
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
        pendingCount: async (id: string) => (id === 'a' ? pending : 0),
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

  it('tells the other tabs first, wipes after the logout, and tells them it is over only after the wipe', async () => {
    const quiet = deps(0, async () => true);
    const calls = quiet.calls;
    await runSignOut({
      ...quiet.deps,
      announce: async () => {
        calls.push('announce');
      },
      announceDone: () => {
        calls.push('announceDone');
      },
    });
    expect(calls).toEqual(['announce', 'logout', 'wipe:a', 'wipe:b', 'announceDone', 'navigate']);
  });

  it('still wipes and tells the other tabs when the logout fails', async () => {
    const calls: string[] = [];
    await expect(
      runSignOut({
        workspaceIds: ['a'],
        pendingCount: async () => 0,
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
        announceDone: () => {
          calls.push('announceDone');
        },
      }),
    ).rejects.toThrow('offline');
    expect(calls).toEqual(['wipe:a', 'announceDone', 'navigate']);
  });

  it('wipes and leaves even when the server cannot be reached', async () => {
    const calls: string[] = [];
    await expect(
      runSignOut({
        workspaceIds: ['a'],
        pendingCount: async () => 0,
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

// ---- several tabs of one browser -----------------------------------------------------------------------------------

/** The browser the tabs share: Web Locks that go to one holder at a time, and broadcast channels. */
function fakeBrowser() {
  const holders = new Set<string>();
  const queues = new Map<string, Array<() => void>>();
  const take = (name: string, callback: (lock: unknown) => unknown) => {
    holders.add(name);
    return Promise.resolve(callback({ name })).finally(() => {
      holders.delete(name);
      queues.get(name)?.shift()?.();
    });
  };
  const locks = {
    request: (async (name: string, a: unknown, b?: unknown) => {
      const options = (typeof a === 'function' ? {} : a) as { ifAvailable?: boolean };
      const callback = (typeof a === 'function' ? a : b) as (lock: unknown) => unknown;
      if (!holders.has(name)) return take(name, callback);
      if (options.ifAvailable) return callback(null);
      return new Promise((resolve, reject) => {
        queues.set(name, [
          ...(queues.get(name) ?? []),
          () => take(name, callback).then(resolve, reject),
        ]);
      });
    }) as unknown as LockManager['request'],
    query: async () => ({ held: [...holders].map((name) => ({ name })), pending: [] }),
  };
  const channels = new Map<string, Set<{ onmessage: ((event: MessageEvent) => void) | null }>>();
  const channel = (name: string) => {
    const mine: { onmessage: ((event: MessageEvent) => void) | null } = { onmessage: null };
    channels.set(name, (channels.get(name) ?? new Set()).add(mine));
    return {
      postMessage: (data: unknown) => {
        for (const other of channels.get(name) ?? []) {
          if (other !== mine) queueMicrotask(() => other.onmessage?.({ data } as MessageEvent));
        }
      },
      set onmessage(listener: ((event: MessageEvent) => void) | null) {
        mine.onmessage = listener;
      },
      close: () => channels.get(name)?.delete(mine),
    } as unknown as BroadcastChannel;
  };
  const platform: TabPlatform = { locks, channel };
  return { platform, holders };
}

/** One shared device: a store, one browser, and a network the tabs send through. */
function device() {
  const browser = fakeBrowser();
  const storage = memoryStorage();
  const sent: Array<{ by: string; key: string }> = [];
  const naps: Array<() => void> = [];
  let online = false;
  const tab = (tabId: string) =>
    createOutboxOnPlatform({
      storage,
      tabId,
      platform: browser.platform,
      send: async (w) => {
        if (!online) throw new ApiError(0, 'network', 'The server could not be reached.');
        sent.push({ by: tabId, key: w.idempotencyKey });
        return { txid: sent.length };
      },
      sleep: () => new Promise<void>((resolve) => naps.push(resolve)),
    });
  return {
    storage,
    sent,
    tab,
    goOnline() {
      online = true;
      for (const wake of naps.splice(0)) wake();
    },
  };
}

const settle = async () => {
  for (let i = 0; i < 8; i += 1) await flush();
};

describe('outbox across tabs', () => {
  it('two tabs hydrate the same record, one send', async () => {
    const d = device();
    // A record of a tab that is gone: no lock is held for its id.
    await d.storage.add(WS, write(1), 'closed-tab');
    const a = d.tab('A');
    const b = d.tab('B');
    await Promise.all([a.resume(WS), b.resume(WS)]);
    d.goOnline();
    await settle();
    expect(d.sent.map((entry) => entry.key)).toEqual(['key-1']);
    expect(d.storage.records.get(WS)).toEqual([]);
  });

  it('a record whose tab is still open is left to that tab', async () => {
    const d = device();
    const a = d.tab('A');
    void a.enqueueWrite(write(1)).catch(() => {});
    await settle();
    const b = d.tab('B');
    await b.resume(WS);
    d.goOnline();
    await settle();
    expect(d.sent).toEqual([{ by: 'A', key: 'key-1' }]);
  });

  it('owner closes, survivor sends the rest in order', async () => {
    const d = device();
    const a = d.tab('A');
    for (const n of [1, 2, 3]) void a.enqueueWrite(write(n)).catch(() => {});
    await settle();
    const b = d.tab('B');
    await b.resume(WS);
    // B sees A's three writes and waits: nothing of A is B's while A is open.
    expect(d.storage.records.get(WS)?.length).toBe(3);

    a.close();
    d.goOnline();
    await settle();
    expect(d.sent).toEqual([
      { by: 'B', key: 'key-1' },
      { by: 'B', key: 'key-2' },
      { by: 'B', key: 'key-3' },
    ]);
    expect(d.storage.records.get(WS)).toEqual([]);
    expect(b.pendingCount(WS)).toBe(0);
  });

  it('count is device-wide', async () => {
    const d = device();
    const a = d.tab('A');
    const b = d.tab('B');
    await Promise.all([a.resume(WS), b.resume(WS)]);
    const heard = vi.fn();
    b.subscribe(heard);
    void a.enqueueWrite(write(1)).catch(() => {});
    void a.enqueueWrite(write(2)).catch(() => {});
    await settle();
    expect(a.pendingCount(WS)).toBe(2);
    expect(b.pendingCount(WS)).toBe(2);
    expect(heard).toHaveBeenCalled();

    d.goOnline();
    await settle();
    expect(a.pendingCount(WS)).toBe(0);
    expect(b.pendingCount(WS)).toBe(0);
  });

  it("pendingWrites lists the other tab's create, with what the temporary row shows", async () => {
    const d = device();
    const a = d.tab('A');
    const b = d.tab('B');
    await b.resume(WS);
    const draft = { title: 'Offline issue', teamId: TEAM } as never;
    void a
      .enqueueWrite(write(1, { meta: { kind: 'issue.create', teamId: TEAM, draft } }))
      .catch(() => {});
    void a.enqueueWrite(write(2)).catch(() => {});
    await settle();
    const pending = await b.pendingWrites(WS);
    expect(pending.map((w) => w.idempotencyKey)).toEqual(['key-1', 'key-2']);
    expect(pending[0]?.meta).toEqual({ kind: 'issue.create', teamId: TEAM, draft });
    // The owner is the outbox's business, not the screens'.
    expect(pending[0]).not.toHaveProperty('owner');
  });

  it('a claim by the tab that does not own the record fails', async () => {
    const storage = memoryStorage();
    await storage.add(WS, write(1), 'A');
    await expect(storage.claim(WS, 'key-1', 'B', 'someone-else')).resolves.toBe(false);
    await expect(storage.claim(WS, 'key-1', 'B', 'A')).resolves.toBe(true);
    await expect(storage.claim(WS, 'key-1', 'C', 'A')).resolves.toBe(false);
    await expect(storage.claim(WS, 'missing', 'C', 'A')).resolves.toBe(false);
  });

  it('without Web Locks a tab sends what it finds on the device, as before', async () => {
    const storage = memoryStorage();
    const offline = network();
    const before = createOutbox({ storage, tabId: 'A', send: offline.send, sleep: offline.sleep });
    void before.enqueueWrite(write(1)).catch(() => {});
    await flush();
    const net = network();
    const after = createOutbox({
      storage,
      tabId: 'B',
      platform: { locks: undefined, channel: () => new BroadcastChannel('x') },
      send: net.send,
      sleep: net.sleep,
    });
    await after.resume(WS);
    net.goOnline();
    await settle();
    expect(net.sent.map((w) => w.idempotencyKey)).toEqual(['key-1']);
  });
});
