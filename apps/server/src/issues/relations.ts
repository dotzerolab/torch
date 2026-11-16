// Relations between issues (spec section 6): `blocks`, `related`, `duplicate`, stored once. `blocks` and `duplicate`
// have a direction; `related` is symmetric and is stored with the lower id first.
// `blocked_by` is `blocks` read from the other end. The other issue may be in another team; the actor must be able to
// see it, and a hidden issue is "not found" like a missing one. A read never gives a hidden issue's title or number.
import { issue, issueRelation, team } from '@torch/shared/db/schema';
import { type IssueRelationInput, issueRelationInput } from '@torch/shared/mutations/issue';
import { canSeeTeam } from '@torch/shared/permissions';
import { and, eq, inArray, or } from 'drizzle-orm';
import { recordIssueChange } from '../activity/record.ts';
import type { Orm } from '../db.ts';
import type { ClientActor } from '../permissions/load-actor.ts';
import { isUniqueViolation } from '../util/pg-error.ts';
import { isUuid } from '../util/uuid.ts';
import { type ChangeResult, changeIssueJoin } from './join-changes.ts';
import { visibleIssue } from './references.ts';
import { type Failure, invalidReferenceFailure, refuse } from './update-issue.ts';

export type RelationType = IssueRelationInput['type'];
export type RelationView = {
  id: string;
  /** Seen from this issue: `blocked_by` where the stored row says the other issue blocks this one. */
  type: RelationType;
  /** The other issue. */
  issueId: string;
  /** Present only when the actor may see the other issue's team. */
  issue?: { identifier: string; title: string };
};

const SYMMETRIC: ReadonlySet<string> = new Set(['related', 'duplicate']);

export async function addRelation(
  orm: Orm,
  requested: ClientActor,
  issueId: string,
  input: IssueRelationInput,
): Promise<ChangeResult<{ id: string; type: RelationType; issueId: string }>> {
  const parsed = issueRelationInput.safeParse(input);
  if (!parsed.success) return refuse('invalid_input', 400);
  const data = parsed.data;
  try {
    return await changeIssueJoin(orm, requested, issueId, 'edit', async ({ tx, actor, row }) => {
      if (data.relatedIssueId === issueId) return invalidReferenceFailure('relatedIssueId');
      const other = await visibleIssue(tx, actor, data.relatedIssueId);
      if (!other) return refuse('not_found', 404);

      const reversed = data.type === 'blocked_by';
      const stored = data.type === 'blocked_by' ? 'blocks' : data.type;
      const here = { id: issueId, teamId: row.teamId };
      let [from, to] = reversed ? [other, here] : [here, other];
      // `related` has no direction: it is stored with the lower id first, so the unique key sees both ends as one row.
      if (stored === 'related' && from.id > to.id) [from, to] = [to, from];
      const forward = and(
        eq(issueRelation.issueId, from.id),
        eq(issueRelation.relatedIssueId, to.id),
      );
      const backward = and(
        eq(issueRelation.issueId, to.id),
        eq(issueRelation.relatedIssueId, from.id),
      );
      const [existing] = await tx
        .select({ id: issueRelation.id })
        .from(issueRelation)
        .where(
          and(
            eq(issueRelation.workspaceId, actor.workspaceId),
            eq(issueRelation.type, stored),
            SYMMETRIC.has(stored) ? or(forward, backward) : forward,
          ),
        );
      if (existing) return refuse('relation_exists', 409);

      const [created] = await tx
        .insert(issueRelation)
        .values({
          workspaceId: actor.workspaceId,
          teamId: from.teamId,
          issueId: from.id,
          relatedTeamId: to.teamId,
          relatedIssueId: to.id,
          type: stored,
          createdBy: actor.memberId,
        })
        .returning({ id: issueRelation.id });
      if (!created) throw new Error('relation insert returned no row');
      await recordIssueChange(tx, actor, {
        kind: 'relation',
        issueId,
        op: 'added',
        data: { relationId: created.id, type: data.type, relatedIssueId: data.relatedIssueId },
      });
      return {
        value: { id: created.id, type: data.type, issueId: data.relatedIssueId },
        changed: true,
      };
    });
  } catch (error) {
    // Two identical requests raced past the check above: the unique key lets one of them in.
    if (
      isUniqueViolation(error, 'issue_relation_unique') ||
      isUniqueViolation(error, 'issue_relation_pair_unique')
    ) {
      return refuse('relation_exists', 409);
    }
    throw error;
  }
}

export async function removeRelation(
  orm: Orm,
  requested: ClientActor,
  issueId: string,
  relationId: string,
): Promise<ChangeResult<null>> {
  if (!isUuid(relationId)) return refuse('not_found', 404);
  return changeIssueJoin(orm, requested, issueId, 'edit', async ({ tx, actor }) => {
    const [found] = await tx
      .select()
      .from(issueRelation)
      .where(
        and(
          eq(issueRelation.workspaceId, actor.workspaceId),
          eq(issueRelation.id, relationId),
          or(eq(issueRelation.issueId, issueId), eq(issueRelation.relatedIssueId, issueId)),
        ),
      )
      .for('update');
    if (!found) return refuse('not_found', 404);
    await tx.delete(issueRelation).where(eq(issueRelation.id, relationId));
    const outgoing = found.issueId === issueId;
    await recordIssueChange(tx, actor, {
      kind: 'relation',
      issueId,
      op: 'removed',
      data: {
        relationId,
        type: outgoing || found.type !== 'blocks' ? found.type : 'blocked_by',
        relatedIssueId: outgoing ? found.relatedIssueId : found.issueId,
      },
    });
    return { value: null, changed: true };
  });
}

/** The relations of an issue the actor can see; the other end's identifier and title only where its team is visible. */
export async function listRelations(
  orm: Orm,
  actor: ClientActor,
  issueId: string,
): Promise<{ ok: true; relations: RelationView[] } | Failure> {
  if (!isUuid(issueId)) return refuse('not_found', 404);
  const workspaceId = actor.workspaceId;
  const [subject] = await orm
    .select({ teamId: issue.teamId, teamPrivate: team.private })
    .from(issue)
    .innerJoin(team, and(eq(team.workspaceId, issue.workspaceId), eq(team.id, issue.teamId)))
    .where(and(eq(issue.workspaceId, workspaceId), eq(issue.id, issueId)));
  const access = subject && { id: subject.teamId, workspaceId, private: subject.teamPrivate };
  if (!access || !canSeeTeam(actor, access)) return refuse('not_found', 404);

  const rows = await orm
    .select()
    .from(issueRelation)
    .where(
      and(
        eq(issueRelation.workspaceId, workspaceId),
        or(eq(issueRelation.issueId, issueId), eq(issueRelation.relatedIssueId, issueId)),
      ),
    )
    .orderBy(issueRelation.createdAt, issueRelation.id);
  const otherId = (row: (typeof rows)[number]) =>
    row.issueId === issueId ? row.relatedIssueId : row.issueId;
  const ids = [...new Set(rows.map(otherId))];
  const others = ids.length
    ? await orm
        .select({
          id: issue.id,
          number: issue.number,
          title: issue.title,
          teamId: issue.teamId,
          key: team.key,
          teamPrivate: team.private,
        })
        .from(issue)
        .innerJoin(team, and(eq(team.workspaceId, issue.workspaceId), eq(team.id, issue.teamId)))
        .where(and(eq(issue.workspaceId, workspaceId), inArray(issue.id, ids)))
    : [];
  const byId = new Map(others.map((other) => [other.id, other]));
  return {
    ok: true,
    relations: rows.map((row): RelationView => {
      const id = otherId(row);
      const other = byId.get(id);
      const visible =
        other && canSeeTeam(actor, { id: other.teamId, workspaceId, private: other.teamPrivate });
      return {
        id: row.id,
        type: row.issueId === issueId || row.type !== 'blocks' ? row.type : 'blocked_by',
        issueId: id,
        ...(visible
          ? { issue: { identifier: `${other.key}-${other.number}`, title: other.title } }
          : {}),
      };
    }),
  };
}
