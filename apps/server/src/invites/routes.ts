// Invite routes, mounted under `/api`.
//   Signed in, `/w/:workspaceId/...`:  GET /invites, POST /invites, POST /invites/:inviteId/resend,
//                                      DELETE /invites/:inviteId
//   Public, `/invites/...`:            POST /invites/preview, POST /invites/accept (the link holder is not signed in)
// Thin wrappers: the service decides, this file turns its answer into HTTP.
import type { Brand } from '@torch/shared/brand';
import type { Locale } from '@torch/shared/i18n';
import {
  type AdminErrorCode,
  inviteAcceptInput,
  inviteCreateInput,
  inviteTokenInput,
} from '@torch/shared/mutations/admin';
import type { Actor, Role } from '@torch/shared/permissions';
import type { Context } from 'hono';
import { Hono } from 'hono';
import { setCookie } from 'hono/cookie';
import { clientIp, createRateLimiter } from '../auth/rate-limit.ts';
import {
  isSecureUrl,
  listSessionWorkspaces,
  liveSessionExpiry,
  readSessionToken,
  revokeSessions,
  sessionCookieName,
} from '../auth/sessions.ts';
import type { Orm } from '../db.ts';
import type { Mailer, MailMessage } from '../mail/mailer.ts';
import type { ActorResolver } from '../permissions/load-actor.ts';
import { isUuid } from '../util/uuid.ts';
import { renderInviteEmail } from './email.ts';
import {
  acceptInvite,
  createInvite,
  INVITE_TTL_DAYS,
  listInvites,
  loadInviteMailContext,
  previewInvite,
  resendInvite,
  revokeInvite,
} from './service.ts';

export type InviteRouteDeps = {
  orm: Orm;
  auth: ActorResolver;
  mailer: Mailer;
  brand: Brand;
  appUrl: string;
  trustProxy: boolean;
  now?: () => Date;
};

/** Public routes: calls per client address and window (preview and accept share one budget). */
const PUBLIC_LIMIT = 20;
const PUBLIC_WINDOW_MS = 15 * 60 * 1000;

// Developer-facing fallback texts; the web shows its own translated text for each code.
const MESSAGES: Record<AdminErrorCode, string> = {
  unauthenticated: 'Sign in to continue.',
  forbidden: 'You are not allowed to do that.',
  not_found: 'Not found.',
  invalid_input: 'The request is not valid.',
  last_owner: 'The workspace needs at least one owner.',
  already_member: 'This email already belongs to a member of the workspace.',
  invite_pending: 'This email already has a pending invitation.',
  invite_invalid: 'This invitation is not valid.',
  team_key_taken: 'A team with this key already exists.',
  handle_taken: 'This handle is already taken.',
  private_team_needs_member: 'A private team needs at least one member.',
  rate_limited: 'Too many requests. Try again later.',
};

type Status = 200 | 201 | 202 | 400 | 401 | 403 | 404 | 409 | 429;

// Every answer here is personal or secret-bearing: nothing may be cached by a browser or a proxy. Set per answer,
// never by a wildcard middleware, because a sub-app's middleware would also wrap the routes mounted after it.
const NO_STORE = { 'Cache-Control': 'no-store' };

const reply = (c: Context, body: unknown, status: Status = 200) => c.json(body, status, NO_STORE);
const failure = (c: Context, code: AdminErrorCode, status: Status, message?: string) =>
  reply(c, { error: code, message: message ?? MESSAGES[code] }, status);

/** What a zod schema of `@torch/shared` offers, so the server needs no direct dependency on zod. */
type Parser<T> = {
  safeParse(
    input: unknown,
  ):
    | { success: true; data: T }
    | { success: false; error: { issues: readonly { message: string }[] } };
};

async function readBody<T>(
  c: Context,
  schema: Parser<T>,
): Promise<{ data: T } | { error: string }> {
  let raw: unknown;
  try {
    raw = await c.req.json();
  } catch {
    return { error: MESSAGES.invalid_input };
  }
  const parsed = schema.safeParse(raw);
  return parsed.success
    ? { data: parsed.data }
    : { error: parsed.error.issues[0]?.message ?? MESSAGES.invalid_input };
}

export function createInviteRoutes(deps: InviteRouteDeps): Hono {
  const now = deps.now ?? (() => new Date());
  const baseUrl = deps.appUrl.replace(/\/+$/, '');
  const cookieName = sessionCookieName(deps.appUrl);
  const secure = isSecureUrl(deps.appUrl);
  const limiter = createRateLimiter({
    limit: PUBLIC_LIMIT,
    windowMs: PUBLIC_WINDOW_MS,
    now: () => now().getTime(),
  });
  const routes = new Hono();

  /** The signed-in actor of the workspace in the URL, or the answer to send instead. */
  async function actorOf(c: Context): Promise<Actor | Response> {
    const workspaceId = c.req.param('workspaceId') ?? '';
    if (!isUuid(workspaceId)) return failure(c, 'not_found', 404);
    const actor = await deps.auth.resolveActor(c.req.raw, workspaceId);
    if (!actor || actor.workspaceId !== workspaceId) return failure(c, 'unauthenticated', 401);
    return actor;
  }

  /** Mail is never awaited: the answer must not wait for the mail server. Only the error text is logged. */
  function sendInviteMail(message: MailMessage) {
    void Promise.resolve()
      .then(() => deps.mailer.send(message))
      .catch((error: unknown) => {
        console.error(
          'invite email could not be sent:',
          error instanceof Error ? error.message : 'unknown error',
        );
      });
  }

  function inviteMail(input: {
    to: string;
    token: string;
    locale: Locale;
    role: Role;
    context: { workspaceName: string; inviterName: string };
  }): MailMessage {
    return {
      to: input.to,
      ...renderInviteEmail({
        brand: deps.brand,
        locale: input.locale,
        workspaceName: input.context.workspaceName,
        inviterName: input.context.inviterName,
        role: input.role,
        link: `${baseUrl}/invite#token=${input.token}`,
        expiresInDays: INVITE_TTL_DAYS,
      }),
    };
  }

  // ---- signed in ----

  routes.get('/w/:workspaceId/invites', async (c) => {
    const actor = await actorOf(c);
    if (actor instanceof Response) return actor;

    const result = await listInvites(deps.orm, actor, { now: now() });
    if (!result.ok) return failure(c, result.code, result.status);
    return reply(c, { invites: result.value });
  });

  routes.post('/w/:workspaceId/invites', async (c) => {
    const actor = await actorOf(c);
    if (actor instanceof Response) return actor;
    const body = await readBody(c, inviteCreateInput);
    if ('error' in body) return failure(c, 'invalid_input', 400, body.error);

    const context = await loadInviteMailContext(deps.orm, actor);
    const result = await createInvite(deps.orm, actor, body.data, { now: now() });
    if (!result.ok) return failure(c, result.code, result.status);

    sendInviteMail(
      inviteMail({
        to: body.data.email,
        token: result.value.token,
        locale: result.value.locale,
        role: body.data.role,
        context,
      }),
    );
    return reply(c, { inviteId: result.value.inviteId }, 201);
  });

  routes.post('/w/:workspaceId/invites/:inviteId/resend', async (c) => {
    const actor = await actorOf(c);
    if (actor instanceof Response) return actor;

    const context = await loadInviteMailContext(deps.orm, actor);
    const result = await resendInvite(deps.orm, actor, c.req.param('inviteId'), { now: now() });
    if (!result.ok) return failure(c, result.code, result.status);

    sendInviteMail(
      inviteMail({
        to: result.value.email,
        token: result.value.token,
        locale: result.value.locale,
        role: result.value.role,
        context,
      }),
    );
    return reply(c, { status: 'sent' }, 202);
  });

  routes.delete('/w/:workspaceId/invites/:inviteId', async (c) => {
    const actor = await actorOf(c);
    if (actor instanceof Response) return actor;

    const result = await revokeInvite(deps.orm, actor, c.req.param('inviteId'), { now: now() });
    if (!result.ok) return failure(c, result.code, result.status);
    return reply(c, { txid: result.value.txid });
  });

  // ---- public ----

  function limited(c: Context): Response | null {
    const verdict = limiter.hit(clientIp(c.req.raw, c.env, deps.trustProxy));
    if (verdict.allowed) return null;
    return c.json({ error: 'rate_limited', message: MESSAGES.rate_limited }, 429, {
      ...NO_STORE,
      'Retry-After': String(verdict.retryAfterSeconds),
    });
  }

  routes.post('/invites/preview', async (c) => {
    const blocked = limited(c);
    if (blocked) return blocked;
    const body = await readBody(c, inviteTokenInput);
    if ('error' in body) return failure(c, 'invalid_input', 400, body.error);

    const preview = await previewInvite(deps.orm, body.data.token, now());
    if (!preview) return failure(c, 'invite_invalid', 400);
    return reply(c, preview);
  });

  routes.post('/invites/accept', async (c) => {
    const blocked = limited(c);
    if (blocked) return blocked;
    const body = await readBody(c, inviteAcceptInput);
    if ('error' in body) return failure(c, 'invalid_input', 400, body.error);

    const at = now();
    const userAgent = c.req.header('user-agent')?.slice(0, 255) ?? null;
    const result = await acceptInvite(deps.orm, {
      token: body.data.token,
      name: body.data.name,
      now: at,
      userAgent,
    });
    if (!result.ok) return failure(c, result.code, result.status);

    // Like a sign-in link: the cookie it replaces stops working.
    const previous = readSessionToken(c.req.raw, deps.appUrl);
    if (previous) await revokeSessions(deps.orm, previous, at);

    const { sessionToken } = result.value;
    const expiresAt = await liveSessionExpiry(deps.orm, sessionToken, at);
    if (expiresAt) {
      setCookie(c, cookieName, sessionToken, {
        httpOnly: true,
        secure,
        sameSite: 'Lax',
        path: '/',
        maxAge: Math.max(1, Math.floor((expiresAt.getTime() - at.getTime()) / 1000)),
      });
    }
    const workspaces = await listSessionWorkspaces(deps.orm, sessionToken, at);
    return reply(c, { workspaces });
  });

  return routes;
}
