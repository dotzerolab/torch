import { describe, expect, it } from 'vitest';
import {
  ADMIN_ERROR_CODES,
  inviteAcceptInput,
  inviteCreateInput,
  inviteTokenInput,
  memberRoleInput,
  profileUpdateInput,
  slugifyHandle,
  teamCreateInput,
  teamMemberInput,
  teamUpdateInput,
} from './admin.ts';

const ID = '3f2b8c1e-9d4a-4e6b-8a7c-1b2d3e4f5a6b';
const ID_2 = '4f2b8c1e-9d4a-4e6b-8a7c-1b2d3e4f5a6b';

describe('ADMIN_ERROR_CODES', () => {
  it('is the full list of refusals an admin call can answer', () => {
    expect([...ADMIN_ERROR_CODES]).toEqual([
      'unauthenticated',
      'forbidden',
      'not_found',
      'invalid_input',
      'last_owner',
      'already_member',
      'invite_pending',
      'invite_invalid',
      'team_key_taken',
      'handle_taken',
      'private_team_needs_member',
      'rate_limited',
    ]);
  });
});

describe('memberRoleInput', () => {
  it('accepts each of the four roles', () => {
    for (const role of ['owner', 'admin', 'member', 'guest']) {
      expect(memberRoleInput.safeParse({ role }).success, role).toBe(true);
    }
  });

  it('rejects an unknown role, a missing role and unknown keys', () => {
    expect(memberRoleInput.safeParse({ role: 'superuser' }).success).toBe(false);
    expect(memberRoleInput.safeParse({}).success).toBe(false);
    expect(memberRoleInput.safeParse({ role: 'member', memberId: ID }).success).toBe(false);
  });
});

describe('profileUpdateInput', () => {
  it('accepts each field on its own', () => {
    expect(profileUpdateInput.safeParse({ name: 'Ada Lovelace' }).success).toBe(true);
    expect(profileUpdateInput.safeParse({ handle: 'ada' }).success).toBe(true);
    expect(profileUpdateInput.safeParse({ handle: 'ada_l-2' }).success).toBe(true);
    expect(profileUpdateInput.safeParse({ locale: 'it' }).success).toBe(true);
    expect(profileUpdateInput.safeParse({ timezone: 'Europe/Rome' }).success).toBe(true);
    expect(profileUpdateInput.safeParse({ timezone: 'UTC' }).success).toBe(true);
  });

  it('rejects an empty object and unknown keys (role, email and id are not profile fields)', () => {
    expect(profileUpdateInput.safeParse({}).success).toBe(false);
    for (const field of ['role', 'email', 'id', 'workspaceId', 'deactivatedAt']) {
      expect(profileUpdateInput.safeParse({ name: 'Ada', [field]: 'x' }).success, field).toBe(
        false,
      );
    }
  });

  it('trims the name and bounds it to 1..80', () => {
    expect(profileUpdateInput.parse({ name: '  Ada  ' })).toEqual({ name: 'Ada' });
    expect(profileUpdateInput.safeParse({ name: '   ' }).success).toBe(false);
    expect(profileUpdateInput.safeParse({ name: 'x'.repeat(80) }).success).toBe(true);
    expect(profileUpdateInput.safeParse({ name: 'x'.repeat(81) }).success).toBe(false);
  });

  it('handles are 2 to 32 characters of lower-case letters, digits, underscore and hyphen', () => {
    for (const bad of [
      'a',
      '-ada',
      '_ada',
      'Ada',
      'ada lovelace',
      'ada.l',
      'x'.repeat(33),
      'àda',
    ]) {
      expect(profileUpdateInput.safeParse({ handle: bad }).success, bad).toBe(false);
    }
    expect(profileUpdateInput.safeParse({ handle: 'x'.repeat(32) }).success).toBe(true);
  });

  it('only en and it are languages', () => {
    expect(profileUpdateInput.safeParse({ locale: 'fr' }).success).toBe(false);
  });

  it('timezone must be a real IANA zone', () => {
    for (const bad of ['Mars/Base', '', 'rome', '+01:00', '12:00']) {
      expect(profileUpdateInput.safeParse({ timezone: bad }).success, bad).toBe(false);
    }
  });
});

describe('teamCreateInput', () => {
  it('accepts a key, a name and an optional privacy flag', () => {
    expect(teamCreateInput.parse({ key: 'ENG', name: 'Engineering' })).toEqual({
      key: 'ENG',
      name: 'Engineering',
    });
    expect(teamCreateInput.parse({ key: 'OPS', name: ' Operations ', private: true })).toEqual({
      key: 'OPS',
      name: 'Operations',
      private: true,
    });
  });

  it('keys are 1 to 7 upper-case letters or digits starting with a letter (same rule as the database)', () => {
    for (const bad of ['eng', 'Eng', '1ENG', 'ENG-1', '', 'ABCDEFGH', ' ENG']) {
      expect(teamCreateInput.safeParse({ key: bad, name: 'x' }).success, bad).toBe(false);
    }
    expect(teamCreateInput.safeParse({ key: 'A', name: 'x' }).success).toBe(true);
    expect(teamCreateInput.safeParse({ key: 'ABCDEF1', name: 'x' }).success).toBe(true);
  });

  it('rejects an empty or too long name and unknown keys', () => {
    expect(teamCreateInput.safeParse({ key: 'ENG', name: '  ' }).success).toBe(false);
    expect(teamCreateInput.safeParse({ key: 'ENG', name: 'x'.repeat(81) }).success).toBe(false);
    expect(teamCreateInput.safeParse({ key: 'ENG', name: 'x', workspaceId: ID }).success).toBe(
      false,
    );
  });
});

describe('teamUpdateInput', () => {
  it('accepts a new name, a privacy toggle, or both', () => {
    expect(teamUpdateInput.safeParse({ name: 'Platform' }).success).toBe(true);
    expect(teamUpdateInput.safeParse({ private: false }).success).toBe(true);
    expect(teamUpdateInput.safeParse({ name: 'Platform', private: true }).success).toBe(true);
  });

  it('rejects an empty object', () => {
    expect(teamUpdateInput.safeParse({}).success).toBe(false);
  });

  it('keys are immutable: `key` is an unknown field, as is anything else', () => {
    expect(teamUpdateInput.safeParse({ key: 'NEW' }).success).toBe(false);
    expect(teamUpdateInput.safeParse({ name: 'Platform', key: 'NEW' }).success).toBe(false);
    expect(teamUpdateInput.safeParse({ name: 'Platform', issueCounter: 0 }).success).toBe(false);
  });
});

describe('teamMemberInput', () => {
  it('needs a member id that is a uuid', () => {
    expect(teamMemberInput.safeParse({ memberId: ID }).success).toBe(true);
    expect(teamMemberInput.safeParse({ memberId: 'ada' }).success).toBe(false);
    expect(teamMemberInput.safeParse({}).success).toBe(false);
    expect(teamMemberInput.safeParse({ memberId: ID, teamId: ID_2 }).success).toBe(false);
  });
});

describe('inviteCreateInput', () => {
  const valid = { email: 'new@example.test', role: 'member', teamIds: [ID] };

  it('accepts a valid invite and defaults nothing that the caller did not send', () => {
    expect(inviteCreateInput.parse(valid)).toEqual(valid);
    expect(inviteCreateInput.parse({ ...valid, locale: 'it' })).toEqual({ ...valid, locale: 'it' });
    expect(inviteCreateInput.safeParse({ ...valid, teamIds: [] }).success).toBe(true);
  });

  it('trims and lower-cases the email', () => {
    const parsed = inviteCreateInput.parse({ ...valid, email: '  New.Person@Example.TEST ' });

    expect(parsed.email).toBe('new.person@example.test');
  });

  it('rejects a malformed or over-long email', () => {
    for (const bad of ['', 'nobody', 'a@', '@example.test', 'a b@example.test']) {
      expect(inviteCreateInput.safeParse({ ...valid, email: bad }).success, bad).toBe(false);
    }
    const tooLong = `${'a'.repeat(250)}@example.test`;
    expect(inviteCreateInput.safeParse({ ...valid, email: tooLong }).success).toBe(false);
  });

  it('rejects an unknown role and unknown keys', () => {
    expect(inviteCreateInput.safeParse({ ...valid, role: 'root' }).success).toBe(false);
    expect(inviteCreateInput.safeParse({ ...valid, invitedBy: ID }).success).toBe(false);
  });

  it('at most 20 team ids, no duplicates (whatever the case), each a uuid', () => {
    const ids = Array.from(
      { length: 21 },
      (_, i) => `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`,
    );

    expect(inviteCreateInput.safeParse({ ...valid, teamIds: ids.slice(0, 20) }).success).toBe(true);
    expect(inviteCreateInput.safeParse({ ...valid, teamIds: ids }).success).toBe(false);
    expect(inviteCreateInput.safeParse({ ...valid, teamIds: [ID, ID] }).success).toBe(false);
    expect(inviteCreateInput.safeParse({ ...valid, teamIds: [ID, ID.toUpperCase()] }).success).toBe(
      false,
    );
    expect(inviteCreateInput.safeParse({ ...valid, teamIds: ['not-a-uuid'] }).success).toBe(false);
  });

  it('team ids come back lower-case', () => {
    const parsed = inviteCreateInput.parse({ ...valid, teamIds: [ID.toUpperCase()] });

    expect(parsed.teamIds).toEqual([ID]);
  });
});

describe('inviteTokenInput and inviteAcceptInput', () => {
  it('a token is a non-empty string and nothing else is accepted next to it', () => {
    expect(inviteTokenInput.safeParse({ token: 'abc' }).success).toBe(true);
    expect(inviteTokenInput.safeParse({ token: '' }).success).toBe(false);
    expect(inviteTokenInput.safeParse({}).success).toBe(false);
    expect(inviteTokenInput.safeParse({ token: 'abc', role: 'owner' }).success).toBe(false);
  });

  it('accepting needs the token and a name of 1..80 characters, trimmed', () => {
    expect(inviteAcceptInput.parse({ token: 'abc', name: '  Ada  ' })).toEqual({
      token: 'abc',
      name: 'Ada',
    });
    expect(inviteAcceptInput.safeParse({ token: 'abc', name: ' ' }).success).toBe(false);
    expect(inviteAcceptInput.safeParse({ token: 'abc', name: 'x'.repeat(81) }).success).toBe(false);
    expect(inviteAcceptInput.safeParse({ name: 'Ada' }).success).toBe(false);
    expect(inviteAcceptInput.safeParse({ token: 'abc', name: 'Ada', role: 'owner' }).success).toBe(
      false,
    );
  });
});

describe('slugifyHandle', () => {
  it.each([
    ['Ada Lovelace', 'ada-lovelace'],
    ['  Èrik  Ünal ', 'erik-unal'],
    ['日本', 'user'],
    ['a', 'user'],
    ['', 'user'],
    ['---', 'user'],
    ['Ana_Maria  --  Rossi', 'ana_maria-rossi'],
    ["O'Brien", 'obrien'],
  ])('%j gives %j', (name, expected) => {
    expect(slugifyHandle(name)).toBe(expected);
  });

  it('caps a long name at 28 characters without a trailing hyphen', () => {
    const handle = slugifyHandle('x'.repeat(60));

    expect(handle).toBe('x'.repeat(28));
    expect(slugifyHandle(`${'x'.repeat(27)} yyyy`)).toBe('x'.repeat(27));
  });

  it('always produces a handle that profileUpdateInput accepts', () => {
    for (const name of [
      'Ada Lovelace',
      'Èrik Ünal',
      '日本',
      'a',
      '_x_',
      'Ana_Maria -- Rossi',
      '9lives',
    ]) {
      expect(profileUpdateInput.safeParse({ handle: slugifyHandle(name) }).success, name).toBe(
        true,
      );
    }
  });
});
