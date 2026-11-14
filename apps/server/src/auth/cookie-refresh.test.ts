import { session } from '@torch/shared/db/schema';
import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';
import { createApp } from '../app.ts';
import { createAuthTestApp, testBrand } from '../test/auth-app.ts';
import { createWorkspaceFixture, withTempDatabase } from '../test/fixtures.ts';
import { refreshSessionCookie } from './cookie-refresh.ts';

const databaseUrl = process.env.DATABASE_URL;

// Integration: needs the dev compose Postgres (see db.test.ts). Skipped, loudly, when DATABASE_URL is not set.
if (!databaseUrl) {
  console.warn(
    '[auth/cookie-refresh.test] SKIPPED the cookie refresh integration tests: DATABASE_URL is not set. ' +
      'Start `docker compose -f docker-compose.dev.yml up -d --wait postgres` and set DATABASE_URL (see .env.example).',
  );
}

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const unique = () => crypto.randomUUID().slice(0, 8);

/**
 * A tiny app that does what every data route does (asks the resolver who is calling for one workspace), behind the
 * middleware under test, on the same injected clock as the sessions.
 */
function setup(t: ReturnType<typeof createAuthTestApp>, workspaceId: string) {
  const app = new Hono();
  app.use('*', refreshSessionCookie(t.auth, t.appUrl, t.now));
  app.get('/probe', async (c) => {
    const actor = await t.auth.resolveActor(c.req.raw, workspaceId);
    return actor ? c.json({ ok: true }) : c.json({ error: 'unauthenticated' }, 401);
  });
  return (cookie?: string) =>
    app.fetch(new Request(`${t.origin}/probe`, { headers: cookie ? { cookie } : {} }));
}

const maxAge = (header: string | undefined) => Number(/Max-Age=(\d+)/.exec(header ?? '')?.[1]);

describe.skipIf(!databaseUrl)('refreshSessionCookie', () => {
  it('61 minutes after the last touch: the same cookie value again, Max-Age = remaining seconds', async () => {
    await withTempDatabase(async (db) => {
      const email = `member-${unique()}@example.test`;
      const f = await createWorkspaceFixture(db.orm, { email: { member: email } });
      const t = createAuthTestApp(db);
      const probe = setup(t, f.workspaceId);
      const { cookie, cookieValue } = await t.signIn(email);

      t.clock.current = new Date(t.clock.current.getTime() + 61 * MINUTE);
      const res = await probe(cookie);

      expect(res.status).toBe(200);
      const headers = res.headers.getSetCookie();
      expect(headers).toHaveLength(1);
      const header = headers[0];
      expect(header).toContain(`sid=${cookieValue};`);
      expect(header).toContain('HttpOnly');
      expect(header).toContain('SameSite=Lax');
      expect(header).toContain('Path=/');
      expect(maxAge(header)).toBe(30 * 86_400);
    });
  });

  it('10 minutes after the last touch: no cookie, the row was not touched either', async () => {
    await withTempDatabase(async (db) => {
      const email = `member-${unique()}@example.test`;
      const f = await createWorkspaceFixture(db.orm, { email: { member: email } });
      const t = createAuthTestApp(db);
      const probe = setup(t, f.workspaceId);
      const { cookie } = await t.signIn(email);

      t.clock.current = new Date(t.clock.current.getTime() + 10 * MINUTE);
      const res = await probe(cookie);

      expect(res.status).toBe(200);
      expect(res.headers.getSetCookie()).toHaveLength(0);
    });
  });

  it('a second request right after the refresh gets none: one cookie per touch', async () => {
    await withTempDatabase(async (db) => {
      const email = `member-${unique()}@example.test`;
      const f = await createWorkspaceFixture(db.orm, { email: { member: email } });
      const t = createAuthTestApp(db);
      const probe = setup(t, f.workspaceId);
      const { cookie } = await t.signIn(email);
      t.clock.current = new Date(t.clock.current.getTime() + 2 * HOUR);

      expect((await probe(cookie)).headers.getSetCookie()).toHaveLength(1);
      expect((await probe(cookie)).headers.getSetCookie()).toHaveLength(0);
    });
  });

  it('never sends a new token: the cookie value equals the request value and the session hash is unchanged', async () => {
    await withTempDatabase(async (db) => {
      const email = `member-${unique()}@example.test`;
      const f = await createWorkspaceFixture(db.orm, { email: { member: email } });
      const t = createAuthTestApp(db);
      const probe = setup(t, f.workspaceId);
      const { cookie, cookieValue } = await t.signIn(email);
      const [before] = await db.orm.select().from(session);

      t.clock.current = new Date(t.clock.current.getTime() + 2 * HOUR);
      const res = await probe(cookie);

      const sent = /^sid=([^;]+);/.exec(res.headers.getSetCookie()[0] ?? '')?.[1];
      expect(sent).toBe(cookieValue);
      const rows = await db.orm.select().from(session);
      expect(rows).toHaveLength(1);
      expect(rows[0]?.tokenHash).toBe(before?.tokenHash);
    });
  });

  it('a request without a session (no cookie, garbage, unknown, revoked) gets no cookie', async () => {
    await withTempDatabase(async (db) => {
      const email = `member-${unique()}@example.test`;
      const f = await createWorkspaceFixture(db.orm, { email: { member: email } });
      const t = createAuthTestApp(db);
      const probe = setup(t, f.workspaceId);
      const { cookie } = await t.signIn(email);
      t.clock.current = new Date(t.clock.current.getTime() + 2 * HOUR);

      for (const sent of [undefined, 'sid=garbage', `sid=${'B'.repeat(42)}A`]) {
        const res = await probe(sent);
        expect(res.status, String(sent)).toBe(401);
        expect(res.headers.getSetCookie(), String(sent)).toHaveLength(0);
      }

      await db.orm.update(session).set({ revokedAt: new Date() });
      const revoked = await probe(cookie);
      expect(revoked.status).toBe(401);
      expect(revoked.headers.getSetCookie()).toHaveLength(0);
    });
  });

  it('a cookie that signs into two workspaces is re-sent once', async () => {
    await withTempDatabase(async (db) => {
      const email = `shared-${unique()}@example.test`;
      const a = await createWorkspaceFixture(db.orm, { email: { owner: email } });
      await createWorkspaceFixture(db.orm, { email: { admin: email } });
      const t = createAuthTestApp(db);
      const probe = setup(t, a.workspaceId);
      const { cookie } = await t.signIn(email);

      t.clock.current = new Date(t.clock.current.getTime() + 2 * HOUR);
      const res = await probe(cookie);

      expect(res.headers.getSetCookie()).toHaveLength(1);
    });
  });

  it('90-day ceiling: a session 89 days old is refreshed to at most one more day', async () => {
    await withTempDatabase(async (db) => {
      const email = `member-${unique()}@example.test`;
      const f = await createWorkspaceFixture(db.orm, { email: { member: email } });
      const t = createAuthTestApp(db);
      const probe = setup(t, f.workspaceId);
      const startedAt = t.clock.current.getTime();
      const { cookie } = await t.signIn(email);
      const maxAges: number[] = [];

      for (const day of [25, 50, 75, 89]) {
        t.clock.current = new Date(startedAt + day * DAY);
        const res = await probe(cookie);
        expect(res.status, `day ${day}`).toBe(200);
        maxAges.push(maxAge(res.headers.getSetCookie()[0]));
      }

      expect(maxAges).toEqual([30 * 86_400, 30 * 86_400, 15 * 86_400, 1 * 86_400]);
    });
  });

  it('through the real app: an authenticated data route refreshes the cookie, a 404 from it too', async () => {
    await withTempDatabase(async (db) => {
      const email = `member-${unique()}@example.test`;
      const f = await createWorkspaceFixture(db.orm, { email: { member: email } });
      const t = createAuthTestApp(db);
      const { cookie, cookieValue } = await t.signIn(email);
      t.clock.current = new Date(t.clock.current.getTime() + 2 * HOUR);

      const res = await t.request(
        'PATCH',
        `/api/w/${f.workspaceId}/issues/${crypto.randomUUID()}`,
        { title: 'x' },
        { cookie },
      );

      expect(res.status).toBe(404);
      const header = res.headers.getSetCookie()[0] ?? '';
      expect(header).toContain(`sid=${cookieValue};`);
      expect(maxAge(header)).toBe(30 * 86_400);
    });
  });

  it('through the real app: the shape proxy, which streams its body, refreshes too', async () => {
    await withTempDatabase(async (db) => {
      const email = `member-${unique()}@example.test`;
      const f = await createWorkspaceFixture(db.orm, { email: { member: email } });
      const t = createAuthTestApp(db);
      const { cookie, cookieValue } = await t.signIn(email);
      const app = createApp({
        brand: testBrand,
        db,
        config: { appUrl: t.appUrl, trustProxy: false },
        auth: t.auth,
        electric: { url: 'http://electric.test:3000', secret: 'test-secret' },
        fetchUpstream: async () =>
          new Response('[{"headers":{"control":"up-to-date"}}]', {
            status: 200,
            headers: { 'content-type': 'application/json', 'electric-handle': 'h-1' },
          }),
        now: t.now,
      });
      t.clock.current = new Date(t.clock.current.getTime() + 2 * HOUR);

      const res = await app.fetch(
        new Request(`${t.origin}/api/sync/w/${f.workspaceId}/teams?offset=-1`, {
          headers: { cookie },
        }),
      );

      expect(res.status).toBe(200);
      expect(await res.text()).toContain('up-to-date');
      const header = res.headers.getSetCookie()[0] ?? '';
      expect(header).toContain(`sid=${cookieValue};`);
      expect(maxAge(header)).toBe(30 * 86_400);
    });
  });

  it('through the real app: a request with a session of another workspace gets none', async () => {
    await withTempDatabase(async (db) => {
      const email = `member-${unique()}@example.test`;
      await createWorkspaceFixture(db.orm, { email: { member: email } });
      const other = await createWorkspaceFixture(db.orm);
      const t = createAuthTestApp(db);
      const { cookie } = await t.signIn(email);
      t.clock.current = new Date(t.clock.current.getTime() + 2 * HOUR);

      const res = await t.request(
        'PATCH',
        `/api/w/${other.workspaceId}/issues/${crypto.randomUUID()}`,
        { title: 'x' },
        { cookie },
      );

      expect(res.status).toBe(401);
      expect(res.headers.getSetCookie()).toHaveLength(0);
    });
  });
});
