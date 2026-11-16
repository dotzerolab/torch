// External links on an issue. Only http and https are stored (the schema refuses every other scheme, and so does the
// input check first): a stored link is safe to render as an anchor.
import { issueLink } from '@torch/shared/db/schema';
import { type IssueLinkInput, issueLinkInput } from '@torch/shared/mutations/issue';
import { and, eq } from 'drizzle-orm';
import { recordIssueChange } from '../activity/record.ts';
import type { Orm } from '../db.ts';
import type { ClientActor } from '../permissions/load-actor.ts';
import { isUuid } from '../util/uuid.ts';
import { type ChangeResult, changeIssueJoin } from './join-changes.ts';
import { refuse } from './update-issue.ts';

export type LinkDto = { id: string; url: string; title: string | null };

export async function addLink(
  orm: Orm,
  requested: ClientActor,
  issueId: string,
  input: IssueLinkInput,
): Promise<ChangeResult<LinkDto>> {
  const parsed = issueLinkInput.safeParse(input);
  if (!parsed.success) {
    return refuse('invalid_input', 400, { message: parsed.error.issues[0]?.message });
  }
  const data = parsed.data;
  return changeIssueJoin(orm, requested, issueId, 'edit', async ({ tx, actor, row }) => {
    const [created] = await tx
      .insert(issueLink)
      .values({
        workspaceId: actor.workspaceId,
        teamId: row.teamId,
        issueId,
        url: data.url,
        title: data.title ?? null,
        createdBy: actor.memberId,
      })
      .returning();
    if (!created) throw new Error('link insert returned no row');
    const value = { id: created.id, url: created.url, title: created.title };
    await recordIssueChange(tx, actor, {
      kind: 'link',
      issueId,
      op: 'added',
      data: { linkId: created.id, url: created.url, title: created.title },
    });
    return { value, changed: true };
  });
}

export async function removeLink(
  orm: Orm,
  requested: ClientActor,
  issueId: string,
  linkId: string,
): Promise<ChangeResult<null>> {
  if (!isUuid(linkId)) return refuse('not_found', 404);
  return changeIssueJoin(orm, requested, issueId, 'edit', async ({ tx, actor }) => {
    const [removed] = await tx
      .delete(issueLink)
      .where(and(eq(issueLink.id, linkId), eq(issueLink.issueId, issueId)))
      .returning();
    if (!removed) return refuse('not_found', 404);
    await recordIssueChange(tx, actor, {
      kind: 'link',
      issueId,
      op: 'removed',
      data: { linkId, url: removed.url, title: removed.title },
    });
    return { value: null, changed: true };
  });
}
