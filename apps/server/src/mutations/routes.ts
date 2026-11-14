// HTTP wrapper around the mutation functions: one endpoint per mutation (ADR 0001 section 1).
import { issueUpdateInput, type MutationErrorCode } from '@torch/shared/mutations/issue';
import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import type { Orm } from '../db.ts';
import type { ActorResolver } from '../permissions/load-actor.ts';
import { isUuid } from '../util/uuid.ts';
import { updateIssue } from './update-issue.ts';

export type MutationRouteDeps = { orm: Orm; auth: ActorResolver };

// Developer-facing fallback texts; the web shows its own translated text for each code.
const MESSAGES: Record<MutationErrorCode, string> = {
  unauthenticated: 'Sign in to continue.',
  not_found: 'Issue not found.',
  forbidden: 'You cannot edit issues in this team.',
  invalid_input: 'The request is not a valid issue update.',
  invalid_state: "The state does not belong to the issue's team.",
  invalid_assignee: 'The assignee must be an active member who can see the issue.',
};

const failure = (code: MutationErrorCode, status: 400 | 401 | 403 | 404 | 413, message?: string) =>
  Response.json({ error: code, message: message ?? MESSAGES[code] }, { status });

/** Mounted under `/api`: `PATCH /api/w/:workspaceId/issues/:issueId` -> `{ txid }` or `{ error, message }`. */
export function createMutationRoutes(deps: MutationRouteDeps): Hono {
  const routes = new Hono();

  routes.patch(
    '/w/:workspaceId/issues/:issueId',
    // An update is a few short fields; anything bigger is not one.
    bodyLimit({
      maxSize: 16 * 1024,
      onError: () => failure('invalid_input', 413, 'The request body is too large.'),
    }),
    async (c) => {
      const workspaceId = c.req.param('workspaceId');
      const issueId = c.req.param('issueId');
      if (!isUuid(workspaceId)) return failure('not_found', 404);

      const actor = await deps.auth.resolveActor(c.req.raw, workspaceId);
      if (!actor || actor.workspaceId !== workspaceId) return failure('unauthenticated', 401);

      let body: unknown;
      try {
        body = await c.req.json();
      } catch {
        return failure('invalid_input', 400);
      }
      const input = issueUpdateInput.safeParse(body);
      if (!input.success) {
        return failure(
          'invalid_input',
          400,
          input.error.issues[0]?.message ?? MESSAGES.invalid_input,
        );
      }

      const result = await updateIssue(deps.orm, actor, issueId, input.data);
      if (!result.ok) return failure(result.code, result.status);
      return Response.json({ txid: result.txid });
    },
  );

  return routes;
}
