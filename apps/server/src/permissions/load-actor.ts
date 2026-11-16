// Turns a (workspace, member) pair into the `Actor` the shared permission module decides on.
import { type ActivityClient, member, team, teamMember } from '@torch/shared/db/schema';
import { type Actor, canSeeMember, type TeamAccess } from '@torch/shared/permissions';
import { and, eq, inArray, isNull } from 'drizzle-orm';
import type { Orm } from '../db.ts';
import { isUuid } from '../util/uuid.ts';

/**
 * An actor plus how the call authenticated. The client is set by the resolver (a session is `web`; API tokens, the MCP
 * server and imports get their own value when they exist), never read from a request header, and ends up on every
 * activity row and event the call writes.
 */
export type ClientActor = Actor & { readonly client: ActivityClient };

/** Resolves who is calling for one workspace; the session layer implements it. */
export type ActorResolver = {
  resolveActor(req: Request, workspaceId: string): Promise<ClientActor | null>;
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

/** `loadActor` for a call that authenticated as `client`. */
export async function loadClientActor(
  orm: Orm,
  workspaceId: string,
  memberId: string,
  client: ActivityClient,
): Promise<ClientActor | null> {
  const actor = await loadActor(orm, workspaceId, memberId);
  return actor ? { ...actor, client } : null;
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

/**
 * The ids of the members whose profile the actor may read, for the synced `member` shape: `'all'` for every role
 * but guest; for a guest the actor themselves plus every member sharing a team with them, sorted. Deactivated
 * co-members stay in the list so a name that is still on an issue resolves. Read per request from the stored
 * team memberships, so adding or removing a guest from a team changes the next shape immediately. The decision
 * itself is `canSeeMember`; this function only narrows the query to the guest's own teams first.
 */
export async function loadVisibleMemberIds(
  orm: Orm,
  actor: Actor,
): Promise<readonly string[] | 'all'> {
  if (actor.role !== 'guest') return 'all';

  // Only the actor's workspace and the actor's teams are read, whatever else the actor object might hold.
  const teamIds = [...actor.teamIds].filter(isUuid);
  const sharedTeams = new Map<string, Set<string>>();
  if (teamIds.length > 0) {
    const rows = await orm
      .select({ memberId: teamMember.memberId, teamId: teamMember.teamId })
      .from(teamMember)
      .where(
        and(eq(teamMember.workspaceId, actor.workspaceId), inArray(teamMember.teamId, teamIds)),
      );
    for (const row of rows) {
      const teams = sharedTeams.get(row.memberId) ?? new Set<string>();
      teams.add(row.teamId);
      sharedTeams.set(row.memberId, teams);
    }
  }

  const visible = new Set<string>([actor.memberId]);
  for (const [id, teams] of sharedTeams) {
    if (canSeeMember(actor, { id, workspaceId: actor.workspaceId, teamIds: teams })) {
      visible.add(id);
    }
  }
  return [...visible].sort();
}
