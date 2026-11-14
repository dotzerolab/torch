import { member, teamMember } from '@torch/shared/db/schema';
import { and, eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { addMember, createWorkspaceFixture, pgErrorCode, withTempDatabase } from './fixtures.ts';

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  console.warn('[fixtures.test] SKIPPED the fixture integration tests: DATABASE_URL is not set.');
}

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
