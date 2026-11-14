// The states every new team starts with, in workflow order (spec §6). `position` orders them in the UI.
import type { WorkflowStateType } from './schema.ts';

export type DefaultWorkflowState = {
  name: string;
  type: WorkflowStateType;
  position: number;
  color: string;
};

/** A fresh list on every call, so callers can change it without touching the defaults. */
export function defaultWorkflowStates(): DefaultWorkflowState[] {
  return [
    { name: 'Triage', type: 'triage', position: 0, color: '#fb923c' },
    { name: 'Backlog', type: 'backlog', position: 1, color: '#94a3b8' },
    { name: 'Todo', type: 'unstarted', position: 2, color: '#64748b' },
    { name: 'In Progress', type: 'started', position: 3, color: '#facc15' },
    { name: 'Done', type: 'completed', position: 4, color: '#22c55e' },
    { name: 'Canceled', type: 'canceled', position: 5, color: '#ef4444' },
  ];
}
