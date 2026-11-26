// What My Issues reads: the issues the person holds or created in every team they can see (one live shape), and the
// states and labels of each team that has a row (snapshots, no connection kept). A screen adds exactly one live shape.
import { useLiveQuery } from '@tanstack/react-db';
import { useEffect, useMemo, useReducer, useRef } from 'react';
import type {
  SyncedIssue,
  SyncedIssueLabel,
  SyncedLabel,
  SyncedTeam,
  SyncedWorkflowState,
} from '../sync/collections.ts';
import type { ShapeKey } from '../sync/registry.ts';
import { useShape } from '../sync/shapes.ts';
import { useMyIssuesFeed, useSnapshot, useSnapshots } from '../sync/snapshot-hooks.ts';
import { composeTeamData, type TeamData, usePendingWrites } from './data.ts';
import type { IssueRow } from './model/engine.ts';
import { applyLabelEdits, labelEditsFromWrites, recentLabelEdits } from './model/pending.ts';
import { buildRows } from './model/row-model.ts';

/** What the rows of several collections need of them: read the rows, hear a change, know when the first answer is in. */
type Source<T> = {
  readonly toArray: readonly T[];
  isReady(): boolean;
  onFirstReady(callback: () => void): () => void;
  subscribeChanges(callback: () => void): { unsubscribe(): void };
};

/** The rows of as many collections as there are teams, together; the number changes with the rows on screen. */
function useRowsOf<T>(given: readonly Source<T>[]): { rows: T[]; ready: boolean } {
  const [version, bump] = useReducer((count: number) => count + 1, 0);
  // The same collections in a new array are the same sources: only a new instance changes what is subscribed to.
  const last = useRef(given);
  if (given.length !== last.current.length || given.some((source, i) => source !== last.current[i]))
    last.current = given;
  const sources = last.current;
  useEffect(() => {
    const stops = sources.map((source) => source.subscribeChanges(bump));
    const waits = sources.filter((source) => !source.isReady()).map((s) => s.onFirstReady(bump));
    // A source may have changed between the render and this effect.
    bump();
    return () => {
      for (const stop of stops) stop.unsubscribe();
      for (const wait of waits) wait();
    };
  }, [sources]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: `version` is the signal that a collection changed
  return useMemo(
    () => ({
      rows: sources.flatMap((source) => [...source.toArray]),
      ready: sources.every((source) => source.isReady()),
    }),
    [sources, version],
  );
}

/** Every `n`-th collection of an array read three at a time: the states, the labels and the label links of each team. */
const every = <T>(items: readonly T[], offset: number): T[] =>
  items.filter((_, index) => index % 3 === offset);

export function useMyIssues(
  workspaceId: string,
  teams: readonly SyncedTeam[],
): {
  rows: IssueRow[];
  data: TeamData;
  /** Names of the teams and the members, to title the groups. */
  names: ReadonlyMap<string, string>;
  ready: boolean;
} {
  const mine = useShape({ kind: 'myIssues', workspaceId });
  const membersCollection = useShape({ kind: 'members', workspaceId });
  const workspaceLabelsCollection = useSnapshot({ kind: 'workspaceLabels', workspaceId });
  useMyIssuesFeed(workspaceId);

  const issues = useLiveQuery({ query: (q) => q.from({ issue: mine }) });
  const members = useLiveQuery({ query: (q) => q.from({ row: membersCollection }) });
  const workspaceLabels = useLiveQuery({
    query: (q) => q.from({ row: workspaceLabelsCollection }),
  });
  const writes = usePendingWrites(workspaceId);

  // A row of a team that is no longer in the person's teams is not shown, whatever the shape still holds: the team list
  // answers first, and the shape follows with its own restart.
  const teamKeys = useMemo(() => new Map(teams.map((team) => [team.id, team.key])), [teams]);
  const issueRows = issues.data as SyncedIssue[];
  const visible = useMemo(
    () => issueRows.filter((issue) => teamKeys.has(issue.team_id)),
    [issueRows, teamKeys],
  );

  // The reference data of each team that has a row: nothing is read for a team the list does not reach.
  const teamsWithRows = useMemo(
    () => [...new Set(visible.map((issue) => issue.team_id))].sort(),
    [visible],
  );
  const keys = useMemo<ShapeKey[]>(
    () =>
      teamsWithRows.flatMap((teamId) => [
        { kind: 'workflowStates', workspaceId, teamId } as const,
        { kind: 'labels', workspaceId, teamId } as const,
        { kind: 'issueLabels', workspaceId, teamId } as const,
      ]),
    [teamsWithRows, workspaceId],
  );
  const collections = useSnapshots(keys) as unknown as Source<never>[];
  const statesOf = useMemo(() => every(collections, 0), [collections]);
  const labelsOf = useMemo(() => every(collections, 1), [collections]);
  const linksOf = useMemo(() => every(collections, 2), [collections]);
  const states = useRowsOf(statesOf as unknown as Source<SyncedWorkflowState>[]);
  const labels = useRowsOf(labelsOf as unknown as Source<SyncedLabel>[]);
  const links = useRowsOf(linksOf as unknown as Source<SyncedIssueLabel>[]);

  const base = useMemo(
    () => buildRows(visible, links.rows, teamKeys),
    [visible, links.rows, teamKeys],
  );
  const rows = useMemo(
    () =>
      applyLabelEdits(base, [
        ...recentLabelEdits.active(),
        ...labelEditsFromWrites(writes, workspaceId),
      ]),
    [base, writes, workspaceId],
  );

  const ready = issues.isReady && members.isReady && workspaceLabels.isReady;
  const data = useMemo(
    () => ({
      ...composeTeamData({
        states: states.rows,
        labels: labels.rows,
        workspaceLabels: workspaceLabels.data,
        members: members.data,
        ready: ready && states.ready && labels.ready && links.ready,
        statesReady: states.ready,
      }),
      teamKeys,
    }),
    [
      teamKeys,
      states.rows,
      states.ready,
      labels.rows,
      labels.ready,
      links.ready,
      workspaceLabels.data,
      members.data,
      ready,
    ],
  );
  const names = useMemo(
    () =>
      new Map<string, string>([
        ...data.members.map((member) => [member.id, member.name] as const),
        ...[...data.membersById].map(([id, member]) => [id, member.name] as const),
        ...teams.map((team) => [team.id, team.name] as const),
      ]),
    [data.members, data.membersById, teams],
  );
  return { rows, data, names, ready };
}
