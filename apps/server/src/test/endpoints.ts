// Every authenticated endpoint of the API as test data (one case per route and per variant that changes who is
// allowed), and the world those cases are called in: two workspaces, a fresh actor per attempt and fresh targets, so
// attempts that change state (deactivate, delete, revoke, add oneself to a team) never disturb each other.
// The cross-workspace tests and the HTTP rows of the permission matrix both read this file. A new route needs a case
// here, or the coverage test in `cross-workspace.test.ts` fails.
import {
  attachment,
  comment,
  document,
  invite,
  issue,
  issueLink,
  issueRelation,
  label,
  member,
  team,
  teamMember,
  workflowState,
} from '@torch/shared/db/schema';
import { defaultWorkflowStates } from '@torch/shared/db/workflow-defaults';
import type { Role } from '@torch/shared/permissions';
import { eq } from 'drizzle-orm';
import { type App, createApp } from '../app.ts';
import { createSessionActorResolver } from '../auth/resolver.ts';
import { generateToken, hashToken } from '../auth/tokens.ts';
import type { Db, Orm } from '../db.ts';
import { createFakeStorage, type FakeStorage } from '../files/fake-storage.ts';
import { stagingKeyOf } from '../files/keys.ts';
import { createIssue } from '../issues/create-issue.ts';
import { createMemoryMailer } from '../mail/mailer.ts';
import { loadClientActor } from '../permissions/load-actor.ts';
import { openSession } from './admin-helpers.ts';
import { testBrand } from './auth-app.ts';
import { addMember, createWorkspaceFixture } from './fixtures.ts';

// ---- the endpoint table ----

/**
 * The ids one attempt calls an endpoint with. `workspaceId` is the workspace in the URL; the targets are real rows of
 * that workspace, created fresh for the attempt when a case uses them (see `idsUsedBy`), so no other attempt has
 * touched them.
 */
export type Ids = {
  workspaceId: string;
  /** The member who makes the call. */
  selfId: string;
  /** Unique per attempt: part of a team key or an email address that no other attempt may use. */
  uid: string;
  /** A public team every role belongs to. */
  teamId: string;
  /** A private team: the owner and the member belong to it, the admin and the guest do not. */
  privateTeamId: string;
  /** A public team whose only member is the owner: the admin and the member see it, the guest does not. */
  ownerOnlyTeamId: string;
  /** One issue of each of those teams, in the same order. */
  issueId: string;
  privateIssueId: string;
  ownerOnlyIssueId: string;
  /**
   * A second issue of each of those teams, new for the attempt (a relation between two issues exists once), and a
   * relation and a link on the first issue of each, also new for the attempt.
   */
  peerIssueId: string;
  privatePeerIssueId: string;
  ownerOnlyPeerIssueId: string;
  relationId: string;
  privateRelationId: string;
  ownerOnlyRelationId: string;
  linkId: string;
  privateLinkId: string;
  ownerOnlyLinkId: string;
  /** A label of each of the three teams and one of the workspace, and a started workflow state of each team: all new for the attempt. */
  labelId: string;
  privateLabelId: string;
  ownerOnlyLabelId: string;
  workspaceLabelId: string;
  stateId: string;
  privateStateId: string;
  ownerOnlyStateId: string;
  /**
   * A comment on the first issue of the public team: one written by the member who makes the call, and one written by
   * somebody else (the workspace owner). Both new for the attempt.
   */
  commentId: string;
  otherCommentId: string;
  /**
   * Files of each team, on an issue of their own that is new for the attempt (so they never pile up on the shared
   * issue): a pending upload of the member who makes the call, with its object in place and ready to complete, and a
   * ready file of the same member. `otherFileId` is a ready file of the public team uploaded by the workspace owner.
   */
  attachmentId: string;
  privateAttachmentId: string;
  ownerOnlyAttachmentId: string;
  fileId: string;
  privateFileId: string;
  ownerOnlyFileId: string;
  otherFileId: string;
  /** A document of each team, new for the attempt. */
  documentId: string;
  privateDocumentId: string;
  ownerOnlyDocumentId: string;
  /** A member (role `member`) who belongs to all three teams. */
  memberId: string;
  /** A member (role `member`) who belongs to no team. */
  newcomerId: string;
  /** An active admin. */
  adminId: string;
  /** A deactivated member and a deactivated admin. */
  deactivatedId: string;
  deactivatedAdminId: string;
  /** A pending invite for the role `member`, and one for the role `admin`. */
  inviteId: string;
  adminInviteId: string;
};

export type EndpointCase = {
  /** Unique; the key of the hand-written rows in `matrix.test.ts`. */
  name: string;
  method: string;
  /** The URL path. Called with placeholder ids it gives the route pattern the server registers. */
  path(ids: Ids): string;
  /** The JSON body; a function is called with the ids of the attempt (a team key, an email, a target). */
  body?: unknown;
  /**
   * The lowest role that may do this, in the order guest < member < admin < owner; `none` when nobody may (changing
   * one's own role). Roles below it are refused with 403, or with 404 when the object is invisible to them.
   */
  minRole: Role | 'none';
  /** Roles below `minRole` that succeed anyway: the members of a private team. */
  alsoAllowed?: readonly Role[];
};

type Rule = Pick<EndpointCase, 'minRole' | 'alsoAllowed'>;

const RANK: Record<Role, number> = { guest: 0, member: 1, admin: 2, owner: 3 };
export const ROLES: readonly Role[] = ['guest', 'member', 'admin', 'owner'];

/** Should `role` succeed on `c`, by the case's own `minRole` and `alsoAllowed`? */
export function succeeds(c: EndpointCase, role: Role): boolean {
  if (c.alsoAllowed?.includes(role)) return true;
  return c.minRole !== 'none' && RANK[role] >= RANK[c.minRole];
}

/** The body of a case for these ids. */
export function bodyOf(c: EndpointCase, ids: Ids): unknown {
  return typeof c.body === 'function' ? c.body(ids) : c.body;
}

/**
 * Names that `path` and `body` return as route parameters, so `c.path(PLACEHOLDER_IDS)` is the pattern the app
 * registers (`/api/w/:workspaceId/teams/:teamId/members`). Parameter names must match the route definitions.
 */
export const PLACEHOLDER_IDS: Ids = {
  workspaceId: ':workspaceId',
  selfId: ':memberId',
  uid: 'UID',
  teamId: ':teamId',
  privateTeamId: ':teamId',
  ownerOnlyTeamId: ':teamId',
  issueId: ':issueId',
  privateIssueId: ':issueId',
  ownerOnlyIssueId: ':issueId',
  peerIssueId: 'PEER',
  privatePeerIssueId: 'PEER',
  ownerOnlyPeerIssueId: 'PEER',
  relationId: ':relationId',
  privateRelationId: ':relationId',
  ownerOnlyRelationId: ':relationId',
  linkId: ':linkId',
  privateLinkId: ':linkId',
  ownerOnlyLinkId: ':linkId',
  labelId: ':labelId',
  privateLabelId: ':labelId',
  ownerOnlyLabelId: ':labelId',
  workspaceLabelId: ':labelId',
  commentId: ':commentId',
  otherCommentId: ':commentId',
  attachmentId: ':attachmentId',
  privateAttachmentId: ':attachmentId',
  ownerOnlyAttachmentId: ':attachmentId',
  fileId: ':attachmentId',
  privateFileId: ':attachmentId',
  ownerOnlyFileId: ':attachmentId',
  otherFileId: ':attachmentId',
  documentId: ':documentId',
  privateDocumentId: ':documentId',
  ownerOnlyDocumentId: ':documentId',
  stateId: ':stateId',
  privateStateId: ':stateId',
  ownerOnlyStateId: ':stateId',
  memberId: ':memberId',
  newcomerId: ':memberId',
  adminId: ':memberId',
  deactivatedId: ':memberId',
  deactivatedAdminId: ':memberId',
  inviteId: ':inviteId',
  adminInviteId: ':inviteId',
};

/** `METHOD /route/pattern`, the form `listRoutes` entries are compared in. */
export const patternOf = (c: EndpointCase) => `${c.method} ${c.path(PLACEHOLDER_IDS)}`;

/** The ids a case reads, found by calling it with a recording copy of the placeholders. */
export function idsUsedBy(c: EndpointCase): Set<keyof Ids> {
  const used = new Set<keyof Ids>();
  const probe = new Proxy(PLACEHOLDER_IDS, {
    get(target, key, receiver) {
      if (typeof key === 'string') used.add(key as keyof Ids);
      return Reflect.get(target, key, receiver);
    },
  });
  c.path(probe);
  bodyOf(c, probe);
  return used;
}

const api = (ids: Ids) => `/api/w/${ids.workspaceId}`;
const sync = (ids: Ids) => `/api/sync/w/${ids.workspaceId}`;
/** The emoji segment of a reaction URL: the route parameter in the pattern, a real (URL-encoded) emoji in a request. */
const emojiSegment = (ids: Ids) =>
  ids.workspaceId === PLACEHOLDER_IDS.workspaceId ? ':emoji' : encodeURIComponent('👍');

type TeamKey = 'teamId' | 'privateTeamId' | 'ownerOnlyTeamId';
type IssueKey = 'issueId' | 'privateIssueId' | 'ownerOnlyIssueId';
type PeerKey = 'peerIssueId' | 'privatePeerIssueId' | 'ownerOnlyPeerIssueId';
type RelationKey = 'relationId' | 'privateRelationId' | 'ownerOnlyRelationId';
type LinkKey = 'linkId' | 'privateLinkId' | 'ownerOnlyLinkId';
type LabelKey = 'labelId' | 'privateLabelId' | 'ownerOnlyLabelId';
type StateKey = 'stateId' | 'privateStateId' | 'ownerOnlyStateId';
type AttachmentKey = 'attachmentId' | 'privateAttachmentId' | 'ownerOnlyAttachmentId';
type FileKey = 'fileId' | 'privateFileId' | 'ownerOnlyFileId';
type DocumentKey = 'documentId' | 'privateDocumentId' | 'ownerOnlyDocumentId';

/**
 * The three teams of a world with who may see (and edit the issues of) each and who may manage it, as the rules say:
 * a team is visible to everybody but a guest who is not in it, a private team only to its members (an owner or admin
 * who is not in it sees only the directory), and only an owner or admin manages a team they can see.
 */
const TEAMS: readonly {
  team: TeamKey;
  issue: IssueKey;
  peer: PeerKey;
  relation: RelationKey;
  link: LinkKey;
  teamLabel: LabelKey;
  state: StateKey;
  attachment: AttachmentKey;
  file: FileKey;
  document: DocumentKey;
  label: string;
  see: Rule;
  manage: Rule;
  /** Who may define a label of the team: anybody but a guest who sees the team. */
  defineLabel: Rule;
  /** Who may create, edit and archive the team's documents: anybody but a guest who sees the team. */
  editDocuments: Rule;
}[] = [
  {
    team: 'teamId',
    issue: 'issueId',
    peer: 'peerIssueId',
    relation: 'relationId',
    link: 'linkId',
    teamLabel: 'labelId',
    state: 'stateId',
    attachment: 'attachmentId',
    file: 'fileId',
    document: 'documentId',
    label: 'public team',
    see: { minRole: 'guest' },
    manage: { minRole: 'admin' },
    defineLabel: { minRole: 'member' },
    editDocuments: { minRole: 'member' },
  },
  {
    team: 'privateTeamId',
    issue: 'privateIssueId',
    peer: 'privatePeerIssueId',
    relation: 'privateRelationId',
    link: 'privateLinkId',
    teamLabel: 'privateLabelId',
    state: 'privateStateId',
    attachment: 'privateAttachmentId',
    file: 'privateFileId',
    document: 'privateDocumentId',
    label: 'private team',
    see: { minRole: 'owner', alsoAllowed: ['member'] },
    manage: { minRole: 'owner' },
    defineLabel: { minRole: 'owner', alsoAllowed: ['member'] },
    editDocuments: { minRole: 'owner', alsoAllowed: ['member'] },
  },
  {
    team: 'ownerOnlyTeamId',
    issue: 'ownerOnlyIssueId',
    peer: 'ownerOnlyPeerIssueId',
    relation: 'ownerOnlyRelationId',
    link: 'ownerOnlyLinkId',
    teamLabel: 'ownerOnlyLabelId',
    state: 'ownerOnlyStateId',
    attachment: 'ownerOnlyAttachmentId',
    file: 'ownerOnlyFileId',
    document: 'ownerOnlyDocumentId',
    label: 'public team with the owner only',
    see: { minRole: 'member' },
    manage: { minRole: 'admin' },
    defineLabel: { minRole: 'member' },
    editDocuments: { minRole: 'member' },
  },
];

/** Every authenticated route under `/api/w` and `/api/sync/w`. A new route appends its cases here. */
export const ENDPOINTS: EndpointCase[] = [
  // ---- members and the caller's own profile ----
  { name: 'members: list', method: 'GET', path: (ids) => `${api(ids)}/members`, minRole: 'admin' },
  {
    name: 'members: change role, member to guest',
    method: 'PATCH',
    path: (ids) => `${api(ids)}/members/${ids.memberId}`,
    body: { role: 'guest' },
    minRole: 'admin',
  },
  {
    name: 'members: change role, member to admin',
    method: 'PATCH',
    path: (ids) => `${api(ids)}/members/${ids.memberId}`,
    body: { role: 'admin' },
    minRole: 'owner',
  },
  {
    name: 'members: change role, admin to member',
    method: 'PATCH',
    path: (ids) => `${api(ids)}/members/${ids.adminId}`,
    body: { role: 'member' },
    minRole: 'owner',
  },
  {
    name: 'members: change own role',
    method: 'PATCH',
    path: (ids) => `${api(ids)}/members/${ids.selfId}`,
    body: { role: 'member' },
    minRole: 'none',
  },
  {
    name: 'members: deactivate a member',
    method: 'POST',
    path: (ids) => `${api(ids)}/members/${ids.memberId}/deactivate`,
    minRole: 'admin',
  },
  {
    name: 'members: deactivate an admin',
    method: 'POST',
    path: (ids) => `${api(ids)}/members/${ids.adminId}/deactivate`,
    minRole: 'owner',
  },
  {
    name: 'members: deactivate oneself',
    method: 'POST',
    path: (ids) => `${api(ids)}/members/${ids.selfId}/deactivate`,
    minRole: 'none',
  },
  {
    name: 'members: reactivate a member',
    method: 'POST',
    path: (ids) => `${api(ids)}/members/${ids.deactivatedId}/reactivate`,
    minRole: 'admin',
  },
  {
    name: 'members: reactivate an admin',
    method: 'POST',
    path: (ids) => `${api(ids)}/members/${ids.deactivatedAdminId}/reactivate`,
    minRole: 'owner',
  },
  {
    name: 'profile: edit own profile',
    method: 'PATCH',
    path: (ids) => `${api(ids)}/me`,
    body: { name: 'New Name' },
    minRole: 'guest',
  },

  // ---- teams: create, edit, the people of a team, the private-team directory ----
  {
    name: 'teams: create',
    method: 'POST',
    path: (ids) => `${api(ids)}/teams`,
    body: (ids: Ids) => ({ key: `T${ids.uid}`, name: 'Created team' }),
    minRole: 'admin',
  },
  ...TEAMS.flatMap(({ team: key, label, manage }): EndpointCase[] => [
    {
      name: `teams: rename (${label})`,
      method: 'PATCH',
      path: (ids) => `${api(ids)}/teams/${ids[key]}`,
      body: { name: 'Renamed team' },
      ...manage,
    },
    {
      name: `teams: add a member (${label})`,
      method: 'POST',
      path: (ids) => `${api(ids)}/teams/${ids[key]}/members`,
      body: (ids: Ids) => ({ memberId: ids.newcomerId }),
      ...manage,
    },
    {
      name: `teams: remove a member (${label})`,
      method: 'DELETE',
      path: (ids) => `${api(ids)}/teams/${ids[key]}/members/${ids.memberId}`,
      ...manage,
    },
  ]),
  {
    // An owner or admin may join any team of the workspace, a private one they cannot see included.
    name: 'teams: add oneself (private team)',
    method: 'POST',
    path: (ids) => `${api(ids)}/teams/${ids.privateTeamId}/members`,
    body: (ids: Ids) => ({ memberId: ids.selfId }),
    minRole: 'admin',
  },
  {
    name: 'teams: private team directory',
    method: 'GET',
    path: (ids) => `${api(ids)}/admin/teams`,
    minRole: 'admin',
  },

  // ---- invites ----
  { name: 'invites: list', method: 'GET', path: (ids) => `${api(ids)}/invites`, minRole: 'admin' },
  {
    name: 'invites: create (member role)',
    method: 'POST',
    path: (ids) => `${api(ids)}/invites`,
    body: (ids: Ids) => ({
      email: `invitee-${ids.uid.toLowerCase()}@example.test`,
      role: 'member',
      teamIds: [],
    }),
    minRole: 'admin',
  },
  {
    name: 'invites: create (guest role, into a public team)',
    method: 'POST',
    path: (ids) => `${api(ids)}/invites`,
    body: (ids: Ids) => ({
      email: `invitee-${ids.uid.toLowerCase()}@example.test`,
      role: 'guest',
      teamIds: [ids.teamId],
    }),
    minRole: 'admin',
  },
  {
    name: 'invites: create (admin role)',
    method: 'POST',
    path: (ids) => `${api(ids)}/invites`,
    body: (ids: Ids) => ({
      email: `invitee-${ids.uid.toLowerCase()}@example.test`,
      role: 'admin',
      teamIds: [],
    }),
    minRole: 'owner',
  },
  {
    name: 'invites: create (member role, into a private team)',
    method: 'POST',
    path: (ids) => `${api(ids)}/invites`,
    body: (ids: Ids) => ({
      email: `invitee-${ids.uid.toLowerCase()}@example.test`,
      role: 'member',
      teamIds: [ids.privateTeamId],
    }),
    minRole: 'owner',
  },
  {
    name: 'invites: resend (member role)',
    method: 'POST',
    path: (ids) => `${api(ids)}/invites/${ids.inviteId}/resend`,
    minRole: 'admin',
  },
  {
    name: 'invites: resend (admin role)',
    method: 'POST',
    path: (ids) => `${api(ids)}/invites/${ids.adminInviteId}/resend`,
    minRole: 'owner',
  },
  {
    name: 'invites: revoke (member role)',
    method: 'DELETE',
    path: (ids) => `${api(ids)}/invites/${ids.inviteId}`,
    minRole: 'admin',
  },
  {
    name: 'invites: revoke (admin role)',
    method: 'DELETE',
    path: (ids) => `${api(ids)}/invites/${ids.adminInviteId}`,
    minRole: 'owner',
  },

  // ---- the issue mutation ----
  { name: 'issues: list', method: 'GET', path: (ids) => `${api(ids)}/issues`, minRole: 'guest' },
  ...TEAMS.map(
    ({ issue: key, label, see }): EndpointCase => ({
      name: `issues: update (${label})`,
      method: 'PATCH',
      path: (ids) => `${api(ids)}/issues/${ids[key]}`,
      body: { title: 'Edited title' },
      ...see,
    }),
  ),

  ...TEAMS.flatMap(({ issue: key, label, see }): EndpointCase[] =>
    (['archive', 'unarchive'] as const).map((action) => ({
      name: `issues: ${action} (${label})`,
      method: 'POST',
      path: (ids) => `${api(ids)}/issues/${ids[key]}/${action}`,
      ...see,
    })),
  ),

  ...TEAMS.map(
    ({ team: key, label, see }): EndpointCase => ({
      name: `issues: create (${label})`,
      method: 'POST',
      path: (ids) => `${api(ids)}/issues`,
      body: (ids: Ids) => ({ teamId: ids[key], title: `Created ${ids.uid}` }),
      ...see,
    }),
  ),

  // ---- relations, subscribers and links: they follow the issue's team ----
  ...TEAMS.flatMap(({ issue: key, peer, relation, link, label, see }): EndpointCase[] => [
    {
      name: `issues: list relations (${label})`,
      method: 'GET',
      path: (ids) => `${api(ids)}/issues/${ids[key]}/relations`,
      ...see,
    },
    {
      name: `issues: add relation (${label})`,
      method: 'POST',
      path: (ids) => `${api(ids)}/issues/${ids[key]}/relations`,
      body: (ids: Ids) => ({ relatedIssueId: ids[peer], type: 'blocks' }),
      ...see,
    },
    {
      name: `issues: remove relation (${label})`,
      method: 'DELETE',
      path: (ids) => `${api(ids)}/issues/${ids[key]}/relations/${ids[relation]}`,
      ...see,
    },
    {
      name: `issues: subscribe (${label})`,
      method: 'PUT',
      path: (ids) => `${api(ids)}/issues/${ids[key]}/subscribers/${ids.selfId}`,
      ...see,
    },
    {
      name: `issues: unsubscribe (${label})`,
      method: 'DELETE',
      path: (ids) => `${api(ids)}/issues/${ids[key]}/subscribers/${ids.selfId}`,
      ...see,
    },
    {
      name: `issues: add link (${label})`,
      method: 'POST',
      path: (ids) => `${api(ids)}/issues/${ids[key]}/links`,
      body: (ids: Ids) => ({ url: `https://example.test/${ids.uid}` }),
      ...see,
    },
    {
      name: `issues: remove link (${label})`,
      method: 'DELETE',
      path: (ids) => `${api(ids)}/issues/${ids[key]}/links/${ids[link]}`,
      ...see,
    },
  ]),

  // ---- comments: they follow the issue's team; the author edits, the author or an admin deletes ----
  ...TEAMS.flatMap(({ issue: key, label, see }): EndpointCase[] => [
    {
      name: `comments: list (${label})`,
      method: 'GET',
      path: (ids) => `${api(ids)}/issues/${ids[key]}/comments`,
      ...see,
    },
    {
      name: `comments: create (${label})`,
      method: 'POST',
      path: (ids) => `${api(ids)}/issues/${ids[key]}/comments`,
      body: (ids: Ids) => ({ body: `Comment ${ids.uid}` }),
      ...see,
    },
  ]),
  {
    name: 'comments: edit own (public team)',
    method: 'PATCH',
    path: (ids) => `${api(ids)}/comments/${ids.commentId}`,
    body: { body: 'Edited text' },
    minRole: 'guest',
  },
  {
    name: "comments: edit other's (public team)",
    method: 'PATCH',
    path: (ids) => `${api(ids)}/comments/${ids.otherCommentId}`,
    body: { body: 'Edited text' },
    minRole: 'none',
  },
  {
    name: 'comments: delete own (public team)',
    method: 'DELETE',
    path: (ids) => `${api(ids)}/comments/${ids.commentId}`,
    minRole: 'guest',
  },
  {
    name: "comments: delete other's (public team)",
    method: 'DELETE',
    path: (ids) => `${api(ids)}/comments/${ids.otherCommentId}`,
    minRole: 'admin',
  },
  {
    name: 'comments: resolve (public team)',
    method: 'POST',
    path: (ids) => `${api(ids)}/comments/${ids.commentId}/resolve`,
    minRole: 'guest',
  },
  {
    name: 'comments: unresolve (public team)',
    method: 'POST',
    path: (ids) => `${api(ids)}/comments/${ids.commentId}/unresolve`,
    minRole: 'guest',
  },
  {
    name: 'comments: react (public team)',
    method: 'PUT',
    path: (ids) => `${api(ids)}/comments/${ids.commentId}/reactions/${emojiSegment(ids)}`,
    minRole: 'guest',
  },
  {
    name: 'comments: unreact (public team)',
    method: 'DELETE',
    path: (ids) => `${api(ids)}/comments/${ids.commentId}/reactions/${emojiSegment(ids)}`,
    minRole: 'guest',
  },
  {
    name: 'comments: history (public team)',
    method: 'GET',
    path: (ids) => `${api(ids)}/comments/${ids.commentId}/history`,
    minRole: 'guest',
  },

  // ---- attachments: they follow the issue's team; the uploader (or anybody but a guest) removes ----
  ...TEAMS.flatMap(({ issue: key, attachment: pending, file, label, see }): EndpointCase[] => [
    {
      name: `attachments: init (${label})`,
      method: 'POST',
      path: (ids) => `${api(ids)}/issues/${ids[key]}/attachments`,
      body: (ids: Ids) => ({ fileName: `f-${ids.uid}.png`, contentType: 'image/png', size: 64 }),
      ...see,
    },
    {
      name: `attachments: list (${label})`,
      method: 'GET',
      path: (ids) => `${api(ids)}/issues/${ids[key]}/attachments`,
      ...see,
    },
    {
      name: `attachments: complete (${label})`,
      method: 'POST',
      path: (ids) => `${api(ids)}/attachments/${ids[pending]}/complete`,
      ...see,
    },
    {
      name: `attachments: read (${label})`,
      method: 'GET',
      path: (ids) => `${api(ids)}/attachments/${ids[file]}/file`,
      ...see,
    },
    {
      name: `attachments: remove (${label})`,
      method: 'DELETE',
      path: (ids) => `${api(ids)}/attachments/${ids[file]}`,
      ...see,
    },
  ]),
  {
    name: "attachments: remove other's (public team)",
    method: 'DELETE',
    path: (ids) => `${api(ids)}/attachments/${ids.otherFileId}`,
    minRole: 'member',
  },

  // ---- team documents: everybody who sees the team reads; anybody but a guest writes ----
  ...TEAMS.flatMap(
    ({ team: teamKey, document: doc, label, see, editDocuments }): EndpointCase[] => [
      {
        name: `documents: list (${label})`,
        method: 'GET',
        path: (ids) => `${api(ids)}/teams/${ids[teamKey]}/documents`,
        ...see,
      },
      {
        name: `documents: create (${label})`,
        method: 'POST',
        path: (ids) => `${api(ids)}/teams/${ids[teamKey]}/documents`,
        body: (ids: Ids) => ({ title: `Document ${ids.uid}`, body: 'Text' }),
        ...editDocuments,
      },
      {
        name: `documents: get (${label})`,
        method: 'GET',
        path: (ids) => `${api(ids)}/documents/${ids[doc]}`,
        ...see,
      },
      {
        name: `documents: update (${label})`,
        method: 'PATCH',
        path: (ids) => `${api(ids)}/documents/${ids[doc]}`,
        body: { title: 'Edited title' },
        ...editDocuments,
      },
      {
        name: `documents: archive (${label})`,
        method: 'POST',
        path: (ids) => `${api(ids)}/documents/${ids[doc]}/archive`,
        ...editDocuments,
      },
      {
        name: `documents: unarchive (${label})`,
        method: 'POST',
        path: (ids) => `${api(ids)}/documents/${ids[doc]}/unarchive`,
        ...editDocuments,
      },
      {
        name: `documents: revisions (${label})`,
        method: 'GET',
        path: (ids) => `${api(ids)}/documents/${ids[doc]}/revisions`,
        ...see,
      },
    ],
  ),

  // ---- labels and workflow states ----
  { name: 'labels: list', method: 'GET', path: (ids) => `${api(ids)}/labels`, minRole: 'guest' },
  {
    name: 'labels: create (workspace)',
    method: 'POST',
    path: (ids) => `${api(ids)}/labels`,
    body: (ids: Ids) => ({ name: `W${ids.uid}`, color: '#336699' }),
    minRole: 'admin',
  },
  {
    name: 'labels: update (workspace)',
    method: 'PATCH',
    path: (ids) => `${api(ids)}/labels/${ids.workspaceLabelId}`,
    body: { color: '#112233' },
    minRole: 'admin',
  },
  {
    name: 'labels: archive (workspace)',
    method: 'POST',
    path: (ids) => `${api(ids)}/labels/${ids.workspaceLabelId}/archive`,
    minRole: 'admin',
  },
  ...TEAMS.flatMap(
    ({ team: key, teamLabel, state, label, see, manage, defineLabel }): EndpointCase[] => [
      {
        name: `labels: create (${label})`,
        method: 'POST',
        path: (ids) => `${api(ids)}/labels`,
        body: (ids: Ids) => ({ name: `T${ids.uid}`, color: '#336699', teamId: ids[key] }),
        ...defineLabel,
      },
      {
        name: `labels: update (${label})`,
        method: 'PATCH',
        path: (ids) => `${api(ids)}/labels/${ids[teamLabel]}`,
        body: { color: '#112233' },
        ...defineLabel,
      },
      {
        name: `labels: archive (${label})`,
        method: 'POST',
        path: (ids) => `${api(ids)}/labels/${ids[teamLabel]}/archive`,
        ...defineLabel,
      },
      {
        name: `workflow states: list (${label})`,
        method: 'GET',
        path: (ids) => `${api(ids)}/teams/${ids[key]}/workflow-states`,
        ...see,
      },
      {
        name: `workflow states: create (${label})`,
        method: 'POST',
        path: (ids) => `${api(ids)}/teams/${ids[key]}/workflow-states`,
        body: (ids: Ids) => ({ name: `State ${ids.uid}`, type: 'started' }),
        ...manage,
      },
      {
        name: `workflow states: update (${label})`,
        method: 'PATCH',
        path: (ids) => `${api(ids)}/teams/${ids[key]}/workflow-states/${ids[state]}`,
        body: { color: '#112233' },
        ...manage,
      },
      {
        name: `workflow states: archive (${label})`,
        method: 'POST',
        path: (ids) => `${api(ids)}/teams/${ids[key]}/workflow-states/${ids[state]}/archive`,
        body: {},
        ...manage,
      },
    ],
  ),

  // ---- sync shapes ----
  { name: 'sync: teams', method: 'GET', path: (ids) => `${sync(ids)}/teams`, minRole: 'guest' },
  { name: 'sync: members', method: 'GET', path: (ids) => `${sync(ids)}/members`, minRole: 'guest' },
  {
    name: 'sync: own team memberships',
    method: 'GET',
    path: (ids) => `${sync(ids)}/me/team-memberships`,
    minRole: 'guest',
  },
  // The one cross-team shape: the actor's own issues of every team they can see. Everybody reads it; what it holds
  // is decided per request from the teams the actor can see.
  {
    name: 'sync: my issues',
    method: 'GET',
    path: (ids) => `${sync(ids)}/my-issues`,
    minRole: 'guest',
  },
  ...TEAMS.flatMap(({ team: key, label, see }): EndpointCase[] => [
    {
      name: `sync: issues (${label})`,
      method: 'GET',
      path: (ids) => `${sync(ids)}/teams/${ids[key]}/issues`,
      ...see,
    },
    {
      name: `sync: workflow states (${label})`,
      method: 'GET',
      path: (ids) => `${sync(ids)}/teams/${ids[key]}/workflow-states`,
      ...see,
    },
    {
      name: `sync: team members (${label})`,
      method: 'GET',
      path: (ids) => `${sync(ids)}/teams/${ids[key]}/members`,
      ...see,
    },
  ]),
  // The issue model's own shapes: per team (the same visibility as the team), the workspace's labels (everybody), and
  // per opened issue (the visibility of the issue's team).
  {
    name: 'sync: workspace labels',
    method: 'GET',
    path: (ids) => `${sync(ids)}/workspace-labels`,
    minRole: 'guest',
  },
  ...TEAMS.flatMap(({ team: key, issue, document: doc, label, see }): EndpointCase[] => [
    {
      name: `sync: team documents (${label})`,
      method: 'GET',
      path: (ids) => `${sync(ids)}/teams/${ids[key]}/documents`,
      ...see,
    },
    {
      name: `sync: document content (${label})`,
      method: 'GET',
      path: (ids) => `${sync(ids)}/documents/${ids[doc]}/content`,
      ...see,
    },
    ...(
      [
        ['labels', 'labels'],
        ['issue labels', 'issue-labels'],
        ['issue subscribers', 'issue-subscribers'],
        ['issue links', 'issue-links'],
        ['issue relations', 'issue-relations'],
      ] as const
    ).map(
      ([title, route]): EndpointCase => ({
        name: `sync: ${title} (${label})`,
        method: 'GET',
        path: (ids) => `${sync(ids)}/teams/${ids[key]}/${route}`,
        ...see,
      }),
    ),
    ...(['detail', 'activity', 'comments', 'attachments'] as const).map(
      (route): EndpointCase => ({
        name: `sync: issue ${route} (${label})`,
        method: 'GET',
        path: (ids) => `${sync(ids)}/issues/${ids[issue]}/${route}`,
        ...see,
      }),
    ),
  ]),
];

// ---- the world ----

const UNUSED = '00000000-0000-4000-8000-000000000000';
const WEEK_MS = 7 * 24 * 60 * 60 * 1000;
const ORIGIN = 'http://app.example.test';

/** A workspace of the world: the fixture plus the owner-only public team and one issue per team. */
export type Workspace = {
  workspaceId: string;
  ownerId: string;
  teams: { eng: string; ops: string; pub: string };
  issues: { eng: string; ops: string; pub: string };
};

type TeamName = keyof Workspace['teams'];

/** The teams each role's fresh actor belongs to; it is the layout of the fixture's own members plus the owner-only team. */
const ACTOR_TEAMS: Record<Role, readonly TeamName[]> = {
  owner: ['eng', 'ops', 'pub'],
  admin: ['eng'],
  member: ['eng', 'ops'],
  guest: ['eng'],
};

async function createWorkspace(orm: Orm): Promise<Workspace> {
  const f = await createWorkspaceFixture(orm);
  const workspaceId = f.workspaceId;
  const ownerId = f.members.owner.id;

  const pub = await orm.transaction(async (tx) => {
    const [created] = await tx
      .insert(team)
      .values({
        workspaceId,
        key: 'PUB',
        name: 'Public, owner only',
        private: false,
        issueCounter: 1,
      })
      .returning({ id: team.id });
    if (!created) throw new Error('team insert returned no row');
    const states = await tx
      .insert(workflowState)
      .values(defaultWorkflowStates().map((s) => ({ workspaceId, teamId: created.id, ...s })))
      .returning({ id: workflowState.id, type: workflowState.type });
    const backlog = states.find((s) => s.type === 'backlog');
    if (!backlog) throw new Error('no backlog state');
    await tx.insert(teamMember).values({ workspaceId, teamId: created.id, memberId: ownerId });
    const [first] = await tx
      .insert(issue)
      .values({
        workspaceId,
        teamId: created.id,
        number: 1,
        title: 'PUB issue 1',
        stateId: backlog.id,
        creatorId: ownerId,
      })
      .returning({ id: issue.id });
    if (!first) throw new Error('issue insert returned no row');
    return { teamId: created.id, issueId: first.id };
  });

  const first = (rows: { id: string }[]) => {
    const row = rows[0];
    if (!row) throw new Error('the fixture has no issue');
    return row.id;
  };
  return {
    workspaceId,
    ownerId,
    teams: { eng: f.teams.eng.id, ops: f.teams.ops.id, pub: pub.teamId },
    issues: { eng: first(f.issues.eng), ops: first(f.issues.ops), pub: pub.issueId },
  };
}

let attemptCounter = 0;
/** Six upper-case letters and digits, never repeated in this process: `T` + this is a valid team key. */
const nextUid = () => (++attemptCounter).toString(36).toUpperCase().padStart(6, '0');

export type Attempt = { cookie: string; ids: Ids };

/**
 * A fresh actor of `role` in `ws` with a real session, and fresh targets for the ids in `needs`. Every attempt gets
 * its own people, so one that deactivates, deletes, revokes or joins a team changes nobody else's answer.
 */
export async function newAttempt(
  orm: Orm,
  ws: Workspace,
  role: Role,
  needs: ReadonlySet<keyof Ids>,
  files: FakeStorage,
): Promise<Attempt> {
  const { workspaceId } = ws;
  const actor = await addMember(orm, workspaceId, role, {
    teamIds: ACTOR_TEAMS[role].map((name) => ws.teams[name]),
  });
  const { cookie } = await openSession(orm, workspaceId, actor.id);
  const uid = nextUid();
  const ids: Ids = {
    workspaceId,
    selfId: actor.id,
    uid,
    teamId: ws.teams.eng,
    privateTeamId: ws.teams.ops,
    ownerOnlyTeamId: ws.teams.pub,
    issueId: ws.issues.eng,
    privateIssueId: ws.issues.ops,
    ownerOnlyIssueId: ws.issues.pub,
    peerIssueId: UNUSED,
    privatePeerIssueId: UNUSED,
    ownerOnlyPeerIssueId: UNUSED,
    relationId: UNUSED,
    privateRelationId: UNUSED,
    ownerOnlyRelationId: UNUSED,
    linkId: UNUSED,
    privateLinkId: UNUSED,
    ownerOnlyLinkId: UNUSED,
    labelId: UNUSED,
    privateLabelId: UNUSED,
    ownerOnlyLabelId: UNUSED,
    workspaceLabelId: UNUSED,
    commentId: UNUSED,
    otherCommentId: UNUSED,
    attachmentId: UNUSED,
    privateAttachmentId: UNUSED,
    ownerOnlyAttachmentId: UNUSED,
    fileId: UNUSED,
    privateFileId: UNUSED,
    ownerOnlyFileId: UNUSED,
    otherFileId: UNUSED,
    documentId: UNUSED,
    privateDocumentId: UNUSED,
    ownerOnlyDocumentId: UNUSED,
    stateId: UNUSED,
    privateStateId: UNUSED,
    ownerOnlyStateId: UNUSED,
    memberId: UNUSED,
    newcomerId: UNUSED,
    adminId: UNUSED,
    deactivatedId: UNUSED,
    deactivatedAdminId: UNUSED,
    inviteId: UNUSED,
    adminInviteId: UNUSED,
  };

  const deactivated = async (memberRole: 'member' | 'admin') => {
    const added = await addMember(orm, workspaceId, memberRole);
    await orm.update(member).set({ deactivatedAt: new Date() }).where(eq(member.id, added.id));
    return added.id;
  };
  const pendingInvite = async (inviteRole: Role) => {
    const [row] = await orm
      .insert(invite)
      .values({
        workspaceId,
        email: `target-${uid.toLowerCase()}-${inviteRole}@example.test`,
        role: inviteRole,
        tokenHash: hashToken(generateToken()),
        invitedBy: ws.ownerId,
        expiresAt: new Date(Date.now() + WEEK_MS),
      })
      .returning({ id: invite.id });
    if (!row) throw new Error('invite insert returned no row');
    return row.id;
  };

  // A new issue next to the first one of a team, made by the owner (who belongs to all three teams).
  const owner = await loadClientActor(orm, workspaceId, ws.ownerId, 'web');
  if (!owner) throw new Error('the workspace owner has no actor');
  const peerOf = async (name: TeamName) => {
    const created = await createIssue(orm, owner, { teamId: ws.teams[name], title: `Peer ${uid}` });
    if (!created.ok) throw new Error(`peer issue refused: ${created.error.code}`);
    return created.body.issue.id;
  };
  const JOIN_TARGETS = [
    ['eng', 'peerIssueId', 'relationId', 'linkId'],
    ['ops', 'privatePeerIssueId', 'privateRelationId', 'privateLinkId'],
    ['pub', 'ownerOnlyPeerIssueId', 'ownerOnlyRelationId', 'ownerOnlyLinkId'],
  ] as const;
  for (const [name, peerKey, relationKey, linkKey] of JOIN_TARGETS) {
    const teamId = ws.teams[name];
    if (needs.has(peerKey)) ids[peerKey] = await peerOf(name);
    if (needs.has(relationKey)) {
      const [row] = await orm
        .insert(issueRelation)
        .values({
          workspaceId,
          teamId,
          issueId: ws.issues[name],
          relatedTeamId: teamId,
          relatedIssueId: await peerOf(name),
          type: 'related',
          createdBy: ws.ownerId,
        })
        .returning({ id: issueRelation.id });
      if (!row) throw new Error('relation insert returned no row');
      ids[relationKey] = row.id;
    }
    if (needs.has(linkKey)) {
      const [row] = await orm
        .insert(issueLink)
        .values({
          workspaceId,
          teamId,
          issueId: ws.issues[name],
          url: 'https://example.test/linked',
          createdBy: ws.ownerId,
        })
        .returning({ id: issueLink.id });
      if (!row) throw new Error('link insert returned no row');
      ids[linkKey] = row.id;
    }
  }

  const LABEL_TARGETS = [
    ['eng', 'labelId', 'stateId'],
    ['ops', 'privateLabelId', 'privateStateId'],
    ['pub', 'ownerOnlyLabelId', 'ownerOnlyStateId'],
  ] as const;
  const newLabelRow = async (teamId: string | null, name: string) => {
    const [row] = await orm
      .insert(label)
      .values({ workspaceId, teamId, name, color: '#336699' })
      .returning({ id: label.id });
    if (!row) throw new Error('label insert returned no row');
    return row.id;
  };
  for (const [name, labelKey, stateKey] of LABEL_TARGETS) {
    if (needs.has(labelKey)) ids[labelKey] = await newLabelRow(ws.teams[name], `L${uid}`);
    if (needs.has(stateKey)) {
      const [row] = await orm
        .insert(workflowState)
        .values({
          workspaceId,
          teamId: ws.teams[name],
          name: `Review ${uid}`,
          type: 'started',
          position: 50,
        })
        .returning({ id: workflowState.id });
      if (!row) throw new Error('workflow state insert returned no row');
      ids[stateKey] = row.id;
    }
  }
  if (needs.has('workspaceLabelId')) ids.workspaceLabelId = await newLabelRow(null, `WL${uid}`);

  const commentBy = async (authorId: string, body: string) => {
    const [row] = await orm
      .insert(comment)
      .values({
        workspaceId,
        teamId: ws.teams.eng,
        issueId: ws.issues.eng,
        authorId,
        body,
      })
      .returning({ id: comment.id });
    if (!row) throw new Error('comment insert returned no row');
    return row.id;
  };
  if (needs.has('commentId')) ids.commentId = await commentBy(actor.id, `Comment of ${uid}`);
  if (needs.has('otherCommentId')) {
    ids.otherCommentId = await commentBy(ws.ownerId, `Comment of the owner ${uid}`);
  }

  // A file of `uploader` on a new issue of the team (files never pile up on the shared issue), with its object in the
  // storage as a finished upload leaves it.
  const fileFor = async (name: TeamName, uploaderId: string, status: 'pending' | 'ready') => {
    const holder = await peerOf(name);
    const id = crypto.randomUUID();
    const storageKey = `workspaces/${workspaceId}/attachments/${id}`;
    const bytes = new Uint8Array(64);
    bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    // A pending upload sits at its staging key (what complete copies from); a ready file at its own key.
    files.put(
      status === 'pending' ? stagingKeyOf(workspaceId, id) : storageKey,
      bytes,
      'image/png',
    );
    await orm.insert(attachment).values({
      id,
      workspaceId,
      teamId: ws.teams[name],
      issueId: holder,
      uploaderId,
      fileName: 'seed.png',
      contentType: 'image/png',
      sizeBytes: 64,
      storageKey,
      status,
      readyAt: status === 'ready' ? new Date() : null,
    });
    return id;
  };
  for (const [name, pendingKey, fileKey] of [
    ['eng', 'attachmentId', 'fileId'],
    ['ops', 'privateAttachmentId', 'privateFileId'],
    ['pub', 'ownerOnlyAttachmentId', 'ownerOnlyFileId'],
  ] as const) {
    if (needs.has(pendingKey)) ids[pendingKey] = await fileFor(name, actor.id, 'pending');
    if (needs.has(fileKey)) ids[fileKey] = await fileFor(name, actor.id, 'ready');
  }
  if (needs.has('otherFileId')) ids.otherFileId = await fileFor('eng', ws.ownerId, 'ready');

  for (const [name, documentKey] of [
    ['eng', 'documentId'],
    ['ops', 'privateDocumentId'],
    ['pub', 'ownerOnlyDocumentId'],
  ] as const) {
    if (!needs.has(documentKey)) continue;
    const [row] = await orm
      .insert(document)
      .values({
        workspaceId,
        teamId: ws.teams[name],
        title: `Doc ${uid}`,
        body: 'Seed text',
        createdBy: ws.ownerId,
        updatedBy: ws.ownerId,
      })
      .returning({ id: document.id });
    if (!row) throw new Error('document insert returned no row');
    ids[documentKey] = row.id;
  }

  if (needs.has('memberId')) {
    const added = await addMember(orm, workspaceId, 'member', {
      teamIds: [ws.teams.eng, ws.teams.ops, ws.teams.pub],
    });
    ids.memberId = added.id;
  }
  if (needs.has('newcomerId')) ids.newcomerId = (await addMember(orm, workspaceId, 'member')).id;
  if (needs.has('adminId')) ids.adminId = (await addMember(orm, workspaceId, 'admin')).id;
  if (needs.has('deactivatedId')) ids.deactivatedId = await deactivated('member');
  if (needs.has('deactivatedAdminId')) ids.deactivatedAdminId = await deactivated('admin');
  if (needs.has('inviteId')) ids.inviteId = await pendingInvite('member');
  if (needs.has('adminInviteId')) ids.adminInviteId = await pendingInvite('admin');
  return { cookie, ids };
}

/** What a call answered: the status and, for a refusal, the `error` code of the body. */
export type Outcome = { status: number; error?: string };

export type World = {
  /** Two workspaces with the same layout. */
  a: Workspace;
  b: Workspace;
  app: App;
  /** A fresh actor of `role` in `ws` and the targets `c` needs (none without a case: a session only). */
  attempt(ws: Workspace, role: Role, c?: EndpointCase): Promise<Attempt>;
  /** Calls `c` with `ids`, signed in with `cookie` when given. Writes carry the Origin the CSRF guard expects. */
  send(c: EndpointCase, ids: Ids, cookie?: string): Promise<Outcome>;
};

/**
 * The real app (session cookies, memory mailer, the shape proxy with an Electric that answers 200 to everything) over
 * `db`, and two workspaces. Call once per test file; attempts create their own rows.
 */
export async function createWorld(db: Db): Promise<World> {
  // The files of the world live in memory: the same contract as the S3 storage, no network.
  const files = createFakeStorage();
  const app = createApp({
    brand: testBrand,
    db,
    config: { appUrl: ORIGIN, trustProxy: false },
    mailer: createMemoryMailer(),
    auth: createSessionActorResolver({ orm: db.orm, appUrl: ORIGIN }),
    electric: { url: 'http://electric.test:3000', secret: 'test-secret' },
    files,
    fetchUpstream: async () =>
      new Response('[{"headers":{"control":"up-to-date"}}]', {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
  });
  const a = await createWorkspace(db.orm);
  const b = await createWorkspace(db.orm);

  return {
    a,
    b,
    app,
    attempt: (ws, role, c) => newAttempt(db.orm, ws, role, c ? idsUsedBy(c) : new Set(), files),
    async send(c, ids, cookie) {
      const body = bodyOf(c, ids);
      const headers: Record<string, string> = { origin: ORIGIN };
      if (cookie) headers.cookie = cookie;
      if (body !== undefined) headers['content-type'] = 'application/json';
      const res = await app.fetch(
        new Request(`${ORIGIN}${c.path(ids)}`, {
          method: c.method,
          headers,
          body: body === undefined ? undefined : JSON.stringify(body),
        }),
      );
      const text = await res.text();
      let error: string | undefined;
      try {
        const parsed = JSON.parse(text) as { error?: unknown };
        if (typeof parsed.error === 'string') error = parsed.error;
      } catch {
        // A success body, or one that is not JSON: no error code to report.
      }
      return { status: res.status, error };
    },
  };
}

/**
 * An app with every route mounted and nothing behind it, to read its routes without a database: handlers are never
 * reached. Same dependencies as `createWorld`, stubbed.
 */
export function createRouteProbeApp(): App {
  const never = async () => {
    throw new Error('the route probe app answers no request');
  };
  return createApp({
    brand: testBrand,
    db: { health: never, orm: {} as Orm },
    config: { appUrl: ORIGIN, trustProxy: false },
    mailer: createMemoryMailer(),
    auth: { resolveActor: never },
    electric: { url: 'http://electric.test:3000', secret: 'test-secret' },
  });
}
