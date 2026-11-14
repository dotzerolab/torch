import type { Actor } from '@torch/shared/permissions';
import { describe, expect, it } from 'vitest';
import {
  MEMBER_COLUMNS,
  membersShape,
  type ShapeDefinition,
  teamMembersShape,
  teamScopedShape,
  teamsShape,
} from './shapes.ts';

const NIL_UUID = '00000000-0000-0000-0000-000000000000';
const WORKSPACE = '11111111-1111-4111-8111-111111111111';
const TEAM_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const TEAM_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const SELF = '22222222-2222-4222-8222-222222222222';
const MEMBER_A = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const MEMBER_B = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';

const actor = (role: Actor['role'], teamIds: string[]): Actor => ({
  workspaceId: WORKSPACE,
  memberId: '22222222-2222-4222-8222-222222222222',
  role,
  teamIds: new Set(teamIds),
});

// Whatever a shape says, its SQL text must be a constant template: only `$n` placeholders, values in params.
function expectParameterised(shape: ShapeDefinition) {
  expect(shape.where).not.toMatch(/['"]/);
  expect(shape.where).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}/i);
  const used = [...shape.where.matchAll(/\$(\d+)/g)].map((m) => Number(m[1]));
  const highest = Math.max(...used);
  expect(shape.params).toHaveLength(highest);
  for (let n = 1; n <= highest; n++) expect(used).toContain(n);
}

describe('teamsShape', () => {
  it('for a guest lists only their teams', () => {
    const shape = teamsShape(actor('guest', [TEAM_B, TEAM_A]));

    expect(shape.table).toBe('team');
    expect(shape.where).toBe('workspace_id = $1 AND id IN ($2, $3)');
    // Sorted, so the same actor always produces the same URL (stable cache key, stable tests).
    expect(shape.params).toEqual([WORKSPACE, TEAM_A, TEAM_B]);
    expectParameterised(shape);
  });

  it('for a member adds public teams to their own', () => {
    const shape = teamsShape(actor('member', [TEAM_A]));

    expect(shape.where).toBe('workspace_id = $1 AND (private = false OR id IN ($2))');
    expect(shape.params).toEqual([WORKSPACE, TEAM_A]);
    expectParameterised(shape);
  });

  it('owners and admins get the same filter as members (private teams stay members-only)', () => {
    for (const role of ['owner', 'admin'] as const) {
      const shape = teamsShape(actor(role, [TEAM_A, TEAM_B]));

      expect(shape.where).toBe('workspace_id = $1 AND (private = false OR id IN ($2, $3))');
      expect(shape.params).toEqual([WORKSPACE, TEAM_A, TEAM_B]);
    }
  });

  it('an empty team list uses the nil uuid so the IN list is never empty', () => {
    const guest = teamsShape(actor('guest', []));
    const member = teamsShape(actor('member', []));

    expect(guest.where).toBe('workspace_id = $1 AND id IN ($2)');
    expect(guest.params).toEqual([WORKSPACE, NIL_UUID]);
    expect(member.where).toBe('workspace_id = $1 AND (private = false OR id IN ($2))');
    expect(member.params).toEqual([WORKSPACE, NIL_UUID]);
  });

  it('selects only the columns the client needs', () => {
    expect(teamsShape(actor('member', [])).columns).toEqual([
      'id',
      'workspace_id',
      'key',
      'name',
      'private',
    ]);
  });

  it('never interpolates ids into the SQL text', () => {
    expectParameterised(teamsShape(actor('guest', [TEAM_A, TEAM_B])));
    expectParameterised(teamsShape(actor('member', [])));
  });
});

describe('teamScopedShape', () => {
  it('issues: one shape per team, bound by parameter', () => {
    const shape = teamScopedShape('issues', TEAM_A);

    expect(shape.table).toBe('issue');
    expect(shape.where).toBe('team_id = $1');
    expect(shape.params).toEqual([TEAM_A]);
    expectParameterised(shape);
  });

  it('issue shape columns never include description', () => {
    const { columns } = teamScopedShape('issues', TEAM_A);

    expect(columns).not.toContain('description');
    expect(columns).toEqual([
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
    ]);
  });

  it('workflow states: one shape per team with the state columns', () => {
    const shape = teamScopedShape('workflow_states', TEAM_B);

    expect(shape.table).toBe('workflow_state');
    expect(shape.where).toBe('team_id = $1');
    expect(shape.params).toEqual([TEAM_B]);
    expect(shape.columns).toEqual([
      'id',
      'workspace_id',
      'team_id',
      'name',
      'type',
      'position',
      'color',
    ]);
  });
});

describe('membersShape', () => {
  it('MEMBER_COLUMNS is the pinned allowlist and never holds email or timezone', () => {
    expect(MEMBER_COLUMNS).toEqual([
      'id',
      'workspace_id',
      'name',
      'handle',
      'role',
      'locale',
      'deactivated_at',
      'created_at',
    ]);
    expect(MEMBER_COLUMNS).not.toContain('email');
    expect(MEMBER_COLUMNS).not.toContain('timezone');
  });

  it('is built on the member table with exactly the allowlist as columns', () => {
    for (const visible of ['all', [SELF]] as const) {
      const shape = membersShape(actor(visible === 'all' ? 'member' : 'guest', []), visible);

      expect(shape.table).toBe('member');
      expect(shape.columns).toEqual([...MEMBER_COLUMNS]);
      expect(shape.columns).not.toContain('email');
      expect(shape.columns).not.toContain('timezone');
    }
  });

  it('non-guests get the whole workspace: one parameter, no id list', () => {
    for (const role of ['owner', 'admin', 'member'] as const) {
      const shape = membersShape(actor(role, [TEAM_A]), 'all');

      expect(shape.where).toBe('workspace_id = $1');
      expect(shape.where).not.toMatch(/\bid IN\b/i);
      expect(shape.params).toEqual([WORKSPACE]);
      expectParameterised(shape);
    }
  });

  it('a guest lists exactly the ids given, sorted, as parameters only', () => {
    const shape = membersShape(actor('guest', [TEAM_A]), [MEMBER_B, SELF, MEMBER_A]);

    expect(shape.where).toBe('workspace_id = $1 AND id IN ($2, $3, $4)');
    // '2222...' < 'cccc...' < 'dddd...'
    expect(shape.params).toEqual([WORKSPACE, SELF, MEMBER_A, MEMBER_B]);
    expectParameterised(shape);
    // No id ever appears inside the SQL text.
    for (const id of [SELF, MEMBER_A, MEMBER_B]) expect(shape.where).not.toContain(id);
  });

  it('duplicate ids collapse to one parameter', () => {
    const shape = membersShape(actor('guest', [TEAM_A]), [MEMBER_A, MEMBER_A, SELF]);

    expect(shape.where).toBe('workspace_id = $1 AND id IN ($2, $3)');
    expect(shape.params).toEqual([WORKSPACE, SELF, MEMBER_A]);
  });

  it('an empty guest list uses the nil uuid so the IN list is never empty', () => {
    const shape = membersShape(actor('guest', []), []);

    expect(shape.where).toBe('workspace_id = $1 AND id IN ($2)');
    expect(shape.params).toEqual([WORKSPACE, NIL_UUID]);
    expectParameterised(shape);
  });

  it('the workspace id comes from the actor', () => {
    expect(membersShape(actor('member', []), 'all').params[0]).toBe(WORKSPACE);
    expect(membersShape(actor('guest', []), [SELF]).params[0]).toBe(WORKSPACE);
  });

  it('refuses the whole-workspace shape for a guest (fail closed)', () => {
    expect(() => membersShape(actor('guest', [TEAM_A]), 'all')).toThrow();
  });
});

describe('teamMembersShape', () => {
  it('one shape per team on team_member, bound by params[1] only', () => {
    const shape = teamMembersShape(TEAM_A);

    expect(shape.table).toBe('team_member');
    expect(shape.where).toBe('team_id = $1');
    expect(shape.params).toEqual([TEAM_A]);
    expect(shape.columns).toEqual(['team_id', 'member_id', 'workspace_id', 'created_at']);
    expectParameterised(shape);
  });
});
