// Labels: `GET /w/:ws/labels?teamId=&includeArchived=` -> `{ labels }`; `POST /w/:ws/labels` -> 201 `{ label, txid }`;
// `PATCH /w/:ws/labels/:id` and `POST /w/:ws/labels/:id/archive` -> `{ label, txid }`. Refusals are `{ error, message }`.
import { labelCreateInput, labelUpdateInput } from '@torch/shared/mutations/workflow';
import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import type { Orm } from '../db.ts';
import { errorResponse } from '../issues/errors.ts';
import { actorOf, changeResponse, NO_STORE, readBody, tooLarge } from '../issues/http.ts';
import type { ActorResolver } from '../permissions/load-actor.ts';
import { archiveLabel, createLabel, listLabels, updateLabel } from './service.ts';

export type LabelRouteDeps = { orm: Orm; auth: ActorResolver };

const LIMIT = 16 * 1024;

export function createLabelRoutes(deps: LabelRouteDeps): Hono {
  const routes = new Hono();

  routes.get('/w/:workspaceId/labels', async (c) => {
    const actor = await actorOf(c, deps.auth);
    if (actor instanceof Response) return actor;
    const result = await listLabels(deps.orm, actor, {
      teamId: c.req.query('teamId'),
      includeArchived: c.req.query('includeArchived') === 'true',
    });
    return result.ok
      ? Response.json({ labels: result.value }, { headers: NO_STORE })
      : errorResponse(result);
  });

  routes.post(
    '/w/:workspaceId/labels',
    bodyLimit({ maxSize: LIMIT, onError: tooLarge }),
    async (c) => {
      const actor = await actorOf(c, deps.auth);
      if (actor instanceof Response) return actor;
      const body = await readBody(c, labelCreateInput);
      if (body instanceof Response) return body;
      return changeResponse(await createLabel(deps.orm, actor, body.data), 201, 'label');
    },
  );

  routes.patch(
    '/w/:workspaceId/labels/:labelId',
    bodyLimit({ maxSize: LIMIT, onError: tooLarge }),
    async (c) => {
      const actor = await actorOf(c, deps.auth);
      if (actor instanceof Response) return actor;
      const body = await readBody(c, labelUpdateInput);
      if (body instanceof Response) return body;
      return changeResponse(
        await updateLabel(deps.orm, actor, c.req.param('labelId'), body.data),
        200,
        'label',
      );
    },
  );

  routes.post('/w/:workspaceId/labels/:labelId/archive', async (c) => {
    const actor = await actorOf(c, deps.auth);
    if (actor instanceof Response) return actor;
    return changeResponse(
      await archiveLabel(deps.orm, actor, c.req.param('labelId')),
      200,
      'label',
    );
  });

  return routes;
}
