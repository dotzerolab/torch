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
    return {
      workspaceId,
      name,
      persistence,
      database,
      close: async () => {
        await database.close?.();
      },
    };
  })();
  stores.set(workspaceId, opened);
  opened.catch(() => stores.delete(workspaceId));
  return opened;
}

/** Closes the open store of a workspace without deleting it. */
export async function closeWorkspaceStore(workspaceId: string): Promise<void> {
  const open = stores.get(workspaceId);
  stores.delete(workspaceId);
  if (open) await open.then((store) => store.close()).catch(() => {});
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
 * The team is gone for this person: delete the persisted rows of its shapes (issues, workflow states, members) while
 * the other teams of the workspace stay. Collection ids are `<kind>-<workspaceId>-<teamId>` plus a restart suffix;
 * workspace and team ids are fixed-length UUIDs, so a prefix match cannot reach another team.
 */
export async function deleteTeamRows(workspaceId: string, teamId: string): Promise<void> {
  const open = stores.get(workspaceId);
  if (!open) return;
  const { database } = await open;
  for (const kind of TEAM_COLLECTION_KINDS) {
    const prefix = `${kind}-${workspaceId}-${teamId}`;
    let registered: ReadonlyArray<{
      collection_id: string;
      table_name: string;
      tombstone_table_name: string;
    }>;
    try {
      registered = await database.execute(
        'SELECT collection_id, table_name, tombstone_table_name FROM collection_registry WHERE collection_id LIKE ?',
        [`${prefix}%`],
      );
    } catch {
      return; // nothing was ever persisted: no registry yet
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
      .execute('DELETE FROM cache_generation WHERE physical_id LIKE ?', [`${prefix}%`])
      .catch(() => {});
  }
}

/** Test helper: forget the open stores without touching any file. */
export function resetStoresForTests() {
  stores.clear();
}
