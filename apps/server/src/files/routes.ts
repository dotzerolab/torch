// HTTP wrapper around the attachment functions, mounted under `/api`. Every route is `/w/:workspaceId/...` and answers
// for the actor of that workspace. Refusals are `{ error, message, details? }` (see issues/errors.ts), and no answer is
// cached. Without storage (no S3_ENDPOINT) the calls that need it answer 503 `storage_unavailable` after the session
// check; listing needs only the database.
//
//   POST   /w/:ws/issues/:issueId/attachments        -> 201 { attachment, upload }   body { fileName, contentType, size }
//   POST   /w/:ws/attachments/:attachmentId/complete -> { attachment, txid }
//   GET    /w/:ws/issues/:issueId/attachments        -> { attachments }              (ready files only)
//   GET    /w/:ws/attachments/:attachmentId/file     -> 302 to a signed URL of 60 seconds (?inline=1 for raster images)
//   DELETE /w/:ws/attachments/:attachmentId          -> { txid }
//
// The signed URL is minted per request after the permission check, never stored and never logged; the redirect says
// `no-store` and `no-referrer`, so it stays out of caches and out of the Referer header of whatever it loads.
import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import type { Orm } from '../db.ts';
import { errorResponse } from '../issues/errors.ts';
import { actorOf, changeResponse, NO_STORE, tooLarge } from '../issues/http.ts';
import type { ActorResolver } from '../permissions/load-actor.ts';
import {
  completeAttachment,
  initAttachment,
  listAttachments,
  readAttachmentUrl,
  removeAttachment,
} from './attachments.ts';
import type { FileStorage } from './storage.ts';

export type AttachmentRouteDeps = { orm: Orm; auth: ActorResolver; files?: FileStorage };

/** What an upload start carries: a name, a type and a size. */
const BODY_LIMIT = 16 * 1024;

export function createAttachmentRoutes(deps: AttachmentRouteDeps): Hono {
  const routes = new Hono();
  const small = bodyLimit({ maxSize: BODY_LIMIT, onError: tooLarge });
  const unavailable = () => errorResponse({ code: 'storage_unavailable', status: 503 });
  const issuePath = '/w/:workspaceId/issues/:issueId/attachments';
  const filePath = '/w/:workspaceId/attachments/:attachmentId';

  routes.get(issuePath, async (c) => {
    const actor = await actorOf(c, deps.auth);
    if (actor instanceof Response) return actor;
    const result = await listAttachments(deps.orm, actor, c.req.param('issueId'));
    return result.ok
      ? Response.json({ attachments: result.value }, { headers: NO_STORE })
      : errorResponse(result);
  });

  routes.post(issuePath, small, async (c) => {
    const actor = await actorOf(c, deps.auth);
    if (actor instanceof Response) return actor;
    if (!deps.files) return unavailable();

    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return errorResponse({ code: 'invalid_input', status: 400 });
    }
    // The service tells a type that is not allowed (415) and a file that is too large (413) from a malformed request
    // (400), so it gets the raw body and validates it itself.
    if (typeof body !== 'object' || body === null || Array.isArray(body)) {
      return errorResponse({ code: 'invalid_input', status: 400 });
    }
    const result = await initAttachment(
      deps.orm,
      deps.files,
      actor,
      c.req.param('issueId'),
      body as Parameters<typeof initAttachment>[4],
    );
    return result.ok
      ? Response.json(result.value, { status: 201, headers: NO_STORE })
      : errorResponse(result);
  });

  routes.post(`${filePath}/complete`, small, async (c) => {
    const actor = await actorOf(c, deps.auth);
    if (actor instanceof Response) return actor;
    if (!deps.files) return unavailable();
    const result = await completeAttachment(
      deps.orm,
      deps.files,
      actor,
      c.req.param('attachmentId'),
    );
    return result.ok
      ? Response.json({ attachment: result.value, txid: result.txid }, { headers: NO_STORE })
      : errorResponse(result);
  });

  routes.get(`${filePath}/file`, async (c) => {
    const actor = await actorOf(c, deps.auth);
    if (actor instanceof Response) return actor;
    if (!deps.files) return unavailable();
    const result = await readAttachmentUrl(
      deps.orm,
      deps.files,
      actor,
      c.req.param('attachmentId'),
      { inline: c.req.query('inline') === '1' },
    );
    if (!result.ok) return errorResponse(result);
    return new Response(null, {
      status: 302,
      headers: { Location: result.value, ...NO_STORE, 'Referrer-Policy': 'no-referrer' },
    });
  });

  routes.delete(filePath, small, async (c) => {
    const actor = await actorOf(c, deps.auth);
    if (actor instanceof Response) return actor;
    if (!deps.files) return unavailable();
    return changeResponse(
      await removeAttachment(deps.orm, deps.files, actor, c.req.param('attachmentId')),
      200,
    );
  });

  return routes;
}
