// Workflow states of a team (spec section 6): list, create, edit and archive. States are archived, never deleted. An
// archived state keeps the issues that sit in it, takes no new ones and frees its name. A team always keeps one
// backlog or unstarted state (where new issues start) and one completed state.
import { issue, team, type WorkflowStateRow, workflowState } from '@torch/shared/db/schema';
import {
  type WorkflowStateArchiveInput,
  type WorkflowStateCreateInput,
  type WorkflowStateUpdateInput,
  workflowStateArchiveInput,
  workflowStateCreateInput,
  workflowStateUpdateInput,
} from '@torch/shared/mutations/workflow';
import { canManageWorkflow } from '@torch/shared/permissions';
import { and, asc, eq, isNull, ne, sql } from 'drizzle-orm';
import { recordIssueChange } from '../activity/record.ts';
import type { Orm, Tx } from '../db.ts';
import type { ChangeResult } from '../issues/join-changes.ts';
import { visibleTeam } from '../issues/references.ts';
import { applyStateTimestamps } from '../issues/state-timestamps.ts';
import {
  type Failure,
  invalidReferenceFailure,
  lockParentTree,
  refuse,
} from '../issues/update-issue.ts';
import { currentTxid } from '../mutations/txid.ts';
import { currentActor } from '../permissions/current-actor.ts';
import type { ClientActor } from '../permissions/load-actor.ts';
import { isUniqueViolation } from '../util/pg-error.ts';
import { isUuid } from '../util/uuid.ts';

export type WorkflowStateDto = {
  id: string;
  teamId: string;
  name: string;
  type: WorkflowStateRow['type'];
  position: number;
  color: string;
  archivedAt: string | null;
  createdAt: string;
};

const NAME_INDEX = 'workflow_state_team_name_unique';

export const toStateDto = (row: WorkflowStateRow): WorkflowStateDto => ({
  id: row.id,
  teamId: row.teamId,
  name: row.name,
  type: row.type,
  position: row.position,
  color: row.color,
  archivedAt: row.archivedAt?.toISOString() ?? null,
  createdAt: row.createdAt.toISOString(),
});

async function freshActor(tx: Tx, requested: ClientActor): Promise<ClientActor | Failure> {
  const fresh = await currentActor(tx, requested);
  return fresh ? { ...fresh, client: requested.client } : refuse('unauthenticated', 401);
}

/** The team's states in workflow order. Anyone who can see the team reads them; archived ones only on request. */
export async function listWorkflowStates(
  orm: Orm,
  requested: ClientActor,
  teamId: string,
  options: { includeArchived?: boolean } = {},
): Promise<{ ok: true; value: WorkflowStateDto[] } | Failure> {
  if (!isUuid(teamId)) return refuse('not_found', 404);
  return orm.transaction(async (tx) => {
    const actor = await freshActor(tx, requested);
    if ('ok' in actor) return actor;
    if (!(await visibleTeam(tx, actor, teamId))) return refuse('not_found', 404);
    const rows = await tx
      .select()
      .from(workflowState)
      .where(
        and(
          eq(workflowState.workspaceId, actor.workspaceId),
          eq(workflowState.teamId, teamId),
          options.includeArchived ? undefined : isNull(workflowState.archivedAt),
        ),
      )
      .orderBy(asc(workflowState.position), asc(workflowState.id));
    return { ok: true as const, value: rows.map(toStateDto) };
  });
}

/** The team for a management call: 404 when hidden or missing, 403 when the actor may not manage its workflow. */
async function manageableTeam(tx: Tx, actor: ClientActor, teamId: string) {
  const access = await visibleTeam(tx, actor, teamId);
  if (!access) return refuse('not_found', 404);
  if (!canManageWorkflow(actor, access)) return refuse('forbidden', 403);
  return access;
}

export async function createWorkflowState(
  orm: Orm,
  requested: ClientActor,
  teamId: string,
  input: WorkflowStateCreateInput,
): Promise<ChangeResult<WorkflowStateDto>> {
  const parsed = workflowStateCreateInput.safeParse(input);
  if (!parsed.success) return refuse('invalid_input', 400);
  const data = parsed.data;
  if (!isUuid(teamId)) return refuse('not_found', 404);
  try {
    return await orm.transaction(async (tx) => {
      const actor = await freshActor(tx, requested);
      if ('ok' in actor) return actor;
      const access = await manageableTeam(tx, actor, teamId);
      if ('ok' in access) return access;
      let position = data.position;
      if (position === undefined) {
        const [last] = await tx
          .select({ max: sql<number | null>`max(${workflowState.position})` })
          .from(workflowState)
          .where(eq(workflowState.teamId, teamId));
        position = (last?.max ?? -1) + 1;
      }
      const [row] = await tx
        .insert(workflowState)
        .values({
          workspaceId: actor.workspaceId,
          teamId,
          name: data.name,
          type: data.type,
          position,
          ...(data.color ? { color: data.color } : {}),
        })
        .returning();
      if (!row) throw new Error('workflow state insert returned no row');
      return { ok: true as const, txid: await currentTxid(tx), value: toStateDto(row) };
    });
  } catch (error) {
    if (isUniqueViolation(error, NAME_INDEX)) return refuse('workflow_state_name_taken', 409);
    throw error;
  }
}

export async function updateWorkflowState(
  orm: Orm,
  requested: ClientActor,
  teamId: string,
  stateId: string,
  input: WorkflowStateUpdateInput,
): Promise<ChangeResult<WorkflowStateDto>> {
  const parsed = workflowStateUpdateInput.safeParse(input);
  if (!parsed.success) return refuse('invalid_input', 400);
  const changes = parsed.data;
  if (!isUuid(teamId) || !isUuid(stateId)) return refuse('not_found', 404);
  try {
    return await orm.transaction(async (tx) => {
      const actor = await freshActor(tx, requested);
      if ('ok' in actor) return actor;
      const access = await manageableTeam(tx, actor, teamId);
      if ('ok' in access) return access;
      const set: Partial<typeof workflowState.$inferInsert> = {};
      if (changes.name !== undefined) set.name = changes.name;
      if (changes.color !== undefined) set.color = changes.color;
      if (changes.position !== undefined) set.position = changes.position;
      const [after] = await tx
        .update(workflowState)
        .set(set)
        .where(
          and(
            eq(workflowState.id, stateId),
            eq(workflowState.teamId, teamId),
            eq(workflowState.workspaceId, actor.workspaceId),
          ),
        )
        .returning();
      if (!after) return refuse('not_found', 404);
      return { ok: true as const, txid: await currentTxid(tx), value: toStateDto(after) };
    });
  } catch (error) {
    if (isUniqueViolation(error, NAME_INDEX)) return refuse('workflow_state_name_taken', 409);
    throw error;
  }
}

/**
 * Archives a state. The issues that are not archived and sit in it move to `moveIssuesTo` (a state of the same team that
 * is not archived), each with its own history row and event, as an edit by the caller. Locks, in this order, like every
 * other writer: the workspace parent lock, the team row (archives of one team queue), the state, the issues by id and
 * the target state (shared). Archiving twice changes nothing. The team and issue locks are `no key update`: `for update`
 * would conflict with the `for key share` of the foreign-key checks of other writers (an event of the team, a relation
 * to an issue) and deadlock with them.
 */
export async function archiveWorkflowState(
  orm: Orm,
  requested: ClientActor,
  teamId: string,
  stateId: string,
  input: WorkflowStateArchiveInput = {},
): Promise<ChangeResult<WorkflowStateDto>> {
  const parsed = workflowStateArchiveInput.safeParse(input);
  if (!parsed.success) return refuse('invalid_input', 400);
  const target = parsed.data.moveIssuesTo;
  if (!isUuid(teamId) || !isUuid(stateId)) return refuse('not_found', 404);
  return orm.transaction(async (tx) => {
    const early = await freshActor(tx, requested);
    if ('ok' in early) return early;
    const checked = await manageableTeam(tx, early, teamId);
    if ('ok' in checked) return checked;

    await lockParentTree(tx, requested.workspaceId);
    await tx
      .select({ id: team.id })
      .from(team)
      .where(and(eq(team.id, teamId), eq(team.workspaceId, requested.workspaceId)))
      .for('no key update');
    // Re-read under the locks: a role or a team that changed while this call waited counts.
    const actor = await freshActor(tx, requested);
    if ('ok' in actor) return actor;
    const access = await manageableTeam(tx, actor, teamId);
    if ('ok' in access) return access;

    const [state] = await tx
      .select()
      .from(workflowState)
      .where(
        and(
          eq(workflowState.id, stateId),
          eq(workflowState.teamId, teamId),
          eq(workflowState.workspaceId, actor.workspaceId),
        ),
      )
      .for('update');
    if (!state) return refuse('not_found', 404);
    if (state.archivedAt) {
      return { ok: true as const, txid: await currentTxid(tx), value: toStateDto(state) };
    }

    const remaining = await tx
      .select({ type: workflowState.type })
      .from(workflowState)
      .where(
        and(
          eq(workflowState.teamId, teamId),
          isNull(workflowState.archivedAt),
          ne(workflowState.id, stateId),
        ),
      );
    const has = (...types: string[]) => remaining.some((row) => types.includes(row.type));
    if (!has('backlog', 'unstarted') || !has('completed')) {
      return refuse('workflow_state_required', 422);
    }

    const inState = await tx
      .select()
      .from(issue)
      .where(
        and(
          eq(issue.workspaceId, actor.workspaceId),
          eq(issue.teamId, teamId),
          eq(issue.stateId, stateId),
          isNull(issue.archivedAt),
        ),
      )
      .orderBy(asc(issue.id))
      .for('no key update');
    if (inState.length > 0 && !target) return refuse('move_target_required', 422);
    if (target) {
      const [destination] = await tx
        .select()
        .from(workflowState)
        .where(
          and(
            eq(workflowState.id, target),
            eq(workflowState.teamId, teamId),
            eq(workflowState.workspaceId, actor.workspaceId),
            isNull(workflowState.archivedAt),
            ne(workflowState.id, stateId),
          ),
        )
        .for('share');
      if (!destination) return invalidReferenceFailure('moveIssuesTo');
      const now = new Date();
      for (const before of inState) {
        const [after] = await tx
          .update(issue)
          .set({
            stateId: destination.id,
            ...applyStateTimestamps(destination.type, before, now),
            updatedAt: sql`clock_timestamp()`,
          })
          .where(and(eq(issue.id, before.id), eq(issue.workspaceId, actor.workspaceId)))
          .returning();
        if (!after) throw new Error('issue update returned no row');
        await recordIssueChange(tx, actor, { kind: 'updated', before, after });
      }
    }

    const [archived] = await tx
      .update(workflowState)
      .set({ archivedAt: new Date() })
      .where(eq(workflowState.id, stateId))
      .returning();
    if (!archived) throw new Error('workflow state archive returned no row');
    return { ok: true as const, txid: await currentTxid(tx), value: toStateDto(archived) };
  });
}
