// The permission-filtered shape proxy (ADR 0001): the browser reads only through these routes. Electric itself is
// never exposed. Per request the server decides who the caller is, which team they may read and exactly what shape
// to ask Electric for; the only things taken from the client are the sync-protocol cursor parameters.
import { canSeeTeam } from '@torch/shared/permissions';
import { Hono } from 'hono';
import type { Orm } from '../db.ts';
import type { ActorResolver } from '../permissions/load-actor.ts';
import { loadTeamAccess } from '../permissions/load-actor.ts';
import { isUuid } from '../util/uuid.ts';
import type { ElectricConfig } from './config.ts';
import { type ShapeDefinition, teamScopedShape, teamsShape } from './shapes.ts';

export type SyncRouteDeps = {
  orm: Orm;
  electric: ElectricConfig;
  auth: ActorResolver;
  /** Replaces `fetch` in tests. */
  fetchUpstream?: typeof fetch;
};

/**
 * The client-controlled query parameters that reach Electric: the live/offset/handle cursor of the sync protocol.
 * Deliberately not forwarded: table, where, params, columns, secret and replica (ours), and the `subset__*` family
 * (a client-supplied `where` evaluated against columns we exclude from the shape could answer questions about
 * `description`). A test pins every name here to the protocol parameters of the pinned `@electric-sql/client`.
 */
export const SYNC_FORWARDED_PARAMS: readonly string[] = [
  'live',
  'live_sse',
  'experimental_live_sse',
  'handle',
  'offset',
  'cursor',
  'expired_handle',
  'log',
  'cache-buster',
];

// The statuses of the sync protocol the client understands: data, no content, not modified, a bad request (the
// body names the parameter) and must-refetch. Anything else is the proxy's own trouble with Electric (a wrong
// ELECTRIC_SECRET answers 401, a stale route 404, overload 429 or 5xx) and must never look like the user's
// session ending, so it becomes a plain 502.
const PROTOCOL_STATUSES: ReadonlySet<number> = new Set([200, 204, 304, 400, 409]);

// Hop-by-hop headers and the ones that stop describing the body once the runtime has decoded it (ADR section 9).
// Electric's wildcard CORS headers go too: the browser reads this proxy same-origin only.
const DROPPED_RESPONSE_HEADERS = [
  'content-encoding',
  'content-length',
  'transfer-encoding',
  'connection',
  'keep-alive',
];

function relayHeaders(upstream: Headers): Headers {
  const headers = new Headers(upstream);
  for (const name of DROPPED_RESPONSE_HEADERS) headers.delete(name);
  for (const name of [...headers.keys()])
    if (name.startsWith('access-control-')) headers.delete(name);

  // A shape response belongs to one user's permissions: no shared cache may keep it.
  const cacheControl = headers.get('cache-control');
  headers.set(
    'cache-control',
    cacheControl ? cacheControl.replace(/\bpublic\b/gi, 'private') : 'private',
  );
  const vary = headers.get('vary');
  if (!vary || !/(^|,)\s*(cookie|\*)\s*(,|$)/i.test(vary)) {
    headers.set('vary', vary ? `${vary}, Cookie` : 'Cookie');
  }
  return headers;
}

export function createSyncRoutes(deps: SyncRouteDeps): Hono {
  const { orm, electric, auth } = deps;
  const fetchUpstream = deps.fetchUpstream ?? fetch;
  const routes = new Hono();

  const notFound = () => Response.json({ error: 'not_found' }, { status: 404 });
  const unauthenticated = () => Response.json({ error: 'unauthenticated' }, { status: 401 });

  async function proxy(req: Request, shape: ShapeDefinition): Promise<Response> {
    const url = new URL(`${electric.url}/v1/shape`);
    const incoming = new URL(req.url).searchParams;
    for (const name of SYNC_FORWARDED_PARAMS) {
      const value = incoming.get(name);
      if (value !== null) url.searchParams.set(name, value);
    }
    url.searchParams.set('table', shape.table);
    url.searchParams.set('where', shape.where);
    shape.params.forEach((value, index) => {
      url.searchParams.set(`params[${index + 1}]`, value);
    });
    url.searchParams.set('columns', shape.columns.join(','));
    url.searchParams.set('secret', electric.secret);

    let upstream: Response;
    try {
      upstream = await fetchUpstream(url, { signal: req.signal });
    } catch (error) {
      // The client went away mid long-poll: nothing to answer, nothing to log.
      if (req.signal.aborted) return new Response(null, { status: 499 });
      // Category only: the message of a failed fetch can carry the URL, and the URL carries the secret.
      console.error(
        'sync upstream unreachable:',
        error instanceof Error ? error.name : 'unknown error',
      );
      return Response.json({ error: 'sync_unavailable' }, { status: 502 });
    }
    if (!PROTOCOL_STATUSES.has(upstream.status)) {
      await upstream.body?.cancel();
      // The status only: the body can describe the configuration (and the URL carries the secret).
      console.error('sync upstream failed with status', upstream.status);
      return Response.json({ error: 'sync_unavailable' }, { status: 502 });
    }
    return new Response(upstream.body, {
      status: upstream.status,
      statusText: upstream.statusText,
      headers: relayHeaders(upstream.headers),
    });
  }

  // Who is calling for this workspace. A resolver that hands back an actor of a different workspace is a bug:
  // fail closed instead of serving that workspace's shape under this URL.
  async function authenticate(req: Request, workspaceId: string) {
    const actor = await auth.resolveActor(req, workspaceId);
    return actor && actor.workspaceId === workspaceId ? actor : null;
  }

  routes.get('/w/:workspaceId/teams', async (c) => {
    const workspaceId = c.req.param('workspaceId');
    if (!isUuid(workspaceId)) return notFound();
    const actor = await authenticate(c.req.raw, workspaceId);
    if (!actor) return unauthenticated();
    return proxy(c.req.raw, teamsShape(actor));
  });

  const teamRoute = (path: string, kind: 'issues' | 'workflow_states') =>
    routes.get(`/w/:workspaceId/teams/:teamId/${path}`, async (c) => {
      const workspaceId = c.req.param('workspaceId');
      if (!isUuid(workspaceId)) return notFound();
      const actor = await authenticate(c.req.raw, workspaceId);
      if (!actor) return unauthenticated();

      // Malformed, unknown, other-workspace and invisible teams all answer the same 404: no existence oracle.
      const teamId = c.req.param('teamId');
      if (!isUuid(teamId)) return notFound();
      const access = await loadTeamAccess(orm, workspaceId, teamId);
      if (!access || !canSeeTeam(actor, access)) return notFound();
      // The shape is built from the stored id (`access.id`), never from the URL string.
      return proxy(c.req.raw, teamScopedShape(kind, access.id));
    });
  teamRoute('issues', 'issues');
  teamRoute('workflow-states', 'workflow_states');

  return routes;
}
