// Workspace isolation over HTTP, for every authenticated endpoint of the API: the real app, real sessions, a real
// database. For each case of ENDPOINTS:
//   (a) an actor of workspace A calls A's URL with ids of workspace B: 404, never a hint that B's objects exist
//       (also with one id of B among ids of A, and with an answer that must equal the one for an id that exists
//       nowhere, for every role);
//   (b) a session of A on B's URL: 401;
//   (c) no cookie: 401;
//   (d) every role below the case's minimum is refused: 403, or 404 where the object is invisible to that role;
//   (e) the minimum role and every role above it succeed.
// A test also checks that every route the app registers under `/api/w` and `/api/sync/w` has a case, so a new route
// without one fails the suite. The exact status of every role and case is pinned by hand in
// `permissions/matrix.test.ts`.
import { beforeAll, describe, expect, it } from 'vitest';
import { listRoutes } from '../app.ts';
import {
  bodyOf,
  createRouteProbeApp,
  createWorld,
  ENDPOINTS,
  type EndpointCase,
  type Ids,
  idsUsedBy,
  PLACEHOLDER_IDS,
  patternOf,
  ROLES,
  succeeds,
  type World,
} from './endpoints.ts';
import { useSharedDatabase } from './shared-database.ts';

// The table lives in endpoints.ts so other test files can read it without running this file's tests again.
export { ENDPOINTS, type EndpointCase } from './endpoints.ts';

const databaseUrl = process.env.DATABASE_URL;

// Integration: needs the dev compose Postgres (see db.test.ts). Skipped, loudly, when DATABASE_URL is not set.
if (!databaseUrl) {
  console.warn(
    '[cross-workspace.test] SKIPPED the HTTP isolation tests: DATABASE_URL is not set. ' +
      'Start `docker compose -f docker-compose.dev.yml up -d --wait postgres` and set DATABASE_URL (see .env.example).',
  );
}

const UNKNOWN_UUID = '99999999-9999-4999-8999-999999999999';
const isSuccess = (status: number) => status >= 200 && status < 300;

// ---- every route has a case ----

describe('route coverage', () => {
  const AUTHENTICATED = ['/api/w/', '/api/sync/w/'];
  const registered = listRoutes(createRouteProbeApp())
    .filter((route) => AUTHENTICATED.some((prefix) => route.path.startsWith(prefix)))
    .map((route) => `${route.method} ${route.path}`);
  const covered = ENDPOINTS.map(patternOf);

  it('every route under /api/w and /api/sync/w has a case in ENDPOINTS', () => {
    const missing = registered.filter((pattern) => !covered.includes(pattern));
    expect(missing, 'routes without a case').toEqual([]);
  });

  it('every case is a route the app registers', () => {
    const stale = covered.filter((pattern) => !registered.includes(pattern));
    expect(stale, 'cases without a route').toEqual([]);
  });

  it('finds the routes it is meant to guard', () => {
    expect(registered).toContain('GET /api/w/:workspaceId/members');
    expect(registered).toContain('PATCH /api/w/:workspaceId/issues/:issueId');
    expect(registered).toContain('GET /api/sync/w/:workspaceId/teams/:teamId/issues');
  });

  it('case names are unique, and every case says who may do it', () => {
    const names = ENDPOINTS.map((c) => c.name);
    expect(new Set(names).size).toBe(names.length);
    for (const c of ENDPOINTS) {
      expect(['guest', 'member', 'admin', 'owner', 'none'], c.name).toContain(c.minRole);
      expect(c.path(PLACEHOLDER_IDS), c.name).toMatch(/^\/api\/(sync\/)?w\/:workspaceId\//);
    }
  });
});

describe('listRoutes', () => {
  const routes = listRoutes(createRouteProbeApp());

  it('lists a route once even when it carries its own middleware, and never a middleware entry', () => {
    const keys = routes.map((route) => `${route.method} ${route.path}`);
    expect(new Set(keys).size).toBe(keys.length);
    expect(routes.some((route) => route.method === 'ALL')).toBe(false);
    expect(keys.filter((key) => key === 'PATCH /api/w/:workspaceId/issues/:issueId')).toHaveLength(
      1,
    );
    expect(keys).toContain('GET /health');
  });

  it('refuses an object that createApp did not make', () => {
    expect(() => listRoutes({ fetch: async () => new Response() })).toThrow();
  });
});

// ---- the cases, over HTTP ----

/** Both ids of the same case, as two distinct sets: does the request change when its ids come from another workspace? */
const synthetic = (tag: string): Ids =>
  ({
    ...Object.fromEntries(Object.keys(PLACEHOLDER_IDS).map((key) => [key, `${tag}-${key}`])),
    workspaceId: 'workspace',
    uid: 'UID',
  }) as Ids;
const requestOf = (c: EndpointCase, ids: Ids) => JSON.stringify([c.path(ids), bodyOf(c, ids)]);
const takesOtherIds = (c: EndpointCase) =>
  requestOf(c, synthetic('own')) !== requestOf(c, synthetic('other'));

/** Endpoints whose request holds no id but the workspace's: there is nothing of workspace B to put in them. */
const WITHOUT_OTHER_IDS = [
  'members: list',
  'profile: edit own profile',
  'teams: create',
  'teams: private team directory',
  'invites: list',
  'invites: create (member role)',
  'invites: create (admin role)',
  'sync: teams',
  'sync: members',
];

describe.skipIf(!databaseUrl)('workspace isolation over HTTP', () => {
  const getDb = useSharedDatabase();
  let world: World;
  beforeAll(async () => {
    world = await createWorld(getDb());
  });

  describe('(a) ids of another workspace under the own URL', () => {
    const withOtherIds = ENDPOINTS.filter(takesOtherIds);

    it('the endpoints that cannot take an id of another workspace are exactly the listed ones', () => {
      const without = ENDPOINTS.filter((c) => !takesOtherIds(c)).map((c) => c.name);
      expect(without.sort()).toEqual([...WITHOUT_OTHER_IDS].sort());
    });

    for (const c of withOtherIds) {
      it(`${c.name}: 404 not_found`, async () => {
        const own = await world.attempt(world.a, 'owner', c);
        const other = await world.attempt(world.b, 'owner', c);

        const res = await world.send(
          c,
          { ...other.ids, workspaceId: own.ids.workspaceId },
          own.cookie,
        );

        expect(res).toEqual({ status: 404, error: 'not_found' });
      });
    }

    // A call that holds two ids (a team and a person): each one on its own, from workspace B, with the other from A.
    for (const c of withOtherIds) {
      const objects = [...idsUsedBy(c)].filter((key) => key !== 'workspaceId' && key !== 'uid');
      if (objects.length < 2) continue;
      for (const key of objects) {
        it(`${c.name}: only ${key} is of another workspace: 404 not_found`, async () => {
          const own = await world.attempt(world.a, 'owner', c);
          const other = await world.attempt(world.b, 'owner', c);

          const res = await world.send(c, { ...own.ids, [key]: other.ids[key] }, own.cookie);

          expect(res).toEqual({ status: 404, error: 'not_found' });
        });
      }
    }

    // The answer for an id of workspace B must be the one for an id that exists nowhere: any difference tells the
    // caller that the object exists, whatever the role.
    for (const c of withOtherIds) {
      for (const role of ROLES) {
        it(`${c.name} as ${role}: an id of another workspace answers like an id that does not exist`, async () => {
          const own = await world.attempt(world.a, role, c);
          const other = await world.attempt(world.b, 'owner', c);
          const nowhere = Object.fromEntries(
            [...idsUsedBy(c)].map((key) => [key, UNKNOWN_UUID]),
          ) as Partial<Ids>;

          const ofOther = await world.send(
            c,
            { ...other.ids, workspaceId: own.ids.workspaceId },
            own.cookie,
          );
          const ofNowhere = await world.send(
            c,
            { ...own.ids, ...nowhere, workspaceId: own.ids.workspaceId, uid: own.ids.uid },
            own.cookie,
          );

          expect([403, 404], `status ${ofOther.status}`).toContain(ofOther.status);
          expect(ofOther).toEqual(ofNowhere);
        });
      }
    }

    for (const c of withOtherIds) {
      it(`${c.name}: a malformed id is 400 or 404, never a server error`, async () => {
        const own = await world.attempt(world.a, 'owner');
        const malformed = Object.fromEntries(
          [...idsUsedBy(c)].map((key) => [key, 'not-a-uuid']),
        ) as Partial<Ids>;

        const res = await world.send(
          c,
          { ...own.ids, ...malformed, workspaceId: own.ids.workspaceId },
          own.cookie,
        );

        expect([400, 404], `status ${res.status}`).toContain(res.status);
      });
    }
  });

  describe('(b) a session of one workspace on the URL of another', () => {
    for (const c of ENDPOINTS) {
      it(`${c.name}: 401 unauthenticated`, async () => {
        const mine = await world.attempt(world.a, 'owner');
        const theirs = await world.attempt(world.b, 'owner', c);

        const res = await world.send(c, theirs.ids, mine.cookie);

        expect(res).toEqual({ status: 401, error: 'unauthenticated' });
      });
    }
  });

  describe('(c) no cookie', () => {
    for (const c of ENDPOINTS) {
      it(`${c.name}: 401 unauthenticated`, async () => {
        const own = await world.attempt(world.a, 'owner', c);

        const res = await world.send(c, own.ids);

        expect(res).toEqual({ status: 401, error: 'unauthenticated' });
      });
    }
  });

  describe('(d) and (e) each role on its own workspace', () => {
    for (const c of ENDPOINTS) {
      for (const role of ROLES) {
        const allowed = succeeds(c, role);
        it(`${c.name} as ${role}: ${allowed ? 'succeeds' : 'is refused'}`, async () => {
          const own = await world.attempt(world.a, role, c);

          const res = await world.send(c, own.ids, own.cookie);

          if (allowed) {
            expect(isSuccess(res.status), `status ${res.status} ${res.error ?? ''}`).toBe(true);
            return;
          }
          // 403 where the actor sees the object, 404 where it is invisible to them; never anything else.
          expect([403, 404], `status ${res.status}`).toContain(res.status);
          expect(res.error).toBe(res.status === 403 ? 'forbidden' : 'not_found');
        });
      }
    }
  });
});
