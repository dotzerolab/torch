import type { Actor } from '@torch/shared/permissions';
import { describe, expect, it } from 'vitest';
import { assignableRoles, roleChoices } from './access.ts';

const actor = (role: Actor['role'], memberId = 'me'): Actor => ({
  workspaceId: 'w1',
  memberId,
  role,
  teamIds: new Set(),
});
const target = (role: Actor['role'], id = 'other') => ({ id, workspaceId: 'w1', role });

describe('assignableRoles', () => {
  it('lets an owner hand out every role', () => {
    expect(assignableRoles(actor('owner'))).toEqual(['owner', 'admin', 'member', 'guest']);
  });

  it('lets an admin hand out member and guest only', () => {
    expect(assignableRoles(actor('admin'))).toEqual(['member', 'guest']);
  });

  it('gives a member or a guest nothing to hand out', () => {
    expect(assignableRoles(actor('member'))).toEqual([]);
    expect(assignableRoles(actor('guest'))).toEqual([]);
  });
});

describe('roleChoices', () => {
  it('offers an admin member and guest on a member, and lets them change it', () => {
    expect(roleChoices(actor('admin'), target('member'))).toEqual({
      roles: ['member', 'guest'],
      editable: true,
    });
  });

  it('offers an owner all four roles on anybody else', () => {
    expect(roleChoices(actor('owner'), target('guest'))).toEqual({
      roles: ['owner', 'admin', 'member', 'guest'],
      editable: true,
    });
  });

  it('freezes the own row, whatever the role', () => {
    expect(roleChoices(actor('owner', 'me'), target('owner', 'me'))).toEqual({
      roles: ['owner'],
      editable: false,
    });
  });

  it('freezes an admin or an owner for an admin: only the owner moves them', () => {
    expect(roleChoices(actor('admin'), target('admin'))).toEqual({
      roles: ['admin'],
      editable: false,
    });
    expect(roleChoices(actor('admin'), target('owner'))).toEqual({
      roles: ['owner'],
      editable: false,
    });
  });
});
