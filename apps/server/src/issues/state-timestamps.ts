// The timestamps that follow an issue's state: entering a `started` state sets `started_at` if it is not set,
// `completed` sets `completed_at`, `canceled` sets `canceled_at`, and leaving `completed` or `canceled` clears that column.
import type { WorkflowStateType } from '@torch/shared/db/schema';

export type StateTimestamps = {
  startedAt: Date | null;
  completedAt: Date | null;
  canceledAt: Date | null;
};

/** The timestamps of an issue that is now in a state of `type`, given the ones it had. Pure: `now` is a parameter. */
export function applyStateTimestamps(
  type: WorkflowStateType,
  current: StateTimestamps,
  now: Date,
): StateTimestamps {
  return {
    startedAt: type === 'started' ? (current.startedAt ?? now) : current.startedAt,
    completedAt: type === 'completed' ? (current.completedAt ?? now) : null,
    canceledAt: type === 'canceled' ? (current.canceledAt ?? now) : null,
  };
}
