// The shape every change to an issue's join rows (relations, subscribers, links) shares: lock the issue, check who may
// do it, refuse on an archived issue, run the change, move the issue's `updated_at`, answer with the transaction id.
import type { IssueRow } from '@torch/shared/db/schema';
import type { TeamAccess } from '@torch/shared/permissions';
import type { Orm, Tx } from '../db.ts';
import { currentTxid } from '../mutations/txid.ts';
import type { ClientActor } from '../permissions/load-actor.ts';
import { isUuid } from '../util/uuid.ts';
import { type Failure, lockEditableIssue, refuse, touchIssue } from './update-issue.ts';

export type ChangeContext = { tx: Tx; actor: ClientActor; access: TeamAccess; row: IssueRow };
export type ChangeResult<T> = { ok: true; txid: number; value: T } | Failure;

/** `need` is what the actor must be allowed to do on the issue: `see` is enough to manage oneself as a subscriber. */
export async function changeIssueJoin<T>(
  orm: Orm,
  requested: ClientActor,
  issueId: string,
  need: 'edit' | 'see',
  run: (context: ChangeContext) => Promise<{ value: T; changed: boolean } | Failure>,
): Promise<ChangeResult<T>> {
  if (!isUuid(issueId)) return refuse('not_found', 404);
  return orm.transaction(async (tx) => {
    const locked = await lockEditableIssue(tx, requested, issueId, need);
    if (!locked.ok) return locked.refusal;
    if (locked.row.archivedAt) return refuse('issue_archived', 409);
    const { actor, access, row } = locked;
    const outcome = await run({ tx, actor, access, row });
    if ('ok' in outcome) return outcome;
    if (outcome.changed) await touchIssue(tx, actor.workspaceId, issueId);
    return { ok: true as const, txid: await currentTxid(tx), value: outcome.value };
  });
}
