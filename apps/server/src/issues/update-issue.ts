// The issue update mutation (ADR 0001 section 1): permission check, validation, write, history, outbox event and
// transaction id in ONE transaction. REST, MCP and the assistant call this function; the HTTP route (routes.ts) is a
// thin wrapper. Refusals never reveal more than "not found": an issue of another workspace or of a team the actor
// cannot see answers 404 exactly like an id that does not exist.
import {
  type IssueRow,
  issue,
  issueLabel,
  label,
  team,
  workflowState,
} from '@torch/shared/db/schema';
import { type IssueUpdateInput, issueUpdateInput } from '@torch/shared/mutations/issue';
import { canEditIssues, canSeeTeam, type TeamAccess } from '@torch/shared/permissions';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { recordIssueChange } from '../activity/record.ts';
import type { Orm, Tx } from '../db.ts';
import { currentTxid } from '../mutations/txid.ts';
import { currentActor } from '../permissions/current-actor.ts';
import type { ClientActor } from '../permissions/load-actor.ts';
import { isUuid } from '../util/uuid.ts';
import type { IssueApiError } from './errors.ts';
import {
  keepLastLabelPerGroup,
  membersWhoCanSeeTeam,
  usableLabels,
  usableParent,
} from './references.ts';
import { applyStateTimestamps } from './state-timestamps.ts';

export type Failure = { ok: false } & IssueApiError;
export type UpdateIssueResult = { ok: true; txid: number } | Failure;

export const refuse = (
  code: IssueApiError['code'],
  status: IssueApiError['status'],
  extra: Pick<IssueApiError, 'message' | 'details'> = {},
): Failure => ({ ok: false, code, status, ...extra });

export const invalidReferenceFailure = (field: string): Failure =>
  refuse('invalid_reference', 422, {
    message: `${field} refers to something that does not exist or cannot be used here.`,
    details: { field },
  });

/** Takes the workspace-wide lock that serialises parent changes: two tangled moves can never both pass the cycle check. */
export const lockParentTree = (tx: Tx, workspaceId: string) =>
  tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${workspaceId}::text, 0))`);

/** Is `candidate` one of the descendants of `issueId` (children, their children, and so on)? */
async function isDescendant(
  tx: Tx,
  workspaceId: string,
  issueId: string,
  candidate: string,
): Promise<boolean> {
  const result = await tx.execute(sql`
    with recursive descendants(id) as (
      select id from issue where workspace_id = ${workspaceId} and parent_id = ${issueId}
      union
      select i.id from issue i join descendants d on i.parent_id = d.id where i.workspace_id = ${workspaceId}
    )
    select 1 from descendants where id = ${candidate} limit 1`);
  return result.rows.length > 0;
}

/**
 * The issue row locked for this transaction, the team access of the actor and the refusal, if any: 404 for an issue the
 * actor cannot see, 403 where they see it but may not edit. Shared by the update and the archive calls.
 */
export async function lockEditableIssue(
  tx: Tx,
  requested: ClientActor,
  issueId: string,
  need: 'edit' | 'see' = 'edit',
): Promise<
  | { ok: true; row: IssueRow; access: TeamAccess; actor: ClientActor }
  | { ok: false; refusal: Failure }
> {
  // Locks the row: concurrent writers of this issue queue here, so each field's last writer wins in order.
  const [row] = await tx
    .select()
    .from(issue)
    .where(and(eq(issue.id, issueId), eq(issue.workspaceId, requested.workspaceId)))
    .for('update');
  if (!row) return { ok: false, refusal: refuse('not_found', 404) };

  // The actor as the database says now: a member removed from the team since the request was resolved gets nothing.
  const fresh = await currentActor(tx, requested);
  if (!fresh) return { ok: false, refusal: refuse('unauthenticated', 401) };
  const actor: ClientActor = { ...fresh, client: requested.client };
  const [access] = await tx
    .select({ id: team.id, workspaceId: team.workspaceId, private: team.private })
    .from(team)
    .where(and(eq(team.workspaceId, actor.workspaceId), eq(team.id, row.teamId)));
  if (!access || !canSeeTeam(actor, access))
    return { ok: false, refusal: refuse('not_found', 404) };
  if (need === 'edit' && !canEditIssues(actor, access)) {
    return { ok: false, refusal: refuse('forbidden', 403) };
  }
  return { ok: true, row, access, actor };
}

/** Moves the issue's `updated_at` forward: a change to its labels, relations, subscribers or links is a change to it. */
export const touchIssue = (tx: Tx, workspaceId: string, issueId: string) =>
  tx
    .update(issue)
    .set({ updatedAt: sql`clock_timestamp()` })
    .where(and(eq(issue.id, issueId), eq(issue.workspaceId, workspaceId)));

/**
 * Updates the given fields of one issue and returns the Postgres transaction id for the client's `awaitTxId`. An
 * archived issue is read-only (409 `issue_archived`). A new parent is checked for cycles under a workspace lock.
 */
export async function updateIssue(
  orm: Orm,
  requested: ClientActor,
  issueId: string,
  input: IssueUpdateInput,
): Promise<UpdateIssueResult> {
  // The type says "validated", the function does not rely on it: protected columns stay protected.
  const parsed = issueUpdateInput.safeParse(input);
  if (!parsed.success) return refuse('invalid_input', 400);
  const changes = parsed.data;
  if (!isUuid(issueId)) return refuse('not_found', 404);

  return orm.transaction(async (tx) => {
    // The parent lock comes BEFORE the row lock: every writer that takes both takes them in this order, so two
    // moves that wait for each other's row can never deadlock; the second waits here and sees the first's result.
    if (changes.parentId) await lockParentTree(tx, requested.workspaceId);

    const locked = await lockEditableIssue(tx, requested, issueId);
    if (!locked.ok) return locked.refusal;
    const { row: before, access, actor } = locked;
    if (before.archivedAt) return refuse('issue_archived', 409);

    let stateType: Awaited<ReturnType<typeof stateTypeOf>>;
    if (changes.stateId !== undefined) {
      stateType = await stateTypeOf(tx, before.teamId, changes.stateId);
      if (!stateType) return refuse('invalid_state', 400);
    }
    if (changes.assigneeId) {
      const people = await membersWhoCanSeeTeam(tx, access, [changes.assigneeId]);
      if (!people.has(changes.assigneeId)) return refuse('invalid_assignee', 400);
    }
    if (changes.parentId) {
      if (changes.parentId === issueId) return refuse('parent_cycle', 422);
      if (!(await usableParent(tx, actor, changes.parentId)))
        return invalidReferenceFailure('parentId');
      if (await isDescendant(tx, actor.workspaceId, issueId, changes.parentId)) {
        return refuse('parent_cycle', 422);
      }
    }

    const adding = await usableLabels(
      tx,
      actor.workspaceId,
      before.teamId,
      changes.addLabelIds ?? [],
    );
    if (!adding) return invalidReferenceFailure('addLabelIds');
    const labelChange = await planLabels(tx, issueId, adding, changes.removeLabelIds ?? []);

    // Only the given fields, plus updated_at. clock_timestamp(), not now(): a writer that waited for the lock
    // must not stamp the row with its (older) transaction start time.
    const set: Partial<typeof issue.$inferInsert> = {};
    if (changes.title !== undefined) set.title = changes.title;
    if (changes.description !== undefined) set.description = changes.description;
    if (changes.priority !== undefined) set.priority = changes.priority;
    if (changes.assigneeId !== undefined) set.assigneeId = changes.assigneeId;
    if (changes.estimate !== undefined) set.estimate = changes.estimate;
    if (changes.dueDate !== undefined) set.dueDate = changes.dueDate;
    if (changes.parentId !== undefined) set.parentId = changes.parentId;
    if (changes.sortOrder !== undefined) set.sortOrder = changes.sortOrder;
    if (changes.stateId !== undefined && stateType && changes.stateId !== before.stateId) {
      set.stateId = changes.stateId;
      Object.assign(set, applyStateTimestamps(stateType, before, new Date()));
    }
    const [after] = await tx
      .update(issue)
      .set({ ...set, updatedAt: sql`clock_timestamp()` })
      .where(and(eq(issue.id, issueId), eq(issue.workspaceId, actor.workspaceId)))
      .returning();
    if (!after) throw new Error('issue update returned no row');

    const where = { workspaceId: actor.workspaceId, teamId: before.teamId, issueId };
    if (labelChange.added.length > 0) {
      await tx
        .insert(issueLabel)
        .values(labelChange.added.map((labelId) => ({ ...where, labelId })));
    }
    if (labelChange.removed.length > 0) {
      await tx
        .delete(issueLabel)
        .where(
          and(eq(issueLabel.issueId, issueId), inArray(issueLabel.labelId, labelChange.removed)),
        );
    }

    await recordIssueChange(tx, actor, { kind: 'updated', before, after });
    if (labelChange.added.length > 0 || labelChange.removed.length > 0) {
      await recordIssueChange(tx, actor, { kind: 'labels', issueId, ...labelChange });
    }

    // Electric reports this id for the transaction's rows; the client waits for it (`awaitTxId`).
    return { ok: true as const, txid: await currentTxid(tx) };
  });
}

async function stateTypeOf(tx: Tx, teamId: string, stateId: string) {
  const [state] = await tx
    .select({ type: workflowState.type })
    .from(workflowState)
    .where(and(eq(workflowState.id, stateId), eq(workflowState.teamId, teamId)));
  return state?.type;
}

/**
 * The labels after an update: the ones on the issue, plus `adding` (adding a child of a group takes any other child of
 * that group off), minus `removeIds`. Returns what to insert and what to delete; ids already in place do nothing.
 */
async function planLabels(
  tx: Tx,
  issueId: string,
  adding: Parameters<typeof keepLastLabelPerGroup>[0],
  removeIds: readonly string[],
): Promise<{ added: string[]; removed: string[] }> {
  if (adding.length === 0 && removeIds.length === 0) return { added: [], removed: [] };
  const current = await tx
    .select({ id: label.id, parentId: label.parentId })
    .from(issueLabel)
    .innerJoin(label, eq(label.id, issueLabel.labelId))
    .where(eq(issueLabel.issueId, issueId));
  const final = new Map(current.map((row) => [row.id, row.parentId]));
  for (const row of keepLastLabelPerGroup(adding)) {
    if (row.parentId) {
      for (const [id, parentId] of final) if (parentId === row.parentId) final.delete(id);
    }
    final.set(row.id, row.parentId);
  }
  for (const id of removeIds) final.delete(id);
  const before = new Set(current.map((row) => row.id));
  return {
    added: [...final.keys()].filter((id) => !before.has(id)),
    removed: [...before].filter((id) => !final.has(id)),
  };
}
