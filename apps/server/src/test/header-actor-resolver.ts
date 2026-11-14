// Test-only ActorResolver: the member id comes from a header, the actor from the real `loadActor`.
// Sync and mutation tests use it until they run behind the session resolver of the auth task.

import type { Orm } from '../db.ts';
import type { ActorResolver } from '../permissions/load-actor.ts';
import { loadActor } from '../permissions/load-actor.ts';

export const TEST_MEMBER_HEADER = 'x-test-member';

/** What createApp needs next to a resolver (the CSRF guard), for tests that call the app at http://localhost. */
export const TEST_APP_CONFIG = { appUrl: 'http://localhost', trustProxy: false };
/** The Origin a browser would send from TEST_APP_CONFIG; writes without it get 403. */
export const TEST_ORIGIN = 'http://localhost';

export function headerActorResolver(orm: Orm): ActorResolver {
  return {
    async resolveActor(req, workspaceId) {
      const memberId = req.headers.get(TEST_MEMBER_HEADER);
      return memberId ? loadActor(orm, workspaceId, memberId) : null;
    },
  };
}
