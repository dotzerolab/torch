// The permission matrix: every role x object x action, written out by hand from the spec (§6) and the
// decisions of the project, then evaluated against the real functions of the shared permission module.
// The expectations are NOT computed from the code under test: change a rule and this file has to change
// with it, on purpose.
//
// Adding an object type (OBJECT_TYPES) fails `typecheck` until `MATRIX` and `EVALUATORS` have an entry for
// it, and fails the completeness tests below until it has rows. Later sub-phases append their objects here.
//
// The last section asks the same questions of the running app: one row per endpoint case (test/endpoints.ts) with
// the status every role must get, and a completeness test that every case has a row and every row a case. A new
// object type needs rows in both places.
import {
  type Actor,
  canAddSelfToTeam,
  canAttach,
  canChangeMemberRole,
  canComment,
  canCreateIssue,
  canDeactivateMember,
  canDeleteComment,
  canEditComment,
  canEditDocuments,
  canEditIssues,
  canGrantRole,
  canInvite,
  canListPrivateTeams,
  canManageInvite,
  canManageLabels,
  canManageMembers,
  canManageTeamMembership,
  canManageTeams,
  canManageWorkflow,
  canReadDocuments,
  canRemoveAttachment,
  canSeeMember,
  canSeeMemberEmail,
  canSeeTeam,
  OBJECT_TYPES,
  type ObjectType,
  type Role,
  type TeamAccess,
} from '@torch/shared/permissions';
import { beforeAll, describe, expect, it } from 'vitest';
import { createWorld, ENDPOINTS, type World } from '../test/endpoints.ts';
import { useSharedDatabase } from '../test/shared-database.ts';

const ROLES: readonly Role[] = ['owner', 'admin', 'member', 'guest'];

type Relation = 'in team' | 'not in team, public' | 'not in team, private' | 'other workspace';
type MatrixRow = { action: string; roles: Record<Role, boolean>; relation?: Relation };

const row = (
  action: string,
  owner: boolean,
  admin: boolean,
  member: boolean,
  guest: boolean,
  relation?: Relation,
): MatrixRow => ({
  action,
  roles: { owner, admin, member, guest },
  ...(relation ? { relation } : {}),
});

const NOBODY = (action: string, relation?: Relation) =>
  row(action, false, false, false, false, relation);

/**
 * Expected answers, per object. Relations: for team-scoped objects `in team` is "the actor belongs to the team",
 * `not in team, public` and `not in team, private` are teams the actor is not a member of, and `other workspace`
 * is anything that belongs to another workspace (the actor is even listed in a team with the same id there).
 * For `member` rows, `in team` means "the target shares a team with the actor".
 */
export const MATRIX: Record<ObjectType, MatrixRow[]> = {
  member: [
    // Every member sees the people of the workspace; a guest sees only themselves and who shares a team.
    row('view', true, true, true, true, 'in team'),
    row('view', true, true, true, false, 'not in team, public'),
    NOBODY('view', 'other workspace'),
    // Emails: owner and admin only.
    row('view email', true, true, false, false),
    // Role changes: an owner moves anybody, an admin moves members and guests between member and guest only,
    // nobody changes their own role.
    row('change role: member to guest', true, true, false, false),
    row('change role: guest to member', true, true, false, false),
    row('change role: member to admin', true, false, false, false),
    row('change role: admin to member', true, false, false, false),
    row('change role: admin to owner', true, false, false, false),
    row('change role: owner to admin', true, false, false, false),
    NOBODY('change role: own role'),
    NOBODY('change role: member to guest', 'other workspace'),
    NOBODY('change role: guest to member', 'other workspace'),
    NOBODY('change role: member to admin', 'other workspace'),
    NOBODY('change role: admin to member', 'other workspace'),
    NOBODY('change role: admin to owner', 'other workspace'),
    NOBODY('change role: owner to admin', 'other workspace'),
    // Deactivation (and reactivation): owner anybody, admin members and guests, nobody themselves.
    row('deactivate: member', true, true, false, false),
    row('deactivate: guest', true, true, false, false),
    row('deactivate: admin', true, false, false, false),
    row('deactivate: owner', true, false, false, false),
    NOBODY('deactivate: self'),
    NOBODY('deactivate: member', 'other workspace'),
    NOBODY('deactivate: guest', 'other workspace'),
    NOBODY('deactivate: admin', 'other workspace'),
    NOBODY('deactivate: owner', 'other workspace'),
  ],
  invite: [
    // Inviting follows the role being granted: only an owner invites an admin or an owner.
    row('create guest', true, true, false, false),
    row('create member', true, true, false, false),
    row('create admin', true, false, false, false),
    row('create owner', true, false, false, false),
    // An invite for the address of a DEACTIVATED member brings that person back (a reactivation), so it also needs the
    // right to grant the role they have now: an admin never reactivates an admin or an owner, by any route.
    row('create for a deactivated member', true, true, false, false),
    row('create for a deactivated guest', true, true, false, false),
    row('create for a deactivated admin', true, false, false, false),
    row('create for a deactivated owner', true, false, false, false),
    // Resend and revoke follow the role the invite carries, like creating it; an invite of another workspace is
    // closed to everybody.
    row('resend a guest invite', true, true, false, false),
    row('resend a member invite', true, true, false, false),
    row('resend an admin invite', true, false, false, false),
    row('resend an owner invite', true, false, false, false),
    NOBODY('resend a guest invite', 'other workspace'),
    NOBODY('resend a member invite', 'other workspace'),
    NOBODY('resend an admin invite', 'other workspace'),
    NOBODY('resend an owner invite', 'other workspace'),
    row('revoke a guest invite', true, true, false, false),
    row('revoke a member invite', true, true, false, false),
    row('revoke an admin invite', true, false, false, false),
    row('revoke an owner invite', true, false, false, false),
    NOBODY('revoke a guest invite', 'other workspace'),
    NOBODY('revoke a member invite', 'other workspace'),
    NOBODY('revoke an admin invite', 'other workspace'),
    NOBODY('revoke an owner invite', 'other workspace'),
  ],
  team: [
    // Public teams are visible to everyone except guests who are not in them; private ones only to members.
    row('view', true, true, true, true, 'in team'),
    row('view', true, true, true, false, 'not in team, public'),
    NOBODY('view', 'not in team, private'),
    NOBODY('view', 'other workspace'),
    // Only owners and admins create and edit teams.
    row('create', true, true, false, false),
    // Editing needs a team the actor can see: a private team they are not in is closed until they join it.
    row('update', true, true, false, false, 'in team'),
    row('update', true, true, false, false, 'not in team, public'),
    NOBODY('update', 'not in team, private'),
    NOBODY('update', 'other workspace'),
    // Management-only directory of private teams: key, name and member count, never issues.
    row('list private directory', true, true, false, false),
  ],
  team_membership: [
    // Add or remove people of a team the actor can see: owner and admin only.
    row('add or remove', true, true, false, false, 'in team'),
    row('add or remove', true, true, false, false, 'not in team, public'),
    NOBODY('add or remove', 'not in team, private'),
    NOBODY('add or remove', 'other workspace'),
    // An owner or admin may add themselves to any team of the workspace, a private one included (audited).
    row('add self', true, true, false, false, 'in team'),
    row('add self', true, true, false, false, 'not in team, public'),
    row('add self', true, true, false, false, 'not in team, private'),
    NOBODY('add self', 'other workspace'),
  ],
  issue: [
    // Issues follow their team, for every role.
    row('view', true, true, true, true, 'in team'),
    row('view', true, true, true, false, 'not in team, public'),
    NOBODY('view', 'not in team, private'),
    NOBODY('view', 'other workspace'),
    row('edit', true, true, true, true, 'in team'),
    row('edit', true, true, true, false, 'not in team, public'),
    NOBODY('edit', 'not in team, private'),
    NOBODY('edit', 'other workspace'),
    // Creating an issue follows editing: a guest creates issues in the teams they belong to, like everybody else.
    row('create', true, true, true, true, 'in team'),
    row('create', true, true, true, false, 'not in team, public'),
    NOBODY('create', 'not in team, private'),
    NOBODY('create', 'other workspace'),
  ],
  label: [
    // A workspace label: owners and admins. It has no team, so there is no relation to ask about.
    row('manage workspace label', true, true, false, false),
    // A team label: anybody but a guest who can see the team.
    row('manage team label', true, true, true, false, 'in team'),
    row('manage team label', true, true, true, false, 'not in team, public'),
    NOBODY('manage team label', 'not in team, private'),
    NOBODY('manage team label', 'other workspace'),
  ],
  workflow_state: [
    // Owners and admins, for a team they can see.
    row('manage', true, true, false, false, 'in team'),
    row('manage', true, true, false, false, 'not in team, public'),
    NOBODY('manage', 'not in team, private'),
    NOBODY('manage', 'other workspace'),
  ],
  comment: [
    // Comments follow the issue's team, for every role (a guest comments in the teams they belong to).
    row('create', true, true, true, true, 'in team'),
    row('create', true, true, true, false, 'not in team, public'),
    NOBODY('create', 'not in team, private'),
    NOBODY('create', 'other workspace'),
    // Reacting and resolving a thread are open to whoever can comment.
    row('react or resolve', true, true, true, true, 'in team'),
    row('react or resolve', true, true, true, false, 'not in team, public'),
    NOBODY('react or resolve', 'not in team, private'),
    NOBODY('react or resolve', 'other workspace'),
    // Only the author edits a comment; nobody edits another person's, an owner included.
    row('edit own', true, true, true, true, 'in team'),
    row('edit own', true, true, true, false, 'not in team, public'),
    NOBODY('edit own', 'not in team, private'),
    NOBODY('edit own', 'other workspace'),
    NOBODY('edit other', 'in team'),
    NOBODY('edit other', 'not in team, public'),
    NOBODY('edit other', 'not in team, private'),
    NOBODY('edit other', 'other workspace'),
    // The author deletes their own comment; an owner or admin deletes anybody's, for a team they can see.
    row('delete own', true, true, true, true, 'in team'),
    row('delete own', true, true, true, false, 'not in team, public'),
    NOBODY('delete own', 'not in team, private'),
    NOBODY('delete own', 'other workspace'),
    row('delete other', true, true, false, false, 'in team'),
    row('delete other', true, true, false, false, 'not in team, public'),
    NOBODY('delete other', 'not in team, private'),
    NOBODY('delete other', 'other workspace'),
  ],
  attachment: [
    // A guest attaches files in the teams they belong to, like everybody else who sees the team.
    row('add', true, true, true, true, 'in team'),
    row('add', true, true, true, false, 'not in team, public'),
    NOBODY('add', 'not in team, private'),
    NOBODY('add', 'other workspace'),
    // The uploader removes their own file; anybody but a guest removes another person's.
    row('remove own', true, true, true, true, 'in team'),
    row('remove own', true, true, true, false, 'not in team, public'),
    NOBODY('remove own', 'not in team, private'),
    NOBODY('remove own', 'other workspace'),
    row('remove other', true, true, true, false, 'in team'),
    row('remove other', true, true, true, false, 'not in team, public'),
    NOBODY('remove other', 'not in team, private'),
    NOBODY('remove other', 'other workspace'),
  ],
  document: [
    // A team's documents: everybody who sees the team reads them; everybody but a guest edits them.
    row('view', true, true, true, true, 'in team'),
    row('view', true, true, true, false, 'not in team, public'),
    NOBODY('view', 'not in team, private'),
    NOBODY('view', 'other workspace'),
    row('edit', true, true, true, false, 'in team'),
    row('edit', true, true, true, false, 'not in team, public'),
    NOBODY('edit', 'not in team, private'),
    NOBODY('edit', 'other workspace'),
  ],
};

// ---- fixtures, in memory ----

const WORKSPACE = '00000000-0000-4000-8000-0000000000a1';
const OTHER_WORKSPACE = '00000000-0000-4000-8000-0000000000b2';
const TEAM = '10000000-0000-4000-8000-0000000000a1';
const SELF = '20000000-0000-4000-8000-0000000000a1';
const OTHER_MEMBER = '20000000-0000-4000-8000-0000000000a2';

type Scenario = { actor: Actor; team: TeamAccess };

/** The actor is a member of TEAM only for `in team` (and, adversarially, for `other workspace`). */
function scenario(role: Role, relation: Relation | undefined): Scenario {
  const actor: Actor = {
    workspaceId: WORKSPACE,
    memberId: SELF,
    role,
    teamIds: new Set(relation === 'in team' || relation === 'other workspace' ? [TEAM] : []),
  };
  const team: TeamAccess = {
    id: TEAM,
    workspaceId: relation === 'other workspace' ? OTHER_WORKSPACE : WORKSPACE,
    private: relation === 'not in team, private',
  };
  return { actor, team };
}

/** A member the actor is looking at or changing. */
function targetMember(role: Role, relation: Relation | undefined, over: { id?: string } = {}) {
  return {
    id: over.id ?? OTHER_MEMBER,
    workspaceId: relation === 'other workspace' ? OTHER_WORKSPACE : WORKSPACE,
    role,
  };
}

type Evaluate = (s: Scenario, relation: Relation | undefined) => boolean;

const changeRole =
  (from: Role, to: Role): Evaluate =>
  (s, relation) =>
    canChangeMemberRole(s.actor, targetMember(from, relation), to);
const deactivate =
  (targetRole: Role): Evaluate =>
  (s, relation) =>
    canDeactivateMember(s.actor, targetMember(targetRole, relation));
/** Resend or revoke: an invite carrying `role`, in the actor's workspace or (adversarially) in another one. */
const manageInvite =
  (role: Role): Evaluate =>
  (s, relation) =>
    canManageInvite(s.actor, {
      workspaceId: relation === 'other workspace' ? OTHER_WORKSPACE : WORKSPACE,
      role,
    });
/** An invite for a member role `member` for the address of a deactivated member who has the role `returning`. */
const inviteReturning =
  (returning: Role): Evaluate =>
  (s) =>
    canInvite(s.actor, 'member', returning);

/** How each row is asked of the real module. One evaluator per action name, keyed by object. */
const EVALUATORS: Record<ObjectType, Record<string, Evaluate>> = {
  member: {
    view: (s, relation) =>
      canSeeMember(s.actor, {
        id: OTHER_MEMBER,
        workspaceId: relation === 'other workspace' ? OTHER_WORKSPACE : WORKSPACE,
        // Adversarial for another workspace: the target is listed in a team with the actor's team id.
        teamIds: new Set(relation === 'in team' || relation === 'other workspace' ? [TEAM] : []),
      }),
    'view email': (s) => canSeeMemberEmail(s.actor),
    'change role: member to guest': changeRole('member', 'guest'),
    'change role: guest to member': changeRole('guest', 'member'),
    'change role: member to admin': changeRole('member', 'admin'),
    'change role: admin to member': changeRole('admin', 'member'),
    'change role: admin to owner': changeRole('admin', 'owner'),
    'change role: owner to admin': changeRole('owner', 'admin'),
    'change role: own role': (s) =>
      canChangeMemberRole(
        s.actor,
        { id: SELF, workspaceId: WORKSPACE, role: s.actor.role },
        'member',
      ),
    'deactivate: member': deactivate('member'),
    'deactivate: guest': deactivate('guest'),
    'deactivate: admin': deactivate('admin'),
    'deactivate: owner': deactivate('owner'),
    'deactivate: self': (s) =>
      canDeactivateMember(s.actor, { id: SELF, workspaceId: WORKSPACE, role: s.actor.role }),
  },
  invite: {
    // Creating an invite needs the right to manage members and to grant the invited role.
    'create guest': (s) => canManageMembers(s.actor) && canGrantRole(s.actor, 'guest'),
    'create member': (s) => canManageMembers(s.actor) && canGrantRole(s.actor, 'member'),
    'create admin': (s) => canManageMembers(s.actor) && canGrantRole(s.actor, 'admin'),
    'create owner': (s) => canManageMembers(s.actor) && canGrantRole(s.actor, 'owner'),
    'create for a deactivated member': inviteReturning('member'),
    'create for a deactivated guest': inviteReturning('guest'),
    'create for a deactivated admin': inviteReturning('admin'),
    'create for a deactivated owner': inviteReturning('owner'),
    'resend a guest invite': manageInvite('guest'),
    'resend a member invite': manageInvite('member'),
    'resend an admin invite': manageInvite('admin'),
    'resend an owner invite': manageInvite('owner'),
    'revoke a guest invite': manageInvite('guest'),
    'revoke a member invite': manageInvite('member'),
    'revoke an admin invite': manageInvite('admin'),
    'revoke an owner invite': manageInvite('owner'),
  },
  team: {
    view: (s) => canSeeTeam(s.actor, s.team),
    create: (s) => canManageTeams(s.actor),
    // Editing a team needs the right to manage teams and to see the team being edited.
    update: (s) => canManageTeams(s.actor) && canSeeTeam(s.actor, s.team),
    'list private directory': (s) => canListPrivateTeams(s.actor),
  },
  team_membership: {
    'add or remove': (s) => canManageTeamMembership(s.actor, s.team),
    'add self': (s) => canAddSelfToTeam(s.actor, s.team),
  },
  issue: {
    view: (s) => canSeeTeam(s.actor, s.team),
    edit: (s) => canEditIssues(s.actor, s.team),
    create: (s) => canCreateIssue(s.actor, s.team),
  },
  label: {
    'manage workspace label': (s) => canManageLabels(s.actor, null),
    'manage team label': (s) => canManageLabels(s.actor, s.team),
  },
  workflow_state: {
    manage: (s) => canManageWorkflow(s.actor, s.team),
  },
  comment: {
    create: (s) => canComment(s.actor, s.team),
    'react or resolve': (s) => canComment(s.actor, s.team),
    'edit own': (s) => canEditComment(s.actor, s.team, { authorId: SELF }),
    'edit other': (s) => canEditComment(s.actor, s.team, { authorId: OTHER_MEMBER }),
    'delete own': (s) => canDeleteComment(s.actor, s.team, { authorId: SELF }),
    'delete other': (s) => canDeleteComment(s.actor, s.team, { authorId: OTHER_MEMBER }),
  },
  attachment: {
    add: (s) => canAttach(s.actor, s.team),
    'remove own': (s) => canRemoveAttachment(s.actor, s.team, { uploaderId: SELF }),
    'remove other': (s) => canRemoveAttachment(s.actor, s.team, { uploaderId: OTHER_MEMBER }),
  },
  document: {
    view: (s) => canReadDocuments(s.actor, s.team),
    edit: (s) => canEditDocuments(s.actor, s.team),
  },
};

/**
 * Actions decided on the actor's role alone: they act inside the actor's own workspace and have no target that
 * could live in another one, so they have no `other workspace` row.
 */
const ROLE_ONLY = new Set([
  'member: view email',
  'member: change role: own role',
  'member: deactivate: self',
  'invite: create guest',
  'invite: create member',
  'invite: create admin',
  'invite: create owner',
  'invite: create for a deactivated member',
  'invite: create for a deactivated guest',
  'invite: create for a deactivated admin',
  'invite: create for a deactivated owner',
  'team: create',
  'team: list private directory',
  'label: manage workspace label',
]);

const keyOf = (r: MatrixRow) => `${r.action} [${r.relation ?? '-'}]`;
const CASES = OBJECT_TYPES.flatMap((object) =>
  MATRIX[object].flatMap((r) =>
    ROLES.map((role) => ({ object, r, role, expected: r.roles[role] })),
  ),
);

describe('permission matrix: expected answers against the real module', () => {
  it.each(CASES.map((c) => [`${c.object}: ${keyOf(c.r)} as ${c.role}`, c] as const))(
    '%s',
    (_name, { object, r, role, expected }) => {
      const evaluate = EVALUATORS[object][r.action];
      if (!evaluate) throw new Error(`no evaluator for ${object}: ${r.action}`);

      expect(evaluate(scenario(role, r.relation), r.relation)).toBe(expected);
    },
  );
});

describe('permission matrix: completeness', () => {
  it('OBJECT_TYPES has no duplicate and every row action is unique per object', () => {
    expect(new Set(OBJECT_TYPES).size).toBe(OBJECT_TYPES.length);
    for (const object of OBJECT_TYPES) {
      const keys = MATRIX[object].map(keyOf);
      expect(new Set(keys).size, `${object} has a duplicate row`).toBe(keys.length);
    }
  });

  it('every object has at least one row', () => {
    for (const object of OBJECT_TYPES) {
      expect(MATRIX[object].length, `${object} has no matrix rows`).toBeGreaterThan(0);
    }
  });

  it('the matrix has no object that OBJECT_TYPES does not know', () => {
    expect(Object.keys(MATRIX).sort()).toEqual([...OBJECT_TYPES].sort());
    expect(Object.keys(EVALUATORS).sort()).toEqual([...OBJECT_TYPES].sort());
  });

  it('every row names all four roles', () => {
    for (const object of OBJECT_TYPES) {
      for (const r of MATRIX[object]) {
        expect(Object.keys(r.roles).sort(), `${object}: ${keyOf(r)}`).toEqual([...ROLES].sort());
      }
    }
  });

  it('every row has an evaluator and every evaluator has a row', () => {
    for (const object of OBJECT_TYPES) {
      const actions = new Set(MATRIX[object].map((r) => r.action));
      expect([...actions].sort(), object).toEqual(Object.keys(EVALUATORS[object]).sort());
    }
  });

  it('every action with a target has an `other workspace` row', () => {
    for (const object of OBJECT_TYPES) {
      for (const action of new Set(MATRIX[object].map((r) => r.action))) {
        if (ROLE_ONLY.has(`${object}: ${action}`)) continue;
        const hasOtherWorkspace = MATRIX[object].some(
          (r) => r.action === action && r.relation === 'other workspace',
        );
        expect(hasOtherWorkspace, `${object}: ${action} lacks an "other workspace" row`).toBe(true);
      }
    }
  });
});

describe('permission matrix: another workspace is closed to everybody', () => {
  // Independent of the rows above: every evaluator, every role, with the target in another workspace.
  const CROSS = OBJECT_TYPES.flatMap((object) =>
    Object.keys(EVALUATORS[object]).flatMap((action) =>
      ROLES.map((role) => [`${object}: ${action} as ${role}`, object, action, role] as const),
    ),
  );

  it.each(CROSS)('%s', (_name, object, action, role) => {
    const evaluate = EVALUATORS[object][action];
    if (!evaluate) throw new Error(`no evaluator for ${object}: ${action}`);
    if (ROLE_ONLY.has(`${object}: ${action}`)) return;

    expect(evaluate(scenario(role, 'other workspace'), 'other workspace')).toBe(false);
  });
});

// ---- the same rules over HTTP ----
// One row per endpoint case (test/endpoints.ts): the status each role gets from the running app, written out by hand
// from the spec. Never read from `minRole`, from the permission module or from what the server answers.
// 200 is a success, 201 a created team or invite, 202 a resent invite. A refusal is 403 `forbidden` where the actor
// sees the object but may not do this, and 404 `not_found` where the object is invisible to the actor: a private
// team they are not in, any team a guest is not in. A session of another workspace is 401 and an id of another
// workspace is 404 for every role: see test/cross-workspace.test.ts.
//
// The fixture's private team (OPS) has the owner and the member in it, not the admin and not the guest. The public
// team "with the owner only" has the owner in it: the admin and the member see it, the guest does not.

type HttpRow = { endpoint: string; status: Record<Role, number> };

const http = (
  endpoint: string,
  owner: number,
  admin: number,
  member: number,
  guest: number,
): HttpRow => ({ endpoint, status: { owner, admin, member, guest } });

const HTTP_ROWS: HttpRow[] = [
  // Members: owners and admins list and administer people; an admin moves people between member and guest and
  // deactivates or reactivates members and guests only; only an owner touches admins and owners; nobody changes
  // their own role or deactivates themselves; everybody edits their own profile.
  http('members: list', 200, 200, 403, 403),
  http('members: change role, member to guest', 200, 200, 403, 403),
  http('members: change role, member to admin', 200, 403, 403, 403),
  http('members: change role, admin to member', 200, 403, 403, 403),
  http('members: change own role', 403, 403, 403, 403),
  http('members: deactivate a member', 200, 200, 403, 403),
  http('members: deactivate an admin', 200, 403, 403, 403),
  http('members: deactivate oneself', 403, 403, 403, 403),
  http('members: reactivate a member', 200, 200, 403, 403),
  http('members: reactivate an admin', 200, 403, 403, 403),
  http('profile: edit own profile', 200, 200, 200, 200),

  // Teams: owners and admins create teams and edit the teams they can see; a member sees a team they are in or a
  // public one but may not manage it; a guest sees only the teams they are in. An owner or admin may add
  // themselves to a private team they cannot see (and nobody else may be added to it by them).
  http('teams: create', 201, 201, 403, 403),
  http('teams: rename (public team)', 200, 200, 403, 403),
  http('teams: add a member (public team)', 200, 200, 403, 403),
  http('teams: remove a member (public team)', 200, 200, 403, 403),
  http('teams: rename (private team)', 200, 404, 403, 404),
  http('teams: add a member (private team)', 200, 404, 403, 404),
  http('teams: remove a member (private team)', 200, 404, 403, 404),
  http('teams: rename (public team with the owner only)', 200, 200, 403, 404),
  http('teams: add a member (public team with the owner only)', 200, 200, 403, 404),
  http('teams: remove a member (public team with the owner only)', 200, 200, 403, 404),
  http('teams: add oneself (private team)', 200, 200, 403, 404),
  http('teams: private team directory', 200, 200, 403, 403),

  // Invites: owners and admins; an admin hands out the roles member and guest only, and may not invite into a
  // private team they cannot see (404: the team does not exist for them).
  http('invites: list', 200, 200, 403, 403),
  http('invites: create (member role)', 201, 201, 403, 403),
  http('invites: create (guest role, into a public team)', 201, 201, 403, 403),
  http('invites: create (admin role)', 201, 403, 403, 403),
  http('invites: create (member role, into a private team)', 201, 404, 403, 403),
  http('invites: resend (member role)', 202, 202, 403, 403),
  http('invites: resend (admin role)', 202, 403, 403, 403),
  http('invites: revoke (member role)', 200, 200, 403, 403),
  http('invites: revoke (admin role)', 200, 403, 403, 403),

  // Issues follow their team, for every role.
  http('issues: list', 200, 200, 200, 200),
  http('issues: update (public team)', 200, 200, 200, 200),
  http('issues: update (private team)', 200, 404, 200, 404),
  http('issues: update (public team with the owner only)', 200, 200, 200, 404),
  http('issues: archive (public team)', 200, 200, 200, 200),
  http('issues: archive (private team)', 200, 404, 200, 404),
  http('issues: archive (public team with the owner only)', 200, 200, 200, 404),
  http('issues: unarchive (public team)', 200, 200, 200, 200),
  http('issues: unarchive (private team)', 200, 404, 200, 404),
  http('issues: unarchive (public team with the owner only)', 200, 200, 200, 404),
  http('issues: create (public team)', 201, 201, 201, 201),
  http('issues: create (private team)', 201, 404, 201, 404),
  http('issues: create (public team with the owner only)', 201, 201, 201, 404),

  // Relations, subscribers and links follow the issue's team: the same visibility, and a guest may also use them.
  http('issues: list relations (public team)', 200, 200, 200, 200),
  http('issues: add relation (public team)', 201, 201, 201, 201),
  http('issues: remove relation (public team)', 200, 200, 200, 200),
  http('issues: subscribe (public team)', 200, 200, 200, 200),
  http('issues: unsubscribe (public team)', 200, 200, 200, 200),
  http('issues: add link (public team)', 201, 201, 201, 201),
  http('issues: remove link (public team)', 200, 200, 200, 200),
  http('issues: list relations (private team)', 200, 404, 200, 404),
  http('issues: add relation (private team)', 201, 404, 201, 404),
  http('issues: remove relation (private team)', 200, 404, 200, 404),
  http('issues: subscribe (private team)', 200, 404, 200, 404),
  http('issues: unsubscribe (private team)', 200, 404, 200, 404),
  http('issues: add link (private team)', 201, 404, 201, 404),
  http('issues: remove link (private team)', 200, 404, 200, 404),
  http('issues: list relations (public team with the owner only)', 200, 200, 200, 404),
  http('issues: add relation (public team with the owner only)', 201, 201, 201, 404),
  http('issues: remove relation (public team with the owner only)', 200, 200, 200, 404),
  http('issues: subscribe (public team with the owner only)', 200, 200, 200, 404),
  http('issues: unsubscribe (public team with the owner only)', 200, 200, 200, 404),
  http('issues: add link (public team with the owner only)', 201, 201, 201, 404),
  http('issues: remove link (public team with the owner only)', 200, 200, 200, 404),

  // Comments follow the issue's team, for every role. The author edits their own comment (nobody edits another
  // person's, the owner included: 403); the author deletes their own comment and an owner or admin anybody's.
  http('comments: list (public team)', 200, 200, 200, 200),
  http('comments: create (public team)', 201, 201, 201, 201),
  http('comments: list (private team)', 200, 404, 200, 404),
  http('comments: create (private team)', 201, 404, 201, 404),
  http('comments: list (public team with the owner only)', 200, 200, 200, 404),
  http('comments: create (public team with the owner only)', 201, 201, 201, 404),
  http('comments: edit own (public team)', 200, 200, 200, 200),
  http("comments: edit other's (public team)", 403, 403, 403, 403),
  http('comments: delete own (public team)', 200, 200, 200, 200),
  http("comments: delete other's (public team)", 200, 200, 403, 403),
  http('comments: resolve (public team)', 200, 200, 200, 200),
  http('comments: unresolve (public team)', 200, 200, 200, 200),
  http('comments: react (public team)', 200, 200, 200, 200),
  http('comments: unreact (public team)', 200, 200, 200, 200),
  http('comments: history (public team)', 200, 200, 200, 200),

  // Attachments follow the issue's team, for every role (a guest attaches in the teams they belong to). The uploader
  // removes their own file; anybody but a guest removes another person's. A file is read through a redirect (302) to a
  // signed URL, minted only for somebody who sees the team.
  http('attachments: init (public team)', 201, 201, 201, 201),
  http('attachments: list (public team)', 200, 200, 200, 200),
  http('attachments: complete (public team)', 200, 200, 200, 200),
  http('attachments: read (public team)', 302, 302, 302, 302),
  http('attachments: remove (public team)', 200, 200, 200, 200),
  http('attachments: init (private team)', 201, 404, 201, 404),
  http('attachments: list (private team)', 200, 404, 200, 404),
  http('attachments: complete (private team)', 200, 404, 200, 404),
  http('attachments: read (private team)', 302, 404, 302, 404),
  http('attachments: remove (private team)', 200, 404, 200, 404),
  http('attachments: init (public team with the owner only)', 201, 201, 201, 404),
  http('attachments: list (public team with the owner only)', 200, 200, 200, 404),
  http('attachments: complete (public team with the owner only)', 200, 200, 200, 404),
  http('attachments: read (public team with the owner only)', 302, 302, 302, 404),
  http('attachments: remove (public team with the owner only)', 200, 200, 200, 404),
  http("attachments: remove other's (public team)", 200, 200, 200, 403),

  // Team documents follow the team: everybody who sees it reads them; anybody but a guest creates, edits and archives
  // them (a guest in the team gets 403).
  http('documents: list (public team)', 200, 200, 200, 200),
  http('documents: create (public team)', 201, 201, 201, 403),
  http('documents: get (public team)', 200, 200, 200, 200),
  http('documents: update (public team)', 200, 200, 200, 403),
  http('documents: archive (public team)', 200, 200, 200, 403),
  http('documents: unarchive (public team)', 200, 200, 200, 403),
  http('documents: revisions (public team)', 200, 200, 200, 200),
  http('documents: list (private team)', 200, 404, 200, 404),
  http('documents: create (private team)', 201, 404, 201, 404),
  http('documents: get (private team)', 200, 404, 200, 404),
  http('documents: update (private team)', 200, 404, 200, 404),
  http('documents: archive (private team)', 200, 404, 200, 404),
  http('documents: unarchive (private team)', 200, 404, 200, 404),
  http('documents: revisions (private team)', 200, 404, 200, 404),
  http('documents: list (public team with the owner only)', 200, 200, 200, 404),
  http('documents: create (public team with the owner only)', 201, 201, 201, 404),
  http('documents: get (public team with the owner only)', 200, 200, 200, 404),
  http('documents: update (public team with the owner only)', 200, 200, 200, 404),
  http('documents: archive (public team with the owner only)', 200, 200, 200, 404),
  http('documents: unarchive (public team with the owner only)', 200, 200, 200, 404),
  http('documents: revisions (public team with the owner only)', 200, 200, 200, 404),

  // Sync shapes: every role reads the team list and the member list (filtered by the server); a team's own shapes
  // follow the visibility of the team.
  // Labels: the workspace's are for owners and admins; a team's for anybody but a guest who sees the team. Everybody
  // reads. Workflow states: owners and admins, for the teams they can see; everybody who sees the team reads them.
  http('labels: list', 200, 200, 200, 200),
  http('labels: create (workspace)', 201, 201, 403, 403),
  http('labels: update (workspace)', 200, 200, 403, 403),
  http('labels: archive (workspace)', 200, 200, 403, 403),
  http('labels: create (public team)', 201, 201, 201, 403),
  http('labels: update (public team)', 200, 200, 200, 403),
  http('labels: archive (public team)', 200, 200, 200, 403),
  http('labels: create (private team)', 201, 404, 201, 404),
  http('labels: update (private team)', 200, 404, 200, 404),
  http('labels: archive (private team)', 200, 404, 200, 404),
  http('labels: create (public team with the owner only)', 201, 201, 201, 404),
  http('labels: update (public team with the owner only)', 200, 200, 200, 404),
  http('labels: archive (public team with the owner only)', 200, 200, 200, 404),
  http('workflow states: list (public team)', 200, 200, 200, 200),
  http('workflow states: create (public team)', 201, 201, 403, 403),
  http('workflow states: update (public team)', 200, 200, 403, 403),
  http('workflow states: archive (public team)', 200, 200, 403, 403),
  http('workflow states: list (private team)', 200, 404, 200, 404),
  http('workflow states: create (private team)', 201, 404, 403, 404),
  http('workflow states: update (private team)', 200, 404, 403, 404),
  http('workflow states: archive (private team)', 200, 404, 403, 404),
  http('workflow states: list (public team with the owner only)', 200, 200, 200, 404),
  http('workflow states: create (public team with the owner only)', 201, 201, 403, 404),
  http('workflow states: update (public team with the owner only)', 200, 200, 403, 404),
  http('workflow states: archive (public team with the owner only)', 200, 200, 403, 404),

  http('sync: teams', 200, 200, 200, 200),
  http('sync: members', 200, 200, 200, 200),
  http('sync: own team memberships', 200, 200, 200, 200),
  http('sync: my issues', 200, 200, 200, 200),
  http('sync: issues (public team)', 200, 200, 200, 200),
  http('sync: workflow states (public team)', 200, 200, 200, 200),
  http('sync: team members (public team)', 200, 200, 200, 200),
  http('sync: issues (private team)', 200, 404, 200, 404),
  http('sync: workflow states (private team)', 200, 404, 200, 404),
  http('sync: team members (private team)', 200, 404, 200, 404),
  http('sync: issues (public team with the owner only)', 200, 200, 200, 404),
  http('sync: workflow states (public team with the owner only)', 200, 200, 200, 404),
  http('sync: team members (public team with the owner only)', 200, 200, 200, 404),

  // The issue model's shapes: the workspace's labels are read by everybody; the rest follows the visibility of the team.
  http('sync: workspace labels', 200, 200, 200, 200),
  http('sync: labels (public team)', 200, 200, 200, 200),
  http('sync: issue labels (public team)', 200, 200, 200, 200),
  http('sync: issue subscribers (public team)', 200, 200, 200, 200),
  http('sync: issue links (public team)', 200, 200, 200, 200),
  http('sync: issue relations (public team)', 200, 200, 200, 200),
  http('sync: issue detail (public team)', 200, 200, 200, 200),
  http('sync: issue activity (public team)', 200, 200, 200, 200),
  http('sync: issue comments (public team)', 200, 200, 200, 200),
  http('sync: issue attachments (public team)', 200, 200, 200, 200),
  http('sync: team documents (public team)', 200, 200, 200, 200),
  http('sync: document content (public team)', 200, 200, 200, 200),
  http('sync: labels (private team)', 200, 404, 200, 404),
  http('sync: issue labels (private team)', 200, 404, 200, 404),
  http('sync: issue subscribers (private team)', 200, 404, 200, 404),
  http('sync: issue links (private team)', 200, 404, 200, 404),
  http('sync: issue relations (private team)', 200, 404, 200, 404),
  http('sync: issue detail (private team)', 200, 404, 200, 404),
  http('sync: issue activity (private team)', 200, 404, 200, 404),
  http('sync: issue comments (private team)', 200, 404, 200, 404),
  http('sync: issue attachments (private team)', 200, 404, 200, 404),
  http('sync: team documents (private team)', 200, 404, 200, 404),
  http('sync: document content (private team)', 200, 404, 200, 404),
  http('sync: labels (public team with the owner only)', 200, 200, 200, 404),
  http('sync: issue labels (public team with the owner only)', 200, 200, 200, 404),
  http('sync: issue subscribers (public team with the owner only)', 200, 200, 200, 404),
  http('sync: issue links (public team with the owner only)', 200, 200, 200, 404),
  http('sync: issue relations (public team with the owner only)', 200, 200, 200, 404),
  http('sync: issue detail (public team with the owner only)', 200, 200, 200, 404),
  http('sync: issue activity (public team with the owner only)', 200, 200, 200, 404),
  http('sync: issue comments (public team with the owner only)', 200, 200, 200, 404),
  http('sync: issue attachments (public team with the owner only)', 200, 200, 200, 404),
  http('sync: team documents (public team with the owner only)', 200, 200, 200, 404),
  http('sync: document content (public team with the owner only)', 200, 200, 200, 404),
];

describe('permission matrix over HTTP: completeness', () => {
  it('every endpoint case has a row', () => {
    const rows = new Set(HTTP_ROWS.map((r) => r.endpoint));
    const missing = ENDPOINTS.map((c) => c.name).filter((name) => !rows.has(name));
    expect(missing, 'endpoint cases without a row').toEqual([]);
  });

  it('every row belongs to an endpoint case', () => {
    const cases = new Set(ENDPOINTS.map((c) => c.name));
    const stale = HTTP_ROWS.map((r) => r.endpoint).filter((name) => !cases.has(name));
    expect(stale, 'rows without an endpoint case').toEqual([]);
  });

  it('there is one row per case and every row names all four roles with a status', () => {
    const names = HTTP_ROWS.map((r) => r.endpoint);
    expect(new Set(names).size).toBe(names.length);
    for (const r of HTTP_ROWS) {
      expect(Object.keys(r.status).sort(), r.endpoint).toEqual([...ROLES].sort());
      for (const role of ROLES) {
        expect([200, 201, 202, 302, 403, 404], `${r.endpoint} as ${role}`).toContain(
          r.status[role],
        );
      }
    }
  });
});

const databaseUrl = process.env.DATABASE_URL;

// Integration: needs the dev compose Postgres (see db.test.ts). Skipped, loudly, when DATABASE_URL is not set.
if (!databaseUrl) {
  console.warn(
    '[matrix.test] SKIPPED the HTTP rows of the permission matrix: DATABASE_URL is not set. ' +
      'Start `docker compose -f docker-compose.dev.yml up -d --wait postgres` and set DATABASE_URL (see .env.example).',
  );
}

describe.skipIf(!databaseUrl)(
  'permission matrix over HTTP: the running app answers what the rows say',
  () => {
    const getDb = useSharedDatabase();
    let world: World;
    beforeAll(async () => {
      world = await createWorld(getDb());
    });

    for (const row of HTTP_ROWS) {
      for (const role of ROLES) {
        it(`${row.endpoint} as ${role}: ${row.status[role]}`, async () => {
          const endpoint = ENDPOINTS.find((c) => c.name === row.endpoint);
          if (!endpoint) throw new Error(`no endpoint case named "${row.endpoint}"`);

          const attempt = await world.attempt(world.a, role, endpoint);
          const res = await world.send(endpoint, attempt.ids, attempt.cookie);

          expect(res.status, `${res.status} ${res.error ?? ''}`).toBe(row.status[role]);
        });
      }
    }
  },
);
