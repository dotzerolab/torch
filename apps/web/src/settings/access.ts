// What the settings screens may offer the signed-in person. These helpers only decide what to show: the server
// answers every write on its own rules, so a screen that offers too much is refused, never trusted.
import {
  type Actor,
  canChangeMemberRole,
  canGrantRole,
  type MemberAccess,
  type Role,
} from '@torch/shared/permissions';
import type { SessionWorkspace } from '../auth/useSession.ts';

export const ROLES: readonly Role[] = ['owner', 'admin', 'member', 'guest'];

/** The actor the permission module judges, from what the session says. Team ids are not needed for these rules. */
export function actorOf(workspace: SessionWorkspace): Actor {
  return {
    workspaceId: workspace.id,
    memberId: workspace.memberId,
    role: workspace.role,
    teamIds: new Set(),
  };
}

/** The roles this person may hand out: an owner all four, an admin member and guest, anybody else none. */
export function assignableRoles(actor: Actor): Role[] {
  return ROLES.filter((role) => canGrantRole(actor, role));
}

/**
 * The roles to list for one row of the member table and whether the select may be used. A row the actor may not
 * change (their own, or an admin or owner for an admin) lists its current role only.
 */
export function roleChoices(
  actor: Actor,
  target: MemberAccess,
): { roles: Role[]; editable: boolean } {
  const roles = assignableRoles(actor);
  const editable = roles.some(
    (role) => role !== target.role && canChangeMemberRole(actor, target, role),
  );
  return { roles: editable ? roles : [target.role], editable };
}
