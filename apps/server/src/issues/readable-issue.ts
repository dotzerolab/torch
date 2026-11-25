// Can this actor see this issue? For the read calls of issue-scoped objects (comments, attachments): the stored issue
// decides, never the URL, and an issue that does not exist, belongs to another workspace or sits in a team the actor
// cannot see all answer the same: null.
import { issue, team } from '@torch/shared/db/schema';
import { canSeeTeam, type TeamAccess } from '@torch/shared/permissions';
import { and, eq } from 'drizzle-orm';
import type { Orm } from '../db.ts';
import type { ClientActor } from '../permissions/load-actor.ts';

/** The team access of an issue, when the actor can see its team. */
export async function readableIssue(
  orm: Orm,
  actor: ClientActor,
  issueId: string,
): Promise<TeamAccess | null> {
  const [subject] = await orm
    .select({ teamId: team.id, private: team.private })
    .from(issue)
    .innerJoin(team, and(eq(team.workspaceId, issue.workspaceId), eq(team.id, issue.teamId)))
    .where(and(eq(issue.workspaceId, actor.workspaceId), eq(issue.id, issueId)));
  if (!subject) return null;
  const access = { id: subject.teamId, workspaceId: actor.workspaceId, private: subject.private };
  return canSeeTeam(actor, access) ? access : null;
}
