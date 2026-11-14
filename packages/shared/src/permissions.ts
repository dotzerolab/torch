// Who may see and edit what (spec §6). One module, used by the server for every decision (shape filters,
// mutations) and by the web only to hide what the server would refuse anyway.
// No Node imports: this file reaches the browser bundle.
export type Role = 'owner' | 'admin' | 'member' | 'guest';

export type Actor = {
  workspaceId: string;
  memberId: string;
  role: Role;
  teamIds: ReadonlySet<string>;
};

export type TeamAccess = { id: string; workspaceId: string; private: boolean };

/**
 * A team of another workspace is never visible. A guest sees only the teams they belong to. Everyone else
 * sees public teams and the private teams they belong to: a private team is visible only to its members,
 * whatever the role (spec §6; an admin "join private team" action is P1).
 */
export function canSeeTeam(actor: Actor, team: TeamAccess): boolean {
  if (actor.workspaceId !== team.workspaceId) return false;
  if (actor.teamIds.has(team.id)) return true;
  return actor.role !== 'guest' && !team.private;
}

/** P0d: whoever can see a team can edit its issues. P1 refines this (guests, read-only roles). */
export function canEditIssues(actor: Actor, team: TeamAccess): boolean {
  return canSeeTeam(actor, team);
}

/** The ids of the teams the actor can see, in the order of `teams`. */
export function visibleTeamIds(actor: Actor, teams: readonly TeamAccess[]): string[] {
  return teams.filter((team) => canSeeTeam(actor, team)).map((team) => team.id);
}
