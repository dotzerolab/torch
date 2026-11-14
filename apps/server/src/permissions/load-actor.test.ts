import { member } from '@torch/shared/db/schema';
import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { createWorkspaceFixture, withTempDatabase } from '../test/fixtures.ts';
import { loadActor, loadTeamAccess } from './load-actor.ts';

const databaseUrl = process.env.DATABASE_URL;

// Integration: needs the dev compose Postgres (see db.test.ts). Skipped, loudly, when DATABASE_URL is not set.
if (!databaseUrl) {
  console.warn(
    '[load-actor.test] SKIPPED the actor-loading integration tests: DATABASE_URL is not set. ' +
      'Start `docker compose -f docker-compose.dev.yml up -d --wait postgres` and set DATABASE_URL (see .env.example).',
  );
}

describe.skipIf(!databaseUrl)('loadActor / loadTeamAccess (Postgres)', () => {
  it('loads role and team ids', async () => {
    await withTempDatabase(async (db) => {
      const f = await createWorkspaceFixture(db.orm);

      const owner = await loadActor(db.orm, f.workspaceId, f.members.owner.id);
      const guest = await loadActor(db.orm, f.workspaceId, f.members.guest.id);
      const outsider = await loadActor(db.orm, f.workspaceId, f.members.outsider.id);

      expect(owner).toEqual({
        workspaceId: f.workspaceId,
        memberId: f.members.owner.id,
        role: 'owner',
        teamIds: new Set([f.teams.eng.id, f.teams.ops.id]),
      });
      expect(guest?.role).toBe('guest');
      expect(guest?.teamIds).toEqual(new Set([f.teams.eng.id]));
      expect(outsider?.role).toBe('member');
      expect(outsider?.teamIds.size).toBe(0);
    });
  });

  it('deactivated member -> null', async () => {
    await withTempDatabase(async (db) => {
      const f = await createWorkspaceFixture(db.orm);
      await db.orm
        .update(member)
        .set({ deactivatedAt: new Date() })
        .where(eq(member.id, f.members.member.id));

      const actor = await loadActor(db.orm, f.workspaceId, f.members.member.id);

      expect(actor).toBeNull();
    });
  });

  it('member id of another workspace -> null', async () => {
    await withTempDatabase(async (db) => {
      const a = await createWorkspaceFixture(db.orm);
      const b = await createWorkspaceFixture(db.orm);

      const actor = await loadActor(db.orm, a.workspaceId, b.members.owner.id);

      expect(actor).toBeNull();
    });
  });

  it('an unknown member id -> null', async () => {
    await withTempDatabase(async (db) => {
      const f = await createWorkspaceFixture(db.orm);

      const actor = await loadActor(db.orm, f.workspaceId, '00000000-0000-4000-8000-000000000000');

      expect(actor).toBeNull();
    });
  });

  it('a malformed id -> null, not a database error', async () => {
    await withTempDatabase(async (db) => {
      const f = await createWorkspaceFixture(db.orm);

      expect(await loadActor(db.orm, f.workspaceId, 'not-a-uuid')).toBeNull();
      expect(await loadActor(db.orm, 'not-a-uuid', f.members.owner.id)).toBeNull();
      expect(await loadTeamAccess(db.orm, f.workspaceId, 'not-a-uuid')).toBeNull();
      expect(await loadTeamAccess(db.orm, 'not-a-uuid', f.teams.eng.id)).toBeNull();
    });
  });

  it('an upper-case id is not canonical -> null, so one id has one spelling everywhere', async () => {
    await withTempDatabase(async (db) => {
      const f = await createWorkspaceFixture(db.orm);

      // Control: the canonical spelling loads, so the nulls below are decisions.
      expect(await loadActor(db.orm, f.workspaceId, f.members.owner.id)).not.toBeNull();
      expect(await loadActor(db.orm, f.workspaceId.toUpperCase(), f.members.owner.id)).toBeNull();
      expect(await loadActor(db.orm, f.workspaceId, f.members.owner.id.toUpperCase())).toBeNull();
      expect(await loadTeamAccess(db.orm, f.workspaceId.toUpperCase(), f.teams.eng.id)).toBeNull();
      expect(await loadTeamAccess(db.orm, f.workspaceId, f.teams.eng.id.toUpperCase())).toBeNull();
    });
  });

  it('loads the access data of a team of the same workspace', async () => {
    await withTempDatabase(async (db) => {
      const f = await createWorkspaceFixture(db.orm);

      const eng = await loadTeamAccess(db.orm, f.workspaceId, f.teams.eng.id);
      const ops = await loadTeamAccess(db.orm, f.workspaceId, f.teams.ops.id);

      expect(eng).toEqual({ id: f.teams.eng.id, workspaceId: f.workspaceId, private: false });
      expect(ops).toEqual({ id: f.teams.ops.id, workspaceId: f.workspaceId, private: true });
    });
  });

  it('team of another workspace -> null', async () => {
    await withTempDatabase(async (db) => {
      const a = await createWorkspaceFixture(db.orm);
      const b = await createWorkspaceFixture(db.orm);

      const access = await loadTeamAccess(db.orm, a.workspaceId, b.teams.eng.id);

      expect(access).toBeNull();
    });
  });
});
