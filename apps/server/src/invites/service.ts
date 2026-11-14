// Workspace invites: create, resend, revoke, list, preview and accept (spec section 6, plan Task 6).
// Every function takes the Orm and, when it acts for someone, the Actor; it never sees a request. One transaction
// per call, the audit row in the same transaction. The link token is 32 random bytes; only its SHA-256 is stored.
//
// Lock order, shared with the member and team services: the workspace row first, then member rows. Invite rows are
// locked only after the workspace row (create, accept) or alone (resend, revoke), so no two paths wait on each
// other in a circle.
import {
  invite,
  inviteTeam,
  type MemberRole,
  member,
  team,
  teamMember,
  workspace,
} from '@torch/shared/db/schema';
import type { Locale } from '@torch/shared/i18n';
import type { InviteCreateInput } from '@torch/shared/mutations/admin';
import { slugifyHandle } from '@torch/shared/mutations/admin';
import {
  type Actor,
  canGrantRole,
  canManageMembers,
  canManageTeamMembership,
  type Role,
} from '@torch/shared/permissions';
import { and, desc, eq, gt, inArray, isNull, sql } from 'drizzle-orm';
import { recordAudit } from '../audit/log.ts';
import { createSessionsForMembers } from '../auth/sessions.ts';
import { generateToken, hashToken, isWellFormedToken } from '../auth/tokens.ts';
import type { Orm, Tx } from '../db.ts';
import { currentTxid } from '../mutations/txid.ts';
import type { ServiceResult } from '../util/result.ts';
import { isUuid } from '../util/uuid.ts';

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

/** How long an invite link lives, from creation or from the last resend. */
export const INVITE_TTL_DAYS = 7;
const INVITE_TTL_MS = INVITE_TTL_DAYS * DAY_MS;
/** Invites one member may create per hour. */
export const INVITES_PER_ACTOR_PER_HOUR = 30;
/** Pending (unexpired, unused, unrevoked) invites one workspace may hold. */
export const PENDING_INVITES_PER_WORKSPACE = 200;

const MAX_NAME_LENGTH = 80;
const HANDLE_CANDIDATES_PER_QUERY = 50;
const MAX_HANDLE_CANDIDATES = 1000;

type Refusal = Extract<ServiceResult<never>, { ok: false }>;
const refuse = (code: Refusal['code'], status: Refusal['status']): Refusal => ({
  ok: false,
  code,
  status,
});
const ok = <T>(value: T): ServiceResult<T> => ({ ok: true, value });

/** Thrown inside a transaction to roll everything back and answer with `result`. */
class Abort extends Error {
  readonly result: Refusal;
  constructor(result: Refusal) {
    super(result.code);
    this.result = result;
  }
}

/** Locks the workspace row; `no key update` conflicts with itself and with `for update`, not with foreign-key checks. */
async function lockWorkspace(tx: Tx, workspaceId: string): Promise<void> {
  await tx
    .select({ id: workspace.id })
    .from(workspace)
    .where(eq(workspace.id, workspaceId))
    .for('no key update');
}

const isPending = and(isNull(invite.acceptedAt), isNull(invite.revokedAt));

/**
 * May the member who made an invite still hand out its role? An invite outlives its maker for up to 7 days; if they
 * were deactivated or lost the right since, the link must not open an account for them.
 */
function inviterMayGrant(
  workspaceId: string,
  inviterId: string,
  inviter: { role: MemberRole; deactivatedAt: Date | null } | undefined,
  role: Role,
): boolean {
  if (!inviter || inviter.deactivatedAt) return false;
  const asActor: Actor = {
    workspaceId,
    memberId: inviterId,
    role: inviter.role,
    teamIds: new Set(),
  };
  return canManageMembers(asActor) && canGrantRole(asActor, role);
}

// ---- create ----

/**
 * Invites `input.email` to the actor's workspace. Needs the right to manage members and to grant the role; every
 * team must be one whose membership the actor may manage (a team they cannot see is `not_found`). Nothing is written
 * unless every check passes, except that an expired pending invite for the same email is revoked first so it cannot
 * block the new one. The returned token is the only copy: it goes into the mail and nowhere else.
 */
export async function createInvite(
  orm: Orm,
  actor: Actor,
  input: InviteCreateInput,
  ctx: { now: Date },
): Promise<ServiceResult<{ inviteId: string; token: string; locale: Locale }>> {
  if (!canManageMembers(actor) || !canGrantRole(actor, input.role)) return refuse('forbidden', 403);

  const { now } = ctx;
  const email = input.email.trim().toLowerCase();
  const teamIds = [...new Set(input.teamIds.map((id) => id.toLowerCase()))];
  if (input.role === 'guest' && teamIds.length === 0) return refuse('invalid_input', 400);
  if (!teamIds.every(isUuid)) return refuse('not_found', 404);

  return orm.transaction(async (tx) => {
    await lockWorkspace(tx, actor.workspaceId);

    if (teamIds.length > 0) {
      const teams = await tx
        .select({ id: team.id, workspaceId: team.workspaceId, private: team.private })
        .from(team)
        .where(and(eq(team.workspaceId, actor.workspaceId), inArray(team.id, teamIds)));
      if (teams.length !== teamIds.length) return refuse('not_found', 404);
      if (!teams.every((row) => canManageTeamMembership(actor, row)))
        return refuse('not_found', 404);
    }

    const [existing] = await tx
      .select({ id: member.id })
      .from(member)
      .where(
        and(
          eq(member.workspaceId, actor.workspaceId),
          eq(member.email, email),
          isNull(member.deactivatedAt),
        ),
      )
      .limit(1);
    if (existing) return refuse('already_member', 409);

    // Row locks: a resend of the same invite waits here and the decision below sees its new expiry.
    const pendingForEmail = await tx
      .select({ id: invite.id, role: invite.role, expiresAt: invite.expiresAt })
      .from(invite)
      .where(and(eq(invite.workspaceId, actor.workspaceId), eq(invite.email, email), isPending))
      .for('update');
    if (pendingForEmail.some((row) => row.expiresAt.getTime() > now.getTime())) {
      return refuse('invite_pending', 409);
    }

    const [recent] = await tx
      .select({ count: sql<number>`count(*)::int` })
      .from(invite)
      .where(
        and(
          eq(invite.workspaceId, actor.workspaceId),
          eq(invite.invitedBy, actor.memberId),
          gt(invite.createdAt, new Date(now.getTime() - HOUR_MS)),
        ),
      );
    if ((recent?.count ?? 0) >= INVITES_PER_ACTOR_PER_HOUR) return refuse('rate_limited', 429);

    const [pending] = await tx
      .select({ count: sql<number>`count(*)::int` })
      .from(invite)
      .where(and(eq(invite.workspaceId, actor.workspaceId), isPending, gt(invite.expiresAt, now)));
    if ((pending?.count ?? 0) >= PENDING_INVITES_PER_WORKSPACE) return refuse('rate_limited', 429);

    for (const stale of pendingForEmail) {
      await tx
        .update(invite)
        .set({ revokedAt: now })
        .where(and(eq(invite.workspaceId, actor.workspaceId), eq(invite.id, stale.id)));
      await recordAudit(tx, {
        workspaceId: actor.workspaceId,
        actorMemberId: actor.memberId,
        action: 'invite.revoked',
        targetType: 'invite',
        targetId: stale.id,
        metadata: { role: stale.role, reason: 'expired' },
      });
    }

    const token = generateToken();
    const [created] = await tx
      .insert(invite)
      .values({
        workspaceId: actor.workspaceId,
        email,
        role: input.role,
        locale: input.locale ?? 'en',
        tokenHash: hashToken(token),
        invitedBy: actor.memberId,
        createdAt: now,
        expiresAt: new Date(now.getTime() + INVITE_TTL_MS),
      })
      .returning({ id: invite.id, locale: invite.locale });
    if (!created) throw new Error('invite insert returned no row');

    if (teamIds.length > 0) {
      await tx.insert(inviteTeam).values(
        teamIds.map((teamId) => ({
          workspaceId: actor.workspaceId,
          inviteId: created.id,
          teamId,
        })),
      );
    }
    await recordAudit(tx, {
      workspaceId: actor.workspaceId,
      actorMemberId: actor.memberId,
      action: 'invite.created',
      targetType: 'invite',
      targetId: created.id,
      metadata: { role: input.role, team_count: teamIds.length },
    });
    return ok({ inviteId: created.id, token, locale: created.locale });
  });
}

// ---- resend and revoke ----

/**
 * Gives a pending invite (an expired one too) a new token and a fresh 7 days; the old link stops working at once.
 * The row keeps its creation time, so a resend does not count as a new invite for the hourly limit. An admin cannot
 * resend an invite for a role they cannot grant.
 */
export async function resendInvite(
  orm: Orm,
  actor: Actor,
  inviteId: string,
  ctx: { now: Date },
): Promise<ServiceResult<{ token: string; email: string; locale: Locale; role: Role }>> {
  if (!canManageMembers(actor)) return refuse('forbidden', 403);
  if (!isUuid(inviteId)) return refuse('not_found', 404);

  return orm.transaction(async (tx) => {
    const [row] = await tx
      .select()
      .from(invite)
      .where(and(eq(invite.workspaceId, actor.workspaceId), eq(invite.id, inviteId), isPending))
      .for('update');
    if (!row) return refuse('not_found', 404);
    if (!canGrantRole(actor, row.role)) return refuse('forbidden', 403);

    const token = generateToken();
    await tx
      .update(invite)
      .set({ tokenHash: hashToken(token), expiresAt: new Date(ctx.now.getTime() + INVITE_TTL_MS) })
      .where(and(eq(invite.workspaceId, actor.workspaceId), eq(invite.id, row.id)));
    await recordAudit(tx, {
      workspaceId: actor.workspaceId,
      actorMemberId: actor.memberId,
      action: 'invite.resent',
      targetType: 'invite',
      targetId: row.id,
      metadata: { role: row.role },
    });
    return ok({ token, email: row.email, locale: row.locale, role: row.role });
  });
}

/**
 * Revokes an invite so its link stops working. Revoking a revoked invite is a no-op that still answers a txid; an
 * accepted invite is `not_found` (nothing is pending). An admin cannot revoke an invite for a role they cannot grant.
 */
export async function revokeInvite(
  orm: Orm,
  actor: Actor,
  inviteId: string,
  ctx: { now: Date },
): Promise<ServiceResult<{ txid: number }>> {
  if (!canManageMembers(actor)) return refuse('forbidden', 403);
  if (!isUuid(inviteId)) return refuse('not_found', 404);

  return orm.transaction(async (tx) => {
    const [row] = await tx
      .select()
      .from(invite)
      .where(and(eq(invite.workspaceId, actor.workspaceId), eq(invite.id, inviteId)))
      .for('update');
    if (!row || row.acceptedAt) return refuse('not_found', 404);
    if (!canGrantRole(actor, row.role)) return refuse('forbidden', 403);

    if (!row.revokedAt) {
      await tx
        .update(invite)
        .set({ revokedAt: ctx.now })
        .where(and(eq(invite.workspaceId, actor.workspaceId), eq(invite.id, row.id)));
      await recordAudit(tx, {
        workspaceId: actor.workspaceId,
        actorMemberId: actor.memberId,
        action: 'invite.revoked',
        targetType: 'invite',
        targetId: row.id,
        metadata: { role: row.role },
      });
    }
    return ok({ txid: await currentTxid(tx) });
  });
}

// ---- list and preview ----

export type InviteListItem = {
  id: string;
  email: string;
  role: Role;
  teamIds: string[];
  invitedBy: string;
  createdAt: string;
  expiresAt: string;
};

/** Pending, unexpired invites of the actor's workspace, newest first. Never a token or a hash. */
export async function listInvites(
  orm: Orm,
  actor: Actor,
  ctx: { now: Date } = { now: new Date() },
): Promise<ServiceResult<InviteListItem[]>> {
  if (!canManageMembers(actor)) return refuse('forbidden', 403);

  const rows = await orm
    .select({
      id: invite.id,
      email: invite.email,
      role: invite.role,
      invitedBy: invite.invitedBy,
      createdAt: invite.createdAt,
      expiresAt: invite.expiresAt,
      teamId: inviteTeam.teamId,
    })
    .from(invite)
    .leftJoin(
      inviteTeam,
      and(eq(inviteTeam.workspaceId, invite.workspaceId), eq(inviteTeam.inviteId, invite.id)),
    )
    .where(and(eq(invite.workspaceId, actor.workspaceId), isPending, gt(invite.expiresAt, ctx.now)))
    .orderBy(desc(invite.createdAt), desc(invite.id));

  const items = new Map<string, InviteListItem>();
  for (const row of rows) {
    let item = items.get(row.id);
    if (!item) {
      item = {
        id: row.id,
        email: row.email,
        role: row.role,
        teamIds: [],
        invitedBy: row.invitedBy,
        createdAt: row.createdAt.toISOString(),
        expiresAt: row.expiresAt.toISOString(),
      };
      items.set(row.id, item);
    }
    if (row.teamId) item.teamIds.push(row.teamId);
  }
  for (const item of items.values()) item.teamIds.sort();
  return ok([...items.values()]);
}

export type InvitePreview = {
  workspaceName: string;
  email: string;
  role: Role;
  teams: { key: string; name: string }[];
};

/**
 * What the invited person sees before accepting. Read only: it never changes the invite. Null for a token that is
 * unknown, malformed, expired, revoked, accepted or whose maker can no longer hand out the role (the same cases in
 * which `acceptInvite` refuses).
 */
export async function previewInvite(
  orm: Orm,
  token: string,
  now: Date,
): Promise<InvitePreview | null> {
  if (!isWellFormedToken(token)) return null;

  const [row] = await orm
    .select({
      id: invite.id,
      workspaceId: invite.workspaceId,
      email: invite.email,
      role: invite.role,
      invitedBy: invite.invitedBy,
      workspaceName: workspace.name,
      inviterRole: member.role,
      inviterDeactivatedAt: member.deactivatedAt,
    })
    .from(invite)
    .innerJoin(workspace, eq(workspace.id, invite.workspaceId))
    .leftJoin(
      member,
      and(eq(member.workspaceId, invite.workspaceId), eq(member.id, invite.invitedBy)),
    )
    .where(and(eq(invite.tokenHash, hashToken(token)), isPending, gt(invite.expiresAt, now)))
    .limit(1);
  if (!row) return null;
  const inviter = row.inviterRole
    ? { role: row.inviterRole, deactivatedAt: row.inviterDeactivatedAt }
    : undefined;
  if (!inviterMayGrant(row.workspaceId, row.invitedBy, inviter, row.role)) return null;

  const teams = await orm
    .select({ key: team.key, name: team.name })
    .from(inviteTeam)
    .innerJoin(
      team,
      and(eq(team.workspaceId, inviteTeam.workspaceId), eq(team.id, inviteTeam.teamId)),
    )
    .where(and(eq(inviteTeam.workspaceId, row.workspaceId), eq(inviteTeam.inviteId, row.id)))
    .orderBy(team.key);
  return { workspaceName: row.workspaceName, email: row.email, role: row.role, teams };
}

/** The names a mail needs besides what the invite holds: the workspace and the member who is inviting. */
export async function loadInviteMailContext(
  orm: Orm,
  actor: Actor,
): Promise<{ workspaceName: string; inviterName: string }> {
  const [row] = await orm
    .select({ workspaceName: workspace.name, inviterName: member.name })
    .from(member)
    .innerJoin(workspace, eq(workspace.id, member.workspaceId))
    .where(and(eq(member.workspaceId, actor.workspaceId), eq(member.id, actor.memberId)));
  if (!row) throw new Error('the inviting member is not in the workspace');
  return row;
}

// ---- accept ----

const handleCandidate = (base: string, n: number) =>
  n === 1 ? base : `${base.slice(0, 32 - String(n).length - 1)}-${n}`;

/** `base`, then `base-2`, `base-3`, ... the first one no member of the workspace has. Call with the workspace locked. */
async function availableHandle(tx: Tx, workspaceId: string, base: string): Promise<string> {
  for (let start = 1; start <= MAX_HANDLE_CANDIDATES; start += HANDLE_CANDIDATES_PER_QUERY) {
    const candidates = Array.from({ length: HANDLE_CANDIDATES_PER_QUERY }, (_, i) =>
      handleCandidate(base, start + i),
    );
    const taken = await tx
      .select({ handle: member.handle })
      .from(member)
      .where(and(eq(member.workspaceId, workspaceId), inArray(member.handle, candidates)));
    const takenSet = new Set(taken.map((row) => row.handle));
    const free = candidates.find((candidate) => !takenSet.has(candidate));
    if (free) return free;
  }
  throw new Error('no free handle');
}

/**
 * Accepts an invite: burns the token with one conditional UPDATE (of any number of concurrent calls exactly one
 * gets the row), then in the same transaction creates the member (or reactivates a deactivated one with the same
 * email, keeping their id), puts them in the invited teams, audits it and opens one session for every workspace
 * where that email is an active member, all behind one cookie token. Any refusal after the burn rolls the burn back,
 * so a failed attempt never uses the invite up.
 */
export async function acceptInvite(
  orm: Orm,
  input: { token: string; name: string; now: Date; userAgent: string | null },
): Promise<ServiceResult<{ sessionToken: string; workspaceId: string; memberId: string }>> {
  const { token, now, userAgent } = input;
  const name = input.name.trim();
  if (name.length < 1 || name.length > MAX_NAME_LENGTH) return refuse('invalid_input', 400);
  if (!isWellFormedToken(token)) return refuse('invite_invalid', 400);
  const tokenHash = hashToken(token);

  try {
    return await orm.transaction(async (tx) => {
      // Workspace lock first (the order every service follows), so the unlocked read comes before it.
      const [found] = await tx
        .select({ workspaceId: invite.workspaceId })
        .from(invite)
        .where(eq(invite.tokenHash, tokenHash))
        .limit(1);
      if (!found) return refuse('invite_invalid', 400);
      await lockWorkspace(tx, found.workspaceId);

      const [consumed] = await tx
        .update(invite)
        .set({ acceptedAt: now })
        .where(and(eq(invite.tokenHash, tokenHash), isPending, gt(invite.expiresAt, now)))
        .returning();
      if (!consumed || consumed.workspaceId !== found.workspaceId) {
        throw new Abort(refuse('invite_invalid', 400));
      }
      const workspaceId = consumed.workspaceId;

      const [inviter] = await tx
        .select({ role: member.role, deactivatedAt: member.deactivatedAt })
        .from(member)
        .where(and(eq(member.workspaceId, workspaceId), eq(member.id, consumed.invitedBy)));
      if (!inviterMayGrant(workspaceId, consumed.invitedBy, inviter, consumed.role)) {
        throw new Abort(refuse('invite_invalid', 400));
      }

      const [existing] = await tx
        .select({ id: member.id, deactivatedAt: member.deactivatedAt })
        .from(member)
        .where(and(eq(member.workspaceId, workspaceId), eq(member.email, consumed.email)))
        .for('update');

      let memberId: string;
      const reactivated = existing !== undefined;
      if (existing) {
        if (!existing.deactivatedAt) throw new Abort(refuse('already_member', 409));
        // The same row, the invited role. Team memberships become exactly the invited teams (least privilege: a
        // returning guest never keeps access this invite does not grant). Deactivation keeps the old rows, so they are
        // deleted before the invited ones go in, in this transaction with the member row locked.
        await tx
          .update(member)
          .set({ deactivatedAt: null, role: consumed.role, name })
          .where(and(eq(member.workspaceId, workspaceId), eq(member.id, existing.id)));
        await tx
          .delete(teamMember)
          .where(
            and(eq(teamMember.workspaceId, workspaceId), eq(teamMember.memberId, existing.id)),
          );
        memberId = existing.id;
      } else {
        const [created] = await tx
          .insert(member)
          .values({
            workspaceId,
            email: consumed.email,
            name,
            handle: await availableHandle(tx, workspaceId, slugifyHandle(name)),
            role: consumed.role,
            locale: consumed.locale,
          })
          .returning({ id: member.id });
        if (!created) throw new Error('member insert returned no row');
        memberId = created.id;
      }

      const invitedTeams = await tx
        .select({ teamId: inviteTeam.teamId })
        .from(inviteTeam)
        .where(and(eq(inviteTeam.workspaceId, workspaceId), eq(inviteTeam.inviteId, consumed.id)));
      if (invitedTeams.length > 0) {
        await tx
          .insert(teamMember)
          .values(invitedTeams.map((row) => ({ workspaceId, teamId: row.teamId, memberId })));
      }

      await tx
        .update(invite)
        .set({ acceptedMemberId: memberId })
        .where(and(eq(invite.workspaceId, workspaceId), eq(invite.id, consumed.id)));
      await recordAudit(tx, {
        workspaceId,
        actorMemberId: memberId,
        action: 'invite.accepted',
        targetType: 'invite',
        targetId: consumed.id,
        metadata: {
          role: consumed.role,
          member_id: memberId,
          reactivated,
          team_count: invitedTeams.length,
        },
      });
      if (reactivated) {
        await recordAudit(tx, {
          workspaceId,
          actorMemberId: memberId,
          action: 'member.reactivated',
          targetType: 'member',
          targetId: memberId,
          metadata: { role: consumed.role, via: 'invite' },
        });
      }

      // Signing in with an invite is signing in with the address it was mailed to: every workspace where that
      // address is an active member, exactly like a sign-in link.
      const active = await tx
        .select({ workspaceId: member.workspaceId, memberId: member.id })
        .from(member)
        .where(and(eq(member.email, consumed.email), isNull(member.deactivatedAt)));
      const sessionToken = await createSessionsForMembers(tx, active, { now, userAgent });
      return ok({ sessionToken, workspaceId, memberId });
    });
  } catch (error) {
    if (error instanceof Abort) return error.result;
    throw error;
  }
}
