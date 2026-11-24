import { issue, member, team, teamMember, workflowState, workspace } from '@torch/shared/db/schema';
import { eq, sql } from 'drizzle-orm';
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
});
