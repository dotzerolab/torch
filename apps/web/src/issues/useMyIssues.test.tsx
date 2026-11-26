// @vitest-environment jsdom
import { createCollection } from '@tanstack/react-db';
import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  SyncedIssue,
  SyncedIssueLabel,
  SyncedLabel,
  SyncedMember,
  SyncedTeam,
  SyncedWorkflowState,
} from '../sync/collections.ts';

function local<T extends object>(rows: T[], key: (row: T) => string, ready = true) {
  let control: { begin: () => void; write: (m: never) => void; commit: () => void } | undefined;
  const collection = createCollection<T>({
    getKey: key,
    startSync: true,
    sync: {
      sync: (params) => {
        control = params as never;
        params.begin();
        for (const row of rows) params.write({ type: 'insert', value: row });
        params.commit();
        if (ready) params.markReady();
      },
    },
  });
  return {
    collection,
    add(row: T) {
      control?.begin();
      control?.write({ type: 'insert', value: row } as never);
      control?.commit();
    },
  };
}

const WS = 'w1';
const asked: string[] = [];
let mine: ReturnType<typeof local<SyncedIssue>>;
let members: ReturnType<typeof local<SyncedMember>>;
const perTeam: Record<string, ReturnType<typeof local<never>>> = {};
let workspaceLabels: ReturnType<typeof local<SyncedLabel>>;

vi.mock('../sync/shapes.ts', () => ({
  useShape: (key: { kind: string }) => {
    asked.push(key.kind);
    return (key.kind === 'myIssues' ? mine : members).collection;
  },
}));
vi.mock('../sync/snapshot-hooks.ts', () => ({
  useSnapshot: (key: { kind: string }) => {
    asked.push(key.kind);
    return workspaceLabels.collection;
  },
  useSnapshots: (keys: { kind: string; teamId: string }[]) =>
    keys.map((key) => {
      asked.push(`${key.kind}:${key.teamId}`);
      return perTeam[`${key.kind}:${key.teamId}`]?.collection;
    }),
  useIssuesFeed: () => {},
  useMyIssuesFeed: () => {},
}));
vi.mock('../sync/outbox.ts', () => ({
  outbox: { pendingWrites: async () => [], subscribe: () => () => {} },
}));

const { useMyIssues } = await import('./useMyIssues.ts');

const team = (id: string, key: string, name: string): SyncedTeam => ({
  id,
  workspace_id: WS,
  key,
  name,
  private: false,
});
const TEAMS = [
  team('t1', 'ENG', 'Engineering'),
  team('t2', 'OPS', 'Operations'),
  team('t3', 'DES', 'Design'),
];
const state = (id: string, teamId: string, position: number): SyncedWorkflowState => ({
  id,
  workspace_id: WS,
  team_id: teamId,
  name: id,
  type: 'started',
  position,
  color: '#000000',
  archived_at: null,
});
const label = (id: string, teamId: string | null): SyncedLabel => ({
  id,
  workspace_id: WS,
  team_id: teamId,
  parent_id: null,
  name: id,
  color: '#000000',
  is_group: false,
  archived_at: null,
  created_at: '2025-01-01T00:00:00Z',
});
const member = (id: string): SyncedMember => ({
  id,
  workspace_id: WS,
  name: `Name ${id}`,
  handle: id,
  role: 'member',
  locale: 'en',
  deactivated_at: null,
  created_at: '2025-01-01T00:00:00Z',
});
const issue = (id: string, teamId: string, number: number): SyncedIssue => ({
  id,
  workspace_id: WS,
  team_id: teamId,
  number,
  title: id,
  state_id: teamId === 't1' ? 's-eng' : 's-ops',
  priority: 0,
  assignee_id: 'm1',
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
const link = (issueId: string, labelId: string): SyncedIssueLabel => ({
  workspace_id: WS,
  team_id: 't1',
  issue_id: issueId,
  label_id: labelId,
});

function Probe({ teams = TEAMS }: { teams?: SyncedTeam[] }) {
  const result = useMyIssues(WS, teams);
  return (
    <p data-testid="out">
      {JSON.stringify({
        ready: result.ready,
        rows: result.rows.map((row) => [row.identifier, row.labelIds]),
        states: result.data.states.map((s) => s.id),
        labels: result.data.labels.map((l) => l.id),
        statesReady: result.data.statesReady,
        names: [...result.names.entries()],
      })}
    </p>
  );
}
const read = () => JSON.parse(screen.getByTestId('out').textContent ?? '{}');

afterEach(cleanup);

beforeEach(() => {
  asked.length = 0;
  mine = local([issue('a', 't1', 1), issue('b', 't2', 2), issue('c', 't9', 3)], (r) => r.id);
  members = local([member('m1')], (r) => r.id);
  workspaceLabels = local([label('ws-label', null)], (r) => r.id);
  for (const t of ['t1', 't2', 't3']) {
    perTeam[`workflowStates:${t}`] = local(
      t === 't1' ? [state('s-eng', 't1', 1)] : t === 't2' ? [state('s-ops', 't2', 1)] : [],
      (r) => r.id,
    ) as never;
    perTeam[`labels:${t}`] = local([label(`l-${t}`, t)], (r) => r.id) as never;
    perTeam[`issueLabels:${t}`] = local(
      t === 't1' ? [link('a', 'l-t1')] : [],
      (r) => `${r.issue_id}:${r.label_id}`,
    ) as never;
  }
});

describe('useMyIssues', () => {
  it('numbers each row with the key of its own team and carries the labels of its team', async () => {
    await act(async () => {
      render(<Probe />);
    });
    expect(read().rows).toEqual([
      ['ENG-1', ['l-t1']],
      ['OPS-2', []],
    ]);
    expect(read().ready).toBe(true);
  });

  it('drops the rows of a team the person no longer sees: no stale row, no invented number', async () => {
    await act(async () => {
      render(<Probe teams={[TEAMS[0] as SyncedTeam]} />);
    });
    expect(read().rows.map((row: [string]) => row[0])).toEqual(['ENG-1']);
  });

  it('reads the states and labels of the teams that have a row, and of no other team', async () => {
    await act(async () => {
      render(<Probe />);
    });
    expect(asked).not.toContain('issues');
    expect(asked.filter((entry) => entry.includes(':t3'))).toEqual([]);
    expect(asked).toEqual(
      expect.arrayContaining([
        'workflowStates:t1',
        'workflowStates:t2',
        'labels:t1',
        'labels:t2',
        'issueLabels:t1',
        'issueLabels:t2',
        'myIssues',
        'members',
        'workspaceLabels',
      ]),
    );
    expect(read().states).toEqual(['s-eng', 's-ops']);
    expect(read().labels).toEqual(expect.arrayContaining(['l-t1', 'l-t2', 'ws-label']));
    expect(read().labels).not.toContain('l-t3');
  });

  it('names the groups: every visible team and every member', async () => {
    await act(async () => {
      render(<Probe />);
    });
    const names = new Map(read().names as [string, string][]);
    expect(names.get('t1')).toBe('Engineering');
    expect(names.get('t3')).toBe('Design');
    expect(names.get('m1')).toBe('Name m1');
  });

  it('is not ready before the issues have arrived, and picks up a row that arrives later', async () => {
    mine = local<SyncedIssue>([], (r) => r.id, false);
    await act(async () => {
      render(<Probe />);
    });
    expect(read().ready).toBe(false);
    await act(async () => {
      mine.add(issue('late', 't2', 5));
    });
    expect(read().rows.map((row: [string]) => row[0])).toEqual(['OPS-5']);
  });
});
