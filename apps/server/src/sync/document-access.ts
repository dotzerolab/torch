// Which team a document belongs to, for the per-document shape route: the stored document decides, never the URL.
import { document, team } from '@torch/shared/db/schema';
import type { TeamAccess } from '@torch/shared/permissions';
import { and, eq } from 'drizzle-orm';
import type { Orm } from '../db.ts';
import { isUuid } from '../util/uuid.ts';

/**
 * The team of a document of this workspace (id and privacy, what `canSeeTeam` needs), or null when the document does
 * not exist, belongs to another workspace or the id is malformed. The document's own id is returned from storage.
 */
export async function loadDocumentTeamAccess(
  orm: Orm,
  workspaceId: string,
  documentId: string,
): Promise<{ documentId: string; access: TeamAccess } | null> {
  if (!isUuid(workspaceId) || !isUuid(documentId)) return null;
  const [row] = await orm
    .select({ documentId: document.id, teamId: team.id, private: team.private })
    .from(document)
    .innerJoin(team, and(eq(team.workspaceId, document.workspaceId), eq(team.id, document.teamId)))
    .where(and(eq(document.workspaceId, workspaceId), eq(document.id, documentId)))
    .limit(1);
  if (!row) return null;
  return {
    documentId: row.documentId,
    access: { id: row.teamId, workspaceId, private: row.private },
  };
}
