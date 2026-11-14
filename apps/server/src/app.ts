import type { Brand } from '@torch/shared/brand';
import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { csrfGuard } from './auth/csrf.ts';
import { createAuthRoutes } from './auth/routes.ts';
import type { Db } from './db.ts';
import type { Mailer } from './mail/mailer.ts';
import { createMemberRoutes } from './members/routes.ts';
import { createMutationRoutes } from './mutations/routes.ts';
import type { ActorResolver } from './permissions/load-actor.ts';
import type { ElectricConfig } from './sync/config.ts';
import { createSyncRoutes } from './sync/routes.ts';

// Dependencies injected by main.ts (and by tests). Grows as tasks add routes.
export type AppDeps = {
  brand: Brand;
  /** Absent when DATABASE_URL is not set. Routes that query the database need `orm` too. */
  db?: Pick<Db, 'health'> & Partial<Pick<Db, 'orm'>>;
  /** Public URL of the web app and whether a trusted reverse proxy sits in front (see .env.example). */
  config?: { appUrl: string; trustProxy: boolean };
  /** Sends sign-in emails; without it the sign-in routes are not mounted. */
  mailer?: Mailer;
  /** Electric sync service behind the shape proxy (ELECTRIC_URL, ELECTRIC_SECRET). Never exposed to the browser. */
  electric?: ElectricConfig;
  /** Turns a request into the Actor of one workspace (the session cookie in production). Data routes mount only when it is present. */
  auth?: ActorResolver;
  /** Replaces `fetch` towards Electric in tests. */
  fetchUpstream?: typeof fetch;
  /** Clock for sessions and tokens; tests move it. */
  now?: () => Date;
};

// The only surface tests and main.ts rely on; the web framework behind it stays an internal choice.
// `env` is what the Node adapter passes (socket address); tests may omit it.
export type App = { fetch(req: Request, env?: unknown): Promise<Response> };

// Every body this API takes (a sign-in email or token, one issue update) is a few short fields. The limit sits
// in front of every route, so an unauthenticated caller cannot make the process buffer a large body.
const MAX_BODY_BYTES = 16 * 1024;

/** The SQLSTATE of a database error: `code` on the error or on the pg error that Drizzle wraps as its cause. */
function databaseCode(error: Error): string | undefined {
  for (const candidate of [error, error.cause]) {
    const code = (candidate as { code?: unknown } | undefined)?.code;
    if (typeof code === 'string') return code;
  }
  return undefined;
}

export function createApp(deps: AppDeps): App {
  // Cookie-authenticated routes are only safe behind the Origin check, which needs APP_URL: refuse to build an
  // app that would serve them without it, instead of mounting them unguarded.
  if (deps.auth && !deps.config) {
    throw new Error(
      'createApp: "auth" needs "config" (APP_URL), which the CSRF guard is built from',
    );
  }

  const app = new Hono();

  // Name and code only. Drizzle's error message carries the SQL and its parameters (emails, token hashes), and
  // Hono's default handler would log all of it and answer text/plain.
  app.onError((error, c) => {
    console.error('unhandled error:', error.name, databaseCode(error) ?? '');
    return c.json({ error: 'internal' }, 500);
  });

  if (deps.config) app.use('/api/*', csrfGuard(deps.config.appUrl));
  app.use(
    '/api/*',
    bodyLimit({
      maxSize: MAX_BODY_BYTES,
      onError: (c) =>
        c.json({ error: 'invalid_input', message: 'The request body is too large.' }, 413),
    }),
  );

  app.get('/health', (c) => c.json({ status: 'ok' }));
  app.get('/api/brand', (c) => c.json(deps.brand));
  app.get('/health/db', async (c) => {
    if (!deps.db) return c.json({ status: 'error', reason: 'DATABASE_URL is not set' }, 503);
    const health = await deps.db.health();
    return c.json(health, health.status === 'ok' ? 200 : 503);
  });

  if (deps.db?.orm && deps.mailer && deps.config) {
    app.route(
      '/api/auth',
      createAuthRoutes({
        orm: deps.db.orm,
        mailer: deps.mailer,
        brand: deps.brand,
        appUrl: deps.config.appUrl,
        trustProxy: deps.config.trustProxy,
        now: deps.now,
      }),
    );
  }

  if (deps.db?.orm && deps.auth) {
    app.route('/api', createMutationRoutes({ orm: deps.db.orm, auth: deps.auth }));
    app.route('/api', createMemberRoutes({ orm: deps.db.orm, auth: deps.auth }));
  }

  if (deps.db?.orm && deps.electric && deps.auth) {
    app.route(
      '/api/sync',
      createSyncRoutes({
        orm: deps.db.orm,
        electric: deps.electric,
        auth: deps.auth,
        fetchUpstream: deps.fetchUpstream,
      }),
    );
  }

  return { fetch: async (req, env) => app.fetch(req, env) };
}
