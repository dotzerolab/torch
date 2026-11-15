// Workflow states of a team: `GET /w/:ws/teams/:teamId/workflow-states?includeArchived=` -> `{ states }`;
// `POST` -> 201 `{ state, txid }`; `PATCH .../:stateId` -> `{ state, txid }`; `POST .../:stateId/archive` with an optional
// body `{ moveIssuesTo }` -> `{ state, txid }`. Refusals are `{ error, message, details? }`.
import {
  workflowStateArchiveInput,
  workflowStateCreateInput,
  workflowStateUpdateInput,
} from '@torch/shared/mutations/workflow';
import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import type { Orm } from '../db.ts';
import { errorResponse } from '../issues/errors.ts';
import { actorOf, changeResponse, NO_STORE, readBody, tooLarge } from '../issues/http.ts';
import type { ActorResolver } from '../permissions/load-actor.ts';
import {
  archiveWorkflowState,
  createWorkflowState,
  listWorkflowStates,
  updateWorkflowState,
} from './service.ts';

export type WorkflowRouteDeps = { orm: Orm; auth: ActorResolver };

const LIMIT = 16 * 1024;
const base = '/w/:workspaceId/teams/:teamId/workflow-states';

export function createWorkflowRoutes(deps: WorkflowRouteDeps): Hono {
  const routes = new Hono();

  routes.get(base, async (c) => {
    const actor = await actorOf(c, deps.auth);
    if (actor instanceof Response) return actor;
    const result = await listWorkflowStates(deps.orm, actor, c.req.param('teamId'), {
      includeArchived: c.req.query('includeArchived') === 'true',
    });
    return result.ok
      ? Response.json({ states: result.value }, { headers: NO_STORE })
      : errorResponse(result);
  });

  routes.post(base, bodyLimit({ maxSize: LIMIT, onError: tooLarge }), async (c) => {
    const actor = await actorOf(c, deps.auth);
    if (actor instanceof Response) return actor;
    const body = await readBody(c, workflowStateCreateInput);
    if (body instanceof Response) return body;
    return changeResponse(
      await createWorkflowState(deps.orm, actor, c.req.param('teamId'), body.data),
      201,
      'state',
    );
  });

  routes.patch(`${base}/:stateId`, bodyLimit({ maxSize: LIMIT, onError: tooLarge }), async (c) => {
    const actor = await actorOf(c, deps.auth);
    if (actor instanceof Response) return actor;
    const body = await readBody(c, workflowStateUpdateInput);
    if (body instanceof Response) return body;
    return changeResponse(
      await updateWorkflowState(
        deps.orm,
        actor,
        c.req.param('teamId'),
        c.req.param('stateId'),
        body.data,
      ),
      200,
      'state',
    );
  });

  routes.post(
    `${base}/:stateId/archive`,
    bodyLimit({ maxSize: LIMIT, onError: tooLarge }),
    async (c) => {
      const actor = await actorOf(c, deps.auth);
      if (actor instanceof Response) return actor;
      // The body is optional: a state without issues archives with none.
      const hasBody =
        (c.req.header('content-length') ?? '0') !== '0' || c.req.header('transfer-encoding');
      const body = hasBody ? await readBody(c, workflowStateArchiveInput) : { data: {} };
      if (body instanceof Response) return body;
      return changeResponse(
        await archiveWorkflowState(
          deps.orm,
          actor,
          c.req.param('teamId'),
          c.req.param('stateId'),
          body.data,
        ),
        200,
        'state',
      );
    },
  );

  return routes;
}
