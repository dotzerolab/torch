// `createIssue` (spec section 6): one function creates an issue with every field it can start with, in ONE transaction:
// the number from the team's counter, the row, its labels, subscribers, links and external reference, the activity row
// and the outbox event, the idempotency record, and the transaction id for the client. REST (and later MCP and the
// public API) call this function; the HTTP route (routes.ts) is a thin wrapper.
import { createHash } from 'node:crypto';
import {
  type ExternalRefRow,
  externalRef,
  idempotencyKey,
  issue,
  issueLabel,
  issueLink,
  issueSubscriber,
  team,
  workflowState,
} from '@torch/shared/db/schema';
import { type IssueCreateInput, issueCreateInput } from '@torch/shared/mutations/issue';
import { canCreateIssue, canSeeTeam, type TeamAccess } from '@torch/shared/permissions';
import { and, eq, isNull, sql } from 'drizzle-orm';
import { recordIssueChange } from '../activity/record.ts';
import type { Orm, Tx } from '../db.ts';
import { currentTxid } from '../mutations/txid.ts';
import { currentActor } from '../permissions/current-actor.ts';
import type { ClientActor } from '../permissions/load-actor.ts';
import { isUniqueViolation } from '../util/pg-error.ts';
import { type ExternalRefDto, type IssueDto, toIssueDto } from './dto.ts';
import { type IssueApiError, IssueRefusal, invalidReference, refusal } from './errors.ts';
import {
  keepLastLabelPerGroup,
  membersWhoCanSeeTeam,
  usableLabels,
  usableParent,
} from './references.ts';
import { applyStateTimestamps } from './state-timestamps.ts';

export type CreatedIssue = { issue: IssueDto; txid: number };

export type CreateIssueResult =
  | { ok: true; replayed: boolean; body: CreatedIssue }
  | { ok: false; error: IssueApiError };

/** Sorted keys at every depth, so two bodies with the same content hash the same whatever the key order. */
function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

const hashRequest = (input: IssueCreateInput): string =>
  createHash('sha256').update(canonicalJson(input)).digest('hex');

/**
 * Creates one issue. `idempotencyKey` (the `Idempotency-Key` header) makes a retry safe: the same actor, key and body
 * get the stored answer again and consume no number; the same key with another body is 422. A refusal rolls the
 * whole transaction back, so a refused create never uses a number and never keeps its key.
 */
export async function createIssue(
  orm: Orm,
  actor: ClientActor,
  input: IssueCreateInput,
  opts: { idempotencyKey?: string } = {},
): Promise<CreateIssueResult> {
  // The type says "validated", the function does not rely on it.
  const parsed = issueCreateInput.safeParse(input);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    const where = first?.path.length ? `${first.path.join('.')}: ` : '';
    return fail({ code: 'invalid_input', status: 400, message: `${where}${first?.message ?? ''}` });
  }
  const data = parsed.data;

  try {
    return await orm.transaction((tx) => createInTransaction(tx, actor, data, opts.idempotencyKey));
  } catch (error) {
    if (error instanceof IssueRefusal) return fail(error.error);
    if (data.externalRef && isUniqueViolation(error, 'external_ref_source_id_unique')) {
      // Lost a race for the same external reference: the other create won, this one is rolled back (no number used).
      return fail(await externalRefConflict(orm, actor, data.externalRef));
    }
    throw error;
  }
}

const fail = (error: IssueApiError): CreateIssueResult => ({ ok: false, error });

async function createInTransaction(
  tx: Tx,
  requested: ClientActor,
  data: IssueCreateInput,
  idempotencyKeyValue: string | undefined,
): Promise<CreateIssueResult> {
  const requestHash = hashRequest(data);

  // The key row comes first: a second request with the same key waits here for the first one to commit or roll back,
  // then replays its answer (or, after a rollback, runs). Its row is finished at the end, in this transaction.
  if (idempotencyKeyValue !== undefined) {
    const inserted = await tx
      .insert(idempotencyKey)
      .values({
        workspaceId: requested.workspaceId,
        actorId: requested.memberId,
        key: idempotencyKeyValue,
        requestHash,
        status: 0,
        response: {},
      })
      .onConflictDoNothing()
      .returning({ key: idempotencyKey.key });
    if (inserted.length === 0) {
      const [stored] = await tx
        .select()
        .from(idempotencyKey)
        .where(
          and(
            eq(idempotencyKey.workspaceId, requested.workspaceId),
            eq(idempotencyKey.actorId, requested.memberId),
            eq(idempotencyKey.key, idempotencyKeyValue),
          ),
        );
      if (!stored) throw refusal('not_found', 404);
      if (stored.requestHash !== requestHash) throw refusal('idempotency_key_reused', 422);
      return { ok: true, replayed: true, body: stored.response as CreatedIssue };
    }
  }

  // The actor as the database says now: a member removed from the team after the request was resolved gets nothing.
  const fresh = await currentActor(tx, requested);
  if (!fresh) throw refusal('unauthenticated', 401);
  const actor: ClientActor = { ...fresh, client: requested.client };

  const [teamRow] = await tx
    .select({ id: team.id, workspaceId: team.workspaceId, private: team.private, key: team.key })
    .from(team)
    .where(and(eq(team.workspaceId, actor.workspaceId), eq(team.id, data.teamId)));
  if (!teamRow) throw refusal('not_found', 404);
  const access: TeamAccess = {
    id: teamRow.id,
    workspaceId: teamRow.workspaceId,
    private: teamRow.private,
  };
  if (!canSeeTeam(actor, access)) throw refusal('not_found', 404);
  if (!canCreateIssue(actor, access)) throw refusal('forbidden', 403);

  // ---- the number ----
  // The team row lock comes FIRST, before the state lock below: the archive of a state locks the team, then the state,
  // so a create that took the state first and the team second would close a deadlock cycle with it. The update takes
  // the lock: creates in one team queue here, so numbers are 1, 2, 3 with no gap and no duplicate. Every refusal
  // below rolls the transaction back, and with it the number.
  const [counter] = await tx
    .update(team)
    .set({ issueCounter: sql`${team.issueCounter} + 1` })
    .where(and(eq(team.workspaceId, actor.workspaceId), eq(team.id, teamRow.id)))
    .returning({ number: team.issueCounter });
  if (!counter) throw refusal('not_found', 404);

  // ---- references: all of them are checked before the row is written ----
  const states = await tx
    .select({ id: workflowState.id, type: workflowState.type, position: workflowState.position })
    .from(workflowState)
    .where(
      and(
        eq(workflowState.workspaceId, actor.workspaceId),
        eq(workflowState.teamId, teamRow.id),
        isNull(workflowState.archivedAt),
      ),
    )
    .orderBy(workflowState.position);
  const state = data.stateId
    ? states.find((candidate) => candidate.id === data.stateId)
    : (states.find((candidate) => candidate.type === 'backlog') ??
      states.find((candidate) => candidate.type === 'unstarted'));
  if (!state) throw invalidReference('stateId');
  // A shared lock on the state row, taken with "not archived" in the condition: an archive of this state (which locks
  // the row exclusively) either finishes first, and the row no longer matches, or waits for this transaction.
  const [stillOpen] = await tx
    .select({ id: workflowState.id })
    .from(workflowState)
    .where(and(eq(workflowState.id, state.id), isNull(workflowState.archivedAt)))
    .for('share');
  if (!stillOpen) throw invalidReference('stateId');

  const people = new Set<string>([...(data.subscriberIds ?? [])]);
  if (data.assigneeId) people.add(data.assigneeId);
  const visiblePeople = await membersWhoCanSeeTeam(tx, access, [...people]);
  if (data.assigneeId && !visiblePeople.has(data.assigneeId)) throw invalidReference('assigneeId');
  for (const id of data.subscriberIds ?? []) {
    if (!visiblePeople.has(id)) throw invalidReference('subscriberIds');
  }

  const labels = await usableLabels(tx, actor.workspaceId, teamRow.id, data.labelIds ?? []);
  if (!labels) throw invalidReference('labelIds');
  const keptLabels = keepLastLabelPerGroup(labels);

  if (data.parentId && !(await usableParent(tx, actor, data.parentId))) {
    throw invalidReference('parentId');
  }

  if (data.externalRef) {
    const taken = await findExternalRef(tx, actor.workspaceId, data.externalRef);
    if (taken) throw new IssueRefusal(await conflictFor(tx, actor, taken, data.externalRef));
  }

  // ---- the row ----
  const sortOrder = data.sortOrder ?? (await topOfState(tx, teamRow.id, state.id));
  const stamps = applyStateTimestamps(
    state.type,
    { startedAt: null, completedAt: null, canceledAt: null },
    new Date(),
  );
  const [created] = await tx
    .insert(issue)
    .values({
      workspaceId: actor.workspaceId,
      teamId: teamRow.id,
      number: counter.number,
      title: data.title,
      description: data.description ?? '',
      stateId: state.id,
      priority: data.priority ?? 0,
      estimate: data.estimate ?? null,
      dueDate: data.dueDate ?? null,
      assigneeId: data.assigneeId ?? null,
      creatorId: actor.memberId,
      parentId: data.parentId ?? null,
      sortOrder,
      ...stamps,
    })
    .returning();
  if (!created) throw new Error('issue insert returned no row');

  const where = { workspaceId: actor.workspaceId, teamId: teamRow.id, issueId: created.id };
  if (keptLabels.length > 0) {
    await tx.insert(issueLabel).values(keptLabels.map((row) => ({ ...where, labelId: row.id })));
  }
  // The creator and the assignee follow the issue, next to the people the caller listed.
  const subscribers = new Set<string>([actor.memberId, ...(data.subscriberIds ?? [])]);
  if (data.assigneeId) subscribers.add(data.assigneeId);
  await tx
    .insert(issueSubscriber)
    .values([...subscribers].map((memberId) => ({ ...where, memberId })));
  if (data.links?.length) {
    await tx.insert(issueLink).values(
      data.links.map((link) => ({
        ...where,
        url: link.url,
        title: link.title ?? null,
        createdBy: actor.memberId,
      })),
    );
  }
  let ref: ExternalRefRow | undefined;
  if (data.externalRef) {
    [ref] = await tx
      .insert(externalRef)
      .values({
        workspaceId: actor.workspaceId,
        subjectType: 'issue',
        subjectId: created.id,
        source: data.externalRef.source,
        externalId: data.externalRef.id,
        url: data.externalRef.url ?? null,
      })
      .returning();
  }

  await recordIssueChange(tx, actor, { kind: 'created', issue: created, externalRef: ref });

  const body: CreatedIssue = {
    issue: toIssueDto(created, {
      teamKey: teamRow.key,
      labelIds: keptLabels.map((row) => row.id),
      externalRefs: ref ? [{ source: ref.source, id: ref.externalId, url: ref.url ?? null }] : [],
      includeDescription: true,
    }),
    txid: await currentTxid(tx),
  };

  if (idempotencyKeyValue !== undefined) {
    await tx
      .update(idempotencyKey)
      .set({ status: 201, response: body })
      .where(
        and(
          eq(idempotencyKey.workspaceId, actor.workspaceId),
          eq(idempotencyKey.actorId, actor.memberId),
          eq(idempotencyKey.key, idempotencyKeyValue),
        ),
      );
  }
  return { ok: true, replayed: false, body };
}

/** A new issue goes above the others of its state: one below the lowest sort order there (0 for the first). */
async function topOfState(tx: Tx, teamId: string, stateId: string): Promise<number> {
  const [row] = await tx
    .select({ lowest: sql<number | null>`min(${issue.sortOrder})` })
    .from(issue)
    .where(and(eq(issue.teamId, teamId), eq(issue.stateId, stateId)));
  return row?.lowest === null || row?.lowest === undefined ? 0 : row.lowest - 1;
}

async function findExternalRef(
  tx: Tx,
  workspaceId: string,
  ref: { source: string; id: string },
): Promise<{ subjectId: string } | undefined> {
  const [row] = await tx
    .select({ subjectId: externalRef.subjectId })
    .from(externalRef)
    .where(
      and(
        eq(externalRef.workspaceId, workspaceId),
        eq(externalRef.source, ref.source),
        eq(externalRef.externalId, ref.id),
      ),
    );
  return row;
}

/** The 409 for an external reference in use. The existing issue is named only to somebody who can see its team. */
async function conflictFor(
  tx: Tx,
  actor: ClientActor,
  taken: { subjectId: string },
  ref: { source: string; id: string },
): Promise<IssueApiError> {
  const base: IssueApiError = {
    code: 'external_ref_exists',
    status: 409,
    message: `An issue with the external reference ${ref.source}:${ref.id} already exists.`,
  };
  const [row] = await tx
    .select({
      id: issue.id,
      number: issue.number,
      teamId: issue.teamId,
      key: team.key,
      teamPrivate: team.private,
    })
    .from(issue)
    .innerJoin(team, and(eq(team.workspaceId, issue.workspaceId), eq(team.id, issue.teamId)))
    .where(and(eq(issue.workspaceId, actor.workspaceId), eq(issue.id, taken.subjectId)));
  if (!row) return base;
  const visible = canSeeTeam(actor, {
    id: row.teamId,
    workspaceId: actor.workspaceId,
    private: row.teamPrivate,
  });
  return visible
    ? { ...base, details: { issueId: row.id, identifier: `${row.key}-${row.number}` } }
    : base;
}

/** The conflict after a lost race, read outside the rolled-back transaction. */
async function externalRefConflict(
  orm: Orm,
  actor: ClientActor,
  ref: { source: string; id: string },
): Promise<IssueApiError> {
  return orm.transaction(async (tx) => {
    const taken = await findExternalRef(tx, actor.workspaceId, ref);
    const current = await currentActor(tx, actor);
    const reader: ClientActor = { ...(current ?? actor), client: actor.client };
    if (!taken) return { code: 'external_ref_exists', status: 409 } satisfies IssueApiError;
    return conflictFor(tx, reader, taken, ref);
  });
}

export type { ExternalRefDto };
