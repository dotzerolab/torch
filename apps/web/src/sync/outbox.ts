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
import { LOCAL_SCHEMA_VERSION } from './persistence.ts';

export type OutboxWrite = {
  workspaceId: string;
  /** The team the write belongs to, so writes of a team the person lost can be dropped together. */
  teamId?: string;
  method: 'POST' | 'PATCH' | 'DELETE';
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

/** Where queued writes survive a reload. One record per workspace. */
export type OutboxStorage = {
  load(workspaceId: string): Promise<OutboxWrite[]>;
  save(workspaceId: string, writes: OutboxWrite[]): Promise<void>;
  clear(workspaceId: string): Promise<void>;
};

export function memoryStorage(): OutboxStorage & { records: Map<string, OutboxWrite[]> } {
  const records = new Map<string, OutboxWrite[]>();
  return {
    records,
    load: async (id) => structuredClone(records.get(id) ?? []),
    save: async (id, writes) => {
      records.set(id, structuredClone(writes));
    },
    clear: async (id) => {
      records.delete(id);
    },
  };
}

/** The name of the IndexedDB database of a workspace: it starts like the store, so one wipe removes both. */
export const outboxDatabaseName = (workspaceId: string) =>
  `ws-${workspaceId}-v${LOCAL_SCHEMA_VERSION}-outbox`;

function openDb(workspaceId: string): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(outboxDatabaseName(workspaceId), 1);
    request.onupgradeneeded = () => request.result.createObjectStore('queue');
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function withStore<T>(
  workspaceId: string,
  mode: IDBTransactionMode,
  run: (store: IDBObjectStore) => IDBRequest<T>,
): Promise<T> {
  const db = await openDb(workspaceId);
  try {
    return await new Promise<T>((resolve, reject) => {
      const request = run(db.transaction('queue', mode).objectStore('queue'));
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  } finally {
    db.close();
  }
}

export const indexedDbStorage: OutboxStorage = {
  load: async (id) => (await withStore(id, 'readonly', (s) => s.get('writes'))) ?? [],
  save: async (id, writes) => {
    await withStore(id, 'readwrite', (s) => s.put(writes, 'writes'));
  },
  clear: async (id) => {
    await withStore(id, 'readwrite', (s) => s.delete('writes'));
  },
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
  const listeners = new Set<() => void>();
  const droppedListeners = new Set<DroppedListener>();
  const notify = () => {
    for (const listener of [...listeners]) listener();
  };

  function hydrate(workspaceId: string): Promise<Item[]> {
    let loading = hydrating.get(workspaceId);
    if (!loading) {
      loading = storage.load(workspaceId).then((writes) => {
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

  const persist = (workspaceId: string) =>
    storage.save(
      workspaceId,
      (queues.get(workspaceId) ?? []).map((item) => item.write),
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
          await persist(workspaceId);
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
          await persist(workspaceId);
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
    // Read the queue after loading: every send replaces the array, so one taken earlier may be a dead copy.
    const queue = queues.get(write.workspaceId) ?? [];
    const result = new Promise<{ txid: number }>((resolve, reject) => {
      queue.push({ write, settle: { resolve, reject } });
    });
    // The count (the offline banner) says "waiting" only once the write is on the device: a page that ends right after
    // would otherwise show a write that its next visit never finds.
    await persist(write.workspaceId);
    notify();
    void drain(write.workspaceId);
    return result;
  }

  /** Sends what a previous visit left behind. Call once per workspace when the page opens it. */
  async function resume(workspaceId: string) {
    await hydrate(workspaceId);
    void drain(workspaceId);
  }

  const pendingCount = (workspaceId: string) => (queues.get(workspaceId) ?? []).length;

  /** The team is gone for this person: its queued writes will never be accepted. */
  async function dropTeamWrites(workspaceId: string, teamId: string) {
    await hydrate(workspaceId);
    const queue = queues.get(workspaceId) ?? [];
    const inFlight = draining.has(workspaceId) ? queue[0] : undefined;
    for (const item of [...queue]) {
      if (item.write.teamId === teamId && item !== inFlight) {
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
    await persist(workspaceId);
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

  return { enqueueWrite, resume, pendingCount, dropTeamWrites, wipe, subscribe, subscribeDropped };
}

export type Outbox = ReturnType<typeof createOutbox>;

/** The page's outbox. */
export const outbox = createOutbox({ storage: indexedDbStorage });
export const enqueueWrite = outbox.enqueueWrite;
export const pendingCount = outbox.pendingCount;
export const subscribePending = outbox.subscribe;
