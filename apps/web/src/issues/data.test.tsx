// @vitest-environment jsdom
import { createCollection } from '@tanstack/react-db';
import { act, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  SyncedIssue,
  SyncedIssueLabel,
  SyncedLabel,
  SyncedMember,
  SyncedWorkflowState,
} from '../sync/collections.ts';
import type { OutboxWrite } from '../sync/outbox.ts';

function local<T extends object>(rows: T[], key: (row: T) => string) {
  return createCollection<T>({
    getKey: key,
    sync: {
      sync: ({ begin, write, commit, markReady }) => {
        begin();
        for (const row of rows) write({ type: 'insert', value: row });
        commit();
        markReady();
      },
    },
  });
}

const store: Record<string, ReturnType<typeof local<never>>> = {};
let pending: OutboxWrite[] = [];
const listeners = new Set<() => void>();

vi.mock('../sync/shapes.ts', () => ({
  useShape: (key: { kind: string }) => store[key.kind],
}));
vi.mock('../sync/snapshot-hooks.ts', () => ({
  useSnapshot: (key: { kind: string }) => store[key.kind],
  useIssuesFeed: () => {},
}));
vi.mock('../sync/outbox.ts', () => ({
  outbox: {
    pendingWrites: async () => pending,
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  },
}));

const { useIssueRows, useTeamData } = await import('./data.ts');

const WS = 'w1';
const state = (id: string, position: number): SyncedWorkflowState => ({
  id,
  workspace_id: WS,
  team_id: 't1',
  name: id,
  type: 'started',
  position,
  color: '#000000',
  archived_at: null,
});
const label = (id: string, extra: Partial<SyncedLabel> = {}): SyncedLabel => ({
  id,
  workspace_id: WS,
  team_id: 't1',
  parent_id: null,
  name: id,
  color: '#000000',
  is_group: false,
  archived_at: null,
  created_at: '2025-01-01T00:00:00Z',
  ...extra,
});
const member = (id: string, deactivated = false): SyncedMember => ({
  id,
  workspace_id: WS,
  name: id,
  handle: id,
  role: 'member',
  locale: 'en',
  deactivated_at: deactivated ? '2026-01-01T00:00:00Z' : null,
  created_at: '2025-01-01T00:00:00Z',
});
const issue = (id: string, number: number): SyncedIssue => ({
  id,
  workspace_id: WS,
  team_id: 't1',
  number,
  title: id,
  state_id: 's1',
  priority: 0,
  assignee_id: null,
  creator_id: 'm1',
  created_at: '2026-01-01T00:00:00Z',
  updated_at: '2026-01-01T00:00:00Z',
  archived_at: null,
  estimate: null,
  due_date: null,
  parent_id: null,
  sort_order: 0,
  started_at: null,
  completed_at: null,
  canceled_at: null,
});
const team = { id: 't1', workspace_id: WS, key: 'ENG', name: 'Engineering', private: false };

function Probe() {
  const data = useTeamData(WS, 't1');
  return (
    <p data-testid="data">
      {JSON.stringify({
        states: data.states.map((s) => s.id),
        labels: data.labels.map((l) => l.id),
        members: data.members.map((m) => m.id),
        ready: data.ready,
        archivedLabelKnown: data.labelsById.has('old'),
        deactivatedKnown: data.membersById.has('gone'),
      })}
    </p>
  );
}

function Rows() {
  const { rows, ready } = useIssueRows(WS, team);
  return (
    <p data-testid="rows">
      {JSON.stringify({ ready, rows: rows.map((r) => [r.identifier, r.labelIds]) })}
    </p>
  );
}

beforeEach(() => {
  pending = [];
  listeners.clear();
  store.workflowStates = local([state('s2', 2), state('s1', 1)], (r) => r.id) as never;
  store.labels = local(
    [
      label('g', { is_group: true }),
      label('c1', { parent_id: 'g' }),
      label('empty', { is_group: true }),
      label('old', { archived_at: '2026-01-01T00:00:00Z' }),
    ],
    (r) => r.id,
  ) as never;
  store.workspaceLabels = local([label('ws', { team_id: null })], (r) => r.id) as never;
  store.members = local([member('m1'), member('gone', true)], (r) => r.id) as never;
  store.issues = local([issue('i1', 1), issue('i2', 2)], (r) => r.id) as never;
  store.issueLabels = local(
    [{ workspace_id: WS, team_id: 't1', issue_id: 'i1', label_id: 'c1' }] as SyncedIssueLabel[],
    (r) => `${r.issue_id}:${r.label_id}`,
  ) as never;
});

const read = (id: string) => JSON.parse(screen.getByTestId(id).textContent ?? '{}');

describe('useTeamData', () => {
  it('gives states in workflow order, usable labels of the team and the workspace, and active members', async () => {
    render(<Probe />);
    await act(async () => {});
    const data = read('data');
    expect(data.states).toEqual(['s1', 's2']);
    // Archived labels and groups without a label are left out; a group with a child stays.
    expect(data.labels.sort()).toEqual(['c1', 'g', 'ws']);
    expect(data.members).toEqual(['m1']);
    expect(data.ready).toBe(true);
    // They stay known by id, so a chip or a name of what was archived or deactivated can still be drawn.
    expect(data.archivedLabelKnown).toBe(true);
    expect(data.deactivatedKnown).toBe(true);
  });
});

describe('useIssueRows', () => {
  it('builds rows with identifiers and label ids', async () => {
    render(<Rows />);
    await act(async () => {});
    const data = read('rows');
    expect(data.ready).toBe(true);
    expect(data.rows).toEqual([
      ['ENG-1', ['c1']],
      ['ENG-2', []],
    ]);
  });

  it('a queued label edit shows before the server answers, and goes when the write is over', async () => {
    pending = [
      {
        workspaceId: WS,
        teamId: 't1',
        method: 'PATCH',
        path: `/api/w/${WS}/issues/i2`,
        body: { addLabelIds: ['ws'] },
        idempotencyKey: 'k1',
      },
    ];
    render(<Rows />);
    await act(async () => {});
    expect(read('rows').rows).toEqual([
      ['ENG-1', ['c1']],
      ['ENG-2', ['ws']],
    ]);
    // The write was sent and its record is gone: the outbox tells the screens.
    pending = [];
    await act(async () => {
      for (const listener of [...listeners]) listener();
    });
    expect(read('rows').rows).toEqual([
      ['ENG-1', ['c1']],
      ['ENG-2', []],
    ]);
  });
});
