// Keeps the browser cookie as long-lived as the session row it belongs to. A session slides forward when it is
// used (at most once an hour); without this the cookie, set at sign-in, would end after 30 days whatever the
// person did, while only the page's /session check re-sent it.
import type { MiddlewareHandler } from 'hono';
import type { SessionResolver } from './resolver.ts';
import { buildSessionCookie, readSessionToken } from './sessions.ts';

/**
 * After the handler ran, if the resolver slid the session row for this request, sends the request's own cookie
 * again with the new lifetime. The value is the one the browser sent (never a new token), and no round trip
 * is added: it rides on a response the request already needed.
 */
export function refreshSessionCookie(
  resolver: SessionResolver,
  appUrl: string,
  now: () => Date = () => new Date(),
): MiddlewareHandler {
  return async (c, next) => {
    await next();
    const expiresAt = resolver.touchedExpiry(c.req.raw);
    if (!expiresAt) return;
    const token = readSessionToken(c.req.raw, appUrl);
    if (!token) return;
    c.header('Set-Cookie', buildSessionCookie(appUrl, token, expiresAt, now()), { append: true });
  };
}
