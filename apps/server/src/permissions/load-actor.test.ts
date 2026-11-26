import { member, team, teamMember } from '@torch/shared/db/schema';
import { and, eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { addMember, createWorkspaceFixture, withTempDatabase } from '../test/fixtures.ts';
import {
  loadActor,
  loadTeamAccess,
  loadVisibleMemberIds,
  loadVisibleTeamIds,
} from './load-actor.ts';

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

describe.skipIf(!databaseUrl)('loadVisibleMemberIds (Postgres)', () => {
  const sorted = (ids: string[]) => [...ids].sort();

  it('owner, admin and member see the whole workspace', async () => {
    await withTempDatabase(async (db) => {
      const f = await createWorkspaceFixture(db.orm);

      for (const who of ['owner', 'admin', 'member', 'outsider'] as const) {
        const actor = await loadActor(db.orm, f.workspaceId, f.members[who].id);

        expect(await loadVisibleMemberIds(db.orm, actor as NonNullable<typeof actor>), who).toBe(
          'all',
        );
      }
    });
  });

  it('a guest sees self plus the members sharing a team, sorted, and not the outsider', async () => {
    await withTempDatabase(async (db) => {
      const f = await createWorkspaceFixture(db.orm);
      const guest = await loadActor(db.orm, f.workspaceId, f.members.guest.id);

      const ids = await loadVisibleMemberIds(db.orm, guest as NonNullable<typeof guest>);

      expect(ids).toEqual(
        sorted([f.members.guest.id, f.members.owner.id, f.members.admin.id, f.members.member.id]),
      );
      expect(ids).not.toContain(f.members.outsider.id);
    });
  });

  it('a guest in no team sees only themselves', async () => {
    await withTempDatabase(async (db) => {
      const f = await createWorkspaceFixture(db.orm);
      const lonely = await addMember(db.orm, f.workspaceId, 'guest');
      const actor = await loadActor(db.orm, f.workspaceId, lonely.id);

      expect(await loadVisibleMemberIds(db.orm, actor as NonNullable<typeof actor>)).toEqual([
        lonely.id,
      ]);
    });
  });

  it('a guest in two teams sees the union, each member once', async () => {
    await withTempDatabase(async (db) => {
      const f = await createWorkspaceFixture(db.orm);
      const opsOnly = await addMember(db.orm, f.workspaceId, 'member', {
        teamIds: [f.teams.ops.id],
      });
      await db.orm.insert(teamMember).values({
        workspaceId: f.workspaceId,
        teamId: f.teams.ops.id,
        memberId: f.members.guest.id,
      });
      const guest = await loadActor(db.orm, f.workspaceId, f.members.guest.id);

      const ids = await loadVisibleMemberIds(db.orm, guest as NonNullable<typeof guest>);

      // The owner and the member are in both teams and still appear once.
      expect(ids).toEqual(
        sorted([
          f.members.guest.id,
          f.members.owner.id,
          f.members.admin.id,
          f.members.member.id,
          opsOnly.id,
        ]),
      );
      expect(ids).not.toContain(f.members.outsider.id);
    });
  });

  it('deactivated co-members stay in the list so their names resolve', async () => {
    await withTempDatabase(async (db) => {
      const f = await createWorkspaceFixture(db.orm);
      await db.orm
        .update(member)
        .set({ deactivatedAt: new Date() })
        .where(eq(member.id, f.members.admin.id));
      const guest = await loadActor(db.orm, f.workspaceId, f.members.guest.id);

      const ids = await loadVisibleMemberIds(db.orm, guest as NonNullable<typeof guest>);

      expect(ids).toContain(f.members.admin.id);
    });
  });

  it('the list follows the team memberships at the time of the call', async () => {
    await withTempDatabase(async (db) => {
      const f = await createWorkspaceFixture(db.orm);
      const colleague = await addMember(db.orm, f.workspaceId, 'member', {
        teamIds: [f.teams.eng.id],
      });
      const idsFor = async () => {
        const guest = await loadActor(db.orm, f.workspaceId, f.members.guest.id);
        return loadVisibleMemberIds(db.orm, guest as NonNullable<typeof guest>);
      };

      expect(await idsFor()).toContain(colleague.id);
      await db.orm
        .delete(teamMember)
        .where(and(eq(teamMember.teamId, f.teams.eng.id), eq(teamMember.memberId, colleague.id)));
      expect(await idsFor()).not.toContain(colleague.id);
    });
  });

  it('never returns a member of another workspace', async () => {
    await withTempDatabase(async (db) => {
      const a = await createWorkspaceFixture(db.orm);
      const b = await createWorkspaceFixture(db.orm);
      const guest = await loadActor(db.orm, a.workspaceId, a.members.guest.id);

      const ids = await loadVisibleMemberIds(db.orm, guest as NonNullable<typeof guest>);

      for (const other of Object.values(b.members)) expect(ids).not.toContain(other.id);
    });
  });

  it('is scoped by the actor, not by anything else: a guest actor of workspace A with B team ids sees nothing of B', async () => {
    await withTempDatabase(async (db) => {
      const a = await createWorkspaceFixture(db.orm);
      const b = await createWorkspaceFixture(db.orm);
      const guest = await loadActor(db.orm, a.workspaceId, a.members.guest.id);
      // A tampered actor: its team set names a team of workspace B.
      const tampered = {
        ...(guest as NonNullable<typeof guest>),
        teamIds: new Set([b.teams.eng.id]),
      };

      const ids = await loadVisibleMemberIds(db.orm, tampered);

      expect(ids).toEqual([a.members.guest.id]);
    });
  });
});

describe.skipIf(!databaseUrl)('loadVisibleTeamIds (Postgres)', () => {
  const sorted = (ids: string[]) => [...ids].sort();
  const actorOf = async (
    db: Parameters<Parameters<typeof withTempDatabase>[0]>[0],
    workspaceId: string,
    memberId: string,
  ) => {
    const actor = await loadActor(db.orm, workspaceId, memberId);
    return actor as NonNullable<typeof actor>;
  };

  it('a member sees the public team and the private team they are in', async () => {
    await withTempDatabase(async (db) => {
      const f = await createWorkspaceFixture(db.orm);

      const ids = await loadVisibleTeamIds(
        db.orm,
        await actorOf(db, f.workspaceId, f.members.member.id),
      );

      expect(ids).toEqual(sorted([f.teams.eng.id, f.teams.ops.id]));
    });
  });

  it('an owner outside the private team sees the public team only; a guest sees only their own team', async () => {
    await withTempDatabase(async (db) => {
      const f = await createWorkspaceFixture(db.orm);
      await db.orm
        .delete(teamMember)
        .where(
          and(eq(teamMember.teamId, f.teams.ops.id), eq(teamMember.memberId, f.members.owner.id)),
        );

      for (const who of ['owner', 'guest', 'outsider'] as const) {
        const ids = await loadVisibleTeamIds(
          db.orm,
          await actorOf(db, f.workspaceId, f.members[who].id),
        );
        expect(ids, who).toEqual([f.teams.eng.id]);
      }
    });
  });

  it('a guest in no team sees nothing', async () => {
    await withTempDatabase(async (db) => {
      const f = await createWorkspaceFixture(db.orm);
      const lonely = await addMember(db.orm, f.workspaceId, 'guest');

      expect(await loadVisibleTeamIds(db.orm, await actorOf(db, f.workspaceId, lonely.id))).toEqual(
        [],
      );
    });
  });

  it('follows the stored memberships, not the team set the actor object holds', async () => {
    await withTempDatabase(async (db) => {
      const f = await createWorkspaceFixture(db.orm);
      // Loaded while still in OPS, then removed: a stale actor must not keep the private team.
      const stale = await actorOf(db, f.workspaceId, f.members.member.id);
      expect([...stale.teamIds]).toContain(f.teams.ops.id);
      await db.orm
        .delete(teamMember)
        .where(
          and(eq(teamMember.teamId, f.teams.ops.id), eq(teamMember.memberId, f.members.member.id)),
        );

      expect(await loadVisibleTeamIds(db.orm, stale)).toEqual([f.teams.eng.id]);

      // And a team set that names a team of another workspace adds nothing.
      const other = await createWorkspaceFixture(db.orm);
      const tampered = { ...stale, teamIds: new Set([other.teams.ops.id, other.teams.eng.id]) };
      expect(await loadVisibleTeamIds(db.orm, tampered)).toEqual([f.teams.eng.id]);
    });
  });

  it('a team that turns private drops out for a member who is not in it', async () => {
    await withTempDatabase(async (db) => {
      const f = await createWorkspaceFixture(db.orm);
      await db.orm.update(team).set({ private: true }).where(eq(team.id, f.teams.eng.id));
      await db.orm
        .delete(teamMember)
        .where(
          and(eq(teamMember.teamId, f.teams.eng.id), eq(teamMember.memberId, f.members.member.id)),
        );

      const ids = await loadVisibleTeamIds(
        db.orm,
        await actorOf(db, f.workspaceId, f.members.member.id),
      );

      expect(ids).toEqual([f.teams.ops.id]);
    });
  });

  it('never lists a team of another workspace', async () => {
    await withTempDatabase(async (db) => {
      const a = await createWorkspaceFixture(db.orm);
      const b = await createWorkspaceFixture(db.orm);

      const ids = await loadVisibleTeamIds(
        db.orm,
        await actorOf(db, a.workspaceId, a.members.owner.id),
      );

      expect(ids).toEqual(sorted([a.teams.eng.id, a.teams.ops.id]));
      expect(ids).not.toContain(b.teams.eng.id);
    });
  });
});
