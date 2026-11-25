// The outbox event of a new comment (spec section 11, catalogue `comment.created`, version 1). It carries ids and the
// issue identifier, never the text: a consumer reads the comment over REST, where the permission check applies.
import { type CommentRow, event, issue, team } from '@torch/shared/db/schema';
import { and, eq, sql } from 'drizzle-orm';
import type { Tx } from '../db.ts';
import type { ClientActor } from '../permissions/load-actor.ts';

const EVENT_VERSION = 1;

/** Writes `comment.created` inside the transaction that inserted the comment: a rollback takes it away. */
export async function recordCommentCreated(
  tx: Tx,
  actor: ClientActor,
  created: CommentRow,
): Promise<void> {
  const [subject] = await tx
    .select({ number: issue.number, key: team.key })
    .from(issue)
    .innerJoin(team, and(eq(team.workspaceId, issue.workspaceId), eq(team.id, issue.teamId)))
    .where(and(eq(issue.workspaceId, created.workspaceId), eq(issue.id, created.issueId)));
  if (!subject) throw new Error('recordCommentCreated: issue not found in the comment workspace');

  await tx.insert(event).values({
    workspaceId: created.workspaceId,
    teamId: created.teamId,
    type: 'comment.created',
    version: EVENT_VERSION,
    occurredAt: sql`clock_timestamp()`,
    actorId: actor.memberId,
    client: actor.client,
    subjectType: 'comment',
    subjectId: created.id,
    data: {
      issueId: created.issueId,
      identifier: `${subject.key}-${subject.number}`,
      commentId: created.id,
      parentId: created.parentId,
    },
  });
}
