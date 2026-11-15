import { issue, member, team, teamMember, workflowState, workspace } from '@torch/shared/db/schema';
import { and, eq, sql } from 'drizzle-orm';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Orm } from '../db.ts';
import { withTempDatabase } from '../test/fixtures.ts';
import { seedDev } from './seed.ts';

const databaseUrl = process.env.DATABASE_URL;

// Integration: needs the dev compose Postgres (see db.test.ts). Skipped, loudly, when DATABASE_URL is not set.
if (!databaseUrl) {
  console.warn(
    '[seed.test] SKIPPED the seed integration tests: DATABASE_URL is not set. ' +
      'Start `docker compose -f docker-compose.dev.yml up -d --wait postgres` and set DATABASE_URL (see .env.example).',
  );
}

afterEach(() => {
  vi.unstubAllEnvs();
});

// The guard runs before the database is touched, so these need no database: a handle that throws on any use proves it.
const untouchable = new Proxy({} as Orm, {
  get() {
    throw new Error('the database must not be touched');
  },
});

describe('seedDev guard', () => {
  it.each([
    'https://app.example.com',
    'http://app.example.com:5173',
    'http://192.168.1.5:5173',
    'https://localhost.example.com',
    'http://localhost.evil.test',
    'not a url',
  ])('refuses when APP_URL is %s (not this machine)', async (appUrl) => {
    vi.stubEnv('NODE_ENV', 'development');
    vi.stubEnv('APP_URL', appUrl);

    await expect(seedDev(untouchable)).rejects.toThrow(/APP_URL/);
    await expect(seedDev(untouchable)).rejects.toThrow(/--allow-remote/);
  });

  it.each([
    'postgres://torch:pw@db.example.com:5432/torch',
    'postgres://torch:pw@10.0.0.7:5432/torch',
    'postgres://torch:pw@localhost.evil.test/torch',
    'not a url',
    '',
  ])(
    'refuses when APP_URL is unset and DATABASE_URL is "%s" (not shown to be this machine)',
    async (databaseUrl) => {
      vi.stubEnv('NODE_ENV', 'development');
      vi.stubEnv('APP_URL', '');
      vi.stubEnv('DATABASE_URL', databaseUrl);

      const error = await seedDev(untouchable).catch((e: unknown) => e as Error);

      expect(String((error as Error).message)).toMatch(/APP_URL is not set/);
      expect(String((error as Error).message)).toMatch(/--allow-remote/);
      // Never echoes the connection string (it carries the password).
      expect(String((error as Error).message)).not.toContain('pw@');
    },
  );

  it.each([
    'postgres://torch:torch@localhost:5432/torch',
    'postgres://torch:torch@127.0.0.1:5432/torch',
    'postgres://torch:torch@[::1]:5432/torch',
    'postgres:///torch?host=/var/run/postgresql',
  ])(
    'lets a seed through when APP_URL is unset and DATABASE_URL is local: %s',
    async (databaseUrl) => {
      vi.stubEnv('NODE_ENV', 'development');
      vi.stubEnv('APP_URL', '');
      vi.stubEnv('DATABASE_URL', databaseUrl);

      // The guard passed: the first touch of the (untouchable) database is what throws.
      await expect(seedDev(untouchable)).rejects.toThrow(/must not be touched/);
    },
  );

  it('allowRemote still seeds with APP_URL unset and a remote DATABASE_URL', async () => {
    vi.stubEnv('NODE_ENV', 'development');
    vi.stubEnv('APP_URL', '');
    vi.stubEnv('DATABASE_URL', 'postgres://torch:pw@db.example.com:5432/torch');

    await expect(seedDev(untouchable, { allowRemote: true })).rejects.toThrow(
      /must not be touched/,
    );
  });

  it('refuses in production even with allowRemote, and even for a local APP_URL', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('APP_URL', 'http://localhost:5173');

    await expect(seedDev(untouchable)).rejects.toThrow(/production/);
    await expect(seedDev(untouchable, { allowRemote: true })).rejects.toThrow(/production/);
  });

  it('never prints the APP_URL it refused (it may carry a credential)', async () => {
    vi.stubEnv('APP_URL', 'https://user:secret@app.example.com');

    const error = await seedDev(untouchable).catch((e: unknown) => e as Error);

    expect(String((error as Error).message)).not.toContain('secret');
  });
});

describe.skipIf(!databaseUrl)('seedDev (Postgres)', () => {
  const counts = async (orm: Parameters<typeof seedDev>[0]) => {
    const count = async (
      table: typeof workspace | typeof member | typeof team | typeof issue | typeof workflowState,
    ) => (await orm.select({ n: sql<number>`count(*)::int` }).from(table))[0]?.n;
    return {
      workspaces: await count(workspace),
      members: await count(member),
      teams: await count(team),
      states: await count(workflowState),
      issues: await count(issue),
    };
  };

  it('seedDev creates the demo workspace once', async () => {
    await withTempDatabase(async (db) => {
      const first = await seedDev(db.orm);
      const afterFirst = await counts(db.orm);
      const second = await seedDev(db.orm);
      const afterSecond = await counts(db.orm);

      expect(first).toEqual({ created: true, workspaceSlug: 'demo' });
      expect(second).toEqual({ created: false, workspaceSlug: 'demo' });
      expect(afterFirst).toEqual({ workspaces: 1, members: 5, teams: 2, states: 12, issues: 100 });
      expect(afterSecond).toEqual(afterFirst);
    });
  });

  it('seedDev refuses in production', async () => {
    await withTempDatabase(async (db) => {
      vi.stubEnv('NODE_ENV', 'production');

      await expect(seedDev(db.orm)).rejects.toThrow(/production/);

      vi.unstubAllEnvs();
      expect((await counts(db.orm)).workspaces).toBe(0);
    });
  });

  it('issue numbers are 1..n per team and issue_counter matches', async () => {
    await withTempDatabase(async (db) => {
      await seedDev(db.orm, { issuesPerTeam: 7 });

      const teams = await db.orm.select().from(team);
      expect(teams).toHaveLength(2);
      for (const t of teams) {
        const rows = await db.orm
          .select({ number: issue.number })
          .from(issue)
          .where(eq(issue.teamId, t.id));
        expect(rows.map((row) => row.number).sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5, 6, 7]);
        expect(t.issueCounter).toBe(7);
      }
    });
  });

  it('issue_counter is never below the highest issue number of its team, so the next number is free', async () => {
    await withTempDatabase(async (db) => {
      await seedDev(db.orm, { issuesPerTeam: 5 });

      const rows = await db.pool.query<{ key: string; counter: number; highest: number }>(
        `select t.key, t.issue_counter as counter, max(i.number)::int as highest
           from team t join issue i on i.team_id = t.id
          group by t.id, t.key, t.issue_counter`,
      );
      expect(rows.rows).toHaveLength(2);
      for (const row of rows.rows) expect(row.counter).toBeGreaterThanOrEqual(row.highest);
    });
  });

  it('seeds 50 issues per team by default', async () => {
    await withTempDatabase(async (db) => {
      await seedDev(db.orm);

      const teams = await db.orm.select().from(team);
      for (const t of teams) expect(t.issueCounter).toBe(50);
      expect((await counts(db.orm)).issues).toBe(100);
    });
  });

  it('the demo workspace has the fixture layout: five members, public ENG, private OPS without the guest', async () => {
    await withTempDatabase(async (db) => {
      await seedDev(db.orm);

      const members = await db.orm.select().from(member);
      expect(members.map((row) => [row.handle, row.email, row.role]).sort()).toEqual([
        ['admin', 'admin@example.test', 'admin'],
        ['guest', 'guest@example.test', 'guest'],
        ['member', 'member@example.test', 'member'],
        ['outsider', 'outsider@example.test', 'member'],
        ['owner', 'owner@example.test', 'owner'],
      ]);
      const teams = await db.orm.select().from(team);
      const eng = teams.find((row) => row.key === 'ENG');
      const ops = teams.find((row) => row.key === 'OPS');
      expect(eng?.private).toBe(false);
      expect(ops?.private).toBe(true);

      const handlesOf = async (teamId: string | undefined) => {
        const rows = await db.orm
          .select({ handle: member.handle })
          .from(teamMember)
          .innerJoin(
            member,
            and(eq(member.workspaceId, teamMember.workspaceId), eq(member.id, teamMember.memberId)),
          )
          .where(eq(teamMember.teamId, teamId ?? ''));
        return rows.map((row) => row.handle).sort();
      };
      expect(await handlesOf(eng?.id)).toEqual(['admin', 'guest', 'member', 'owner']);
      expect(await handlesOf(ops?.id)).toEqual(['member', 'owner']);
    });
  });

  it('accepts a local APP_URL (localhost, 127.0.0.1, [::1]) and no APP_URL at all', async () => {
    await withTempDatabase(async (db) => {
      vi.stubEnv('NODE_ENV', 'development');
      vi.stubEnv('APP_URL', 'http://localhost:5173');
      expect((await seedDev(db.orm)).created).toBe(true);

      for (const appUrl of ['http://127.0.0.1:3000', 'http://[::1]:5173', 'https://localhost']) {
        vi.stubEnv('APP_URL', appUrl);
        expect(await seedDev(db.orm), appUrl).toEqual({ created: false, workspaceSlug: 'demo' });
      }
      vi.stubEnv('APP_URL', '');
      expect(await seedDev(db.orm)).toEqual({ created: false, workspaceSlug: 'demo' });
    });
  });

  it('seeds a remote APP_URL only with allowRemote', async () => {
    await withTempDatabase(async (db) => {
      vi.stubEnv('NODE_ENV', 'development');
      vi.stubEnv('APP_URL', 'https://app.example.com');

      await expect(seedDev(db.orm)).rejects.toThrow(/APP_URL/);
      expect((await counts(db.orm)).workspaces).toBe(0);
      const allowed = await seedDev(db.orm, { allowRemote: true });

      expect(allowed).toEqual({ created: true, workspaceSlug: 'demo' });
      expect((await counts(db.orm)).workspaces).toBe(1);
    });
  });
});
