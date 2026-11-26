// Writes that have not reached the server yet (ADR 0001 section 1). Every change a person makes goes through here: it
// is stored on the device, sent in order, and sent again until the server answers. Each write carries an
// `Idempotency-Key` made when it was queued and kept on every replay, so a replay after a lost answer cannot create
// the thing twice. The answer decides what happens next:
//   2xx          done; the caller waits for its txid to come back through the shape.
//   no answer / 5xx / 429   keep it, keep the order, try again later (the shape client's own timings).
//   403 / 404    the person lost access to what the write touches (a team they were removed from): dropped with a
//                message, never sent again.
//   other 4xx    the server refuses the change: dropped, the caller rolls the optimistic change back and shows why.
import { ApiError, apiFetch } from '../api.ts';
import { deviceScope } from './identity.ts';

export type OutboxWrite = {
  workspaceId: string;
  /** The team the write belongs to, so writes of a team the person lost can be dropped together. */
  teamId?: string;
  method: 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  path: string;
  body?: unknown;
  /** A UUID made when the write is first queued, unchanged on every replay. */
  idempotencyKey: string;
};

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
  load(workspaceId: string): Promise<OutboxWrite[]>;
  add(workspaceId: string, write: OutboxWrite): Promise<void>;
  remove(workspaceId: string, idempotencyKey: string): Promise<void>;
  count(workspaceId: string): Promise<number>;
  clear(workspaceId: string): Promise<void>;
};

export function memoryStorage(): OutboxStorage & { records: Map<string, OutboxWrite[]> } {
  const records = new Map<string, OutboxWrite[]>();
  const of = (id: string) => records.get(id) ?? [];
  return {
    records,
    load: async (id) => structuredClone(of(id)),
    add: async (id, write) => {
      records.set(id, [
        ...of(id).filter((other) => other.idempotencyKey !== write.idempotencyKey),
        structuredClone(write),
      ]);
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

type StoredWrite = { id: string; seq: number; write: OutboxWrite };

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
    inTransaction<OutboxWrite[]>(id, 'readonly', (store, done) => {
      const request = store.index('seq').getAll();
      request.onsuccess = () =>
        done((request.result as StoredWrite[]).map((record) => record.write));
    }),
  // The sequence number is read and used inside one transaction, so two tabs get different, increasing numbers.
  add: (id, write) =>
    inTransaction<void>(id, 'readwrite', (store, done) => {
      const last = store.index('seq').openCursor(null, 'prev');
      last.onsuccess = () => {
        const seq = ((last.result?.value as StoredWrite | undefined)?.seq ?? 0) + 1;
        store.put({ id: write.idempotencyKey, seq, write } satisfies StoredWrite);
        done(undefined);
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

export function createOutbox(options: OutboxOptions) {
  const { storage, onDropped } = options;
  const send = options.send ?? sendOverHttp;
  const sleep = options.sleep ?? sleepUnlessOnline;
  const queues = new Map<string, Item[]>();
  const hydrating = new Map<string, Promise<Item[]>>();
  const draining = new Set<string>();
  // Saves of one workspace run one after the other, so the stored order is the order the writes were made in.
  const saves = new Map<string, Promise<unknown>>();
  const listeners = new Set<() => void>();
  const droppedListeners = new Set<DroppedListener>();
  const notify = () => {
    for (const listener of [...listeners]) listener();
  };

  function hydrate(workspaceId: string): Promise<Item[]> {
    let loading = hydrating.get(workspaceId);
    if (!loading) {
      // A device that cannot be read (no IndexedDB, private mode) starts with an empty queue: writes still go out, they
      // just do not survive a reload, as before the outbox existed.
      loading = storage
        .load(workspaceId)
        .catch(() => [] as OutboxWrite[])
        .then((writes) => {
          // Writes queued while loading come after the ones from the last visit.
          const queue = [...writes.map((write) => ({ write })), ...(queues.get(workspaceId) ?? [])];
          queues.set(workspaceId, queue);
          notify();
          return queue;
        });
      hydrating.set(workspaceId, loading);
    }
    return loading;
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

  /** Forgets the record of a write that is over. A record that cannot be deleted only means a repeat on the next visit. */
  const forget = (workspaceId: string, write: OutboxWrite) =>
    afterSaves(workspaceId, () => storage.remove(workspaceId, write.idempotencyKey)).catch(
      () => {},
    );

  function drop(workspaceId: string, item: Item, error: WriteDropped) {
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
    if (draining.has(workspaceId)) return;
    draining.add(workspaceId);
    try {
      let attempt = 0;
      for (;;) {
        const item = (queues.get(workspaceId) ?? [])[0];
        if (!item) return;
        try {
          const result = await send(item.write);
          queues.set(workspaceId, (queues.get(workspaceId) ?? []).slice(1));
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
    // The count (the offline banner) says "waiting" only once the write is on the device: a page that ends right after
    // would otherwise show a write that its next visit never finds. A device that cannot save it still sends it from
    // memory (the person is not blocked; a reload before the send loses it, as it did before the outbox).
    await afterSaves(write.workspaceId, () => storage.add(write.workspaceId, write)).catch(
      () => {},
    );
    // Read the queue after saving: every send replaces the array, so one taken earlier may be a dead copy.
    const queue = queues.get(write.workspaceId) ?? [];
    const result = new Promise<{ txid: number }>((resolve, reject) => {
      queue.push({ write, settle: { resolve, reject } });
    });
    notify();
    void drain(write.workspaceId);
    return result;
  }

  /** Sends what a previous visit left behind. Call once per workspace when the page opens it. */
  async function resume(workspaceId: string) {
    await hydrate(workspaceId);
    void drain(workspaceId);
  }

  /** What this tab has queued (the offline banner). */
  const pendingCount = (workspaceId: string) => (queues.get(workspaceId) ?? []).length;

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
    hydrating.set(workspaceId, Promise.resolve([]));
    await storage.clear(workspaceId);
    notify();
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

  return {
    enqueueWrite,
    resume,
    pendingCount,
    storedCount,
    dropTeamWrites,
    wipe,
    subscribe,
    subscribeDropped,
  };
}

export type Outbox = ReturnType<typeof createOutbox>;

/** The page's outbox. */
export const outbox = createOutbox({ storage: indexedDbStorage });
export const enqueueWrite = outbox.enqueueWrite;
export const pendingCount = outbox.pendingCount;
export const subscribePending = outbox.subscribe;
