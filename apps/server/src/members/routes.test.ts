import { member } from '@torch/shared/db/schema';
import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import type { Db } from '../db.ts';
import { openSession } from '../test/admin-helpers.ts';
import { createAuthTestApp } from '../test/auth-app.ts';
import {
  createWorkspaceFixture,
  type WorkspaceFixture,
  withTempDatabase,
} from '../test/fixtures.ts';

const databaseUrl = process.env.DATABASE_URL;

// Integration: needs the dev compose Postgres (see db.test.ts). Skipped, loudly, when DATABASE_URL is not set.
if (!databaseUrl) {
  console.warn(
    '[members/routes.test] SKIPPED the member route tests: DATABASE_URL is not set. ' +
      'Start `docker compose -f docker-compose.dev.yml up -d --wait postgres` and set DATABASE_URL (see .env.example).',
  );
}

const UNKNOWN_UUID = '99999999-9999-4999-8999-999999999999';

type Who = keyof WorkspaceFixture['members'];

/** The five routes with a valid body each, for a workspace and one target member. */
const routesOf = (workspaceId: string, targetId: string) =>
  [
    ['GET', `/api/w/${workspaceId}/members`, undefined],
    ['PATCH', `/api/w/${workspaceId}/members/${targetId}`, { role: 'guest' }],
    ['POST', `/api/w/${workspaceId}/members/${targetId}/deactivate`, undefined],
    ['POST', `/api/w/${workspaceId}/members/${targetId}/reactivate`, undefined],
    ['PATCH', `/api/w/${workspaceId}/me`, { name: 'New Name' }],
  ] as const;

async function setup(db: Db) {
  const f = await createWorkspaceFixture(db.orm);
  const t = createAuthTestApp(db);
  const as = async (who: Who) =>
    (await openSession(db.orm, f.workspaceId, f.members[who].id)).cookie;
  return { f, t, as };
}

const row = async (db: Db, id: string) => {
  const [found] = await db.orm.select().from(member).where(eq(member.id, id));
  if (!found) throw new Error('member vanished');
  return found;
};

describe.skipIf(!databaseUrl)('member routes', () => {
  it('every route answers 401 without a cookie, with a garbage cookie, and with a cookie of another workspace', async () => {
    await withTempDatabase(async (db) => {
      const { f, t } = await setup(db);
      const other = await createWorkspaceFixture(db.orm);
      const foreign = await openSession(db.orm, other.workspaceId, other.members.owner.id);
      const target = f.members.member.id;

      for (const [method, path, body] of routesOf(f.workspaceId, target)) {
        for (const [label, cookie] of [
          ['no cookie', undefined],
          ['garbage cookie', 'sid=not-a-token'],
          ['cookie of another workspace', foreign.cookie],
        ] as const) {
          const res = await t.request(method, path, body, { cookie });
          expect(res.status, `${method} ${path} ${label}`).toBe(401);
          expect(await res.json()).toMatchObject({ error: 'unauthenticated' });
        }
      }
      expect((await row(db, target)).role).toBe('member');
      expect((await row(db, target)).deactivatedAt).toBeNull();
    });
  });

  it('every answer of the member routes is no-store: the list carries emails, nothing here may be cached', async () => {
    await withTempDatabase(async (db) => {
      const { f, t, as } = await setup(db);
      const owner = await as('owner');
      const member = await as('member');

      for (const [method, path, body] of routesOf(f.workspaceId, f.members.guest.id)) {
        for (const [label, cookie] of [
          ['owner', owner],
          ['member', member],
          ['no cookie', undefined],
        ] as const) {
          const res = await t.request(method, path, body, { cookie });
          expect(res.headers.get('cache-control'), `${method} ${path} ${label} ${res.status}`).toBe(
            'no-store',
          );
        }
      }
    });
  });

  it('a workspace id that is not a uuid is 404', async () => {
    await withTempDatabase(async (db) => {
      const { t, as } = await setup(db);
      const res = await t.get('/api/w/not-a-uuid/members', { cookie: await as('owner') });
      expect(res.status).toBe(404);
      expect(await res.json()).toMatchObject({ error: 'not_found' });
    });
  });

  it('GET /members: owner and admin get the list with emails; member and guest get 403 forbidden', async () => {
    await withTempDatabase(async (db) => {
      const { f, t, as } = await setup(db);

      for (const who of ['owner', 'admin'] as const) {
        const res = await t.get(`/api/w/${f.workspaceId}/members`, { cookie: await as(who) });
        expect(res.status, who).toBe(200);
        const { members } = (await res.json()) as { members: { id: string; email: string }[] };
        expect(members).toHaveLength(5);
        expect(members.find((m) => m.id === f.members.member.id)?.email).toBe(
          f.members.member.email,
        );
      }
      for (const who of ['member', 'guest'] as const) {
        const res = await t.get(`/api/w/${f.workspaceId}/members`, { cookie: await as(who) });
        expect(res.status, who).toBe(403);
        expect(await res.json()).toEqual({ error: 'forbidden', message: expect.any(String) });
      }
    });
  });

  it('PATCH /members/:id: success returns a txid; refusals carry error and message', async () => {
    await withTempDatabase(async (db) => {
      const { f, t, as } = await setup(db);
      const url = (id: string) => `/api/w/${f.workspaceId}/members/${id}`;

      const done = await t.request(
        'PATCH',
        url(f.members.member.id),
        { role: 'admin' },
        {
          cookie: await as('owner'),
        },
      );
      expect(done.status).toBe(200);
      const { txid } = (await done.json()) as { txid: number };
      expect(Number.isInteger(txid) && txid > 0).toBe(true);
      expect((await row(db, f.members.member.id)).role).toBe('admin');

      const cases: [string, string, unknown, Who, number, string][] = [
        [
          'admin grants admin',
          url(f.members.guest.id),
          { role: 'admin' },
          'admin',
          403,
          'forbidden',
        ],
        ['own role', url(f.members.admin.id), { role: 'guest' }, 'admin', 403, 'forbidden'],
        ['plain member', url(f.members.guest.id), { role: 'member' }, 'outsider', 403, 'forbidden'],
        ['unknown id', url(UNKNOWN_UUID), { role: 'guest' }, 'owner', 404, 'not_found'],
        ['malformed id', url('not-a-uuid'), { role: 'guest' }, 'owner', 404, 'not_found'],
        ['unknown role', url(f.members.guest.id), { role: 'root' }, 'owner', 400, 'invalid_input'],
        [
          'extra key',
          url(f.members.guest.id),
          { role: 'member', x: 1 },
          'owner',
          400,
          'invalid_input',
        ],
        ['empty body', url(f.members.guest.id), {}, 'owner', 400, 'invalid_input'],
        ['not json', url(f.members.guest.id), '{nope', 'owner', 400, 'invalid_input'],
      ];
      for (const [label, path, body, who, status, code] of cases) {
        const res = await t.request('PATCH', path, body, { cookie: await as(who) });
        expect(res.status, label).toBe(status);
        expect(await res.json(), label).toEqual({ error: code, message: expect.any(String) });
      }
      expect((await row(db, f.members.guest.id)).role).toBe('guest');
    });
  });

  it('an id of another workspace in a valid URL is 404 on every id route', async () => {
    await withTempDatabase(async (db) => {
      const { f, t, as } = await setup(db);
      const other = await createWorkspaceFixture(db.orm);
      const cookie = await as('owner');
      const foreign = other.members.member.id;

      for (const [method, path, body] of routesOf(f.workspaceId, foreign).slice(1, 4)) {
        const res = await t.request(method, path, body, { cookie });
        expect(res.status, `${method} ${path}`).toBe(404);
        expect(await res.json()).toMatchObject({ error: 'not_found' });
      }
      expect((await row(db, foreign)).role).toBe('member');
      expect((await row(db, foreign)).deactivatedAt).toBeNull();
    });
  });

  it('deactivate revokes the sessions: the next request of the deactivated member is 401; reactivation needs a new sign-in', async () => {
    await withTempDatabase(async (db) => {
      const { f, t, as } = await setup(db);
      const signedIn = await t.signIn(f.members.member.email);
      const own = (cookie: string) =>
        t.request('PATCH', `/api/w/${f.workspaceId}/me`, { name: 'Still Here' }, { cookie });
      expect((await own(signedIn.cookie)).status).toBe(200);
      const ownerCookie = await as('owner');
      const target = `/api/w/${f.workspaceId}/members/${f.members.member.id}`;

      const deactivated = await t.request('POST', `${target}/deactivate`, undefined, {
        cookie: ownerCookie,
      });
      expect(deactivated.status).toBe(200);
      expect(await deactivated.json()).toEqual({ txid: expect.any(Number) });
      expect((await own(signedIn.cookie)).status).toBe(401);

      const reactivated = await t.request('POST', `${target}/reactivate`, undefined, {
        cookie: ownerCookie,
      });
      expect(reactivated.status).toBe(200);
      expect((await own(signedIn.cookie)).status).toBe(401);
      const again = await t.signIn(f.members.member.email, { ip: '10.0.0.2' });
      expect((await own(again.cookie)).status).toBe(200);
    });
  });

  it('deactivate: admin cannot deactivate an owner (403), nobody deactivates themselves (403)', async () => {
    await withTempDatabase(async (db) => {
      const { f, t, as } = await setup(db);
      const post = (id: string, who: Who) =>
        as(who).then((cookie) =>
          t.request('POST', `/api/w/${f.workspaceId}/members/${id}/deactivate`, undefined, {
            cookie,
          }),
        );

      expect((await post(f.members.owner.id, 'admin')).status).toBe(403);
      expect((await post(f.members.owner.id, 'owner')).status).toBe(403);
      expect((await post(f.members.guest.id, 'member')).status).toBe(403);
      expect((await row(db, f.members.owner.id)).deactivatedAt).toBeNull();
    });
  });

  it('PATCH /me: edits the profile and returns a txid; a handle clash is 409 handle_taken', async () => {
    await withTempDatabase(async (db) => {
      const { f, t, as } = await setup(db);
      const cookie = await as('member');
      const me = `/api/w/${f.workspaceId}/me`;

      const done = await t.request('PATCH', me, { name: 'Ada Lovelace', locale: 'it' }, { cookie });
      expect(done.status).toBe(200);
      expect(await done.json()).toEqual({ txid: expect.any(Number) });
      expect(await row(db, f.members.member.id)).toMatchObject({
        name: 'Ada Lovelace',
        locale: 'it',
      });

      const clash = await t.request('PATCH', me, { handle: 'admin' }, { cookie });
      expect(clash.status).toBe(409);
      expect(await clash.json()).toEqual({ error: 'handle_taken', message: expect.any(String) });
    });
  });

  it('PATCH /me refuses an empty body and any field that is not a profile field, so a role cannot be self-granted', async () => {
    await withTempDatabase(async (db) => {
      const { f, t, as } = await setup(db);
      const cookie = await as('member');

      for (const body of [{}, { role: 'owner' }, { email: 'x@example.test' }, { name: '' }]) {
        const res = await t.request('PATCH', `/api/w/${f.workspaceId}/me`, body, { cookie });
        expect(res.status, JSON.stringify(body)).toBe(400);
        expect(await res.json()).toMatchObject({ error: 'invalid_input' });
      }
      expect(await row(db, f.members.member.id)).toMatchObject({
        role: 'member',
        email: f.members.member.email,
      });
    });
  });

  it('a 20 KB body is 413 before any service runs', async () => {
    await withTempDatabase(async (db) => {
      const { f, t, as } = await setup(db);
      const body = JSON.stringify({ name: 'x'.repeat(20 * 1024) });

      const res = await t.request('PATCH', `/api/w/${f.workspaceId}/me`, body, {
        cookie: await as('member'),
      });

      expect(res.status).toBe(413);
      expect(await res.json()).toMatchObject({ error: 'invalid_input' });
    });
  });

  it('writes without the app Origin are refused by the CSRF guard', async () => {
    await withTempDatabase(async (db) => {
      const { f, t, as } = await setup(db);
      const cookie = await as('owner');

      for (const origin of [null, 'http://evil.example.test']) {
        const res = await t.request(
          'POST',
          `/api/w/${f.workspaceId}/members/${f.members.guest.id}/deactivate`,
          undefined,
          { cookie, origin },
        );
        expect(res.status, String(origin)).toBe(403);
      }
      expect((await row(db, f.members.guest.id)).deactivatedAt).toBeNull();
    });
  });
});
