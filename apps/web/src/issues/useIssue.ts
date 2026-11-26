// One issue of a team by its number, from the team's loaded issues. `gone` says it was there and is not any more (the
// team was removed or access was revoked while it was open); an issue that never was there is just `row: null`.
import { useMemo, useRef } from 'react';
import type { SyncedTeam } from '../sync/collections.ts';
import { useIssueRows } from './data.ts';
import type { IssueRow } from './model/engine.ts';

export function useIssue(
  workspaceId: string,
  team: Pick<SyncedTeam, 'id' | 'key'>,
  number: number,
): { row: IssueRow | null; ready: boolean; gone: boolean } {
  const { rows, ready } = useIssueRows(workspaceId, team);
  const row = useMemo(
    () => rows.find((candidate) => candidate.issue.number === number) ?? null,
    [rows, number],
  );
  const seen = useRef(false);
  if (row) seen.current = true;
  return { row, ready, gone: seen.current && ready && row === null };
}
