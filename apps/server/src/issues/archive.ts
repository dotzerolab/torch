// Archive and unarchive (spec section 6): an archived issue keeps its number, stays readable and cannot be changed
// until it is unarchived. Nothing is ever deleted. Doing either twice changes nothing and records nothing.
import { issue } from '@torch/shared/db/schema';
import { and, eq, sql } from 'drizzle-orm';
import { recordIssueChange } from '../activity/record.ts';
import type { Orm } from '../db.ts';
import { currentTxid } from '../mutations/txid.ts';
import type { ClientActor } from '../permissions/load-actor.ts';
import { isUuid } from '../util/uuid.ts';
import { lockEditableIssue, refuse, type UpdateIssueResult } from './update-issue.ts';

async function setArchived(
  orm: Orm,
  requested: ClientActor,
  issueId: string,
  archive: boolean,
): Promise<UpdateIssueResult> {
  if (!isUuid(issueId)) return refuse('not_found', 404);
  return orm.transaction(async (tx) => {
    const locked = await lockEditableIssue(tx, requested, issueId);
    if (!locked.ok) return locked.refusal;
    const { row, actor } = locked;
    if ((row.archivedAt !== null) === archive)
      return { ok: true as const, txid: await currentTxid(tx) };

    const [after] = await tx
      .update(issue)
      .set({
        archivedAt: archive ? sql`clock_timestamp()` : null,
        updatedAt: sql`clock_timestamp()`,
      })
      .where(and(eq(issue.id, issueId), eq(issue.workspaceId, actor.workspaceId)))
      .returning();
    if (!after) throw new Error('issue update returned no row');
    await recordIssueChange(tx, actor, { kind: archive ? 'archived' : 'unarchived', issue: after });
    return { ok: true as const, txid: await currentTxid(tx) };
  });
}

export const archiveIssue = (orm: Orm, actor: ClientActor, issueId: string) =>
  setArchived(orm, actor, issueId, true);

export const unarchiveIssue = (orm: Orm, actor: ClientActor, issueId: string) =>
  setArchived(orm, actor, issueId, false);
