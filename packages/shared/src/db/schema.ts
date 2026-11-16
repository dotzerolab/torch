// Core tables (spec §6). Every table carries `workspace_id`; foreign keys between workspace-scoped
// tables are composite `(workspace_id, x_id)` (and `(team_id, state_id)` for workflow states), so a row
// can never point at another workspace's or another team's data, whatever the application code does.
import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  date,
  doublePrecision,
  foreignKey,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  primaryKey,
  smallint,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

import {
  ACTIVITY_CLIENTS,
  ISSUE_RELATION_TYPES,
  MEMBER_LOCALES,
  MEMBER_ROLES,
  WORKFLOW_STATE_TYPES,
} from './enums.ts';

export {
  ACTIVITY_CLIENTS,
  type ActivityClient,
  ISSUE_RELATION_TYPES,
  type IssueRelationType,
  MEMBER_LOCALES,
  MEMBER_ROLES,
  type MemberLocale,
  type MemberRole,
  WORKFLOW_STATE_TYPES,
  type WorkflowStateType,
} from './enums.ts';

/** What the audit log records (admin actions). Entries carry ids, roles and counts, never emails or free text. */
export const AUDIT_ACTIONS = [
  'member.role_changed',
  'member.deactivated',
  'member.reactivated',
  'member.profile_updated',
  'invite.created',
  'invite.resent',
  'invite.revoked',
  'invite.accepted',
  'team.created',
  'team.updated',
  'team.member_added',
  'team.member_removed',
  'team.admin_joined',
  'team.emptied',
] as const;
export type AuditAction = (typeof AUDIT_ACTIONS)[number];

export const AUDIT_TARGET_TYPES = ['member', 'invite', 'team', 'team_member'] as const;
export type AuditTargetType = (typeof AUDIT_TARGET_TYPES)[number];

export const memberRole = pgEnum('member_role', MEMBER_ROLES);
export const locale = pgEnum('locale', MEMBER_LOCALES);
export const workflowStateType = pgEnum('workflow_state_type', WORKFLOW_STATE_TYPES);
export const issueRelationType = pgEnum('issue_relation_type', ISSUE_RELATION_TYPES);
export const activityClient = pgEnum('activity_client', ACTIVITY_CLIENTS);

const id = () => uuid('id').primaryKey().defaultRandom();
const createdAt = () => timestamp('created_at', { withTimezone: true }).notNull().defaultNow();

export const workspace = pgTable(
  'workspace',
  {
    id: id(),
    name: text('name').notNull(),
    slug: text('slug').notNull(),
    createdAt: createdAt(),
  },
  (t) => [unique('workspace_slug_unique').on(t.slug)],
);

export const member = pgTable(
  'member',
  {
    id: id(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspace.id),
    email: text('email').notNull(),
    name: text('name').notNull(),
    handle: text('handle').notNull(),
    role: memberRole('role').notNull(),
    locale: locale('locale').notNull().default('en'),
    timezone: text('timezone').notNull().default('UTC'),
    deactivatedAt: timestamp('deactivated_at', { withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [
    unique('member_workspace_email_unique').on(t.workspaceId, t.email),
    unique('member_workspace_handle_unique').on(t.workspaceId, t.handle),
    // Target of the composite foreign keys of every table that points at a member.
    unique('member_workspace_id_unique').on(t.workspaceId, t.id),
    check('member_email_normalised', sql`${t.email} = lower(btrim(${t.email}))`),
  ],
);

export const team = pgTable(
  'team',
  {
    id: id(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspace.id),
    key: text('key').notNull(),
    name: text('name').notNull(),
    private: boolean('private').notNull().default(false),
    issueCounter: integer('issue_counter').notNull().default(0),
    createdAt: createdAt(),
  },
  (t) => [
    unique('team_workspace_key_unique').on(t.workspaceId, t.key),
    unique('team_workspace_id_unique').on(t.workspaceId, t.id),
    check('team_key_format', sql`${t.key} ~ '^[A-Z][A-Z0-9]{0,6}$'`),
  ],
);

export const teamMember = pgTable(
  'team_member',
  {
    workspaceId: uuid('workspace_id').notNull(),
    teamId: uuid('team_id').notNull(),
    memberId: uuid('member_id').notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    primaryKey({ columns: [t.teamId, t.memberId] }),
    foreignKey({
      name: 'team_member_team_fk',
      columns: [t.workspaceId, t.teamId],
      foreignColumns: [team.workspaceId, team.id],
    }).onDelete('cascade'),
    foreignKey({
      name: 'team_member_member_fk',
      columns: [t.workspaceId, t.memberId],
      foreignColumns: [member.workspaceId, member.id],
    }).onDelete('cascade'),
  ],
);

export const workflowState = pgTable(
  'workflow_state',
  {
    id: id(),
    workspaceId: uuid('workspace_id').notNull(),
    teamId: uuid('team_id').notNull(),
    name: text('name').notNull(),
    type: workflowStateType('type').notNull(),
    position: integer('position').notNull(),
    color: text('color').notNull().default('#94a3b8'),
    // An archived state keeps its issues' history and stays readable; it takes no new issues and frees its name.
    archivedAt: timestamp('archived_at', { withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [
    // A name is unique per team among states that are not archived (the same rule as labels).
    uniqueIndex('workflow_state_team_name_unique')
      .on(t.teamId, sql`lower(${t.name})`)
      .where(sql`${t.archivedAt} is null`),
    // Target of the issue's composite foreign key: a state belongs to exactly one team.
    unique('workflow_state_team_id_unique').on(t.teamId, t.id),
    foreignKey({
      name: 'workflow_state_team_fk',
      columns: [t.workspaceId, t.teamId],
      foreignColumns: [team.workspaceId, team.id],
    }).onDelete('cascade'),
  ],
);

/**
 * Priority follows Linear: 0 none, 1 urgent, 2 high, 3 medium, 4 low. `sort_order` is Linear's float (a new issue
 * goes to the top of its state); `parent_id` makes sub-issues of any depth (a cycle is refused by the mutation, under a
 * lock); `started_at`, `completed_at` and `canceled_at` follow the state the issue is in.
 */
export const issue = pgTable(
  'issue',
  {
    id: id(),
    workspaceId: uuid('workspace_id').notNull(),
    teamId: uuid('team_id').notNull(),
    number: integer('number').notNull(),
    title: text('title').notNull(),
    description: text('description').notNull().default(''),
    stateId: uuid('state_id').notNull(),
    priority: smallint('priority').notNull().default(0),
    estimate: smallint('estimate'),
    dueDate: date('due_date', { mode: 'string' }),
    assigneeId: uuid('assignee_id'),
    creatorId: uuid('creator_id').notNull(),
    parentId: uuid('parent_id'),
    sortOrder: doublePrecision('sort_order').notNull().default(0),
    createdAt: createdAt(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    startedAt: timestamp('started_at', { withTimezone: true }),
    completedAt: timestamp('completed_at', { withTimezone: true }),
    canceledAt: timestamp('canceled_at', { withTimezone: true }),
    archivedAt: timestamp('archived_at', { withTimezone: true }),
  },
  (t) => [
    unique('issue_team_number_unique').on(t.teamId, t.number),
    // Targets of the composite foreign keys: the parent (workspace, id) and the join tables (workspace, team, id).
    unique('issue_workspace_id_unique').on(t.workspaceId, t.id),
    unique('issue_workspace_team_id_unique').on(t.workspaceId, t.teamId, t.id),
    index('issue_team_id_idx').on(t.teamId),
    // The updated-after poll and the cursor order walk this index.
    index('issue_workspace_updated_idx').on(t.workspaceId, t.updatedAt, t.id),
    index('issue_parent_idx').on(t.parentId),
    check('issue_priority_range', sql`${t.priority} between 0 and 4`),
    check('issue_estimate_range', sql`${t.estimate} between 0 and 64`),
    check('issue_parent_not_self', sql`${t.parentId} <> ${t.id}`),
    foreignKey({
      name: 'issue_team_fk',
      columns: [t.workspaceId, t.teamId],
      foreignColumns: [team.workspaceId, team.id],
    }),
    foreignKey({
      name: 'issue_state_fk',
      columns: [t.teamId, t.stateId],
      foreignColumns: [workflowState.teamId, workflowState.id],
    }),
    foreignKey({
      name: 'issue_assignee_fk',
      columns: [t.workspaceId, t.assigneeId],
      foreignColumns: [member.workspaceId, member.id],
    }),
    foreignKey({
      name: 'issue_creator_fk',
      columns: [t.workspaceId, t.creatorId],
      foreignColumns: [member.workspaceId, member.id],
    }),
    foreignKey({
      name: 'issue_parent_fk',
      columns: [t.workspaceId, t.parentId],
      foreignColumns: [t.workspaceId, t.id],
    }),
  ],
);

/** A label of the workspace (`team_id` null) or of one team. A group is a label with `is_group`; its children point at it. */
export const label = pgTable(
  'label',
  {
    id: id(),
    workspaceId: uuid('workspace_id').notNull(),
    teamId: uuid('team_id'),
    parentId: uuid('parent_id'),
    name: text('name').notNull(),
    color: text('color').notNull(),
    isGroup: boolean('is_group').notNull().default(false),
    archivedAt: timestamp('archived_at', { withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [
    // Target of the composite foreign keys that point at a label.
    unique('label_workspace_id_unique').on(t.workspaceId, t.id),
    // A name is unique per scope (the workspace, or one team) among labels that are not archived.
    uniqueIndex('label_scope_name_unique')
      .on(
        t.workspaceId,
        sql`coalesce(${t.teamId}, '00000000-0000-0000-0000-000000000000'::uuid)`,
        sql`lower(${t.name})`,
      )
      .where(sql`${t.archivedAt} is null`),
    index('label_team_idx').on(t.teamId),
    check('label_parent_not_self', sql`${t.parentId} <> ${t.id}`),
    foreignKey({
      name: 'label_team_fk',
      columns: [t.workspaceId, t.teamId],
      foreignColumns: [team.workspaceId, team.id],
    }),
    foreignKey({
      name: 'label_parent_fk',
      columns: [t.workspaceId, t.parentId],
      foreignColumns: [t.workspaceId, t.id],
    }),
  ],
);

/** A label on an issue. `team_id` repeats the issue's team (the composite key pins it) so a shape can filter by it. */
export const issueLabel = pgTable(
  'issue_label',
  {
    workspaceId: uuid('workspace_id').notNull(),
    teamId: uuid('team_id').notNull(),
    issueId: uuid('issue_id').notNull(),
    labelId: uuid('label_id').notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.issueId, t.labelId] }),
    index('issue_label_team_idx').on(t.teamId),
    index('issue_label_label_idx').on(t.labelId),
    foreignKey({
      name: 'issue_label_issue_fk',
      columns: [t.workspaceId, t.teamId, t.issueId],
      foreignColumns: [issue.workspaceId, issue.teamId, issue.id],
    }).onDelete('cascade'),
    foreignKey({
      name: 'issue_label_label_fk',
      columns: [t.workspaceId, t.labelId],
      foreignColumns: [label.workspaceId, label.id],
    }).onDelete('cascade'),
  ],
);

/**
 * A relation between two issues, stored once with a direction (`blocks`: issue blocks related issue; `duplicate`: issue
 * duplicates related issue). `related` is symmetric and is stored with the lower id first. Both ends carry their team,
 * so a team's shape can include relations that point into it; the other end may be in another team.
 */
export const issueRelation = pgTable(
  'issue_relation',
  {
    id: id(),
    workspaceId: uuid('workspace_id').notNull(),
    teamId: uuid('team_id').notNull(),
    issueId: uuid('issue_id').notNull(),
    relatedTeamId: uuid('related_team_id').notNull(),
    relatedIssueId: uuid('related_issue_id').notNull(),
    type: issueRelationType('type').notNull(),
    createdBy: uuid('created_by').notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    unique('issue_relation_unique').on(t.issueId, t.relatedIssueId, t.type),
    // `related` and `duplicate` hold between two issues whichever end they were added from: one row per pair and type.
    uniqueIndex('issue_relation_pair_unique')
      .on(
        sql`least(${t.issueId}, ${t.relatedIssueId})`,
        sql`greatest(${t.issueId}, ${t.relatedIssueId})`,
        t.type,
      )
      .where(sql`${t.type} in ('related', 'duplicate')`),
    index('issue_relation_team_idx').on(t.teamId),
    index('issue_relation_related_idx').on(t.relatedTeamId, t.relatedIssueId),
    check('issue_relation_not_self', sql`${t.issueId} <> ${t.relatedIssueId}`),
    foreignKey({
      name: 'issue_relation_issue_fk',
      columns: [t.workspaceId, t.teamId, t.issueId],
      foreignColumns: [issue.workspaceId, issue.teamId, issue.id],
    }).onDelete('cascade'),
    foreignKey({
      name: 'issue_relation_related_fk',
      columns: [t.workspaceId, t.relatedTeamId, t.relatedIssueId],
      foreignColumns: [issue.workspaceId, issue.teamId, issue.id],
    }).onDelete('cascade'),
    foreignKey({
      name: 'issue_relation_created_by_fk',
      columns: [t.workspaceId, t.createdBy],
      foreignColumns: [member.workspaceId, member.id],
    }),
  ],
);

export const issueSubscriber = pgTable(
  'issue_subscriber',
  {
    workspaceId: uuid('workspace_id').notNull(),
    teamId: uuid('team_id').notNull(),
    issueId: uuid('issue_id').notNull(),
    memberId: uuid('member_id').notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    primaryKey({ columns: [t.issueId, t.memberId] }),
    index('issue_subscriber_team_idx').on(t.teamId),
    foreignKey({
      name: 'issue_subscriber_issue_fk',
      columns: [t.workspaceId, t.teamId, t.issueId],
      foreignColumns: [issue.workspaceId, issue.teamId, issue.id],
    }).onDelete('cascade'),
    foreignKey({
      name: 'issue_subscriber_member_fk',
      columns: [t.workspaceId, t.memberId],
      foreignColumns: [member.workspaceId, member.id],
    }).onDelete('cascade'),
  ],
);

/** An external link on an issue. Only http and https are stored; the page that renders it never sees another scheme. */
export const issueLink = pgTable(
  'issue_link',
  {
    id: id(),
    workspaceId: uuid('workspace_id').notNull(),
    teamId: uuid('team_id').notNull(),
    issueId: uuid('issue_id').notNull(),
    url: text('url').notNull(),
    title: text('title'),
    createdBy: uuid('created_by').notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    index('issue_link_team_idx').on(t.teamId),
    index('issue_link_issue_idx').on(t.issueId),
    check('issue_link_url_scheme', sql`${t.url} ~ '^https?://'`),
    foreignKey({
      name: 'issue_link_issue_fk',
      columns: [t.workspaceId, t.teamId, t.issueId],
      foreignColumns: [issue.workspaceId, issue.teamId, issue.id],
    }).onDelete('cascade'),
    foreignKey({
      name: 'issue_link_created_by_fk',
      columns: [t.workspaceId, t.createdBy],
      foreignColumns: [member.workspaceId, member.id],
    }),
  ],
);

export const loginToken = pgTable(
  'login_token',
  {
    id: id(),
    workspaceId: uuid('workspace_id').notNull(),
    memberId: uuid('member_id').notNull(),
    tokenHash: text('token_hash').notNull(),
    createdAt: createdAt(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    usedAt: timestamp('used_at', { withTimezone: true }),
  },
  (t) => [
    index('login_token_token_hash_idx').on(t.tokenHash),
    foreignKey({
      name: 'login_token_member_fk',
      columns: [t.workspaceId, t.memberId],
      foreignColumns: [member.workspaceId, member.id],
    }).onDelete('cascade'),
  ],
);

export const session = pgTable(
  'session',
  {
    id: id(),
    workspaceId: uuid('workspace_id').notNull(),
    memberId: uuid('member_id').notNull(),
    tokenHash: text('token_hash').notNull(),
    createdAt: createdAt(),
    lastSeenAt: timestamp('last_seen_at', { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    userAgent: text('user_agent'),
  },
  (t) => [
    index('session_token_hash_workspace_idx').on(t.tokenHash, t.workspaceId),
    foreignKey({
      name: 'session_member_fk',
      columns: [t.workspaceId, t.memberId],
      foreignColumns: [member.workspaceId, member.id],
    }).onDelete('cascade'),
  ],
);

/**
 * A pending, accepted or revoked invitation. Only the SHA-256 of the link token is stored. One pending invite per
 * email per workspace (the partial unique index); a revoked or accepted one frees the email again.
 */
export const invite = pgTable(
  'invite',
  {
    id: id(),
    workspaceId: uuid('workspace_id').notNull(),
    email: text('email').notNull(),
    role: memberRole('role').notNull(),
    locale: locale('locale').notNull().default('en'),
    tokenHash: text('token_hash').notNull(),
    invitedBy: uuid('invited_by').notNull(),
    createdAt: createdAt(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    acceptedAt: timestamp('accepted_at', { withTimezone: true }),
    acceptedMemberId: uuid('accepted_member_id'),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
  },
  (t) => [
    // Target of invite_team's composite foreign key.
    unique('invite_workspace_id_unique').on(t.workspaceId, t.id),
    index('invite_token_hash_idx').on(t.tokenHash),
    uniqueIndex('invite_pending_email_unique')
      .on(t.workspaceId, t.email)
      .where(sql`${t.acceptedAt} is null and ${t.revokedAt} is null`),
    check('invite_email_normalised', sql`${t.email} = lower(btrim(${t.email}))`),
    foreignKey({
      name: 'invite_invited_by_fk',
      columns: [t.workspaceId, t.invitedBy],
      foreignColumns: [member.workspaceId, member.id],
    }),
    foreignKey({
      name: 'invite_accepted_member_fk',
      columns: [t.workspaceId, t.acceptedMemberId],
      foreignColumns: [member.workspaceId, member.id],
    }),
  ],
);

/** The teams an invited person joins on acceptance. */
export const inviteTeam = pgTable(
  'invite_team',
  {
    workspaceId: uuid('workspace_id').notNull(),
    inviteId: uuid('invite_id').notNull(),
    teamId: uuid('team_id').notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.inviteId, t.teamId] }),
    foreignKey({
      name: 'invite_team_invite_fk',
      columns: [t.workspaceId, t.inviteId],
      foreignColumns: [invite.workspaceId, invite.id],
    }).onDelete('cascade'),
    foreignKey({
      name: 'invite_team_team_fk',
      columns: [t.workspaceId, t.teamId],
      foreignColumns: [team.workspaceId, team.id],
    }).onDelete('cascade'),
  ],
);

/**
 * Admin actions, one row each, written in the same transaction as the action. `actor_member_id` is null for a
 * system action. Metadata holds scalars only (ids, roles, counts); the action and target type are one of
 * `AUDIT_ACTIONS` and `AUDIT_TARGET_TYPES`, enforced by `recordAudit`.
 */
export const auditLog = pgTable(
  'audit_log',
  {
    id: id(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspace.id),
    actorMemberId: uuid('actor_member_id'),
    action: text('action').notNull(),
    targetType: text('target_type').notNull(),
    targetId: uuid('target_id'),
    metadata: jsonb('metadata')
      .$type<Record<string, string | number | boolean | null>>()
      .notNull()
      .default({}),
    createdAt: createdAt(),
  },
  (t) => [
    // NULLS FIRST is what `order by created_at desc` asks for, so the newest-first read uses this index.
    index('audit_log_workspace_created_idx').on(t.workspaceId, t.createdAt.desc().nullsFirst()),
    foreignKey({
      name: 'audit_log_actor_fk',
      columns: [t.workspaceId, t.actorMemberId],
      foreignColumns: [member.workspaceId, member.id],
    }),
  ],
);

/**
 * One row per changed field of an issue (and one per label, relation, subscriber or link change): who, through which
 * client, what. A description change keeps `field = 'description'` and no values: text history is not kept in P1.
 * `actor_id` is null for a system change.
 */
export const issueActivity = pgTable(
  'issue_activity',
  {
    id: id(),
    workspaceId: uuid('workspace_id').notNull(),
    teamId: uuid('team_id').notNull(),
    issueId: uuid('issue_id').notNull(),
    actorId: uuid('actor_id'),
    client: activityClient('client').notNull(),
    type: text('type').notNull(),
    field: text('field'),
    fromValue: jsonb('from_value'),
    toValue: jsonb('to_value'),
    createdAt: createdAt(),
  },
  (t) => [
    index('issue_activity_issue_created_idx').on(t.issueId, t.createdAt),
    foreignKey({
      name: 'issue_activity_issue_fk',
      columns: [t.workspaceId, t.teamId, t.issueId],
      foreignColumns: [issue.workspaceId, issue.teamId, issue.id],
    }).onDelete('cascade'),
    foreignKey({
      name: 'issue_activity_actor_fk',
      columns: [t.workspaceId, t.actorId],
      foreignColumns: [member.workspaceId, member.id],
    }),
  ],
);

/**
 * The transactional outbox (spec section 11): every state change writes its event in the same transaction. Never synced;
 * delivery and the pull API come later. `subject_id` is polymorphic (no foreign key); the envelope is built on read.
 */
export const event = pgTable(
  'event',
  {
    id: id(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspace.id),
    teamId: uuid('team_id'),
    type: text('type').notNull(),
    version: smallint('version').notNull(),
    occurredAt: timestamp('occurred_at', { withTimezone: true }).notNull().defaultNow(),
    actorId: uuid('actor_id'),
    client: activityClient('client').notNull(),
    subjectType: text('subject_type').notNull(),
    subjectId: uuid('subject_id').notNull(),
    data: jsonb('data').$type<Record<string, unknown>>().notNull().default({}),
  },
  (t) => [
    index('event_workspace_occurred_idx').on(t.workspaceId, t.occurredAt, t.id),
    foreignKey({
      name: 'event_team_fk',
      columns: [t.workspaceId, t.teamId],
      foreignColumns: [team.workspaceId, team.id],
    }),
    foreignKey({
      name: 'event_actor_fk',
      columns: [t.workspaceId, t.actorId],
      foreignColumns: [member.workspaceId, member.id],
    }),
  ],
);

/**
 * A (source, external id, url) triple on any object, for idempotent imports and links back. An external id is used once
 * per source in a workspace, and a subject has one reference per source. `source` is a lower-case slug.
 */
export const externalRef = pgTable(
  'external_ref',
  {
    id: id(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspace.id),
    subjectType: text('subject_type').notNull(),
    subjectId: uuid('subject_id').notNull(),
    source: text('source').notNull(),
    externalId: text('external_id').notNull(),
    url: text('url'),
    createdAt: createdAt(),
  },
  (t) => [
    unique('external_ref_source_id_unique').on(t.workspaceId, t.source, t.externalId),
    unique('external_ref_subject_source_unique').on(
      t.workspaceId,
      t.subjectType,
      t.subjectId,
      t.source,
    ),
    check('external_ref_source_format', sql`${t.source} ~ '^[a-z0-9][a-z0-9._-]{0,63}$'`),
    check('external_ref_url_scheme', sql`${t.url} is null or ${t.url} ~ '^https?://'`),
  ],
);

/**
 * The stored answer of a create that carried an `Idempotency-Key`: the same actor and key with the same request body
 * gets this response again. Rows older than 24 hours are removed (`cleanupExpiredRows`).
 */
export const idempotencyKey = pgTable(
  'idempotency_key',
  {
    workspaceId: uuid('workspace_id').notNull(),
    actorId: uuid('actor_id').notNull(),
    key: text('key').notNull(),
    requestHash: text('request_hash').notNull(),
    status: smallint('status').notNull(),
    response: jsonb('response').notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    primaryKey({ columns: [t.workspaceId, t.actorId, t.key] }),
    index('idempotency_key_created_idx').on(t.createdAt),
    check('idempotency_key_length', sql`char_length(${t.key}) between 1 and 128`),
    foreignKey({
      name: 'idempotency_key_actor_fk',
      columns: [t.workspaceId, t.actorId],
      foreignColumns: [member.workspaceId, member.id],
    }).onDelete('cascade'),
  ],
);

/** Saved filters and display options, personal or shared. Table only: the logic arrives with the issue views. */
export const savedView = pgTable(
  'saved_view',
  {
    id: id(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspace.id),
    teamId: uuid('team_id'),
    ownerId: uuid('owner_id'),
    name: text('name').notNull(),
    filters: jsonb('filters').$type<Record<string, unknown>>().notNull().default({}),
    display: jsonb('display').$type<Record<string, unknown>>().notNull().default({}),
    shared: boolean('shared').notNull().default(false),
    createdAt: createdAt(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    foreignKey({
      name: 'saved_view_team_fk',
      columns: [t.workspaceId, t.teamId],
      foreignColumns: [team.workspaceId, team.id],
    }),
    foreignKey({
      name: 'saved_view_owner_fk',
      columns: [t.workspaceId, t.ownerId],
      foreignColumns: [member.workspaceId, member.id],
    }),
  ],
);

/** Pre-filled issue fields a person starts from. Table only: the logic arrives with the issue creation form. */
export const issueTemplate = pgTable(
  'issue_template',
  {
    id: id(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspace.id),
    teamId: uuid('team_id'),
    name: text('name').notNull(),
    fields: jsonb('fields').$type<Record<string, unknown>>().notNull().default({}),
    createdAt: createdAt(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    foreignKey({
      name: 'issue_template_team_fk',
      columns: [t.workspaceId, t.teamId],
      foreignColumns: [team.workspaceId, team.id],
    }),
  ],
);

export type WorkspaceRow = typeof workspace.$inferSelect;
export type MemberRow = typeof member.$inferSelect;
export type TeamRow = typeof team.$inferSelect;
export type TeamMemberRow = typeof teamMember.$inferSelect;
export type WorkflowStateRow = typeof workflowState.$inferSelect;
export type IssueRow = typeof issue.$inferSelect;
export type LabelRow = typeof label.$inferSelect;
export type IssueLabelRow = typeof issueLabel.$inferSelect;
export type IssueRelationRow = typeof issueRelation.$inferSelect;
export type IssueSubscriberRow = typeof issueSubscriber.$inferSelect;
export type IssueLinkRow = typeof issueLink.$inferSelect;
export type IssueActivityRow = typeof issueActivity.$inferSelect;
export type EventRow = typeof event.$inferSelect;
export type ExternalRefRow = typeof externalRef.$inferSelect;
export type IdempotencyKeyRow = typeof idempotencyKey.$inferSelect;
export type SavedViewRow = typeof savedView.$inferSelect;
export type IssueTemplateRow = typeof issueTemplate.$inferSelect;
export type LoginTokenRow = typeof loginToken.$inferSelect;
export type SessionRow = typeof session.$inferSelect;
export type InviteRow = typeof invite.$inferSelect;
export type InviteTeamRow = typeof inviteTeam.$inferSelect;
export type AuditLogRow = typeof auditLog.$inferSelect;
