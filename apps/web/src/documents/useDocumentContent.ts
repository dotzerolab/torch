import { useLiveQuery } from '@tanstack/react-db';
import { useKeptRows } from '../comments/keep.ts';
import { useKeepDocumentCurrent } from '../comments/refresh.ts';
import { useShape } from '../sync/shapes.ts';

/**
 * The body of one opened document: `null` until the shape has answered, and for a document the person cannot read. A
 * snapshot, read again when the document changes (its row in the live titles shape) and right after this person saves.
 */
export function useDocumentContent(
  workspaceId: string,
  teamId: string,
  documentId: string,
): { body: string | null; ready: boolean } {
  const collection = useShape({ kind: 'documentContent', workspaceId, teamId, documentId });
  useKeepDocumentCurrent(workspaceId, teamId, documentId);
  const { data, isReady } = useLiveQuery({
    query: (q) => q.from({ content: collection }),
  });
  const kept = useKeptRows(data, isReady, documentId);
  return { body: kept.rows[0]?.body ?? null, ready: kept.ready };
}
