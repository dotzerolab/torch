// Team administration: create and edit teams, the people of a team, and the management directory of private teams
// (spec §6). Every function decides through the shared permission module on the actor as the database says it right
// now (read under the lock, see `currentActor`), writes in ONE transaction together with its audit row and returns
// the Postgres transaction id for the client's `awaitTxId`. REST, MCP and the assistant call these functions.
//
// Locks: a call that changes the people of a team (or its privacy) locks that team row first and counts members
// under the lock, so "a private team keeps at least one member" holds with concurrent calls. The mode is
// `no key update`: `for update` would deadlock with the `for key share` that foreign-key checks take on the team row
// (a team_member insert of another call), and the team key and id never change.
import { member, team, teamMember, workflowState } from '@torch/shared/db/schema';
import { defaultWorkflowStates } from '@torch/shared/db/workflow-defaults';
import {
  type TeamCreateInput,
  type TeamUpdateInput,
  teamCreateInput,
  teamUpdateInput,
} from '@torch/shared/mutations/admin';
import {
  type Actor,
  canAddSelfToTeam,
  canListPrivateTeams,
  canManageTeamMembership,
  canManageTeams,
  canSeeTeam,
  type TeamAccess,
} from '@torch/shared/permissions';
import { and, asc, count, eq, isNull, sql } from 'drizzle-orm';
import { recordAudit } from '../audit/log.ts';
import type { Orm, Tx } from '../db.ts';
import { currentTxid } from '../mutations/txid.ts';
import { currentActor } from '../permissions/current-actor.ts';
import { isUniqueViolation } from '../util/pg-error.ts';
import { refuse, succeed } from '../util/refusal.ts';
import type { ServiceResult } from '../util/result.ts';
import { isUuid } from '../util/uuid.ts';

export type DirectoryTeam = {
  id: string;
  key: string;
  name: string;
  memberCount: number;
  isMember: boolean;
};

/** The team row of this workspace, locked; null for an id that is not in it. */
async function lockTeam(tx: Tx, workspaceId: string, teamId: string): Promise<TeamAccess | null> {
  const [row] = await tx
    .select({ id: team.id, workspaceId: team.workspaceId, private: team.private })
    .from(team)
    .where(and(eq(team.workspaceId, workspaceId), eq(team.id, teamId)))
    .for('no key update');
  return row ?? null;
}

async function countMembers(tx: Tx, teamId: string): Promise<number> {
  const [row] = await tx
    .select({ members: count() })
    .from(teamMember)
    .where(eq(teamMember.teamId, teamId));
  return row?.members ?? 0;
}

/** Creates a team with the six default workflow states; the creator is its first member. Owners and admins only. */
export async function createTeam(
  orm: Orm,
  actor: Actor,
  input: TeamCreateInput,
): Promise<ServiceResult<{ teamId: string; txid: number }>> {
  // The type says "validated", the function does not rely on it.
  const parsed = teamCreateInput.safeParse(input);
  if (!parsed.success) return refuse('invalid_input', 400);
  if (!canManageTeams(actor)) return refuse('forbidden', 403);
  const { key, name, private: isPrivate = false } = parsed.data;

  try {
    return await orm.transaction(async (tx) => {
      const now = await currentActor(tx, actor);
      if (!now || !canManageTeams(now)) return refuse('forbidden', 403);

      const [created] = await tx
        .insert(team)
        .values({ workspaceId: actor.workspaceId, key, name, private: isPrivate })
        .returning({ id: team.id });
      if (!created) throw new Error('team insert returned no row');

      await tx.insert(workflowState).values(
        defaultWorkflowStates().map((state) => ({
          workspaceId: actor.workspaceId,
          teamId: created.id,
          ...state,
        })),
      );
      await tx
        .insert(teamMember)
        .values({ workspaceId: actor.workspaceId, teamId: created.id, memberId: actor.memberId });
      await recordAudit(tx, {
        workspaceId: actor.workspaceId,
        actorMemberId: actor.memberId,
        action: 'team.created',
        targetType: 'team',
        targetId: created.id,
        metadata: { private: isPrivate },
      });
      return succeed({ teamId: created.id, txid: await currentTxid(tx) });
    });
  } catch (error) {
    if (isUniqueViolation(error, 'team_workspace_key_unique')) {
      return refuse('team_key_taken', 409);
    }
    throw error;
  }
}

/**
 * Renames a team or toggles its privacy (the key never changes). A team the actor cannot see answers 404, a visible
 * team they may not edit 403. Turning a team private needs at least one member (409 otherwise).
 */
export async function updateTeam(
  orm: Orm,
  actor: Actor,
  teamId: string,
  input: TeamUpdateInput,
): Promise<ServiceResult<{ txid: number }>> {
  const parsed = teamUpdateInput.safeParse(input);
  if (!parsed.success) return refuse('invalid_input', 400);
  if (!isUuid(teamId)) return refuse('not_found', 404);
  const changes = parsed.data;

  return orm.transaction(async (tx) => {
    const access = await lockTeam(tx, actor.workspaceId, teamId);
    if (!access) return refuse('not_found', 404);
    const now = await currentActor(tx, actor);
    if (!now) return refuse('forbidden', 403);
    if (!canSeeTeam(now, access)) return refuse('not_found', 404);
    if (!canManageTeams(now)) return refuse('forbidden', 403);

    const [current] = await tx.select({ name: team.name }).from(team).where(eq(team.id, teamId));
    const renamed = changes.name !== undefined && changes.name !== current?.name;
    const privacyChanged = changes.private !== undefined && changes.private !== access.private;
    if (privacyChanged && changes.private && (await countMembers(tx, teamId)) < 1) {
      return refuse('private_team_needs_member', 409);
    }

    if (renamed || privacyChanged) {
      await tx
        .update(team)
        .set({
          ...(renamed ? { name: changes.name } : {}),
          ...(privacyChanged ? { private: changes.private } : {}),
        })
        .where(and(eq(team.workspaceId, actor.workspaceId), eq(team.id, teamId)));
      await recordAudit(tx, {
        workspaceId: actor.workspaceId,
        actorMemberId: actor.memberId,
        action: 'team.updated',
        targetType: 'team',
        targetId: teamId,
        metadata: {
          ...(renamed ? { renamed: true } : {}),
          ...(privacyChanged ? { private: changes.private ?? false } : {}),
        },
      });
    }
    return succeed({ txid: await currentTxid(tx) });
  });
}

/**
 * Adds an active member of the workspace to a team. Owners and admins manage the people of the teams they can see.
 * One more door: an owner or admin may add THEMSELVES to a private team they cannot see (audited as
 * `team.admin_joined`); adding anybody else to a team the actor cannot see stays 404. Adding twice is a 200 no-op.
 */
export async function addTeamMember(
  orm: Orm,
  actor: Actor,
  teamId: string,
  memberId: string,
): Promise<ServiceResult<{ txid: number }>> {
  if (!isUuid(teamId) || !isUuid(memberId)) return refuse('not_found', 404);

  return orm.transaction(async (tx) => {
    const access = await lockTeam(tx, actor.workspaceId, teamId);
    if (!access) return refuse('not_found', 404);
    const now = await currentActor(tx, actor);
    if (!now) return refuse('forbidden', 403);

    const joiningSelf = memberId === now.memberId && canAddSelfToTeam(now, access);
    const sees = canSeeTeam(now, access);
    if (!joiningSelf) {
      if (!sees) return refuse('not_found', 404);
      if (!canManageTeamMembership(now, access)) return refuse('forbidden', 403);
    }

    // `for share`: a member deactivated by a concurrent call is either seen as deactivated here or finishes after us.
    const [target] = await tx
      .select({ id: member.id, role: member.role })
      .from(member)
      .where(
        and(
          eq(member.workspaceId, actor.workspaceId),
          eq(member.id, memberId),
          isNull(member.deactivatedAt),
        ),
      )
      .for('share');
    if (!target) return refuse('not_found', 404);

    const inserted = await tx
      .insert(teamMember)
      .values({ workspaceId: actor.workspaceId, teamId, memberId })
      .onConflictDoNothing()
      .returning({ memberId: teamMember.memberId });
    if (inserted.length > 0) {
      await recordAudit(tx, {
        workspaceId: actor.workspaceId,
        actorMemberId: actor.memberId,
        action: joiningSelf && !sees ? 'team.admin_joined' : 'team.member_added',
        targetType: 'team_member',
        targetId: memberId,
        metadata: joiningSelf && !sees ? { teamId } : { teamId, role: target.role },
      });
    }
    return succeed({ txid: await currentTxid(tx) });
  });
}

/**
 * Removes a person from a team. Visibility and rights as for adding. Removing a member of the workspace who is not in
 * the team (a deactivated one included) is a 200 no-op; an id that is not a member of this workspace is 404, like
 * everywhere else. The last member of a private team cannot be removed (409).
 */
export async function removeTeamMember(
  orm: Orm,
  actor: Actor,
  teamId: string,
  memberId: string,
): Promise<ServiceResult<{ txid: number }>> {
  if (!isUuid(teamId) || !isUuid(memberId)) return refuse('not_found', 404);

  return orm.transaction(async (tx) => {
    const access = await lockTeam(tx, actor.workspaceId, teamId);
    if (!access) return refuse('not_found', 404);
    const now = await currentActor(tx, actor);
    if (!now) return refuse('forbidden', 403);
    if (!canSeeTeam(now, access)) return refuse('not_found', 404);
    if (!canManageTeamMembership(now, access)) return refuse('forbidden', 403);

    const [membership] = await tx
      .select({ memberId: teamMember.memberId })
      .from(teamMember)
      .where(and(eq(teamMember.teamId, teamId), eq(teamMember.memberId, memberId)));
    if (!membership) {
      // Nothing to remove: a member of this workspace who is not in the team is an idempotent no-op, but an id that
      // is no member of this workspace (unknown, or of another workspace) is not found. A plain read: no lock is
      // taken here, so the lock order stays team row, then nothing else.
      const [known] = await tx
        .select({ id: member.id })
        .from(member)
        .where(and(eq(member.workspaceId, actor.workspaceId), eq(member.id, memberId)));
      if (!known) return refuse('not_found', 404);
      return succeed({ txid: await currentTxid(tx) });
    }

    if (access.private && (await countMembers(tx, teamId)) <= 1) {
      return refuse('private_team_needs_member', 409);
    }

    // The row may be gone by now (an invite that reactivated this member replaced their memberships while this call
    // waited for it): then nothing was removed, and nothing is audited.
    const deleted = await tx
      .delete(teamMember)
      .where(and(eq(teamMember.teamId, teamId), eq(teamMember.memberId, memberId)))
      .returning({ memberId: teamMember.memberId });
    if (deleted.length > 0) {
      await recordAudit(tx, {
        workspaceId: actor.workspaceId,
        actorMemberId: actor.memberId,
        action: 'team.member_removed',
        targetType: 'team_member',
        targetId: memberId,
        metadata: { teamId },
      });
    }
    return succeed({ txid: await currentTxid(tx) });
  });
}

/**
 * The management directory of private teams: key, name and member count, and whether the caller is in it. Owners
 * and admins only, so a private team nobody can reach is never lost. It never carries issues or people.
 */
export async function listPrivateTeamDirectory(
  orm: Orm,
  actor: Actor,
): Promise<ServiceResult<DirectoryTeam[]>> {
  if (!canListPrivateTeams(actor)) return refuse('forbidden', 403);

  const rows = await orm
    .select({
      id: team.id,
      key: team.key,
      name: team.name,
      memberCount: count(teamMember.memberId),
      isMember: sql<boolean>`coalesce(bool_or(${teamMember.memberId} = ${actor.memberId}), false)`,
    })
    .from(team)
    .leftJoin(
      teamMember,
      and(eq(teamMember.workspaceId, team.workspaceId), eq(teamMember.teamId, team.id)),
    )
    .where(and(eq(team.workspaceId, actor.workspaceId), eq(team.private, true)))
    .groupBy(team.id)
    .orderBy(asc(team.key));
  return succeed(rows);
}
