import { useLiveQuery } from '@tanstack/react-db';
import { useEffect, useMemo } from 'react';
import { useShape } from '../sync/shapes.ts';
import { useKeptRows } from './keep.ts';
import { applyPending, type CommentView, settlePending, usePending } from './pending.ts';
import { useKeepIssueCurrent } from './refresh.ts';

/**
 * The comments of one opened issue, oldest first, with this person's unconfirmed writes laid over them. The shape is a
 * snapshot held while the screen is mounted; it is read again when the issue changes and right after this person writes.
 */
export function useIssueComments(
  workspaceId: string,
  teamId: string,
  issueId: string,
): { comments: CommentView[]; ready: boolean } {
  const collection = useShape({ kind: 'issueComments', workspaceId, teamId, issueId });
  useKeepIssueCurrent(workspaceId, teamId, issueId, 'issueComments');
  const { data, isReady } = useLiveQuery({
    query: (q) => q.from({ comment: collection }).orderBy(({ comment }) => comment.created_at),
  });
  const pending = usePending(issueId);
  const kept = useKeptRows(data, isReady, issueId);
  // A write the server acknowledged is in the rows of the instance that replaced the one it was made against.
  useEffect(() => {
    if (isReady) settlePending(issueId, collection);
  }, [isReady, collection, issueId]);
  const comments = useMemo(() => applyPending(kept.rows, pending), [kept.rows, pending]);
  return { comments, ready: kept.ready };
}
