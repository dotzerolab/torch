// HTTP wrapper around the team services. Mounted under `/api`; every route is `/w/:workspaceId/...` and answers for
// the actor of that workspace (the global body limit and CSRF guard sit in front, see app.ts).
import { teamCreateInput, teamMemberInput, teamUpdateInput } from '@torch/shared/mutations/admin';
import { Hono } from 'hono';
import type { Orm } from '../db.ts';
import type { ActorResolver } from '../permissions/load-actor.ts';
import type { AccessNotifier } from '../sync/access-bus.ts';
import {
  actorOfRequest,
  adminFailure,
  invalidInput,
  readJson,
  respond,
} from '../util/admin-http.ts';
import {
  addTeamMember,
  createTeam,
  listPrivateTeamDirectory,
  removeTeamMember,
  updateTeam,
} from './service.ts';

export type TeamRouteDeps = { orm: Orm; auth: ActorResolver; accessBus?: AccessNotifier };

/**
 * `POST /w/:ws/teams` `{ key, name, private? }` -> 201 `{ teamId, txid }`;
 * `PATCH /w/:ws/teams/:id` `{ name?, private? }`, `POST /w/:ws/teams/:id/members` `{ memberId }`,
 * `DELETE /w/:ws/teams/:id/members/:memberId` -> `{ txid }`;
 * `GET /w/:ws/admin/teams` -> `{ teams }` (the private-team directory for owners and admins).
 * Refusals are `{ error, message }`.
 */
export function createTeamRoutes(deps: TeamRouteDeps): Hono {
  const routes = new Hono();

  routes.post('/w/:workspaceId/teams', async (c) => {
    const actor = await actorOfRequest(c, deps.auth);
    if (actor instanceof Response) return actor;
    const json = await readJson(c);
    if (!json) return adminFailure('invalid_input', 400);
    const input = teamCreateInput.safeParse(json.body);
    if (!input.success) return invalidInput(input.error.issues);
    return respond(
      await createTeam(deps.orm, actor, input.data, deps.accessBus),
      (value) => value,
      201,
    );
  });

  routes.patch('/w/:workspaceId/teams/:teamId', async (c) => {
    const actor = await actorOfRequest(c, deps.auth);
    if (actor instanceof Response) return actor;
    const json = await readJson(c);
    if (!json) return adminFailure('invalid_input', 400);
    const input = teamUpdateInput.safeParse(json.body);
    if (!input.success) return invalidInput(input.error.issues);
    return respond(
      await updateTeam(deps.orm, actor, c.req.param('teamId'), input.data, deps.accessBus),
      (value) => value,
    );
  });

  routes.post('/w/:workspaceId/teams/:teamId/members', async (c) => {
    const actor = await actorOfRequest(c, deps.auth);
    if (actor instanceof Response) return actor;
    const json = await readJson(c);
    if (!json) return adminFailure('invalid_input', 400);
    const input = teamMemberInput.safeParse(json.body);
    if (!input.success) return invalidInput(input.error.issues);
    return respond(
      await addTeamMember(
        deps.orm,
        actor,
        c.req.param('teamId'),
        input.data.memberId,
        deps.accessBus,
      ),
      (value) => value,
    );
  });

  routes.delete('/w/:workspaceId/teams/:teamId/members/:memberId', async (c) => {
    const actor = await actorOfRequest(c, deps.auth);
    if (actor instanceof Response) return actor;
    return respond(
      await removeTeamMember(
        deps.orm,
        actor,
        c.req.param('teamId'),
        c.req.param('memberId'),
        deps.accessBus,
      ),
      (value) => value,
    );
  });

  routes.get('/w/:workspaceId/admin/teams', async (c) => {
    const actor = await actorOfRequest(c, deps.auth);
    if (actor instanceof Response) return actor;
    return respond(await listPrivateTeamDirectory(deps.orm, actor), (teams) => ({ teams }));
  });

  return routes;
}
