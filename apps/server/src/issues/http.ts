// What every route of the issue API does the same way: find the actor of the workspace in the URL, read a JSON body and
// turn a service answer into a response. Refusals are `{ error, message, details? }` (see errors.ts).
import { createRateLimiter } from '../auth/rate-limit.ts';
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

/**
 * A limit on how often one member writes through a group of routes: `limit` writes in `windowMs`, counted per member
 * (never per address), in this process like every other limit. Every comment write moves its issue's `updated_at`, which
 * makes every open viewer of that issue read its snapshots again, so a loop of reactions would fan out to all of them.
 * Call the result right after the actor is known and before the body is read: it answers the 429 `rate_limited` to send
 * (with `Retry-After`), or null. Only writes call it; reads are never counted.
 */
export function createMemberWriteLimit(opts: {
  limit: number;
  windowMs: number;
  now?: () => Date;
}): (actor: ClientActor) => Response | null {
  const limiter = createRateLimiter({
    limit: opts.limit,
    windowMs: opts.windowMs,
    ...(opts.now ? { now: () => (opts.now as () => Date)().getTime() } : {}),
  });
  return (actor) => {
    const verdict = limiter.hit(`${actor.workspaceId}:${actor.memberId}`);
    if (verdict.allowed) return null;
    return Response.json(
      {
        error: 'rate_limited',
        message: 'Too many changes in a short time. Try again in a moment.',
      },
      {
        status: 429,
        headers: { ...NO_STORE, 'Retry-After': String(verdict.retryAfterSeconds) },
      },
    );
  };
}

/** Writes one member may make in a minute to the comments (reactions included) or to the documents. */
export const WRITES_PER_MINUTE = 60;
export const WRITE_WINDOW_MS = 60_000;
