// What every route of the issue API does the same way: find the actor of the workspace in the URL, read a JSON body and
// turn a service answer into a response. Refusals are `{ error, message, details? }` (see errors.ts).
import type { ActorResolver, ClientActor } from '../permissions/load-actor.ts';
import { isUuid } from '../util/uuid.ts';
import { errorResponse } from './errors.ts';
import type { ChangeResult } from './join-changes.ts';

export const NO_STORE = { 'Cache-Control': 'no-store' };

/** The actor of `:workspaceId`, or the response to send (404 for a malformed workspace id, 401 for no session). */
export async function actorOf(
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

export const tooLarge = () =>
  errorResponse({ code: 'invalid_input', status: 413, message: 'The request body is too large.' });

/** `{ txid, ...value }` with the given status, or the refusal body. */
export const changeResponse = <T>(
  result: ChangeResult<T>,
  status: 200 | 201,
  key?: string,
): Response =>
  result.ok
    ? Response.json(
        { ...(key ? { [key]: result.value } : {}), txid: result.txid },
        { status, headers: NO_STORE },
      )
    : errorResponse(result);

/** A JSON body that is parsed by `schema`, or the 400 response. */
export async function readBody<S extends { safeParse(value: unknown): { success: boolean } }>(
  c: { req: { json(): Promise<unknown> } },
  schema: S,
): Promise<{ data: ReturnType<S['safeParse']> extends { data: infer D } ? D : never } | Response> {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return errorResponse({ code: 'invalid_input', status: 400 });
  }
  const parsed = schema.safeParse(body) as {
    success: boolean;
    data?: unknown;
    error?: { issues: { path: PropertyKey[]; message: string }[] };
  };
  if (!parsed.success) {
    const first = parsed.error?.issues[0];
    const where = first?.path.length ? `${first.path.join('.')}: ` : '';
    return errorResponse({
      code: 'invalid_input',
      status: 400,
      message: `${where}${first?.message ?? 'The request is not valid.'}`,
    });
  }
  return { data: parsed.data as never };
}
