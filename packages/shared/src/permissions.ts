// Who may see and edit what (spec §6). One module, used by the server for every decision (shape filters,
// mutations) and by the web only to hide what the server would refuse anyway.
// No Node imports: this file reaches the browser bundle.
//
// Rules in one place:
// - owner: everything an admin can, plus granting and removing the admin and owner roles;
// - admin: invites, deactivates and reactivates members and guests, moves people between member and guest,
//   creates and edits teams, manages the people of the teams they can see, and may add themselves to any team
//   (a private team included, audited) because a private team could otherwise be lost for good;
// - member: everything inside the teams they see;
// - guest: only the teams they belong to, and only the people who share a team with them, never emails.
// Nobody changes their own role or deactivates themselves, and the workspace always keeps one active owner
// (a rule about counts: the service reads the count under a lock and asks `wouldLeaveNoOwner`).
export type Role = 'owner' | 'admin' | 'member' | 'guest';

/** Every kind of object a permission decision is about. The matrix test needs rows for each one. */
export const OBJECT_TYPES = [
  'member',
  'invite',
  'team',
  'team_membership',
  'issue',
  'label',
  'workflow_state',
] as const;
export type ObjectType = (typeof OBJECT_TYPES)[number];

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
 * whatever the role. An owner or admin who is not in a private team can list it in the management directory
 * (`canListPrivateTeams`) and add themselves (`canAddSelfToTeam`); until they have joined it stays invisible.
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

/** Creating an issue follows editing: whoever can edit the issues of a team can start one there, a guest included. */
export const canCreateIssue = canEditIssues;

/** The ids of the teams the actor can see, in the order of `teams`. */
export function visibleTeamIds(actor: Actor, teams: readonly TeamAccess[]): string[] {
  return teams.filter((team) => canSeeTeam(actor, team)).map((team) => team.id);
}

// ---- Members, invites and teams (P1b) ----

/** A member as the rules see them. */
export type MemberAccess = { id: string; workspaceId: string; role: Role };

const isOwnerOrAdmin = (actor: Actor): boolean => actor.role === 'owner' || actor.role === 'admin';

/** Invite, deactivate, reactivate and administer people: owners and admins. */
export function canManageMembers(actor: Actor): boolean {
  return isOwnerOrAdmin(actor);
}

/**
 * May this actor hand out `role`? An owner any role; an admin only `member` and `guest`, so an admin can never
 * create, keep or remove an admin or an owner by any route (role change, invite, reactivation).
 */
export function canGrantRole(actor: Actor, role: Role): boolean {
  if (actor.role === 'owner') return true;
  if (actor.role === 'admin') return role === 'member' || role === 'guest';
  return false;
}

/** An invite as the rules see it. */
export type InviteAccess = { workspaceId: string; role: Role };

/**
 * Create an invite for `role`: the right to manage members and to grant that role. `returningRole` is the role of a
 * DEACTIVATED member who has the invited address: the invite brings them back with the invited role, which is a
 * reactivation, so it also needs the right to grant the role they have now (an admin never reactivates an admin or an
 * owner, by any route).
 */
export function canInvite(actor: Actor, role: Role, returningRole?: Role): boolean {
  if (!canManageMembers(actor) || !canGrantRole(actor, role)) return false;
  return returningRole === undefined || canGrantRole(actor, returningRole);
}

/** Resend or revoke an invite: one of the actor's own workspace, whose role the actor may grant. */
export function canManageInvite(actor: Actor, invite: InviteAccess): boolean {
  if (invite.workspaceId !== actor.workspaceId) return false;
  return canManageMembers(actor) && canGrantRole(actor, invite.role);
}

/**
 * Change another member's role. Both the role they have and the role they get must be grantable by the actor, so
 * an admin can neither promote to admin or owner nor demote an admin or an owner; nobody changes their own role.
 */
export function canChangeMemberRole(actor: Actor, target: MemberAccess, newRole: Role): boolean {
  if (target.workspaceId !== actor.workspaceId) return false;
  if (target.id === actor.memberId) return false;
  return canGrantRole(actor, target.role) && canGrantRole(actor, newRole);
}

/** Deactivate (and, with the same rule, reactivate) a member: whoever may grant their role, never oneself. */
export function canDeactivateMember(actor: Actor, target: MemberAccess): boolean {
  if (target.workspaceId !== actor.workspaceId) return false;
  if (target.id === actor.memberId) return false;
  return canGrantRole(actor, target.role);
}

/**
 * The last-owner rule. `activeOwnerCount` is what the service counted after locking the workspace row; the
 * change would leave nobody if the target is an owner who stops being one (demoted or deactivated) and no other
 * active owner exists.
 */
export function wouldLeaveNoOwner(
  activeOwnerCount: number,
  target: { role: Role },
  change: { kind: 'role'; role: Role } | { kind: 'deactivate' },
): boolean {
  if (target.role !== 'owner') return false;
  const staysOwner = change.kind === 'role' && change.role === 'owner';
  if (staysOwner) return false;
  return activeOwnerCount <= 1;
}

/** Create and edit teams: owners and admins (a member never creates a team). */
export function canManageTeams(actor: Actor): boolean {
  return isOwnerOrAdmin(actor);
}

/** Add or remove the people of a team: owners and admins, for the teams they can see. */
export function canManageTeamMembership(actor: Actor, team: TeamAccess): boolean {
  return canManageTeams(actor) && canSeeTeam(actor, team);
}

/**
 * The management-only directory of private teams (key, name and member count, never issues or people): owners
 * and admins.
 */
export function canListPrivateTeams(actor: Actor): boolean {
  return isOwnerOrAdmin(actor);
}

/**
 * An owner or admin adds themselves to any team of their workspace, a private one included. This is the only way
 * into a private team that is not a plain invitation by one of its members; the service writes an audit entry
 * (`team.admin_joined`). It opens nothing else: seeing the team's issues still needs the membership it creates.
 */
export function canAddSelfToTeam(actor: Actor, team: TeamAccess): boolean {
  return canManageTeams(actor) && actor.workspaceId === team.workspaceId;
}

/**
 * Who is visible to whom. Another workspace: nobody. A guest sees themselves and the members who share a team
 * with them; every other role sees the whole workspace. `teamIds` is the target's own team list.
 */
export function canSeeMember(
  actor: Actor,
  target: { id: string; workspaceId: string; teamIds: ReadonlySet<string> },
): boolean {
  if (target.workspaceId !== actor.workspaceId) return false;
  if (actor.role !== 'guest') return true;
  if (target.id === actor.memberId) return true;
  for (const teamId of target.teamIds) if (actor.teamIds.has(teamId)) return true;
  return false;
}

/** Emails are administrative data: owners and admins only (the synced member profile never carries one). */
export function canSeeMemberEmail(actor: Actor): boolean {
  return isOwnerOrAdmin(actor);
}

// ---- Labels and workflow states (P1d) ----

/**
 * Create, edit and archive a label. A workspace label (`team` null) is for owners and admins. A team label is for
 * anyone but a guest who can see the team: guests read labels, they do not define them.
 */
export function canManageLabels(actor: Actor, team: TeamAccess | null): boolean {
  if (team === null) return isOwnerOrAdmin(actor);
  return actor.role !== 'guest' && canSeeTeam(actor, team);
}

/** Create, edit and archive the workflow states of a team: owners and admins, for the teams they can see. */
export function canManageWorkflow(actor: Actor, team: TeamAccess): boolean {
  return isOwnerOrAdmin(actor) && canSeeTeam(actor, team);
}
