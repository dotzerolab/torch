import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { bindSession, bindTestSession, deviceScope, resetIdentityForTests } from './identity.ts';
import {
  deleteTeamRows,
  deleteTeamsExcept,
  LOCAL_SCHEMA_VERSION,
  openWorkspaceStore,
  queueDeviceCopy,
  resetStoresForTests,
  type StoragePlatform,
  startDeviceSession,
  storedGeneration,
  storeName,
  waitUntilStored,
  wipeWorkspaceStore,
} from './persistence.ts';
import { createRegistry, type ShapeKey, TEAM_KINDS } from './registry.ts';

const WS_A = '11111111-1111-4111-8111-111111111111';
const WS_B = '22222222-2222-4222-8222-222222222222';
const TEAM_1 = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const TEAM_2 = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const ISSUE_1 = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';

/** The id the registry gives the device copy of a team shape (for the shapes of one issue, of ISSUE_1). */
function idOf(kind: (typeof TEAM_KINDS)[number], workspaceId: string, teamId: string): string {
  let id = '';
  const remember = (_key: ShapeKey, made: string) => {
    id = made;
    return { cleanup() {} };
  };
  const none = () => ({ cleanup() {} });
  const registry = createRegistry({
    teams: none,
    members: none,
    ownMemberships: none,
    workspaceLabels: none,
    issues: remember,
    workflowStates: remember,
    teamMembers: remember,
    labels: remember,
    issueLabels: remember,
    issueRelations: remember,
    issueLinks: remember,
    issueSubscribers: remember,
    issueDetail: remember,
    issueActivity: remember,
  });
  registry.get({ kind, workspaceId, teamId, issueId: ISSUE_1 } as ShapeKey);
  return id;
}

/** An in-memory OPFS root, IndexedDB name list and SQLite engine (one real database per file name). */
function fakePlatform() {
  const files = new Set<string>();
  const indexedDbs = new Set<string>();
  const databases = new Map<string, DatabaseSync>();
  let pending: string[] = [];
  const stuck = new Set<string>();
  const platform: StoragePlatform = {
    pendingWipes: {
      read: () => pending,
      write: (prefixes) => {
        pending = prefixes;
      },
    },
    root: async () => ({
      async *keys() {
        yield* [...files];
      },
      removeEntry: async (name) => {
        // A file another tab still holds cannot be removed.
        if (stuck.has(name)) throw new Error('in use');
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
  return { platform, files, indexedDbs, databases, stuck, pending: () => pending };
}

beforeEach(() => {
  resetStoresForTests();
  bindTestSession(WS_A, WS_B);
});
afterEach(() => resetIdentityForTests());

describe('persistence', () => {
  it('names the store after the workspace, the signed-in member and the schema version, without a product name', () => {
    expect(storeName(WS_A)).toBe(`ws-${WS_A}-mmemberof-v${LOCAL_SCHEMA_VERSION}`);
  });

  it('keeps every file name short enough for the browser to open it (a longer one failed to open)', () => {
    bindSession([{ id: WS_A, memberId: 'c0a80123-4567-4abc-8def-0123456789ab' }]);
    // The longest name is the store of a two digit schema version: the browser opens up to about 55 characters.
    expect(storeName(WS_A, 99).length).toBeLessThanOrEqual(54);
    expect(storeName(WS_A)).toBe(`ws-${WS_A}-mc0a80123-v${LOCAL_SCHEMA_VERSION}`);
  });

  it('cannot name anything before the session is known', () => {
    resetIdentityForTests();
    expect(() => storeName(WS_A)).toThrow();
  });

  it('version bump resets the store', async () => {
    const { platform, files, indexedDbs } = fakePlatform();
    // A store another version wrote (and a database of the outbox), and another workspace's old store.
    const scope = deviceScope(WS_A);
    for (const name of [`${scope}-v0`, `${scope}-v0-journal`, `${deviceScope(WS_B)}-v0`])
      files.add(name);
    // The outbox has its own version: a new schema of the store never deletes the writes that wait to be sent.
    indexedDbs.add(`${scope}-outbox-v1`);

    const store = await openWorkspaceStore(WS_A, platform);

    expect(store.name).toBe(storeName(WS_A));
    expect([...files].filter((name) => name.startsWith(`${scope}-v0`))).toEqual([]);
    expect([...indexedDbs]).toEqual([`${scope}-outbox-v1`]);
    expect(files.has(`${deviceScope(WS_B)}-v0`)).toBe(true);
    expect(files.has(storeName(WS_A))).toBe(true);
  });

  it('v1 store is rebuilt: the stored issue row changed, so the first layout is deleted on open and the second kept', async () => {
    const { platform, files } = fakePlatform();
    const scope = deviceScope(WS_A);
    files.add(`${scope}-v1`);
    files.add(`${scope}-v1-journal`);
    // A store of the layout the page writes now (a second tab opened it earlier) stays.
    files.add(`${scope}-v2`);

    const store = await openWorkspaceStore(WS_A, platform);

    expect(LOCAL_SCHEMA_VERSION).toBe(2);
    expect(store.name).toBe(`${scope}-v2`);
    expect(files.has(`${scope}-v1`)).toBe(false);
    expect(files.has(`${scope}-v1-journal`)).toBe(false);
    expect(files.has(`${scope}-v2`)).toBe(true);
  });

  it('does not take a version that merely starts with the current one for the current store', async () => {
    const { platform, files } = fakePlatform();
    files.add(`${deviceScope(WS_A)}-v10`);
    await openWorkspaceStore(WS_A, platform);
    expect(files.has(`${deviceScope(WS_A)}-v10`)).toBe(false);
  });

  it('wipe is per workspace', async () => {
    const { platform, files, indexedDbs, databases } = fakePlatform();
    const a = await openWorkspaceStore(WS_A, platform);
    const b = await openWorkspaceStore(WS_B, platform);
    await a.database.execute('CREATE TABLE rows (id TEXT)');
    await a.database.execute("INSERT INTO rows VALUES ('a-row')");
    await b.database.execute('CREATE TABLE rows (id TEXT)');
    await b.database.execute("INSERT INTO rows VALUES ('b-row')");
    indexedDbs.add(`${deviceScope(WS_A)}-outbox-v1`);
    indexedDbs.add(`${deviceScope(WS_B)}-outbox-v1`);

    await wipeWorkspaceStore(WS_A, platform);

    expect([...files].filter((name) => name.includes(WS_A))).toEqual([]);
    expect([...indexedDbs]).toEqual([`${deviceScope(WS_B)}-outbox-v1`]);
    expect(databases.has(storeName(WS_A))).toBe(false);
    expect(await b.database.execute('SELECT id FROM rows')).toEqual([{ id: 'b-row' }]);
    // A later open of A starts from nothing.
    const again = await openWorkspaceStore(WS_A, platform);
    await expect(again.database.execute('SELECT id FROM rows')).rejects.toThrow();
  });

  /** The registry and per-collection tables as the persistence library lays them out, with one collection per team kind. */
  async function seedTeamStores(database: {
    execute: (sql: string, params?: ReadonlyArray<unknown>) => Promise<unknown>;
  }) {
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
    const add = async (id: string, table: string) => {
      await database.execute(`CREATE TABLE c_${table} (id TEXT)`);
      await database.execute(`CREATE TABLE t_${table} (id TEXT)`);
      await database.execute(`INSERT INTO c_${table} VALUES ('row')`);
      await database.execute('INSERT INTO collection_registry VALUES (?, ?, ?)', [
        id,
        `c_${table}`,
        `t_${table}`,
      ]);
      await database.execute('INSERT INTO collection_version VALUES (?)', [id]);
      await database.execute('INSERT INTO cache_generation VALUES (?)', [id]);
    };
    for (const [n, team] of [TEAM_1, TEAM_2].entries()) {
      // The ids the app really gives its collections: made by the registry, not typed here.
      for (const kind of TEAM_KINDS) await add(idOf(kind, WS_A, team), `${kind}${n}`);
    }
    // A restarted shape of team 1 has a suffixed id and its own table.
    await database.execute('CREATE TABLE c_restarted (id TEXT)');
    await database.execute('INSERT INTO collection_registry VALUES (?, ?, ?)', [
      `issues-${WS_A}-${TEAM_1}~2`,
      'c_restarted',
      't_restarted',
    ]);
    // The labels of no team belong to the workspace, not to a team.
    await add(`workspaceLabels-${WS_A}`, 'workspaceLabels');
  }

  const tablesOf = async (database: { execute: <T>(sql: string) => Promise<ReadonlyArray<T>> }) =>
    (
      await database.execute<{ name: string }>(
        "SELECT name FROM sqlite_master WHERE type = 'table'",
      )
    ).map((row) => row.name);

  it('names the shapes of one issue after the team and the issue, so the team prefix reaches them', () => {
    expect(idOf('issueDetail', WS_A, TEAM_1)).toBe(`issueDetail-${WS_A}-${TEAM_1}-${ISSUE_1}`);
    expect(idOf('issueActivity', WS_A, TEAM_1)).toBe(`issueActivity-${WS_A}-${TEAM_1}-${ISSUE_1}`);
    expect(idOf('labels', WS_A, TEAM_1)).toBe(`labels-${WS_A}-${TEAM_1}`);
  });

  it("dropTeam deletes the team's persisted rows", async () => {
    const { platform } = fakePlatform();
    const { database } = await openWorkspaceStore(WS_A, platform);
    await seedTeamStores(database);

    await deleteTeamRows(WS_A, TEAM_1);

    const left = await database.execute<{ collection_id: string }>(
      'SELECT collection_id FROM collection_registry ORDER BY collection_id',
    );
    // The other team keeps one collection per kind, and the workspace keeps its labels.
    expect(left.filter((row) => row.collection_id.includes(TEAM_1))).toEqual([]);
    expect(left.filter((row) => row.collection_id.includes(TEAM_2))).toHaveLength(
      TEAM_KINDS.length,
    );
    expect(left.map((row) => row.collection_id)).toContain(`workspaceLabels-${WS_A}`);
    const kept = TEAM_KINDS.length + 1;
    expect(left).toHaveLength(kept);
    expect(await database.execute('SELECT * FROM collection_version')).toHaveLength(kept);
    expect(await database.execute('SELECT * FROM cache_generation')).toHaveLength(kept);
    const tables = await tablesOf(database);
    expect(tables).not.toContain('c_restarted');
    // Every shape of the lost team is gone, not only its issues: the live ones, the snapshots and the per-issue ones.
    for (const kind of TEAM_KINDS) {
      expect(tables).not.toContain(`c_${kind}0`);
      expect(tables).toContain(`c_${kind}1`);
    }
    expect(tables).toContain('c_workspaceLabels');
  });

  it('deleteTeamRows removes snapshot kinds', async () => {
    const { platform } = fakePlatform();
    const { database } = await openWorkspaceStore(WS_A, platform);
    await seedTeamStores(database);

    await deleteTeamRows(WS_A, TEAM_2);

    const tables = await tablesOf(database);
    for (const kind of [
      'labels',
      'issueLabels',
      'issueRelations',
      'issueLinks',
      'issueSubscribers',
      'workflowStates',
      'issueDetail',
      'issueActivity',
    ] as const) {
      expect(TEAM_KINDS).toContain(kind);
      expect(tables).not.toContain(`c_${kind}1`);
      expect(tables).toContain(`c_${kind}0`);
    }
  });

  it('deleteTeamsExcept removes the snapshots of a team that is not kept, and nothing of the workspace', async () => {
    const { platform } = fakePlatform();
    const { database } = await openWorkspaceStore(WS_A, platform);
    await seedTeamStores(database);

    await deleteTeamsExcept(WS_A, new Set([TEAM_2]));

    const tables = await tablesOf(database);
    for (const kind of TEAM_KINDS) {
      expect(tables).not.toContain(`c_${kind}0`);
      expect(tables).toContain(`c_${kind}1`);
    }
    expect(tables).toContain('c_workspaceLabels');
  });

  it('does nothing for a workspace whose store is not open', async () => {
    await expect(deleteTeamRows(WS_A, TEAM_1)).resolves.toBeUndefined();
  });
});

describe('session start', () => {
  const MEMBER_A = '2c6bccd5-9fdc-4eb7-8d50-f2e19358a8b9';
  const OLD = '33333333-3333-4333-8333-333333333333';

  it('removes what another person left, a workspace the person left, and the first names; keeps its own', async () => {
    const { platform, files, indexedDbs } = fakePlatform();
    bindSession([{ id: WS_A, memberId: MEMBER_A }]);
    const mine = deviceScope(WS_A);
    for (const name of [
      `${mine}-v1`,
      `${mine}-v1-journal`,
      // Another person's copy of the same workspace (the previous session ended by expiry).
      `ws-${WS_A}-mother-member-v1`,
      // A workspace this session no longer lists.
      `ws-${OLD}-m${MEMBER_A}-v1`,
      // The names before the member was part of them.
      `ws-${WS_A}-v1`,
    ])
      files.add(name);
    indexedDbs.add(`${mine}-outbox-v1`);
    indexedDbs.add(`ws-${WS_A}-mother-member-outbox-v1`);
    indexedDbs.add(`ws-${WS_A}-v1-outbox`);
    files.add('unrelated-app-file');

    await startDeviceSession([{ id: WS_A, memberId: MEMBER_A }], platform);

    expect([...files].sort()).toEqual(['unrelated-app-file', `${mine}-v1`, `${mine}-v1-journal`]);
    expect([...indexedDbs]).toEqual([`${mine}-outbox-v1`]);
  });

  it('names nothing before it has bound the session', async () => {
    resetIdentityForTests();
    const { platform } = fakePlatform();
    await startDeviceSession([{ id: WS_A, memberId: MEMBER_A }], platform);
    expect(storeName(WS_A)).toContain('-m2c6bccd5-');
  });

  it('a wipe that left files behind is finished by the next session start, before any store opens', async () => {
    const { platform, files, stuck, pending } = fakePlatform();
    const a = await openWorkspaceStore(WS_A, platform);
    stuck.add(a.name);

    await wipeWorkspaceStore(WS_A, platform);
    expect(files.has(a.name)).toBe(true);
    expect(pending()).toEqual([`ws-${WS_A}-`]);

    // The other tab let go; the person signs in again as the same member.
    stuck.clear();
    await startDeviceSession([{ id: WS_A, memberId: MEMBER_A }], platform);
    expect(files.has(a.name)).toBe(false);
    expect(pending()).toEqual([]);
  });
});

describe('storedGeneration', () => {
  it('is the newest restart generation the device holds for a shape, 0 when it holds none', async () => {
    const { platform } = fakePlatform();
    // The device already holds these copies when the store opens (a leader that takes over continues from them).
    const earlier = await platform.openDatabase(storeName(WS_A));
    await earlier.execute(
      'CREATE TABLE collection_registry (collection_id TEXT PRIMARY KEY, table_name TEXT, tombstone_table_name TEXT)',
    );
    const base = `issues-${WS_A}-${TEAM_1}`;
    for (const id of [
      base,
      `${base}~2`,
      `${base}~11`,
      `${base}~junk`,
      `issues-${WS_A}-${TEAM_2}~7`,
    ])
      await earlier.execute('INSERT INTO collection_registry VALUES (?, ?, ?)', [id, 't', 'u']);
    await openWorkspaceStore(WS_A, platform);

    expect(storedGeneration(WS_A, base)).toBe(11);
    expect(storedGeneration(WS_A, `issues-${WS_A}-${TEAM_2}`)).toBe(7);
    expect(storedGeneration(WS_A, `issues-${WS_A}-cccccccc-cccc-4ccc-8ccc-cccccccccccc`)).toBe(0);
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
