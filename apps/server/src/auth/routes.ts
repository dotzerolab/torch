// /api/auth: request a sign-in link, exchange it for a session, read the session, sign out.
import type { Brand } from '@torch/shared/brand';
import type { Context } from 'hono';
import { Hono } from 'hono';
import { deleteCookie } from 'hono/cookie';
import type { Orm } from '../db.ts';
import { renderMagicLinkEmail } from '../mail/magic-link-email.ts';
import type { Mailer } from '../mail/mailer.ts';
import {
  consumeMagicLink,
  issueMagicLink,
  LOGIN_TOKEN_TTL_MS,
  previewMagicLink,
} from './magic-link.ts';
import { clientIp, clientKey, createRateLimiter, type RateLimitResult } from './rate-limit.ts';
import {
  buildSessionCookie,
  isSecureUrl,
  listSessionWorkspaces,
  liveSessionExpiry,
  readSessionToken,
  revokeSessions,
  sessionCookieName,
  touchSessions,
} from './sessions.ts';
import { isWellFormedToken } from './tokens.ts';

export type AuthDeps = {
  orm: Orm;
  mailer: Mailer;
  brand: Brand;
  appUrl: string;
  trustProxy: boolean;
  now?: () => Date;
};

const IP_LIMIT = 20;
const IP_WINDOW_MS = 15 * 60 * 1000;
// Opening a link is two calls (preview, then verify) and a page can be reloaded, so this is looser than asking for
// links; a token cannot be guessed anyway (256 random bits), the limit only bounds the load one address can cause.
const LINK_LIMIT = 60;
const LINK_WINDOW_MS = 15 * 60 * 1000;
const MAX_EMAIL_LENGTH = 254;
const EMAIL_SHAPE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

async function readJson(req: Request): Promise<Record<string, unknown>> {
  try {
    const body: unknown = await req.json();
    return typeof body === 'object' && body !== null && !Array.isArray(body)
      ? (body as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

export function createAuthRoutes(deps: AuthDeps) {
  const now = deps.now ?? (() => new Date());
  const cookieName = sessionCookieName(deps.appUrl);
  const baseUrl = deps.appUrl.replace(/\/+$/, '');
  const ipLimiter = createRateLimiter({
    limit: IP_LIMIT,
    windowMs: IP_WINDOW_MS,
    now: () => now().getTime(),
  });
  // One budget per address for both calls the link page makes.
  const linkLimiter = createRateLimiter({
    limit: LINK_LIMIT,
    windowMs: LINK_WINDOW_MS,
    now: () => now().getTime(),
  });
  const app = new Hono();

  // One client = one address, or one /64 for IPv6 (see `clientKey`).
  const limitKey = (c: Context) => clientKey(clientIp(c.req.raw, c.env, deps.trustProxy));
  const tooManyRequests = (c: Context, limited: Extract<RateLimitResult, { allowed: false }>) =>
    c.json({ error: 'rate_limited', message: 'Too many requests. Try again later.' }, 429, {
      'Retry-After': String(limited.retryAfterSeconds),
    });
  const invalidLink = (c: Context) =>
    c.json({ error: 'invalid_or_expired', message: 'This sign-in link is not valid.' }, 400);

  // The cookie ends when the session row does. Sent at sign-in and again by every GET /session, whose touch slides
  // the row, so a browser in use stays signed in up to the 90-day ceiling instead of dropping at day 30.
  async function sendSessionCookie(c: Context, token: string, at: Date): Promise<void> {
    const expiresAt = await liveSessionExpiry(deps.orm, token, at);
    if (!expiresAt) return;
    c.header('Set-Cookie', buildSessionCookie(deps.appUrl, token, expiresAt, at), { append: true });
  }

  // Every response here is personal or secret-bearing: nothing may be cached by a browser or a proxy.
  app.use('*', async (c, next) => {
    await next();
    c.header('Cache-Control', 'no-store');
  });

  app.post('/magic-link', async (c) => {
    const limited = ipLimiter.hit(limitKey(c));
    if (!limited.allowed) return tooManyRequests(c, limited);

    const body = await readJson(c.req.raw);
    const email = typeof body.email === 'string' ? body.email.trim().toLowerCase() : '';
    if (email.length > MAX_EMAIL_LENGTH || !EMAIL_SHAPE.test(email)) {
      return c.json({ error: 'invalid_email', message: 'Enter a valid email address.' }, 400);
    }

    const issued = await issueMagicLink(deps.orm, { email, now: now() });
    if (issued) {
      // The token sits in the fragment: a browser never sends it to a server, so it stays out of access logs,
      // proxy logs and the Referer header. The page reads it from `location.hash` and removes it.
      const link = `${baseUrl}/auth/verify#token=${issued.token}`;
      const message = {
        to: email,
        ...renderMagicLinkEmail({
          brand: deps.brand,
          // A member always has a locale, so the request's `locale` hint is only a fallback for the form.
          locale: issued.locale,
          link,
          expiresInMinutes: LOGIN_TOKEN_TTL_MS / 60_000,
        }),
      };
      // Not awaited: the answer must not wait for (or reveal the speed of) the mail server.
      void Promise.resolve()
        .then(() => deps.mailer.send(message))
        .catch((error: unknown) => {
          // Only the error text: the message, the link and the token never reach the log.
          console.error(
            'sign-in email could not be sent:',
            error instanceof Error ? error.message : 'unknown error',
          );
        });
    }
    return c.json({ status: 'sent' }, 202);
  });

  // Who a link would sign in, shown on the Continue page before anything is used up. POST only, like verify: the
  // token travels in the body, never in a URL.
  app.post('/preview', async (c) => {
    const limited = linkLimiter.hit(limitKey(c));
    if (!limited.allowed) return tooManyRequests(c, limited);

    const body = await readJson(c.req.raw);
    if (!isWellFormedToken(body.token)) return invalidLink(c);
    const email = await previewMagicLink(deps.orm, { token: body.token, now: now() });
    if (!email) return invalidLink(c);
    return c.json({ email });
  });

  // POST only: a mail scanner that opens the link with GET must not burn it (the web page shows a button).
  app.post('/verify', async (c) => {
    const limited = linkLimiter.hit(limitKey(c));
    if (!limited.allowed) return tooManyRequests(c, limited);

    const body = await readJson(c.req.raw);
    if (!isWellFormedToken(body.token)) return invalidLink(c);

    const at = now();
    const userAgent = c.req.header('user-agent')?.slice(0, 255) ?? null;
    // A browser that is already signed in keeps nothing of the old sign-in: its sessions end in the same
    // transaction that opens the new ones (a link that fails changes nothing). A cookie that is not a token, or
    // names no session, simply revokes nothing.
    const result = await consumeMagicLink(deps.orm, {
      token: body.token,
      now: at,
      userAgent,
      revokeSessionToken: readSessionToken(c.req.raw, deps.appUrl),
    });
    if (!result) return invalidLink(c);

    await sendSessionCookie(c, result.sessionToken, at);
    const workspaces = await listSessionWorkspaces(deps.orm, result.sessionToken, at);
    return c.json({ workspaces });
  });

  app.get('/session', async (c) => {
    const token = readSessionToken(c.req.raw, deps.appUrl);
    const at = now();
    const workspaces = token ? await listSessionWorkspaces(deps.orm, token, at) : [];
    if (!token || workspaces.length === 0) {
      return c.json({ error: 'unauthenticated', message: 'Sign in to continue.' }, 401);
    }
    await touchSessions(deps.orm, token, at);
    await sendSessionCookie(c, token, at);
    return c.json({ workspaces });
  });

  app.post('/logout', async (c) => {
    const token = readSessionToken(c.req.raw, deps.appUrl);
    if (token) await revokeSessions(deps.orm, token, now());
    deleteCookie(c, cookieName, { path: '/', secure: isSecureUrl(deps.appUrl) });
    return c.body(null, 204);
  });

  return app;
}
