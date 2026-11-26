// The view engine: from the rows a screen has (issues with their labels), a filter and the display options, the sections
// to draw. Pure: no clock (the caller says what day it is), no store, no React, so it is tested with plain objects and
// runs the same for a list, a board and My Issues. 10,000 rows build in well under 150 ms.
import { VIEW_STATE_TYPES, type ViewDisplay, type ViewFilter } from '@torch/shared/views';
import type { SyncedIssue, SyncedWorkflowState } from '../../sync/collections.ts';

export type IssueRow = {
  id: string;
  issue: SyncedIssue;
  /** `ENG-12`; empty for an issue the server has not numbered yet. */
  identifier: string;
  labelIds: string[];
  /** The issue is queued on this device and the server has not confirmed it. */
  pending: boolean;
};

export type ViewContext = {
  /** The member who looks at the view: what `me` means. */
  meId: string;
  /** Today as `YYYY-MM-DD`, in the person's day. */
  today: string;
  states: ReadonlyMap<string, SyncedWorkflowState>;
  /** Names that order groups (a member's or a team's, by id). An id without a name sorts by the id. */
  names?: ReadonlyMap<string, string>;
};

export type Section = {
  /** Unique among the sections of one build: `<group>:<id>`. */
  key: string;
  group: ViewDisplay['group'];
  /** The state, type, member, priority or team the section stands for; null for "all" and for "no assignee". */
  id: string | null;
  rows: IssueRow[];
};

const collator = new Intl.Collator(undefined, { sensitivity: 'base', numeric: true });

/** Seven days from today, today included, as the last day that still counts as "this week". */
function lastDayOfWeek(today: string): string {
  const [year, month, day] = today.split('-').map(Number) as [number, number, number];
  return new Date(Date.UTC(year, month - 1, day + 6)).toISOString().slice(0, 10);
}

const DONE_TYPES = new Set(['completed', 'canceled']);

/** The test of a filter, made once for a whole list. */
function compile(filter: ViewFilter, ctx: ViewContext): (row: IssueRow) => boolean {
  const set = <T>(items: readonly T[] | undefined) => (items?.length ? new Set(items) : null);
  const states = set(filter.state);
  const types = set(filter.stateType);
  const assignees = set(filter.assignee?.map((id) => (id === 'me' ? ctx.meId : id)));
  const creators = set(filter.creator?.map((id) => (id === 'me' ? ctx.meId : id)));
  const priorities = set(filter.priority);
  const labels = set(filter.label);
  const due = set(filter.due);
  const text = filter.text?.trim().toLowerCase() || null;
  const weekEnd = lastDayOfWeek(ctx.today);
  // `none` is its own word in the filter, but an assignee id cannot be it: a row with no assignee is looked up as `none`.
  const wantsUnassigned = filter.assignee?.includes('none') ?? false;

  return (row) => {
    const { issue } = row;
    if (states && !states.has(issue.state_id)) return false;
    if (types) {
      const type = ctx.states.get(issue.state_id)?.type;
      if (!type || !types.has(type as never)) return false;
    }
    if (assignees || wantsUnassigned) {
      const assignee = issue.assignee_id;
      const hit = assignee === null ? wantsUnassigned : assignees?.has(assignee) === true;
      if (!hit) return false;
    }
    if (creators && !creators.has(issue.creator_id)) return false;
    if (priorities && !priorities.has(issue.priority)) return false;
    if (labels && !row.labelIds.some((id) => labels.has(id))) return false;
    if (due) {
      const day = issue.due_date;
      const open = !DONE_TYPES.has(ctx.states.get(issue.state_id)?.type ?? '');
      const hit =
        (due.has('none') && day === null) ||
        (day !== null && due.has('overdue') && open && day < ctx.today) ||
        (day !== null && due.has('week') && day >= ctx.today && day <= weekEnd);
      if (!hit) return false;
    }
    if (
      text &&
      !row.issue.title.toLowerCase().includes(text) &&
      !row.identifier.toLowerCase().includes(text)
    ) {
      return false;
    }
    return true;
  };
}

export function matchesFilter(row: IssueRow, filter: ViewFilter, ctx: ViewContext): boolean {
  return compile(filter, ctx)(row);
}

type Rank = string | number | null;

/** What an order sorts by; null (no value) always sorts last, in both directions. */
function rankOf(order: ViewDisplay['order']): (row: IssueRow) => Rank {
  switch (order) {
    case 'manual':
      return (row) => row.issue.sort_order;
    case 'priority':
      // Urgent (1) first, "none" (0) last: it is not the lowest urgency, it is no urgency.
      return (row) => (row.issue.priority === 0 ? null : row.issue.priority);
    case 'updated':
      return (row) => row.issue.updated_at;
    case 'created':
      return (row) => row.issue.created_at;
    case 'due':
      return (row) => row.issue.due_date;
    case 'title':
      return (row) => row.issue.title;
    case 'estimate':
      return (row) => row.issue.estimate;
  }
}

function sortRows(rows: IssueRow[], display: ViewDisplay): IssueRow[] {
  const rank = rankOf(display.order);
  const sign = display.direction === 'desc' ? -1 : 1;
  const keyed = rows.map((row) => ({ row, key: rank(row) }));
  keyed.sort((a, b) => {
    if (a.key !== b.key) {
      if (a.key === null) return 1;
      if (b.key === null) return -1;
      const order =
        typeof a.key === 'string' && typeof b.key === 'string'
          ? display.order === 'title'
            ? collator.compare(a.key, b.key)
            : a.key < b.key
              ? -1
              : 1
          : (a.key as number) - (b.key as number);
      if (order !== 0) return order * sign;
    }
    // Equal values go by number whichever way the order runs; a list of several teams keeps each team's together.
    if (a.row.issue.team_id !== b.row.issue.team_id) {
      return a.row.issue.team_id < b.row.issue.team_id ? -1 : 1;
    }
    return a.row.issue.number - b.row.issue.number;
  });
  return keyed.map((entry) => entry.row);
}

const PRIORITY_ORDER = ['1', '2', '3', '4', '0'];

function section(group: ViewDisplay['group'], id: string | null, rows: IssueRow[]): Section {
  return { key: `${group}:${id ?? 'none'}`, group, id, rows };
}

/** Groups rows by `idOf` and lists the groups in `order`; ids not in `order` follow, sorted by `rest`. */
function grouped(
  group: ViewDisplay['group'],
  rows: IssueRow[],
  idOf: (row: IssueRow) => string | null,
  order: readonly (string | null)[],
  rest: (a: string | null, b: string | null) => number,
  showEmpty: boolean,
): Section[] {
  const byId = new Map<string | null, IssueRow[]>();
  for (const row of rows) {
    const id = idOf(row);
    const bucket = byId.get(id);
    if (bucket) bucket.push(row);
    else byId.set(id, [row]);
  }
  const known = new Set(order);
  const extra = [...byId.keys()].filter((id) => !known.has(id)).sort(rest);
  return [...order, ...extra]
    .filter((id) => showEmpty || byId.has(id))
    .map((id) => section(group, id, byId.get(id) ?? []));
}

export function buildSections(
  rows: IssueRow[],
  filter: ViewFilter,
  display: ViewDisplay,
  ctx: ViewContext,
): Section[] {
  const test = compile(filter, ctx);
  const present = display.subIssues ? null : new Set(rows.map((row) => row.id));
  const shown = rows.filter(
    (row) =>
      (display.showArchived || row.issue.archived_at === null) &&
      !(present && row.issue.parent_id !== null && present.has(row.issue.parent_id)) &&
      test(row),
  );
  const name = (id: string | null) => (id === null ? '' : (ctx.names?.get(id) ?? id));
  const byName = (a: string | null, b: string | null) => collator.compare(name(a), name(b));
  const showEmpty = display.showEmptyGroups;
  let sections: Section[];

  switch (display.group) {
    case 'state': {
      const usedStates = new Set(shown.map((row) => row.issue.state_id));
      // An archived state keeps its issues but takes no new ones: its group shows while it holds some.
      const known = [...ctx.states.values()]
        .filter((state) => state.archived_at === null || usedStates.has(state.id))
        .sort((a, b) => a.position - b.position || collator.compare(a.name, b.name))
        .map((state) => state.id);
      sections = grouped(
        'state',
        shown,
        (row) => row.issue.state_id,
        known,
        (a, b) => collator.compare(a ?? '', b ?? ''),
        showEmpty,
      );
      break;
    }
    case 'stateType':
      sections = grouped(
        'stateType',
        shown,
        (row) => ctx.states.get(row.issue.state_id)?.type ?? null,
        VIEW_STATE_TYPES,
        () => 0,
        showEmpty,
      );
      break;
    case 'assignee':
      sections = grouped('assignee', shown, (row) => row.issue.assignee_id, [], byName, false);
      // "No assignee" closes the list; it shows when empty groups are asked for.
      if (showEmpty && !sections.some((s) => s.id === null))
        sections.push(section('assignee', null, []));
      sections.sort((a, b) => (a.id === null ? 1 : b.id === null ? -1 : 0));
      break;
    case 'priority':
      sections = grouped(
        'priority',
        shown,
        (row) => String(row.issue.priority),
        PRIORITY_ORDER,
        () => 0,
        showEmpty,
      );
      break;
    case 'team':
      sections = grouped('team', shown, (row) => row.issue.team_id, [], byName, false);
      break;
    case 'none':
      sections = shown.length > 0 || showEmpty ? [section('none', null, shown)] : [];
      break;
  }
  for (const part of sections) part.rows = sortRows(part.rows, display);
  return sections;
}
