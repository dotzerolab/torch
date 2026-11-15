// Who follows an issue. A member manages their own subscription on any issue they can see; adding or removing someone
// else needs the right to edit the issue, and the person added must be able to open it (a guest only adds people they
// share a team with).
import { issueSubscriber, member, teamMember } from '@torch/shared/db/schema';
import { and, eq, inArray, isNull } from 'drizzle-orm';
import { recordIssueChange } from '../activity/record.ts';
import type { Orm, Tx } from '../db.ts';
import type { ClientActor } from '../permissions/load-actor.ts';
import { isUuid } from '../util/uuid.ts';
import { type ChangeResult, changeIssueJoin } from './join-changes.ts';
import { membersWhoCanSeeTeam } from './references.ts';
import { invalidReferenceFailure, refuse } from './update-issue.ts';

/** The member in the path must exist, as the issue does: unknown or of another workspace is 404. */
async function memberExists(
  tx: Tx,
  actor: ClientActor,
  memberId: string,
  activeOnly: boolean,
): Promise<boolean> {
  if (memberId === actor.memberId) return true;
  const [known] = await tx
    .select({ id: member.id })
    .from(member)
    .where(
      and(
        eq(member.workspaceId, actor.workspaceId),
        eq(member.id, memberId),
        activeOnly ? isNull(member.deactivatedAt) : undefined,
      ),
    );
  return Boolean(known);
}

const needFor = (actor: ClientActor, memberId: string) =>
  memberId === actor.memberId ? 'see' : 'edit';

/** Subscribes `memberId`; doing it twice changes nothing and records nothing. */
export async function addSubscriber(
  orm: Orm,
  requested: ClientActor,
  issueId: string,
  memberId: string,
): Promise<ChangeResult<{ memberId: string }>> {
  if (!isUuid(memberId)) return refuse('invalid_input', 400);
  return changeIssueJoin(orm, requested, issueId, needFor(requested, memberId), async (context) => {
    const { tx, actor, access, row } = context;
    if (!(await memberExists(tx, actor, memberId, true))) return refuse('not_found', 404);
    const people = await membersWhoCanSeeTeam(tx, access, [memberId]);
    if (!people.has(memberId)) return invalidReferenceFailure('memberId');
    if (memberId !== actor.memberId && actor.role === 'guest') {
      const shared = await tx
        .select({ teamId: teamMember.teamId })
        .from(teamMember)
        .where(
          and(
            eq(teamMember.workspaceId, actor.workspaceId),
            eq(teamMember.memberId, memberId),
            inArray(teamMember.teamId, [...actor.teamIds]),
          ),
        );
      if (shared.length === 0) return invalidReferenceFailure('memberId');
    }
    const inserted = await tx
      .insert(issueSubscriber)
      .values({ workspaceId: actor.workspaceId, teamId: row.teamId, issueId, memberId })
      .onConflictDoNothing()
      .returning({ memberId: issueSubscriber.memberId });
    if (inserted.length > 0) {
      await recordIssueChange(tx, actor, {
        kind: 'subscriber',
        issueId,
        op: 'added',
        data: { memberId },
      });
    }
    return { value: { memberId }, changed: inserted.length > 0 };
  });
}

/** Removes a subscriber; a member who is not subscribed is a no-op. */
export async function removeSubscriber(
  orm: Orm,
  requested: ClientActor,
  issueId: string,
  memberId: string,
): Promise<ChangeResult<null>> {
  if (!isUuid(memberId)) return refuse('invalid_input', 400);
  return changeIssueJoin(
    orm,
    requested,
    issueId,
    needFor(requested, memberId),
    async ({ tx, actor }) => {
      if (!(await memberExists(tx, actor, memberId, false))) return refuse('not_found', 404);
      const removed = await tx
        .delete(issueSubscriber)
        .where(and(eq(issueSubscriber.issueId, issueId), eq(issueSubscriber.memberId, memberId)))
        .returning({ memberId: issueSubscriber.memberId });
      if (removed.length > 0) {
        await recordIssueChange(tx, actor, {
          kind: 'subscriber',
          issueId,
          op: 'removed',
          data: { memberId },
        });
      }
      return { value: null, changed: removed.length > 0 };
    },
  );
}
