// Who is calling: the session cookie turned into an Actor for one workspace. Every route that needs a user
// (sync shapes, mutations) asks this, never the cookie itself.
import type { Orm } from '../db.ts';
import { type ActorResolver, loadActor } from '../permissions/load-actor.ts';
import { findSession, readSessionToken, TOUCH_INTERVAL_MS, touchSessions } from './sessions.ts';

export function createSessionActorResolver(deps: {
  orm: Orm;
  appUrl: string;
  now?: () => Date;
}): ActorResolver {
  const now = deps.now ?? (() => new Date());
  return {
    async resolveActor(req, workspaceId) {
      const token = readSessionToken(req, deps.appUrl);
      if (!token) return null;
      const at = now();
      const row = await findSession(deps.orm, token, workspaceId, at);
      if (!row) return null;
      // loadActor refuses a deactivated member, so a live session of one grants nothing.
      const actor = await loadActor(deps.orm, row.workspaceId, row.memberId);
      if (!actor) return null;
      // Most requests skip this: the row is only rewritten when it was last touched over an hour ago.
      if (at.getTime() - row.lastSeenAt.getTime() >= TOUCH_INTERVAL_MS) {
        await touchSessions(deps.orm, token, at);
      }
      return actor;
    },
  };
}
