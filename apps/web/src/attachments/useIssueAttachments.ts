import { useLiveQuery } from '@tanstack/react-db';
import { useKeptRows } from '../comments/keep.ts';
import { useKeepIssueCurrent } from '../comments/refresh.ts';
import type { SyncedAttachment } from '../sync/collections.ts';
import { useShape } from '../sync/shapes.ts';

/** The ready files of one opened issue, oldest first. A snapshot, read again when the issue changes. */
export function useIssueAttachments(
  workspaceId: string,
  teamId: string,
  issueId: string,
): { attachments: SyncedAttachment[]; ready: boolean } {
  const collection = useShape({ kind: 'issueAttachments', workspaceId, teamId, issueId });
  useKeepIssueCurrent(workspaceId, teamId, issueId, 'issueAttachments');
  const { data, isReady } = useLiveQuery({
    query: (q) => q.from({ file: collection }).orderBy(({ file }) => file.created_at),
  });
  const kept = useKeptRows(data, isReady, issueId);
  return { attachments: [...kept.rows], ready: kept.ready };
}
