// Writes that have not reached the server yet (ADR 0001 section 1). Every change a person makes goes through here: it
// is stored on the device, sent in order, and sent again until the server answers. Each write carries an
// `Idempotency-Key` made when it was queued and kept on every replay, so a replay after a lost answer cannot create
// the thing twice. Every record names the tab that sends it (`owner`); a tab sends only its own, and adopts the records of
// a tab that is gone (its Web Lock `outbox-tab:<id>` is free), so two tabs never send the same write. The answer decides
// what happens next:
//   2xx          done; the caller waits for its txid to come back through the shape.
//   no answer / 5xx / 429   keep it, keep the order, try again later (the shape client's own timings).
//   403 / 404    the person lost access to what the write touches (a team they were removed from): dropped with a
//                message, never sent again.
//   other 4xx    the server refuses the change: dropped, the caller rolls the optimistic change back and shows why.
import type { IssueCreateInput } from '@torch/shared/mutations/issue';
import { ApiError, apiFetch } from '../api.ts';
import { deviceScope } from './identity.ts';
import { browserTabs, type TabPlatform, tabId as thisTabId } from './tabs.ts';

/** What a screen shows for a queued write before the server answers (an issue made offline: the temporary row). */
export type OutboxMeta = { kind: 'issue.create'; teamId: string; draft: IssueCreateInput };

export type OutboxWrite = {
  workspaceId: string;
  /** The team the write belongs to, so writes of a team the person lost can be dropped together. */
  teamId?: string;
  method: 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  path: string;
  body?: unknown;
  /** A UUID made when the write is first queued, unchanged on every replay. */
  idempotencyKey: string;
  /** What the screens show of the write while it waits (see `OutboxMeta`). */
  meta?: OutboxMeta;
};

/** A write as the device keeps it: with the tab that sends it. */
export type StoredWrite = OutboxWrite & { owner?: string };

/**
 * Why a write ended without being applied: `lost-access` (403/404) or `rejected` (any other 4xx). It is an `ApiError`
 * with the server's status and code, so the screens that turn a refusal into a translated message keep working.
 */
export class WriteDropped extends ApiError {
  readonly kind: 'lost-access' | 'rejected';

  constructor(kind: 'lost-access' | 'rejected', status: number, code: string, message: string) {
    super(status, code, message);
    this.name = 'WriteDropped';
    this.kind = kind;
  }
}

/** The same timings as the shape client's retries (PR A): 1 s doubling to 30 s. */
export const OUTBOX_BACKOFF = { initialDelay: 1000, maxDelay: 30_000, multiplier: 2 } as const;

/**
 * Where queued writes survive a reload: one record per write, keyed by its idempotency key, so tabs of the same browser
 * never overwrite each other's writes (each add and each delete touches one record). `load` returns the records in the
 * order they were added.
 */
export type OutboxStorage = {
  load(workspaceId: string): Promise<StoredWrite[]>;
  add(workspaceId: string, write: OutboxWrite, owner?: string): Promise<void>;
  remove(workspaceId: string, idempotencyKey: string): Promise<void>;
  count(workspaceId: string): Promise<number>;
  clear(workspaceId: string): Promise<void>;
  /**
   * Hands a record to `owner` when it is still `expected`'s (a compare-and-set, one atomic step): of several tabs that
   * adopt the records of a tab that is gone, exactly one gets each record. False when the record is no longer there or
   * belongs to someone else by now.
   */
  claim(
    workspaceId: string,
    idempotencyKey: string,
    owner: string,
    expected?: string,
  ): Promise<boolean>;
};

export function memoryStorage(): OutboxStorage & { records: Map<string, StoredWrite[]> } {
  const records = new Map<string, StoredWrite[]>();
  const of = (id: string) => records.get(id) ?? [];
  return {
    records,
    load: async (id) => structuredClone(of(id)),
    add: async (id, write, owner) => {
      records.set(id, [
        ...of(id).filter((other) => other.idempotencyKey !== write.idempotencyKey),
        { ...structuredClone(write), ...(owner === undefined ? {} : { owner }) },
      ]);
    },
    claim: async (id, key, owner, expected) => {
      const record = of(id).find((other) => other.idempotencyKey === key);
      if (!record || record.owner !== expected) return false;
      record.owner = owner;
      return true;
    },
    remove: async (id, key) => {
      records.set(
        id,
        of(id).filter((other) => other.idempotencyKey !== key),
      );
    },
    count: async (id) => of(id).length,
    clear: async (id) => {
      records.delete(id);
    },
  };
}

/**
 * The IndexedDB database of a workspace and person. It starts like the store's name, so one wipe removes both, but it
 * carries its own version: a new schema of the device copy deletes the store, never the writes that wait to be sent.
 */
export const outboxDatabaseName = (workspaceId: string) => `${deviceScope(workspaceId)}-outbox-v1`;

type StoredRecord = { id: string; seq: number; write: OutboxWrite; owner?: string };

function openDb(workspaceId: string): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(outboxDatabaseName(workspaceId), 1);
    request.onupgradeneeded = () => {
      const store = request.result.createObjectStore('writes', { keyPath: 'id' });
      store.createIndex('seq', 'seq');
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

/** Runs one transaction; resolves with `run`'s result once the transaction has committed. */
async function inTransaction<T>(
  workspaceId: string,
  mode: IDBTransactionMode,
  run: (store: IDBObjectStore, done: (value: T) => void) => void,
): Promise<T> {
  const db = await openDb(workspaceId);
  try {
    return await new Promise<T>((resolve, reject) => {
      const tx = db.transaction('writes', mode);
      let value: T;
      tx.oncomplete = () => resolve(value);
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
      run(tx.objectStore('writes'), (result) => {
        value = result;
      });
    });
  } finally {
    db.close();
  }
}

export const indexedDbStorage: OutboxStorage = {
  load: (id) =>
    inTransaction<StoredWrite[]>(id, 'readonly', (store, done) => {
      const request = store.index('seq').getAll();
      request.onsuccess = () =>
        done(
          (request.result as StoredRecord[]).map((record) => ({
            ...record.write,
            ...(record.owner === undefined ? {} : { owner: record.owner }),
          })),
        );
    }),
  // The sequence number is read and used inside one transaction, so two tabs get different, increasing numbers.
  add: (id, write, owner) =>
    inTransaction<void>(id, 'readwrite', (store, done) => {
      const last = store.index('seq').openCursor(null, 'prev');
      last.onsuccess = () => {
        const seq = ((last.result?.value as StoredRecord | undefined)?.seq ?? 0) + 1;
        store.put({
          id: write.idempotencyKey,
          seq,
          write,
          ...(owner === undefined ? {} : { owner }),
        } satisfies StoredRecord);
        done(undefined);
      };
    }),
  // Read and written inside one transaction: of two tabs claiming the same record, the second finds the first's owner.
  claim: (id, key, owner, expected) =>
    inTransaction<boolean>(id, 'readwrite', (store, done) => {
      const request = store.get(key);
      request.onsuccess = () => {
        const record = request.result as StoredRecord | undefined;
        if (!record || record.owner !== expected) {
          done(false);
          return;
        }
        store.put({ ...record, owner });
        done(true);
      };
    }),
  remove: (id, key) =>
    inTransaction<void>(id, 'readwrite', (store, done) => {
      store.delete(key);
      done(undefined);
    }),
  count: (id) =>
    inTransaction<number>(id, 'readonly', (store, done) => {
      const request = store.count();
      request.onsuccess = () => done(request.result);
    }),
  clear: (id) =>
    inTransaction<void>(id, 'readwrite', (store, done) => {
      store.clear();
      done(undefined);
    }),
};

type Item = {
  write: OutboxWrite;
  settle?: { resolve: (result: { txid: number }) => void; reject: (error: unknown) => void };
};

/** `handled` is true when a caller is still waiting on the write and takes the refusal itself (a screen rolling back). */
export type DroppedListener = (write: OutboxWrite, error: WriteDropped, handled: boolean) => void;

export type OutboxOptions = {
  storage: OutboxStorage;
  /** This tab, for the `owner` of the records it queues. Default: the id of the page. */
  tabId?: string;
  /** Web Locks and broadcast channels. Default: the browser's. */
  platform?: TabPlatform;
  send?: (write: OutboxWrite) => Promise<{ txid: number }>;
  /** Waits `ms`, or less when the browser says it is back online. */
  sleep?: (ms: number) => Promise<void>;
  /** Told about every write that ended without being applied, however the caller took it. */
  onDropped?: (write: OutboxWrite, error: WriteDropped) => void;
};

const sendOverHttp = (write: OutboxWrite) =>
  apiFetch<{ txid: number }>(write.path, {
    method: write.method,
    headers: { 'Idempotency-Key': write.idempotencyKey },
    body: write.body === undefined ? undefined : JSON.stringify(write.body),
  });

const sleepUnlessOnline = (ms: number) =>
  new Promise<void>((resolve) => {
    const done = () => {
      clearTimeout(timer);
      window.removeEventListener('online', done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    window.addEventListener('online', done);
  });

/** The lock a tab holds for as long as its page lives: free means the tab is gone and its records are up for adoption. */
const TAB_LOCK_PREFIX = 'outbox-tab:';

/** The name of the channel the tabs of a workspace tell each other about changes of the queue on. */
function channelName(workspaceId: string): string {
  try {
    return `outbox-changes:${deviceScope(workspaceId)}`;
  } catch {
    return `outbox-changes:ws-${workspaceId}`;
  }
}

export function createOutbox(options: OutboxOptions) {
  const { storage, onDropped } = options;
  const send = options.send ?? sendOverHttp;
  const sleep = options.sleep ?? sleepUnlessOnline;
  const me = options.tabId ?? thisTabId;
  const platform = options.platform ?? browserTabs;
  // What this tab sends, in order: the records it owns.
  const queues = new Map<string, Item[]>();
  // What the other tabs hold on the device (their records), for the count and the lists.
  const foreign = new Map<string, StoredWrite[]>();
  const hydrating = new Map<string, Promise<void>>();
  const draining = new Set<string>();
  // Writes that ended (sent or dropped) and whose record is not deleted yet: reading the store must not bring them back.
  const over = new Set<string>();
  // Owners whose lock is awaited: when it is free the owner is gone and its records are adopted.
  const watching = new Set<string>();
  const channels = new Map<string, BroadcastChannel>();
  let ownLock: Promise<void> | null = null;
  let releaseOwnLock: (() => void) | null = null;
  let closed = false;
  // Saves of one workspace run one after the other, so the stored order is the order the writes were made in.
  const saves = new Map<string, Promise<unknown>>();
  const listeners = new Set<() => void>();
  const droppedListeners = new Set<DroppedListener>();
  const appliedListeners = new Set<(write: OutboxWrite) => void>();
  const notify = () => {
    for (const listener of [...listeners]) listener();
  };

  /** This page holds its lock from its first write or read of the queue on, until it ends. */
  function holdOwnLock(): Promise<void> {
    if (!ownLock) {
      const { locks } = platform;
      ownLock = locks
        ? new Promise<void>((resolve) => {
            locks
              .request(`${TAB_LOCK_PREFIX}${me}`, () => {
                resolve();
                return new Promise<void>((release) => {
                  releaseOwnLock = release;
                });
              })
              .catch(() => resolve());
          })
        : Promise.resolve();
    }
    return ownLock;
  }

  /** The tabs of this origin that hold their lock (null when the browser cannot say: then every record is adoptable). */
  async function liveTabs(): Promise<Set<string> | null> {
    const { locks } = platform;
    if (!locks) return null;
    try {
      const { held } = await locks.query();
      return new Set(
        (held ?? []).flatMap((lock) =>
          lock.name?.startsWith(TAB_LOCK_PREFIX) ? [lock.name.slice(TAB_LOCK_PREFIX.length)] : [],
        ),
      );
    } catch {
      // Unknown: adopt nothing now. The owners are watched, and the next change of the queue asks again.
      return new Set(['*']);
    }
  }

  function channelOf(workspaceId: string): BroadcastChannel | null {
    let channel = channels.get(workspaceId);
    if (channel) return channel;
    try {
      channel = platform.channel(channelName(workspaceId));
      channel.onmessage = () => {
        void follow(workspaceId);
      };
      (channel as { unref?: () => void }).unref?.();
      channels.set(workspaceId, channel);
      return channel;
    } catch {
      // No channel: the other tabs read the device on their next change.
      return null;
    }
  }

  /** Tells the other tabs of the workspace that the queue changed. */
  function announce(workspaceId: string) {
    try {
      channelOf(workspaceId)?.postMessage({ t: 'changed' });
    } catch {
      // The tabs catch up at their next read.
    }
  }

  /** Runs `work` after the saves already started for the workspace; a failed save never stops the next one. */
  function afterSaves<T>(workspaceId: string, work: () => Promise<T>): Promise<T> {
    const run = (saves.get(workspaceId) ?? Promise.resolve()).then(work, work);
    saves.set(
      workspaceId,
      run.catch(() => {}),
    );
    return run;
  }

  /**
   * Reads the device and settles who sends what: the records this tab owns are its queue (in the order they were made),
   * the records of a tab that is gone are adopted (one tab wins each, see `claim`), the rest belong to tabs that are
   * still open. A device that cannot be read (no IndexedDB, private mode) leaves the queue as it is: writes still go
   * out, they just do not survive a reload, as before the outbox existed.
   */
  function reconcile(workspaceId: string, adoptUnknown = false): Promise<void> {
    return afterSaves(workspaceId, async () => {
      const records = await storage.load(workspaceId).catch(() => null);
      if (!records) return;
      // A browser without Web Locks cannot say which tabs are open: the records found when the page opens are adopted (as
      // they always were), and none after that, so two open tabs never take each other's writes.
      const live = await liveTabs();
      const knowsTabs = live !== null || !adoptUnknown;
      const known = new Map(
        (queues.get(workspaceId) ?? []).map((item) => [item.write.idempotencyKey, item]),
      );
      const mine: Item[] = [];
      const others: StoredWrite[] = [];
      for (const record of records) {
        const key = record.idempotencyKey;
        if (over.has(key)) continue;
        const { owner, ...write } = record;
        const existing = known.get(key);
        let owned = owner === me || existing !== undefined;
        if (!owned) {
          const alive = knowsTabs && (live === null || (owner !== undefined && live.has(owner)));
          // A tab that is gone leaves its records to whoever claims them first.
          if (!alive) owned = await storage.claim(workspaceId, key, me, owner).catch(() => false);
        }
        if (owned) mine.push(existing ?? { write });
        else others.push(record);
      }
      // Writes the device could not keep still go out of this tab.
      const stored = new Set(records.map((record) => record.idempotencyKey));
      const memory = [...known.values()].filter((item) => !stored.has(item.write.idempotencyKey));
      queues.set(workspaceId, [...mine, ...memory]);
      foreign.set(workspaceId, others);
      watchOwners(workspaceId, others);
    });
  }

  /** Waits for the lock of each owner that is still open: once it is free the owner is gone, and its records are adopted. */
  function watchOwners(workspaceId: string, others: StoredWrite[]) {
    const { locks } = platform;
    if (!locks || closed) return;
    for (const owner of new Set(others.flatMap((record) => (record.owner ? [record.owner] : [])))) {
      if (watching.has(owner)) continue;
      watching.add(owner);
      locks
        .request(`${TAB_LOCK_PREFIX}${owner}`, () => undefined)
        .then(
          () => {
            watching.delete(owner);
            if (!closed) void follow(workspaceId);
          },
          () => watching.delete(owner),
        );
    }
  }

  /** The queue changed somewhere (another tab said so, or an owner is gone): read it, and send what became ours. */
  async function follow(workspaceId: string) {
    if (closed || !hydrating.has(workspaceId)) return;
    await reconcile(workspaceId);
    notify();
    void drain(workspaceId);
  }

  function hydrate(workspaceId: string): Promise<void> {
    let loading = hydrating.get(workspaceId);
    if (!loading) {
      loading = holdOwnLock()
        .then(() => {
          channelOf(workspaceId);
          return reconcile(workspaceId, true);
        })
        .then(() => notify());
      hydrating.set(workspaceId, loading);
    }
    return loading;
  }

  /** Forgets the record of a write that is over. A record that cannot be deleted only means a repeat on the next visit. */
  const forget = (workspaceId: string, write: OutboxWrite) =>
    afterSaves(workspaceId, () => storage.remove(workspaceId, write.idempotencyKey))
      .catch(() => {})
      .then(() => {
        over.delete(write.idempotencyKey);
        announce(workspaceId);
      });

  function drop(workspaceId: string, item: Item, error: WriteDropped) {
    over.add(item.write.idempotencyKey);
    const queue = queues.get(workspaceId) ?? [];
    queues.set(
      workspaceId,
      queue.filter((other) => other !== item),
    );
    item.settle?.reject(error);
    onDropped?.(item.write, error);
    for (const listener of [...droppedListeners])
      listener(item.write, error, item.settle !== undefined);
  }

  async function drain(workspaceId: string) {
    if (draining.has(workspaceId) || closed) return;
    draining.add(workspaceId);
    try {
      let attempt = 0;
      for (;;) {
        const item = (queues.get(workspaceId) ?? [])[0];
        if (!item || closed) return;
        try {
          const result = await send(item.write);
          over.add(item.write.idempotencyKey);
          queues.set(
            workspaceId,
            (queues.get(workspaceId) ?? []).filter((other) => other !== item),
          );
          for (const listener of [...appliedListeners]) listener(item.write);
          await forget(workspaceId, item.write);
          item.settle?.resolve(result);
          attempt = 0;
        } catch (error) {
          const status = error instanceof ApiError ? error.status : 0;
          if (status === 0 || status === 429 || status >= 500) {
            const { initialDelay, maxDelay, multiplier } = OUTBOX_BACKOFF;
            await sleep(Math.min(maxDelay, initialDelay * multiplier ** attempt));
            attempt += 1;
            continue;
          }
          const api = error as ApiError;
          drop(
            workspaceId,
            item,
            new WriteDropped(
              status === 403 || status === 404 ? 'lost-access' : 'rejected',
              status,
              api.code,
              api.message,
            ),
          );
          await forget(workspaceId, item.write);
          attempt = 0;
        }
        notify();
      }
    } finally {
      draining.delete(workspaceId);
      notify();
    }
  }

  /** Queues a write and resolves with the server's `txid` once it is applied; rejects with `WriteDropped`. */
  async function enqueueWrite(write: OutboxWrite): Promise<{ txid: number }> {
    await hydrate(write.workspaceId);
    let settle!: NonNullable<Item['settle']>;
    const result = new Promise<{ txid: number }>((resolve, reject) => {
      settle = { resolve, reject };
    });
    // The count (the offline banner) says "waiting" only once the write is on the device: a page that ends right after
    // would otherwise show a write that its next visit never finds. A device that cannot save it still sends it from
    // memory (the person is not blocked; a reload before the send loses it, as it did before the outbox). The write joins
    // the queue in the same step as its save, so reading the device never sees a record this tab has no item for.
    await afterSaves(write.workspaceId, async () => {
      await storage.add(write.workspaceId, write, me).catch(() => {});
      const queue = queues.get(write.workspaceId) ?? [];
      queue.push({ write, settle });
      queues.set(write.workspaceId, queue);
    });
    announce(write.workspaceId);
    notify();
    void drain(write.workspaceId);
    return result;
  }

  /** Sends what a previous visit left behind. Call once per workspace when the page opens it. */
  async function resume(workspaceId: string) {
    await hydrate(workspaceId);
    void drain(workspaceId);
  }

  /** What the device holds for the workspace that is not sent yet, whichever tab queued it (the offline banner). */
  const pendingCount = (workspaceId: string) =>
    (queues.get(workspaceId) ?? []).length + (foreign.get(workspaceId) ?? []).length;

  /** Every write waiting on the device, the other tabs' included, in the order they were made. */
  async function pendingWrites(workspaceId: string): Promise<OutboxWrite[]> {
    await hydrate(workspaceId);
    const records = await afterSaves(workspaceId, () => storage.load(workspaceId)).catch(
      () => null,
    );
    const mine = (queues.get(workspaceId) ?? []).map((item) => item.write);
    if (!records) return mine;
    const stored = new Set(records.map((record) => record.idempotencyKey));
    const listed = records
      .filter((record) => !over.has(record.idempotencyKey))
      .map(({ owner: _owner, ...write }) => write);
    return [...listed, ...mine.filter((write) => !stored.has(write.idempotencyKey))];
  }

  /** What the device holds for the workspace, whichever tab queued it (the sign-out question). */
  const storedCount = async (workspaceId: string) => {
    try {
      return Math.max(await storage.count(workspaceId), pendingCount(workspaceId));
    } catch {
      return pendingCount(workspaceId);
    }
  };

  /** The team is gone for this person: its queued writes will never be accepted. */
  async function dropTeamWrites(workspaceId: string, teamId: string) {
    await hydrate(workspaceId);
    const queue = queues.get(workspaceId) ?? [];
    const inFlight = draining.has(workspaceId) ? queue[0] : undefined;
    const dropped: OutboxWrite[] = [];
    for (const item of [...queue]) {
      if (item.write.teamId === teamId && item !== inFlight) {
        dropped.push(item.write);
        drop(
          workspaceId,
          item,
          new WriteDropped(
            'lost-access',
            404,
            'not_found',
            'You no longer have access to this team.',
          ),
        );
      }
    }
    await Promise.all(dropped.map((write) => forget(workspaceId, write)));
    notify();
  }

  /** Forgets every queued write of the workspace, for good (sign-out, after the person agreed). */
  async function wipe(workspaceId: string) {
    queues.set(workspaceId, []);
    foreign.set(workspaceId, []);
    hydrating.set(workspaceId, Promise.resolve());
    await storage.clear(workspaceId);
    announce(workspaceId);
    notify();
  }

  /** This page is done with the queue: it stops sending and gives its lock up, so another tab adopts what is left. */
  function close() {
    closed = true;
    releaseOwnLock?.();
    for (const channel of channels.values()) {
      try {
        channel.close();
      } catch {
        // Already closed.
      }
    }
    channels.clear();
  }

  function subscribe(listener: () => void): () => void {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  }

  /** Calls `listener` for every write that ends without being applied. */
  function subscribeDropped(listener: DroppedListener): () => void {
    droppedListeners.add(listener);
    return () => {
      droppedListeners.delete(listener);
    };
  }

  /** Calls `listener` for every write of this tab the server applied (before its caller hears). */
  function subscribeApplied(listener: (write: OutboxWrite) => void): () => void {
    appliedListeners.add(listener);
    return () => {
      appliedListeners.delete(listener);
    };
  }

  return {
    enqueueWrite,
    resume,
    pendingCount,
    pendingWrites,
    storedCount,
    dropTeamWrites,
    wipe,
    close,
    subscribe,
    subscribeDropped,
    subscribeApplied,
  };
}

export type Outbox = ReturnType<typeof createOutbox>;

/** The page's outbox. */
export const outbox = createOutbox({ storage: indexedDbStorage });
export const enqueueWrite = outbox.enqueueWrite;
export const pendingCount = outbox.pendingCount;
export const subscribePending = outbox.subscribe;
