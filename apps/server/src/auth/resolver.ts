// Who is calling: the session cookie turned into an Actor for one workspace. Every route that needs a user
// (sync shapes, mutations) asks this, never the cookie itself.
import type { Orm } from '../db.ts';
import { type ActorResolver, loadClientActor } from '../permissions/load-actor.ts';
import { findSession, readSessionToken, TOUCH_INTERVAL_MS, touchSessions } from './sessions.ts';

/**
 * An actor resolver that also remembers, per request, when the session it slid now ends: `touchedExpiry` is
 * set only when `resolveActor` rewrote the session row for that very request object. The cookie refresh
 * middleware reads it after the handler ran.
 */
export type SessionResolver = ActorResolver & { touchedExpiry(req: Request): Date | undefined };

export const isSessionResolver = (resolver: ActorResolver): resolver is SessionResolver =>
  typeof (resolver as Partial<SessionResolver>).touchedExpiry === 'function';

export function createSessionActorResolver(deps: {
  orm: Orm;
  appUrl: string;
  now?: () => Date;
}): SessionResolver {
  const now = deps.now ?? (() => new Date());
  const touched = new WeakMap<Request, Date>();
  return {
    async resolveActor(req, workspaceId) {
      const token = readSessionToken(req, deps.appUrl);
      if (!token) return null;
      const at = now();
      const row = await findSession(deps.orm, token, workspaceId, at);
      if (!row) return null;
      // loadActor refuses a deactivated member, so a live session of one grants nothing.
      const actor = await loadClientActor(deps.orm, row.workspaceId, row.memberId, 'web');
      if (!actor) return null;
      // Most requests skip this: the row is only rewritten when it was last touched over an hour ago.
      if (at.getTime() - row.lastSeenAt.getTime() >= TOUCH_INTERVAL_MS) {
        const expiresAt = await touchSessions(deps.orm, token, at);
        if (expiresAt) touched.set(req, expiresAt);
      }
      return actor;
    },
    touchedExpiry: (req) => touched.get(req),
  };
}
