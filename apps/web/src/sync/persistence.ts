// The device copy of a workspace: one SQLite database per workspace in the browser's private file system (OPFS), read
// back on the next visit so the page renders before the network answers (ADR 0001 section 5). Everything of a
// workspace lives under one name, so signing out or losing a workspace removes it with one prefix match.
//
// The store name carries the person (`identity.ts`) and the schema version: a store written by another version is
// deleted when the page opens the workspace, never migrated (the server is the source of truth, a reload refills it).
// The outbox database of the workspace has the same prefix but its own version, so that reset never reaches it.
import {
  type BrowserWASQLiteDatabase,
  createBrowserWASQLitePersistence,
  openBrowserWASQLiteOPFSDatabase,
  type PersistedCollectionPersistence,
} from '@tanstack/browser-db-sqlite-persistence';
import { bindSession, deviceScope, type SessionIdentity, sessionScopes } from './identity.ts';
import { TEAM_KINDS } from './registry.ts';

/** Bump when the layout of what is stored changes: stores of other versions are deleted on open. */
export const LOCAL_SCHEMA_VERSION = 1;

/** Names carry no product name: the same origin may host other apps. */
export const storeName = (workspaceId: string, version = LOCAL_SCHEMA_VERSION) =>
  `${deviceScope(workspaceId)}-v${version}`;
/** Every store of this person in the workspace, whatever its schema version (not the outbox: that has its own). */
const storePrefix = (workspaceId: string) => `${deviceScope(workspaceId)}-v`;
/** Everything the device keeps of the workspace, for every person and every version: stores and outbox. */
const workspacePrefix = (workspaceId: string) => `ws-${workspaceId}-`;

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
  /** Prefixes whose removal failed: the next page load removes them before it opens any store. */
  pendingWipes?: { read(): string[]; write(prefixes: string[]): void };
};

const PENDING_WIPES_KEY = 'wipe-pending';

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
  pendingWipes: {
    read() {
      try {
        const value = JSON.parse(localStorage.getItem(PENDING_WIPES_KEY) ?? '[]') as unknown;
        return Array.isArray(value) ? value.filter((name) => typeof name === 'string') : [];
      } catch {
        return [];
      }
    },
    write(prefixes) {
      try {
        if (prefixes.length === 0) localStorage.removeItem(PENDING_WIPES_KEY);
        else localStorage.setItem(PENDING_WIPES_KEY, JSON.stringify(prefixes));
      } catch {
        // No storage for the marker: the wipe is best effort.
      }
    },
  },
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

/** Every OPFS entry and IndexedDB database whose name `matches`. */
async function listMatching(
  platform: StoragePlatform,
  matches: (name: string) => boolean,
): Promise<{ files: string[]; databases: string[] }> {
  const root = await platform.root();
  const files: string[] = [];
  for await (const name of root.keys()) if (matches(name)) files.push(name);
  const databases = (await platform.indexedDbNames()).filter(matches);
  return { files, databases };
}

async function removeMatching(
  platform: StoragePlatform,
  matches: (name: string) => boolean,
): Promise<void> {
  const { files, databases } = await listMatching(platform, matches);
  const root = await platform.root();
  for (const name of files) await root.removeEntry(name, { recursive: true }).catch(() => {});
  for (const name of databases) await platform.deleteIndexedDb(name).catch(() => {});
}

/** True when something of the prefix is still on the device (a wipe that did not go through). */
async function anyLeft(platform: StoragePlatform, prefix: string): Promise<boolean> {
  try {
    const { files, databases } = await listMatching(platform, (name) => name.startsWith(prefix));
    return files.length + databases.length > 0;
  } catch {
    return true;
  }
}

/**
 * The session starts: binds the person's workspaces (nothing of the device is named, read or resumed before this), then
 * removes what a wipe left behind and everything of the device that does not belong to this session: the files of
 * another person who signed in here before (a session that ended by expiry leaves them), of a workspace this person no
 * longer belongs to, and of the first version of the names. Never rejects: what cannot be removed stays unreadable,
 * since every name this session uses carries its own member.
 */
export async function startDeviceSession(
  workspaces: readonly SessionIdentity[],
  platform: StoragePlatform = browserPlatform,
): Promise<void> {
  bindSession(workspaces);
  try {
    const pending = platform.pendingWipes?.read() ?? [];
    const stillPending: string[] = [];
    for (const prefix of pending) {
      await removeMatching(platform, (name) => name.startsWith(prefix));
      if (await anyLeft(platform, prefix)) stillPending.push(prefix);
    }
    if (pending.length > 0) platform.pendingWipes?.write(stillPending);
    const scopes = sessionScopes().map((scope) => `${scope}-`);
    await removeMatching(
      platform,
      (name) => name.startsWith('ws-') && !scopes.some((scope) => name.startsWith(scope)),
    );
  } catch {
    // The device may not be readable at all (private mode): the page works from memory.
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
    await removeMatching(
      platform,
      (entry) => entry.startsWith(storePrefix(workspaceId)) && !belongsTo(entry, name),
    );
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
 * Removes everything the device keeps of ONE workspace: its OPFS files and IndexedDB databases (store and outbox), of
 * every schema version and every person. Other workspaces on the same origin are untouched. What could not be removed
 * (a tab still holds the files) is remembered, and the next page load removes it before it opens any store.
 */
export async function wipeWorkspaceStore(
  workspaceId: string,
  platform: StoragePlatform = browserPlatform,
): Promise<void> {
  await closeWorkspaceStore(workspaceId);
  const prefix = workspacePrefix(workspaceId);
  await removeMatching(platform, (name) => name.startsWith(prefix)).catch(() => {});
  if (await anyLeft(platform, prefix)) {
    const pending = platform.pendingWipes?.read() ?? [];
    if (!pending.includes(prefix)) platform.pendingWipes?.write([...pending, prefix]);
  }
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
 * The team is gone for this person: delete the persisted rows of its shapes (issues, workflow states, team members) while
 * the other teams of the workspace stay. Collection ids are `<kind>-<workspaceId>-<teamId>` plus a restart suffix;
 * workspace and team ids are fixed-length UUIDs, so a prefix match cannot reach another team.
 */
export async function deleteTeamRows(workspaceId: string, teamId: string): Promise<void> {
  const open = stores.get(workspaceId);
  if (!open) return;
  const { database } = await open;
  for (const kind of TEAM_KINDS) {
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
  for (const kind of TEAM_KINDS) {
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
