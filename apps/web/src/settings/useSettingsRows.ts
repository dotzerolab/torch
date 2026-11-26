// The rows the workflow and label screens read: a snapshot of the table, kept fresh after this person's own writes.
// Both hooks return `refresh` (read the snapshot again now) and `remember` (keep the server's answer to a write on
// screen until the snapshot shows it, `confirmed.ts`).
import { useLiveQuery } from '@tanstack/react-db';
import { useCallback } from 'react';
import type { SyncedLabel, SyncedWorkflowState } from '../sync/collections.ts';
import { snapshotWatch, useSnapshot } from '../sync/snapshot-hooks.ts';
import { useConfirmedRows } from './confirmed.ts';

export type SettingsRows<T> = {
  rows: T[];
  /** The first read of the snapshot finished. */
  ready: boolean;
  remember: (row: T) => void;
  refresh: () => void;
};

/** The states of one team (archived ones too: the screen picks what it shows). */
export function useWorkflowStates(
  workspaceId: string,
  teamId: string,
): SettingsRows<SyncedWorkflowState> {
  const collection = useSnapshot({ kind: 'workflowStates', workspaceId, teamId });
  const { data, isReady } = useLiveQuery({ query: (q) => q.from({ row: collection }) });
  const refresh = useCallback(
    () => snapshotWatch.ownWrite({ workspaceId, teamId, kinds: ['workflowStates'] }),
    [workspaceId, teamId],
  );
  const { rows, remember } = useConfirmedRows<SyncedWorkflowState>(data, refresh);
  return { rows, ready: isReady, remember, refresh };
}

/** The labels of the whole workspace. */
export function useWorkspaceLabelRows(workspaceId: string): SettingsRows<SyncedLabel> {
  const collection = useSnapshot({ kind: 'workspaceLabels', workspaceId });
  const { data, isReady } = useLiveQuery({ query: (q) => q.from({ row: collection }) });
  const refresh = useCallback(
    () => snapshotWatch.ownWrite({ workspaceId, kinds: ['workspaceLabels'] }),
    [workspaceId],
  );
  const { rows, remember } = useConfirmedRows<SyncedLabel>(data, refresh);
  return { rows, ready: isReady, remember, refresh };
}

/** The labels of one team (not the workspace's). */
export function useTeamLabelRows(workspaceId: string, teamId: string): SettingsRows<SyncedLabel> {
  const collection = useSnapshot({ kind: 'labels', workspaceId, teamId });
  const { data, isReady } = useLiveQuery({ query: (q) => q.from({ row: collection }) });
  const refresh = useCallback(
    () => snapshotWatch.ownWrite({ workspaceId, teamId, kinds: ['labels'] }),
    [workspaceId, teamId],
  );
  const { rows, remember } = useConfirmedRows<SyncedLabel>(data, refresh);
  return { rows, ready: isReady, remember, refresh };
}
