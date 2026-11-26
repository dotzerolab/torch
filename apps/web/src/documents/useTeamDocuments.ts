import { useLiveQuery } from '@tanstack/react-db';
import type { SyncedDocumentSummary } from '../sync/collections.ts';
import { useShape } from '../sync/shapes.ts';

/** The documents of a team, titles only, the most recently changed first. Live. */
export function useTeamDocuments(
  workspaceId: string,
  teamId: string,
): { documents: SyncedDocumentSummary[]; ready: boolean } {
  const collection = useShape({ kind: 'documents', workspaceId, teamId });
  const { data, isReady } = useLiveQuery({
    query: (q) =>
      q.from({ document: collection }).orderBy(({ document }) => document.updated_at, 'desc'),
  });
  return { documents: data, ready: isReady };
}
