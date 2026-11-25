// HTTP wrapper around the comment functions, mounted under `/api`. Every route is `/w/:workspaceId/...` and answers for
// the actor of that workspace. Refusals are `{ error, message, details? }` (see issues/errors.ts), and no answer is
// cached: it is one person's data.
//
//   GET    /w/:ws/issues/:issueId/comments            -> { comments }
//   POST   /w/:ws/issues/:issueId/comments            -> 201 { comment, txid } (header Idempotency-Key, 1-128 visible
//                                                        characters; a replay adds `Idempotent-Replayed: true`)
//   PATCH  /w/:ws/comments/:commentId                 -> { txid }
//   DELETE /w/:ws/comments/:commentId                 -> { txid } (the comment stays as a tombstone)
//   POST   /w/:ws/comments/:commentId/resolve|unresolve -> { txid }
//   PUT|DELETE /w/:ws/comments/:commentId/reactions/:emoji -> { txid } (the emoji URL-encoded)
//   GET    /w/:ws/comments/:commentId/history         -> { edits }
import { commentCreateInput, commentEditInput } from '@torch/shared/mutations/comment';
import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import type { Orm } from '../db.ts';
import { errorResponse } from '../issues/errors.ts';
import { actorOf, changeResponse, NO_STORE, readBody, tooLarge } from '../issues/http.ts';
import type { ActorResolver } from '../permissions/load-actor.ts';
import {
  createComment,
  deleteComment,
  editComment,
  listComments,
  listEdits,
  setReaction,
  setResolved,
} from './service.ts';

export type CommentRouteDeps = { orm: Orm; auth: ActorResolver };

/** The largest body a comment write takes: 20,000 characters, with room for JSON escapes and the other fields. */
export const COMMENT_BODY_LIMIT = 128 * 1024;
/** Every other call of these routes carries no body to speak of. */
const SMALL_BODY_LIMIT = 16 * 1024;

const IDEMPOTENCY_KEY = /^[\x21-\x7e]{1,128}$/;

export function createCommentRoutes(deps: CommentRouteDeps): Hono {
  const routes = new Hono();
  const writes = bodyLimit({ maxSize: COMMENT_BODY_LIMIT, onError: tooLarge });
  const small = bodyLimit({ maxSize: SMALL_BODY_LIMIT, onError: tooLarge });
  const issuePath = '/w/:workspaceId/issues/:issueId/comments';
  const commentPath = '/w/:workspaceId/comments/:commentId';

  routes.get(issuePath, async (c) => {
    const actor = await actorOf(c, deps.auth);
    if (actor instanceof Response) return actor;
    const result = await listComments(deps.orm, actor, c.req.param('issueId'));
    return result.ok
      ? Response.json({ comments: result.value }, { headers: NO_STORE })
      : errorResponse(result);
  });

  routes.post(issuePath, writes, async (c) => {
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
    const body = await readBody(c, commentCreateInput);
    if (body instanceof Response) return body;

    const result = await createComment(deps.orm, actor, c.req.param('issueId'), body.data, {
      idempotencyKey: key,
    });
    if (!result.ok) return errorResponse(result);
    return Response.json(
      { comment: result.value, txid: result.txid },
      {
        status: 201,
        headers: { ...NO_STORE, ...(result.replayed ? { 'Idempotent-Replayed': 'true' } : {}) },
      },
    );
  });

  routes.patch(commentPath, writes, async (c) => {
    const actor = await actorOf(c, deps.auth);
    if (actor instanceof Response) return actor;
    const body = await readBody(c, commentEditInput);
    if (body instanceof Response) return body;
    return changeResponse(
      await editComment(deps.orm, actor, c.req.param('commentId'), body.data),
      200,
    );
  });

  routes.delete(commentPath, small, async (c) => {
    const actor = await actorOf(c, deps.auth);
    if (actor instanceof Response) return actor;
    return changeResponse(await deleteComment(deps.orm, actor, c.req.param('commentId')), 200);
  });

  for (const [path, resolved] of [
    ['resolve', true],
    ['unresolve', false],
  ] as const) {
    routes.post(`${commentPath}/${path}`, small, async (c) => {
      const actor = await actorOf(c, deps.auth);
      if (actor instanceof Response) return actor;
      return changeResponse(
        await setResolved(deps.orm, actor, c.req.param('commentId'), resolved),
        200,
      );
    });
  }

  routes.put(`${commentPath}/reactions/:emoji`, small, async (c) => {
    const actor = await actorOf(c, deps.auth);
    if (actor instanceof Response) return actor;
    return changeResponse(
      await setReaction(deps.orm, actor, c.req.param('commentId'), c.req.param('emoji'), true),
      200,
    );
  });
  routes.delete(`${commentPath}/reactions/:emoji`, small, async (c) => {
    const actor = await actorOf(c, deps.auth);
    if (actor instanceof Response) return actor;
    return changeResponse(
      await setReaction(deps.orm, actor, c.req.param('commentId'), c.req.param('emoji'), false),
      200,
    );
  });

  routes.get(`${commentPath}/history`, async (c) => {
    const actor = await actorOf(c, deps.auth);
    if (actor instanceof Response) return actor;
    const result = await listEdits(deps.orm, actor, c.req.param('commentId'));
    return result.ok
      ? Response.json({ edits: result.value }, { headers: NO_STORE })
      : errorResponse(result);
  });

  return routes;
}
