// Electric shape definitions (ADR 0001): what each synced collection is allowed to contain. The proxy sends
// exactly these to Electric; nothing the client says reaches a shape. Values travel as `params[n]`, never inside
// the SQL text, so an id can never change the meaning of a `where` clause.
import type { Actor } from '@torch/shared/permissions';

export type ShapeDefinition = {
  table: string;
  /** Constant SQL template with `$1`, `$2`, ... placeholders only. */
  where: string;
  /** Values for `$1`, `$2`, ... in order. */
  params: string[];
  columns: string[];
};

/** An IN list must not be empty; no row has this id, so "no teams" matches nothing. */
const NIL_UUID = '00000000-0000-0000-0000-000000000000';

const TEAM_COLUMNS = ['id', 'workspace_id', 'key', 'name', 'private'];
// Never `description` (ADR 0001 section 4): large text syncs per opened object, not in the list shape.
const ISSUE_COLUMNS = [
  'id',
  'workspace_id',
  'team_id',
  'number',
  'title',
  'state_id',
  'priority',
  'assignee_id',
  'creator_id',
  'created_at',
  'updated_at',
  'archived_at',
];
/**
 * The synced member profile: an allowlist, so a column added to `member` later stays private until someone adds
 * it here on purpose. Never `email` (administrators read it through the REST list) and never `timezone`.
 */
export const MEMBER_COLUMNS: readonly string[] = [
  'id',
  'workspace_id',
  'name',
  'handle',
  'role',
  'locale',
  'deactivated_at',
  'created_at',
];
const TEAM_MEMBER_COLUMNS = ['team_id', 'member_id', 'workspace_id', 'created_at'];
const WORKFLOW_STATE_COLUMNS = [
  'id',
  'workspace_id',
  'team_id',
  'name',
  'type',
  'position',
  'color',
];

/**
 * The teams the actor can see, mirroring `canSeeTeam` in SQL: a guest sees only their teams, everyone else sees
 * public teams plus their own. The team list is sorted so one actor always yields one URL.
 */
export function teamsShape(actor: Actor): ShapeDefinition {
  const own = [...actor.teamIds].sort();
  const ids = own.length > 0 ? own : [NIL_UUID];
  const list = ids.map((_, index) => `$${index + 2}`).join(', ');
  const where =
    actor.role === 'guest'
      ? `workspace_id = $1 AND id IN (${list})`
      : `workspace_id = $1 AND (private = false OR id IN (${list}))`;
  return { table: 'team', where, params: [actor.workspaceId, ...ids], columns: TEAM_COLUMNS };
}

/**
 * One shape per team (ADR 0001 section 2): losing a team drops one shape instead of refetching everything. The
 * caller has already checked that the actor can see `teamId`.
 */
export function teamScopedShape(
  kind: 'issues' | 'workflow_states',
  teamId: string,
): ShapeDefinition {
  if (kind === 'issues') {
    return { table: 'issue', where: 'team_id = $1', params: [teamId], columns: ISSUE_COLUMNS };
  }
  return {
    table: 'workflow_state',
    where: 'team_id = $1',
    params: [teamId],
    columns: WORKFLOW_STATE_COLUMNS,
  };
}

/**
 * The member profiles the actor may read, mirroring `canSeeMember` in SQL. `visibleMemberIds` comes from
 * `loadVisibleMemberIds` (stored ids, never the request): `'all'` for every role but guest, and for a guest the
 * list of themselves plus the members they share a team with. The list is sorted and de-duplicated so one actor
 * state always yields one URL, and it is never empty in SQL (the nil uuid matches no row).
 */
export function membersShape(
  actor: Actor,
  visibleMemberIds: readonly string[] | 'all',
): ShapeDefinition {
  if (visibleMemberIds === 'all') {
    // Fail closed: a guest must never be handed the whole workspace, whatever the caller computed.
    if (actor.role === 'guest') {
      throw new Error('a guest cannot read the whole-workspace member shape');
    }
    return {
      table: 'member',
      where: 'workspace_id = $1',
      params: [actor.workspaceId],
      columns: [...MEMBER_COLUMNS],
    };
  }
  const unique = [...new Set(visibleMemberIds)].sort();
  const ids = unique.length > 0 ? unique : [NIL_UUID];
  const list = ids.map((_, index) => `$${index + 2}`).join(', ');
  return {
    table: 'member',
    where: `workspace_id = $1 AND id IN (${list})`,
    params: [actor.workspaceId, ...ids],
    columns: [...MEMBER_COLUMNS],
  };
}

/**
 * Who is in one team (ADR 0001 section 2: one shape per team). The caller has already checked that the actor can
 * see `teamId`; every co-member of a team the actor can see is visible to them by construction.
 */
export function teamMembersShape(teamId: string): ShapeDefinition {
  return {
    table: 'team_member',
    where: 'team_id = $1',
    params: [teamId],
    columns: [...TEAM_MEMBER_COLUMNS],
  };
}
