// Core tables (spec §6). Every table carries `workspace_id`; foreign keys between workspace-scoped
// tables are composite `(workspace_id, x_id)` (and `(team_id, state_id)` for workflow states), so a row
// can never point at another workspace's or another team's data, whatever the application code does.
import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
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

import { MEMBER_LOCALES, MEMBER_ROLES } from './enums.ts';

export { MEMBER_LOCALES, MEMBER_ROLES, type MemberLocale, type MemberRole } from './enums.ts';

export const WORKFLOW_STATE_TYPES = [
  'triage',
  'backlog',
  'unstarted',
  'started',
  'completed',
  'canceled',
] as const;
export type WorkflowStateType = (typeof WORKFLOW_STATE_TYPES)[number];

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
] as const;
export type AuditAction = (typeof AUDIT_ACTIONS)[number];

export const AUDIT_TARGET_TYPES = ['member', 'invite', 'team', 'team_member'] as const;
export type AuditTargetType = (typeof AUDIT_TARGET_TYPES)[number];

export const memberRole = pgEnum('member_role', MEMBER_ROLES);
export const locale = pgEnum('locale', MEMBER_LOCALES);
export const workflowStateType = pgEnum('workflow_state_type', WORKFLOW_STATE_TYPES);

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
    createdAt: createdAt(),
  },
  (t) => [
    unique('workflow_state_team_name_unique').on(t.teamId, t.name),
    // Target of the issue's composite foreign key: a state belongs to exactly one team.
    unique('workflow_state_team_id_unique').on(t.teamId, t.id),
    foreignKey({
      name: 'workflow_state_team_fk',
      columns: [t.workspaceId, t.teamId],
      foreignColumns: [team.workspaceId, team.id],
    }).onDelete('cascade'),
  ],
);

/** Priority follows Linear: 0 none, 1 urgent, 2 high, 3 medium, 4 low. */
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
    assigneeId: uuid('assignee_id'),
    creatorId: uuid('creator_id').notNull(),
    createdAt: createdAt(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    archivedAt: timestamp('archived_at', { withTimezone: true }),
  },
  (t) => [
    unique('issue_team_number_unique').on(t.teamId, t.number),
    index('issue_team_id_idx').on(t.teamId),
    check('issue_priority_range', sql`${t.priority} between 0 and 4`),
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

export type WorkspaceRow = typeof workspace.$inferSelect;
export type MemberRow = typeof member.$inferSelect;
export type TeamRow = typeof team.$inferSelect;
export type TeamMemberRow = typeof teamMember.$inferSelect;
export type WorkflowStateRow = typeof workflowState.$inferSelect;
export type IssueRow = typeof issue.$inferSelect;
export type LoginTokenRow = typeof loginToken.$inferSelect;
export type SessionRow = typeof session.$inferSelect;
export type InviteRow = typeof invite.$inferSelect;
export type InviteTeamRow = typeof inviteTeam.$inferSelect;
export type AuditLogRow = typeof auditLog.$inferSelect;
