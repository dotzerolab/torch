// The actor as the database says right now, read inside the transaction that is about to write. A request resolves
// its actor first and the write comes later: an owner demoted, a member deactivated or a team left in between must
// not still act with what they were a moment ago. Services decide on the request's actor first (fast refusals),
// then call this under their locks.
import { member, teamMember } from '@torch/shared/db/schema';
import type { Actor } from '@torch/shared/permissions';
import { and, eq, isNull } from 'drizzle-orm';
import type { Tx } from '../db.ts';

/** The actor's current role and teams; null when the member is gone or deactivated. */
export async function currentActor(tx: Tx, actor: Actor): Promise<Actor | null> {
  const rows = await tx
    .select({ role: member.role, teamId: teamMember.teamId })
    .from(member)
    .leftJoin(
      teamMember,
      and(eq(teamMember.workspaceId, member.workspaceId), eq(teamMember.memberId, member.id)),
    )
    .where(
      and(
        eq(member.workspaceId, actor.workspaceId),
        eq(member.id, actor.memberId),
        isNull(member.deactivatedAt),
      ),
    );
  const first = rows[0];
  if (!first) return null;
  const teamIds = new Set<string>();
  for (const row of rows) if (row.teamId) teamIds.add(row.teamId);
  return { workspaceId: actor.workspaceId, memberId: actor.memberId, role: first.role, teamIds };
}
