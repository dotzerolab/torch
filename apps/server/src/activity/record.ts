// The change recorder: one function writes the activity rows and the outbox events of an issue change, inside the
// transaction that made the change (spec section 11: "every state change writes its event in the same transaction").
// Every issue mutation (create, update, labels, relations, subscribers, links, archive) calls it last, so a rollback
// takes the history and the events with it.
//
// Activity: one row per changed field, label, relation, subscriber or link. Events: `issue.created`, `issue.updated`
// (one per call, with every change), plus `issue.state_changed` and `issue.assigned` when those fields changed, and
// `issue.archived`. Text is never copied: a description change records that it changed, not what it said.
import {
  type ActivityClient,
  type ExternalRefRow,
  event,
  externalRef,
  type IssueRow,
  issue,
  issueActivity,
  team,
} from '@torch/shared/db/schema';
import { and, asc, eq, sql } from 'drizzle-orm';
import type { PgInsertValue } from 'drizzle-orm/pg-core';
import type { Tx } from '../db.ts';
import type { ClientActor } from '../permissions/load-actor.ts';

export type IssueChange =
  | { kind: 'created'; issue: IssueRow; externalRef?: ExternalRefRow }
  | { kind: 'updated'; before: IssueRow; after: IssueRow }
  | { kind: 'labels'; issueId: string; added: string[]; removed: string[] }
  | {
      kind: 'relation' | 'subscriber' | 'link';
      issueId: string;
      op: 'added' | 'removed';
      data: Record<string, unknown>;
    }
  | { kind: 'archived' | 'unarchived'; issue: IssueRow };

/** Version of the `data` shapes below; a consumer reads it from the event. */
const EVENT_VERSION = 1;

/** The fields whose change is history and an event. Sort order and the state timestamps are not: they follow other changes. */
const TRACKED_FIELDS = [
  'title',
  'description',
  'stateId',
  'priority',
  'estimate',
  'assigneeId',
  'dueDate',
  'parentId',
] as const;
type TrackedField = (typeof TRACKED_FIELDS)[number];

/** The row-based kinds keep their text out of history and events. */
const TEXT_FIELDS: ReadonlySet<TrackedField> = new Set(['description']);

type ActivityInsert = PgInsertValue<typeof issueActivity>;
type EventInsert = PgInsertValue<typeof event>;
type Changes = Record<string, Record<string, unknown>>;

const JOIN_KIND = { relation: 'relations', subscriber: 'subscribers', link: 'links' } as const;

const issueIdOf = (change: IssueChange): string => {
  switch (change.kind) {
    case 'updated':
      return change.after.id;
    case 'created':
    case 'archived':
    case 'unarchived':
      return change.issue.id;
    default:
      return change.issueId;
  }
};

/** Records the history and the events of one issue change. Call it inside the transaction that made the change. */
export async function recordIssueChange(
  tx: Tx,
  actor: ClientActor,
  change: IssueChange,
): Promise<void> {
  const issueId = issueIdOf(change);
  const [subject] = await tx
    .select({ teamId: issue.teamId, number: issue.number, key: team.key })
    .from(issue)
    .innerJoin(team, and(eq(team.workspaceId, issue.workspaceId), eq(team.id, issue.teamId)))
    .where(and(eq(issue.id, issueId), eq(issue.workspaceId, actor.workspaceId)));
  if (!subject) throw new Error('recordIssueChange: issue not found in the actor workspace');

  const externalRefs = await loadExternalRefs(tx, actor.workspaceId, issueId, change);
  const identifier = `${subject.key}-${subject.number}`;
  const base = {
    workspaceId: actor.workspaceId,
    teamId: subject.teamId,
  };
  const activityRow = (
    type: string,
    field: string | null,
    fromValue: unknown,
    toValue: unknown,
  ): ActivityInsert => ({
    ...base,
    issueId,
    actorId: actor.memberId,
    client: actor.client satisfies ActivityClient,
    type,
    field,
    fromValue: fromValue ?? null,
    toValue: toValue ?? null,
    // Write time, not transaction start: rows keep the order they were written in.
    createdAt: sql`clock_timestamp()`,
  });
  const eventRow = (type: string, data: Record<string, unknown>): EventInsert => ({
    ...base,
    type,
    version: EVENT_VERSION,
    occurredAt: sql`clock_timestamp()`,
    actorId: actor.memberId,
    client: actor.client,
    subjectType: 'issue',
    subjectId: issueId,
    data: { identifier, number: subject.number, ...data, externalRefs },
  });

  const activity: ActivityInsert[] = [];
  const events: EventInsert[] = [];

  switch (change.kind) {
    case 'created': {
      const fields = snapshot(change.issue);
      activity.push(
        activityRow('issue.created', null, null, { identifier, title: change.issue.title }),
      );
      events.push(eventRow('issue.created', { issue: fields }));
      break;
    }
    case 'updated': {
      const diff = diffIssue(change.before, change.after);
      for (const [field, values] of Object.entries(diff)) {
        activity.push(activityRow('issue.field_changed', field, values.before, values.after));
      }
      if (activity.length === 0) return;
      const changes = eventChanges(diff);
      events.push(eventRow('issue.updated', { changes }));
      if (diff.stateId)
        events.push(eventRow('issue.state_changed', { changes: pick(changes, 'stateId') }));
      if (diff.assigneeId)
        events.push(eventRow('issue.assigned', { changes: pick(changes, 'assigneeId') }));
      break;
    }
    case 'labels': {
      for (const labelId of change.added) {
        activity.push(activityRow('issue.label_added', 'labels', null, labelId));
      }
      for (const labelId of change.removed) {
        activity.push(activityRow('issue.label_removed', 'labels', labelId, null));
      }
      if (activity.length === 0) return;
      events.push(
        eventRow('issue.updated', {
          changes: { labels: { added: change.added, removed: change.removed } },
        }),
      );
      break;
    }
    case 'relation':
    case 'subscriber':
    case 'link': {
      const key = JOIN_KIND[change.kind];
      const type = `issue.${change.kind}_${change.op}`;
      activity.push(
        change.op === 'added'
          ? activityRow(type, key, null, change.data)
          : activityRow(type, key, change.data, null),
      );
      events.push(
        eventRow('issue.updated', { changes: { [key]: { [change.op]: [change.data] } } }),
      );
      break;
    }
    case 'archived': {
      activity.push(activityRow('issue.archived', null, null, null));
      events.push(
        eventRow('issue.archived', { archivedAt: change.issue.archivedAt?.toISOString() ?? null }),
      );
      break;
    }
    case 'unarchived': {
      activity.push(activityRow('issue.unarchived', null, null, null));
      // The catalogue has no unarchive event: a consumer sees the issue come back as an update.
      events.push(eventRow('issue.updated', { changes: { archivedAt: { after: null } } }));
      break;
    }
  }

  await tx.insert(issueActivity).values(activity);
  await tx.insert(event).values(events);
}

function snapshot(row: IssueRow): Record<string, unknown> {
  return {
    teamId: row.teamId,
    title: row.title,
    stateId: row.stateId,
    priority: row.priority,
    estimate: row.estimate,
    assigneeId: row.assigneeId,
    dueDate: row.dueDate,
    parentId: row.parentId,
  };
}

function diffIssue(
  before: IssueRow,
  after: IssueRow,
): Record<string, { before: unknown; after: unknown }> {
  const diff: Record<string, { before: unknown; after: unknown }> = {};
  for (const field of TRACKED_FIELDS) {
    if (before[field] === after[field]) continue;
    diff[field] = TEXT_FIELDS.has(field)
      ? { before: null, after: null }
      : { before: before[field], after: after[field] };
  }
  return diff;
}

/** The event form of a diff: values before and after, except text, which only says that it changed. */
function eventChanges(diff: Record<string, { before: unknown; after: unknown }>): Changes {
  const changes: Changes = {};
  for (const [field, values] of Object.entries(diff)) {
    changes[field] = TEXT_FIELDS.has(field as TrackedField)
      ? { changed: true }
      : { before: values.before, after: values.after };
  }
  return changes;
}

const pick = (changes: Changes, field: string): Changes =>
  changes[field] ? { [field]: changes[field] } : {};

async function loadExternalRefs(
  tx: Tx,
  workspaceId: string,
  issueId: string,
  change: IssueChange,
): Promise<{ source: string; id: string; url: string | null }[]> {
  const rows =
    change.kind === 'created' && change.externalRef
      ? [change.externalRef]
      : await tx
          .select()
          .from(externalRef)
          .where(
            and(
              eq(externalRef.workspaceId, workspaceId),
              eq(externalRef.subjectType, 'issue'),
              eq(externalRef.subjectId, issueId),
            ),
          )
          .orderBy(asc(externalRef.createdAt), asc(externalRef.source));
  return rows.map((row) => ({ source: row.source, id: row.externalId, url: row.url ?? null }));
}
