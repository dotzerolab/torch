// Member administration: list, role change, deactivation and the caller's own profile (spec §6). Each function
// decides through the shared permission module, writes in ONE transaction together with its audit row and returns
// the Postgres transaction id for the client's `awaitTxId`. REST, MCP and the assistant call these functions; the
// HTTP routes (routes.ts) are thin wrappers.
//
// Locks: every change that can alter the number of active owners first locks the workspace row, then the member
// row, always in that order. The owner count is read under that lock, so two owners demoting or deactivating each
// other at the same time are serialised and the second one is refused (`last_owner`).
import {
  type MemberLocale,
  type MemberRole,
  member,
  session,
  workspace,
} from '@torch/shared/db/schema';
import {
  memberRoleInput,
  type ProfileUpdateInput,
  profileUpdateInput,
} from '@torch/shared/mutations/admin';
import {
  type Actor,
  canChangeMemberRole,
  canDeactivateMember,
  canManageMembers,
  wouldLeaveNoOwner,
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

export type MemberListItem = {
  id: string;
  name: string;
  handle: string;
  role: MemberRole;
  email: string;
  locale: MemberLocale;
  deactivatedAt: string | null;
  createdAt: string;
};

type Target = { id: string; workspaceId: string; role: MemberRole; deactivatedAt: Date | null };

async function lockWorkspace(tx: Tx, workspaceId: string): Promise<void> {
  await tx
    .select({ id: workspace.id })
    .from(workspace)
    .where(eq(workspace.id, workspaceId))
    .for('update');
}

/** The member row, locked; null for an id that is not in this workspace. */
async function lockTarget(tx: Tx, workspaceId: string, memberId: string): Promise<Target | null> {
  const [row] = await tx
    .select({
      id: member.id,
      workspaceId: member.workspaceId,
      role: member.role,
      deactivatedAt: member.deactivatedAt,
    })
    .from(member)
    .where(and(eq(member.workspaceId, workspaceId), eq(member.id, memberId)))
    .for('update');
  return row ?? null;
}

/**
 * Would this change leave the workspace without an active owner? Counts under the workspace lock the caller holds.
 * Only an active owner matters: a deactivated one is not counted, so changing them cannot remove the last one.
 */
async function leavesNoOwner(
  tx: Tx,
  target: Target,
  change: { kind: 'role'; role: MemberRole } | { kind: 'deactivate' },
): Promise<boolean> {
  if (target.role !== 'owner' || target.deactivatedAt !== null) return false;
  const [owners] = await tx
    .select({ owners: count() })
    .from(member)
    .where(
      and(
        eq(member.workspaceId, target.workspaceId),
        eq(member.role, 'owner'),
        isNull(member.deactivatedAt),
      ),
    );
  return wouldLeaveNoOwner(owners?.owners ?? 0, target, change);
}

/** False when the actor lost their role or their access since the request resolved them. */
async function actorStillCurrent(tx: Tx, actor: Actor): Promise<boolean> {
  const now = await currentActor(tx, actor);
  return now !== null && now.role === actor.role;
}

/** Every member of the workspace with their email, deactivated ones included: owners and admins only. */
export async function listMembers(
  orm: Orm,
  actor: Actor,
): Promise<ServiceResult<MemberListItem[]>> {
  if (!canManageMembers(actor)) return refuse('forbidden', 403);

  const rows = await orm
    .select({
      id: member.id,
      name: member.name,
      handle: member.handle,
      role: member.role,
      email: member.email,
      locale: member.locale,
      deactivatedAt: member.deactivatedAt,
      createdAt: member.createdAt,
    })
    .from(member)
    .where(eq(member.workspaceId, actor.workspaceId))
    .orderBy(asc(member.createdAt), asc(member.id));

  return succeed(
    rows.map((row) => ({
      ...row,
      deactivatedAt: row.deactivatedAt?.toISOString() ?? null,
      createdAt: row.createdAt.toISOString(),
    })),
  );
}

/**
 * Changes another member's role. Refusal order: not a manager 403, unknown id 404, role rules 403 (the permission
 * module: an admin can neither grant nor take away admin or owner, nobody changes themselves), last owner 409,
 * then whether the actor is still who the request said (403).
 */
export async function changeMemberRole(
  orm: Orm,
  actor: Actor,
  memberId: string,
  role: MemberRole,
): Promise<ServiceResult<{ txid: number }>> {
  // The type says "validated", the function does not rely on it.
  const parsed = memberRoleInput.safeParse({ role });
  if (!parsed.success) return refuse('invalid_input', 400);
  if (!canManageMembers(actor)) return refuse('forbidden', 403);
  if (!isUuid(memberId)) return refuse('not_found', 404);
  const newRole = parsed.data.role;

  return orm.transaction(async (tx) => {
    await lockWorkspace(tx, actor.workspaceId);
    const target = await lockTarget(tx, actor.workspaceId, memberId);
    if (!target) return refuse('not_found', 404);
    if (!canChangeMemberRole(actor, target, newRole)) return refuse('forbidden', 403);
    if (await leavesNoOwner(tx, target, { kind: 'role', role: newRole })) {
      return refuse('last_owner', 409);
    }
    if (!(await actorStillCurrent(tx, actor))) return refuse('forbidden', 403);

    if (target.role !== newRole) {
      await tx
        .update(member)
        .set({ role: newRole })
        .where(and(eq(member.workspaceId, actor.workspaceId), eq(member.id, target.id)));
      await recordAudit(tx, {
        workspaceId: actor.workspaceId,
        actorMemberId: actor.memberId,
        action: 'member.role_changed',
        targetType: 'member',
        targetId: target.id,
        metadata: { from: target.role, to: newRole },
      });
    }
    return succeed({ txid: await currentTxid(tx) });
  });
}

/**
 * Deactivates or reactivates a member. Deactivation sets `deactivated_at` and revokes the member's sessions of this
 * workspace in the same transaction, so their next request is 401. Repeating the current state is a 200 no-op.
 */
export async function setMemberActive(
  orm: Orm,
  actor: Actor,
  memberId: string,
  active: boolean,
): Promise<ServiceResult<{ txid: number }>> {
  if (!canManageMembers(actor)) return refuse('forbidden', 403);
  if (!isUuid(memberId)) return refuse('not_found', 404);

  return orm.transaction(async (tx) => {
    await lockWorkspace(tx, actor.workspaceId);
    const target = await lockTarget(tx, actor.workspaceId, memberId);
    if (!target) return refuse('not_found', 404);
    if (!canDeactivateMember(actor, target)) return refuse('forbidden', 403);
    if (!active && (await leavesNoOwner(tx, target, { kind: 'deactivate' }))) {
      return refuse('last_owner', 409);
    }
    if (!(await actorStillCurrent(tx, actor))) return refuse('forbidden', 403);

    const alreadyDone = active ? target.deactivatedAt === null : target.deactivatedAt !== null;
    if (!alreadyDone) {
      await tx
        .update(member)
        .set({ deactivatedAt: active ? null : sql`clock_timestamp()` })
        .where(and(eq(member.workspaceId, actor.workspaceId), eq(member.id, target.id)));
      if (!active) {
        await tx
          .update(session)
          .set({ revokedAt: sql`clock_timestamp()` })
          .where(
            and(
              eq(session.workspaceId, actor.workspaceId),
              eq(session.memberId, target.id),
              isNull(session.revokedAt),
            ),
          );
      }
      await recordAudit(tx, {
        workspaceId: actor.workspaceId,
        actorMemberId: actor.memberId,
        action: active ? 'member.reactivated' : 'member.deactivated',
        targetType: 'member',
        targetId: target.id,
        metadata: { role: target.role },
      });
    }
    return succeed({ txid: await currentTxid(tx) });
  });
}

/** The caller edits their own name, handle, language or time zone. Nothing else about a member is a profile field. */
export async function updateOwnProfile(
  orm: Orm,
  actor: Actor,
  input: ProfileUpdateInput,
): Promise<ServiceResult<{ txid: number }>> {
  const parsed = profileUpdateInput.safeParse(input);
  if (!parsed.success) return refuse('invalid_input', 400);
  const { name, handle, locale, timezone } = parsed.data;
  const fields = Object.entries({ handle, locale, name, timezone })
    .filter(([, value]) => value !== undefined)
    .map(([key]) => key)
    .join(',');

  try {
    return await orm.transaction(async (tx) => {
      const [updated] = await tx
        .update(member)
        .set({ name, handle, locale, timezone })
        .where(
          and(
            eq(member.workspaceId, actor.workspaceId),
            eq(member.id, actor.memberId),
            isNull(member.deactivatedAt),
          ),
        )
        .returning({ id: member.id });
      // A deactivated member cannot edit anything; the session layer already refuses them, this is the backstop.
      if (!updated) return refuse('forbidden', 403);

      await recordAudit(tx, {
        workspaceId: actor.workspaceId,
        actorMemberId: actor.memberId,
        action: 'member.profile_updated',
        targetType: 'member',
        targetId: actor.memberId,
        metadata: { fields },
      });
      return succeed({ txid: await currentTxid(tx) });
    });
  } catch (error) {
    if (isUniqueViolation(error, 'member_workspace_handle_unique')) {
      return refuse('handle_taken', 409);
    }
    throw error;
  }
}
