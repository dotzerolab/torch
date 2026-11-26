import { describe, expect, it } from 'vitest';
import type { SyncedWorkflowState } from '../sync/collections.ts';
import type { WorkflowStateDto } from './admin-api.ts';
import { activeStates, archiveBlock, reorder, stateRow } from './workflow-model.ts';

const state = (
  id: string,
  type: string,
  position: number,
  archived: string | null = null,
): SyncedWorkflowState => ({
  id,
  workspace_id: 'w',
  team_id: 't',
  name: id,
  type,
  position,
  color: '#111111',
  archived_at: archived,
});

const TEAM = [
  state('triage', 'triage', 0),
  state('backlog', 'backlog', 1),
  state('todo', 'unstarted', 2),
  state('doing', 'started', 3),
  state('done', 'completed', 4),
  state('canceled', 'canceled', 5),
];

describe('activeStates', () => {
  it('lists the states in workflow order and leaves archived ones out', () => {
    const rows = [
      ...TEAM.filter((s) => ['doing', 'triage', 'backlog'].includes(s.id)),
      state('old', 'started', 0, '2026-01-01'),
    ];
    expect(activeStates(rows).map((s) => s.id)).toEqual(['triage', 'backlog', 'doing']);
  });
});

describe('archiveBlock', () => {
  it('allows archiving a state when another of its kind stays', () => {
    expect(archiveBlock(TEAM, TEAM[1] as SyncedWorkflowState)).toBeNull();
    expect(archiveBlock(TEAM, TEAM[3] as SyncedWorkflowState)).toBeNull();
    expect(archiveBlock(TEAM, TEAM[5] as SyncedWorkflowState)).toBeNull();
  });
  it('keeps the last backlog or unstarted state, and the last completed one', () => {
    const lean = [TEAM[2], TEAM[3], TEAM[4]] as SyncedWorkflowState[];
    expect(archiveBlock(lean, lean[0] as SyncedWorkflowState)).toBe('open');
    expect(archiveBlock(lean, lean[2] as SyncedWorkflowState)).toBe('completed');
    expect(archiveBlock(lean, lean[1] as SyncedWorkflowState)).toBeNull();
  });
  it('lets a backlog state go while an unstarted one remains', () => {
    const two = [TEAM[1], TEAM[2], TEAM[4]] as SyncedWorkflowState[];
    expect(archiveBlock(two, two[0] as SyncedWorkflowState)).toBeNull();
  });
});

describe('reorder', () => {
  it('writes the positions that make the list 0..n-1 in the new order', () => {
    const moves = reorder(TEAM, 'doing', -1);
    expect(moves).toEqual([
      { id: 'doing', position: 2 },
      { id: 'todo', position: 3 },
    ]);
  });
  it('renumbers a list with gaps, and does nothing at the ends or for an unknown state', () => {
    const gapped = [state('a', 'backlog', 10), state('b', 'completed', 20)];
    expect(reorder(gapped, 'a', 1)).toEqual([
      { id: 'b', position: 0 },
      { id: 'a', position: 1 },
    ]);
    expect(reorder(TEAM, 'triage', -1)).toEqual([]);
    expect(reorder(TEAM, 'canceled', 1)).toEqual([]);
    expect(reorder(TEAM, 'nope', 1)).toEqual([]);
  });
});

describe('stateRow', () => {
  it('turns a server answer into the row the snapshot would hold', () => {
    const dto: WorkflowStateDto = {
      id: 'x',
      teamId: 't',
      name: 'Review',
      type: 'started',
      position: 4,
      color: '#123456',
      archivedAt: null,
      createdAt: '2026-11-26T00:00:00.000Z',
    };
    expect(stateRow(dto, 'w')).toEqual({
      id: 'x',
      workspace_id: 'w',
      team_id: 't',
      name: 'Review',
      type: 'started',
      position: 4,
      color: '#123456',
      archived_at: null,
    });
  });
});
