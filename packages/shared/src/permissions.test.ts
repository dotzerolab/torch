import { describe, expect, it } from 'vitest';
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
  type Role,
  type TeamAccess,
  visibleTeamIds,
  wouldLeaveNoOwner,
} from './permissions.ts';

const WORKSPACE = '00000000-0000-4000-8000-000000000001';
const OTHER_WORKSPACE = '00000000-0000-4000-8000-000000000002';
const TEAM = '10000000-0000-4000-8000-000000000001';

const actor = (role: Role, teamIds: string[], workspaceId = WORKSPACE): Actor => ({
  workspaceId,
  memberId: '20000000-0000-4000-8000-000000000001',
  role,
  teamIds: new Set(teamIds),
});
const team = (over: Partial<TeamAccess> = {}): TeamAccess => ({
  id: TEAM,
  workspaceId: WORKSPACE,
  private: false,
  ...over,
});

// role x {public, private team} x {member of the team, not a member} -> can the actor see it?
const MATRIX: [Role, boolean, boolean, boolean][] = [
  ['owner', false, true, true],
  ['owner', false, false, true],
  ['owner', true, true, true],
  ['owner', true, false, false],
  ['admin', false, true, true],
  ['admin', false, false, true],
  ['admin', true, true, true],
  ['admin', true, false, false],
  ['member', false, true, true],
  ['member', false, false, true],
  ['member', true, true, true],
  ['member', true, false, false],
  ['guest', false, true, true],
  ['guest', false, false, false],
  ['guest', true, true, true],
  ['guest', true, false, false],
];

describe('canSeeTeam', () => {
  it.each(MATRIX)('%s, private=%s, in team=%s -> %s', (role, isPrivate, inTeam, expected) => {
    const result = canSeeTeam(actor(role, inTeam ? [TEAM] : []), team({ private: isPrivate }));

    expect(result).toBe(expected);
  });

  it.each(['owner', 'admin', 'member', 'guest'] as const)(
    'every role is denied a team of another workspace (%s)',
    (role) => {
      const other = team({ workspaceId: OTHER_WORKSPACE });

      // Even with the team id in the actor's own list: the workspace check comes first.
      expect(canSeeTeam(actor(role, [TEAM]), other)).toBe(false);
      expect(canEditIssues(actor(role, [TEAM]), other)).toBe(false);
    },
  );
});

describe('canEditIssues', () => {
  it.each(MATRIX)(
    '%s, private=%s, in team=%s -> %s (same as canSeeTeam in P0d)',
    (role, isPrivate, inTeam, expected) => {
      const result = canEditIssues(actor(role, inTeam ? [TEAM] : []), team({ private: isPrivate }));

      expect(result).toBe(expected);
    },
  );
});

describe('visibleTeamIds', () => {
  it('keeps input order and drops what the actor cannot see', () => {
    const teams: TeamAccess[] = [
      team({ id: 'c', private: false }),
      team({ id: 'b', private: true }),
      team({ id: 'a', private: true }),
      team({ id: 'z', private: false, workspaceId: OTHER_WORKSPACE }),
      team({ id: 'd', private: false }),
    ];

    expect(visibleTeamIds(actor('member', ['a']), teams)).toEqual(['c', 'a', 'd']);
    expect(visibleTeamIds(actor('guest', ['a']), teams)).toEqual(['a']);
    expect(visibleTeamIds(actor('owner', []), teams)).toEqual(['c', 'd']);
  });

  it('returns an empty list for no teams', () => {
    expect(visibleTeamIds(actor('owner', []), [])).toEqual([]);
  });
});

// ---- P1b: roles, guests and member administration (spec §6; expectations written out by hand) ----

const ROLES: Role[] = ['owner', 'admin', 'member', 'guest'];
const SELF = '20000000-0000-4000-8000-000000000001';
const OTHER_MEMBER = '20000000-0000-4000-8000-000000000002';

const target = (role: Role, over: Partial<{ id: string; workspaceId: string }> = {}) => ({
  id: OTHER_MEMBER,
  workspaceId: WORKSPACE,
  role,
  ...over,
});

describe('OBJECT_TYPES', () => {
  it('lists every object a permission decision is about', () => {
    expect([...OBJECT_TYPES]).toEqual(['member', 'invite', 'team', 'team_membership', 'issue']);
  });
});

describe('canManageMembers, canManageTeams, canSeeMemberEmail, canListPrivateTeams', () => {
  // role -> allowed. Only owners and admins administer people and teams, see emails and list private teams.
  const ONLY_OWNER_AND_ADMIN: [Role, boolean][] = [
    ['owner', true],
    ['admin', true],
    ['member', false],
    ['guest', false],
  ];

  it.each(ONLY_OWNER_AND_ADMIN)('canManageMembers: %s -> %s', (role, expected) => {
    expect(canManageMembers(actor(role, []))).toBe(expected);
  });
  it.each(ONLY_OWNER_AND_ADMIN)(
    'canManageTeams (create and edit teams): %s -> %s',
    (role, expected) => {
      expect(canManageTeams(actor(role, []))).toBe(expected);
    },
  );
  it.each(ONLY_OWNER_AND_ADMIN)('canSeeMemberEmail: %s -> %s', (role, expected) => {
    expect(canSeeMemberEmail(actor(role, []))).toBe(expected);
  });
  it.each(ONLY_OWNER_AND_ADMIN)('canListPrivateTeams: %s -> %s', (role, expected) => {
    expect(canListPrivateTeams(actor(role, []))).toBe(expected);
  });
});

describe('canGrantRole', () => {
  // actor role, role to grant -> allowed. Only an owner grants admin or owner.
  const TABLE: [Role, Role, boolean][] = [
    ['owner', 'owner', true],
    ['owner', 'admin', true],
    ['owner', 'member', true],
    ['owner', 'guest', true],
    ['admin', 'owner', false],
    ['admin', 'admin', false],
    ['admin', 'member', true],
    ['admin', 'guest', true],
    ['member', 'owner', false],
    ['member', 'admin', false],
    ['member', 'member', false],
    ['member', 'guest', false],
    ['guest', 'owner', false],
    ['guest', 'admin', false],
    ['guest', 'member', false],
    ['guest', 'guest', false],
  ];

  it.each(TABLE)('%s grants %s -> %s', (actorRole, granted, expected) => {
    expect(canGrantRole(actor(actorRole, []), granted)).toBe(expected);
  });
});

describe('canChangeMemberRole', () => {
  // actor role, target current role, new role -> allowed (target is another member of the same workspace).
  const TABLE: [Role, Role, Role, boolean][] = [
    ['owner', 'admin', 'owner', true],
    ['owner', 'owner', 'admin', true],
    ['owner', 'member', 'admin', true],
    ['owner', 'admin', 'guest', true],
    ['admin', 'member', 'guest', true],
    ['admin', 'guest', 'member', true],
    ['admin', 'member', 'admin', false],
    ['admin', 'guest', 'owner', false],
    ['admin', 'admin', 'member', false],
    ['admin', 'owner', 'member', false],
    ['admin', 'owner', 'admin', false],
    ['member', 'guest', 'member', false],
    ['member', 'member', 'guest', false],
    ['guest', 'member', 'guest', false],
  ];

  it.each(TABLE)('%s changes a %s to %s -> %s', (actorRole, current, next, expected) => {
    expect(canChangeMemberRole(actor(actorRole, []), target(current), next)).toBe(expected);
  });

  it.each(ROLES)('a %s can never change their own role, whatever the new role', (role) => {
    for (const next of ROLES) {
      expect(canChangeMemberRole(actor(role, []), target(role, { id: SELF }), next)).toBe(false);
    }
  });

  it.each(ROLES)('a %s can never change the role of a member of another workspace', (role) => {
    const foreign = target('member', { workspaceId: OTHER_WORKSPACE });
    for (const next of ROLES) {
      expect(canChangeMemberRole(actor(role, []), foreign, next)).toBe(false);
    }
  });
});

describe('canDeactivateMember', () => {
  // actor role, target role -> allowed. Reactivation follows the same rule.
  const TABLE: [Role, Role, boolean][] = [
    ['owner', 'owner', true],
    ['owner', 'admin', true],
    ['owner', 'member', true],
    ['owner', 'guest', true],
    ['admin', 'owner', false],
    ['admin', 'admin', false],
    ['admin', 'member', true],
    ['admin', 'guest', true],
    ['member', 'guest', false],
    ['member', 'member', false],
    ['guest', 'guest', false],
  ];

  it.each(TABLE)('%s deactivates a %s -> %s', (actorRole, targetRole, expected) => {
    expect(canDeactivateMember(actor(actorRole, []), target(targetRole))).toBe(expected);
  });

  it.each(ROLES)('a %s can never deactivate themselves', (role) => {
    expect(canDeactivateMember(actor(role, []), target(role, { id: SELF }))).toBe(false);
  });

  it.each(ROLES)('a %s can never deactivate a member of another workspace', (role) => {
    expect(
      canDeactivateMember(actor(role, []), target('guest', { workspaceId: OTHER_WORKSPACE })),
    ).toBe(false);
  });
});

describe('wouldLeaveNoOwner (the last-owner rule; the service passes the count it read under lock)', () => {
  it('an owner demoted or deactivated while being the only active owner leaves nobody', () => {
    expect(wouldLeaveNoOwner(1, { role: 'owner' }, { kind: 'role', role: 'admin' })).toBe(true);
    expect(wouldLeaveNoOwner(1, { role: 'owner' }, { kind: 'role', role: 'guest' })).toBe(true);
    expect(wouldLeaveNoOwner(1, { role: 'owner' }, { kind: 'deactivate' })).toBe(true);
  });

  it('two or more active owners: one may step down or be deactivated', () => {
    expect(wouldLeaveNoOwner(2, { role: 'owner' }, { kind: 'role', role: 'admin' })).toBe(false);
    expect(wouldLeaveNoOwner(2, { role: 'owner' }, { kind: 'deactivate' })).toBe(false);
  });

  it('keeping the owner role, or touching somebody who is not an owner, never empties the workspace', () => {
    expect(wouldLeaveNoOwner(1, { role: 'owner' }, { kind: 'role', role: 'owner' })).toBe(false);
    expect(wouldLeaveNoOwner(1, { role: 'admin' }, { kind: 'role', role: 'owner' })).toBe(false);
    expect(wouldLeaveNoOwner(1, { role: 'member' }, { kind: 'deactivate' })).toBe(false);
  });

  it('a count of zero (already broken) still refuses to remove an owner', () => {
    expect(wouldLeaveNoOwner(0, { role: 'owner' }, { kind: 'deactivate' })).toBe(true);
  });
});

describe('canManageTeamMembership (add or remove people of a team the actor can see)', () => {
  // role, private, actor in team -> allowed. Owner and admin only, and only where they can see the team.
  const TABLE: [Role, boolean, boolean, boolean][] = [
    ['owner', false, true, true],
    ['owner', false, false, true],
    ['owner', true, true, true],
    ['owner', true, false, false],
    ['admin', false, true, true],
    ['admin', false, false, true],
    ['admin', true, true, true],
    ['admin', true, false, false],
    ['member', false, true, false],
    ['member', false, false, false],
    ['member', true, true, false],
    ['member', true, false, false],
    ['guest', false, true, false],
    ['guest', false, false, false],
    ['guest', true, true, false],
    ['guest', true, false, false],
  ];

  it.each(TABLE)('%s, private=%s, in team=%s -> %s', (role, isPrivate, inTeam, expected) => {
    const result = canManageTeamMembership(
      actor(role, inTeam ? [TEAM] : []),
      team({ private: isPrivate }),
    );

    expect(result).toBe(expected);
  });

  it.each(ROLES)('%s: a team of another workspace is never manageable', (role) => {
    expect(
      canManageTeamMembership(actor(role, [TEAM]), team({ workspaceId: OTHER_WORKSPACE })),
    ).toBe(false);
  });
});

describe('canAddSelfToTeam (owner or admin joins any team of their workspace, private ones included)', () => {
  // role, private, actor in team -> allowed. The audit entry `team.admin_joined` is the service's job.
  const TABLE: [Role, boolean, boolean, boolean][] = [
    ['owner', false, false, true],
    ['owner', true, false, true],
    ['owner', true, true, true],
    ['admin', false, false, true],
    ['admin', true, false, true],
    ['admin', true, true, true],
    ['member', false, false, false],
    ['member', true, false, false],
    ['guest', false, false, false],
    ['guest', true, false, false],
  ];

  it.each(TABLE)('%s, private=%s, in team=%s -> %s', (role, isPrivate, inTeam, expected) => {
    expect(canAddSelfToTeam(actor(role, inTeam ? [TEAM] : []), team({ private: isPrivate }))).toBe(
      expected,
    );
  });

  it.each(ROLES)('%s: a team of another workspace is never joinable', (role) => {
    expect(canAddSelfToTeam(actor(role, [TEAM]), team({ workspaceId: OTHER_WORKSPACE }))).toBe(
      false,
    );
  });

  it('joining does not open the issues: seeing the team still needs membership', () => {
    const admin = actor('admin', []);
    const secret = team({ private: true });

    expect(canAddSelfToTeam(admin, secret)).toBe(true);
    expect(canSeeTeam(admin, secret)).toBe(false);
    expect(canEditIssues(admin, secret)).toBe(false);
  });
});

describe('canSeeMember', () => {
  const view = (
    actorRole: Role,
    actorTeams: string[],
    over: {
      id?: string;
      workspaceId?: string;
      teamIds?: string[];
    } = {},
  ) =>
    canSeeMember(actor(actorRole, actorTeams), {
      id: over.id ?? OTHER_MEMBER,
      workspaceId: over.workspaceId ?? WORKSPACE,
      teamIds: new Set(over.teamIds ?? []),
    });

  it.each(['owner', 'admin', 'member'] as const)(
    'a %s sees every member of the workspace, in a shared team or not',
    (role) => {
      expect(view(role, [], { teamIds: [] })).toBe(true);
      expect(view(role, [TEAM], { teamIds: [TEAM] })).toBe(true);
    },
  );

  it('a guest sees a member who shares a team with them', () => {
    expect(view('guest', [TEAM], { teamIds: [TEAM, 'other'] })).toBe(true);
  });

  it('a guest does not see a member who shares no team with them', () => {
    expect(view('guest', [TEAM], { teamIds: ['other'] })).toBe(false);
    expect(view('guest', [TEAM], { teamIds: [] })).toBe(false);
    expect(view('guest', [], { teamIds: [TEAM] })).toBe(false);
  });

  it('a guest always sees themselves, even with no team', () => {
    expect(view('guest', [], { id: SELF, teamIds: [] })).toBe(true);
  });

  it.each(ROLES)('a %s never sees a member of another workspace', (role) => {
    expect(view(role, [TEAM], { workspaceId: OTHER_WORKSPACE, teamIds: [TEAM] })).toBe(false);
    // Same member id as the actor's own, but in another workspace: still no.
    expect(view(role, [TEAM], { id: SELF, workspaceId: OTHER_WORKSPACE, teamIds: [TEAM] })).toBe(
      false,
    );
  });
});
