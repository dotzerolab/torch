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
