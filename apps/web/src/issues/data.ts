// What the issue screens read: the reference data of a team (states, labels, members) and the rows of its issues. The
// issues and the members are live shapes; everything else is a snapshot that is read again when it may have changed
// (`snapshot-hooks.ts`), so a screen adds one live connection (the issues of its team) and no more.
import { useLiveQuery } from '@tanstack/react-db';
import { useEffect, useMemo, useState } from 'react';
import type {
  SyncedIssue,
  SyncedIssueLabel,
  SyncedLabel,
  SyncedMember,
  SyncedTeam,
  SyncedWorkflowState,
} from '../sync/collections.ts';
import { type OutboxWrite, outbox } from '../sync/outbox.ts';
import { useShape } from '../sync/shapes.ts';
import { useIssuesFeed, useSnapshot } from '../sync/snapshot-hooks.ts';
import type { IssueRow } from './model/engine.ts';
import { applyLabelEdits, labelEditsFromWrites, recentLabelEdits } from './model/pending.ts';
import { buildRows } from './model/row-model.ts';

export type TeamData = {
  /** Every state of the team in workflow order, archived ones included (an issue may still be in one). */
  states: SyncedWorkflowState[];
  /** The labels a picker offers: of the team and of the workspace, not archived; a group only when it has a label. */
  labels: SyncedLabel[];
  /** Active members. */
  members: SyncedMember[];
  statesById: ReadonlyMap<string, SyncedWorkflowState>;
  /** Every label, archived ones too: a chip of an archived label can still be drawn (and removed). */
  labelsById: ReadonlyMap<string, SyncedLabel>;
  /** Every member, deactivated ones too: an assignee who was deactivated keeps their name. */
  membersById: ReadonlyMap<string, SyncedMember>;
  /** Everything is loaded. */
  ready: boolean;
  /** The states are loaded: enough to group a list (labels and names fill in when they arrive). */
  statesReady: boolean;
};

const EMPTY: never[] = [];

export function useTeamData(workspaceId: string, teamId: string): TeamData {
  const statesCollection = useSnapshot({ kind: 'workflowStates', workspaceId, teamId });
  const labelsCollection = useSnapshot({ kind: 'labels', workspaceId, teamId });
  const workspaceLabelsCollection = useSnapshot({ kind: 'workspaceLabels', workspaceId });
  const membersCollection = useShape({ kind: 'members', workspaceId });

  const states = useLiveQuery({ query: (q) => q.from({ row: statesCollection }) });
  const labels = useLiveQuery({ query: (q) => q.from({ row: labelsCollection }) });
  const workspaceLabels = useLiveQuery({
    query: (q) => q.from({ row: workspaceLabelsCollection }),
  });
  const members = useLiveQuery({ query: (q) => q.from({ row: membersCollection }) });

  const ready = states.isReady && labels.isReady && workspaceLabels.isReady && members.isReady;
  const { data: stateRows } = states;
  const { data: labelRows } = labels;
  const { data: workspaceLabelRows } = workspaceLabels;
  const { data: memberRows } = members;

  return useMemo(() => {
    const orderedStates = [...stateRows].sort((a, b) => a.position - b.position);
    const allLabels = [...labelRows, ...workspaceLabelRows];
    const open = allLabels.filter((label) => label.archived_at === null);
    const groupsWithLabels = new Set(
      open.flatMap((label) => (label.parent_id ? [label.parent_id] : [])),
    );
    const usable = open.filter((label) => !label.is_group || groupsWithLabels.has(label.id));
    return {
      states: orderedStates,
      labels: usable,
      members: memberRows.filter((member) => member.deactivated_at === null),
      statesById: new Map(orderedStates.map((state) => [state.id, state])),
      labelsById: new Map(allLabels.map((label) => [label.id, label])),
      membersById: new Map(memberRows.map((member) => [member.id, member])),
      ready,
      statesReady: states.isReady,
    };
  }, [stateRows, labelRows, workspaceLabelRows, memberRows, ready, states.isReady]);
}

/** The writes waiting on this device (every tab's), read again whenever the outbox says its queue changed. */
function usePendingWrites(workspaceId: string): readonly OutboxWrite[] {
  const [writes, setWrites] = useState<readonly OutboxWrite[]>(EMPTY);
  useEffect(() => {
    let current = true;
    const load = () => {
      void outbox
        .pendingWrites(workspaceId)
        .then((list) => {
          if (current) setWrites(list);
        })
        .catch(() => {});
    };
    load();
    const unsubscribe = outbox.subscribe(load);
    return () => {
      current = false;
      unsubscribe();
    };
  }, [workspaceId]);
  return writes;
}

/**
 * The rows of a team's issues, ready for the view engine: identifier, label ids, and the label edits that are queued or
 * just confirmed shown as if the server had them. Also keeps the team's snapshots fresh while its issues are on screen.
 */
export function useIssueRows(
  workspaceId: string,
  team: Pick<SyncedTeam, 'id' | 'key'>,
): { rows: IssueRow[]; ready: boolean } {
  const issuesCollection = useShape({ kind: 'issues', workspaceId, teamId: team.id });
  const linksCollection = useSnapshot({ kind: 'issueLabels', workspaceId, teamId: team.id });
  useIssuesFeed(workspaceId, team.id);

  const issues = useLiveQuery({ query: (q) => q.from({ issue: issuesCollection }) });
  const links = useLiveQuery({ query: (q) => q.from({ link: linksCollection }) });
  const writes = usePendingWrites(workspaceId);

  const { data: issueRows } = issues;
  const { data: linkRows } = links;
  const base = useMemo(
    () =>
      buildRows(
        issueRows as SyncedIssue[],
        linkRows as SyncedIssueLabel[],
        new Map([[team.id, team.key]]),
      ),
    [issueRows, linkRows, team.id, team.key],
  );
  const rows = useMemo(
    () =>
      applyLabelEdits(base, [
        ...recentLabelEdits.active(),
        ...labelEditsFromWrites(writes, workspaceId),
      ]),
    [base, writes, workspaceId],
  );
  // The rows are there when the issues are; their labels may arrive a moment later and then appear on them.
  return { rows, ready: issues.isReady };
}
