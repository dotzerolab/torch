// Checks on the ids an issue call refers to: people, labels and parents must belong to the workspace and be usable by
// this issue. A refusal says which field, never anything about what the id points at.
import {
  type IssueRow,
  issue,
  type LabelRow,
  label,
  member,
  team,
  teamMember,
} from '@torch/shared/db/schema';
import { type Actor, canSeeTeam, type TeamAccess } from '@torch/shared/permissions';
import { and, eq, inArray, isNull } from 'drizzle-orm';
import type { Tx } from '../db.ts';

/**
 * Of `ids`, the active members of the team's workspace who can see the team (an assignee or a subscriber must be
 * able to open the issue). A deactivated member, a member of another workspace and a guest outside the team drop out.
 */
export async function membersWhoCanSeeTeam(
  tx: Tx,
  access: TeamAccess,
  ids: readonly string[],
): Promise<Set<string>> {
  if (ids.length === 0) return new Set();
  const rows = await tx
    .select({ id: member.id, role: member.role, teamId: teamMember.teamId })
    .from(member)
    .leftJoin(
      teamMember,
      and(
        eq(teamMember.workspaceId, member.workspaceId),
        eq(teamMember.memberId, member.id),
        eq(teamMember.teamId, access.id),
      ),
    )
    .where(
      and(
        eq(member.workspaceId, access.workspaceId),
        inArray(member.id, [...ids]),
        isNull(member.deactivatedAt),
      ),
    );
  const allowed = new Set<string>();
  for (const row of rows) {
    const candidate: Actor = {
      workspaceId: access.workspaceId,
      memberId: row.id,
      role: row.role,
      teamIds: new Set(row.teamId ? [access.id] : []),
    };
    if (canSeeTeam(candidate, access)) allowed.add(row.id);
  }
  return allowed;
}

/**
 * The labels an issue of `teamId` may carry: not archived, not a group (a group only groups), and either of the
 * workspace or of this very team. Returns them in the order of `ids`, or null if any id is not usable.
 */
export async function usableLabels(
  tx: Tx,
  workspaceId: string,
  teamId: string,
  ids: readonly string[],
): Promise<LabelRow[] | null> {
  const unique = [...new Set(ids)];
  if (unique.length === 0) return [];
  const rows = await tx
    .select()
    .from(label)
    .where(and(eq(label.workspaceId, workspaceId), inArray(label.id, unique)));
  const byId = new Map(rows.map((row) => [row.id, row]));
  const ordered: LabelRow[] = [];
  for (const id of unique) {
    const row = byId.get(id);
    if (!row || row.archivedAt || row.isGroup) return null;
    if (row.teamId !== null && row.teamId !== teamId) return null;
    ordered.push(row);
  }
  return ordered;
}

/** One label per group: when several labels of the same group are given, the last one wins. The rest keep their order. */
export function keepLastLabelPerGroup(labels: readonly LabelRow[]): LabelRow[] {
  const lastOfGroup = new Map<string, string>();
  for (const row of labels) if (row.parentId) lastOfGroup.set(row.parentId, row.id);
  return labels.filter((row) => !row.parentId || lastOfGroup.get(row.parentId) === row.id);
}

/**
 * An issue that may be the parent of another: in the workspace, not archived, in a team the actor can see. Returns
 * null otherwise, whatever the reason, so a caller cannot tell a hidden issue from a missing one.
 */
export async function usableParent(
  tx: Tx,
  actor: Actor,
  parentId: string,
): Promise<Pick<IssueRow, 'id' | 'teamId'> | null> {
  const [row] = await tx
    .select({
      id: issue.id,
      teamId: issue.teamId,
      archivedAt: issue.archivedAt,
      teamPrivate: team.private,
    })
    .from(issue)
    .innerJoin(team, and(eq(team.workspaceId, issue.workspaceId), eq(team.id, issue.teamId)))
    .where(and(eq(issue.workspaceId, actor.workspaceId), eq(issue.id, parentId)));
  if (!row || row.archivedAt) return null;
  const access: TeamAccess = {
    id: row.teamId,
    workspaceId: actor.workspaceId,
    private: row.teamPrivate,
  };
  return canSeeTeam(actor, access) ? { id: row.id, teamId: row.teamId } : null;
}

/** An issue the actor may see (any team they can see, archived or not), or null: a hidden issue and a missing one look alike. */
export async function visibleIssue(
  tx: Tx,
  actor: Actor,
  issueId: string,
): Promise<Pick<IssueRow, 'id' | 'teamId'> | null> {
  const [row] = await tx
    .select({ id: issue.id, teamId: issue.teamId, teamPrivate: team.private })
    .from(issue)
    .innerJoin(team, and(eq(team.workspaceId, issue.workspaceId), eq(team.id, issue.teamId)))
    .where(and(eq(issue.workspaceId, actor.workspaceId), eq(issue.id, issueId)));
  if (!row) return null;
  const access: TeamAccess = {
    id: row.teamId,
    workspaceId: actor.workspaceId,
    private: row.teamPrivate,
  };
  return canSeeTeam(actor, access) ? { id: row.id, teamId: row.teamId } : null;
}
