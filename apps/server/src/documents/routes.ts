// HTTP wrapper around the document functions, mounted under `/api`. Every route is `/w/:workspaceId/...` and answers for
// the actor of that workspace. Refusals are `{ error, message, details? }` (see issues/errors.ts), and no answer is
// cached: it is one team's data.
//
//   GET    /w/:ws/teams/:teamId/documents          -> { documents }   (no bodies; ?includeArchived=true)
//   POST   /w/:ws/teams/:teamId/documents          -> 201 { document, txid }   body { title, body? }, header Idempotency-Key
//   GET    /w/:ws/documents/:documentId            -> { document }    (with the body)
//   PATCH  /w/:ws/documents/:documentId            -> { txid }        body { title?, body? }
//   POST   /w/:ws/documents/:documentId/archive|unarchive -> { txid }
//   GET    /w/:ws/documents/:documentId/revisions  -> { revisions }   (newest first, at most 50)
import { documentUpdateInput } from '@torch/shared/mutations/document';
import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import type { Orm } from '../db.ts';
import { errorResponse } from '../issues/errors.ts';
import { actorOf, changeResponse, NO_STORE, readBody, tooLarge } from '../issues/http.ts';
import type { ActorResolver } from '../permissions/load-actor.ts';
import {
  archiveDocument,
  createDocument,
  getDocument,
  listDocuments,
  listRevisions,
  updateDocument,
} from './service.ts';

export type DocumentRouteDeps = { orm: Orm; auth: ActorResolver };

/** The largest body a document write takes: 100,000 characters, with room for JSON escapes and the other fields. */
export const DOCUMENT_BODY_LIMIT = 512 * 1024;
const SMALL_BODY_LIMIT = 16 * 1024;

const IDEMPOTENCY_KEY = /^[\x21-\x7e]{1,128}$/;

export function createDocumentRoutes(deps: DocumentRouteDeps): Hono {
  const routes = new Hono();
  const writes = bodyLimit({ maxSize: DOCUMENT_BODY_LIMIT, onError: tooLarge });
  const small = bodyLimit({ maxSize: SMALL_BODY_LIMIT, onError: tooLarge });
  const teamPath = '/w/:workspaceId/teams/:teamId/documents';
  const documentPath = '/w/:workspaceId/documents/:documentId';

  routes.get(teamPath, async (c) => {
    const actor = await actorOf(c, deps.auth);
    if (actor instanceof Response) return actor;
    const result = await listDocuments(deps.orm, actor, c.req.param('teamId'), {
      includeArchived: c.req.query('includeArchived') === 'true',
    });
    return result.ok
      ? Response.json({ documents: result.value }, { headers: NO_STORE })
      : errorResponse(result);
  });

  routes.post(teamPath, writes, async (c) => {
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
    // The team comes from the URL: a body that names another one is refused like any unknown key.
    let input: unknown;
    try {
      input = await c.req.json();
    } catch {
      return errorResponse({ code: 'invalid_input', status: 400 });
    }
    if (typeof input !== 'object' || input === null || Array.isArray(input)) {
      return errorResponse({ code: 'invalid_input', status: 400 });
    }

    const result = await createDocument(
      deps.orm,
      actor,
      { ...input, teamId: c.req.param('teamId') } as Parameters<typeof createDocument>[2],
      { idempotencyKey: key },
    );
    if (!result.ok) return errorResponse(result);
    return Response.json(
      { document: result.value, txid: result.txid },
      {
        status: 201,
        headers: { ...NO_STORE, ...(result.replayed ? { 'Idempotent-Replayed': 'true' } : {}) },
      },
    );
  });

  routes.get(documentPath, async (c) => {
    const actor = await actorOf(c, deps.auth);
    if (actor instanceof Response) return actor;
    const result = await getDocument(deps.orm, actor, c.req.param('documentId'));
    return result.ok
      ? Response.json({ document: result.value }, { headers: NO_STORE })
      : errorResponse(result);
  });

  routes.patch(documentPath, writes, async (c) => {
    const actor = await actorOf(c, deps.auth);
    if (actor instanceof Response) return actor;
    const body = await readBody(c, documentUpdateInput);
    if (body instanceof Response) return body;
    return changeResponse(
      await updateDocument(deps.orm, actor, c.req.param('documentId'), body.data),
      200,
    );
  });

  for (const [path, archived] of [
    ['archive', true],
    ['unarchive', false],
  ] as const) {
    routes.post(`${documentPath}/${path}`, small, async (c) => {
      const actor = await actorOf(c, deps.auth);
      if (actor instanceof Response) return actor;
      return changeResponse(
        await archiveDocument(deps.orm, actor, c.req.param('documentId'), archived),
        200,
      );
    });
  }

  routes.get(`${documentPath}/revisions`, async (c) => {
    const actor = await actorOf(c, deps.auth);
    if (actor instanceof Response) return actor;
    const result = await listRevisions(deps.orm, actor, c.req.param('documentId'));
    return result.ok
      ? Response.json({ revisions: result.value }, { headers: NO_STORE })
      : errorResponse(result);
  });

  return routes;
}
