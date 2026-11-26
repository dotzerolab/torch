// What the sections of an opened issue make of their rows: its relations seen from its own end, how far its sub-issues
// are, and what one line of its history says. Pure, so the sentences are tested in both languages without a screen.
import type {
  SyncedActivity,
  SyncedIssueRelation,
  SyncedWorkflowState,
} from '../../sync/collections.ts';
import type { IssueRow } from './engine.ts';

export type RelationKind = 'blocks' | 'blocked_by' | 'related' | 'duplicate' | 'duplicated_by';
export type RelationView = { id: string; kind: RelationKind; otherId: string };

/** The relations of an issue, each read from the issue's own end: `A blocks B` is "blocks B" on A and "blocked by A" on B. */
export function relationsOf(rows: readonly SyncedIssueRelation[], issueId: string): RelationView[] {
  const views: RelationView[] = [];
  for (const row of rows) {
    const mine = row.issue_id === issueId;
    if (!mine && row.related_issue_id !== issueId) continue;
    const otherId = mine ? row.related_issue_id : row.issue_id;
    const kind: RelationKind | null =
      row.type === 'blocks'
        ? mine
          ? 'blocks'
          : 'blocked_by'
        : row.type === 'duplicate'
          ? mine
            ? 'duplicate'
            : 'duplicated_by'
          : row.type === 'related'
            ? 'related'
            : null;
    if (kind) views.push({ id: row.id, kind, otherId });
  }
  return views;
}

/** The sub-issues of an issue among the rows of its team, and how many of them are completed. */
export function subIssueProgress(
  rows: readonly IssueRow[],
  parentId: string,
  states: ReadonlyMap<string, Pick<SyncedWorkflowState, 'type'>>,
): { children: IssueRow[]; done: number } {
  const children = rows.filter((row) => row.issue.parent_id === parentId);
  const done = children.filter(
    (row) => states.get(row.issue.state_id)?.type === 'completed',
  ).length;
  return { children, done };
}

const FIELD_KEYS: Record<string, string> = {
  title: 'title',
  description: 'description',
  stateId: 'state',
  priority: 'priority',
  estimate: 'estimate',
  assigneeId: 'assignee',
  dueDate: 'dueDate',
  parentId: 'parent',
};

export type ActivityLookup = {
  /** The name of the person who acted; an id the workspace does not list is `undefined`. */
  member: (id: string) => string | undefined;
  state: (id: string) => string | undefined;
  label: (id: string) => string | undefined;
  priority: (value: number) => string;
  /** A value that has no name (an empty one, "none"). */
  none: string;
  someone: string;
};

/** One line of history as an i18n key and its values; the key is always one the catalogs have. */
export function describeActivity(
  row: Pick<SyncedActivity, 'type' | 'actor_id' | 'field' | 'from_value' | 'to_value'>,
  lookup: ActivityLookup,
  fieldName: (key: string) => string,
): { key: string; vars: Record<string, string> } {
  const actor = (row.actor_id && lookup.member(row.actor_id)) || lookup.someone;
  const value = (field: string | null, raw: unknown): string => {
    if (raw === null || raw === undefined || raw === '') return lookup.none;
    const text = String(raw);
    switch (field) {
      case 'stateId':
        return lookup.state(text) ?? lookup.none;
      case 'assigneeId':
        return lookup.member(text) ?? lookup.someone;
      case 'priority':
        return Number(raw) === 0 ? lookup.none : lookup.priority(Number(raw));
      case 'parentId':
        return lookup.none;
      default:
        return text;
    }
  };
  switch (row.type) {
    case 'issue.created':
    case 'issue.archived':
    case 'issue.unarchived':
    case 'issue.relation_added':
    case 'issue.relation_removed':
    case 'issue.subscriber_added':
    case 'issue.subscriber_removed':
    case 'issue.link_added':
    case 'issue.link_removed':
      return { key: `issue.activity.${row.type.slice('issue.'.length)}`, vars: { actor } };
    case 'issue.label_added':
    case 'issue.label_removed': {
      const id = String(row.type === 'issue.label_added' ? row.to_value : row.from_value);
      return {
        key: `issue.activity.${row.type.slice('issue.'.length)}`,
        vars: { actor, label: lookup.label(id) ?? lookup.none },
      };
    }
    case 'issue.field_changed': {
      const known = row.field ? FIELD_KEYS[row.field] : undefined;
      if (!known) return { key: 'issue.activity.unknown', vars: { actor } };
      // The text of a description is never shown in the history.
      if (row.field === 'description')
        return { key: 'issue.activity.description', vars: { actor } };
      return {
        key: 'issue.activity.field_changed',
        vars: {
          actor,
          field: fieldName(known),
          from: value(row.field, row.from_value),
          to: value(row.field, row.to_value),
        },
      };
    }
    default:
      return { key: 'issue.activity.unknown', vars: { actor } };
  }
}

/** The types `describeActivity` has a sentence for (the catalogs are checked against them). */
export const ACTIVITY_KEYS = [
  'created',
  'archived',
  'unarchived',
  'relation_added',
  'relation_removed',
  'subscriber_added',
  'subscriber_removed',
  'link_added',
  'link_removed',
  'label_added',
  'label_removed',
  'field_changed',
  'description',
  'unknown',
] as const;
