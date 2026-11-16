import { auditLog, member, session, teamMember } from '@torch/shared/db/schema';
import type { Actor } from '@torch/shared/permissions';
import { and, eq, isNull } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { createSessionActorResolver } from '../auth/resolver.ts';
import type { Db } from '../db.ts';
import { loadActor } from '../permissions/load-actor.ts';
import {
  actorOf,
  auditRows,
  openSession,
  recordingBus,
  refusal,
  successOf,
  txidOf,
} from '../test/admin-helpers.ts';
import { addMember, createWorkspaceFixture, withTempDatabase } from '../test/fixtures.ts';
import { changeMemberRole, listMembers, setMemberActive, updateOwnProfile } from './service.ts';

const databaseUrl = process.env.DATABASE_URL;

// Integration: needs the dev compose Postgres (see db.test.ts). Skipped, loudly, when DATABASE_URL is not set.
if (!databaseUrl) {
  console.warn(
    '[members/service.test] SKIPPED the member administration tests: DATABASE_URL is not set. ' +
      'Start `docker compose -f docker-compose.dev.yml up -d --wait postgres` and set DATABASE_URL (see .env.example).',
  );
}

const UNKNOWN_UUID = '99999999-9999-4999-8999-999999999999';

const stored = async (db: Db, memberId: string) => {
  const [row] = await db.orm.select().from(member).where(eq(member.id, memberId));
  if (!row) throw new Error('member vanished');
  return row;
};

const activeOwners = async (db: Db, workspaceId: string) =>
  (
    await db.orm
      .select({ id: member.id })
      .from(member)
      .where(
        and(
          eq(member.workspaceId, workspaceId),
          eq(member.role, 'owner'),
          isNull(member.deactivatedAt),
        ),
      )
  ).length;

describe.skipIf(!databaseUrl)('changeMemberRole', () => {
  it('owner makes a member an admin: txid, new role, one audit row with from and to', async () => {
    await withTempDatabase(async (db) => {
      const f = await createWorkspaceFixture(db.orm);
      const owner = await actorOf(db, f.workspaceId, f.members.owner.id);

      const result = await changeMemberRole(db.orm, owner, f.members.member.id, 'admin');

      txidOf(result);
      expect((await stored(db, f.members.member.id)).role).toBe('admin');
      const audit = await auditRows(db, f.workspaceId);
      expect(audit).toHaveLength(1);
      expect(audit[0]).toMatchObject({
        action: 'member.role_changed',
        actorMemberId: f.members.owner.id,
        targetType: 'member',
        targetId: f.members.member.id,
        metadata: { from: 'member', to: 'admin' },
      });
    });
  });

  it('owner may promote to owner and demote an admin', async () => {
    await withTempDatabase(async (db) => {
      const f = await createWorkspaceFixture(db.orm);
      const owner = await actorOf(db, f.workspaceId, f.members.owner.id);

      txidOf(await changeMemberRole(db.orm, owner, f.members.admin.id, 'owner'));
      expect((await stored(db, f.members.admin.id)).role).toBe('owner');
      txidOf(await changeMemberRole(db.orm, owner, f.members.admin.id, 'guest'));
      expect((await stored(db, f.members.admin.id)).role).toBe('guest');
    });
  });

  it('admin switches a member to guest and back', async () => {
    await withTempDatabase(async (db) => {
      const f = await createWorkspaceFixture(db.orm);
      const admin = await actorOf(db, f.workspaceId, f.members.admin.id);

      txidOf(await changeMemberRole(db.orm, admin, f.members.member.id, 'guest'));
      expect((await stored(db, f.members.member.id)).role).toBe('guest');
      txidOf(await changeMemberRole(db.orm, admin, f.members.member.id, 'member'));
      expect((await stored(db, f.members.member.id)).role).toBe('member');
    });
  });

  it('admin cannot promote to admin or owner, nor touch an admin or an owner: 403, nothing changes', async () => {
    await withTempDatabase(async (db) => {
      const f = await createWorkspaceFixture(db.orm);
      const secondAdmin = await addMember(db.orm, f.workspaceId, 'admin');
      const admin = await actorOf(db, f.workspaceId, f.members.admin.id);

      const attempts = [
        await changeMemberRole(db.orm, admin, f.members.member.id, 'admin'),
        await changeMemberRole(db.orm, admin, f.members.member.id, 'owner'),
        await changeMemberRole(db.orm, admin, secondAdmin.id, 'member'),
        await changeMemberRole(db.orm, admin, f.members.owner.id, 'member'),
      ];

      for (const result of attempts) expect(result).toEqual(refusal('forbidden', 403));
      expect((await stored(db, f.members.member.id)).role).toBe('member');
      expect((await stored(db, secondAdmin.id)).role).toBe('admin');
      expect((await stored(db, f.members.owner.id)).role).toBe('owner');
      expect(await auditRows(db, f.workspaceId)).toHaveLength(0);
    });
  });

  it('nobody changes their own role: owner, admin, member and guest all get 403 forbidden', async () => {
    await withTempDatabase(async (db) => {
      const f = await createWorkspaceFixture(db.orm);

      for (const who of ['owner', 'admin', 'member', 'guest'] as const) {
        const actor = await actorOf(db, f.workspaceId, f.members[who].id);
        const result = await changeMemberRole(db.orm, actor, f.members[who].id, 'owner');
        expect(result, who).toEqual(refusal('forbidden', 403));
        expect((await stored(db, f.members[who].id)).role).toBe(who);
      }
    });
  });

  it('member and guest cannot change roles, even of a valid target: 403', async () => {
    await withTempDatabase(async (db) => {
      const f = await createWorkspaceFixture(db.orm);
      const target = await addMember(db.orm, f.workspaceId, 'member');

      for (const who of ['member', 'guest', 'outsider'] as const) {
        const actor = await actorOf(db, f.workspaceId, f.members[who].id);
        const result = await changeMemberRole(db.orm, actor, target.id, 'guest');
        expect(result, who).toEqual(refusal('forbidden', 403));
      }
      expect((await stored(db, target.id)).role).toBe('member');
    });
  });

  it('unknown, malformed and other-workspace ids: 404 not_found, the same for all', async () => {
    await withTempDatabase(async (db) => {
      const a = await createWorkspaceFixture(db.orm);
      const b = await createWorkspaceFixture(db.orm);
      const owner = await actorOf(db, a.workspaceId, a.members.owner.id);

      for (const id of [UNKNOWN_UUID, 'not-a-uuid', b.members.member.id]) {
        expect(await changeMemberRole(db.orm, owner, id, 'guest'), id).toEqual(
          refusal('not_found', 404),
        );
      }
      expect((await stored(db, b.members.member.id)).role).toBe('member');
    });
  });

  it('an unknown role is invalid_input 400', async () => {
    await withTempDatabase(async (db) => {
      const f = await createWorkspaceFixture(db.orm);
      const owner = await actorOf(db, f.workspaceId, f.members.owner.id);

      // @ts-expect-error a role outside MEMBER_ROLES must be refused even when the type says otherwise
      const result = await changeMemberRole(db.orm, owner, f.members.member.id, 'superuser');

      expect(result).toEqual(refusal('invalid_input', 400));
    });
  });

  it('the role the member already has is a 200 no-op without an audit row', async () => {
    await withTempDatabase(async (db) => {
      const f = await createWorkspaceFixture(db.orm);
      const admin = await actorOf(db, f.workspaceId, f.members.admin.id);

      txidOf(await changeMemberRole(db.orm, admin, f.members.member.id, 'member'));

      expect(await auditRows(db, f.workspaceId)).toHaveLength(0);
    });
  });

  it('an actor whose role changed since the request began is refused, nothing changes', async () => {
    await withTempDatabase(async (db) => {
      const f = await createWorkspaceFixture(db.orm);
      const staleAdmin = await actorOf(db, f.workspaceId, f.members.admin.id);
      await db.orm.update(member).set({ role: 'member' }).where(eq(member.id, f.members.admin.id));

      const result = await changeMemberRole(db.orm, staleAdmin, f.members.member.id, 'guest');

      expect(result).toEqual(refusal('forbidden', 403));
      expect((await stored(db, f.members.member.id)).role).toBe('member');
      expect(await auditRows(db, f.workspaceId)).toHaveLength(0);
    });
  });

  it('an actor deactivated since the request began is refused, nothing changes', async () => {
    await withTempDatabase(async (db) => {
      const f = await createWorkspaceFixture(db.orm);
      const staleOwner = await actorOf(db, f.workspaceId, f.members.owner.id);
      await db.orm
        .update(member)
        .set({ deactivatedAt: new Date() })
        .where(eq(member.id, f.members.owner.id));

      const result = await changeMemberRole(db.orm, staleOwner, f.members.member.id, 'guest');

      expect(result).toEqual(refusal('forbidden', 403));
      expect((await stored(db, f.members.member.id)).role).toBe('member');
    });
  });

  it('the only active owner cannot be demoted: 409 last_owner, even by an actor that was an owner a moment ago', async () => {
    await withTempDatabase(async (db) => {
      const f = await createWorkspaceFixture(db.orm);
      // An actor that still says "owner" while the database says "admin": the state a second owner's request is
      // in after the other owner demoted them first.
      const staleOwner: Actor = {
        ...(await actorOf(db, f.workspaceId, f.members.admin.id)),
        role: 'owner',
      };

      const result = await changeMemberRole(db.orm, staleOwner, f.members.owner.id, 'member');

      expect(result).toEqual(refusal('last_owner', 409));
      expect((await stored(db, f.members.owner.id)).role).toBe('owner');
      expect(await auditRows(db, f.workspaceId)).toHaveLength(0);
    });
  });

  it('a deactivated owner does not count as an owner, and demoting them is allowed', async () => {
    await withTempDatabase(async (db) => {
      const f = await createWorkspaceFixture(db.orm);
      const gone = await addMember(db.orm, f.workspaceId, 'owner');
      await db.orm.update(member).set({ deactivatedAt: new Date() }).where(eq(member.id, gone.id));
      const owner = await actorOf(db, f.workspaceId, f.members.owner.id);

      txidOf(await changeMemberRole(db.orm, owner, gone.id, 'member'));

      expect((await stored(db, gone.id)).role).toBe('member');
      expect(await activeOwners(db, f.workspaceId)).toBe(1);
    });
  });

  it('two owners demote each other at the same time: exactly one succeeds and one active owner remains', async () => {
    await withTempDatabase(async (db) => {
      // Rounds repeat the race with fresh workspaces; without the workspace lock both would read two owners.
      for (let round = 0; round < 6; round++) {
        const f = await createWorkspaceFixture(db.orm);
        const second = await addMember(db.orm, f.workspaceId, 'owner');
        const first = await actorOf(db, f.workspaceId, f.members.owner.id);
        const other = await actorOf(db, f.workspaceId, second.id);

        const results = await Promise.all([
          changeMemberRole(db.orm, first, second.id, 'member'),
          changeMemberRole(db.orm, other, f.members.owner.id, 'member'),
        ]);

        expect(
          results.filter((r) => r.ok),
          `round ${round}`,
        ).toHaveLength(1);
        expect(
          results.filter((r) => !r.ok),
          `round ${round}`,
        ).toEqual([refusal('last_owner', 409)]);
        expect(await activeOwners(db, f.workspaceId), `round ${round}`).toBe(1);
      }
    });
  });
});

describe.skipIf(!databaseUrl)('setMemberActive', () => {
  it('owner deactivates a member: deactivated_at set, one audit row, no txid problems', async () => {
    await withTempDatabase(async (db) => {
      const f = await createWorkspaceFixture(db.orm);
      const owner = await actorOf(db, f.workspaceId, f.members.owner.id);

      txidOf(await setMemberActive(db.orm, owner, f.members.member.id, false));

      expect((await stored(db, f.members.member.id)).deactivatedAt).toBeInstanceOf(Date);
      const audit = await auditRows(db, f.workspaceId);
      expect(audit).toHaveLength(1);
      expect(audit[0]).toMatchObject({
        action: 'member.deactivated',
        actorMemberId: f.members.owner.id,
        targetType: 'member',
        targetId: f.members.member.id,
      });
    });
  });

  it('revokes every session of the target in the same transaction; other members keep theirs', async () => {
    await withTempDatabase(async (db) => {
      const f = await createWorkspaceFixture(db.orm);
      const owner = await actorOf(db, f.workspaceId, f.members.owner.id);
      const resolver = createSessionActorResolver({
        orm: db.orm,
        appUrl: 'http://app.example.test',
      });
      const req = (cookie: string) =>
        new Request('http://app.example.test/api/x', { headers: { cookie } });
      const first = await openSession(db.orm, f.workspaceId, f.members.member.id);
      const second = await openSession(db.orm, f.workspaceId, f.members.member.id);
      const bystander = await openSession(db.orm, f.workspaceId, f.members.guest.id);
      expect((await resolver.resolveActor(req(first.cookie), f.workspaceId))?.role).toBe('member');

      txidOf(await setMemberActive(db.orm, owner, f.members.member.id, false));

      const rows = await db.orm
        .select()
        .from(session)
        .where(eq(session.memberId, f.members.member.id));
      expect(rows).toHaveLength(2);
      for (const row of rows) expect(row.revokedAt).toBeInstanceOf(Date);
      expect(await resolver.resolveActor(req(first.cookie), f.workspaceId)).toBeNull();
      expect(await resolver.resolveActor(req(second.cookie), f.workspaceId)).toBeNull();
      expect((await resolver.resolveActor(req(bystander.cookie), f.workspaceId))?.role).toBe(
        'guest',
      );
    });
  });

  it('reactivate clears deactivated_at, audits it, and leaves the old sessions revoked', async () => {
    await withTempDatabase(async (db) => {
      const f = await createWorkspaceFixture(db.orm);
      const owner = await actorOf(db, f.workspaceId, f.members.owner.id);
      const old = await openSession(db.orm, f.workspaceId, f.members.member.id);
      txidOf(await setMemberActive(db.orm, owner, f.members.member.id, false));

      txidOf(await setMemberActive(db.orm, owner, f.members.member.id, true));

      expect((await stored(db, f.members.member.id)).deactivatedAt).toBeNull();
      const audit = await auditRows(db, f.workspaceId);
      expect(audit.map((row) => row.action)).toEqual(['member.deactivated', 'member.reactivated']);
      const resolver = createSessionActorResolver({
        orm: db.orm,
        appUrl: 'http://app.example.test',
      });
      const actor = await resolver.resolveActor(
        new Request('http://app.example.test/api/x', { headers: { cookie: old.cookie } }),
        f.workspaceId,
      );
      expect(actor).toBeNull();
    });
  });

  it('deactivation keeps the team memberships (co-members still resolve their name); reactivation restores access with them', async () => {
    await withTempDatabase(async (db) => {
      const f = await createWorkspaceFixture(db.orm);
      const owner = await actorOf(db, f.workspaceId, f.members.owner.id);
      const teamsOf = async () =>
        (await db.orm.select().from(teamMember).where(eq(teamMember.memberId, f.members.member.id)))
          .map((row) => row.teamId)
          .sort();
      const before = await teamsOf();
      expect(before).toEqual([f.teams.eng.id, f.teams.ops.id].sort());

      txidOf(await setMemberActive(db.orm, owner, f.members.member.id, false));

      expect(await teamsOf()).toEqual(before);
      expect(await loadActor(db.orm, f.workspaceId, f.members.member.id)).toBeNull();

      txidOf(await setMemberActive(db.orm, owner, f.members.member.id, true));

      const restored = await loadActor(db.orm, f.workspaceId, f.members.member.id);
      expect([...(restored?.teamIds ?? [])].sort()).toEqual(before);
    });
  });

  it('deactivating a deactivated member, or reactivating an active one, is a 200 no-op without a second audit row', async () => {
    await withTempDatabase(async (db) => {
      const f = await createWorkspaceFixture(db.orm);
      const owner = await actorOf(db, f.workspaceId, f.members.owner.id);

      txidOf(await setMemberActive(db.orm, owner, f.members.member.id, true));
      expect(await auditRows(db, f.workspaceId)).toHaveLength(0);

      txidOf(await setMemberActive(db.orm, owner, f.members.member.id, false));
      const first = (await stored(db, f.members.member.id)).deactivatedAt;
      txidOf(await setMemberActive(db.orm, owner, f.members.member.id, false));

      expect((await stored(db, f.members.member.id)).deactivatedAt).toEqual(first);
      expect(await auditRows(db, f.workspaceId)).toHaveLength(1);
    });
  });

  it('admin deactivates and reactivates members and guests only', async () => {
    await withTempDatabase(async (db) => {
      const f = await createWorkspaceFixture(db.orm);
      const secondAdmin = await addMember(db.orm, f.workspaceId, 'admin');
      const admin = await actorOf(db, f.workspaceId, f.members.admin.id);

      txidOf(await setMemberActive(db.orm, admin, f.members.guest.id, false));
      txidOf(await setMemberActive(db.orm, admin, f.members.guest.id, true));

      expect(await setMemberActive(db.orm, admin, secondAdmin.id, false)).toEqual(
        refusal('forbidden', 403),
      );
      expect(await setMemberActive(db.orm, admin, f.members.owner.id, false)).toEqual(
        refusal('forbidden', 403),
      );
      // A deactivated admin cannot be brought back by an admin either.
      await db.orm
        .update(member)
        .set({ deactivatedAt: new Date() })
        .where(eq(member.id, secondAdmin.id));
      expect(await setMemberActive(db.orm, admin, secondAdmin.id, true)).toEqual(
        refusal('forbidden', 403),
      );
      expect((await stored(db, f.members.owner.id)).deactivatedAt).toBeNull();
    });
  });

  it('member and guest cannot deactivate anybody: 403', async () => {
    await withTempDatabase(async (db) => {
      const f = await createWorkspaceFixture(db.orm);
      for (const who of ['member', 'guest'] as const) {
        const actor = await actorOf(db, f.workspaceId, f.members[who].id);
        expect(await setMemberActive(db.orm, actor, f.members.outsider.id, false), who).toEqual(
          refusal('forbidden', 403),
        );
      }
      expect((await stored(db, f.members.outsider.id)).deactivatedAt).toBeNull();
    });
  });

  it('nobody deactivates themselves: the only owner, an admin, a member all get 403', async () => {
    await withTempDatabase(async (db) => {
      const f = await createWorkspaceFixture(db.orm);
      for (const who of ['owner', 'admin', 'member'] as const) {
        const actor = await actorOf(db, f.workspaceId, f.members[who].id);
        expect(await setMemberActive(db.orm, actor, f.members[who].id, false), who).toEqual(
          refusal('forbidden', 403),
        );
        expect((await stored(db, f.members[who].id)).deactivatedAt).toBeNull();
      }
    });
  });

  it('a second owner can be deactivated by an owner, never by an admin', async () => {
    await withTempDatabase(async (db) => {
      const f = await createWorkspaceFixture(db.orm);
      const second = await addMember(db.orm, f.workspaceId, 'owner');
      const admin = await actorOf(db, f.workspaceId, f.members.admin.id);
      const owner = await actorOf(db, f.workspaceId, f.members.owner.id);

      expect(await setMemberActive(db.orm, admin, second.id, false)).toEqual(
        refusal('forbidden', 403),
      );
      txidOf(await setMemberActive(db.orm, owner, second.id, false));

      expect((await stored(db, second.id)).deactivatedAt).toBeInstanceOf(Date);
      expect(await activeOwners(db, f.workspaceId)).toBe(1);
    });
  });

  it('unknown, malformed and other-workspace ids: 404', async () => {
    await withTempDatabase(async (db) => {
      const a = await createWorkspaceFixture(db.orm);
      const b = await createWorkspaceFixture(db.orm);
      const owner = await actorOf(db, a.workspaceId, a.members.owner.id);

      for (const id of [UNKNOWN_UUID, 'not-a-uuid', b.members.member.id]) {
        expect(await setMemberActive(db.orm, owner, id, false), id).toEqual(
          refusal('not_found', 404),
        );
      }
      expect((await stored(db, b.members.member.id)).deactivatedAt).toBeNull();
    });
  });

  it('an actor deactivated since the request began is refused', async () => {
    await withTempDatabase(async (db) => {
      const f = await createWorkspaceFixture(db.orm);
      const staleAdmin = await actorOf(db, f.workspaceId, f.members.admin.id);
      await db.orm
        .update(member)
        .set({ deactivatedAt: new Date() })
        .where(eq(member.id, f.members.admin.id));

      const result = await setMemberActive(db.orm, staleAdmin, f.members.guest.id, false);

      expect(result).toEqual(refusal('forbidden', 403));
      expect((await stored(db, f.members.guest.id)).deactivatedAt).toBeNull();
    });
  });

  it('two owners deactivate each other at the same time: exactly one succeeds and one active owner remains', async () => {
    await withTempDatabase(async (db) => {
      for (let round = 0; round < 6; round++) {
        const f = await createWorkspaceFixture(db.orm);
        const second = await addMember(db.orm, f.workspaceId, 'owner');
        const first = await actorOf(db, f.workspaceId, f.members.owner.id);
        const other = await actorOf(db, f.workspaceId, second.id);

        const results = await Promise.all([
          setMemberActive(db.orm, first, second.id, false),
          setMemberActive(db.orm, other, f.members.owner.id, false),
        ]);

        expect(
          results.filter((r) => r.ok),
          `round ${round}`,
        ).toHaveLength(1);
        expect(
          results.filter((r) => !r.ok),
          `round ${round}`,
        ).toEqual([refusal('last_owner', 409)]);
        expect(await activeOwners(db, f.workspaceId), `round ${round}`).toBe(1);
      }
    });
  });

  it('one owner demotes the other while the other deactivates them: one owner remains', async () => {
    await withTempDatabase(async (db) => {
      for (let round = 0; round < 6; round++) {
        const f = await createWorkspaceFixture(db.orm);
        const second = await addMember(db.orm, f.workspaceId, 'owner');
        const first = await actorOf(db, f.workspaceId, f.members.owner.id);
        const other = await actorOf(db, f.workspaceId, second.id);

        const results = await Promise.all([
          changeMemberRole(db.orm, first, second.id, 'member'),
          setMemberActive(db.orm, other, f.members.owner.id, false),
        ]);

        expect(
          results.filter((r) => r.ok),
          `round ${round}`,
        ).toHaveLength(1);
        expect(await activeOwners(db, f.workspaceId), `round ${round}`).toBe(1);
      }
    });
  });
});

describe.skipIf(!databaseUrl)('listMembers', () => {
  it('owner and admin get every member of the workspace with emails, deactivated ones included', async () => {
    await withTempDatabase(async (db) => {
      const f = await createWorkspaceFixture(db.orm);
      await createWorkspaceFixture(db.orm);
      const gone = await addMember(db.orm, f.workspaceId, 'member');
      await db.orm.update(member).set({ deactivatedAt: new Date() }).where(eq(member.id, gone.id));

      for (const who of ['owner', 'admin'] as const) {
        const actor = await actorOf(db, f.workspaceId, f.members[who].id);
        const list = successOf(await listMembers(db.orm, actor));

        expect(list.map((m) => m.id).sort(), who).toEqual(
          [...Object.values(f.members).map((m) => m.id), gone.id].sort(),
        );
        const owner = list.find((m) => m.id === f.members.owner.id);
        expect(owner).toEqual({
          id: f.members.owner.id,
          name: f.members.owner.name,
          handle: f.members.owner.handle,
          role: 'owner',
          email: f.members.owner.email,
          locale: 'en',
          deactivatedAt: null,
          createdAt: f.members.owner.createdAt.toISOString(),
        });
        expect(list.find((m) => m.id === gone.id)?.deactivatedAt).toEqual(expect.any(String));
      }
    });
  });

  it('member and guest get 403, never the emails', async () => {
    await withTempDatabase(async (db) => {
      const f = await createWorkspaceFixture(db.orm);
      for (const who of ['member', 'guest', 'outsider'] as const) {
        const actor = await actorOf(db, f.workspaceId, f.members[who].id);
        expect(await listMembers(db.orm, actor), who).toEqual(refusal('forbidden', 403));
      }
    });
  });
});

describe.skipIf(!databaseUrl)('updateOwnProfile', () => {
  it('changes name, locale and timezone of the caller only, and audits the field names, not the values', async () => {
    await withTempDatabase(async (db) => {
      const f = await createWorkspaceFixture(db.orm);
      const actor = await actorOf(db, f.workspaceId, f.members.member.id);
      const before = await stored(db, f.members.admin.id);

      const result = await updateOwnProfile(db.orm, actor, {
        name: 'Ada Lovelace',
        locale: 'it',
        timezone: 'Europe/Rome',
      });

      txidOf(result);
      expect(await stored(db, f.members.member.id)).toMatchObject({
        name: 'Ada Lovelace',
        locale: 'it',
        timezone: 'Europe/Rome',
        handle: 'member',
        role: 'member',
        email: f.members.member.email,
      });
      expect(await stored(db, f.members.admin.id)).toEqual(before);
      const audit = await auditRows(db, f.workspaceId);
      expect(audit).toHaveLength(1);
      expect(audit[0]).toMatchObject({
        action: 'member.profile_updated',
        actorMemberId: f.members.member.id,
        targetType: 'member',
        targetId: f.members.member.id,
      });
      expect(JSON.stringify(audit[0]?.metadata)).not.toContain('Ada');
      expect(JSON.stringify(audit[0]?.metadata)).not.toContain('Rome');
    });
  });

  it('every role edits their own profile, a guest included', async () => {
    await withTempDatabase(async (db) => {
      const f = await createWorkspaceFixture(db.orm);
      for (const who of ['owner', 'admin', 'member', 'guest'] as const) {
        const actor = await actorOf(db, f.workspaceId, f.members[who].id);
        txidOf(await updateOwnProfile(db.orm, actor, { name: `New ${who}` }));
        expect((await stored(db, f.members[who].id)).name).toBe(`New ${who}`);
      }
    });
  });

  it('handle clash inside the workspace: 409 handle_taken; the same handle in another workspace is fine', async () => {
    await withTempDatabase(async (db) => {
      const a = await createWorkspaceFixture(db.orm);
      const b = await createWorkspaceFixture(db.orm);
      await db.orm
        .update(member)
        .set({ handle: 'shared' })
        .where(eq(member.id, b.members.owner.id));
      const actor = await actorOf(db, a.workspaceId, a.members.member.id);

      expect(await updateOwnProfile(db.orm, actor, { handle: 'admin' })).toEqual(
        refusal('handle_taken', 409),
      );
      expect((await stored(db, a.members.member.id)).handle).toBe('member');
      expect(await auditRows(db, a.workspaceId)).toHaveLength(0);

      txidOf(await updateOwnProfile(db.orm, actor, { handle: 'shared' }));
      expect((await stored(db, a.members.member.id)).handle).toBe('shared');
      // Keeping one's own handle is not a clash.
      txidOf(await updateOwnProfile(db.orm, actor, { handle: 'shared' }));
    });
  });

  it('empty input, role, email and unknown fields are invalid_input 400: a profile cannot grant anything', async () => {
    await withTempDatabase(async (db) => {
      const f = await createWorkspaceFixture(db.orm);
      const actor = await actorOf(db, f.workspaceId, f.members.member.id);
      const bad = [
        {},
        { role: 'owner' },
        { email: 'x@example.test' },
        { name: 'Ok', deactivatedAt: null },
        { handle: 'Upper' },
        { timezone: 'Mars/Base' },
        { locale: 'fr' },
      ];

      for (const input of bad) {
        // @ts-expect-error the service must not rely on the compile-time type
        expect(await updateOwnProfile(db.orm, actor, input), JSON.stringify(input)).toEqual(
          refusal('invalid_input', 400),
        );
      }
      const row = await stored(db, f.members.member.id);
      expect(row).toMatchObject({ role: 'member', email: f.members.member.email });
      expect(await auditRows(db, f.workspaceId)).toHaveLength(0);
    });
  });

  it('a deactivated actor cannot edit: 403, nothing changes', async () => {
    await withTempDatabase(async (db) => {
      const f = await createWorkspaceFixture(db.orm);
      const actor = await actorOf(db, f.workspaceId, f.members.member.id);
      await db.orm
        .update(member)
        .set({ deactivatedAt: new Date() })
        .where(eq(member.id, f.members.member.id));

      const result = await updateOwnProfile(db.orm, actor, { name: 'Late' });

      expect(result).toEqual(refusal('forbidden', 403));
      expect((await stored(db, f.members.member.id)).name).toBe(f.members.member.name);
    });
  });

  it('audit rows never hold emails or typed text', async () => {
    await withTempDatabase(async (db) => {
      const f = await createWorkspaceFixture(db.orm);
      const owner = await actorOf(db, f.workspaceId, f.members.owner.id);
      txidOf(await changeMemberRole(db.orm, owner, f.members.member.id, 'admin'));
      txidOf(await setMemberActive(db.orm, owner, f.members.guest.id, false));
      txidOf(await updateOwnProfile(db.orm, owner, { name: 'Private Name' }));

      const rows = await db.orm
        .select()
        .from(auditLog)
        .where(eq(auditLog.workspaceId, f.workspaceId));
      const text = JSON.stringify(rows);
      expect(text).not.toContain('@');
      expect(text).not.toContain('Private Name');
    });
  });
});

describe.skipIf(!databaseUrl)('member changes signal the access bus', () => {
  it('a role change tells the bus about that member, after the commit; the same role tells nobody', async () => {
    await withTempDatabase(async (db) => {
      const f = await createWorkspaceFixture(db.orm);
      const owner = await actorOf(db, f.workspaceId, f.members.owner.id);
      const bus = recordingBus(
        async () =>
          (await db.pool.query('select role from member where id = $1', [f.members.member.id]))
            .rows[0]?.role,
      );

      successOf(await changeMemberRole(db.orm, owner, f.members.member.id, 'member', bus));
      expect(bus.calls).toEqual([]);
      successOf(await changeMemberRole(db.orm, owner, f.members.member.id, 'guest', bus));

      expect(bus.calls).toEqual([{ workspaceId: f.workspaceId, memberIds: [f.members.member.id] }]);
      expect(await bus.probed()).toEqual(['guest']);
    });
  });

  it('a refused role change tells nobody', async () => {
    await withTempDatabase(async (db) => {
      const f = await createWorkspaceFixture(db.orm);
      const member = await actorOf(db, f.workspaceId, f.members.member.id);
      const bus = recordingBus();

      expect((await changeMemberRole(db.orm, member, f.members.guest.id, 'admin', bus)).ok).toBe(
        false,
      );

      expect(bus.calls).toEqual([]);
    });
  });

  it('deactivating and reactivating tell the bus about that member; repeating either tells nobody', async () => {
    await withTempDatabase(async (db) => {
      const f = await createWorkspaceFixture(db.orm);
      const owner = await actorOf(db, f.workspaceId, f.members.owner.id);
      const bus = recordingBus(
        async () =>
          (
            await db.pool.query(
              'select deactivated_at is null as active from member where id = $1',
              [f.members.member.id],
            )
          ).rows[0]?.active,
      );

      successOf(await setMemberActive(db.orm, owner, f.members.member.id, true, bus));
      expect(bus.calls).toEqual([]);
      successOf(await setMemberActive(db.orm, owner, f.members.member.id, false, bus));
      successOf(await setMemberActive(db.orm, owner, f.members.member.id, false, bus));
      successOf(await setMemberActive(db.orm, owner, f.members.member.id, true, bus));

      const told = { workspaceId: f.workspaceId, memberIds: [f.members.member.id] };
      expect(bus.calls).toEqual([told, told]);
      expect(await bus.probed()).toEqual([false, true]);
    });
  });

  it('a refused deactivation tells nobody', async () => {
    await withTempDatabase(async (db) => {
      const f = await createWorkspaceFixture(db.orm);
      const guest = await actorOf(db, f.workspaceId, f.members.guest.id);
      const bus = recordingBus();

      expect((await setMemberActive(db.orm, guest, f.members.member.id, false, bus)).ok).toBe(
        false,
      );

      expect(bus.calls).toEqual([]);
    });
  });
});
