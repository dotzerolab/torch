// Test helpers for every database test: a throwaway database per test file or test, and a ready-made
// workspace with members, teams, states and issues. Synthetic data only (`example.test` emails).
import { randomBytes } from 'node:crypto';
import { type MemberRole, type MemberRow, member, teamMember } from '@torch/shared/db/schema';
import pg from 'pg';
import { runMigrations } from '../db/migrate.ts';
import { insertWorkspaceLayout, type LayoutRole, type WorkspaceLayout } from '../db/seed.ts';
import { createDb, type Db, type Orm } from '../db.ts';

export type FixtureRole = LayoutRole;
export type WorkspaceFixture = WorkspaceLayout;

/** Postgres error code (`23503`, `23505`, `23514`, ...) of a failed query, also through Drizzle's wrapper. */
export function pgErrorCode(error: unknown): string | undefined {
  let current: unknown = error;
  for (let depth = 0; depth < 5 && current instanceof Error; depth++) {
    const code = (current as { code?: unknown }).code;
    if (typeof code === 'string') return code;
    current = current.cause;
  }
  return undefined;
}

/**
 * Creates `<database in DATABASE_URL>_test_<random>` (the dev database is `torch`, so `torch_test_<random>`;
 * derived, never spelled out, because the white-label gate keeps the product name out of code), migrates
 * it, runs `fn` and always drops it again. Tests that need an empty or private database (`demo` seed,
 * migrations) use this.
 */
export async function withTempDatabase<T>(fn: (db: Db, url: string) => Promise<T>): Promise<T> {
  const baseUrl = process.env.DATABASE_URL;
  if (!baseUrl) throw new Error('withTempDatabase needs DATABASE_URL (see .env.example)');

  const url = new URL(baseUrl);
  const baseName = url.pathname.replace(/^\//, '').replace(/[^a-z0-9_]/gi, '_') || 'test';
  const name = `${baseName}_test_${randomBytes(6).toString('hex')}`;
  url.pathname = `/${name}`;

  const admin = new pg.Client({ connectionString: baseUrl });
  // A lost admin connection fails the next admin query (the test reports it); without a listener it would also be uncaught.
  admin.on('error', () => {});
  await admin.connect();
  let db: Db | undefined;
  let outcome: { value: T } | { error: unknown };
  try {
    await admin.query(`create database ${name}`);
    await runMigrations(url.toString());
    db = createDb(url.toString());
    outcome = { value: await fn(db, url.toString()) };
  } catch (error) {
    outcome = { error };
  }

  let leftover: OpenConnection[] = [];
  try {
    await db?.close();
    leftover = await waitForNoConnections(admin, name);
  } finally {
    // `force` is only the cleanup for a test that leaked a connection (reported below); a clean teardown has nothing to cut.
    await admin.query(`drop database if exists ${name} with (force)`);
    await admin.end();
  }

  if ('error' in outcome) throw outcome.error;
  if (leftover.length > 0) {
    const list = leftover
      .map(
        (c) =>
          `pid ${c.pid} state ${c.state} application "${c.application_name}" query: ${c.query}`,
      )
      .join('; ');
    throw new Error(
      `withTempDatabase: ${leftover.length} connection(s) still open on ${name} after the test, dropped by force: ${list}. ` +
        'Release every pool client and close every pool or client the test (or the code under test) opened.',
    );
  }
  return outcome.value;
}

type OpenConnection = {
  pid: number;
  state: string | null;
  application_name: string;
  query: string;
};

/**
 * Connections to `name` other than this admin session. A closed connection can stay listed for a few milliseconds
 * while its server process exits, so this polls briefly; whatever is still there at the deadline is a real leftover.
 */
async function waitForNoConnections(admin: pg.Client, name: string): Promise<OpenConnection[]> {
  const deadline = Date.now() + 2000;
  for (;;) {
    const { rows } = await admin.query<OpenConnection>(
      `select pid, state, application_name, left(query, 120) as query
         from pg_stat_activity where datname = $1 and pid <> pg_backend_pid()`,
      [name],
    );
    if (rows.length === 0 || Date.now() >= deadline) return rows;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

const ISSUES_PER_TEAM = 3;

/**
 * One workspace with five members, a public ENG team (owner, admin, member, guest), a private OPS team
 * (owner, member), six workflow states per team and three issues per team (the same layout as the dev seed,
 * see `insertWorkspaceLayout`). Every call uses fresh random slug and emails, so tests never share rows.
 */
export async function createWorkspaceFixture(
  orm: Orm,
  opts: { email?: Partial<Record<FixtureRole, string>> } = {},
): Promise<WorkspaceFixture> {
  const suffix = randomBytes(4).toString('hex');
  const email = (role: FixtureRole) => opts.email?.[role] ?? `${role}-${suffix}@example.test`;

  return orm.transaction((tx) =>
    insertWorkspaceLayout(tx, {
      name: `Workspace ${suffix}`,
      slug: `ws-${suffix}`,
      email: {
        owner: email('owner'),
        admin: email('admin'),
        member: email('member'),
        guest: email('guest'),
        outsider: email('outsider'),
      },
      issuesPerTeam: ISSUES_PER_TEAM,
    }),
  );
}

/**
 * Adds one active member to an existing workspace, optionally into some of its teams, in one transaction (a team of
 * another workspace is refused by the composite foreign key and leaves nothing behind). The email is stored
 * normalised; without options it is a fresh `<role>-<suffix>@example.test`, and the handle is always unique.
 */
export async function addMember(
  orm: Orm,
  workspaceId: string,
  role: MemberRole,
  opts: { email?: string; name?: string; teamIds?: string[] } = {},
): Promise<MemberRow> {
  const suffix = randomBytes(4).toString('hex');
  const label = `${role[0]?.toUpperCase()}${role.slice(1)}`;

  return orm.transaction(async (tx) => {
    const [added] = await tx
      .insert(member)
      .values({
        workspaceId,
        email: (opts.email ?? `${role}-${suffix}@example.test`).trim().toLowerCase(),
        name: opts.name ?? `${label} ${suffix}`,
        handle: `${role}-${suffix}`,
        role,
      })
      .returning();
    if (!added) throw new Error('member insert returned no row');

    if (opts.teamIds?.length) {
      await tx
        .insert(teamMember)
        .values(opts.teamIds.map((teamId) => ({ workspaceId, teamId, memberId: added.id })));
    }
    return added;
  });
}
