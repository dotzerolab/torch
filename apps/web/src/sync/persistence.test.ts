import { DatabaseSync } from 'node:sqlite';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  deleteTeamRows,
  LOCAL_SCHEMA_VERSION,
  openWorkspaceStore,
  queueDeviceCopy,
  resetStoresForTests,
  type StoragePlatform,
  storeName,
  waitUntilStored,
  wipeWorkspaceStore,
} from './persistence.ts';

const WS_A = '11111111-1111-4111-8111-111111111111';
const WS_B = '22222222-2222-4222-8222-222222222222';
const TEAM_1 = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const TEAM_2 = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

/** An in-memory OPFS root, IndexedDB name list and SQLite engine (one real database per file name). */
function fakePlatform() {
  const files = new Set<string>();
  const indexedDbs = new Set<string>();
  const databases = new Map<string, DatabaseSync>();
  const platform: StoragePlatform = {
    root: async () => ({
      async *keys() {
        yield* [...files];
      },
      removeEntry: async (name) => {
        files.delete(name);
        databases.get(name)?.close();
        databases.delete(name);
      },
    }),
    indexedDbNames: async () => [...indexedDbs],
    deleteIndexedDb: async (name) => {
      indexedDbs.delete(name);
    },
    openDatabase: async (name) => {
      files.add(name);
      files.add(`${name}-journal`);
      const sqlite = databases.get(name) ?? new DatabaseSync(':memory:');
      databases.set(name, sqlite);
      return {
        execute: async <TRow>(sql: string, params: ReadonlyArray<unknown> = []) =>
          sqlite.prepare(sql).all(...(params as never[])) as unknown as ReadonlyArray<TRow>,
        close: () => {},
      };
    },
  };
  return { platform, files, indexedDbs, databases };
}

beforeEach(() => resetStoresForTests());

describe('persistence', () => {
  it('names the store after the workspace and the schema version, without a product name', () => {
    expect(storeName(WS_A)).toBe(`ws-${WS_A}-v${LOCAL_SCHEMA_VERSION}`);
  });

  it('version bump resets the store', async () => {
    const { platform, files, indexedDbs } = fakePlatform();
    // A store another version wrote (and a database of the outbox), and another workspace's old store.
    for (const name of [`ws-${WS_A}-v0`, `ws-${WS_A}-v0-journal`, `ws-${WS_B}-v0`]) files.add(name);
    indexedDbs.add(`ws-${WS_A}-v0-outbox`);

    const store = await openWorkspaceStore(WS_A, platform);

    expect(store.name).toBe(storeName(WS_A));
    expect([...files].filter((name) => name.startsWith(`ws-${WS_A}-v0`))).toEqual([]);
    expect([...indexedDbs]).toEqual([]);
    expect(files.has(`ws-${WS_B}-v0`)).toBe(true);
    expect(files.has(storeName(WS_A))).toBe(true);
  });

  it('does not take a version that merely starts with the current one for the current store', async () => {
    const { platform, files } = fakePlatform();
    files.add(`ws-${WS_A}-v10`);
    await openWorkspaceStore(WS_A, platform);
    expect(files.has(`ws-${WS_A}-v10`)).toBe(false);
  });

  it('wipe is per workspace', async () => {
    const { platform, files, indexedDbs, databases } = fakePlatform();
    const a = await openWorkspaceStore(WS_A, platform);
    const b = await openWorkspaceStore(WS_B, platform);
    await a.database.execute('CREATE TABLE rows (id TEXT)');
    await a.database.execute("INSERT INTO rows VALUES ('a-row')");
    await b.database.execute('CREATE TABLE rows (id TEXT)');
    await b.database.execute("INSERT INTO rows VALUES ('b-row')");
    indexedDbs.add(`ws-${WS_A}-v1-outbox`);
    indexedDbs.add(`ws-${WS_B}-v1-outbox`);

    await wipeWorkspaceStore(WS_A, platform);

    expect([...files].filter((name) => name.includes(WS_A))).toEqual([]);
    expect([...indexedDbs]).toEqual([`ws-${WS_B}-v1-outbox`]);
    expect(databases.has(storeName(WS_A))).toBe(false);
    expect(await b.database.execute('SELECT id FROM rows')).toEqual([{ id: 'b-row' }]);
    // A later open of A starts from nothing.
    const again = await openWorkspaceStore(WS_A, platform);
    await expect(again.database.execute('SELECT id FROM rows')).rejects.toThrow();
  });

  it("dropTeam deletes the team's persisted rows", async () => {
    const { platform } = fakePlatform();
    const { database } = await openWorkspaceStore(WS_A, platform);
    // The registry and per-collection tables as the persistence library lays them out.
    await database.execute(
      'CREATE TABLE collection_registry (collection_id TEXT PRIMARY KEY, table_name TEXT, tombstone_table_name TEXT)',
    );
    for (const table of [
      'applied_tx',
      'collection_expected_keys',
      'collection_metadata',
      'persisted_index_registry',
      'leader_term',
      'collection_version',
      'collection_reset_epoch',
    ]) {
      await database.execute(`CREATE TABLE ${table} (collection_id TEXT)`);
    }
    await database.execute('CREATE TABLE cache_generation (physical_id TEXT)');
    for (const [n, team] of [TEAM_1, TEAM_2].entries()) {
      for (const kind of ['issues', 'workflow-states', 'team-members']) {
        const id = `${kind}-${WS_A}-${team}`;
        await database.execute(`CREATE TABLE c_${kind.replace('-', '')}${n} (id TEXT)`);
        await database.execute(`CREATE TABLE t_${kind.replace('-', '')}${n} (id TEXT)`);
        await database.execute(`INSERT INTO c_${kind.replace('-', '')}${n} VALUES ('row')`);
        await database.execute('INSERT INTO collection_registry VALUES (?, ?, ?)', [
          id,
          `c_${kind.replace('-', '')}${n}`,
          `t_${kind.replace('-', '')}${n}`,
        ]);
        await database.execute('INSERT INTO collection_version VALUES (?)', [id]);
        await database.execute('INSERT INTO cache_generation VALUES (?)', [id]);
      }
    }
    // A restarted shape of team 1 has a suffixed id and its own table.
    await database.execute('CREATE TABLE c_restarted (id TEXT)');
    await database.execute('INSERT INTO collection_registry VALUES (?, ?, ?)', [
      `issues-${WS_A}-${TEAM_1}~2`,
      'c_restarted',
      't_restarted',
    ]);

    await deleteTeamRows(WS_A, TEAM_1);

    const left = await database.execute<{ collection_id: string }>(
      'SELECT collection_id FROM collection_registry ORDER BY collection_id',
    );
    expect(left.every((row) => row.collection_id.includes(TEAM_2))).toBe(true);
    expect(left).toHaveLength(3);
    expect(await database.execute('SELECT * FROM collection_version')).toHaveLength(3);
    expect(await database.execute('SELECT * FROM cache_generation')).toHaveLength(3);
    const tables = (
      await database.execute<{ name: string }>(
        "SELECT name FROM sqlite_master WHERE type = 'table'",
      )
    ).map((row) => row.name);
    expect(tables).not.toContain('c_issues0');
    expect(tables).not.toContain('c_restarted');
    expect(tables).toContain('c_issues1');
  });

  it('does nothing for a workspace whose store is not open', async () => {
    await expect(deleteTeamRows(WS_A, TEAM_1)).resolves.toBeUndefined();
  });
});

describe('waitUntilStored', () => {
  /** A store holding `rows` rows of the collection `c1`, laid out as the persistence library does. */
  async function storeWith(rows: number) {
    const { platform } = fakePlatform();
    const { database } = await openWorkspaceStore(WS_A, platform);
    await database.execute(
      'CREATE TABLE collection_registry (collection_id TEXT PRIMARY KEY, table_name TEXT, tombstone_table_name TEXT)',
    );
    await database.execute('CREATE TABLE c_one (id TEXT)');
    await database.execute("INSERT INTO collection_registry VALUES ('c1', 'c_one', 't_one')");
    const add = async (n: number) => {
      for (let i = 0; i < n; i++) await database.execute('INSERT INTO c_one VALUES (?)', [`r${i}`]);
    };
    const remove = (id: string) => database.execute('DELETE FROM c_one WHERE id = ?', [id]);
    await add(rows);
    return { database, add, remove };
  }
  const fast = { pollMs: 10, timeoutMs: 400 };

  it('is done when the store holds exactly the rows asked for', async () => {
    await storeWith(3);
    expect(await waitUntilStored(WS_A, 'c1', 3, fast)).toBe(true);
  });

  it('does not take MORE rows than asked for as stored: a delete is only stored once the count is down', async () => {
    const { remove } = await storeWith(3);
    const waiting = waitUntilStored(WS_A, 'c1', 2, fast);
    setTimeout(() => void remove('r0'), 100);
    expect(await waiting).toBe(true);
    // A store that never gets there ends the wait at the timeout instead of passing.
    expect(await waitUntilStored(WS_A, 'c1', 1, { pollMs: 10, timeoutMs: 120 })).toBe(false);
  });

  it('re-reads the target while it waits, so a set that keeps changing does not stall it', async () => {
    const { add } = await storeWith(2);
    // The live set had 2 rows when the wait began; a row arrived since and the store follows it.
    let target = 2;
    setTimeout(() => {
      target = 3;
      void add(1).then(() => {});
    }, 50);
    // Before the fix of the target the count (3 after the add) would never equal the frozen 2.
    expect(await waitUntilStored(WS_A, 'c1', () => target, { pollMs: 10, timeoutMs: 1000 })).toBe(
      true,
    );
  });

  it('gives up at the timeout, and the copy queue goes on with the next job', async () => {
    await storeWith(2);
    const order: string[] = [];
    const first = queueDeviceCopy(WS_A, async () => {
      // 5 rows are never stored: this wait is the stall the queue must survive.
      const stored = await waitUntilStored(WS_A, 'c1', 5, { pollMs: 10, timeoutMs: 150 });
      order.push(`first:${stored}`);
    });
    const second = queueDeviceCopy(WS_A, async () => {
      order.push('second');
    });
    await Promise.all([first, second]);
    expect(order).toEqual(['first:false', 'second']);
  });

  it('settles the promise of a job that throws', async () => {
    await storeWith(0);
    const done = queueDeviceCopy(WS_A, async () => {
      throw new Error('copy failed');
    });
    await expect(done).resolves.toBeUndefined();
  });
});
