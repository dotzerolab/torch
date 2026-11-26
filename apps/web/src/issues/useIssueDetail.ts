// What the panel of an opened issue reads beyond the list row: its description (a snapshot of the one issue, never part
// of a list shape) and who follows it (a snapshot of the team's subscribers).
import { useLiveQuery } from '@tanstack/react-db';
import { useMemo } from 'react';
import type { SyncedActivity, SyncedIssueLink, SyncedIssueRelation } from '../sync/collections.ts';
import { useSnapshot } from '../sync/snapshot-hooks.ts';

export type IssueDetailData = {
  /** Null until the snapshot has the issue. */
  description: string | null;
  subscriberIds: string[];
  /** Every relation row of the team: `relationsOf` reads the ones of the issue (an end may be an issue of another team). */
  relations: SyncedIssueRelation[];
  links: SyncedIssueLink[];
  /** Oldest first. */
  activity: SyncedActivity[];
  ready: boolean;
};

export function useIssueDetail(
  workspaceId: string,
  teamId: string,
  issueId: string,
): IssueDetailData {
  const detailCollection = useSnapshot({ kind: 'issueDetail', workspaceId, teamId, issueId });
  const subscribersCollection = useSnapshot({ kind: 'issueSubscribers', workspaceId, teamId });
  const relationsCollection = useSnapshot({ kind: 'issueRelations', workspaceId, teamId });
  const linksCollection = useSnapshot({ kind: 'issueLinks', workspaceId, teamId });
  const activityCollection = useSnapshot({ kind: 'issueActivity', workspaceId, teamId, issueId });
  const relationRows = useLiveQuery({ query: (q) => q.from({ row: relationsCollection }) });
  const linkRows = useLiveQuery({ query: (q) => q.from({ row: linksCollection }) });
  const activityRows = useLiveQuery({ query: (q) => q.from({ row: activityCollection }) });
  const detail = useLiveQuery({ query: (q) => q.from({ row: detailCollection }) });
  const subscribers = useLiveQuery({ query: (q) => q.from({ row: subscribersCollection }) });
  const { data: detailRows } = detail;
  const { data: subscriberRows } = subscribers;
  return useMemo(
    () => ({
      description: detailRows.find((row) => row.id === issueId)?.description ?? null,
      subscriberIds: subscriberRows
        .filter((row) => row.issue_id === issueId)
        .map((row) => row.member_id),
      relations: relationRows.data as SyncedIssueRelation[],
      links: (linkRows.data as SyncedIssueLink[]).filter((row) => row.issue_id === issueId),
      activity: [...(activityRows.data as SyncedActivity[])]
        .filter((row) => row.issue_id === issueId)
        .sort((a, b) => a.created_at.localeCompare(b.created_at)),
      ready: detail.isReady && subscribers.isReady,
    }),
    [
      detailRows,
      subscriberRows,
      relationRows.data,
      linkRows.data,
      activityRows.data,
      issueId,
      detail.isReady,
      subscribers.isReady,
    ],
  );
}
