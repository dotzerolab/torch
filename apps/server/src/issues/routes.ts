// HTTP wrapper around the issue functions, mounted under `/api`. Every route is `/w/:workspaceId/...` and answers
// for the actor of that workspace. Refusals are `{ error, message, details? }` (see errors.ts).
import { issueCreateInput, issueUpdateInput } from '@torch/shared/mutations/issue';
import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import type { Orm } from '../db.ts';
import type { ActorResolver, ClientActor } from '../permissions/load-actor.ts';
import { isUuid } from '../util/uuid.ts';
import { archiveIssue, unarchiveIssue } from './archive.ts';
import { createIssue } from './create-issue.ts';
import { errorResponse } from './errors.ts';
import { type UpdateIssueResult, updateIssue } from './update-issue.ts';

export type IssueRouteDeps = { orm: Orm; auth: ActorResolver };

/** The largest body an issue call takes: a description of 100000 characters, with room for the other fields. */
export const ISSUE_BODY_LIMIT = 512 * 1024;

const NO_STORE = { 'Cache-Control': 'no-store' };
const IDEMPOTENCY_KEY = /^[\x21-\x7e]{1,128}$/;

/** The actor of `:workspaceId`, or the response to send (404 for a malformed workspace id, 401 for no session). */
async function actorOf(
  c: { req: { param(name: string): string | undefined; raw: Request } },
  auth: ActorResolver,
): Promise<ClientActor | Response> {
  const workspaceId = c.req.param('workspaceId') ?? '';
  if (!isUuid(workspaceId)) return errorResponse({ code: 'not_found', status: 404 });
  const actor = await auth.resolveActor(c.req.raw, workspaceId);
  if (!actor || actor.workspaceId !== workspaceId) {
    return errorResponse({ code: 'unauthenticated', status: 401 });
  }
  return actor;
}

const tooLarge = () =>
  errorResponse({ code: 'invalid_input', status: 413, message: 'The request body is too large.' });

/** The answer of an update, archive or unarchive: `{ txid }`, or the refusal body. */
const mutationResponse = (result: UpdateIssueResult): Response =>
  result.ok ? Response.json({ txid: result.txid }, { headers: NO_STORE }) : errorResponse(result);

/**
 * `PATCH /w/:ws/issues/:id` (any subset of the fields, labels as `addLabelIds` / `removeLabelIds`) and
 * `POST /w/:ws/issues/:id/archive` and `/unarchive` -> `{ txid }`; an archived issue answers 409 `issue_archived`
 * to PATCH. `POST /w/:ws/issues`, optional header `Idempotency-Key` (1-128 visible characters) -> 201 `{ issue, txid }`; a replay
 * of the same key and body answers the same way with the header `Idempotent-Replayed: true`.
 */
export function createIssueRoutes(deps: IssueRouteDeps): Hono {
  const routes = new Hono();

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
