import { member, teamMember } from '@torch/shared/db/schema';
import { and, eq } from 'drizzle-orm';
import pg from 'pg';
import { describe, expect, it } from 'vitest';
import { addMember, createWorkspaceFixture, pgErrorCode, withTempDatabase } from './fixtures.ts';

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  console.warn('[fixtures.test] SKIPPED the fixture integration tests: DATABASE_URL is not set.');
}

describe.skipIf(!databaseUrl)('withTempDatabase (Postgres)', () => {
  it('fails loudly, listing the connection, when a test leaves one open on the database', async () => {
    const outcome = withTempDatabase(async (_db, url) => {
      const leaked = new pg.Client({ connectionString: url, application_name: 'leaky-test' });
      // The teardown still drops the database and so cuts this connection; the listener keeps that cut from crashing.
      leaked.on('error', () => {});
      await leaked.connect();
    });

    await expect(outcome).rejects.toThrow(/1 connection\(s\) still open.*leaky-test/s);
  });

  it('keeps the error of the test when the test fails and leaves a connection open', async () => {
    const outcome = withTempDatabase(async (_db, url) => {
      const leaked = new pg.Client({ connectionString: url });
      leaked.on('error', () => {});
      await leaked.connect();
      throw new Error('the test itself failed');
    });

    await expect(outcome).rejects.toThrow('the test itself failed');
  });

  it('closes cleanly when every connection was released', async () => {
    const outcome = withTempDatabase(async (db) => {
      await db.pool.query('select 1');
      return 'done';
    });

    await expect(outcome).resolves.toBe('done');
  });
});

describe.skipIf(!databaseUrl)('addMember (Postgres)', () => {
  it('creates an active member with a normalised email, the given role and a valid handle', async () => {
    await withTempDatabase(async (db) => {
      const a = await createWorkspaceFixture(db.orm);

      const added = await addMember(db.orm, a.workspaceId, 'admin', {
        email: '  Second.Admin@Example.TEST ',
        name: 'Second Admin',
      });

      expect(added).toMatchObject({
        workspaceId: a.workspaceId,
        email: 'second.admin@example.test',
        name: 'Second Admin',
        role: 'admin',
        deactivatedAt: null,
      });
      expect(added.handle).toMatch(/^[a-z0-9][a-z0-9_-]{1,31}$/);
      const [stored] = await db.orm.select().from(member).where(eq(member.id, added.id));
      expect(stored?.email).toBe('second.admin@example.test');
    });
  });

  it('without options: a fresh example.test email and a unique handle per call', async () => {
    await withTempDatabase(async (db) => {
      const a = await createWorkspaceFixture(db.orm);

      const first = await addMember(db.orm, a.workspaceId, 'guest');
      const second = await addMember(db.orm, a.workspaceId, 'guest');

      expect(first.role).toBe('guest');
      expect(first.email).toMatch(/^guest-[a-z0-9]+@example\.test$/);
      expect(second.email).not.toBe(first.email);
      expect(second.handle).not.toBe(first.handle);
    });
  });

  it('adds the member to the given teams and to none otherwise', async () => {
    await withTempDatabase(async (db) => {
      const a = await createWorkspaceFixture(db.orm);
      const teamsOf = async (memberId: string) =>
        (
          await db.orm
            .select({ teamId: teamMember.teamId })
            .from(teamMember)
            .where(
              and(eq(teamMember.workspaceId, a.workspaceId), eq(teamMember.memberId, memberId)),
            )
        )
          .map((row) => row.teamId)
          .sort();

      const none = await addMember(db.orm, a.workspaceId, 'member');
      const both = await addMember(db.orm, a.workspaceId, 'member', {
        teamIds: [a.teams.eng.id, a.teams.ops.id],
      });

      expect(await teamsOf(none.id)).toEqual([]);
      expect(await teamsOf(both.id)).toEqual([a.teams.eng.id, a.teams.ops.id].sort());
    });
  });

  it('a team of another workspace cannot be given', async () => {
    await withTempDatabase(async (db) => {
      const a = await createWorkspaceFixture(db.orm);
      const b = await createWorkspaceFixture(db.orm);

      const attempt = addMember(db.orm, a.workspaceId, 'member', { teamIds: [b.teams.eng.id] });

      await expect(attempt.then(() => 'added').catch(pgErrorCode)).resolves.toBe('23503');
    });
  });
});
