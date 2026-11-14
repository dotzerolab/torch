// CSRF defence for cookie-authenticated writes: SameSite=Lax cookies plus an exact Origin check on every
// non-GET/HEAD request. A browser always sends Origin on cross-site POST/PATCH/DELETE, so a missing or
// different Origin is refused. (Non-browser clients get bearer tokens in a later phase, not cookies.)
import type { MiddlewareHandler } from 'hono';

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

export function csrfGuard(appUrl: string): MiddlewareHandler {
  const allowedOrigin = new URL(appUrl).origin;
  return async (c, next) => {
    if (SAFE_METHODS.has(c.req.method)) return next();
    if (c.req.header('origin') !== allowedOrigin) {
      return c.json({ error: 'bad_origin', message: 'Request origin is not allowed.' }, 403);
    }
    return next();
  };
}
