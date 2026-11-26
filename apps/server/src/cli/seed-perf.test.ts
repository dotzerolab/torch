import {
  issue,
  issueLabel,
  label,
  member,
  team,
  teamMember,
  workflowState,
  workspace,
} from '@torch/shared/db/schema';
import { and, eq, isNotNull, sql } from 'drizzle-orm';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Orm } from '../db.ts';
import { withTempDatabase } from '../test/fixtures.ts';
import { PERF_ISSUES, seedPerf } from './seed-perf.ts';

const databaseUrl = process.env.DATABASE_URL;

afterEach(() => vi.unstubAllEnvs());

// The guard runs before the database is touched: a handle that throws on any use proves it.
const untouchable = new Proxy({} as Orm, {
  get() {
    throw new Error('the database must not be touched');
  },
});

describe('seedPerf guard', () => {
  it('refuses when APP_URL is not this machine, and in production', async () => {
    vi.stubEnv('NODE_ENV', 'development');
    vi.stubEnv('APP_URL', 'https://app.example.com');
    await expect(seedPerf(untouchable)).rejects.toThrow(/not at this machine/);

    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('APP_URL', 'http://localhost:5173');
    await expect(seedPerf(untouchable, { allowRemote: true })).rejects.toThrow(/production/);
  });

  it('rejects a size that is not a positive integer', async () => {
    vi.stubEnv('APP_URL', 'http://localhost:5173');
    await expect(seedPerf(untouchable, { issues: 0 })).rejects.toThrow(/positive integer/);
  });

  it('seeds 10,000 issues by default', () => {
    expect(PERF_ISSUES).toBe(10_000);
  });
});

describe.skipIf(!databaseUrl)('seedPerf (Postgres)', () => {
  it('creates one workspace with one team, two members and numbered issues, once', async () => {
    vi.stubEnv('APP_URL', 'http://localhost:5173');
    await withTempDatabase(async (db) => {
      const first = await seedPerf(db.orm, { issues: 1200 });
      const second = await seedPerf(db.orm, { issues: 1200 });

      expect(first).toEqual({ created: true, workspaceSlug: 'perf' });
      expect(second).toEqual({ created: false, workspaceSlug: 'perf' });
      const count = async (
        table:
          | typeof workspace
          | typeof member
          | typeof team
          | typeof teamMember
          | typeof workflowState
          | typeof issue,
      ) => (await db.orm.select({ n: sql<number>`count(*)::int` }).from(table))[0]?.n;
      expect(await count(workspace)).toBe(1);
      expect(await count(member)).toBe(2);
      expect(await count(team)).toBe(1);
      expect(await count(teamMember)).toBe(2);
      expect(await count(workflowState)).toBeGreaterThan(0);
      expect(await count(issue)).toBe(1200);
      const [row] = await db.orm.select().from(team).where(eq(team.key, 'PERF'));
      expect(row?.issueCounter).toBe(1200);
      const numbers = await db.orm
        .select({ min: sql<number>`min(number)::int`, max: sql<number>`max(number)::int` })
        .from(issue);
      expect(numbers[0]).toEqual({ min: 1, max: 1200 });
    });
  });

  // What the 10k views need to be measured on: labels, labelled issues, estimates, due dates and sub-issues, all from
  // the issue number, so two runs (and two machines) measure the same data.
  const shape = async (orm: Orm) => {
    const n = async (query: Promise<{ n: number }[]>) => (await query)[0]?.n;
    const count = sql<number>`count(*)::int`;
    return {
      labels: await n(orm.select({ n: count }).from(label)),
      groups: await n(orm.select({ n: count }).from(label).where(eq(label.isGroup, true))),
      children: await n(orm.select({ n: count }).from(label).where(isNotNull(label.parentId))),
      labelled: await n(orm.select({ n: count }).from(issueLabel)),
      estimates: await n(orm.select({ n: count }).from(issue).where(isNotNull(issue.estimate))),
      due: await n(orm.select({ n: count }).from(issue).where(isNotNull(issue.dueDate))),
      subIssues: await n(orm.select({ n: count }).from(issue).where(isNotNull(issue.parentId))),
    };
  };

  it('seeds six labels (one group), labels on a third of the issues, estimates, due dates and sub-issues', async () => {
    vi.stubEnv('APP_URL', 'http://localhost:5173');
    await withTempDatabase(async (db) => {
      await seedPerf(db.orm, { issues: 1200 });

      expect(await shape(db.orm)).toEqual({
        labels: 6,
        groups: 1,
        children: 2,
        labelled: 400,
        estimates: 600,
        due: 240,
        subIssues: 24,
      });
      // A label is never put on an issue twice, and only labels that are not groups are put on issues.
      const onGroup = await db.orm
        .select({ n: sql<number>`count(*)::int` })
        .from(issueLabel)
        .innerJoin(label, and(eq(label.id, issueLabel.labelId), eq(label.isGroup, true)));
      expect(onGroup[0]?.n).toBe(0);
      // Sub-issue 50 hangs under issue 49 of the same team.
      const [child] = await db.orm.select().from(issue).where(eq(issue.number, 50));
      const [parent] = await db.orm.select().from(issue).where(eq(issue.number, 49));
      expect(child?.parentId).toBe(parent?.id);
    });
  });

  it('adds what is missing to a workspace that was seeded without it, and changes nothing the second time', async () => {
    vi.stubEnv('APP_URL', 'http://localhost:5173');
    await withTempDatabase(async (db) => {
      await seedPerf(db.orm, { issues: 1200 });
      const complete = await shape(db.orm);
      expect(complete.labelled).toBe(400);

      // The workspace as an earlier version of the seed left it: issues only.
      await db.orm.delete(issueLabel);
      await db.orm.delete(label).where(isNotNull(label.parentId));
      await db.orm.delete(label);
      await db.orm.update(issue).set({ estimate: null, dueDate: null, parentId: null });
      expect((await shape(db.orm)).labelled).toBe(0);

      const again = await seedPerf(db.orm, { issues: 1200 });
      expect(again).toEqual({ created: false, workspaceSlug: 'perf' });
      expect(await shape(db.orm)).toEqual(complete);

      await seedPerf(db.orm, { issues: 1200 });
      expect(await shape(db.orm)).toEqual(complete);
    });
  });
});
