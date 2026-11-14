// Issuing and consuming sign-in links. One link per email: it covers every workspace where that email is an
// active member, as one login_token row per member sharing one token hash.
import { loginToken, member } from '@torch/shared/db/schema';
import type { Locale } from '@torch/shared/i18n';
import { and, asc, eq, gt, gte, inArray, isNull, sql } from 'drizzle-orm';
import type { Orm } from '../db.ts';
import { createSessionsForMembers, revokeSessions } from './sessions.ts';
import { generateToken, hashToken } from './tokens.ts';

export const LOGIN_TOKEN_TTL_MS = 15 * 60 * 1000;
export const EMAIL_LIMIT = 5;
export const EMAIL_WINDOW_MS = 15 * 60 * 1000;

/**
 * Creates a sign-in token for `email` (already normalised). Returns null, and writes nothing, when no active
 * member has that email or when five links were already issued for it in the last 15 minutes: the caller
 * answers the same either way, so the response never tells which emails exist.
 */
export async function issueMagicLink(
  orm: Orm,
  input: { email: string; now: Date },
): Promise<{ token: string; locale: Locale } | null> {
  const { email, now } = input;
  return orm.transaction(async (tx) => {
    // Serialises concurrent requests for one email so the limit below is exact.
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${email}))`);

    const members = await tx
      .select({ id: member.id, workspaceId: member.workspaceId, locale: member.locale })
      .from(member)
      .where(and(eq(member.email, email), isNull(member.deactivatedAt)))
      .orderBy(asc(member.createdAt), asc(member.id));
    const first = members[0];
    if (!first) return null;

    const [recent] = await tx
      .select({ count: sql<number>`count(distinct ${loginToken.tokenHash})::int` })
      .from(loginToken)
      .innerJoin(
        member,
        and(eq(member.workspaceId, loginToken.workspaceId), eq(member.id, loginToken.memberId)),
      )
      .where(
        and(
          eq(member.email, email),
          gte(loginToken.createdAt, new Date(now.getTime() - EMAIL_WINDOW_MS)),
        ),
      );
    if ((recent?.count ?? 0) >= EMAIL_LIMIT) return null;

    const token = generateToken();
    const tokenHash = hashToken(token);
    await tx.insert(loginToken).values(
      members.map((m) => ({
        workspaceId: m.workspaceId,
        memberId: m.id,
        tokenHash,
        createdAt: now,
        expiresAt: new Date(now.getTime() + LOGIN_TOKEN_TTL_MS),
      })),
    );
    return { token, locale: first.locale };
  });
}

/**
 * The email a valid link would sign in, or null for an unknown, used or expired link and for a link whose
 * members were all deactivated (the cases where `consumeMagicLink` answers null). Reads only: the link stays
 * usable, so the page can show who is signing in before the person presses Continue.
 */
export async function previewMagicLink(
  orm: Orm,
  input: { token: string; now: Date },
): Promise<string | null> {
  const [row] = await orm
    .select({ email: member.email })
    .from(loginToken)
    .innerJoin(
      member,
      and(eq(member.workspaceId, loginToken.workspaceId), eq(member.id, loginToken.memberId)),
    )
    .where(
      and(
        eq(loginToken.tokenHash, hashToken(input.token)),
        isNull(loginToken.usedAt),
        gt(loginToken.expiresAt, input.now),
        isNull(member.deactivatedAt),
      ),
    )
    .orderBy(asc(member.createdAt), asc(member.id))
    .limit(1);
  return row?.email ?? null;
}

/**
 * Burns the link and opens a session in every workspace where the member is still active. The burn is one
 * atomic UPDATE ... WHERE used_at IS NULL, so of any number of concurrent calls exactly one gets rows back.
 * Returns the new session token, or null for an unknown, used or expired link and for a link whose members
 * were all deactivated meanwhile (that link stays burned).
 *
 * `revokeSessionToken` is the cookie the browser already holds: its sessions are revoked in the same
 * transaction that opens the new ones, so a sign-in never leaves the old cookie alive, and a link that fails
 * leaves it signed in.
 */
export async function consumeMagicLink(
  orm: Orm,
  input: { token: string; now: Date; userAgent: string | null; revokeSessionToken?: string | null },
): Promise<{ sessionToken: string } | null> {
  const { token, now, userAgent, revokeSessionToken } = input;
  return orm.transaction(async (tx) => {
    const consumed = await tx
      .update(loginToken)
      .set({ usedAt: now })
      .where(
        and(
          eq(loginToken.tokenHash, hashToken(token)),
          isNull(loginToken.usedAt),
          gt(loginToken.expiresAt, now),
        ),
      )
      .returning({ id: loginToken.id });
    if (consumed.length === 0) return null;

    const active = await tx
      .select({ workspaceId: member.workspaceId, memberId: member.id })
      .from(loginToken)
      .innerJoin(
        member,
        and(eq(member.workspaceId, loginToken.workspaceId), eq(member.id, loginToken.memberId)),
      )
      .where(
        and(
          inArray(
            loginToken.id,
            consumed.map((row) => row.id),
          ),
          isNull(member.deactivatedAt),
        ),
      );
    if (active.length === 0) return null;

    const sessionToken = await createSessionsForMembers(tx, active, { now, userAgent });
    if (revokeSessionToken) await revokeSessions(tx, revokeSessionToken, now);
    return { sessionToken };
  });
}
