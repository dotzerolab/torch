// Which team an issue belongs to, for the per-issue shape routes: the stored issue decides, never the URL.
import { issue, team } from '@torch/shared/db/schema';
import type { TeamAccess } from '@torch/shared/permissions';
import { and, eq } from 'drizzle-orm';
import type { Orm } from '../db.ts';
import { isUuid } from '../util/uuid.ts';

/**
 * The team of an issue of this workspace (id and privacy, what `canSeeTeam` needs), or null when the issue does not
 * exist, belongs to another workspace or the id is malformed. The issue's own id is returned from storage.
 */
export async function loadIssueTeamAccess(
  orm: Orm,
  workspaceId: string,
  issueId: string,
): Promise<{ issueId: string; access: TeamAccess } | null> {
  if (!isUuid(workspaceId) || !isUuid(issueId)) return null;
  const [row] = await orm
    .select({ issueId: issue.id, teamId: team.id, private: team.private })
    .from(issue)
    .innerJoin(team, and(eq(team.workspaceId, issue.workspaceId), eq(team.id, issue.teamId)))
    .where(and(eq(issue.workspaceId, workspaceId), eq(issue.id, issueId)))
    .limit(1);
  if (!row) return null;
  return { issueId: row.issueId, access: { id: row.teamId, workspaceId, private: row.private } };
}
