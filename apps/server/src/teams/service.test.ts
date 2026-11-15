import { member, team, teamMember, workflowState } from '@torch/shared/db/schema';
import { and, asc, eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import type { Db } from '../db.ts';
import { updateIssue } from '../issues/update-issue.ts';
import { loadActor } from '../permissions/load-actor.ts';
import { actorOf, auditRows, refusal, successOf, txidOf } from '../test/admin-helpers.ts';
import {
  addMember,
  createWorkspaceFixture,
  type WorkspaceFixture,
  withTempDatabase,
} from '../test/fixtures.ts';
import {
  addTeamMember,
  createTeam,
  listPrivateTeamDirectory,
  removeTeamMember,
  updateTeam,
} from './service.ts';

const databaseUrl = process.env.DATABASE_URL;

// Integration: needs the dev compose Postgres (see db.test.ts). Skipped, loudly, when DATABASE_URL is not set.
if (!databaseUrl) {
  console.warn(
    '[teams/service.test] SKIPPED the team administration tests: DATABASE_URL is not set. ' +
      'Start `docker compose -f docker-compose.dev.yml up -d --wait postgres` and set DATABASE_URL (see .env.example).',
  );
}

const UNKNOWN_UUID = '99999999-9999-4999-8999-999999999999';

const teamRow = async (db: Db, teamId: string) => {
  const [row] = await db.orm.select().from(team).where(eq(team.id, teamId));
  if (!row) throw new Error('team vanished');
  return row;
};

const membersOf = async (db: Db, teamId: string) =>
  (await db.orm.select().from(teamMember).where(eq(teamMember.teamId, teamId)))
    .map((row) => row.memberId)
    .sort();

const teamIdsOf = async (db: Db, f: WorkspaceFixture, memberId: string) =>
  (await loadActor(db.orm, f.workspaceId, memberId))?.teamIds;

describe.skipIf(!databaseUrl)('createTeam', () => {
  it('owner and admin create a team: id and txid back, the creator is its only member, issue counter 0', async () => {
    await withTempDatabase(async (db) => {
      const f = await createWorkspaceFixture(db.orm);

      for (const [who, key] of [
        ['owner', 'DOCS'],
        ['admin', 'DSGN'],
      ] as const) {
        const actor = await actorOf(db, f.workspaceId, f.members[who].id);
        const result = await createTeam(db.orm, actor, { key, name: `  ${key} team ` });

        const { teamId, txid } = successOf(result);
        expect(Number.isInteger(txid) && txid > 0, who).toBe(true);
        expect(await teamRow(db, teamId)).toMatchObject({
          workspaceId: f.workspaceId,
          key,
          name: `${key} team`,
          private: false,
          issueCounter: 0,
        });
        expect(await membersOf(db, teamId), who).toEqual([f.members[who].id]);
        expect((await teamIdsOf(db, f, f.members[who].id))?.has(teamId), who).toBe(true);
      }
    });
  });

  it('the new team has exactly the six default workflow states in order', async () => {
    await withTempDatabase(async (db) => {
      const f = await createWorkspaceFixture(db.orm);
      const owner = await actorOf(db, f.workspaceId, f.members.owner.id);

      const { teamId } = successOf(await createTeam(db.orm, owner, { key: 'DOCS', name: 'Docs' }));

      const states = await db.orm
        .select()
        .from(workflowState)
        .where(eq(workflowState.teamId, teamId))
        .orderBy(asc(workflowState.position));
      expect(states.map((s) => s.type)).toEqual([
        'triage',
        'backlog',
        'unstarted',
        'started',
        'completed',
        'canceled',
      ]);
      expect(states.map((s) => s.position)).toEqual([0, 1, 2, 3, 4, 5]);
      for (const state of states) expect(state.workspaceId).toBe(f.workspaceId);
    });
  });

  it('private: true makes a private team, visible to its creator', async () => {
    await withTempDatabase(async (db) => {
      const f = await createWorkspaceFixture(db.orm);
      const admin = await actorOf(db, f.workspaceId, f.members.admin.id);

      const { teamId } = successOf(
        await createTeam(db.orm, admin, { key: 'SEC', name: 'Security', private: true }),
      );

      expect((await teamRow(db, teamId)).private).toBe(true);
      expect(await membersOf(db, teamId)).toEqual([f.members.admin.id]);
    });
  });

  it('member, guest and a member outside every team cannot create a team: 403, nothing is written', async () => {
    await withTempDatabase(async (db) => {
      const f = await createWorkspaceFixture(db.orm);
      const before = (await db.orm.select().from(team)).length;

      for (const who of ['member', 'guest', 'outsider'] as const) {
        const actor = await actorOf(db, f.workspaceId, f.members[who].id);
        expect(await createTeam(db.orm, actor, { key: 'NOPE', name: 'No' }), who).toEqual(
          refusal('forbidden', 403),
        );
      }
      expect((await db.orm.select().from(team)).length).toBe(before);
    });
  });

  it('duplicate key in the workspace: 409 team_key_taken and nothing half-written; the same key in another workspace is fine', async () => {
    await withTempDatabase(async (db) => {
      const a = await createWorkspaceFixture(db.orm);
      const b = await createWorkspaceFixture(db.orm);
      const ownerA = await actorOf(db, a.workspaceId, a.members.owner.id);
      const ownerB = await actorOf(db, b.workspaceId, b.members.owner.id);
      const statesBefore = (await db.orm.select().from(workflowState)).length;
      const auditBefore = (await auditRows(db, a.workspaceId)).length;

      expect(await createTeam(db.orm, ownerA, { key: 'ENG', name: 'Again' })).toEqual(
        refusal('team_key_taken', 409),
      );

      expect((await db.orm.select().from(workflowState)).length).toBe(statesBefore);
      expect((await auditRows(db, a.workspaceId)).length).toBe(auditBefore);
      successOf(await createTeam(db.orm, ownerB, { key: 'LONE', name: 'In B' }));
      successOf(await createTeam(db.orm, ownerA, { key: 'LONE', name: 'Same key in A' }));
    });
  });

  it('two creations of the same key at the same time: exactly one succeeds', async () => {
    await withTempDatabase(async (db) => {
      const f = await createWorkspaceFixture(db.orm);
      const owner = await actorOf(db, f.workspaceId, f.members.owner.id);
      const admin = await actorOf(db, f.workspaceId, f.members.admin.id);

      const results = await Promise.all([
        createTeam(db.orm, owner, { key: 'RACE', name: 'One' }),
        createTeam(db.orm, admin, { key: 'RACE', name: 'Two' }),
      ]);

      expect(results.filter((r) => r.ok)).toHaveLength(1);
      expect(results.filter((r) => !r.ok)).toEqual([refusal('team_key_taken', 409)]);
      const rows = await db.orm
        .select()
        .from(team)
        .where(and(eq(team.workspaceId, f.workspaceId), eq(team.key, 'RACE')));
      expect(rows).toHaveLength(1);
    });
  });

  it('a lower-case key, an empty name and unknown fields are invalid_input 400', async () => {
    await withTempDatabase(async (db) => {
      const f = await createWorkspaceFixture(db.orm);
      const owner = await actorOf(db, f.workspaceId, f.members.owner.id);

      for (const input of [
        { key: 'docs', name: 'Docs' },
        { key: 'TOOLONGKEY', name: 'Docs' },
        { key: 'DOCS', name: '   ' },
        { key: 'DOCS', name: 'Docs', workspaceId: f.workspaceId },
        { name: 'No key' },
      ]) {
        // @ts-expect-error the service must not rely on the compile-time type
        expect(await createTeam(db.orm, owner, input), JSON.stringify(input)).toEqual(
          refusal('invalid_input', 400),
        );
      }
    });
  });

  it('an actor demoted since the request began cannot create a team', async () => {
    await withTempDatabase(async (db) => {
      const f = await createWorkspaceFixture(db.orm);
      const staleAdmin = await actorOf(db, f.workspaceId, f.members.admin.id);
      await db.orm.update(member).set({ role: 'member' }).where(eq(member.id, f.members.admin.id));

      expect(await createTeam(db.orm, staleAdmin, { key: 'LATE', name: 'Late' })).toEqual(
        refusal('forbidden', 403),
      );
    });
  });

  it('writes one audit row with ids and flags only: no key, no name', async () => {
    await withTempDatabase(async (db) => {
      const f = await createWorkspaceFixture(db.orm);
      const owner = await actorOf(db, f.workspaceId, f.members.owner.id);

      const { teamId } = successOf(
        await createTeam(db.orm, owner, { key: 'DOCS', name: 'Secret Name', private: true }),
      );

      const audit = await auditRows(db, f.workspaceId);
      expect(audit).toHaveLength(1);
      expect(audit[0]).toMatchObject({
        action: 'team.created',
        actorMemberId: f.members.owner.id,
        targetType: 'team',
        targetId: teamId,
        metadata: { private: true },
      });
      expect(JSON.stringify(audit[0])).not.toContain('Secret Name');
    });
  });
});

describe.skipIf(!databaseUrl)('updateTeam', () => {
  it('owner and admin rename a team and toggle its privacy; one audit row per change', async () => {
    await withTempDatabase(async (db) => {
      const f = await createWorkspaceFixture(db.orm);
      const admin = await actorOf(db, f.workspaceId, f.members.admin.id);
      const owner = await actorOf(db, f.workspaceId, f.members.owner.id);

      txidOf(await updateTeam(db.orm, admin, f.teams.eng.id, { name: ' Platform ' }));
      txidOf(await updateTeam(db.orm, owner, f.teams.eng.id, { private: true }));

      expect(await teamRow(db, f.teams.eng.id)).toMatchObject({
        name: 'Platform',
        private: true,
        key: 'ENG',
      });
      const audit = await auditRows(db, f.workspaceId);
      expect(audit.map((row) => [row.action, row.targetType, row.targetId, row.metadata])).toEqual([
        ['team.updated', 'team', f.teams.eng.id, { renamed: true }],
        ['team.updated', 'team', f.teams.eng.id, { private: true }],
      ]);
    });
  });

  it('making a team private needs a member: the creator alone is enough, an empty team is 409', async () => {
    await withTempDatabase(async (db) => {
      const f = await createWorkspaceFixture(db.orm);
      const owner = await actorOf(db, f.workspaceId, f.members.owner.id);
      const { teamId } = successOf(await createTeam(db.orm, owner, { key: 'DOCS', name: 'Docs' }));
      txidOf(await updateTeam(db.orm, owner, teamId, { private: true }));
      txidOf(await updateTeam(db.orm, owner, teamId, { private: false }));
      await db.orm.delete(teamMember).where(eq(teamMember.teamId, teamId));

      expect(await updateTeam(db.orm, owner, teamId, { private: true })).toEqual(
        refusal('private_team_needs_member', 409),
      );

      expect((await teamRow(db, teamId)).private).toBe(false);
    });
  });

  it('the key is immutable, an empty update is invalid_input, an update that changes nothing is a no-op', async () => {
    await withTempDatabase(async (db) => {
      const f = await createWorkspaceFixture(db.orm);
      const owner = await actorOf(db, f.workspaceId, f.members.owner.id);

      // @ts-expect-error `key` is not an update field
      expect(await updateTeam(db.orm, owner, f.teams.eng.id, { key: 'NEW' })).toEqual(
        refusal('invalid_input', 400),
      );
      expect(await updateTeam(db.orm, owner, f.teams.eng.id, {})).toEqual(
        refusal('invalid_input', 400),
      );
      txidOf(
        await updateTeam(db.orm, owner, f.teams.eng.id, {
          name: f.teams.eng.name,
          private: false,
        }),
      );

      expect((await teamRow(db, f.teams.eng.id)).key).toBe('ENG');
      expect(await auditRows(db, f.workspaceId)).toHaveLength(0);
    });
  });

  it('member and guest of a team they see: 403; a private team they cannot see: 404, the same for guest and outsider', async () => {
    await withTempDatabase(async (db) => {
      const f = await createWorkspaceFixture(db.orm);

      for (const who of ['member', 'guest'] as const) {
        const actor = await actorOf(db, f.workspaceId, f.members[who].id);
        expect(await updateTeam(db.orm, actor, f.teams.eng.id, { name: 'Mine' }), who).toEqual(
          refusal('forbidden', 403),
        );
      }
      const outsider = await actorOf(db, f.workspaceId, f.members.outsider.id);
      const guest = await actorOf(db, f.workspaceId, f.members.guest.id);
      const inOps = await actorOf(db, f.workspaceId, f.members.member.id);
      expect(await updateTeam(db.orm, outsider, f.teams.ops.id, { name: 'x' })).toEqual(
        refusal('not_found', 404),
      );
      expect(await updateTeam(db.orm, guest, f.teams.ops.id, { name: 'x' })).toEqual(
        refusal('not_found', 404),
      );
      expect(await updateTeam(db.orm, inOps, f.teams.ops.id, { name: 'x' })).toEqual(
        refusal('forbidden', 403),
      );
      expect((await teamRow(db, f.teams.eng.id)).name).toBe(f.teams.eng.name);
      expect((await teamRow(db, f.teams.ops.id)).name).toBe(f.teams.ops.name);
    });
  });

  it('a private team is invisible to an admin who is not in it: 404 until they join', async () => {
    await withTempDatabase(async (db) => {
      const f = await createWorkspaceFixture(db.orm);
      const admin = await actorOf(db, f.workspaceId, f.members.admin.id);

      expect(await updateTeam(db.orm, admin, f.teams.ops.id, { name: 'Renamed' })).toEqual(
        refusal('not_found', 404),
      );
      expect((await teamRow(db, f.teams.ops.id)).name).toBe(f.teams.ops.name);

      const owner = await actorOf(db, f.workspaceId, f.members.owner.id);
      txidOf(await addTeamMember(db.orm, owner, f.teams.ops.id, f.members.admin.id));
      const joined = await actorOf(db, f.workspaceId, f.members.admin.id);
      txidOf(await updateTeam(db.orm, joined, f.teams.ops.id, { name: 'Renamed' }));
      expect((await teamRow(db, f.teams.ops.id)).name).toBe('Renamed');
    });
  });

  it('unknown, malformed and other-workspace team ids: 404', async () => {
    await withTempDatabase(async (db) => {
      const a = await createWorkspaceFixture(db.orm);
      const b = await createWorkspaceFixture(db.orm);
      const owner = await actorOf(db, a.workspaceId, a.members.owner.id);

      for (const id of [UNKNOWN_UUID, 'not-a-uuid', b.teams.eng.id]) {
        expect(await updateTeam(db.orm, owner, id, { name: 'x' }), id).toEqual(
          refusal('not_found', 404),
        );
      }
      expect((await teamRow(db, b.teams.eng.id)).name).toBe(b.teams.eng.name);
    });
  });
});

describe.skipIf(!databaseUrl)('addTeamMember', () => {
  it('owner adds a member to a team: the row, one audit row with the team and role, and the member sees the team', async () => {
    await withTempDatabase(async (db) => {
      const f = await createWorkspaceFixture(db.orm);
      const owner = await actorOf(db, f.workspaceId, f.members.owner.id);

      txidOf(await addTeamMember(db.orm, owner, f.teams.eng.id, f.members.outsider.id));

      expect(await membersOf(db, f.teams.eng.id)).toContain(f.members.outsider.id);
      expect((await teamIdsOf(db, f, f.members.outsider.id))?.has(f.teams.eng.id)).toBe(true);
      const audit = await auditRows(db, f.workspaceId);
      expect(audit).toHaveLength(1);
      expect(audit[0]).toMatchObject({
        action: 'team.member_added',
        actorMemberId: f.members.owner.id,
        targetType: 'team_member',
        targetId: f.members.outsider.id,
        metadata: { teamId: f.teams.eng.id, role: 'member' },
      });
    });
  });

  it('admin adds a guest to a team: the guest actor now lists the team', async () => {
    await withTempDatabase(async (db) => {
      const f = await createWorkspaceFixture(db.orm);
      const newGuest = await addMember(db.orm, f.workspaceId, 'guest');
      const admin = await actorOf(db, f.workspaceId, f.members.admin.id);
      expect((await teamIdsOf(db, f, newGuest.id))?.size).toBe(0);

      txidOf(await addTeamMember(db.orm, admin, f.teams.eng.id, newGuest.id));

      expect((await teamIdsOf(db, f, newGuest.id))?.has(f.teams.eng.id)).toBe(true);
    });
  });

  it('adding twice is a 200 no-op without a second audit row, also when two calls run at the same time', async () => {
    await withTempDatabase(async (db) => {
      const f = await createWorkspaceFixture(db.orm);
      const owner = await actorOf(db, f.workspaceId, f.members.owner.id);

      txidOf(await addTeamMember(db.orm, owner, f.teams.eng.id, f.members.outsider.id));
      txidOf(await addTeamMember(db.orm, owner, f.teams.eng.id, f.members.outsider.id));
      expect(await auditRows(db, f.workspaceId)).toHaveLength(1);

      const racers = await addMember(db.orm, f.workspaceId, 'member');
      const results = await Promise.all([
        addTeamMember(db.orm, owner, f.teams.eng.id, racers.id),
        addTeamMember(db.orm, owner, f.teams.eng.id, racers.id),
      ]);
      expect(results.every((r) => r.ok)).toBe(true);
      expect(
        (await auditRows(db, f.workspaceId)).filter((row) => row.targetId === racers.id),
      ).toHaveLength(1);
    });
  });

  it('a deactivated member, a member of another workspace, an unknown and a malformed id: 404, nothing added', async () => {
    await withTempDatabase(async (db) => {
      const a = await createWorkspaceFixture(db.orm);
      const b = await createWorkspaceFixture(db.orm);
      const gone = await addMember(db.orm, a.workspaceId, 'member');
      await db.orm.update(member).set({ deactivatedAt: new Date() }).where(eq(member.id, gone.id));
      const owner = await actorOf(db, a.workspaceId, a.members.owner.id);
      const before = await membersOf(db, a.teams.eng.id);

      for (const id of [gone.id, b.members.member.id, UNKNOWN_UUID, 'not-a-uuid']) {
        expect(await addTeamMember(db.orm, owner, a.teams.eng.id, id), id).toEqual(
          refusal('not_found', 404),
        );
      }
      expect(await membersOf(db, a.teams.eng.id)).toEqual(before);
      expect(await auditRows(db, a.workspaceId)).toHaveLength(0);
    });
  });

  it('a team of another workspace, unknown or malformed: 404', async () => {
    await withTempDatabase(async (db) => {
      const a = await createWorkspaceFixture(db.orm);
      const b = await createWorkspaceFixture(db.orm);
      const owner = await actorOf(db, a.workspaceId, a.members.owner.id);

      for (const id of [b.teams.eng.id, UNKNOWN_UUID, 'not-a-uuid']) {
        expect(await addTeamMember(db.orm, owner, id, a.members.outsider.id), id).toEqual(
          refusal('not_found', 404),
        );
      }
      expect(await membersOf(db, b.teams.eng.id)).not.toContain(a.members.outsider.id);
    });
  });

  it('member and guest cannot add anybody, not even themselves: 403 on a team they see, 404 on a private team they do not', async () => {
    await withTempDatabase(async (db) => {
      const f = await createWorkspaceFixture(db.orm);
      for (const who of ['member', 'guest'] as const) {
        const actor = await actorOf(db, f.workspaceId, f.members[who].id);
        expect(
          await addTeamMember(db.orm, actor, f.teams.eng.id, f.members.outsider.id),
          who,
        ).toEqual(refusal('forbidden', 403));
      }
      const outsider = await actorOf(db, f.workspaceId, f.members.outsider.id);
      const guest = await actorOf(db, f.workspaceId, f.members.guest.id);
      // Adding oneself to a public team is still an admin act; to a private team one cannot see it is a 404.
      expect(await addTeamMember(db.orm, outsider, f.teams.eng.id, outsider.memberId)).toEqual(
        refusal('forbidden', 403),
      );
      expect(await addTeamMember(db.orm, outsider, f.teams.ops.id, outsider.memberId)).toEqual(
        refusal('not_found', 404),
      );
      expect(await addTeamMember(db.orm, guest, f.teams.ops.id, guest.memberId)).toEqual(
        refusal('not_found', 404),
      );
      expect(await membersOf(db, f.teams.ops.id)).not.toContain(f.members.outsider.id);
      expect(await membersOf(db, f.teams.ops.id)).not.toContain(f.members.guest.id);
    });
  });

  it('an admin cannot add OTHER people to a private team they cannot see: 404, nothing is added', async () => {
    await withTempDatabase(async (db) => {
      const f = await createWorkspaceFixture(db.orm);
      const admin = await actorOf(db, f.workspaceId, f.members.admin.id);

      const result = await addTeamMember(db.orm, admin, f.teams.ops.id, f.members.outsider.id);

      expect(result).toEqual(refusal('not_found', 404));
      expect(await membersOf(db, f.teams.ops.id)).toEqual(
        [f.members.owner.id, f.members.member.id].sort(),
      );
      expect(await auditRows(db, f.workspaceId)).toHaveLength(0);
    });
  });

  it('an admin who is in a private team manages its people like any team they see', async () => {
    await withTempDatabase(async (db) => {
      const f = await createWorkspaceFixture(db.orm);
      const owner = await actorOf(db, f.workspaceId, f.members.owner.id);
      txidOf(await addTeamMember(db.orm, owner, f.teams.ops.id, f.members.admin.id));
      const admin = await actorOf(db, f.workspaceId, f.members.admin.id);

      txidOf(await addTeamMember(db.orm, admin, f.teams.ops.id, f.members.outsider.id));

      expect(await membersOf(db, f.teams.ops.id)).toContain(f.members.outsider.id);
    });
  });

  it('an admin or owner adds ONLY THEMSELVES to a private team they cannot see: audited as team.admin_joined, then the team is theirs', async () => {
    await withTempDatabase(async (db) => {
      const f = await createWorkspaceFixture(db.orm);
      const admin = await actorOf(db, f.workspaceId, f.members.admin.id);
      const opsIssue = f.issues.ops[0];
      if (!opsIssue) throw new Error('fixture has no issue');
      // Before joining: the team and its issues do not exist for this admin.
      expect(
        await updateIssue(db.orm, { ...admin, client: 'web' }, opsIssue.id, { title: 'Peek' }),
      ).toMatchObject({
        ok: false,
        status: 404,
      });

      txidOf(await addTeamMember(db.orm, admin, f.teams.ops.id, f.members.admin.id));

      const audit = await auditRows(db, f.workspaceId);
      expect(audit).toHaveLength(1);
      expect(audit[0]).toMatchObject({
        action: 'team.admin_joined',
        actorMemberId: f.members.admin.id,
        targetType: 'team_member',
        targetId: f.members.admin.id,
        metadata: { teamId: f.teams.ops.id },
      });
      const joined = await actorOf(db, f.workspaceId, f.members.admin.id);
      expect(joined.teamIds.has(f.teams.ops.id)).toBe(true);
      expect(
        await updateIssue(db.orm, { ...joined, client: 'web' }, opsIssue.id, {
          title: 'Now visible',
        }),
      ).toMatchObject({
        ok: true,
      });

      // A second owner, in no team, joins a private team the same way.
      const second = await addMember(db.orm, f.workspaceId, 'owner');
      const secondActor = await actorOf(db, f.workspaceId, second.id);
      txidOf(await addTeamMember(db.orm, secondActor, f.teams.ops.id, second.id));
      expect((await auditRows(db, f.workspaceId)).map((row) => row.action)).toEqual([
        'team.admin_joined',
        'team.admin_joined',
      ]);
    });
  });

  it('an admin joining a PUBLIC team they are not in is an ordinary team.member_added', async () => {
    await withTempDatabase(async (db) => {
      const f = await createWorkspaceFixture(db.orm);
      const lone = await addMember(db.orm, f.workspaceId, 'admin');
      const actor = await actorOf(db, f.workspaceId, lone.id);

      txidOf(await addTeamMember(db.orm, actor, f.teams.eng.id, lone.id));

      const audit = await auditRows(db, f.workspaceId);
      expect(audit.map((row) => row.action)).toEqual(['team.member_added']);
      expect(await membersOf(db, f.teams.eng.id)).toContain(lone.id);
    });
  });

  it('an admin cannot add themselves to a private team of ANOTHER workspace', async () => {
    await withTempDatabase(async (db) => {
      const a = await createWorkspaceFixture(db.orm);
      const b = await createWorkspaceFixture(db.orm);
      const admin = await actorOf(db, a.workspaceId, a.members.admin.id);

      expect(await addTeamMember(db.orm, admin, b.teams.ops.id, a.members.admin.id)).toEqual(
        refusal('not_found', 404),
      );
      expect(await membersOf(db, b.teams.ops.id)).not.toContain(a.members.admin.id);
    });
  });

  it('an actor demoted since the request began cannot add anybody', async () => {
    await withTempDatabase(async (db) => {
      const f = await createWorkspaceFixture(db.orm);
      const staleAdmin = await actorOf(db, f.workspaceId, f.members.admin.id);
      await db.orm.update(member).set({ role: 'member' }).where(eq(member.id, f.members.admin.id));

      expect(
        await addTeamMember(db.orm, staleAdmin, f.teams.eng.id, f.members.outsider.id),
      ).toEqual(refusal('forbidden', 403));
      expect(await membersOf(db, f.teams.eng.id)).not.toContain(f.members.outsider.id);
    });
  });
});

describe.skipIf(!databaseUrl)('removeTeamMember', () => {
  it('owner removes a member and a guest: rows gone, one audit row each, their actors lose the team', async () => {
    await withTempDatabase(async (db) => {
      const f = await createWorkspaceFixture(db.orm);
      const owner = await actorOf(db, f.workspaceId, f.members.owner.id);

      txidOf(await removeTeamMember(db.orm, owner, f.teams.eng.id, f.members.guest.id));
      txidOf(await removeTeamMember(db.orm, owner, f.teams.eng.id, f.members.member.id));

      expect(await membersOf(db, f.teams.eng.id)).toEqual(
        [f.members.owner.id, f.members.admin.id].sort(),
      );
      expect((await teamIdsOf(db, f, f.members.guest.id))?.has(f.teams.eng.id)).toBe(false);
      const audit = await auditRows(db, f.workspaceId);
      expect(audit.map((row) => [row.action, row.targetType, row.targetId, row.metadata])).toEqual([
        ['team.member_removed', 'team_member', f.members.guest.id, { teamId: f.teams.eng.id }],
        ['team.member_removed', 'team_member', f.members.member.id, { teamId: f.teams.eng.id }],
      ]);
    });
  });

  it('removing a member of the workspace who is not in the team is a 200 no-op without an audit row', async () => {
    await withTempDatabase(async (db) => {
      const a = await createWorkspaceFixture(db.orm);
      const owner = await actorOf(db, a.workspaceId, a.members.owner.id);
      const before = await membersOf(db, a.teams.eng.id);

      txidOf(await removeTeamMember(db.orm, owner, a.teams.eng.id, a.members.outsider.id));
      // A deactivated member is still a member of the workspace.
      await db.orm
        .update(member)
        .set({ deactivatedAt: new Date() })
        .where(eq(member.id, a.members.outsider.id));
      txidOf(await removeTeamMember(db.orm, owner, a.teams.eng.id, a.members.outsider.id));

      expect(await membersOf(db, a.teams.eng.id)).toEqual(before);
      expect(await auditRows(db, a.workspaceId)).toHaveLength(0);
    });
  });

  it('an id that is no member of this workspace (unknown, of another workspace, malformed) is 404 and changes nothing', async () => {
    await withTempDatabase(async (db) => {
      const a = await createWorkspaceFixture(db.orm);
      const b = await createWorkspaceFixture(db.orm);
      const owner = await actorOf(db, a.workspaceId, a.members.owner.id);
      const before = await membersOf(db, a.teams.eng.id);

      for (const id of [UNKNOWN_UUID, b.members.member.id, 'not-a-uuid']) {
        expect(await removeTeamMember(db.orm, owner, a.teams.eng.id, id), id).toEqual(
          refusal('not_found', 404),
        );
      }

      expect(await membersOf(db, a.teams.eng.id)).toEqual(before);
      expect(await membersOf(db, b.teams.eng.id)).toContain(b.members.member.id);
      expect(await auditRows(db, a.workspaceId)).toHaveLength(0);
    });
  });

  it('the last member of a private team cannot be removed: 409 private_team_needs_member; a public team may end up empty', async () => {
    await withTempDatabase(async (db) => {
      const f = await createWorkspaceFixture(db.orm);
      const owner = await actorOf(db, f.workspaceId, f.members.owner.id);
      txidOf(await removeTeamMember(db.orm, owner, f.teams.ops.id, f.members.member.id));

      expect(await removeTeamMember(db.orm, owner, f.teams.ops.id, f.members.owner.id)).toEqual(
        refusal('private_team_needs_member', 409),
      );
      expect(await membersOf(db, f.teams.ops.id)).toEqual([f.members.owner.id]);

      for (const id of [f.members.admin.id, f.members.member.id, f.members.guest.id]) {
        txidOf(await removeTeamMember(db.orm, owner, f.teams.eng.id, id));
      }
      txidOf(await removeTeamMember(db.orm, owner, f.teams.eng.id, f.members.owner.id));
      expect(await membersOf(db, f.teams.eng.id)).toEqual([]);
    });
  });

  it('two members of a private team removed at the same time: exactly one removal succeeds and one member stays', async () => {
    await withTempDatabase(async (db) => {
      for (let round = 0; round < 6; round++) {
        const f = await createWorkspaceFixture(db.orm);
        const owner = await actorOf(db, f.workspaceId, f.members.owner.id);

        // OPS has the owner and the member: remove both together.
        const results = await Promise.all([
          removeTeamMember(db.orm, owner, f.teams.ops.id, f.members.owner.id),
          removeTeamMember(db.orm, owner, f.teams.ops.id, f.members.member.id),
        ]);

        expect(
          results.filter((r) => r.ok),
          `round ${round}`,
        ).toHaveLength(1);
        // The loser is refused: 409 when the owner is still in the team when it runs, 404 when the winner removed
        // the owner (a private team is invisible to a person who left it). Never a second success.
        const refused = results.filter((r) => !r.ok);
        expect(refused, `round ${round}`).toHaveLength(1);
        expect(['private_team_needs_member', 'not_found'], `round ${round}`).toContain(
          refused[0]?.ok === false ? refused[0].code : '',
        );
        expect(await membersOf(db, f.teams.ops.id), `round ${round}`).toHaveLength(1);
      }
    });
  });

  it('member and guest: 403 on a team they see, 404 on a private team they cannot see; an admin outside a private team: 404', async () => {
    await withTempDatabase(async (db) => {
      const f = await createWorkspaceFixture(db.orm);
      for (const who of ['member', 'guest'] as const) {
        const actor = await actorOf(db, f.workspaceId, f.members[who].id);
        expect(
          await removeTeamMember(db.orm, actor, f.teams.eng.id, f.members.admin.id),
          who,
        ).toEqual(refusal('forbidden', 403));
      }
      const guest = await actorOf(db, f.workspaceId, f.members.guest.id);
      const admin = await actorOf(db, f.workspaceId, f.members.admin.id);
      expect(await removeTeamMember(db.orm, guest, f.teams.ops.id, f.members.owner.id)).toEqual(
        refusal('not_found', 404),
      );
      expect(await removeTeamMember(db.orm, admin, f.teams.ops.id, f.members.owner.id)).toEqual(
        refusal('not_found', 404),
      );
      expect(await membersOf(db, f.teams.ops.id)).toEqual(
        [f.members.owner.id, f.members.member.id].sort(),
      );
      expect(await membersOf(db, f.teams.eng.id)).toContain(f.members.admin.id);
    });
  });

  it('a team of another workspace, unknown or malformed: 404', async () => {
    await withTempDatabase(async (db) => {
      const a = await createWorkspaceFixture(db.orm);
      const b = await createWorkspaceFixture(db.orm);
      const owner = await actorOf(db, a.workspaceId, a.members.owner.id);

      for (const id of [b.teams.eng.id, UNKNOWN_UUID, 'not-a-uuid']) {
        expect(await removeTeamMember(db.orm, owner, id, b.members.owner.id), id).toEqual(
          refusal('not_found', 404),
        );
      }
      expect(await membersOf(db, b.teams.eng.id)).toContain(b.members.owner.id);
    });
  });
});

describe.skipIf(!databaseUrl)('listPrivateTeamDirectory', () => {
  it('owner and admin list the private teams, the ones they are not in included, with counts and isMember', async () => {
    await withTempDatabase(async (db) => {
      const f = await createWorkspaceFixture(db.orm);

      const adminList = successOf(
        await listPrivateTeamDirectory(
          db.orm,
          await actorOf(db, f.workspaceId, f.members.admin.id),
        ),
      );
      const ownerList = successOf(
        await listPrivateTeamDirectory(
          db.orm,
          await actorOf(db, f.workspaceId, f.members.owner.id),
        ),
      );

      expect(adminList).toEqual([
        { id: f.teams.ops.id, key: 'OPS', name: 'Operations', memberCount: 2, isMember: false },
      ]);
      expect(ownerList).toEqual([
        { id: f.teams.ops.id, key: 'OPS', name: 'Operations', memberCount: 2, isMember: true },
      ]);
    });
  });

  it('only the five directory fields come back: no issues, no member names, emails or ids', async () => {
    await withTempDatabase(async (db) => {
      const f = await createWorkspaceFixture(db.orm);
      const admin = await actorOf(db, f.workspaceId, f.members.admin.id);

      const list = successOf(await listPrivateTeamDirectory(db.orm, admin));

      for (const item of list) {
        expect(Object.keys(item).sort()).toEqual(['id', 'isMember', 'key', 'memberCount', 'name']);
      }
      const text = JSON.stringify(list);
      expect(text).not.toContain('OPS issue');
      expect(text).not.toContain('@');
      for (const person of Object.values(f.members)) {
        expect(text).not.toContain(person.id);
        expect(text).not.toContain(person.name);
      }
    });
  });

  it('member, guest and a member in no team get 403', async () => {
    await withTempDatabase(async (db) => {
      const f = await createWorkspaceFixture(db.orm);
      for (const who of ['member', 'guest', 'outsider'] as const) {
        const actor = await actorOf(db, f.workspaceId, f.members[who].id);
        expect(await listPrivateTeamDirectory(db.orm, actor), who).toEqual(
          refusal('forbidden', 403),
        );
      }
    });
  });

  it('a private team of another workspace never appears, public teams never appear, new private teams do', async () => {
    await withTempDatabase(async (db) => {
      const a = await createWorkspaceFixture(db.orm);
      const b = await createWorkspaceFixture(db.orm);
      const ownerB = await actorOf(db, b.workspaceId, b.members.owner.id);
      successOf(await createTeam(db.orm, ownerB, { key: 'BSEC', name: 'B secret', private: true }));
      const ownerA = await actorOf(db, a.workspaceId, a.members.owner.id);
      const { teamId } = successOf(
        await createTeam(db.orm, ownerA, { key: 'ASEC', name: 'A secret', private: true }),
      );

      const list = successOf(await listPrivateTeamDirectory(db.orm, ownerA));

      expect(list.map((item) => item.key)).toEqual(['ASEC', 'OPS']);
      expect(list.find((item) => item.id === teamId)).toMatchObject({
        memberCount: 1,
        isMember: true,
      });
    });
  });

  it('after an admin joins a private team from the directory, the directory says isMember and the count grows', async () => {
    await withTempDatabase(async (db) => {
      const f = await createWorkspaceFixture(db.orm);
      const admin = await actorOf(db, f.workspaceId, f.members.admin.id);
      txidOf(await addTeamMember(db.orm, admin, f.teams.ops.id, f.members.admin.id));

      const list = successOf(await listPrivateTeamDirectory(db.orm, admin));

      expect(list).toEqual([
        { id: f.teams.ops.id, key: 'OPS', name: 'Operations', memberCount: 3, isMember: true },
      ]);
    });
  });
});
