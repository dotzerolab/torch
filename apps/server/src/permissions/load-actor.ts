// Turns a (workspace, member) pair into the `Actor` the shared permission module decides on.
import { member, team, teamMember } from '@torch/shared/db/schema';
import type { Actor, TeamAccess } from '@torch/shared/permissions';
import { and, eq, isNull } from 'drizzle-orm';
import type { Orm } from '../db.ts';
import { isUuid } from '../util/uuid.ts';

/** Resolves who is calling for one workspace; the session layer (Task 5) implements it. */
export type ActorResolver = {
  resolveActor(req: Request, workspaceId: string): Promise<Actor | null>;
};

/**
 * The actor for an active member of the workspace; null for a missing, deactivated or other-workspace member.
 * The ids in the Actor are the stored values, not the caller's strings.
 */
export async function loadActor(
  orm: Orm,
  workspaceId: string,
  memberId: string,
): Promise<Actor | null> {
  if (!isUuid(workspaceId) || !isUuid(memberId)) return null;

  const rows = await orm
    .select({
      workspaceId: member.workspaceId,
      memberId: member.id,
      role: member.role,
      teamId: teamMember.teamId,
    })
    .from(member)
    .leftJoin(
      teamMember,
      and(eq(teamMember.workspaceId, member.workspaceId), eq(teamMember.memberId, member.id)),
    )
    .where(
      and(
        eq(member.workspaceId, workspaceId),
        eq(member.id, memberId),
        isNull(member.deactivatedAt),
      ),
    );

  const first = rows[0];
  if (!first) return null;
  const teamIds = new Set<string>();
  for (const row of rows) if (row.teamId) teamIds.add(row.teamId);
  return { workspaceId: first.workspaceId, memberId: first.memberId, role: first.role, teamIds };
}

/** What the permission module needs to know about a team; null when the team is not in this workspace. */
export async function loadTeamAccess(
  orm: Orm,
  workspaceId: string,
  teamId: string,
): Promise<TeamAccess | null> {
  if (!isUuid(workspaceId) || !isUuid(teamId)) return null;

  const [row] = await orm
    .select({ id: team.id, workspaceId: team.workspaceId, private: team.private })
    .from(team)
    .where(and(eq(team.workspaceId, workspaceId), eq(team.id, teamId)))
    .limit(1);
  return row ?? null;
}
