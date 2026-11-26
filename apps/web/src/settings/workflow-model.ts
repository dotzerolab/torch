// The rules the workflow screen applies to a team's states. The server decides every write; these only decide what the
// screen offers (which button is off, and why) and how a move turns into position writes.
import type { SyncedWorkflowState } from '../sync/collections.ts';
import type { WorkflowStateDto } from './admin-api.ts';

/** The states a team uses now (archived ones are history), in workflow order. */
export function activeStates(rows: readonly SyncedWorkflowState[]): SyncedWorkflowState[] {
  return rows
    .filter((state) => state.archived_at === null)
    .sort((a, b) => a.position - b.position || a.name.localeCompare(b.name));
}

const OPEN_TYPES = ['backlog', 'unstarted'];

/**
 * Why a state cannot be archived: a team keeps at least one backlog or unstarted state and one completed state, so the
 * last of either is kept. `null` when it may be archived (the server still has the last word).
 */
export function archiveBlock(
  active: readonly SyncedWorkflowState[],
  state: SyncedWorkflowState,
): 'open' | 'completed' | null {
  const others = active.filter((other) => other.id !== state.id);
  if (OPEN_TYPES.includes(state.type) && !others.some((other) => OPEN_TYPES.includes(other.type))) {
    return 'open';
  }
  if (state.type === 'completed' && !others.some((other) => other.type === 'completed')) {
    return 'completed';
  }
  return null;
}

/**
 * Moves one state a place up or down. The answer is the position writes that make the list `0..n-1` in the new order
 * (only the states whose position changes), or `[]` when it cannot move.
 */
export function reorder(
  active: readonly SyncedWorkflowState[],
  stateId: string,
  direction: -1 | 1,
): { id: string; position: number }[] {
  const from = active.findIndex((state) => state.id === stateId);
  const to = from + direction;
  if (from < 0 || to < 0 || to >= active.length) return [];
  const order = [...active];
  const [moved] = order.splice(from, 1);
  if (!moved) return [];
  order.splice(to, 0, moved);
  return order.flatMap((state, position) =>
    state.position === position ? [] : [{ id: state.id, position }],
  );
}

/** The synced row a server answer stands for. */
export function stateRow(dto: WorkflowStateDto, workspaceId: string): SyncedWorkflowState {
  return {
    id: dto.id,
    workspace_id: workspaceId,
    team_id: dto.teamId,
    name: dto.name,
    type: dto.type,
    position: dto.position,
    color: dto.color,
    archived_at: dto.archivedAt,
  };
}
