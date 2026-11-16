import { ELECTRIC_PROTOCOL_QUERY_PARAMS, Shape, ShapeStream } from '@electric-sql/client';
import type { Brand } from '@torch/shared/brand';
import { issue, issueRelation, label, member, teamMember } from '@torch/shared/db/schema';
import { and, eq } from 'drizzle-orm';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '../app.ts';
import { createDb, type Db } from '../db.ts';
import { loadClientActor } from '../permissions/load-actor.ts';
import {
  addMember,
  createWorkspaceFixture,
  type WorkspaceFixture,
  withTempDatabase,
} from '../test/fixtures.ts';
import {
  headerActorResolver,
  TEST_APP_CONFIG,
  TEST_MEMBER_HEADER,
  TEST_ORIGIN,
} from '../test/header-actor-resolver.ts';
import { type AccessBus, createAccessBus } from './access-bus.ts';
import { SHAPE_CACHE_CONTROL, SYNC_FORWARDED_PARAMS } from './routes.ts';
import { MEMBER_COLUMNS } from './shapes.ts';

// A hook that runs inside the team access read, between the authorization reads and the registration of the request.
const hooks = vi.hoisted(() => ({ inLoadTeamAccess: undefined as undefined | (() => void) }));
vi.mock('../permissions/load-actor.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../permissions/load-actor.ts')>();
  return {
    ...actual,
    loadTeamAccess: (...args: Parameters<typeof actual.loadTeamAccess>) => {
      hooks.inLoadTeamAccess?.();
      return actual.loadTeamAccess(...args);
    },
  };
});

const databaseUrl = process.env.DATABASE_URL;
const electricUrl = process.env.ELECTRIC_URL;
const electricSecret = process.env.ELECTRIC_SECRET ?? 'dev-electric-secret';

// Integration: needs the dev compose Postgres. Skipped, loudly, when DATABASE_URL is not set.
if (!databaseUrl) {
  console.warn(
    '[sync/routes.test] SKIPPED the shape proxy tests: DATABASE_URL is not set. ' +
      'Start `docker compose -f docker-compose.dev.yml up -d --wait postgres` and set DATABASE_URL (see .env.example).',
  );
}
if (!electricUrl) {
  console.warn(
    '[sync/routes.test] SKIPPED the real-Electric integration test: ELECTRIC_URL is not set. ' +
      'Start `docker compose -f docker-compose.dev.yml up -d --wait electric` and set ELECTRIC_URL (see .env.example).',
  );
}

const brand: Brand = {
  productName: 'Acme Tasks',
  logoLight: '/acme/logo-light.svg',
  logoDark: '/acme/logo-dark.svg',
  favicon: '/acme/favicon.svg',
  accentColor: '#3366ff',
  emailSenderName: 'Acme Tasks',
  emailSenderAddress: 'no-reply@acme.example',
};

const UPSTREAM = 'http://electric.test:3000';
const SECRET = 'TOPSECRET-server-side-value';
const UNKNOWN_UUID = '99999999-9999-4999-8999-999999999999';

type Call = { url: URL; init: RequestInit | undefined };

/** A stand-in for fetch that records what the proxy would send to Electric and answers with `respond`. */
function fakeUpstream(respond: (call: Call) => Response | Promise<Response>) {
  const calls: Call[] = [];
  const fetchUpstream: typeof fetch = async (input, init) => {
    const call = { url: new URL(input instanceof Request ? input.url : String(input)), init };
    calls.push(call);
    return respond(call);
  };
  return { calls, fetchUpstream };
}

const emptyShape = () =>
  new Response('[{"headers":{"control":"up-to-date"}}]', {
    status: 200,
    headers: { 'content-type': 'application/json', 'electric-handle': 'h-1' },
  });

function buildApp(db: Db, fetchUpstream?: typeof fetch, accessBus?: AccessBus) {
  return createApp({
    brand,
    db,
    electric: { url: UPSTREAM, secret: SECRET },
    auth: headerActorResolver(db.orm),
    config: TEST_APP_CONFIG,
    fetchUpstream,
    accessBus,
  });
}

/** An Electric that never answers until the proxy ends the request: the open long-poll. */
function hangingUpstream() {
  return fakeUpstream(
    (call) =>
      new Promise<Response>((_resolve, reject) => {
        call.init?.signal?.addEventListener('abort', () =>
          reject(new DOMException('aborted', 'AbortError')),
        );
      }),
  );
}

const as = (memberId: string | undefined, init: RequestInit = {}): RequestInit => ({
  ...init,
  headers: { ...(memberId ? { [TEST_MEMBER_HEADER]: memberId } : {}), ...init.headers },
});

const issuesPath = (f: WorkspaceFixture, team: 'eng' | 'ops') =>
  `/api/sync/w/${f.workspaceId}/teams/${f.teams[team].id}/issues`;
const get = (app: ReturnType<typeof createApp>, path: string, init?: RequestInit) =>
  app.fetch(new Request(`http://localhost${path}`, init));

afterEach(() => {
  vi.restoreAllMocks();
  hooks.inLoadTeamAccess = undefined;
});

describe.skipIf(!databaseUrl)('GET /api/sync (shape proxy, fake Electric)', () => {
  it('does not mount the sync routes without electric and auth', async () => {
    await withTempDatabase(async (db) => {
      const f = await createWorkspaceFixture(db.orm);
      const app = createApp({ brand, db });

      const res = await get(app, issuesPath(f, 'eng'), as(f.members.owner.id));

      expect(res.status).toBe(404);
    });
  });

  it('client table, where, columns, params[1] and secret never reach Electric', async () => {
    await withTempDatabase(async (db) => {
      const f = await createWorkspaceFixture(db.orm);
      const upstream = fakeUpstream(emptyShape);
      const app = buildApp(db, upstream.fetchUpstream);
      const hostile = new URLSearchParams({
        offset: '-1',
        handle: 'h-0',
        live: 'true',
        cursor: 'c-0',
        // Everything below is ours to decide, not the client's.
        table: 'member',
        where: '1=1',
        columns: 'description',
        secret: 'hunter2',
        'params[1]': 'evil',
        'params[2]': 'evil2',
        params: '{"1":"evil"}',
        replica: 'full',
        subset__where: "description like 'a%'",
        subset__params: '{}',
        subset__limit: '1',
      });

      const res = await get(
        app,
        `${issuesPath(f, 'eng')}?${hostile}`,
        as(f.members.member.id, {
          headers: { cookie: 'sid=session-cookie', authorization: 'Bearer abc' },
        }),
      );

      expect(res.status).toBe(200);
      expect(upstream.calls).toHaveLength(1);
      // The caller's credentials stay with us: Electric gets none of the request headers.
      expect(JSON.stringify(upstream.calls[0]?.init?.headers ?? {})).not.toMatch(
        /cookie|authorization|session-cookie/i,
      );
      const sent = upstream.calls[0]?.url;
      expect(`${sent?.origin}${sent?.pathname}`).toBe(`${UPSTREAM}/v1/shape`);
      const q = sent?.searchParams;
      // Protocol parameters travel through.
      expect(q?.get('offset')).toBe('-1');
      expect(q?.get('handle')).toBe('h-0');
      expect(q?.get('live')).toBe('true');
      expect(q?.get('cursor')).toBe('c-0');
      // Server-owned parameters are the server's values, exactly once.
      expect(q?.getAll('table')).toEqual(['issue']);
      expect(q?.getAll('where')).toEqual(['team_id = $1']);
      expect(q?.getAll('params[1]')).toEqual([f.teams.eng.id]);
      expect(q?.getAll('secret')).toEqual([SECRET]);
      expect(q?.getAll('columns')).toHaveLength(1);
      expect(q?.get('columns')).not.toContain('description');
      // Nothing else the client sent survives: no second param, no JSON params, no replica, no subset queries.
      expect(q?.has('params[2]')).toBe(false);
      expect(q?.has('params')).toBe(false);
      expect(q?.has('replica')).toBe(false);
      expect([...(q?.keys() ?? [])].filter((k) => k.startsWith('subset__'))).toEqual([]);
      expect(sent?.href).not.toContain('evil');
      expect(sent?.href).not.toContain('hunter2');
    });
  });

  it('the teams shape for a member is built from the server-side actor, not from the request', async () => {
    await withTempDatabase(async (db) => {
      const f = await createWorkspaceFixture(db.orm);
      const upstream = fakeUpstream(emptyShape);
      const app = buildApp(db, upstream.fetchUpstream);

      const res = await get(
        app,
        `/api/sync/w/${f.workspaceId}/teams?offset=-1&where=true&params[2]=${UNKNOWN_UUID}`,
        as(f.members.outsider.id),
      );

      expect(res.status).toBe(200);
      const q = upstream.calls[0]?.url.searchParams;
      expect(q?.get('table')).toBe('team');
      expect(q?.get('where')).toBe('workspace_id = $1 AND (private = false OR id IN ($2))');
      expect(q?.get('params[1]')).toBe(f.workspaceId);
      // The outsider belongs to no team: the nil uuid, not the client's value.
      expect(q?.get('params[2]')).toBe('00000000-0000-0000-0000-000000000000');
      expect(q?.has('params[3]')).toBe(false);
    });
  });

  it('serves workflow states per team', async () => {
    await withTempDatabase(async (db) => {
      const f = await createWorkspaceFixture(db.orm);
      const upstream = fakeUpstream(emptyShape);
      const app = buildApp(db, upstream.fetchUpstream);

      const res = await get(
        app,
        `/api/sync/w/${f.workspaceId}/teams/${f.teams.eng.id}/workflow-states?offset=-1`,
        as(f.members.guest.id),
      );

      expect(res.status).toBe(200);
      const q = upstream.calls[0]?.url.searchParams;
      expect(q?.get('table')).toBe('workflow_state');
      expect(q?.get('params[1]')).toBe(f.teams.eng.id);
    });
  });

  it('guest and outsider get 404 for OPS issues; member gets the OPS shape with params[1] = OPS id', async () => {
    await withTempDatabase(async (db) => {
      const f = await createWorkspaceFixture(db.orm);
      const upstream = fakeUpstream(emptyShape);
      const app = buildApp(db, upstream.fetchUpstream);

      for (const who of ['guest', 'outsider'] as const) {
        const res = await get(app, `${issuesPath(f, 'ops')}?offset=-1`, as(f.members[who].id));
        expect(res.status, who).toBe(404);
        expect(await res.json()).toEqual({ error: 'not_found' });
      }
      expect(upstream.calls).toHaveLength(0);

      for (const who of ['member', 'owner'] as const) {
        const res = await get(app, `${issuesPath(f, 'ops')}?offset=-1`, as(f.members[who].id));
        expect(res.status, who).toBe(200);
      }
      expect(upstream.calls).toHaveLength(2);
      for (const call of upstream.calls) {
        expect(call.url.searchParams.get('params[1]')).toBe(f.teams.ops.id);
      }
    });
  });

  it('a team or workspace id from another workspace -> 404, identical body to an unknown team', async () => {
    await withTempDatabase(async (db) => {
      const a = await createWorkspaceFixture(db.orm);
      const b = await createWorkspaceFixture(db.orm);
      const upstream = fakeUpstream(emptyShape);
      const app = buildApp(db, upstream.fetchUpstream);
      const actorA = as(a.members.owner.id);

      // Control: the same caller reaches their own team, so the 404s below are decisions, not missing routes.
      expect((await get(app, issuesPath(a, 'eng'), actorA)).status).toBe(200);
      upstream.calls.length = 0;

      const unknownTeam = await get(
        app,
        `/api/sync/w/${a.workspaceId}/teams/${UNKNOWN_UUID}/issues`,
        actorA,
      );
      const foreignTeam = await get(
        app,
        `/api/sync/w/${a.workspaceId}/teams/${b.teams.eng.id}/issues`,
        actorA,
      );
      const malformedTeam = await get(
        app,
        `/api/sync/w/${a.workspaceId}/teams/not-a-uuid/issues`,
        actorA,
      );
      const foreignWorkspace = await get(app, issuesPath(b, 'eng'), actorA);
      const unknownWorkspace = await get(
        app,
        `/api/sync/w/${UNKNOWN_UUID}/teams/${a.teams.eng.id}/issues`,
        actorA,
      );

      expect([unknownTeam.status, foreignTeam.status, malformedTeam.status]).toEqual([
        404, 404, 404,
      ]);
      const body = await unknownTeam.text();
      expect(await foreignTeam.text()).toBe(body);
      expect(await malformedTeam.text()).toBe(body);
      // A workspace the caller has no session in answers like a workspace that does not exist.
      expect(foreignWorkspace.status).toBe(unknownWorkspace.status);
      expect(await foreignWorkspace.text()).toBe(await unknownWorkspace.text());
      expect(upstream.calls).toHaveLength(0);
    });
  });

  it('an upper-case or mixed-case team or workspace id -> 404 and no new shape: one id, one spelling, one shape', async () => {
    await withTempDatabase(async (db) => {
      const f = await createWorkspaceFixture(db.orm);
      const upstream = fakeUpstream(emptyShape);
      const app = buildApp(db, upstream.fetchUpstream);
      const guest = as(f.members.guest.id);
      const mixed = (id: string) =>
        [...id].map((ch, index) => (index % 2 === 0 ? ch.toUpperCase() : ch)).join('');
      const team = f.teams.eng.id;
      expect(mixed(team)).not.toBe(team);

      // Control: the canonical spelling reaches Electric with exactly the DB id.
      expect((await get(app, issuesPath(f, 'eng'), guest)).status).toBe(200);
      expect(upstream.calls.map((call) => call.url.searchParams.get('params[1]'))).toEqual([team]);
      upstream.calls.length = 0;

      const paths = [
        `/api/sync/w/${f.workspaceId}/teams/${mixed(team)}/issues`,
        `/api/sync/w/${f.workspaceId}/teams/${team.toUpperCase()}/issues`,
        `/api/sync/w/${f.workspaceId}/teams/${mixed(team)}/workflow-states`,
        `/api/sync/w/${mixed(f.workspaceId)}/teams/${team}/issues`,
        `/api/sync/w/${f.workspaceId.toUpperCase()}/teams`,
      ];
      for (const path of paths) {
        const res = await get(app, `${path}?offset=-1`, guest);
        expect(res.status, path).toBe(404);
      }
      expect(upstream.calls).toHaveLength(0);
    });
  });

  it('no actor -> 401, and Electric is never called', async () => {
    await withTempDatabase(async (db) => {
      const f = await createWorkspaceFixture(db.orm);
      const upstream = fakeUpstream(emptyShape);
      const app = buildApp(db, upstream.fetchUpstream);

      const paths = [
        `/api/sync/w/${f.workspaceId}/teams`,
        issuesPath(f, 'eng'),
        `/api/sync/w/${f.workspaceId}/teams/${f.teams.eng.id}/workflow-states`,
      ];
      for (const path of paths) {
        const res = await get(app, path);
        expect(res.status, path).toBe(401);
        expect(await res.json()).toEqual({ error: 'unauthenticated' });
      }
      expect(upstream.calls).toHaveLength(0);
    });
  });

  it('response drops content-encoding and content-length, cache-control is private no-cache, Vary includes Cookie', async () => {
    await withTempDatabase(async (db) => {
      const f = await createWorkspaceFixture(db.orm);
      const upstream = fakeUpstream(
        () =>
          new Response('[{"headers":{"control":"up-to-date"}}]', {
            status: 200,
            headers: {
              'content-type': 'application/json',
              'content-encoding': 'gzip',
              'content-length': '999',
              'cache-control': 'public, max-age=60, stale-while-revalidate=300',
              vary: 'Accept-Encoding',
              'electric-handle': 'h-77',
              'electric-offset': '0_0',
              'electric-schema': '{"id":{"type":"uuid"}}',
              'electric-up-to-date': '',
              // Electric answers every origin; behind our proxy only the same origin may read the response.
              'access-control-allow-origin': '*',
              'access-control-expose-headers': 'electric-handle',
            },
          }),
      );
      const app = buildApp(db, upstream.fetchUpstream);

      const res = await get(app, `${issuesPath(f, 'eng')}?offset=-1`, as(f.members.member.id));

      expect(res.status).toBe(200);
      expect(res.headers.get('content-encoding')).toBeNull();
      expect(res.headers.get('content-length')).toBeNull();
      expect(res.headers.get('cache-control')).toBe(SHAPE_CACHE_CONTROL);
      expect(res.headers.get('vary')?.split(/\s*,\s*/)).toEqual(
        expect.arrayContaining(['Accept-Encoding', 'Cookie']),
      );
      // The sync protocol headers the client needs are relayed untouched.
      expect(res.headers.get('electric-handle')).toBe('h-77');
      expect(res.headers.get('electric-offset')).toBe('0_0');
      expect(res.headers.get('electric-schema')).toBe('{"id":{"type":"uuid"}}');
      // Electric's wildcard CORS headers are dropped: the browser reads the proxy same-origin.
      expect([...res.headers.keys()].filter((h) => h.startsWith('access-control-'))).toEqual([]);
    });
  });

  it('a response without cache-control is still not publicly cacheable', async () => {
    await withTempDatabase(async (db) => {
      const f = await createWorkspaceFixture(db.orm);
      const upstream = fakeUpstream(emptyShape);
      const app = buildApp(db, upstream.fetchUpstream);

      const res = await get(app, `${issuesPath(f, 'eng')}?offset=-1`, as(f.members.member.id));

      expect(res.headers.get('cache-control')).toBe('private, no-cache');
      expect(res.headers.get('vary')).toContain('Cookie');
    });
  });

  it('cache-control is private, no-cache for every relayed status', async () => {
    await withTempDatabase(async (db) => {
      const f = await createWorkspaceFixture(db.orm);
      const cases: [string, number, string, string | null][] = [
        ['initial snapshot', 200, 'public, max-age=604800, stale-while-revalidate=2629746', '[]'],
        ['live response', 200, 'public, max-age=5', '[]'],
        ['not modified', 304, 'public, max-age=604800', null],
        ['no content', 204, 'public, max-age=60', null],
        ['must-refetch', 409, 'public, max-age=60', '[{"headers":{"control":"must-refetch"}}]'],
        ['bad request', 400, 'public, max-age=60', '{"message":"bad"}'],
      ];
      for (const [name, status, upstreamControl, body] of cases) {
        const upstream = fakeUpstream(
          () =>
            new Response(body, {
              status,
              headers: { 'content-type': 'application/json', 'cache-control': upstreamControl },
            }),
        );
        const app = buildApp(db, upstream.fetchUpstream);

        const res = await get(app, `${issuesPath(f, 'eng')}?offset=-1`, as(f.members.member.id));

        expect(res.status, name).toBe(status);
        expect(res.headers.get('cache-control'), name).toBe('private, no-cache');
        expect(res.headers.get('cache-control'), name).not.toMatch(/max-age/);
        expect(res.headers.get('vary'), name).toContain('Cookie');
      }
    });
  });

  it('if-none-match reaches Electric and its 304 is relayed with an empty body', async () => {
    await withTempDatabase(async (db) => {
      const f = await createWorkspaceFixture(db.orm);
      const upstream = fakeUpstream(
        () => new Response(null, { status: 304, headers: { etag: '"abc"' } }),
      );
      const app = buildApp(db, upstream.fetchUpstream);

      const res = await get(
        app,
        `${issuesPath(f, 'eng')}?offset=-1`,
        as(f.members.member.id, { headers: { 'if-none-match': '"abc"', cookie: 'sid=secret' } }),
      );

      expect(upstream.calls).toHaveLength(1);
      const sent = new Headers(upstream.calls[0]?.init?.headers);
      expect(sent.get('if-none-match')).toBe('"abc"');
      // Only the validator is forwarded: the caller's credentials stay with us.
      expect([...sent.keys()]).toEqual(['if-none-match']);
      expect(res.status).toBe(304);
      expect(await res.text()).toBe('');
      expect(res.headers.get('cache-control')).toBe('private, no-cache');
      expect(res.headers.get('etag')).toBe('"abc"');
    });
  });

  it('no if-none-match header is sent upstream when the client sent none', async () => {
    await withTempDatabase(async (db) => {
      const f = await createWorkspaceFixture(db.orm);
      const upstream = fakeUpstream(emptyShape);
      const app = buildApp(db, upstream.fetchUpstream);

      await get(app, `${issuesPath(f, 'eng')}?offset=-1`, as(f.members.member.id));

      expect([...new Headers(upstream.calls[0]?.init?.headers).keys()]).toEqual([]);
    });
  });

  it('etag is relayed', async () => {
    await withTempDatabase(async (db) => {
      const f = await createWorkspaceFixture(db.orm);
      const upstream = fakeUpstream(
        () =>
          new Response('[{"headers":{"control":"up-to-date"}}]', {
            status: 200,
            headers: { 'content-type': 'application/json', etag: '"h-1:-1:0_0"' },
          }),
      );
      const app = buildApp(db, upstream.fetchUpstream);

      const res = await get(app, `${issuesPath(f, 'eng')}?offset=-1`, as(f.members.member.id));

      expect(res.headers.get('etag')).toBe('"h-1:-1:0_0"');
    });
  });

  it('upstream status codes the sync protocol relies on (409 must-refetch) pass through with their body', async () => {
    await withTempDatabase(async (db) => {
      const f = await createWorkspaceFixture(db.orm);
      const upstream = fakeUpstream(
        () =>
          new Response('[{"headers":{"control":"must-refetch"}}]', {
            status: 409,
            headers: { 'content-type': 'application/json', 'electric-handle': 'h-new' },
          }),
      );
      const app = buildApp(db, upstream.fetchUpstream);

      const res = await get(
        app,
        `${issuesPath(f, 'eng')}?offset=5_1&handle=h-old`,
        as(f.members.member.id),
      );

      expect(res.status).toBe(409);
      expect(res.headers.get('electric-handle')).toBe('h-new');
      expect(await res.json()).toEqual([{ headers: { control: 'must-refetch' } }]);
    });
  });

  it('upstream down -> 502 sync_unavailable without upstream detail', async () => {
    await withTempDatabase(async (db) => {
      const f = await createWorkspaceFixture(db.orm);
      const failures = [
        async () => {
          throw new Error(
            `connect ECONNREFUSED 10.9.8.7:3000 ${UPSTREAM}/v1/shape?secret=${SECRET}`,
          );
        },
        async () => new Response(`internal: pg connection ${SECRET}`, { status: 500 }),
        async () => new Response('bad gateway', { status: 503 }),
      ];
      for (const failure of failures) {
        const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
        const app = buildApp(db, failure as unknown as typeof fetch);

        const res = await get(app, `${issuesPath(f, 'eng')}?offset=-1`, as(f.members.member.id));

        expect(res.status).toBe(502);
        expect(await res.json()).toEqual({ error: 'sync_unavailable' });
        // The log carries the category, never the secret or the upstream URL.
        const logged = JSON.stringify(errors.mock.calls);
        expect(logged).not.toContain(SECRET);
        expect(logged).not.toContain('secret=');
        errors.mockRestore();
      }
    });
  });

  it('an upstream auth failure (wrong ELECTRIC_SECRET) is a 502, never a 401 that signs the user out', async () => {
    await withTempDatabase(async (db) => {
      const f = await createWorkspaceFixture(db.orm);
      for (const status of [401, 403, 404, 429]) {
        const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
        const upstream = fakeUpstream(
          () =>
            new Response('{"message":"Unauthorized - Invalid API secret"}', {
              status,
              headers: { 'content-type': 'application/json' },
            }),
        );
        const app = buildApp(db, upstream.fetchUpstream);

        const res = await get(app, `${issuesPath(f, 'eng')}?offset=-1`, as(f.members.member.id));

        expect(res.status, String(status)).toBe(502);
        expect(await res.json()).toEqual({ error: 'sync_unavailable' });
        // The operator sees which status Electric answered; the secret and the upstream body stay out.
        const logged = JSON.stringify(errors.mock.calls);
        expect(logged).toContain(String(status));
        expect(logged).not.toContain(SECRET);
        expect(logged).not.toContain('Invalid API secret');
        errors.mockRestore();
      }
    });
  });

  it('the statuses of the sync protocol (200, 204, 304, 400, 409) still reach the client unchanged', async () => {
    await withTempDatabase(async (db) => {
      const f = await createWorkspaceFixture(db.orm);
      for (const status of [200, 204, 304, 400, 409]) {
        const upstream = fakeUpstream(
          () => new Response(status === 204 || status === 304 ? null : '[]', { status }),
        );
        const app = buildApp(db, upstream.fetchUpstream);

        const res = await get(app, `${issuesPath(f, 'eng')}?offset=-1`, as(f.members.member.id));

        expect(res.status).toBe(status);
      }
    });
  });

  it("passes the request's abort signal to Electric", async () => {
    await withTempDatabase(async (db) => {
      const f = await createWorkspaceFixture(db.orm);
      const upstream = fakeUpstream(emptyShape);
      const app = buildApp(db, upstream.fetchUpstream);
      const controller = new AbortController();

      await get(
        app,
        `${issuesPath(f, 'eng')}?offset=-1`,
        as(f.members.member.id, { signal: controller.signal }),
      );
      const signal = upstream.calls[0]?.init?.signal;

      expect(signal).toBeDefined();
      expect(signal?.aborted).toBe(false);
      controller.abort();
      expect(signal?.aborted).toBe(true);
    });
  });

  describe('access changes', () => {
    it('a long-poll whose person loses access is answered like a timeout of the wait: up to date at the offset it holds', async () => {
      await withTempDatabase(async (db) => {
        const f = await createWorkspaceFixture(db.orm);
        const bus = createAccessBus();
        const upstream = hangingUpstream();
        const app = buildApp(db, upstream.fetchUpstream, bus);

        const pending = get(
          app,
          `${issuesPath(f, 'eng')}?offset=5_1&handle=h-1&cursor=77&live=true`,
          as(f.members.member.id),
        );
        await vi.waitFor(() => expect(bus.tracked()).toBe(1));
        bus.accessChanged(f.workspaceId, [f.members.member.id]);
        const res = await pending;

        expect(res.status).toBe(200);
        expect(await res.json()).toEqual([{ headers: { control: 'up-to-date' } }]);
        // Everything the pinned client needs on a live answer, and nothing that makes it drop its shape.
        expect(res.headers.get('electric-handle')).toBe('h-1');
        expect(res.headers.get('electric-offset')).toBe('5_1');
        expect(res.headers.get('electric-cursor')).toBe('77');
        expect(res.headers.get('electric-up-to-date')).toBe('');
        expect(res.headers.get('cache-control')).toBe(SHAPE_CACHE_CONTROL);
        expect(res.headers.get('vary')?.split(/\s*,\s*/)).toContain('Cookie');
        expect(res.headers.get('etag')).toBeNull();
        expect(bus.tracked()).toBe(0);
      });
    });

    it('a first long-poll without a cursor still gets one, and a request that was not waiting gets a plain 503', async () => {
      await withTempDatabase(async (db) => {
        const f = await createWorkspaceFixture(db.orm);
        const bus = createAccessBus();
        const upstream = hangingUpstream();
        const app = buildApp(db, upstream.fetchUpstream, bus);
        const as_ = as(f.members.member.id);

        const first = get(app, `${issuesPath(f, 'eng')}?offset=0_0&handle=h-1&live=true`, as_);
        const initial = get(app, `${issuesPath(f, 'eng')}?offset=-1`, as_);
        const catchUp = get(app, `${issuesPath(f, 'eng')}?offset=3_2&handle=h-1`, as_);
        const sse = get(app, `${issuesPath(f, 'eng')}?offset=3_2&handle=h-1&live_sse=true`, as_);
        await vi.waitFor(() => expect(bus.tracked()).toBe(4));
        bus.accessChanged(f.workspaceId, 'all');

        const answered = await first;
        expect(answered.status).toBe(200);
        expect(answered.headers.get('electric-cursor')).toBeTruthy();
        for (const request of [initial, catchUp, sse]) {
          const res = await request;
          expect(res.status).toBe(503);
          expect(await res.json()).toEqual({ error: 'access_changed' });
          expect(res.headers.get('cache-control')).toBe(SHAPE_CACHE_CONTROL);
          expect(res.headers.get('electric-handle')).toBeNull();
        }
      });
    });

    it('an access change that lands between the permission reads and the registration still ends the request', async () => {
      await withTempDatabase(async (db) => {
        const f = await createWorkspaceFixture(db.orm);
        const bus = createAccessBus();
        const upstream = hangingUpstream();
        const app = buildApp(db, upstream.fetchUpstream, bus);
        // The owner removes the member right after the team access was read: the actor is already authorised.
        hooks.inLoadTeamAccess = () => bus.accessChanged(f.workspaceId, [f.members.member.id]);

        const res = await get(
          app,
          `${issuesPath(f, 'eng')}?offset=5_1&handle=h-1&cursor=77&live=true`,
          as(f.members.member.id),
        );

        // Answered like any ended long-poll, so the client asks again and is authorised against the new state.
        expect(res.status).toBe(200);
        expect(await res.json()).toEqual([{ headers: { control: 'up-to-date' } }]);
        expect(upstream.calls).toHaveLength(0);
        expect(bus.tracked()).toBe(0);
      });
    });

    it('a change for another member, or one that came before the request began, does not end it', async () => {
      await withTempDatabase(async (db) => {
        const f = await createWorkspaceFixture(db.orm);
        const bus = createAccessBus();
        const upstream = hangingUpstream();
        const app = buildApp(db, upstream.fetchUpstream, bus);
        bus.accessChanged(f.workspaceId, [f.members.member.id]);
        hooks.inLoadTeamAccess = () => bus.accessChanged(f.workspaceId, [f.members.owner.id]);

        const pending = get(app, `${issuesPath(f, 'eng')}?offset=-1`, as(f.members.member.id));
        await vi.waitFor(() => expect(bus.tracked()).toBe(1));

        expect(upstream.calls).toHaveLength(1);
        bus.accessChanged(f.workspaceId, 'all');
        expect((await pending).status).toBe(503);
      });
    });

    it("another member's open request is left alone", async () => {
      await withTempDatabase(async (db) => {
        const f = await createWorkspaceFixture(db.orm);
        const bus = createAccessBus();
        const upstream = hangingUpstream();
        const app = buildApp(db, upstream.fetchUpstream, bus);
        const other = get(app, `${issuesPath(f, 'eng')}?offset=-1`, as(f.members.owner.id));
        await vi.waitFor(() => expect(bus.tracked()).toBe(1));

        bus.accessChanged(f.workspaceId, [f.members.member.id]);

        expect(bus.tracked()).toBe(1);
        bus.accessChanged(f.workspaceId, 'all');
        expect((await other).status).toBe(503);
      });
    });

    it('a client that goes away is not answered and is unregistered', async () => {
      await withTempDatabase(async (db) => {
        const f = await createWorkspaceFixture(db.orm);
        const bus = createAccessBus();
        const upstream = hangingUpstream();
        const app = buildApp(db, upstream.fetchUpstream, bus);
        const controller = new AbortController();

        const pending = get(
          app,
          `${issuesPath(f, 'eng')}?offset=-1`,
          as(f.members.member.id, { signal: controller.signal }),
        );
        await vi.waitFor(() => expect(bus.tracked()).toBe(1));
        controller.abort();
        await pending.catch(() => undefined);

        await vi.waitFor(() => expect(bus.tracked()).toBe(0));
      });
    });

    it('unregister on normal completion: after the body, a body-less answer, a refused status and a failure', async () => {
      await withTempDatabase(async (db) => {
        const f = await createWorkspaceFixture(db.orm);
        const bus = createAccessBus();
        const answers: Array<() => Response | Promise<Response>> = [
          emptyShape,
          () => new Response(null, { status: 204, headers: { 'electric-handle': 'h-1' } }),
          () => new Response('nope', { status: 401 }),
          () => {
            throw new TypeError('fetch failed');
          },
        ];
        let call = 0;
        const upstream = fakeUpstream(() => (answers[call++] as () => Response)());
        const app = buildApp(db, upstream.fetchUpstream, bus);
        vi.spyOn(console, 'error').mockImplementation(() => {});

        for (let i = 0; i < answers.length; i++) {
          const res = await get(app, `${issuesPath(f, 'eng')}?offset=-1`, as(f.members.member.id));
          await res.text();
          expect(bus.tracked(), `after answer ${i}`).toBe(0);
        }
      });
    });

    it('an answer that is still streaming when access changes is cut off, and unregisters', async () => {
      await withTempDatabase(async (db) => {
        const f = await createWorkspaceFixture(db.orm);
        const bus = createAccessBus();
        const upstream = fakeUpstream((call) => {
          const body = new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(new TextEncoder().encode('[{"key":"1"}'));
              call.init?.signal?.addEventListener('abort', () =>
                controller.error(new DOMException('aborted', 'AbortError')),
              );
            },
          });
          return new Response(body, {
            status: 200,
            headers: { 'content-type': 'application/json', 'electric-handle': 'h-1' },
          });
        });
        const app = buildApp(db, upstream.fetchUpstream, bus);

        const res = await get(
          app,
          `${issuesPath(f, 'eng')}?offset=-1&live_sse=true`,
          as(f.members.member.id),
        );
        const reader = res.body?.getReader();
        expect((await reader?.read())?.done).toBe(false);
        expect(bus.tracked()).toBe(1);
        bus.accessChanged(f.workspaceId, [f.members.member.id]);

        await expect(reader?.read()).rejects.toThrow();
        expect(bus.tracked()).toBe(0);
      });
    });

    it('a reader that cancels the answer unregisters it', async () => {
      await withTempDatabase(async (db) => {
        const f = await createWorkspaceFixture(db.orm);
        const bus = createAccessBus();
        const upstream = fakeUpstream(
          () => new Response(new ReadableStream<Uint8Array>({ start() {} }), { status: 200 }),
        );
        const app = buildApp(db, upstream.fetchUpstream, bus);

        const res = await get(app, `${issuesPath(f, 'eng')}?offset=-1`, as(f.members.member.id));
        expect(bus.tracked()).toBe(1);
        await res.body?.cancel();

        expect(bus.tracked()).toBe(0);
      });
    });
  });

  it('an actor of another workspace returned by the resolver is not trusted (401, Electric not called)', async () => {
    await withTempDatabase(async (db) => {
      const a = await createWorkspaceFixture(db.orm);
      const b = await createWorkspaceFixture(db.orm);
      const upstream = fakeUpstream(emptyShape);
      const wrongWorkspaceResolver = {
        // A buggy resolver that ignores the workspace in the URL.
        resolveActor: async () => loadClientActor(db.orm, b.workspaceId, b.members.owner.id, 'web'),
      };
      const app = createApp({
        brand,
        db,
        electric: { url: UPSTREAM, secret: SECRET },
        auth: wrongWorkspaceResolver,
        config: TEST_APP_CONFIG,
        fetchUpstream: upstream.fetchUpstream,
      });

      const teams = await get(app, `/api/sync/w/${a.workspaceId}/teams?offset=-1`);
      const issues = await get(app, `${issuesPath(a, 'eng')}?offset=-1`);

      expect([teams.status, issues.status]).toEqual([401, 401]);
      expect(upstream.calls).toHaveLength(0);
    });
  });

  it('forwards only protocol parameters Electric 1.8 defines, and never subset queries', () => {
    const forwarded = [...SYNC_FORWARDED_PARAMS];
    // Drift guard: every name we forward is still a protocol parameter of the pinned client.
    for (const name of forwarded) expect(ELECTRIC_PROTOCOL_QUERY_PARAMS).toContain(name);
    // The only protocol parameters we deliberately drop are the client-supplied subset queries.
    const dropped = (ELECTRIC_PROTOCOL_QUERY_PARAMS as readonly string[]).filter(
      (name) => !forwarded.includes(name),
    );
    expect(dropped.every((name) => name.startsWith('subset__'))).toBe(true);
    for (const owned of ['table', 'where', 'columns', 'secret', 'params', 'replica']) {
      expect(forwarded).not.toContain(owned);
    }
  });

  it('only GET is served', async () => {
    await withTempDatabase(async (db) => {
      const f = await createWorkspaceFixture(db.orm);
      const upstream = fakeUpstream(emptyShape);
      const app = buildApp(db, upstream.fetchUpstream);

      expect((await get(app, issuesPath(f, 'eng'), as(f.members.owner.id))).status).toBe(200);
      upstream.calls.length = 0;

      const res = await get(
        app,
        issuesPath(f, 'eng'),
        as(f.members.owner.id, { method: 'DELETE', headers: { origin: TEST_ORIGIN } }),
      );

      expect(res.status).toBeGreaterThanOrEqual(404);
      expect(upstream.calls).toHaveLength(0);
    });
  });
});

const membersPath = (f: WorkspaceFixture) => `/api/sync/w/${f.workspaceId}/members`;
const teamMembersPath = (f: WorkspaceFixture, team: 'eng' | 'ops') =>
  `/api/sync/w/${f.workspaceId}/teams/${f.teams[team].id}/members`;

/** The values the proxy sent for `params[1]`, `params[2]`, ... in order. */
function sentParams(call: Call | undefined): string[] {
  const q = call?.url.searchParams;
  const values: string[] = [];
  for (let n = 1; q?.has(`params[${n}]`); n++) values.push(q.get(`params[${n}]`) as string);
  return values;
}

const sorted = (ids: string[]) => [...ids].sort();

describe.skipIf(!databaseUrl)('GET /api/sync members and team members (fake Electric)', () => {
  it('a guest of ENG gets self plus the ENG co-members and nobody else', async () => {
    await withTempDatabase(async (db) => {
      const f = await createWorkspaceFixture(db.orm);
      const upstream = fakeUpstream(emptyShape);
      const app = buildApp(db, upstream.fetchUpstream);

      const res = await get(app, `${membersPath(f)}?offset=-1`, as(f.members.guest.id));

      expect(res.status).toBe(200);
      expect(upstream.calls).toHaveLength(1);
      const q = upstream.calls[0]?.url.searchParams;
      expect(q?.get('table')).toBe('member');
      expect(q?.get('where')).toBe('workspace_id = $1 AND id IN ($2, $3, $4, $5)');
      expect(sentParams(upstream.calls[0])).toEqual([
        f.workspaceId,
        ...sorted([
          f.members.guest.id,
          f.members.owner.id,
          f.members.admin.id,
          f.members.member.id,
        ]),
      ]);
      // The outsider shares no team with the guest.
      expect(sentParams(upstream.calls[0])).not.toContain(f.members.outsider.id);
      expect(q?.get('columns')).toBe(MEMBER_COLUMNS.join(','));
      expect(q?.get('columns')).not.toMatch(/email|timezone/);
    });
  });

  it('the guest shape is recomputed per request: joining OPS adds its members, leaving ENG drops its own', async () => {
    await withTempDatabase(async (db) => {
      const f = await createWorkspaceFixture(db.orm);
      const opsOnly = await addMember(db.orm, f.workspaceId, 'member', {
        teamIds: [f.teams.ops.id],
      });
      const upstream = fakeUpstream(emptyShape);
      const app = buildApp(db, upstream.fetchUpstream);
      const guest = as(f.members.guest.id);
      const idsNow = async () => {
        upstream.calls.length = 0;
        const res = await get(app, `${membersPath(f)}?offset=-1`, guest);
        expect(res.status).toBe(200);
        return sentParams(upstream.calls[0]).slice(1);
      };

      // Before: ENG only. The OPS-only member is invisible.
      const before = await idsNow();
      expect(before).not.toContain(opsOnly.id);
      expect(before).toContain(f.members.admin.id);

      // Added to OPS: the next request includes the OPS members.
      await db.orm.insert(teamMember).values({
        workspaceId: f.workspaceId,
        teamId: f.teams.ops.id,
        memberId: f.members.guest.id,
      });
      const joined = await idsNow();
      expect(joined).toContain(opsOnly.id);
      expect(joined).toContain(f.members.admin.id);
      expect(joined).not.toContain(f.members.outsider.id);

      // Removed from ENG: the ENG-only admin is gone, the OPS co-members stay.
      await db.orm
        .delete(teamMember)
        .where(
          and(eq(teamMember.teamId, f.teams.eng.id), eq(teamMember.memberId, f.members.guest.id)),
        );
      const left = await idsNow();
      expect(left).not.toContain(f.members.admin.id);
      expect(left).toContain(opsOnly.id);
      expect(left).toContain(f.members.owner.id);
      expect(left).toContain(f.members.member.id);
      expect(left).toContain(f.members.guest.id);
    });
  });

  it('a guest in no team gets only themselves', async () => {
    await withTempDatabase(async (db) => {
      const f = await createWorkspaceFixture(db.orm);
      const lonely = await addMember(db.orm, f.workspaceId, 'guest');
      const upstream = fakeUpstream(emptyShape);
      const app = buildApp(db, upstream.fetchUpstream);

      const res = await get(app, `${membersPath(f)}?offset=-1`, as(lonely.id));

      expect(res.status).toBe(200);
      expect(sentParams(upstream.calls[0])).toEqual([f.workspaceId, lonely.id]);
    });
  });

  it('members, admins and owners get the whole workspace: one parameter, no id list', async () => {
    await withTempDatabase(async (db) => {
      const f = await createWorkspaceFixture(db.orm);
      const upstream = fakeUpstream(emptyShape);
      const app = buildApp(db, upstream.fetchUpstream);

      for (const who of ['member', 'admin', 'owner', 'outsider'] as const) {
        upstream.calls.length = 0;
        const res = await get(app, `${membersPath(f)}?offset=-1`, as(f.members[who].id));

        expect(res.status, who).toBe(200);
        const q = upstream.calls[0]?.url.searchParams;
        expect(q?.get('table'), who).toBe('member');
        expect(q?.get('where'), who).toBe('workspace_id = $1');
        expect(sentParams(upstream.calls[0]), who).toEqual([f.workspaceId]);
        expect(q?.get('columns'), who).toBe(MEMBER_COLUMNS.join(','));
      }
    });
  });

  it('client table, where, columns, params[2] and the rest never reach Electric on the member shapes', async () => {
    await withTempDatabase(async (db) => {
      const f = await createWorkspaceFixture(db.orm);
      const upstream = fakeUpstream(emptyShape);
      const app = buildApp(db, upstream.fetchUpstream);
      const hostile = new URLSearchParams({
        offset: '-1',
        table: 'session',
        where: '1=1',
        columns: 'email,timezone',
        secret: 'hunter2',
        'params[1]': 'evil',
        'params[2]': f.members.outsider.id,
        'params[9]': 'evil9',
        params: '{"1":"evil"}',
        replica: 'full',
        subset__where: "email like 'a%'",
      });

      const cases: [string, string, RequestInit, string, string[]][] = [
        ['guest members', membersPath(f), as(f.members.guest.id), 'member', []],
        ['member members', membersPath(f), as(f.members.member.id), 'member', []],
        [
          'team members',
          teamMembersPath(f, 'eng'),
          as(f.members.guest.id),
          'team_member',
          [f.teams.eng.id],
        ],
      ];
      for (const [name, path, init, table, teamParams] of cases) {
        upstream.calls.length = 0;
        const res = await get(app, `${path}?${hostile}`, init);

        expect(res.status, name).toBe(200);
        const sent = upstream.calls[0]?.url;
        const q = sent?.searchParams;
        expect(q?.getAll('table'), name).toEqual([table]);
        expect(q?.getAll('where'), name).toHaveLength(1);
        expect(q?.get('where'), name).not.toContain('1=1');
        expect(q?.getAll('columns'), name).toHaveLength(1);
        expect(q?.get('columns'), name).not.toMatch(/email|timezone/);
        expect(q?.getAll('secret'), name).toEqual([SECRET]);
        expect(q?.has('params'), name).toBe(false);
        expect(q?.has('replica'), name).toBe(false);
        expect(q?.has('params[9]'), name).toBe(false);
        expect(
          [...(q?.keys() ?? [])].filter((k) => k.startsWith('subset__')),
          name,
        ).toEqual([]);
        expect(sent?.href, name).not.toContain('evil');
        expect(sent?.href, name).not.toContain('hunter2');
        if (teamParams.length > 0) expect(sentParams(upstream.calls[0]), name).toEqual(teamParams);
        // The client's own `params[2]` (the outsider) never lands in a shape; only the server's values do.
        if (name === 'guest members') {
          expect(sentParams(upstream.calls[0])).not.toContain(f.members.outsider.id);
        }
        if (name === 'member members') {
          expect(sentParams(upstream.calls[0])).toEqual([f.workspaceId]);
        }
      }
    });
  });

  it('team members: a team the actor can see is served with params[1] = its stored id', async () => {
    await withTempDatabase(async (db) => {
      const f = await createWorkspaceFixture(db.orm);
      const upstream = fakeUpstream(emptyShape);
      const app = buildApp(db, upstream.fetchUpstream);

      const visible: [keyof WorkspaceFixture['members'], 'eng' | 'ops'][] = [
        ['guest', 'eng'],
        ['member', 'eng'],
        ['member', 'ops'],
        ['owner', 'ops'],
        ['outsider', 'eng'],
      ];
      for (const [who, team] of visible) {
        upstream.calls.length = 0;
        const res = await get(app, `${teamMembersPath(f, team)}?offset=-1`, as(f.members[who].id));

        expect(res.status, `${who} ${team}`).toBe(200);
        const q = upstream.calls[0]?.url.searchParams;
        expect(q?.get('table')).toBe('team_member');
        expect(q?.get('where')).toBe('team_id = $1');
        expect(sentParams(upstream.calls[0])).toEqual([f.teams[team].id]);
        expect(q?.get('columns')).toBe('team_id,member_id,workspace_id,created_at');
      }
    });
  });

  it('team members: a team the actor cannot see answers 404 with the body of an unknown id', async () => {
    await withTempDatabase(async (db) => {
      const f = await createWorkspaceFixture(db.orm);
      const other = await createWorkspaceFixture(db.orm);
      const upstream = fakeUpstream(emptyShape);
      const app = buildApp(db, upstream.fetchUpstream);

      const unknown = await get(
        app,
        `/api/sync/w/${f.workspaceId}/teams/${UNKNOWN_UUID}/members`,
        as(f.members.owner.id),
      );
      expect(unknown.status).toBe(404);
      const body = await unknown.text();
      expect(body).toBe(JSON.stringify({ error: 'not_found' }));

      // The guest and the admin are not in the private OPS team; the outsider neither.
      for (const who of ['guest', 'admin', 'outsider'] as const) {
        const res = await get(app, `${teamMembersPath(f, 'ops')}?offset=-1`, as(f.members[who].id));
        expect(res.status, who).toBe(404);
        expect(await res.text(), who).toBe(body);
      }
      // A team of another workspace, and a malformed id.
      const foreign = await get(
        app,
        `/api/sync/w/${f.workspaceId}/teams/${other.teams.eng.id}/members`,
        as(f.members.owner.id),
      );
      const malformed = await get(
        app,
        `/api/sync/w/${f.workspaceId}/teams/not-a-uuid/members`,
        as(f.members.owner.id),
      );
      expect([foreign.status, malformed.status]).toEqual([404, 404]);
      expect(await foreign.text()).toBe(body);
      expect(await malformed.text()).toBe(body);
      expect(upstream.calls).toHaveLength(0);
    });
  });

  it('team members: a guest added to a private team can then read it, and loses it again on removal', async () => {
    await withTempDatabase(async (db) => {
      const f = await createWorkspaceFixture(db.orm);
      const upstream = fakeUpstream(emptyShape);
      const app = buildApp(db, upstream.fetchUpstream);
      const guest = as(f.members.guest.id);

      expect((await get(app, teamMembersPath(f, 'ops'), guest)).status).toBe(404);
      await db.orm.insert(teamMember).values({
        workspaceId: f.workspaceId,
        teamId: f.teams.ops.id,
        memberId: f.members.guest.id,
      });
      expect((await get(app, teamMembersPath(f, 'ops'), guest)).status).toBe(200);
      await db.orm
        .delete(teamMember)
        .where(
          and(eq(teamMember.teamId, f.teams.ops.id), eq(teamMember.memberId, f.members.guest.id)),
        );
      expect((await get(app, teamMembersPath(f, 'ops'), guest)).status).toBe(404);
    });
  });

  it('a mixed-case or upper-case id is rejected on the member routes: no new shape per spelling', async () => {
    await withTempDatabase(async (db) => {
      const f = await createWorkspaceFixture(db.orm);
      const upstream = fakeUpstream(emptyShape);
      const app = buildApp(db, upstream.fetchUpstream);
      const guest = as(f.members.guest.id);
      const mixed = (id: string) =>
        [...id].map((ch, index) => (index % 2 === 0 ? ch.toUpperCase() : ch)).join('');
      const team = f.teams.eng.id;
      expect(mixed(team)).not.toBe(team);

      // Control: the canonical spellings are served, so the 404s below are decisions, not missing routes.
      expect((await get(app, membersPath(f), guest)).status).toBe(200);
      expect((await get(app, teamMembersPath(f, 'eng'), guest)).status).toBe(200);
      upstream.calls.length = 0;

      const paths = [
        `/api/sync/w/${mixed(f.workspaceId)}/members`,
        `/api/sync/w/${f.workspaceId.toUpperCase()}/members`,
        `/api/sync/w/${f.workspaceId}/teams/${mixed(team)}/members`,
        `/api/sync/w/${f.workspaceId}/teams/${team.toUpperCase()}/members`,
        `/api/sync/w/${mixed(f.workspaceId)}/teams/${team}/members`,
      ];
      for (const path of paths) {
        const res = await get(app, `${path}?offset=-1`, guest);
        expect(res.status, path).toBe(404);
      }
      expect(upstream.calls).toHaveLength(0);
    });
  });

  it('no actor, a deactivated member and an actor of another workspace -> 401, Electric never called', async () => {
    await withTempDatabase(async (db) => {
      const f = await createWorkspaceFixture(db.orm);
      const other = await createWorkspaceFixture(db.orm);
      await db.orm
        .update(member)
        .set({ deactivatedAt: new Date() })
        .where(eq(member.id, f.members.member.id));
      const upstream = fakeUpstream(emptyShape);
      const app = buildApp(db, upstream.fetchUpstream);

      for (const path of [membersPath(f), teamMembersPath(f, 'eng')]) {
        const anonymous = await get(app, path);
        expect(anonymous.status, path).toBe(401);
        expect(await anonymous.json()).toEqual({ error: 'unauthenticated' });
        expect((await get(app, path, as(f.members.member.id))).status, path).toBe(401);
        // The cookie of workspace B on the URL of workspace A.
        expect((await get(app, path, as(other.members.owner.id))).status, path).toBe(401);
      }
      expect(upstream.calls).toHaveLength(0);
    });
  });

  it('shape responses keep the private cache headers and Vary: Cookie', async () => {
    await withTempDatabase(async (db) => {
      const f = await createWorkspaceFixture(db.orm);
      const upstream = fakeUpstream(
        () =>
          new Response('[{"headers":{"control":"up-to-date"}}]', {
            status: 200,
            headers: {
              'content-type': 'application/json',
              'cache-control': 'public, max-age=60, stale-while-revalidate=300',
              vary: 'Accept-Encoding',
              'electric-handle': 'h-88',
              'access-control-allow-origin': '*',
            },
          }),
      );
      const app = buildApp(db, upstream.fetchUpstream);

      for (const [name, path] of [
        ['members', membersPath(f)],
        ['team members', teamMembersPath(f, 'eng')],
      ] as const) {
        const res = await get(app, `${path}?offset=-1`, as(f.members.guest.id));

        expect(res.status, name).toBe(200);
        expect(res.headers.get('cache-control'), name).toBe('private, no-cache');
        expect(res.headers.get('vary')?.split(/\s*,\s*/), name).toEqual(
          expect.arrayContaining(['Accept-Encoding', 'Cookie']),
        );
        expect(res.headers.get('electric-handle'), name).toBe('h-88');
        expect(res.headers.get('access-control-allow-origin'), name).toBeNull();
      }
    });
  });

  it('only GET is served on the member routes', async () => {
    await withTempDatabase(async (db) => {
      const f = await createWorkspaceFixture(db.orm);
      const upstream = fakeUpstream(emptyShape);
      const app = buildApp(db, upstream.fetchUpstream);

      for (const path of [membersPath(f), teamMembersPath(f, 'eng')]) {
        // Control: a GET of the same path is served.
        expect((await get(app, path, as(f.members.owner.id))).status, path).toBe(200);
        upstream.calls.length = 0;

        const res = await get(
          app,
          path,
          as(f.members.owner.id, { method: 'POST', headers: { origin: TEST_ORIGIN } }),
        );
        expect(res.status, path).toBeGreaterThanOrEqual(404);
        expect(upstream.calls, path).toHaveLength(0);
      }
    });
  });
});

const ownMembershipsPath = (f: WorkspaceFixture) =>
  `/api/sync/w/${f.workspaceId}/me/team-memberships`;

describe.skipIf(!databaseUrl)(
  'GET /api/sync/w/:workspaceId/me/team-memberships (fake Electric)',
  () => {
    it('the shape is built from the actor: member_id and where in the query are ignored', async () => {
      await withTempDatabase(async (db) => {
        const f = await createWorkspaceFixture(db.orm);
        const upstream = fakeUpstream(emptyShape);
        const app = buildApp(db, upstream.fetchUpstream);
        const hostile = new URLSearchParams({
          offset: '-1',
          member_id: f.members.owner.id,
          memberId: f.members.owner.id,
          where: '1=1',
          table: 'member',
          'params[2]': f.members.owner.id,
        });

        const res = await get(app, `${ownMembershipsPath(f)}?${hostile}`, as(f.members.guest.id));

        expect(res.status).toBe(200);
        expect(upstream.calls).toHaveLength(1);
        const q = upstream.calls[0]?.url.searchParams;
        expect(q?.getAll('table')).toEqual(['team_member']);
        expect(q?.getAll('where')).toEqual(['workspace_id = $1 AND member_id = $2']);
        expect(sentParams(upstream.calls[0])).toEqual([f.workspaceId, f.members.guest.id]);
        expect(q?.get('columns')).toBe('team_id,member_id,workspace_id,created_at');
        expect(q?.getAll('secret')).toEqual([SECRET]);
        expect(res.headers.get('cache-control')).toBe('private, no-cache');
        expect(res.headers.get('vary')).toContain('Cookie');
      });
    });

    it('answers 401 without a session and 404 for a malformed workspace id, Electric never called', async () => {
      await withTempDatabase(async (db) => {
        const f = await createWorkspaceFixture(db.orm);
        const upstream = fakeUpstream(emptyShape);
        const app = buildApp(db, upstream.fetchUpstream);

        const anonymous = await get(app, `${ownMembershipsPath(f)}?offset=-1`);
        const malformed = await get(
          app,
          '/api/sync/w/not-a-uuid/me/team-memberships?offset=-1',
          as(f.members.member.id),
        );

        expect(anonymous.status).toBe(401);
        expect(malformed.status).toBe(404);
        // The same body as the `/teams` route gives a malformed id.
        const teamsMalformed = await get(
          app,
          '/api/sync/w/not-a-uuid/teams?offset=-1',
          as(f.members.member.id),
        );
        expect(await malformed.json()).toEqual(await teamsMalformed.json());
        expect(upstream.calls).toHaveLength(0);
      });
    });

    it('a deactivated member and an actor of another workspace -> 401, Electric never called', async () => {
      await withTempDatabase(async (db) => {
        const f = await createWorkspaceFixture(db.orm);
        const other = await createWorkspaceFixture(db.orm);
        await db.orm
          .update(member)
          .set({ deactivatedAt: new Date() })
          .where(eq(member.id, f.members.member.id));
        const upstream = fakeUpstream(emptyShape);
        const app = buildApp(db, upstream.fetchUpstream);

        const deactivated = await get(
          app,
          `${ownMembershipsPath(f)}?offset=-1`,
          as(f.members.member.id),
        );
        const foreign = await get(
          app,
          `${ownMembershipsPath(f)}?offset=-1`,
          as(other.members.owner.id),
        );

        expect(deactivated.status).toBe(401);
        expect(foreign.status).toBe(401);
        expect(upstream.calls).toHaveLength(0);
      });
    });

    it('only GET is served', async () => {
      await withTempDatabase(async (db) => {
        const f = await createWorkspaceFixture(db.orm);
        const upstream = fakeUpstream(emptyShape);
        const app = buildApp(db, upstream.fetchUpstream);

        const res = await get(
          app,
          ownMembershipsPath(f),
          as(f.members.owner.id, { method: 'POST', headers: { origin: TEST_ORIGIN } }),
        );

        expect(res.status).toBeGreaterThanOrEqual(404);
        expect(upstream.calls).toHaveLength(0);
      });
    });
  },
);

// Real Electric reads the dev database (`torch`) itself, so these tests create their fixture THERE (not in a
// temp database) and remove it again afterwards.
describe.skipIf(!databaseUrl || !electricUrl)('GET /api/sync (real Electric)', () => {
  type Message = {
    key?: string;
    value?: Record<string, unknown>;
    headers: Record<string, unknown>;
  };

  async function removeWorkspace(db: Db, workspaceId: string) {
    for (const table of ['audit_log', 'issue', 'workflow_state', 'team_member', 'team', 'member']) {
      await db.pool.query(`delete from ${table} where workspace_id = $1`, [workspaceId]);
    }
    await db.pool.query('delete from workspace where id = $1', [workspaceId]);
  }

  async function withDevWorkspace(fn: (db: Db, f: WorkspaceFixture) => Promise<void>) {
    const db = createDb(databaseUrl as string);
    const f = await createWorkspaceFixture(db.orm);
    try {
      await fn(db, f);
    } finally {
      await removeWorkspace(db, f.workspaceId);
      await db.close();
    }
  }

  async function rows(res: Response): Promise<Record<string, unknown>[]> {
    expect(res.status, await res.clone().text()).toBe(200);
    const messages = (await res.json()) as Message[];
    return messages.filter((m) => m.value).map((m) => m.value as Record<string, unknown>);
  }

  const realApp = (db: Db, accessBus?: AccessBus) =>
    createApp({
      brand,
      db,
      electric: { url: electricUrl as string, secret: electricSecret },
      auth: headerActorResolver(db.orm),
      config: TEST_APP_CONFIG,
      accessBus,
    });

  async function waitUntil(condition: () => boolean, ms: number, what: string) {
    const deadline = Date.now() + ms;
    while (!condition()) {
      if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }

  it('real Electric returns only ENG rows for the ENG shape, without description', async () => {
    await withDevWorkspace(async (db, f) => {
      const app = realApp(db);

      const res = await get(app, `${issuesPath(f, 'eng')}?offset=-1`, as(f.members.member.id));
      const issues = await rows(res);

      expect(issues).toHaveLength(f.issues.eng.length);
      expect(new Set(issues.map((i) => i.id))).toEqual(new Set(f.issues.eng.map((i) => i.id)));
      for (const issue of issues) {
        expect(issue.team_id).toBe(f.teams.eng.id);
        expect(issue.workspace_id).toBe(f.workspaceId);
        expect(Object.keys(issue)).not.toContain('description');
      }
      expect(res.headers.get('cache-control') ?? '').not.toContain('public');
    });
  }, 30_000);

  it('real Electric: the OPS shape serves members and nobody else; states come with the team', async () => {
    await withDevWorkspace(async (db, f) => {
      const app = realApp(db);

      const asMember = await get(app, `${issuesPath(f, 'ops')}?offset=-1`, as(f.members.member.id));
      const asGuest = await get(app, `${issuesPath(f, 'ops')}?offset=-1`, as(f.members.guest.id));
      const states = await get(
        app,
        `/api/sync/w/${f.workspaceId}/teams/${f.teams.ops.id}/workflow-states?offset=-1`,
        as(f.members.member.id),
      );

      expect(new Set((await rows(asMember)).map((i) => i.id))).toEqual(
        new Set(f.issues.ops.map((i) => i.id)),
      );
      expect(asGuest.status).toBe(404);
      const stateRows = await rows(states);
      expect(stateRows).toHaveLength(Object.keys(f.states.ops).length);
      expect(stateRows.every((s) => s.team_id === f.teams.ops.id)).toBe(true);
    });
  }, 30_000);

  it('real Electric: the teams shape lists exactly the teams the actor may see', async () => {
    await withDevWorkspace(async (db, f) => {
      const app = realApp(db);
      const keysFor = async (who: keyof WorkspaceFixture['members']) => {
        const res = await get(
          app,
          `/api/sync/w/${f.workspaceId}/teams?offset=-1`,
          as(f.members[who].id),
        );
        return (await rows(res)).map((t) => t.id).sort();
      };

      expect(await keysFor('owner')).toEqual([f.teams.eng.id, f.teams.ops.id].sort());
      expect(await keysFor('member')).toEqual([f.teams.eng.id, f.teams.ops.id].sort());
      expect(await keysFor('guest')).toEqual([f.teams.eng.id]);
      expect(await keysFor('outsider')).toEqual([f.teams.eng.id]);
    });
  }, 30_000);
  it('real Electric: a guest member shape holds self and ENG co-members, never the outsider, never email or timezone', async () => {
    await withDevWorkspace(async (db, f) => {
      const app = realApp(db);

      const res = await get(app, `${membersPath(f)}?offset=-1`, as(f.members.guest.id));
      const members = await rows(res);

      expect(new Set(members.map((m) => m.id))).toEqual(
        new Set([f.members.guest.id, f.members.owner.id, f.members.admin.id, f.members.member.id]),
      );
      expect(members.map((m) => m.id)).not.toContain(f.members.outsider.id);
      for (const row of members) {
        expect(Object.keys(row).sort()).toEqual([...MEMBER_COLUMNS].sort());
        expect(row.workspace_id).toBe(f.workspaceId);
      }
      // The emails are in the database; none of them is in the response.
      const body = JSON.stringify(members);
      for (const m of Object.values(f.members)) expect(body).not.toContain(m.email);
      expect(res.headers.get('cache-control') ?? '').not.toContain('public');
    });
  }, 30_000);

  it('real Electric: a member gets the whole workspace, still without email or timezone', async () => {
    await withDevWorkspace(async (db, f) => {
      const app = realApp(db);

      const res = await get(app, `${membersPath(f)}?offset=-1`, as(f.members.member.id));
      const members = await rows(res);

      expect(new Set(members.map((m) => m.id))).toEqual(
        new Set(Object.values(f.members).map((m) => m.id)),
      );
      for (const row of members) {
        expect(Object.keys(row)).not.toContain('email');
        expect(Object.keys(row)).not.toContain('timezone');
      }
    });
  }, 30_000);

  it('real Electric: team members come per team, and the private team is closed to a guest', async () => {
    await withDevWorkspace(async (db, f) => {
      const app = realApp(db);

      const eng = await rows(
        await get(app, `${teamMembersPath(f, 'eng')}?offset=-1`, as(f.members.guest.id)),
      );
      const ops = await rows(
        await get(app, `${teamMembersPath(f, 'ops')}?offset=-1`, as(f.members.member.id)),
      );
      const guestOps = await get(
        app,
        `${teamMembersPath(f, 'ops')}?offset=-1`,
        as(f.members.guest.id),
      );

      expect(new Set(eng.map((r) => r.member_id))).toEqual(
        new Set([f.members.owner.id, f.members.admin.id, f.members.member.id, f.members.guest.id]),
      );
      expect(eng.every((r) => r.team_id === f.teams.eng.id)).toBe(true);
      expect(new Set(ops.map((r) => r.member_id))).toEqual(
        new Set([f.members.owner.id, f.members.member.id]),
      );
      for (const row of [...eng, ...ops]) {
        expect(Object.keys(row).sort()).toEqual(
          ['created_at', 'member_id', 'team_id', 'workspace_id'].sort(),
        );
      }
      expect(guestOps.status).toBe(404);
    });
  }, 30_000);

  it('real Electric: a guest gets only their own team rows, a member their own in several teams', async () => {
    await withDevWorkspace(async (db, f) => {
      const app = realApp(db);

      const guest = await rows(
        await get(app, `${ownMembershipsPath(f)}?offset=-1`, as(f.members.guest.id)),
      );
      const member = await rows(
        await get(app, `${ownMembershipsPath(f)}?offset=-1`, as(f.members.member.id)),
      );

      expect(guest.map((r) => [r.team_id, r.member_id])).toEqual([
        [f.teams.eng.id, f.members.guest.id],
      ]);
      expect(new Set(member.map((r) => r.team_id))).toEqual(
        new Set([f.teams.eng.id, f.teams.ops.id]),
      );
      for (const row of [...guest, ...member]) {
        expect(Object.keys(row).sort()).toEqual(
          ['created_at', 'member_id', 'team_id', 'workspace_id'].sort(),
        );
      }
    });
  }, 30_000);

  it('real Electric: joining a private team reaches the open live request in under 2 s', async () => {
    await withDevWorkspace(async (db, f) => {
      const app = realApp(db);
      const who = as(f.members.outsider.id);
      const initial = await get(app, `${ownMembershipsPath(f)}?offset=-1`, who);
      expect(await rows(initial.clone())).toEqual([]);
      const handle = initial.headers.get('electric-handle');
      const offset = initial.headers.get('electric-offset');
      expect(handle).toBeTruthy();

      const live = get(
        app,
        `${ownMembershipsPath(f)}?offset=${offset}&handle=${handle}&live=true`,
        {
          ...who,
          signal: AbortSignal.timeout(20_000),
        },
      );
      await new Promise((resolve) => setTimeout(resolve, 300));
      const started = Date.now();
      await db.orm.insert(teamMember).values({
        workspaceId: f.workspaceId,
        teamId: f.teams.ops.id,
        memberId: f.members.outsider.id,
      });

      const liveRes = await live;
      const elapsed = Date.now() - started;
      const joined = (await liveRes.json()) as Message[];
      const change = joined.find((m) => m.value?.team_id === f.teams.ops.id);

      expect(liveRes.status).toBe(200);
      expect(change?.headers.operation).toBe('insert');
      expect(change?.value?.member_id).toBe(f.members.outsider.id);
      expect(elapsed).toBeLessThan(2000);
    });
  }, 30_000);

  it('real Electric: the real client carries on after an access change ends its open long-poll', async () => {
    await withDevWorkspace(async (db, f) => {
      const bus = createAccessBus();
      const app = realApp(db, bus);
      const who = f.members.member.id;
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const stop = new AbortController();
      const answers: string[] = [];
      const stream = new ShapeStream({
        url: `http://localhost${issuesPath(f, 'ops')}`,
        signal: stop.signal,
        fetchClient: async (input, init) => {
          const headers = new Headers(init?.headers);
          headers.set(TEST_MEMBER_HEADER, who);
          const res = await app.fetch(new Request(input, { ...init, headers }));
          void res
            .clone()
            .text()
            .then((body) => answers.push(`${res.status} ${body.slice(0, 60)}`));
          return res;
        },
      });
      const shape = new Shape(stream);
      try {
        expect((await shape.rows).length).toBe(f.issues.ops.length);
        await waitUntil(() => bus.tracked() > 0, 5000, 'the live request to open');

        answers.length = 0;
        const changedAt = Date.now();
        bus.accessChanged(f.workspaceId, [who]);
        await db.orm.insert(issue).values({
          workspaceId: f.workspaceId,
          teamId: f.teams.ops.id,
          number: 99,
          title: 'After the change',
          stateId: f.states.ops.backlog.id,
          creatorId: f.members.owner.id,
        });

        await waitUntil(
          () => shape.currentRows.some((row) => row.title === 'After the change'),
          8000,
          'the new issue to reach the client',
        );
        // The open request really was ended by the change (the long-poll would have waited 20 s), the client asked
        // again at once, and it neither complained about the proxy nor fell into a retry loop on the way.
        expect(answers).toContain('200 [{"headers":{"control":"up-to-date"}}]');
        expect(Date.now() - changedAt).toBeLessThan(2000);
        expect(warn.mock.calls.filter((call) => String(call[0]).includes('[Electric]'))).toEqual(
          [],
        );
      } finally {
        stop.abort();
      }
    });
  }, 30_000);

  it('real Electric: no rows after revoke - a request opened before the removal never sees a later row', async () => {
    await withDevWorkspace(async (db, f) => {
      const bus = createAccessBus();
      const app = realApp(db, bus);
      const who = as(f.members.member.id);
      const initial = await get(app, `${issuesPath(f, 'ops')}?offset=-1`, who);
      expect((await rows(initial.clone())).length).toBe(f.issues.ops.length);
      const handle = initial.headers.get('electric-handle');
      const offset = initial.headers.get('electric-offset');

      const live = get(app, `${issuesPath(f, 'ops')}?offset=${offset}&handle=${handle}&live=true`, {
        ...who,
        signal: AbortSignal.timeout(20_000),
      });
      await waitUntil(() => bus.tracked() > 0, 5000, 'the live request to open');

      const removed = await get(
        app,
        `/api/w/${f.workspaceId}/teams/${f.teams.ops.id}/members/${f.members.member.id}`,
        as(f.members.owner.id, { method: 'DELETE', headers: { origin: TEST_ORIGIN } }),
      );
      expect(removed.status).toBe(200);
      await db.orm.insert(issue).values({
        workspaceId: f.workspaceId,
        teamId: f.teams.ops.id,
        number: 99,
        title: 'Created after the removal',
        stateId: f.states.ops.backlog.id,
        creatorId: f.members.owner.id,
      });

      const liveRes = await live;
      // Ended by the removal: nothing but "up to date", never the row created after it.
      expect(await liveRes.text()).toBe('[{"headers":{"control":"up-to-date"}}]');
      const next = await get(app, `${issuesPath(f, 'ops')}?offset=${offset}&handle=${handle}`, who);
      expect(next.status).toBe(404);
    });
  }, 30_000);
});

const TEAM_DATA_ROUTES = [
  [
    'labels',
    'label',
    'id,workspace_id,team_id,parent_id,name,color,is_group,archived_at,created_at',
  ],
  ['issue-labels', 'issue_label', 'workspace_id,team_id,issue_id,label_id'],
  ['issue-subscribers', 'issue_subscriber', 'workspace_id,team_id,issue_id,member_id,created_at'],
  ['issue-links', 'issue_link', 'id,workspace_id,team_id,issue_id,url,title,created_by,created_at'],
  [
    'issue-relations',
    'issue_relation',
    'id,workspace_id,issue_id,related_issue_id,type,created_by,created_at',
  ],
] as const;

const teamDataPath = (f: WorkspaceFixture, team: 'eng' | 'ops', route: string) =>
  `/api/sync/w/${f.workspaceId}/teams/${f.teams[team].id}/${route}`;
const issuePath = (f: WorkspaceFixture, issueId: string, route: 'detail' | 'activity') =>
  `/api/sync/w/${f.workspaceId}/issues/${issueId}/${route}`;

describe.skipIf(!databaseUrl)('GET /api/sync data of the issue model (fake Electric)', () => {
  it('team data shapes: a visible team is served with params[1] = its stored id', async () => {
    await withTempDatabase(async (db) => {
      const f = await createWorkspaceFixture(db.orm);
      const upstream = fakeUpstream(emptyShape);
      const app = buildApp(db, upstream.fetchUpstream);

      for (const [route, table, columns] of TEAM_DATA_ROUTES) {
        for (const [who, team] of [
          ['guest', 'eng'],
          ['member', 'ops'],
          ['owner', 'ops'],
        ] as const) {
          upstream.calls.length = 0;
          const res = await get(
            app,
            `${teamDataPath(f, team, route)}?offset=-1`,
            as(f.members[who].id),
          );

          expect(res.status, `${route} ${who} ${team}`).toBe(200);
          const q = upstream.calls[0]?.url.searchParams;
          expect(q?.get('table')).toBe(table);
          expect(q?.get('where')).toBe(
            route === 'issue-relations' ? 'team_id = $1 OR related_team_id = $1' : 'team_id = $1',
          );
          expect(sentParams(upstream.calls[0])).toEqual([f.teams[team].id]);
          expect(q?.get('columns')).toBe(columns);
        }
      }
    });
  });

  it('team data shapes: an invisible, foreign or malformed team answers 404 with the body of an unknown id, and Electric is not called', async () => {
    await withTempDatabase(async (db) => {
      const f = await createWorkspaceFixture(db.orm);
      const other = await createWorkspaceFixture(db.orm);
      const upstream = fakeUpstream(emptyShape);
      const app = buildApp(db, upstream.fetchUpstream);
      const body = JSON.stringify({ error: 'not_found' });

      for (const [route] of TEAM_DATA_ROUTES) {
        const base = `/api/sync/w/${f.workspaceId}/teams`;
        const attempts: [string, string, string][] = [
          ['guest on OPS', teamDataPath(f, 'ops', route), f.members.guest.id],
          ['admin on OPS', teamDataPath(f, 'ops', route), f.members.admin.id],
          ['outsider on OPS', teamDataPath(f, 'ops', route), f.members.outsider.id],
          ['unknown team', `${base}/${UNKNOWN_UUID}/${route}`, f.members.owner.id],
          ['foreign team', `${base}/${other.teams.eng.id}/${route}`, f.members.owner.id],
          ['malformed team', `${base}/not-a-uuid/${route}`, f.members.owner.id],
          [
            'upper-case team',
            `${base}/${f.teams.eng.id.toUpperCase()}/${route}`,
            f.members.owner.id,
          ],
        ];
        for (const [what, path, memberId] of attempts) {
          const res = await get(app, `${path}?offset=-1`, as(memberId));

          expect(res.status, `${route} ${what}`).toBe(404);
          expect(await res.text(), `${route} ${what}`).toBe(body);
        }
        const anonymous = await get(app, teamDataPath(f, 'eng', route));
        expect(anonymous.status, route).toBe(401);
      }
      expect(upstream.calls).toHaveLength(0);
    });
  });

  it('workspace labels: every role reads them with params[1] = the workspace id', async () => {
    await withTempDatabase(async (db) => {
      const f = await createWorkspaceFixture(db.orm);
      const other = await createWorkspaceFixture(db.orm);
      const upstream = fakeUpstream(emptyShape);
      const app = buildApp(db, upstream.fetchUpstream);

      for (const who of ['owner', 'admin', 'member', 'guest', 'outsider'] as const) {
        upstream.calls.length = 0;
        const res = await get(
          app,
          `/api/sync/w/${f.workspaceId}/workspace-labels?offset=-1`,
          as(f.members[who].id),
        );

        expect(res.status, who).toBe(200);
        const q = upstream.calls[0]?.url.searchParams;
        expect(q?.get('table')).toBe('label');
        expect(q?.get('where')).toBe('workspace_id = $1 AND team_id IS NULL');
        expect(sentParams(upstream.calls[0])).toEqual([f.workspaceId]);
      }
      // No actor, and a member of another workspace: nothing is served.
      upstream.calls.length = 0;
      const anonymous = await get(app, `/api/sync/w/${f.workspaceId}/workspace-labels`);
      const foreign = await get(
        app,
        `/api/sync/w/${f.workspaceId}/workspace-labels`,
        as(other.members.owner.id),
      );
      expect(anonymous.status).toBe(401);
      expect(foreign.status).toBe(401);
      expect(upstream.calls).toHaveLength(0);
    });
  });

  it('per-issue shapes: a visible issue is served with params[1] = its stored id', async () => {
    await withTempDatabase(async (db) => {
      const f = await createWorkspaceFixture(db.orm);
      const upstream = fakeUpstream(emptyShape);
      const app = buildApp(db, upstream.fetchUpstream);
      const eng = f.issues.eng[0]?.id as string;
      const ops = f.issues.ops[0]?.id as string;

      const attempts = [
        ['guest', eng],
        ['member', ops],
        ['owner', ops],
      ] as const;
      for (const [who, issueId] of attempts) {
        for (const [route, table, where, columns] of [
          ['detail', 'issue', 'id = $1', 'id,workspace_id,team_id,description'],
          [
            'activity',
            'issue_activity',
            'issue_id = $1',
            'id,workspace_id,team_id,issue_id,actor_id,client,type,field,from_value,to_value,created_at',
          ],
        ] as const) {
          upstream.calls.length = 0;
          const res = await get(
            app,
            `${issuePath(f, issueId, route)}?offset=-1`,
            as(f.members[who].id),
          );

          expect(res.status, `${route} ${who}`).toBe(200);
          const q = upstream.calls[0]?.url.searchParams;
          expect(q?.get('table')).toBe(table);
          expect(q?.get('where')).toBe(where);
          expect(sentParams(upstream.calls[0])).toEqual([issueId]);
          expect(q?.get('columns')).toBe(columns);
        }
      }
    });
  });

  it('per-issue shapes: an invisible, foreign, unknown or malformed issue answers one 404 and Electric is not called', async () => {
    await withTempDatabase(async (db) => {
      const f = await createWorkspaceFixture(db.orm);
      const other = await createWorkspaceFixture(db.orm);
      const upstream = fakeUpstream(emptyShape);
      const app = buildApp(db, upstream.fetchUpstream);
      const ops = f.issues.ops[0]?.id as string;
      const eng = f.issues.eng[0]?.id as string;
      const body = JSON.stringify({ error: 'not_found' });

      for (const route of ['detail', 'activity'] as const) {
        const attempts: [string, string, string][] = [
          ['guest on a private-team issue', issuePath(f, ops, route), f.members.guest.id],
          ['admin on a private-team issue', issuePath(f, ops, route), f.members.admin.id],
          ['outsider on a private-team issue', issuePath(f, ops, route), f.members.outsider.id],
          ['unknown issue', issuePath(f, UNKNOWN_UUID, route), f.members.owner.id],
          [
            'issue of another workspace',
            issuePath(f, other.issues.eng[0]?.id as string, route),
            f.members.owner.id,
          ],
          ['malformed issue', issuePath(f, 'not-a-uuid', route), f.members.owner.id],
          ['upper-case issue', issuePath(f, eng.toUpperCase(), route), f.members.owner.id],
        ];
        for (const [what, path, memberId] of attempts) {
          const res = await get(app, `${path}?offset=-1`, as(memberId));

          expect(res.status, `${route} ${what}`).toBe(404);
          expect(await res.text(), `${route} ${what}`).toBe(body);
        }
        const anonymous = await get(app, issuePath(f, eng, route));
        expect(anonymous.status, route).toBe(401);
      }
      expect(upstream.calls).toHaveLength(0);
    });
  });

  it('a guest who joins the private team can read its issue, and loses it again on removal', async () => {
    await withTempDatabase(async (db) => {
      const f = await createWorkspaceFixture(db.orm);
      const upstream = fakeUpstream(emptyShape);
      const app = buildApp(db, upstream.fetchUpstream);
      const path = `${issuePath(f, f.issues.ops[0]?.id as string, 'detail')}?offset=-1`;

      expect((await get(app, path, as(f.members.guest.id))).status).toBe(404);
      await db.orm.insert(teamMember).values({
        workspaceId: f.workspaceId,
        teamId: f.teams.ops.id,
        memberId: f.members.guest.id,
      });
      expect((await get(app, path, as(f.members.guest.id))).status).toBe(200);
      await db.orm
        .delete(teamMember)
        .where(
          and(eq(teamMember.teamId, f.teams.ops.id), eq(teamMember.memberId, f.members.guest.id)),
        );
      expect((await get(app, path, as(f.members.guest.id))).status).toBe(404);
    });
  });

  it('only GET is served on the new routes', async () => {
    await withTempDatabase(async (db) => {
      const f = await createWorkspaceFixture(db.orm);
      const upstream = fakeUpstream(emptyShape);
      const app = buildApp(db, upstream.fetchUpstream);
      const paths = [
        ...TEAM_DATA_ROUTES.map(([route]) => teamDataPath(f, 'eng', route)),
        `/api/sync/w/${f.workspaceId}/workspace-labels`,
        issuePath(f, f.issues.eng[0]?.id as string, 'detail'),
        issuePath(f, f.issues.eng[0]?.id as string, 'activity'),
      ];

      for (const path of paths) {
        for (const method of ['POST', 'PUT', 'DELETE']) {
          const res = await get(app, path, {
            ...as(f.members.owner.id),
            method,
            headers: { [TEST_MEMBER_HEADER]: f.members.owner.id, origin: TEST_ORIGIN },
          });
          expect(res.status, `${method} ${path}`).toBeGreaterThanOrEqual(404);
          expect(res.status, `${method} ${path}`).toBeLessThan(500);
        }
      }
      expect(upstream.calls).toHaveLength(0);
    });
  });
});

describe.skipIf(!databaseUrl || !electricUrl)(
  'GET /api/sync data of the issue model (real Electric)',
  () => {
    type Message = { value?: Record<string, unknown>; headers: Record<string, unknown> };

    async function withDevWorkspace(fn: (db: Db, f: WorkspaceFixture) => Promise<void>) {
      const db = createDb(databaseUrl as string);
      const f = await createWorkspaceFixture(db.orm);
      try {
        await fn(db, f);
      } finally {
        // Labels and issues of this workspace only; join rows and activity go with their issues.
        await db.pool.query('delete from label where workspace_id = $1', [f.workspaceId]);
        for (const table of ['issue', 'workflow_state', 'team_member', 'team', 'member']) {
          await db.pool.query(`delete from ${table} where workspace_id = $1`, [f.workspaceId]);
        }
        await db.pool.query('delete from workspace where id = $1', [f.workspaceId]);
        await db.close();
      }
    }

    async function rows(res: Response): Promise<Record<string, unknown>[]> {
      expect(res.status).toBe(200);
      const messages = (await res.json()) as Message[];
      return messages.filter((m) => m.value).map((m) => m.value as Record<string, unknown>);
    }

    const realApp = (db: Db) =>
      createApp({
        brand,
        db,
        electric: { url: electricUrl as string, secret: electricSecret },
        auth: headerActorResolver(db.orm),
        config: TEST_APP_CONFIG,
      });

    it('relations: the row that ends in a hidden issue is present, with ids only and no title anywhere', async () => {
      await withDevWorkspace(async (db, f) => {
        const app = realApp(db);
        const visible = f.issues.eng[0];
        const hidden = f.issues.ops[0];
        if (!visible || !hidden) throw new Error('fixture issues missing');
        await db.orm.insert(issueRelation).values({
          workspaceId: f.workspaceId,
          teamId: f.teams.eng.id,
          issueId: visible.id,
          relatedTeamId: f.teams.ops.id,
          relatedIssueId: hidden.id,
          type: 'blocks',
          createdBy: f.members.owner.id,
        });

        const asGuest = await rows(
          await get(
            app,
            `${teamDataPath(f, 'eng', 'issue-relations')}?offset=-1`,
            as(f.members.guest.id),
          ),
        );

        expect(asGuest).toHaveLength(1);
        expect(asGuest[0]?.related_issue_id).toBe(hidden.id);
        const text = JSON.stringify(asGuest);
        expect(text).not.toContain(hidden.title);
        expect(text).not.toContain(visible.title);
        expect(Object.keys(asGuest[0] ?? {}).sort()).toEqual(
          [
            'created_at',
            'created_by',
            'id',
            'issue_id',
            'related_issue_id',
            'type',
            'workspace_id',
          ].sort(),
        );
        // The private team's shape holds the same row (it ends there), and the guest cannot open it.
        const ops = await rows(
          await get(
            app,
            `${teamDataPath(f, 'ops', 'issue-relations')}?offset=-1`,
            as(f.members.member.id),
          ),
        );
        expect(ops.map((r) => r.id)).toEqual(asGuest.map((r) => r.id));
        expect(
          (
            await get(
              app,
              `${teamDataPath(f, 'ops', 'issue-relations')}?offset=-1`,
              as(f.members.guest.id),
            )
          ).status,
        ).toBe(404);
      });
    }, 30_000);

    it('labels: the team shape holds the team labels, the workspace shape the labels of no team', async () => {
      await withDevWorkspace(async (db, f) => {
        const app = realApp(db);
        const [workspaceLabel] = await db.orm
          .insert(label)
          .values({
            workspaceId: f.workspaceId,
            teamId: null,
            name: 'Everywhere',
            color: '#112233',
          })
          .returning();
        const [teamLabel] = await db.orm
          .insert(label)
          .values({
            workspaceId: f.workspaceId,
            teamId: f.teams.eng.id,
            name: 'Eng only',
            color: '#445566',
          })
          .returning();
        const [opsLabel] = await db.orm
          .insert(label)
          .values({
            workspaceId: f.workspaceId,
            teamId: f.teams.ops.id,
            name: 'Ops only',
            color: '#778899',
          })
          .returning();
        if (!workspaceLabel || !teamLabel || !opsLabel) throw new Error('label insert failed');

        const workspace = await rows(
          await get(
            app,
            `/api/sync/w/${f.workspaceId}/workspace-labels?offset=-1`,
            as(f.members.guest.id),
          ),
        );
        const eng = await rows(
          await get(app, `${teamDataPath(f, 'eng', 'labels')}?offset=-1`, as(f.members.guest.id)),
        );

        expect(workspace.map((r) => r.id)).toEqual([workspaceLabel.id]);
        expect(eng.map((r) => r.id)).toEqual([teamLabel.id]);
        expect(JSON.stringify([workspace, eng])).not.toContain('Ops only');
      });
    }, 30_000);

    it('detail carries the description of the one issue, and states carry archived_at', async () => {
      await withDevWorkspace(async (db, f) => {
        const app = realApp(db);
        const issueId = f.issues.eng[0]?.id as string;

        const detail = await rows(
          await get(app, `${issuePath(f, issueId, 'detail')}?offset=-1`, as(f.members.guest.id)),
        );
        const states = await rows(
          await get(
            app,
            `/api/sync/w/${f.workspaceId}/teams/${f.teams.eng.id}/workflow-states?offset=-1`,
            as(f.members.guest.id),
          ),
        );

        expect(detail).toHaveLength(1);
        expect(Object.keys(detail[0] ?? {}).sort()).toEqual(
          ['description', 'id', 'team_id', 'workspace_id'].sort(),
        );
        expect(states.length).toBeGreaterThan(0);
        expect(states.every((s) => 'archived_at' in s)).toBe(true);
      });
    }, 30_000);
  },
);
