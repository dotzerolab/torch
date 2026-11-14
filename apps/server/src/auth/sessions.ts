// Session rows: one per (workspace, member), all behind one cookie token (so one hash). The cookie holds a
// random token; only its SHA-256 is stored.
import { member, session, workspace } from '@torch/shared/db/schema';
import { and, asc, eq, gt, isNull, lte, max, sql } from 'drizzle-orm';
import { generateCookie } from 'hono/cookie';
import type { Orm } from '../db.ts';
import { isUuid } from '../util/uuid.ts';
import { hashToken, isWellFormedToken } from './tokens.ts';

export const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
export const SESSION_MAX_AGE_MS = 90 * 24 * 60 * 60 * 1000;
/** `last_seen_at` and `expires_at` move at most this often per session. */
export const TOUCH_INTERVAL_MS = 60 * 60 * 1000;

export type SessionWorkspace = {
  id: string;
  name: string;
  slug: string;
  memberId: string;
  role: 'owner' | 'admin' | 'member' | 'guest';
};

export const isSecureUrl = (appUrl: string) => new URL(appUrl).protocol === 'https:';

/** `__Host-sid` over https (the prefix forbids Domain and demands Secure and Path=/), `sid` over plain http. */
export const sessionCookieName = (appUrl: string) => (isSecureUrl(appUrl) ? '__Host-sid' : 'sid');

/**
 * The `Set-Cookie` value of the session cookie: it ends when the session row does (`expiresAt`), measured from
 * `now`. Sign-in and every refresh build the cookie here, so the flags can never drift apart.
 */
export function buildSessionCookie(
  appUrl: string,
  token: string,
  expiresAt: Date,
  now: Date = new Date(),
): string {
  return generateCookie(sessionCookieName(appUrl), token, {
    httpOnly: true,
    secure: isSecureUrl(appUrl),
    sameSite: 'Lax',
    path: '/',
    maxAge: Math.max(1, Math.floor((expiresAt.getTime() - now.getTime()) / 1000)),
  });
}

/** New expiry for a session used at `now`: 30 days sliding, never past `createdAt` + 90 days. */
export function slideExpiry(createdAt: Date, now: Date): Date {
  return new Date(
    Math.min(now.getTime() + SESSION_TTL_MS, createdAt.getTime() + SESSION_MAX_AGE_MS),
  );
}

/** The session token in the request's Cookie header, or null when absent or not shaped like a token. */
export function readSessionToken(req: Request, appUrl: string): string | null {
  const name = sessionCookieName(appUrl);
  for (const part of (req.headers.get('cookie') ?? '').split(';')) {
    const separator = part.indexOf('=');
    if (separator === -1 || part.slice(0, separator).trim() !== name) continue;
    const value = part.slice(separator + 1).trim();
    return isWellFormedToken(value) ? value : null;
  }
  return null;
}

/** The live session of this cookie in one workspace, or null (unknown, revoked or expired). */
export async function findSession(orm: Orm, token: string, workspaceId: string, now: Date) {
  // A workspace id comes from a URL: a malformed one is "no session", never a Postgres 22P02 turned into a 500.
  if (!isUuid(workspaceId)) return null;
  const [row] = await orm
    .select()
    .from(session)
    .where(
      and(
        eq(session.tokenHash, hashToken(token)),
        eq(session.workspaceId, workspaceId),
        isNull(session.revokedAt),
        gt(session.expiresAt, now),
      ),
    )
    .limit(1);
  return row ?? null;
}

/**
 * Slides the expiry of every live session of this cookie that was last touched over an hour ago. Returns the
 * newest expiry it wrote, or null when it touched nothing (touched recently, or revoked or expired meanwhile),
 * so a caller can tell the browser exactly when its cookie now ends.
 */
export async function touchSessions(orm: Orm, token: string, now: Date): Promise<Date | null> {
  const touched = await orm
    .update(session)
    .set({
      lastSeenAt: now,
      expiresAt: sql`least(${session.createdAt} + interval '90 days', ${now.toISOString()}::timestamptz + interval '30 days')`,
    })
    .where(
      and(
        eq(session.tokenHash, hashToken(token)),
        isNull(session.revokedAt),
        gt(session.expiresAt, now),
        lte(session.lastSeenAt, new Date(now.getTime() - TOUCH_INTERVAL_MS)),
      ),
    )
    .returning({ expiresAt: session.expiresAt });
  let newest: Date | null = null;
  for (const row of touched) if (!newest || row.expiresAt > newest) newest = row.expiresAt;
  return newest;
}

/**
 * When the cookie of this token must expire: the latest expiry among its live sessions, so the browser keeps the
 * cookie exactly as long as the database keeps the session (sliding included). Null when no session is live.
 */
export async function liveSessionExpiry(orm: Orm, token: string, now: Date): Promise<Date | null> {
  const [row] = await orm
    .select({ expiresAt: max(session.expiresAt) })
    .from(session)
    .where(
      and(
        eq(session.tokenHash, hashToken(token)),
        isNull(session.revokedAt),
        gt(session.expiresAt, now),
      ),
    );
  return row?.expiresAt ?? null;
}

/** Workspaces this cookie is signed into: live sessions whose member is still active. */
export async function listSessionWorkspaces(
  orm: Orm,
  token: string,
  now: Date,
): Promise<SessionWorkspace[]> {
  return orm
    .select({
      id: workspace.id,
      name: workspace.name,
      slug: workspace.slug,
      memberId: member.id,
      role: member.role,
    })
    .from(session)
    .innerJoin(
      member,
      and(eq(member.workspaceId, session.workspaceId), eq(member.id, session.memberId)),
    )
    .innerJoin(workspace, eq(workspace.id, session.workspaceId))
    .where(
      and(
        eq(session.tokenHash, hashToken(token)),
        isNull(session.revokedAt),
        gt(session.expiresAt, now),
        isNull(member.deactivatedAt),
      ),
    )
    .orderBy(asc(workspace.createdAt), asc(workspace.id));
}

/**
 * Revokes the cookie's session in every workspace: logout, and a sign-in made with a cookie that is already
 * signed in (then `orm` is the sign-in's transaction, so the old sessions end together with the new ones starting).
 */
export async function revokeSessions(
  orm: Pick<Orm, 'update'>,
  token: string,
  now: Date,
): Promise<void> {
  await orm
    .update(session)
    .set({ revokedAt: now })
    .where(and(eq(session.tokenHash, hashToken(token)), isNull(session.revokedAt)));
}
