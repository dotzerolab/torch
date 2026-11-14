// The permission matrix: every role x object x action, written out by hand from the spec (§6) and the
// decisions of the project, then evaluated against the real functions of the shared permission module.
// The expectations are NOT computed from the code under test: change a rule and this file has to change
// with it, on purpose.
//
// Adding an object type (OBJECT_TYPES) fails `typecheck` until `MATRIX` and `EVALUATORS` have an entry for
// it, and fails the completeness tests below until it has rows. Later sub-phases append their objects here.
import {
  type Actor,
  canAddSelfToTeam,
  canChangeMemberRole,
  canDeactivateMember,
  canEditIssues,
  canGrantRole,
  canListPrivateTeams,
  canManageMembers,
  canManageTeamMembership,
  canManageTeams,
  canSeeMember,
  canSeeMemberEmail,
  canSeeTeam,
  OBJECT_TYPES,
  type ObjectType,
  type Role,
  type TeamAccess,
} from '@torch/shared/permissions';
import { describe, expect, it } from 'vitest';

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
  'team: create',
  'team: list private directory',
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
