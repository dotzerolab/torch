// Which team an issue belongs to, for the per-issue shape routes: the stored issue decides, never the URL.
import { comment, issue, team } from '@torch/shared/db/schema';
import type { TeamAccess } from '@torch/shared/permissions';
import { and, count, eq, isNotNull } from 'drizzle-orm';
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

/**
 * The generation of an issue's comments shape: how many of its comments were deleted. A delete is a tombstone (the
 * row stays, `deleted_at` is set), so the number only grows, and it grows in the transaction of the delete itself:
 * no request that starts after the delete commits can name the previous generation. See `issueCommentsShape`.
 */
export async function loadCommentGeneration(
  orm: Orm,
  workspaceId: string,
  issueId: string,
): Promise<number> {
  const [row] = await orm
    .select({ deleted: count() })
    .from(comment)
    .where(
      and(
        eq(comment.workspaceId, workspaceId),
        eq(comment.issueId, issueId),
        isNotNull(comment.deletedAt),
      ),
    );
  return row?.deleted ?? 0;
}
