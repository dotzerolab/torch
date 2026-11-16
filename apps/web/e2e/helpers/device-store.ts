import type { Page } from '@playwright/test';

// What the page keeps of a workspace on the device, read from the real browser storage (OPFS and IndexedDB) and, for
// the rows, through the page's own copy of the store module (the dev server hands out one module instance per URL, so
// this is the same open store the app reads and writes).
const STORE_MODULE = '/src/sync/persistence.ts';

/** Every OPFS entry and IndexedDB database name of the page's origin. */
export function storageNames(page: Page): Promise<{ opfs: string[]; indexedDb: string[] }> {
  return page.evaluate(async () => {
    const root = await navigator.storage.getDirectory();
    const opfs: string[] = [];
    // `keys()` is part of the async iterable directory handle, which the DOM typings do not declare yet.
    for await (const name of (root as unknown as { keys(): AsyncIterable<string> }).keys()) {
      opfs.push(name);
    }
    const databases = (await indexedDB.databases?.()) ?? [];
    return { opfs, indexedDb: databases.flatMap((db) => (db.name ? [db.name] : [])) };
  });
}

/** How many rows of collections whose id starts with `idPrefix` the open store of the workspace holds. */
export function persistedRowCount(
  page: Page,
  workspaceId: string,
  idPrefix: string,
): Promise<number> {
  return page.evaluate(
    async ({ module, workspaceId, idPrefix }) => {
      const { openWorkspaceStore } = await import(/* @vite-ignore */ module);
      const { database } = await openWorkspaceStore(workspaceId);
      // No registry yet: nothing was persisted so far.
      const registered: { table_name: string }[] = await database
        .execute('SELECT table_name FROM collection_registry WHERE collection_id LIKE ?', [
          `${idPrefix}%`,
        ])
        .catch(() => []);
      let total = 0;
      for (const { table_name } of registered) {
        // A table dropped between the two reads (a delete is running) holds no rows.
        const [row] = await database
          .execute(`SELECT COUNT(*) AS n FROM "${table_name.replaceAll('"', '""')}"`)
          .catch(() => [{ n: 0 }]);
        total += Number(row.n);
      }
      return total;
    },
    { module: STORE_MODULE, workspaceId, idPrefix },
  );
}

/** The ids of every collection the open store of the workspace has registered. */
export function persistedCollections(page: Page, workspaceId: string): Promise<string[]> {
  return page.evaluate(
    async ({ module, workspaceId }) => {
      const { openWorkspaceStore } = await import(/* @vite-ignore */ module);
      const { database } = await openWorkspaceStore(workspaceId);
      const rows: { collection_id: string }[] = await database
        .execute('SELECT collection_id FROM collection_registry ORDER BY collection_id')
        .catch(() => []);
      return rows.map((row) => row.collection_id);
    },
    { module: STORE_MODULE, workspaceId },
  );
}

/** Runs the page's own `deleteTeamRows` (what the registry calls when a team is lost). */
export function deleteTeamRowsInPage(
  page: Page,
  workspaceId: string,
  teamId: string,
): Promise<void> {
  return page.evaluate(
    async ({ module, workspaceId, teamId }) => {
      const { deleteTeamRows } = await import(/* @vite-ignore */ module);
      await deleteTeamRows(workspaceId, teamId);
    },
    { module: STORE_MODULE, workspaceId, teamId },
  );
}

/** How many rows the page itself holds (in memory) of a shape of the workspace: what is on screen, not on the device. */
export function liveRowCount(
  page: Page,
  workspaceId: string,
  kind: 'teams' | 'members' | 'ownMemberships',
): Promise<number> {
  return page.evaluate(
    async ({ module, workspaceId, kind }) => {
      const { syncRegistry } = await import(/* @vite-ignore */ module);
      return syncRegistry.get({ kind, workspaceId }).size as number;
    },
    { module: '/src/sync/shapes.ts', workspaceId, kind },
  );
}
