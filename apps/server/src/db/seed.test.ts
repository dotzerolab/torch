import { issue, member, team, teamMember, workflowState, workspace } from '@torch/shared/db/schema';
import { and, eq, sql } from 'drizzle-orm';
import { afterEach, describe, expect, it, vi } from 'vitest';
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
});
