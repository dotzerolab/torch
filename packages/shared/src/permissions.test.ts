import { describe, expect, it } from 'vitest';
import {
  type Actor,
  canEditIssues,
  canSeeTeam,
  type Role,
  type TeamAccess,
  visibleTeamIds,
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
