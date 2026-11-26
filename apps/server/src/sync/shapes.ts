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
  'estimate',
  'due_date',
  'parent_id',
  'sort_order',
  'started_at',
  'completed_at',
  'canceled_at',
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
  // Clients hide archived states (an archived state keeps the issues it had, but takes no new ones).
  'archived_at',
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

// ---- the issue model (labels, issue join rows, per-issue detail and activity) ----

const LABEL_COLUMNS = [
  'id',
  'workspace_id',
  'team_id',
  'parent_id',
  'name',
  'color',
  'is_group',
  'archived_at',
  'created_at',
];

/**
 * The join rows and labels of one team. Each shape is filtered by the denormalised `team_id`, so a team's shape never
 * holds a row of another team. A relation ends in two issues that may belong to two teams, so its shape holds the rows
 * that start or end in the team; its columns are ids only (never a title, number or identifier), so the end that lies in
 * a team the actor cannot see reveals nothing but an id.
 */
const TEAM_DATA_SHAPES = {
  labels: { table: 'label', where: 'team_id = $1', columns: LABEL_COLUMNS },
  issue_labels: {
    table: 'issue_label',
    where: 'team_id = $1',
    columns: ['workspace_id', 'team_id', 'issue_id', 'label_id'],
  },
  issue_subscribers: {
    table: 'issue_subscriber',
    where: 'team_id = $1',
    columns: ['workspace_id', 'team_id', 'issue_id', 'member_id', 'created_at'],
  },
  issue_links: {
    table: 'issue_link',
    where: 'team_id = $1',
    columns: [
      'id',
      'workspace_id',
      'team_id',
      'issue_id',
      'url',
      'title',
      'created_by',
      'created_at',
    ],
  },
  issue_relations: {
    table: 'issue_relation',
    where: 'team_id = $1 OR related_team_id = $1',
    // `team_id` and `related_team_id` filter the rows (where) but are not sent: a client that sees one end knows its
    // team, and the other end's team id (a private team's id) is not needed to draw the relation.
    columns: [
      'id',
      'workspace_id',
      'issue_id',
      'related_issue_id',
      'type',
      'created_by',
      'created_at',
    ],
  },
} as const;

export type TeamDataKind = keyof typeof TEAM_DATA_SHAPES;

/** One of the team data shapes. The caller has already checked that the actor can see `teamId`. */
export function teamDataShape(kind: TeamDataKind, teamId: string): ShapeDefinition {
  const { table, where, columns } = TEAM_DATA_SHAPES[kind];
  return { table, where, params: [teamId], columns: [...columns] };
}

/** The labels of no team: they apply workspace-wide and every member of the workspace reads them. */
export function workspaceLabelsShape(workspaceId: string): ShapeDefinition {
  return {
    table: 'label',
    where: 'workspace_id = $1 AND team_id IS NULL',
    params: [workspaceId],
    columns: [...LABEL_COLUMNS],
  };
}

/**
 * The description of one opened issue (ADR 0001 section 4: large text syncs per object, never in a list). The caller
 * has already checked that the actor can see the issue's team.
 */
export function issueDetailShape(issueId: string): ShapeDefinition {
  return {
    table: 'issue',
    where: 'id = $1',
    params: [issueId],
    columns: ['id', 'workspace_id', 'team_id', 'description'],
  };
}

/** The history of one opened issue. Same precondition as `issueDetailShape`. */
export function issueActivityShape(issueId: string): ShapeDefinition {
  return {
    table: 'issue_activity',
    where: 'issue_id = $1',
    params: [issueId],
    columns: [
      'id',
      'workspace_id',
      'team_id',
      'issue_id',
      'actor_id',
      'client',
      'type',
      'field',
      'from_value',
      'to_value',
      'created_at',
    ],
  };
}

// ---- comments, attachments and documents ----

/**
 * The comments of one opened issue. Comment text syncs per opened issue, never in a list (ADR 0001 section 4); a
 * deleted comment's text is blank in the row itself. The caller has already checked that the actor can see the issue's
 * team.
 *
 * `generation` is how many comments of the issue were deleted so far (see `loadCommentGeneration`). Electric keeps the
 * log of a shape (the snapshot it took when the shape was first asked for, then every change), and sends that whole log
 * to anybody who starts from nothing, so a comment's deleted text and its earlier versions stay in the log of the shape
 * that saw them. Deleting a comment raises the generation, which makes this another shape for Electric (the second
 * parameter is part of the shape's identity; the condition on it is always true): readers that start from nothing are
 * served a new snapshot taken after the delete, and a reader that holds the handle of the old shape is told to start
 * over (`409 must-refetch`).
 */
export function issueCommentsShape(issueId: string, generation: number): ShapeDefinition {
  return {
    table: 'comment',
    where: 'issue_id = $1 AND $2::int4 >= 0',
    params: [issueId, String(generation)],
    columns: [
      'id',
      'workspace_id',
      'team_id',
      'issue_id',
      'parent_id',
      'author_id',
      'body',
      'reactions',
      'created_at',
      'edited_at',
      'resolved_at',
      'resolved_by',
      'deleted_at',
    ],
  };
}

/**
 * The finished files of one opened issue. A pending upload is not part of it, and the storage key and the status never
 * leave the server: a file is read through a signed URL minted after the permission check. Same precondition as
 * `issueCommentsShape`.
 */
export function issueAttachmentsShape(issueId: string): ShapeDefinition {
  return {
    table: 'attachment',
    where: "issue_id = $1 AND status = 'ready'",
    params: [issueId],
    columns: [
      'id',
      'workspace_id',
      'team_id',
      'issue_id',
      'uploader_id',
      'file_name',
      'content_type',
      'size_bytes',
      'created_at',
    ],
  };
}

/**
 * The documents of one team, titles only: a body syncs per opened document (`documentContentShape`). The caller has
 * already checked that the actor can see `teamId`.
 */
export function teamDocumentsShape(teamId: string): ShapeDefinition {
  return {
    table: 'document',
    where: 'team_id = $1',
    params: [teamId],
    columns: [
      'id',
      'workspace_id',
      'team_id',
      'title',
      'created_by',
      'updated_by',
      'created_at',
      'updated_at',
      'archived_at',
    ],
  };
}

/** The body of one opened document. The caller has already checked that the actor can see the document's team. */
export function documentContentShape(documentId: string): ShapeDefinition {
  return {
    table: 'document',
    where: 'id = $1',
    params: [documentId],
    columns: ['id', 'workspace_id', 'team_id', 'body'],
  };
}

/**
 * The actor's own team memberships, workspace-wide. Everything the client needs to notice that its own access
 * changed (a join or removal of a private team) arrives here as one small shape. Both values come from the
 * authenticated actor, never from the request.
 */
export function ownMembershipShape(actor: Actor): ShapeDefinition {
  return {
    table: 'team_member',
    where: 'workspace_id = $1 AND member_id = $2',
    params: [actor.workspaceId, actor.memberId],
    columns: [...TEAM_MEMBER_COLUMNS],
  };
}
