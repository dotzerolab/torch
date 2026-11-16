// The device copy of a workspace: one SQLite database per workspace in the browser's private file system (OPFS), read
// back on the next visit so the page renders before the network answers (ADR 0001 section 5). Everything of a
// workspace lives under one name, so signing out or losing a workspace removes it with one prefix match.
//
// The store name carries the schema version: a store written by another version is deleted when the page opens the
// workspace, never migrated (the server is the source of truth, a reload refills it).
import {
  type BrowserWASQLiteDatabase,
  createBrowserWASQLitePersistence,
  openBrowserWASQLiteOPFSDatabase,
  type PersistedCollectionPersistence,
} from '@tanstack/browser-db-sqlite-persistence';

/** Bump when the layout of what is stored changes: stores of other versions are deleted on open. */
export const LOCAL_SCHEMA_VERSION = 1;

/** Names carry no product name: the same origin may host other apps. */
export const storeName = (workspaceId: string, version = LOCAL_SCHEMA_VERSION) =>
  `ws-${workspaceId}-v${version}`;
const workspacePrefix = (workspaceId: string) => `ws-${workspaceId}-v`;

/** The part of the OPFS root directory the store needs. */
export type DirectoryLike = {
  keys(): AsyncIterable<string>;
  removeEntry(name: string, options?: { recursive?: boolean }): Promise<void>;
};

/** What the store needs of the browser; tests replace it. */
export type StoragePlatform = {
  root(): Promise<DirectoryLike>;
  indexedDbNames(): Promise<string[]>;
  deleteIndexedDb(name: string): Promise<void>;
  openDatabase(name: string): Promise<BrowserWASQLiteDatabase>;
};

export const browserPlatform: StoragePlatform = {
  root: () => navigator.storage.getDirectory() as unknown as Promise<DirectoryLike>,
  async indexedDbNames() {
    const list = await indexedDB.databases?.();
    return (list ?? []).flatMap((db) => (db.name ? [db.name] : []));
  },
  deleteIndexedDb: (name) =>
    new Promise((resolve, reject) => {
      const request = indexedDB.deleteDatabase(name);
      request.onsuccess = () => resolve();
      request.onerror = () => reject(request.error);
      // Another tab still holds it: the deletion completes when that connection closes.
      request.onblocked = () => resolve();
    }),
  openDatabase: (name) => openBrowserWASQLiteOPFSDatabase({ databaseName: name }),
};

export type Store = {
  workspaceId: string;
  name: string;
  persistence: PersistedCollectionPersistence;
  database: BrowserWASQLiteDatabase;
  close(): Promise<void>;
};

const stores = new Map<string, Promise<Store>>();
// The stores that finished opening: a collection factory is synchronous and asks here whether a device copy exists.
const openStores = new Map<string, Store>();
// The collection ids each open store already holds rows for ("warm"), read when the store opened and kept current.
const stored = new Map<string, Set<string>>();

/** Does the device already hold a copy of this collection (so a persisted instance starts from it)? */
export const hasDeviceCopy = (workspaceId: string, collectionId: string) =>
  stored.get(workspaceId)?.has(collectionId) ?? false;

/**
 * The newest restart generation the device holds for a shape, 0 when it holds none: `base` is generation 1, `base~N` is
 * generation N (see `registry.ts`). A leader that starts the shape continues from it.
 */
export function storedGeneration(workspaceId: string, baseId: string): number {
  let latest = 0;
  for (const id of stored.get(workspaceId) ?? []) {
    if (id === baseId) latest = Math.max(latest, 1);
    else if (id.startsWith(`${baseId}~`)) {
      const n = Number(id.slice(baseId.length + 1));
      if (Number.isInteger(n)) latest = Math.max(latest, n);
    }
  }
  return latest;
}

async function readStored(workspaceId: string, database: BrowserWASQLiteDatabase): Promise<void> {
  const rows = await database
    .execute<{ collection_id: string }>('SELECT collection_id FROM collection_registry')
    .catch(() => [] as { collection_id: string }[]);
  stored.set(workspaceId, new Set(rows.map((row) => row.collection_id)));
}

/**
 * Waits until the store holds exactly `rows` rows of the collection. The persisted instance publishes before its rows
 * are on the device, and ending it earlier would cut the write short; a row that was deleted is only stored once the
 * count is down, so more rows than asked for are not enough. `rows` may be a function, read again at every poll: a live
 * shape keeps changing while the store catches up, and a frozen number would never be met. The wait is bounded (the copy
 * queue runs one job at a time and must not stall behind it) and tells whether the store got there.
 */
export async function waitUntilStored(
  workspaceId: string,
  collectionId: string,
  rows: number | (() => number),
  {
    timeoutMs = 60_000,
    pollMs = 200,
    isCancelled = () => false,
  }: { timeoutMs?: number; pollMs?: number; isCancelled?: () => boolean } = {},
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline && !isCancelled()) {
    const store = openStores.get(workspaceId);
    if (!store) return false;
    try {
      const [registered] = await store.database.execute<{ table_name: string }>(
        'SELECT table_name FROM collection_registry WHERE collection_id = ?',
        [collectionId],
      );
      if (registered) {
        const [count] = await store.database.execute<{ n: number }>(
          `SELECT COUNT(*) AS n FROM ${quote(registered.table_name)}`,
        );
        if (Number(count?.n ?? 0) === (typeof rows === 'function' ? rows() : rows)) {
          await readStored(workspaceId, store.database);
          return true;
        }
      }
    } catch {
      return false;
    }
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
  return false;
}

// Background copies of cold shapes (see `collections.ts`): one at a time, and all stopped when the store closes.
const copyQueues = new Map<string, Promise<void>>();
const copyStops = new Map<string, Set<() => void>>();

/**
 * Runs `job` after the earlier copies of the workspace. `stop` ends it early (the store is closing). Resolves when the job
 * ended, failed or was skipped; never rejects.
 */
export function queueDeviceCopy(
  workspaceId: string,
  job: (registerStop: (stop: () => void) => void) => Promise<void>,
): Promise<void> {
  const stops = copyStops.get(workspaceId) ?? new Set<() => void>();
  copyStops.set(workspaceId, stops);
  const previous = copyQueues.get(workspaceId) ?? Promise.resolve();
  const next = previous.then(async () => {
    if (!openStores.has(workspaceId)) return;
    let stop: (() => void) | undefined;
    try {
      await job((fn) => {
        stop = fn;
        stops.add(fn);
      });
    } catch {
      // The copy is an optimisation: the next visit tries again.
    } finally {
      if (stop) stops.delete(stop);
    }
  });
  copyQueues.set(workspaceId, next);
  return next;
}

/** The device copy of a workspace if it is open now, else null (the page then keeps the shape in memory only). */
export function persistenceFor(workspaceId: string): PersistedCollectionPersistence | null {
  return openStores.get(workspaceId)?.persistence ?? null;
}

/** `base`, `base-journal`, `base.lock` ...: every file the database engine keeps for one database. */
const belongsTo = (entry: string, base: string) =>
  entry === base || entry.startsWith(`${base}-`) || entry.startsWith(`${base}.`);

async function removeMatching(
  platform: StoragePlatform,
  prefix: string,
  keep?: string,
): Promise<void> {
  const root = await platform.root();
  const names: string[] = [];
  for await (const name of root.keys()) names.push(name);
  for (const name of names) {
    if (name.startsWith(prefix) && !(keep && belongsTo(name, keep))) {
      await root.removeEntry(name, { recursive: true }).catch(() => {});
    }
  }
  for (const name of await platform.indexedDbNames()) {
    if (name.startsWith(prefix) && !(keep && belongsTo(name, keep))) {
      await platform.deleteIndexedDb(name).catch(() => {});
    }
  }
}

/**
 * Opens (once per page) the store of a workspace. Stores of the same workspace written by another schema version are
 * deleted first. Rejects when the browser cannot keep files (private mode, no OPFS): callers fall back to memory.
 */
export function openWorkspaceStore(
  workspaceId: string,
  platform: StoragePlatform = browserPlatform,
  version = LOCAL_SCHEMA_VERSION,
): Promise<Store> {
  const cached = stores.get(workspaceId);
  if (cached) return cached;
  const name = storeName(workspaceId, version);
  const opened = (async (): Promise<Store> => {
    await removeMatching(platform, workspacePrefix(workspaceId), name);
    const database = await platform.openDatabase(name);
    const persistence = createBrowserWASQLitePersistence({ database });
    const store: Store = {
      workspaceId,
      name,
      persistence,
      database,
      close: async () => {
        await database.close?.();
      },
    };
    openStores.set(workspaceId, store);
    await readStored(workspaceId, database);
    return store;
  })();
  stores.set(workspaceId, opened);
  opened.catch(() => stores.delete(workspaceId));
  return opened;
}

/** Closes the open store of a workspace without deleting it. */
export async function closeWorkspaceStore(workspaceId: string): Promise<void> {
  const open = stores.get(workspaceId);
  stores.delete(workspaceId);
  openStores.delete(workspaceId);
  stored.delete(workspaceId);
  for (const stop of copyStops.get(workspaceId) ?? []) stop();
  copyStops.delete(workspaceId);
  copyQueues.delete(workspaceId);
  if (open) await open.then((store) => store.close()).catch(() => {});
}

/** Closes every open store (another tab is about to delete the files). */
export async function closeAllStores(): Promise<void> {
  await Promise.all([...stores.keys()].map((workspaceId) => closeWorkspaceStore(workspaceId)));
}

/**
 * Removes everything the device keeps of ONE workspace: its OPFS files and IndexedDB databases, of every schema
 * version. Other workspaces on the same origin are untouched (a shared computer, another person's session).
 */
export async function wipeWorkspaceStore(
  workspaceId: string,
  platform: StoragePlatform = browserPlatform,
): Promise<void> {
  await closeWorkspaceStore(workspaceId);
  await removeMatching(platform, workspacePrefix(workspaceId));
}

// What the persistence library keeps per collection besides its two tables (copied from its own cleanup of a retired
// generation; the version is pinned, and the revocation e2e proves the rows are gone from a real store).
const PER_COLLECTION_TABLES = [
  'applied_tx',
  'collection_expected_keys',
  'collection_metadata',
  'persisted_index_registry',
  'leader_term',
  'collection_version',
  'collection_reset_epoch',
] as const;

const TEAM_COLLECTION_KINDS = ['issues', 'workflow-states', 'team-members'] as const;

const quote = (identifier: string) => `"${identifier.replaceAll('"', '""')}"`;

/**
 * Removes the persisted rows of every collection whose id matches `like` (an SQL LIKE pattern) except `keepId`.
 * A missing registry means nothing was ever persisted.
 */
async function removeCollections(
  database: BrowserWASQLiteDatabase,
  like: string,
  keepId = '',
): Promise<void> {
  let registered: ReadonlyArray<{
    collection_id: string;
    table_name: string;
    tombstone_table_name: string;
  }>;
  try {
    registered = await database.execute(
      'SELECT collection_id, table_name, tombstone_table_name FROM collection_registry WHERE collection_id LIKE ? AND collection_id != ?',
      [like, keepId],
    );
  } catch {
    return;
  }
  for (const row of registered) {
    await database.execute(`DROP TABLE IF EXISTS ${quote(row.table_name)}`);
    await database.execute(`DROP TABLE IF EXISTS ${quote(row.tombstone_table_name)}`);
    for (const table of PER_COLLECTION_TABLES) {
      await database.execute(`DELETE FROM ${table} WHERE collection_id = ?`, [row.collection_id]);
    }
    await database.execute('DELETE FROM collection_registry WHERE collection_id = ?', [
      row.collection_id,
    ]);
  }
  await database
    .execute('DELETE FROM cache_generation WHERE physical_id LIKE ? AND physical_id != ?', [
      like,
      keepId,
    ])
    .catch(() => {});
}

/**
 * The team is gone for this person: delete the persisted rows of its shapes (issues, workflow states, members) while
 * the other teams of the workspace stay. Collection ids are `<kind>-<workspaceId>-<teamId>` plus a restart suffix;
 * workspace and team ids are fixed-length UUIDs, so a prefix match cannot reach another team.
 */
export async function deleteTeamRows(workspaceId: string, teamId: string): Promise<void> {
  const open = stores.get(workspaceId);
  if (!open) return;
  const { database } = await open;
  for (const kind of TEAM_COLLECTION_KINDS) {
    await removeCollections(database, `${kind}-${workspaceId}-${teamId}%`);
  }
  await readStored(workspaceId, database);
}

/** Deletes the persisted shapes of every team whose id is not in `keep`: the device copy of teams that are gone. */
export async function deleteTeamsExcept(workspaceId: string, keep: Set<string>): Promise<void> {
  const open = stores.get(workspaceId);
  if (!open) return;
  const { database } = await open;
  let registered: ReadonlyArray<{ collection_id: string }>;
  try {
    registered = await database.execute('SELECT collection_id FROM collection_registry');
  } catch {
    return;
  }
  const gone = new Set<string>();
  for (const kind of TEAM_COLLECTION_KINDS) {
    const prefix = `${kind}-${workspaceId}-`;
    for (const { collection_id } of registered) {
      if (!collection_id.startsWith(prefix)) continue;
      // Workspace and team ids are fixed-length UUIDs; what follows is a restart suffix.
      const teamId = collection_id.slice(prefix.length, prefix.length + 36);
      if (!keep.has(teamId)) gone.add(teamId);
    }
  }
  for (const teamId of gone) await deleteTeamRows(workspaceId, teamId);
}

/**
 * A shape started over (the person's access changed): what its old instances persisted may hold rows the person can
 * no longer see, and the next page load would show them first. Every instance of the shape but `keepId` goes.
 */
export async function deleteShapeRows(
  workspaceId: string,
  baseId: string,
  keepId: string,
): Promise<void> {
  const open = stores.get(workspaceId);
  if (!open) return;
  const { database } = await open;
  await removeCollections(database, `${baseId}%`, keepId);
  await readStored(workspaceId, database);
}

/** Test helper: forget the open stores without touching any file. */
export function resetStoresForTests() {
  stores.clear();
  openStores.clear();
  stored.clear();
  copyStops.clear();
  copyQueues.clear();
}
