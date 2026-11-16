import type { Brand } from '@torch/shared/brand';
import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { refreshSessionCookie } from './auth/cookie-refresh.ts';
import { csrfGuard } from './auth/csrf.ts';
import { isSessionResolver } from './auth/resolver.ts';
import { createAuthRoutes } from './auth/routes.ts';
import { buildManifest } from './brand/manifest.ts';
import type { Db } from './db.ts';
import { createInviteRoutes } from './invites/routes.ts';
import { createIssueRoutes } from './issues/routes.ts';
import { createLabelRoutes } from './labels/routes.ts';
import type { Mailer } from './mail/mailer.ts';
import { createMemberRoutes } from './members/routes.ts';
import type { ActorResolver } from './permissions/load-actor.ts';
import type { ElectricConfig } from './sync/config.ts';
import { checkSyncHealth } from './sync/health.ts';
import { createSyncRoutes } from './sync/routes.ts';
import { createTeamRoutes } from './teams/routes.ts';
import { createWorkflowRoutes } from './workflow/routes.ts';

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

// The framework instance behind each App, so `listRoutes` can read its routes while the App type stays `{ fetch }`.
const instances = new WeakMap<App, Hono>();

/** One route of an app: the HTTP method and the path pattern as registered (`/api/w/:workspaceId/members`). */
export type RouteInfo = { method: string; path: string };

/**
 * The routes `createApp` registered, one entry per method and path, for a test that every authenticated route has a
 * permission case. Middleware (`use`, registered for every method) is left out; a route that carries its own
 * middleware (the body limit of the issue mutation) is listed once, not once per handler.
 */
export function listRoutes(app: App): RouteInfo[] {
  const instance = instances.get(app);
  if (!instance) throw new Error('listRoutes: this is not an app made by createApp');

  const seen = new Set<string>();
  const routes: RouteInfo[] = [];
  for (const { method, path } of instance.routes) {
    const key = `${method} ${path}`;
    if (method === 'ALL' || seen.has(key)) continue;
    seen.add(key);
    routes.push({ method, path });
  }
  return routes;
}

// Every body this API takes (a sign-in email or token, one issue update) is a few short fields. The limit sits
// in front of every route, so an unauthenticated caller cannot make the process buffer a large body.
const MAX_BODY_BYTES = 16 * 1024;

// The issue routes take a description of up to 100000 characters, so they carry their own, larger limit (and sit
// behind the session check before they read a byte of it).
const ISSUE_PATH = /^\/api\/w\/[^/]+\/issues(\/|$)/;

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
  const smallBodies = bodyLimit({
    maxSize: MAX_BODY_BYTES,
    onError: (c) =>
      c.json({ error: 'invalid_input', message: 'The request body is too large.' }, 413),
  });
  app.use('/api/*', (c, next) => (ISSUE_PATH.test(c.req.path) ? next() : smallBodies(c, next)));

  // A session slides forward when it is used; when the resolver says it did for this request, the cookie is sent
  // again with the new lifetime, so a browser in use stays signed in up to the 90-day ceiling.
  if (deps.auth && deps.config && isSessionResolver(deps.auth)) {
    app.use('/api/*', refreshSessionCookie(deps.auth, deps.config.appUrl, deps.now));
  }

  app.get('/health', (c) => c.json({ status: 'ok' }));
  app.get('/api/brand', (c) => c.json(deps.brand));
  // The installed-app manifest follows the brand, so it is built per request and never cached by the browser.
  app.get('/api/manifest.webmanifest', (c) =>
    c.body(JSON.stringify(buildManifest(deps.brand)), 200, {
      'content-type': 'application/manifest+json',
      'cache-control': 'no-cache',
    }),
  );
  app.get('/health/db', async (c) => {
    if (!deps.db) return c.json({ status: 'error', reason: 'DATABASE_URL is not set' }, 503);
    const health = await deps.db.health();
    return c.json(health, health.status === 'ok' ? 200 : 503);
  });
  app.get('/health/sync', async (c) => {
    const health = await checkSyncHealth(deps.electric);
    return c.json(health, health.status === 'error' ? 503 : 200);
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
    app.route('/api', createIssueRoutes({ orm: deps.db.orm, auth: deps.auth }));
    app.route('/api', createLabelRoutes({ orm: deps.db.orm, auth: deps.auth }));
    app.route('/api', createWorkflowRoutes({ orm: deps.db.orm, auth: deps.auth }));
    app.route('/api', createMemberRoutes({ orm: deps.db.orm, auth: deps.auth }));
    app.route('/api', createTeamRoutes({ orm: deps.db.orm, auth: deps.auth }));
  }

  if (deps.db?.orm && deps.auth && deps.mailer && deps.config) {
    app.route(
      '/api',
      createInviteRoutes({
        orm: deps.db.orm,
        auth: deps.auth,
        mailer: deps.mailer,
        brand: deps.brand,
        appUrl: deps.config.appUrl,
        trustProxy: deps.config.trustProxy,
        now: deps.now,
      }),
    );
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

  const created: App = { fetch: async (req, env) => app.fetch(req, env) };
  instances.set(created, app);
  return created;
}
