// Labels and label groups (spec section 6). A label belongs to the workspace or to one team; a group is a label that
// only groups (it is never put on an issue); a child sits in a group of its own scope. Labels are archived, never
// deleted: an archived label stays on the issues that carry it, takes no new ones and frees its name.
import { type LabelRow, label, team } from '@torch/shared/db/schema';
import {
  type LabelCreateInput,
  type LabelUpdateInput,
  labelCreateInput,
  labelUpdateInput,
} from '@torch/shared/mutations/workflow';
import { canManageLabels, canSeeTeam, type TeamAccess } from '@torch/shared/permissions';
import { and, asc, eq, inArray, isNull, or } from 'drizzle-orm';
import type { Orm, Tx } from '../db.ts';
import type { ChangeResult } from '../issues/join-changes.ts';
import { visibleTeam } from '../issues/references.ts';
import { type Failure, invalidReferenceFailure, refuse } from '../issues/update-issue.ts';
import { currentTxid } from '../mutations/txid.ts';
import { currentActor } from '../permissions/current-actor.ts';
import type { ClientActor } from '../permissions/load-actor.ts';
import { isUniqueViolation } from '../util/pg-error.ts';
import { isUuid } from '../util/uuid.ts';

export type LabelDto = {
  id: string;
  teamId: string | null;
  parentId: string | null;
  name: string;
  color: string;
  isGroup: boolean;
  archivedAt: string | null;
  createdAt: string;
};

const NAME_INDEX = 'label_scope_name_unique';

export const toLabelDto = (row: LabelRow): LabelDto => ({
  id: row.id,
  teamId: row.teamId,
  parentId: row.parentId,
  name: row.name,
  color: row.color,
  isGroup: row.isGroup,
  archivedAt: row.archivedAt?.toISOString() ?? null,
  createdAt: row.createdAt.toISOString(),
});

/** The actor as the database says now, or the 401 for a member who is gone. */
async function freshActor(tx: Tx, requested: ClientActor): Promise<ClientActor | Failure> {
  const fresh = await currentActor(tx, requested);
  return fresh ? { ...fresh, client: requested.client } : refuse('unauthenticated', 401);
}

/**
 * The labels the actor can see: those of the workspace and those of the teams they can see. With `teamId`, the ones an
 * issue of that team may carry (the workspace's and that team's); a team the actor cannot see is 404.
 */
export async function listLabels(
  orm: Orm,
  requested: ClientActor,
  options: { teamId?: string; includeArchived?: boolean } = {},
): Promise<{ ok: true; value: LabelDto[] } | Failure> {
  if (options.teamId !== undefined && !isUuid(options.teamId)) return refuse('not_found', 404);
  return orm.transaction(async (tx) => {
    const actor = await freshActor(tx, requested);
    if ('ok' in actor) return actor;
    let teamIds: string[];
    if (options.teamId !== undefined) {
      if (!(await visibleTeam(tx, actor, options.teamId))) return refuse('not_found', 404);
      teamIds = [options.teamId];
    } else {
      const teams = await tx
        .select({ id: team.id, workspaceId: team.workspaceId, private: team.private })
        .from(team)
        .where(eq(team.workspaceId, actor.workspaceId));
      teamIds = teams.filter((access) => canSeeTeam(actor, access)).map((access) => access.id);
    }
    const scope = or(
      isNull(label.teamId),
      teamIds.length > 0 ? inArray(label.teamId, teamIds) : undefined,
    );
    const rows = await tx
      .select()
      .from(label)
      .where(
        and(
          eq(label.workspaceId, actor.workspaceId),
          scope,
          options.includeArchived ? undefined : isNull(label.archivedAt),
        ),
      )
      .orderBy(asc(label.name), asc(label.id));
    return { ok: true as const, value: rows.map(toLabelDto) };
  });
}

/** A group of the same scope as `teamId`, not archived: the only thing a label may be a child of. */
async function usableGroup(
  tx: Tx,
  workspaceId: string,
  teamId: string | null,
  parentId: string,
): Promise<boolean> {
  const [group] = await tx
    .select({ id: label.id })
    .from(label)
    .where(
      and(
        eq(label.workspaceId, workspaceId),
        eq(label.id, parentId),
        eq(label.isGroup, true),
        isNull(label.archivedAt),
        teamId === null ? isNull(label.teamId) : eq(label.teamId, teamId),
      ),
    );
  return Boolean(group);
}

export async function createLabel(
  orm: Orm,
  requested: ClientActor,
  input: LabelCreateInput,
): Promise<ChangeResult<LabelDto>> {
  const parsed = labelCreateInput.safeParse(input);
  if (!parsed.success) return refuse('invalid_input', 400);
  const data = parsed.data;
  if (data.isGroup && data.parentId)
    return refuse('invalid_input', 400, { message: 'A group has no parent.' });
  try {
    return await orm.transaction(async (tx) => {
      const actor = await freshActor(tx, requested);
      if ('ok' in actor) return actor;
      let access: TeamAccess | null = null;
      if (data.teamId) {
        access = await visibleTeam(tx, actor, data.teamId);
        if (!access) return refuse('not_found', 404);
      }
      if (!canManageLabels(actor, access)) return refuse('forbidden', 403);
      if (
        data.parentId &&
        !(await usableGroup(tx, actor.workspaceId, data.teamId ?? null, data.parentId))
      ) {
        return invalidReferenceFailure('parentId');
      }
      const [row] = await tx
        .insert(label)
        .values({
          workspaceId: actor.workspaceId,
          teamId: data.teamId ?? null,
          parentId: data.parentId ?? null,
          name: data.name,
          color: data.color,
          isGroup: data.isGroup ?? false,
        })
        .returning();
      if (!row) throw new Error('label insert returned no row');
      return { ok: true as const, txid: await currentTxid(tx), value: toLabelDto(row) };
    });
  } catch (error) {
    if (isUniqueViolation(error, NAME_INDEX)) return refuse('label_name_taken', 409);
    throw error;
  }
}

/** The label under a row lock and the actor's access to it: 404 where hidden or missing, 403 where they may not manage it. */
async function lockManageable(tx: Tx, requested: ClientActor, labelId: string) {
  const actor = await freshActor(tx, requested);
  if ('ok' in actor) return { refusal: actor };
  const [row] = await tx
    .select()
    .from(label)
    .where(and(eq(label.workspaceId, actor.workspaceId), eq(label.id, labelId)))
    .for('update');
  if (!row) return { refusal: refuse('not_found', 404) };
  let access: TeamAccess | null = null;
  if (row.teamId) {
    access = await visibleTeam(tx, actor, row.teamId);
    if (!access) return { refusal: refuse('not_found', 404) };
  }
  if (!canManageLabels(actor, access)) return { refusal: refuse('forbidden', 403) };
  return { row, actor };
}

export async function updateLabel(
  orm: Orm,
  requested: ClientActor,
  labelId: string,
  input: LabelUpdateInput,
): Promise<ChangeResult<LabelDto>> {
  const parsed = labelUpdateInput.safeParse(input);
  if (!parsed.success) return refuse('invalid_input', 400);
  const changes = parsed.data;
  if (!isUuid(labelId)) return refuse('not_found', 404);
  try {
    return await orm.transaction(async (tx) => {
      const locked = await lockManageable(tx, requested, labelId);
      if (locked.refusal) return locked.refusal;
      const { row, actor } = locked;
      if (changes.parentId && row.isGroup) {
        return refuse('invalid_input', 400, { message: 'A group has no parent.' });
      }
      if (
        changes.parentId &&
        !(await usableGroup(tx, actor.workspaceId, row.teamId, changes.parentId))
      ) {
        return invalidReferenceFailure('parentId');
      }
      const set: Partial<typeof label.$inferInsert> = {};
      if (changes.name !== undefined) set.name = changes.name;
      if (changes.color !== undefined) set.color = changes.color;
      if (changes.parentId !== undefined) set.parentId = changes.parentId;
      const [after] = await tx
        .update(label)
        .set(set)
        .where(and(eq(label.id, labelId), eq(label.workspaceId, actor.workspaceId)))
        .returning();
      if (!after) throw new Error('label update returned no row');
      return { ok: true as const, txid: await currentTxid(tx), value: toLabelDto(after) };
    });
  } catch (error) {
    if (isUniqueViolation(error, NAME_INDEX)) return refuse('label_name_taken', 409);
    throw error;
  }
}

/** Archives a label (a group too: its children keep it as their parent). Archiving twice changes nothing. */
export async function archiveLabel(
  orm: Orm,
  requested: ClientActor,
  labelId: string,
): Promise<ChangeResult<LabelDto>> {
  if (!isUuid(labelId)) return refuse('not_found', 404);
  return orm.transaction(async (tx) => {
    const locked = await lockManageable(tx, requested, labelId);
    if (locked.refusal) return locked.refusal;
    const { row, actor } = locked;
    if (row.archivedAt) {
      return { ok: true as const, txid: await currentTxid(tx), value: toLabelDto(row) };
    }
    const [after] = await tx
      .update(label)
      .set({ archivedAt: new Date() })
      .where(and(eq(label.id, labelId), eq(label.workspaceId, actor.workspaceId)))
      .returning();
    if (!after) throw new Error('label archive returned no row');
    return { ok: true as const, txid: await currentTxid(tx), value: toLabelDto(after) };
  });
}
