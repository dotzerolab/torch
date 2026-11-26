import { DEFAULT_DISPLAY, type ViewDisplay, type ViewFilter } from '@torch/shared/views';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SyncedIssue, SyncedWorkflowState } from '../../sync/collections.ts';
import { buildSections, type IssueRow, matchesFilter, type ViewContext } from './engine.ts';

const ME = '00000000-0000-4000-8000-00000000000a';
const ANA = '00000000-0000-4000-8000-0000000000a1';
const BOB = '00000000-0000-4000-8000-0000000000b2';
const GONE = '00000000-0000-4000-8000-0000000000ff';
const TEAM = '00000000-0000-4000-8000-0000000000e1';
const L1 = '00000000-0000-4000-8000-0000000000c1';
const L2 = '00000000-0000-4000-8000-0000000000c2';

const state = (id: string, type: string, position: number, name = id): SyncedWorkflowState => ({
  id,
  workspace_id: 'w',
  team_id: TEAM,
  name,
  type,
  position,
  color: '#888888',
  archived_at: null,
});
// Positions are not in type order on purpose: grouping follows `position`.
const STATES = [
  state('s-done', 'completed', 4),
  state('s-todo', 'unstarted', 2),
  state('s-back', 'backlog', 1),
  state('s-doing', 'started', 3),
  state('s-cancel', 'canceled', 5),
];

const ctx = (extra: Partial<ViewContext> = {}): ViewContext => ({
  meId: ME,
  today: '2026-11-26',
  states: new Map(STATES.map((s) => [s.id, s])),
  ...extra,
});

let counter = 0;
function row(
  overrides: Partial<SyncedIssue> = {},
  labelIds: string[] = [],
  pending = false,
): IssueRow {
  counter += 1;
  const issue: SyncedIssue = {
    id: `i${counter}`,
    workspace_id: 'w',
    team_id: TEAM,
    number: counter,
    title: `Issue ${counter}`,
    state_id: 's-todo',
    priority: 0,
    assignee_id: null,
    creator_id: ME,
    created_at: '2026-11-01T10:00:00.000Z',
    updated_at: '2026-11-01T10:00:00.000Z',
    archived_at: null,
    estimate: null,
    due_date: null,
    parent_id: null,
    sort_order: counter,
    started_at: null,
    completed_at: null,
    canceled_at: null,
    ...overrides,
  };
  return { id: issue.id, issue, identifier: `ENG-${issue.number}`, labelIds, pending };
}

const display = (overrides: Partial<ViewDisplay> = {}): ViewDisplay => ({
  ...DEFAULT_DISPLAY,
  group: 'none',
  ...overrides,
});
const ids = (rows: IssueRow[]) => rows.map((r) => r.id);
const flat = (sections: ReturnType<typeof buildSections>) => sections.flatMap((s) => ids(s.rows));
const build = (rows: IssueRow[], filter: ViewFilter = {}, d: Partial<ViewDisplay> = {}) =>
  buildSections(rows, filter, display(d), ctx());

afterEach(() => {
  vi.useRealTimers();
  counter = 0;
});

describe('filters', () => {
  it('or within a field, and across fields', () => {
    const a = row({ assignee_id: ANA, priority: 1 });
    const b = row({ assignee_id: BOB, priority: 1 });
    const c = row({ assignee_id: ANA, priority: 3 });
    const d = row({ assignee_id: BOB, priority: 3 });
    const rows = [a, b, c, d];
    expect(flat(build(rows, { assignee: [ANA, BOB] }))).toEqual(ids(rows));
    expect(flat(build(rows, { assignee: [ANA, BOB], priority: [1] }))).toEqual([a.id, b.id]);
    expect(flat(build(rows, { assignee: [ANA], priority: [1, 3] }))).toEqual([a.id, c.id]);
    expect(flat(build(rows, { assignee: [ANA], priority: [2] }))).toEqual([]);
  });

  it('me and none resolve', () => {
    const mine = row({ assignee_id: ME, creator_id: ANA });
    const free = row({ assignee_id: null, creator_id: ME });
    const theirs = row({ assignee_id: ANA, creator_id: BOB });
    const rows = [mine, free, theirs];
    expect(flat(build(rows, { assignee: ['me'] }))).toEqual([mine.id]);
    expect(flat(build(rows, { assignee: ['none'] }))).toEqual([free.id]);
    expect(flat(build(rows, { assignee: ['none', 'me'] }))).toEqual([mine.id, free.id]);
    expect(flat(build(rows, { creator: ['me'] }))).toEqual([free.id]);
  });

  it('overdue uses today, not the clock', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2030-01-01T00:00:00Z'));
    const yesterday = row({ due_date: '2026-11-25' });
    const today = row({ due_date: '2026-11-26' });
    const later = row({ due_date: '2026-12-01' });
    const none = row({ due_date: null });
    const rows = [yesterday, today, later, none];
    expect(flat(build(rows, { due: ['overdue'] }))).toEqual([yesterday.id]);
    expect(flat(build(rows, { due: ['none'] }))).toEqual([none.id]);
    // The next seven days, today included; what is already late is not "this week".
    expect(flat(build(rows, { due: ['week'] }))).toEqual([today.id, later.id]);
    expect(flat(build(rows, { due: ['overdue', 'none'] }))).toEqual([yesterday.id, none.id]);
  });

  it('a finished or cancelled issue is not overdue', () => {
    const late = row({ due_date: '2026-11-01' });
    const done = row({ due_date: '2026-11-01', state_id: 's-done' });
    const cancelled = row({ due_date: '2026-11-01', state_id: 's-cancel' });
    expect(flat(build([late, done, cancelled], { due: ['overdue'] }))).toEqual([late.id]);
  });

  it('state, state type and label', () => {
    const a = row({ state_id: 's-back' }, [L1]);
    const b = row({ state_id: 's-doing' }, [L2]);
    const c = row({ state_id: 's-done' }, [L1, L2]);
    const d = row({ state_id: 's-done' }, []);
    const rows = [a, b, c, d];
    expect(flat(build(rows, { state: ['s-back', 's-doing'] }))).toEqual([a.id, b.id]);
    expect(flat(build(rows, { stateType: ['completed'] }))).toEqual([c.id, d.id]);
    expect(flat(build(rows, { label: [L1] }))).toEqual([a.id, c.id]);
    expect(flat(build(rows, { label: [L1, L2], stateType: ['completed'] }))).toEqual([c.id]);
  });

  it('text matches the title or the identifier, ignoring case', () => {
    const a = row({ title: 'Fix the Login page' });
    const b = row({ title: 'Billing' });
    const rows = [a, b];
    expect(flat(build(rows, { text: 'login' }))).toEqual([a.id]);
    expect(flat(build(rows, { text: 'LOGIN PAGE' }))).toEqual([a.id]);
    expect(flat(build(rows, { text: 'eng-2' }))).toEqual([b.id]);
    expect(flat(build(rows, { text: '   ' }))).toEqual(ids(rows));
  });

  it('unknown ids match nothing and do not throw', () => {
    const rows = [row({ assignee_id: ANA }, [L1]), row({}, [])];
    expect(flat(build(rows, { state: [GONE] }))).toEqual([]);
    expect(flat(build(rows, { label: [GONE] }))).toEqual([]);
    expect(flat(build(rows, { assignee: [GONE] }))).toEqual([]);
    expect(flat(build(rows, { creator: [GONE] }))).toEqual([]);
    expect(flat(build(rows, { stateType: ['started'] }))).toEqual([]);
    expect(matchesFilter(rows[0] as IssueRow, { state: [GONE] }, ctx())).toBe(false);
  });

  it('an issue whose state this person cannot read is still listed, and matches no state or type', () => {
    const orphan = row({ state_id: 's-unknown' });
    expect(flat(build([orphan]))).toEqual([orphan.id]);
    expect(flat(build([orphan], { stateType: ['unstarted'] }))).toEqual([]);
  });
});

describe('order', () => {
  it('manual order follows sort_order, then the number', () => {
    const a = row({ sort_order: 2 });
    const b = row({ sort_order: 1 });
    const c = row({ sort_order: 1 });
    expect(flat(build([a, b, c]))).toEqual([b.id, c.id, a.id]);
    // Reversed, equal values still go by number.
    expect(flat(build([a, b, c], {}, { direction: 'desc' }))).toEqual([a.id, b.id, c.id]);
  });

  it('priority order puts none last: urgent, high, medium, low, none', () => {
    const none = row({ priority: 0 });
    const low = row({ priority: 4 });
    const urgent = row({ priority: 1 });
    const medium = row({ priority: 3 });
    const high = row({ priority: 2 });
    const rows = [none, low, urgent, medium, high];
    expect(flat(build(rows, {}, { order: 'priority' }))).toEqual([
      urgent.id,
      high.id,
      medium.id,
      low.id,
      none.id,
    ]);
    // Reversed, "none" still comes last: an issue without a priority is never the most urgent.
    expect(flat(build(rows, {}, { order: 'priority', direction: 'desc' }))).toEqual([
      low.id,
      medium.id,
      high.id,
      urgent.id,
      none.id,
    ]);
  });

  it('due date and estimate put the missing value last, both ways; ties go by number', () => {
    const a = row({ due_date: '2026-12-02', estimate: 5 });
    const b = row({ due_date: null, estimate: null });
    const c = row({ due_date: '2026-12-01', estimate: 2 });
    const d = row({ due_date: '2026-12-02', estimate: 5 });
    expect(flat(build([a, b, c, d], {}, { order: 'due' }))).toEqual([c.id, a.id, d.id, b.id]);
    expect(flat(build([a, b, c, d], {}, { order: 'due', direction: 'desc' }))).toEqual([
      a.id,
      d.id,
      c.id,
      b.id,
    ]);
    expect(flat(build([a, b, c, d], {}, { order: 'estimate' }))).toEqual([c.id, a.id, d.id, b.id]);
  });

  it('title, created and updated', () => {
    const a = row({
      title: 'banana',
      created_at: '2026-11-03T00:00:00Z',
      updated_at: '2026-11-05T00:00:00Z',
    });
    const b = row({
      title: 'Apple',
      created_at: '2026-11-02T00:00:00Z',
      updated_at: '2026-11-09T00:00:00Z',
    });
    const c = row({
      title: 'cherry',
      created_at: '2026-11-01T00:00:00Z',
      updated_at: '2026-11-07T00:00:00Z',
    });
    expect(flat(build([a, b, c], {}, { order: 'title' }))).toEqual([b.id, a.id, c.id]);
    expect(flat(build([a, b, c], {}, { order: 'created' }))).toEqual([c.id, b.id, a.id]);
    expect(flat(build([a, b, c], {}, { order: 'updated', direction: 'desc' }))).toEqual([
      b.id,
      c.id,
      a.id,
    ]);
  });
});

describe('groups', () => {
  it('group follows workflow position, not alphabet or type', () => {
    const rows = STATES.map((s) => row({ state_id: s.id }));
    expect(buildSections(rows, {}, display({ group: 'state' }), ctx()).map((s) => s.id)).toEqual([
      's-back',
      's-todo',
      's-doing',
      's-done',
      's-cancel',
    ]);
  });

  it('stateType groups follow the type order', () => {
    const rows = [
      row({ state_id: 's-cancel' }),
      row({ state_id: 's-done' }),
      row({ state_id: 's-doing' }),
      row({ state_id: 's-back' }),
    ];
    const sections = buildSections(rows, {}, display({ group: 'stateType' }), ctx());
    expect(sections.map((s) => s.id)).toEqual(['backlog', 'started', 'completed', 'canceled']);
  });

  it('empty groups are hidden unless asked', () => {
    const rows = [row({ state_id: 's-todo' })];
    const hidden = buildSections(rows, {}, display({ group: 'state' }), ctx());
    expect(hidden.map((s) => s.id)).toEqual(['s-todo']);
    const shown = buildSections(
      rows,
      {},
      display({ group: 'state', showEmptyGroups: true }),
      ctx(),
    );
    expect(shown.map((s) => s.id)).toEqual(['s-back', 's-todo', 's-doing', 's-done', 's-cancel']);
    expect(shown.find((s) => s.id === 's-back')?.rows).toEqual([]);
    const types = buildSections(
      rows,
      {},
      display({ group: 'stateType', showEmptyGroups: true }),
      ctx(),
    );
    expect(types.map((s) => s.id)).toEqual([
      'triage',
      'backlog',
      'unstarted',
      'started',
      'completed',
      'canceled',
    ]);
  });

  it('an archived state shows only while it still holds issues', () => {
    const archived = { ...state('s-old', 'backlog', 0), archived_at: '2026-01-01T00:00:00Z' };
    const withOld = ctx({ states: new Map([...STATES, archived].map((s) => [s.id, s])) });
    const d = display({ group: 'state', showEmptyGroups: true });
    expect(buildSections([], {}, d, withOld).map((s) => s.id)).not.toContain('s-old');
    expect(buildSections([row({ state_id: 's-old' })], {}, d, withOld).map((s) => s.id)).toContain(
      's-old',
    );
  });

  it('a state this person cannot read gets its own group after the known ones', () => {
    const rows = [row({ state_id: 's-unknown' }), row({ state_id: 's-todo' })];
    const sections = buildSections(rows, {}, display({ group: 'state' }), ctx());
    expect(sections.map((s) => s.id)).toEqual(['s-todo', 's-unknown']);
  });

  it('priority groups run urgent to none', () => {
    const rows = [row({ priority: 0 }), row({ priority: 2 }), row({ priority: 1 })];
    const sections = buildSections(rows, {}, display({ group: 'priority' }), ctx());
    expect(sections.map((s) => s.id)).toEqual(['1', '2', '0']);
  });

  it('assignee groups sort by name, and unassigned comes last', () => {
    const names = new Map([
      [ANA, 'Ana'],
      [BOB, 'Bob'],
      [ME, 'Me'],
    ]);
    const rows = [row({ assignee_id: null }), row({ assignee_id: BOB }), row({ assignee_id: ANA })];
    const sections = buildSections(rows, {}, display({ group: 'assignee' }), ctx({ names }));
    expect(sections.map((s) => s.id)).toEqual([ANA, BOB, null]);
  });

  it('team groups sort by name', () => {
    const names = new Map([
      ['t-b', 'Billing'],
      ['t-a', 'Apps'],
    ]);
    const rows = [row({ team_id: 't-b' }), row({ team_id: 't-a' })];
    const sections = buildSections(rows, {}, display({ group: 'team' }), ctx({ names }));
    expect(sections.map((s) => s.id)).toEqual(['t-a', 't-b']);
  });

  it('no grouping is one section, and none when there is nothing to show', () => {
    expect(build([row(), row()])).toHaveLength(1);
    expect(build([])).toEqual([]);
  });

  it('every section has a distinct key', () => {
    const rows = STATES.map((s) => row({ state_id: s.id }));
    const keys = buildSections(rows, {}, display({ group: 'state' }), ctx()).map((s) => s.key);
    expect(new Set(keys).size).toBe(keys.length);
  });
});

describe('what a list leaves out', () => {
  it('sub-issues are hidden when their parent is in the list', () => {
    const parent = row();
    const child = row({ parent_id: parent.id });
    const orphan = row({ parent_id: 'not-in-the-list' });
    const rows = [parent, child, orphan];
    expect(flat(build(rows, {}, { subIssues: false }))).toEqual([parent.id, orphan.id]);
    expect(flat(build(rows, {}, { subIssues: true }))).toEqual(ids(rows));
  });

  it('archived issues show only when asked', () => {
    const open = row();
    const archived = row({ archived_at: '2026-11-10T00:00:00Z' });
    expect(flat(build([open, archived]))).toEqual([open.id]);
    expect(flat(build([open, archived], {}, { showArchived: true }))).toEqual([
      open.id,
      archived.id,
    ]);
  });
});

describe('size', () => {
  it('10k rows build under 150 ms (3 filters, grouped, sorted)', () => {
    const rows: IssueRow[] = [];
    for (let i = 0; i < 10_000; i += 1) {
      rows.push(
        row(
          {
            state_id: STATES[i % STATES.length]?.id ?? 's-todo',
            priority: i % 5,
            assignee_id: i % 3 === 0 ? ANA : i % 3 === 1 ? BOB : null,
            sort_order: (i * 7919) % 10_000,
            due_date: i % 4 === 0 ? '2026-11-20' : null,
          },
          i % 2 === 0 ? [L1] : [L2],
        ),
      );
    }
    const filter: ViewFilter = {
      assignee: [ANA, BOB],
      priority: [1, 2, 3],
      label: [L1, L2],
      text: 'issue',
    };
    const d = display({ group: 'state', order: 'priority' });
    buildSections(rows, filter, d, ctx());
    const started = performance.now();
    const sections = buildSections(rows, filter, d, ctx());
    const elapsed = performance.now() - started;
    expect(sections.flatMap((s) => s.rows).length).toBeGreaterThan(1000);
    expect(elapsed).toBeLessThan(150);
  });
});
