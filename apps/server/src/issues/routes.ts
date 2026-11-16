// HTTP wrapper around the issue functions, mounted under `/api`. Every route is `/w/:workspaceId/...` and answers
// for the actor of that workspace. Refusals are `{ error, message, details? }` (see errors.ts).
import {
  issueCreateInput,
  issueLinkInput,
  issueRelationInput,
  issueUpdateInput,
} from '@torch/shared/mutations/issue';
import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import type { Orm } from '../db.ts';
import type { ActorResolver } from '../permissions/load-actor.ts';
import { archiveIssue, unarchiveIssue } from './archive.ts';
import { createIssue } from './create-issue.ts';
import { errorResponse } from './errors.ts';
import { actorOf, changeResponse, NO_STORE, readBody, tooLarge } from './http.ts';
import { addLink, removeLink } from './links.ts';
import { listIssues } from './list.ts';
import { addRelation, listRelations, removeRelation } from './relations.ts';
import { addSubscriber, removeSubscriber } from './subscribers.ts';
import { type UpdateIssueResult, updateIssue } from './update-issue.ts';

export type IssueRouteDeps = { orm: Orm; auth: ActorResolver };

/** The largest body an issue call takes: a description of 100000 characters, with room for the other fields. */
export const ISSUE_BODY_LIMIT = 512 * 1024;

const IDEMPOTENCY_KEY = /^[\x21-\x7e]{1,128}$/;

/** The answer of an update, archive or unarchive: `{ txid }`, or the refusal body. */
const mutationResponse = (result: UpdateIssueResult): Response =>
  result.ok ? Response.json({ txid: result.txid }, { headers: NO_STORE }) : errorResponse(result);

/**
 * Relations, subscribers and links of an issue: `GET|POST /issues/:id/relations`, `DELETE .../relations/:relationId`,
 * `PUT|DELETE .../subscribers/:memberId`, `POST /issues/:id/links`, `DELETE .../links/:linkId`.
 *
 * `PATCH /w/:ws/issues/:id` (any subset of the fields, labels as `addLabelIds` / `removeLabelIds`) and
 * `POST /w/:ws/issues/:id/archive` and `/unarchive` -> `{ txid }`; an archived issue answers 409 `issue_archived`
 * to PATCH. `POST /w/:ws/issues`, optional header `Idempotency-Key` (1-128 visible characters) -> 201 `{ issue, txid }`; a replay
 * of the same key and body answers the same way with the header `Idempotent-Replayed: true`.
 */
export function createIssueRoutes(deps: IssueRouteDeps): Hono {
  const routes = new Hono();

  routes.get('/w/:workspaceId/issues', async (c) => {
    const actor = await actorOf(c, deps.auth);
    if (actor instanceof Response) return actor;
    const limit = c.req.query('limit');
    const result = await listIssues(deps.orm, actor, {
      teamId: c.req.query('teamId'),
      updatedAfter: c.req.query('updatedAfter'),
      externalRef: c.req.query('externalRef'),
      includeArchived: c.req.query('includeArchived') === 'true',
      includeDescription: c.req.query('include') === 'description',
      limit: limit === undefined ? undefined : /^\d+$/.test(limit) ? Number(limit) : Number.NaN,
      cursor: c.req.query('cursor'),
    });
    return result.ok ? Response.json(result.value, { headers: NO_STORE }) : errorResponse(result);
  });

  routes.patch(
    '/w/:workspaceId/issues/:issueId',
    bodyLimit({ maxSize: ISSUE_BODY_LIMIT, onError: tooLarge }),
    async (c) => {
      const actor = await actorOf(c, deps.auth);
      if (actor instanceof Response) return actor;

      let body: unknown;
      try {
        body = await c.req.json();
      } catch {
        return errorResponse({ code: 'invalid_input', status: 400 });
      }
      const input = issueUpdateInput.safeParse(body);
      if (!input.success) {
        const first = input.error.issues[0];
        const where = first?.path.length ? `${first.path.join('.')}: ` : '';
        return errorResponse({
          code: 'invalid_input',
          status: 400,
          message: `${where}${first?.message ?? 'The request is not valid.'}`,
        });
      }
      return mutationResponse(
        await updateIssue(deps.orm, actor, c.req.param('issueId'), input.data),
      );
    },
  );

  const base = '/w/:workspaceId/issues/:issueId';
  routes.get(`${base}/relations`, async (c) => {
    const actor = await actorOf(c, deps.auth);
    if (actor instanceof Response) return actor;
    const result = await listRelations(deps.orm, actor, c.req.param('issueId'));
    return result.ok
      ? Response.json({ relations: result.relations }, { headers: NO_STORE })
      : errorResponse(result);
  });
  routes.post(
    `${base}/relations`,
    bodyLimit({ maxSize: 16 * 1024, onError: tooLarge }),
    async (c) => {
      const actor = await actorOf(c, deps.auth);
      if (actor instanceof Response) return actor;
      const body = await readBody(c, issueRelationInput);
      if (body instanceof Response) return body;
      return changeResponse(
        await addRelation(deps.orm, actor, c.req.param('issueId'), body.data),
        201,
        'relation',
      );
    },
  );
  routes.delete(`${base}/relations/:relationId`, async (c) => {
    const actor = await actorOf(c, deps.auth);
    if (actor instanceof Response) return actor;
    return changeResponse(
      await removeRelation(deps.orm, actor, c.req.param('issueId'), c.req.param('relationId')),
      200,
    );
  });
  routes.put(`${base}/subscribers/:memberId`, async (c) => {
    const actor = await actorOf(c, deps.auth);
    if (actor instanceof Response) return actor;
    return changeResponse(
      await addSubscriber(deps.orm, actor, c.req.param('issueId'), c.req.param('memberId')),
      200,
      'subscriber',
    );
  });
  routes.delete(`${base}/subscribers/:memberId`, async (c) => {
    const actor = await actorOf(c, deps.auth);
    if (actor instanceof Response) return actor;
    return changeResponse(
      await removeSubscriber(deps.orm, actor, c.req.param('issueId'), c.req.param('memberId')),
      200,
    );
  });
  routes.post(`${base}/links`, bodyLimit({ maxSize: 16 * 1024, onError: tooLarge }), async (c) => {
    const actor = await actorOf(c, deps.auth);
    if (actor instanceof Response) return actor;
    const body = await readBody(c, issueLinkInput);
    if (body instanceof Response) return body;
    return changeResponse(
      await addLink(deps.orm, actor, c.req.param('issueId'), body.data),
      201,
      'link',
    );
  });
  routes.delete(`${base}/links/:linkId`, async (c) => {
    const actor = await actorOf(c, deps.auth);
    if (actor instanceof Response) return actor;
    return changeResponse(
      await removeLink(deps.orm, actor, c.req.param('issueId'), c.req.param('linkId')),
      200,
    );
  });

  for (const [path, run] of [
    ['archive', archiveIssue],
    ['unarchive', unarchiveIssue],
  ] as const) {
    routes.post(`/w/:workspaceId/issues/:issueId/${path}`, async (c) => {
      const actor = await actorOf(c, deps.auth);
      if (actor instanceof Response) return actor;
      return mutationResponse(await run(deps.orm, actor, c.req.param('issueId')));
    });
  }

  routes.post(
    '/w/:workspaceId/issues',
    bodyLimit({
      maxSize: ISSUE_BODY_LIMIT,
      onError: tooLarge,
    }),
    async (c) => {
      const actor = await actorOf(c, deps.auth);
      if (actor instanceof Response) return actor;

      const key = c.req.header('idempotency-key');
      if (key !== undefined && !IDEMPOTENCY_KEY.test(key)) {
        return errorResponse({
          code: 'invalid_input',
          status: 400,
          message: 'Idempotency-Key must be 1 to 128 visible characters.',
        });
      }

      let body: unknown;
      try {
        body = await c.req.json();
      } catch {
        return errorResponse({ code: 'invalid_input', status: 400 });
      }
      const input = issueCreateInput.safeParse(body);
      if (!input.success) {
        const first = input.error.issues[0];
        const where = first?.path.length ? `${first.path.join('.')}: ` : '';
        return errorResponse({
          code: 'invalid_input',
          status: 400,
          message: `${where}${first?.message ?? 'The request is not valid.'}`,
        });
      }

      const result = await createIssue(deps.orm, actor, input.data, { idempotencyKey: key });
      if (!result.ok) return errorResponse(result.error);
      return Response.json(result.body, {
        status: 201,
        headers: { ...NO_STORE, ...(result.replayed ? { 'Idempotent-Replayed': 'true' } : {}) },
      });
    },
  );

  return routes;
}
