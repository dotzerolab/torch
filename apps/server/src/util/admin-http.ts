// What every admin route does the same way: find the actor of the workspace in the URL, read a JSON body, and turn a
// service answer into a response. Bodies are `{ error, message }` for refusals (the web shows its own translated
// text for each code; the message is the developer-facing fallback) and a small JSON object for successes.
import type { AdminErrorCode } from '@torch/shared/mutations/admin';
import type { Actor } from '@torch/shared/permissions';
import type { Context } from 'hono';
import type { ActorResolver } from '../permissions/load-actor.ts';
import type { ServiceResult } from './result.ts';
import { isUuid } from './uuid.ts';

const MESSAGES: Record<AdminErrorCode, string> = {
  unauthenticated: 'Sign in to continue.',
  forbidden: 'You are not allowed to do this.',
  not_found: 'Not found.',
  invalid_input: 'The request is not valid.',
  last_owner: 'A workspace needs at least one active owner.',
  already_member: 'This person is already a member.',
  invite_pending: 'This person already has a pending invitation.',
  invite_invalid: 'This invitation is not valid.',
  team_key_taken: 'This team key is already used in the workspace.',
  handle_taken: 'This handle is already used in the workspace.',
  private_team_needs_member: 'A private team needs at least one member.',
  rate_limited: 'Too many requests. Try again later.',
};

export type FailureStatus = 400 | 401 | 403 | 404 | 409 | 413 | 429;

// Every admin answer is personal (the member list carries emails): nothing may be kept by a browser or a proxy. Set
// per answer here, not by a middleware, because a sub-app's middleware would also wrap the routes mounted after it.
const NO_STORE = { 'Cache-Control': 'no-store' };

export const adminFailure = (code: AdminErrorCode, status: FailureStatus, message?: string) =>
  Response.json({ error: code, message: message ?? MESSAGES[code] }, { status, headers: NO_STORE });

/**
 * The actor of `:workspaceId`, or the response to send. A workspace id that is not a uuid is 404; no session for that
 * workspace (no cookie, a garbage cookie, a cookie of another workspace, a deactivated member) is 401.
 */
export async function actorOfRequest(c: Context, auth: ActorResolver): Promise<Actor | Response> {
  const workspaceId = c.req.param('workspaceId') ?? '';
  if (!isUuid(workspaceId)) return adminFailure('not_found', 404);
  const actor = await auth.resolveActor(c.req.raw, workspaceId);
  if (!actor || actor.workspaceId !== workspaceId) return adminFailure('unauthenticated', 401);
  return actor;
}

/** The parsed JSON body, or null when it is not JSON. */
export async function readJson(c: Context): Promise<{ body: unknown } | null> {
  try {
    return { body: await c.req.json() };
  } catch {
    return null;
  }
}

/** The first problem of a zod result as the message of an `invalid_input` answer. */
export function invalidInput(issues: readonly { message: string }[] | undefined): Response {
  return adminFailure('invalid_input', 400, issues?.[0]?.message);
}

/** A service answer as a response: the refusal as it is, a success mapped by `body` with `status` (default 200). */
export function respond<T>(
  result: ServiceResult<T>,
  body: (value: T) => unknown,
  status: 200 | 201 = 200,
): Response {
  if (!result.ok) return adminFailure(result.code, result.status);
  return Response.json(body(result.value), { status, headers: NO_STORE });
}
