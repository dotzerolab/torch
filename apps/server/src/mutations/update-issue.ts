// The issue update mutation (ADR 0001 section 1): permission check, validation, write and transaction id in ONE
// transaction. REST, MCP and the assistant call this function; the HTTP route (routes.ts) is a thin wrapper.
import { issue, member, team, teamMember, workflowState } from '@torch/shared/db/schema';
import {
  type IssueUpdateInput,
  issueUpdateInput,
  type MutationErrorCode,
} from '@torch/shared/mutations/issue';
import { type Actor, canEditIssues, canSeeTeam, type TeamAccess } from '@torch/shared/permissions';
import { and, eq, isNull, sql } from 'drizzle-orm';
import type { Orm, Tx } from '../db.ts';
import { isUuid } from '../util/uuid.ts';
import { currentTxid } from './txid.ts';

export type UpdateIssueResult =
  | { ok: true; txid: number }
  | { ok: false; code: MutationErrorCode; status: 400 | 403 | 404 };

const refuse = (code: MutationErrorCode, status: 400 | 403 | 404): UpdateIssueResult => ({
  ok: false,
  code,
  status,
});

/** An assignee must be an active member of this workspace who can see the issue's team. */
async function canBeAssigned(tx: Tx, access: TeamAccess, assigneeId: string): Promise<boolean> {
  const workspaceId = access.workspaceId;
  const [found] = await tx
    .select({ role: member.role })
    .from(member)
    .where(
      and(
        eq(member.workspaceId, workspaceId),
        eq(member.id, assigneeId),
        isNull(member.deactivatedAt),
      ),
    );
  if (!found) return false;

  const [membership] = await tx
    .select({ teamId: teamMember.teamId })
    .from(teamMember)
    .where(
      and(
        eq(teamMember.workspaceId, workspaceId),
        eq(teamMember.teamId, access.id),
        eq(teamMember.memberId, assigneeId),
      ),
    );
  const assignee: Actor = {
    workspaceId,
    memberId: assigneeId,
    role: found.role,
    teamIds: new Set(membership ? [access.id] : []),
  };
  return canSeeTeam(assignee, access);
}

/**
 * Updates the given fields of one issue and returns the Postgres transaction id for the client's `awaitTxId`.
 * Refusals never reveal more than "not found": an issue of another workspace or of a team the actor cannot see
 * answers 404 exactly like an id that does not exist.
 */
export async function updateIssue(
  orm: Orm,
  actor: Actor,
  issueId: string,
  input: IssueUpdateInput,
): Promise<UpdateIssueResult> {
  // The type says "validated", the function does not rely on it: protected columns stay protected.
  const parsed = issueUpdateInput.safeParse(input);
  if (!parsed.success) return refuse('invalid_input', 400);
  const changes = parsed.data;
  if (!isUuid(issueId)) return refuse('not_found', 404);

  return orm.transaction(async (tx) => {
    // Locks the row: concurrent writers of this issue queue here, so each field's last writer wins in order.
    const [target] = await tx
      .select({ teamId: issue.teamId })
      .from(issue)
      .where(and(eq(issue.id, issueId), eq(issue.workspaceId, actor.workspaceId)))
      .for('update');
    if (!target) return refuse('not_found', 404);

    const [access] = await tx
      .select({ id: team.id, workspaceId: team.workspaceId, private: team.private })
      .from(team)
      .where(and(eq(team.workspaceId, actor.workspaceId), eq(team.id, target.teamId)));
    if (!access || !canSeeTeam(actor, access)) return refuse('not_found', 404);
    if (!canEditIssues(actor, access)) return refuse('forbidden', 403);

    if (changes.stateId !== undefined) {
      const [state] = await tx
        .select({ id: workflowState.id })
        .from(workflowState)
        .where(and(eq(workflowState.id, changes.stateId), eq(workflowState.teamId, target.teamId)));
      if (!state) return refuse('invalid_state', 400);
    }
    if (changes.assigneeId) {
      if (!(await canBeAssigned(tx, access, changes.assigneeId))) {
        return refuse('invalid_assignee', 400);
      }
    }

    // Only the given fields, plus updated_at. clock_timestamp(), not now(): a writer that waited for the lock
    // must not stamp the row with its (older) transaction start time.
    const set: Partial<typeof issue.$inferInsert> = {};
    if (changes.title !== undefined) set.title = changes.title;
    if (changes.priority !== undefined) set.priority = changes.priority;
    if (changes.stateId !== undefined) set.stateId = changes.stateId;
    if (changes.assigneeId !== undefined) set.assigneeId = changes.assigneeId;
    await tx
      .update(issue)
      .set({ ...set, updatedAt: sql`clock_timestamp()` })
      .where(and(eq(issue.id, issueId), eq(issue.workspaceId, actor.workspaceId)));

    // Electric reports this id for the transaction's rows; the client waits for it (`awaitTxId`).
    return { ok: true as const, txid: await currentTxid(tx) };
  });
}
