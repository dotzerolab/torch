// The permission-filtered shape proxy (ADR 0001): the browser reads only through these routes. Electric itself is
// never exposed. Per request the server decides who the caller is, which team they may read and exactly what shape
// to ask Electric for; the only things taken from the client are the sync-protocol cursor parameters.
import { type Actor, canSeeTeam } from '@torch/shared/permissions';
import { Hono } from 'hono';
import type { Orm } from '../db.ts';
import type { ActorResolver } from '../permissions/load-actor.ts';
import { loadTeamAccess, loadVisibleMemberIds } from '../permissions/load-actor.ts';
import { isUuid } from '../util/uuid.ts';
import { type AccessBus, createAccessBus } from './access-bus.ts';
import type { ElectricConfig } from './config.ts';
import { loadIssueTeamAccess } from './issue-access.ts';
import {
  issueActivityShape,
  issueDetailShape,
  membersShape,
  ownMembershipShape,
  type ShapeDefinition,
  type TeamDataKind,
  teamDataShape,
  teamMembersShape,
  teamScopedShape,
  teamsShape,
  workspaceLabelsShape,
} from './shapes.ts';

export type SyncRouteDeps = {
  orm: Orm;
  electric: ElectricConfig;
  auth: ActorResolver;
  /** Replaces `fetch` in tests. */
  fetchUpstream?: typeof fetch;
  /** Ends open shape requests when access changes. One instance per app, shared with the services that signal it. */
  accessBus?: AccessBus;
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

/** Every relayed shape response, whatever Electric said: stored at most per user, revalidated on every use. */
export const SHAPE_CACHE_CONTROL = 'private, no-cache';

function relayHeaders(upstream: Headers): Headers {
  const headers = new Headers(upstream);
  for (const name of DROPPED_RESPONSE_HEADERS) headers.delete(name);
  for (const name of [...headers.keys()])
    if (name.startsWith('access-control-')) headers.delete(name);

  // A shape response belongs to one user's permissions and one moment of them. The browser may keep it but must
  // ask again before every use: the question reaches this proxy, which authorises the caller and then lets
  // Electric answer 304 against the ETag. Electric's own `max-age` would serve the first snapshot to a user
  // whose access has since ended.
  headers.set('cache-control', SHAPE_CACHE_CONTROL);
  const vary = headers.get('vary');
  if (!vary || !/(^|,)\s*(cookie|\*)\s*(,|$)/i.test(vary)) {
    headers.set('vary', vary ? `${vary}, Cookie` : 'Cookie');
  }
  return headers;
}

/** Passes a body through and calls `release` once it has ended, failed or been cancelled by the reader. */
function releasing(
  body: ReadableStream<Uint8Array>,
  release: () => void,
): ReadableStream<Uint8Array> {
  const reader = body.getReader();
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const chunk = await reader.read();
        if (chunk.done) {
          release();
          controller.close();
        } else {
          controller.enqueue(chunk.value);
        }
      } catch (error) {
        release();
        controller.error(error);
      }
    },
    async cancel(reason) {
      release();
      await reader.cancel(reason);
    },
  });
}

/**
 * What a request is answered with when its person's access changed before Electric answered.
 *
 * A long-poll (`live=true`) gets exactly what Electric itself answers when its wait runs out with nothing new: "up to
 * date at the offset you already hold". The client asks again at once, and the proxy then authorises that request
 * against the new state (a removed member gets 404, a signed-out one 401). Anything else (a request that was not
 * waiting for changes) gets a plain 503, which the client's fetch layer retries with a short backoff.
 *
 * Deliberately NOT a 409 must-refetch: the pinned client files the shape's current handle as expired on a 409, and as
 * this shape did not change on Electric's side the next real answer carries the same handle, which the client then
 * rejects as a stale cached response, retries, and warns about until it gives up and resets (a real-client test
 * pins that the answer below does not do this).
 */
function accessChangedResponse(incoming: URLSearchParams): Response {
  const headers = new Headers({
    'cache-control': SHAPE_CACHE_CONTROL,
    vary: 'Cookie',
    'content-type': 'application/json',
  });
  const handle = incoming.get('handle');
  const offset = incoming.get('offset');
  if (incoming.get('live') === 'true' && handle && offset && offset !== '-1') {
    headers.set('electric-handle', handle);
    headers.set('electric-offset', offset);
    // The client needs a cursor on every live answer; it only sends it back, so the one it sent is as good as any.
    headers.set('electric-cursor', incoming.get('cursor') ?? '0');
    headers.set('electric-up-to-date', '');
    return new Response('[{"headers":{"control":"up-to-date"}}]', { status: 200, headers });
  }
  return new Response('{"error":"access_changed"}', { status: 503, headers });
}

export function createSyncRoutes(deps: SyncRouteDeps): Hono {
  const { orm, electric, auth } = deps;
  const fetchUpstream = deps.fetchUpstream ?? fetch;
  const accessBus = deps.accessBus ?? createAccessBus();
  const routes = new Hono();

  const notFound = () => Response.json({ error: 'not_found' }, { status: 404 });
  const unauthenticated = () => Response.json({ error: 'unauthenticated' }, { status: 401 });

  async function proxy(req: Request, shape: ShapeDefinition, actor: Actor): Promise<Response> {
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

    // The request ends when the client goes away or when this person's access changes (see access-bus.ts); the bus
    // keeps it registered until the last byte of the answer has been sent, so a streamed answer ends too.
    const ended = new AbortController();
    const release = accessBus.track(actor.workspaceId, actor.memberId, () => ended.abort());

    let upstream: Response;
    try {
      // The one request header that crosses: the validator of a response this proxy sent. Credentials stay here.
      const ifNoneMatch = req.headers.get('if-none-match');
      upstream = await fetchUpstream(url, {
        signal: AbortSignal.any([req.signal, ended.signal]),
        ...(ifNoneMatch ? { headers: { 'if-none-match': ifNoneMatch } } : {}),
      });
    } catch (error) {
      release();
      // The client went away mid long-poll: nothing to answer, nothing to log.
      if (req.signal.aborted) return new Response(null, { status: 499 });
      if (ended.signal.aborted) return accessChangedResponse(incoming);
      // Category only: the message of a failed fetch can carry the URL, and the URL carries the secret.
      console.error(
        'sync upstream unreachable:',
        error instanceof Error ? error.name : 'unknown error',
      );
      return Response.json({ error: 'sync_unavailable' }, { status: 502 });
    }
    if (!PROTOCOL_STATUSES.has(upstream.status)) {
      release();
      await upstream.body?.cancel();
      // The status only: the body can describe the configuration (and the URL carries the secret).
      console.error('sync upstream failed with status', upstream.status);
      return Response.json({ error: 'sync_unavailable' }, { status: 502 });
    }
    let body: ReadableStream<Uint8Array> | null = null;
    if (upstream.body) body = releasing(upstream.body, release);
    else release();
    return new Response(body, {
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
    return proxy(c.req.raw, teamsShape(actor), actor);
  });

  // Member profiles: the shape follows the actor's role and stored team memberships, never the URL or the query.
  routes.get('/w/:workspaceId/members', async (c) => {
    const workspaceId = c.req.param('workspaceId');
    if (!isUuid(workspaceId)) return notFound();
    const actor = await authenticate(c.req.raw, workspaceId);
    if (!actor) return unauthenticated();
    return proxy(c.req.raw, membersShape(actor, await loadVisibleMemberIds(orm, actor)), actor);
  });

  // The actor's own team memberships: the signal that tells an open page its access changed (a private-team join
  // or removal) without waiting for the next poll of the shapes it already holds.
  routes.get('/w/:workspaceId/me/team-memberships', async (c) => {
    const workspaceId = c.req.param('workspaceId');
    if (!isUuid(workspaceId)) return notFound();
    const actor = await authenticate(c.req.raw, workspaceId);
    if (!actor) return unauthenticated();
    return proxy(c.req.raw, ownMembershipShape(actor), actor);
  });

  const teamRoute = (path: string, kind: 'issues' | 'workflow_states' | 'team_members') =>
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
      return proxy(
        c.req.raw,
        kind === 'team_members' ? teamMembersShape(access.id) : teamScopedShape(kind, access.id),
        actor,
      );
    });
  teamRoute('issues', 'issues');
  teamRoute('workflow-states', 'workflow_states');
  teamRoute('members', 'team_members');

  // ---- the issue model: labels and join rows per team, workspace labels, detail and activity per opened issue ----

  const teamDataRoute = (path: string, kind: TeamDataKind) =>
    routes.get(`/w/:workspaceId/teams/:teamId/${path}`, async (c) => {
      const workspaceId = c.req.param('workspaceId');
      if (!isUuid(workspaceId)) return notFound();
      const actor = await authenticate(c.req.raw, workspaceId);
      if (!actor) return unauthenticated();

      const teamId = c.req.param('teamId');
      if (!isUuid(teamId)) return notFound();
      const access = await loadTeamAccess(orm, workspaceId, teamId);
      if (!access || !canSeeTeam(actor, access)) return notFound();
      return proxy(c.req.raw, teamDataShape(kind, access.id));
    });
  teamDataRoute('labels', 'labels');
  teamDataRoute('issue-labels', 'issue_labels');
  teamDataRoute('issue-subscribers', 'issue_subscribers');
  teamDataRoute('issue-links', 'issue_links');
  teamDataRoute('issue-relations', 'issue_relations');

  // Labels of no team: every member of the workspace reads them, a guest included.
  routes.get('/w/:workspaceId/workspace-labels', async (c) => {
    const workspaceId = c.req.param('workspaceId');
    if (!isUuid(workspaceId)) return notFound();
    const actor = await authenticate(c.req.raw, workspaceId);
    if (!actor) return unauthenticated();
    return proxy(c.req.raw, workspaceLabelsShape(actor.workspaceId));
  });

  // Per opened issue. The issue is looked up first and its team decides visibility: an issue of a team the actor cannot
  // see answers the same 404 as an unknown id. The shape is built from the stored issue id.
  const issueRoute = (path: string, build: (issueId: string) => ShapeDefinition) =>
    routes.get(`/w/:workspaceId/issues/:issueId/${path}`, async (c) => {
      const workspaceId = c.req.param('workspaceId');
      if (!isUuid(workspaceId)) return notFound();
      const actor = await authenticate(c.req.raw, workspaceId);
      if (!actor) return unauthenticated();

      const found = await loadIssueTeamAccess(orm, workspaceId, c.req.param('issueId'));
      if (!found || !canSeeTeam(actor, found.access)) return notFound();
      return proxy(c.req.raw, build(found.issueId));
    });
  issueRoute('detail', issueDetailShape);
  issueRoute('activity', issueActivityShape);

  return routes;
}
