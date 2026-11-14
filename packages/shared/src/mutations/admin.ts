// What a client may send to administer members, teams and invites, and the refusals those calls can answer.
// Shared so the web validates before sending and the server validates what arrives.
// No Node imports: this file reaches the browser bundle.
import { z } from 'zod';
import { MEMBER_LOCALES, MEMBER_ROLES } from '../db/enums.ts';

/**
 * The refusals of an admin call. The status is the service's to choose (400, 401, 403, 404, 409, 429); an id that
 * is not in the caller's workspace or not visible to them is always `not_found`, never `forbidden`.
 */
export const ADMIN_ERROR_CODES = [
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
] as const;
export type AdminErrorCode = (typeof ADMIN_ERROR_CODES)[number];

const name = z.string().trim().min(1).max(80);
const locale = z.enum(MEMBER_LOCALES);
const role = z.enum(MEMBER_ROLES);
/** An id from a request: any case is accepted, the stored lower-case form is what the code compares. */
const id = z.guid().toLowerCase();

/** An IANA zone name such as `Europe/Rome` or `UTC`; offsets (`+01:00`) and abbreviations are not zones. */
function isTimeZone(value: string): boolean {
  if (!/^[A-Za-z][A-Za-z0-9_+-]*(\/[A-Za-z0-9_+-]+)*$/.test(value)) return false;
  try {
    new Intl.DateTimeFormat('en', { timeZone: value });
    return true;
  } catch {
    return false;
  }
}

const hasAField = (input: Record<string, unknown>) =>
  Object.values(input).some((value) => value !== undefined);
const AT_LEAST_ONE = { message: 'at least one field is required' };

/** Change a member's role. The rules (who may grant what) live in the permission module. */
export const memberRoleInput = z.strictObject({ role });
export type MemberRoleInput = z.infer<typeof memberRoleInput>;

/** A person edits their own profile. Role, email and ids are not profile fields. */
export const profileUpdateInput = z
  .strictObject({
    name: name.optional(),
    handle: z
      .string()
      .regex(/^[a-z0-9][a-z0-9_-]{1,31}$/)
      .optional(),
    locale: locale.optional(),
    timezone: z.string().refine(isTimeZone, { message: 'not an IANA time zone' }).optional(),
  })
  .refine(hasAField, AT_LEAST_ONE);
export type ProfileUpdateInput = z.infer<typeof profileUpdateInput>;

/** A new team. The key becomes part of every issue identifier and never changes (same rule as the database). */
export const teamCreateInput = z.strictObject({
  key: z.string().regex(/^[A-Z][A-Z0-9]{0,6}$/),
  name,
  private: z.boolean().optional(),
});
export type TeamCreateInput = z.infer<typeof teamCreateInput>;

/** Rename a team or toggle its privacy. `key` is rejected as an unknown field: keys are immutable. */
export const teamUpdateInput = z
  .strictObject({ name: name.optional(), private: z.boolean().optional() })
  .refine(hasAField, AT_LEAST_ONE);
export type TeamUpdateInput = z.infer<typeof teamUpdateInput>;

export const teamMemberInput = z.strictObject({ memberId: id });
export type TeamMemberInput = z.infer<typeof teamMemberInput>;

const uniqueIds = (ids: readonly string[]) => new Set(ids).size === ids.length;

export const inviteCreateInput = z.strictObject({
  email: z.string().trim().toLowerCase().max(254).pipe(z.email()),
  role,
  teamIds: z.array(id).max(20).refine(uniqueIds, { message: 'team ids must be unique' }),
  locale: locale.optional(),
});
export type InviteCreateInput = z.infer<typeof inviteCreateInput>;

export const inviteTokenInput = z.strictObject({ token: z.string().min(1) });
export type InviteTokenInput = z.infer<typeof inviteTokenInput>;

export const inviteAcceptInput = z.strictObject({ token: z.string().min(1), name });
export type InviteAcceptInput = z.infer<typeof inviteAcceptInput>;

/**
 * A handle from a display name: accents stripped, lower-case, spaces to `-`, everything outside `[a-z0-9_-]`
 * dropped, repeats collapsed, edges trimmed, at most 28 characters (room for a `-2` suffix). Fewer than two
 * characters left gives `user`. The result always satisfies the profile handle rule.
 */
export function slugifyHandle(displayName: string): string {
  const handle = displayName
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/\s+/g, '-')
    .replace(/[^a-z0-9_-]/g, '')
    .replace(/-{2,}/g, '-')
    .replace(/_{2,}/g, '_')
    .slice(0, 28)
    .replace(/^[-_]+|[-_]+$/g, '');
  return handle.length >= 2 ? handle : 'user';
}
