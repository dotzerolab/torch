import { describe, expect, it } from 'vitest';
import { WORKFLOW_STATE_TYPES } from './schema.ts';
import { defaultWorkflowStates } from './workflow-defaults.ts';

describe('defaultWorkflowStates', () => {
  it('lists the six default states in workflow order', () => {
    const states = defaultWorkflowStates();

    expect(states.map((state) => [state.name, state.type])).toEqual([
      ['Triage', 'triage'],
      ['Backlog', 'backlog'],
      ['Todo', 'unstarted'],
      ['In Progress', 'started'],
      ['Done', 'completed'],
      ['Canceled', 'canceled'],
    ]);
    expect(states.map((state) => state.position)).toEqual([0, 1, 2, 3, 4, 5]);
  });

  it('covers every workflow state type once and gives each a hex colour', () => {
    const states = defaultWorkflowStates();

    expect(states.map((state) => state.type).sort()).toEqual([...WORKFLOW_STATE_TYPES].sort());
    for (const state of states) expect(state.color).toMatch(/^#[0-9a-f]{6}$/);
  });

  it('returns a fresh copy each call', () => {
    const first = defaultWorkflowStates();
    first[0] = { name: 'Changed', type: 'triage', position: 9, color: '#000000' };

    expect(defaultWorkflowStates()[0]?.name).toBe('Triage');
  });
});
