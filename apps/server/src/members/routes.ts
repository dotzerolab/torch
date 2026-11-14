// HTTP wrapper around the member services. Mounted under `/api`; every route is `/w/:workspaceId/...` and answers
// for the actor of that workspace (the global body limit and CSRF guard sit in front, see app.ts).
import { memberRoleInput, profileUpdateInput } from '@torch/shared/mutations/admin';
import { Hono } from 'hono';
import type { Orm } from '../db.ts';
import type { ActorResolver } from '../permissions/load-actor.ts';
import {
  actorOfRequest,
  adminFailure,
  invalidInput,
  readJson,
  respond,
} from '../util/admin-http.ts';
import { changeMemberRole, listMembers, setMemberActive, updateOwnProfile } from './service.ts';

export type MemberRouteDeps = { orm: Orm; auth: ActorResolver };

/**
 * `GET /w/:ws/members` -> `{ members }` (owners and admins);
 * `PATCH /w/:ws/members/:id` `{ role }`, `POST /w/:ws/members/:id/deactivate`, `POST .../reactivate`,
 * `PATCH /w/:ws/me` `{ name?, handle?, locale?, timezone? }` -> `{ txid }`; refusals `{ error, message }`.
 */
export function createMemberRoutes(deps: MemberRouteDeps): Hono {
  const routes = new Hono();

  routes.get('/w/:workspaceId/members', async (c) => {
    const actor = await actorOfRequest(c, deps.auth);
    if (actor instanceof Response) return actor;
    return respond(await listMembers(deps.orm, actor), (members) => ({ members }));
  });

  routes.patch('/w/:workspaceId/members/:memberId', async (c) => {
    const actor = await actorOfRequest(c, deps.auth);
    if (actor instanceof Response) return actor;
    const json = await readJson(c);
    if (!json) return adminFailure('invalid_input', 400);
    const input = memberRoleInput.safeParse(json.body);
    if (!input.success) return invalidInput(input.error.issues);
    return respond(
      await changeMemberRole(deps.orm, actor, c.req.param('memberId'), input.data.role),
      (value) => value,
    );
  });

  for (const [action, active] of [
    ['deactivate', false],
    ['reactivate', true],
  ] as const) {
    routes.post(`/w/:workspaceId/members/:memberId/${action}`, async (c) => {
      const actor = await actorOfRequest(c, deps.auth);
      if (actor instanceof Response) return actor;
      return respond(
        await setMemberActive(deps.orm, actor, c.req.param('memberId'), active),
        (value) => value,
      );
    });
  }

  routes.patch('/w/:workspaceId/me', async (c) => {
    const actor = await actorOfRequest(c, deps.auth);
    if (actor instanceof Response) return actor;
    const json = await readJson(c);
    if (!json) return adminFailure('invalid_input', 400);
    const input = profileUpdateInput.safeParse(json.body);
    if (!input.success) return invalidInput(input.error.issues);
    return respond(await updateOwnProfile(deps.orm, actor, input.data), (value) => value);
  });

  return routes;
}
