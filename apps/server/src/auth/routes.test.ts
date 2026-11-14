import { createHash } from 'node:crypto';
import { loginToken, member, session } from '@torch/shared/db/schema';
import { eq } from 'drizzle-orm';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Db } from '../db.ts';
import { createAuthTestApp } from '../test/auth-app.ts';
import { createWorkspaceFixture, withTempDatabase } from '../test/fixtures.ts';
import { generateToken } from './tokens.ts';

const databaseUrl = process.env.DATABASE_URL;

// Integration: needs the dev compose Postgres (see db.test.ts). Skipped, loudly, when DATABASE_URL is not set.
if (!databaseUrl) {
  console.warn(
    '[auth/routes.test] SKIPPED the sign-in integration tests: DATABASE_URL is not set. ' +
      'Start `docker compose -f docker-compose.dev.yml up -d --wait postgres` and set DATABASE_URL (see .env.example).',
  );
}

const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;
const sha256 = (value: string) => createHash('sha256').update(value).digest('hex');
const unique = () => crypto.randomUUID().slice(0, 8);
const requestWith = (cookie: string) =>
  new Request('http://app.example.test/api/x', { headers: { cookie } });

afterEach(() => vi.restoreAllMocks());

describe.skipIf(!databaseUrl)('POST /api/auth/magic-link', () => {
  it('unknown email: 202 and no mail', async () => {
    await withTempDatabase(async (db) => {
      const t = createAuthTestApp(db);

      const res = await t.post('/api/auth/magic-link', {
        email: `nobody-${unique()}@example.test`,
      });
      await t.flush();

      expect(res.status).toBe(202);
      expect(await res.json()).toEqual({ status: 'sent' });
      expect(t.mailer.sent).toHaveLength(0);
      expect(await db.orm.select().from(loginToken)).toHaveLength(0);
    });
  });

  it('known email with capitals and spaces: one mail whose link points to APP_URL/auth/verify', async () => {
    await withTempDatabase(async (db) => {
      const email = `owner-${unique()}@example.test`;
      await createWorkspaceFixture(db.orm, { email: { owner: email } });
      const t = createAuthTestApp(db);

      const res = await t.post('/api/auth/magic-link', { email: `  ${email.toUpperCase()} ` });
      await t.waitForMail(1);
      await t.flush();

      expect(res.status).toBe(202);
      expect(t.mailer.sent).toHaveLength(1);
      const mail = t.mailer.sent[0];
      expect(mail?.to).toBe(email);
      expect(mail?.text).toContain(`${t.appUrl}/auth/verify#token=`);
      expect(mail?.html).toContain(`${t.appUrl}/auth/verify#token=`);
      expect(mail?.subject).toBe('Sign in to Acme Tasks');
    });
  });

  it('the sign-in mail carries the token in the URL fragment and in no query string', async () => {
    await withTempDatabase(async (db) => {
      const email = `owner-${unique()}@example.test`;
      await createWorkspaceFixture(db.orm, { email: { owner: email } });
      const t = createAuthTestApp(db);

      await t.post('/api/auth/magic-link', { email });
      await t.waitForMail(1);

      const mail = t.mailer.sent[0];
      for (const part of [mail?.text ?? '', mail?.html ?? '']) {
        expect(part).toContain('#token=');
        expect(part).not.toContain('?token');
        expect(part).not.toMatch(/[?&]token=/);
      }
      // The whole link is `APP_URL/auth/verify#token=<43 characters>`: nothing after the token reaches a server.
      const link = /https?:\/\/[^\s"<]+/.exec(mail?.text ?? '')?.[0] ?? '';
      const parsed = new URL(link);
      expect(parsed.pathname).toBe('/auth/verify');
      expect(parsed.search).toBe('');
      expect(parsed.hash).toBe(`#token=${t.tokenOf(0)}`);
    });
  });

  it('answers with the language of the member, whatever the request says', async () => {
    await withTempDatabase(async (db) => {
      const email = `owner-${unique()}@example.test`;
      const f = await createWorkspaceFixture(db.orm, { email: { owner: email } });
      await db.orm.update(member).set({ locale: 'it' }).where(eq(member.id, f.members.owner.id));
      const t = createAuthTestApp(db);

      await t.post('/api/auth/magic-link', { email, locale: 'en' });
      await t.waitForMail(1);

      expect(t.mailer.sent[0]?.subject).toBe('Accedi a Acme Tasks');
    });
  });

  it('a deactivated member gets no mail, like an unknown email', async () => {
    await withTempDatabase(async (db) => {
      const email = `owner-${unique()}@example.test`;
      const f = await createWorkspaceFixture(db.orm, { email: { owner: email } });
      await db.orm
        .update(member)
        .set({ deactivatedAt: new Date() })
        .where(eq(member.id, f.members.owner.id));
      const t = createAuthTestApp(db);

      const res = await t.post('/api/auth/magic-link', { email });
      await t.flush();

      expect(res.status).toBe(202);
      expect(t.mailer.sent).toHaveLength(0);
    });
  });

  it('malformed email, empty body or non-JSON → 400 invalid_email', async () => {
    await withTempDatabase(async (db) => {
      const t = createAuthTestApp(db);
      const bodies: unknown[] = [
        { email: 'not-an-email' },
        { email: 'a b@example.test' },
        { email: '' },
        { email: 42 },
        {},
        'not json{',
        { email: `${'a'.repeat(260)}@example.test` },
      ];

      for (const body of bodies) {
        const res = await t.post('/api/auth/magic-link', body);

        expect(res.status, JSON.stringify(body)).toBe(400);
        expect(await res.json()).toMatchObject({ error: 'invalid_email' });
      }
    });
  });

  it('a failing mailer still answers 202 and logs without the link', async () => {
    await withTempDatabase(async (db) => {
      const email = `owner-${unique()}@example.test`;
      await createWorkspaceFixture(db.orm, { email: { owner: email } });
      const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
      const t = createAuthTestApp(db, { mailerFails: true });

      const res = await t.post('/api/auth/magic-link', { email });
      await vi.waitFor(() => expect(errors).toHaveBeenCalled());

      expect(res.status).toBe(202);
      const logged = errors.mock.calls.flat().join(' ');
      expect(logged).toContain('smtp down');
      expect(logged).not.toContain('/auth/verify');
      expect(logged).not.toContain('token=');
    });
  });

  it('sixth request for one email within 15 minutes sends no mail and answers 202', async () => {
    await withTempDatabase(async (db) => {
      const email = `owner-${unique()}@example.test`;
      await createWorkspaceFixture(db.orm, { email: { owner: email } });
      const t = createAuthTestApp(db);

      for (let i = 1; i <= 5; i++) {
        expect((await t.post('/api/auth/magic-link', { email })).status).toBe(202);
        await t.waitForMail(i);
      }
      const sixth = await t.post('/api/auth/magic-link', { email });
      await t.flush();

      expect(sixth.status).toBe(202);
      expect(await sixth.json()).toEqual({ status: 'sent' });
      expect(t.mailer.sent).toHaveLength(5);

      t.clock.current = new Date(t.clock.current.getTime() + 15 * MINUTE + 1000);
      expect((await t.post('/api/auth/magic-link', { email })).status).toBe(202);
      await t.waitForMail(6);
    });
  });

  it('21st request from one IP answers 429 with Retry-After; another IP is unaffected', async () => {
    await withTempDatabase(async (db) => {
      const t = createAuthTestApp(db);
      const ask = (ip: string) =>
        t.post('/api/auth/magic-link', { email: `x-${unique()}@example.test` }, { ip });

      for (let i = 1; i <= 20; i++) expect((await ask('203.0.113.7')).status).toBe(202);
      const blocked = await ask('203.0.113.7');

      expect(blocked.status).toBe(429);
      const retryAfter = Number(blocked.headers.get('retry-after'));
      expect(Number.isInteger(retryAfter)).toBe(true);
      expect(retryAfter).toBeGreaterThan(0);
      expect(retryAfter).toBeLessThanOrEqual(900);
      expect((await ask('203.0.113.8')).status).toBe(202);
    });
  });

  it('an IPv6 client rotating addresses inside its /64 shares one limit; another /64 is unaffected', async () => {
    await withTempDatabase(async (db) => {
      const t = createAuthTestApp(db);
      const ask = (ip: string) =>
        t.post('/api/auth/magic-link', { email: `x-${unique()}@example.test` }, { ip });

      for (let i = 1; i <= 20; i++) {
        expect((await ask(`2001:db8:1:2:${i}:aaaa:bbbb:cccc`)).status).toBe(202);
      }
      const blocked = await ask('2001:db8:1:2:ffff::1');

      expect(blocked.status).toBe(429);
      expect((await ask('2001:db8:1:3::1')).status).toBe(202);
    });
  });

  it('an IPv4-mapped IPv6 socket address counts as its IPv4 address', async () => {
    await withTempDatabase(async (db) => {
      const t = createAuthTestApp(db);
      const ask = (ip: string) =>
        t.post('/api/auth/magic-link', { email: `x-${unique()}@example.test` }, { ip });

      for (let i = 1; i <= 10; i++) expect((await ask('203.0.113.50')).status).toBe(202);
      for (let i = 1; i <= 10; i++) expect((await ask('::ffff:203.0.113.50')).status).toBe(202);

      expect((await ask('203.0.113.50')).status).toBe(429);
    });
  });

  it('the preview and verify limit also keys IPv6 by /64', async () => {
    await withTempDatabase(async (db) => {
      const t = createAuthTestApp(db);
      const ask = (ip: string) => t.post('/api/auth/preview', { token: generateToken() }, { ip });

      for (let i = 1; i <= 60; i++) expect((await ask(`2001:db8:9:9:${i}::1`)).status).toBe(400);

      expect((await ask('2001:db8:9:9:ffff::1')).status).toBe(429);
      expect((await ask('2001:db8:9:a::1')).status).toBe(400);
    });
  });

  it('x-forwarded-for is ignored unless TRUST_PROXY: spoofed values do not escape the IP limit', async () => {
    await withTempDatabase(async (db) => {
      const t = createAuthTestApp(db, { trustProxy: false });
      const ask = (xff: string) =>
        t.post(
          '/api/auth/magic-link',
          { email: `x-${unique()}@example.test` },
          { ip: '203.0.113.7', headers: { 'x-forwarded-for': xff } },
        );

      for (let i = 1; i <= 20; i++) expect((await ask(`198.51.100.${i}`)).status).toBe(202);

      expect((await ask('198.51.100.99')).status).toBe(429);
    });
  });

  it('behind a trusted proxy the limit follows the last x-forwarded-for entry', async () => {
    await withTempDatabase(async (db) => {
      const t = createAuthTestApp(db, { trustProxy: true });
      const ask = (xff: string) =>
        t.post(
          '/api/auth/magic-link',
          { email: `x-${unique()}@example.test` },
          { ip: '10.0.0.2', headers: { 'x-forwarded-for': xff } },
        );

      for (let i = 1; i <= 20; i++) expect((await ask(`6.6.6.${i}, 9.9.9.9`)).status).toBe(202);

      expect((await ask('6.6.6.99, 9.9.9.9')).status).toBe(429);
      expect((await ask('6.6.6.99, 9.9.9.10')).status).toBe(202);
    });
  });
});

describe.skipIf(!databaseUrl)('POST /api/auth/verify', () => {
  it('one link signs into every workspace where the email is an active member, with one cookie', async () => {
    await withTempDatabase(async (db) => {
      const email = `shared-${unique()}@example.test`;
      const a = await createWorkspaceFixture(db.orm, { email: { owner: email } });
      const b = await createWorkspaceFixture(db.orm, { email: { admin: email } });
      const t = createAuthTestApp(db);

      const { verified, cookie } = await t.signIn(email);

      expect(t.mailer.sent).toHaveLength(1);
      expect(verified.status).toBe(200);
      expect(verified.headers.getSetCookie()).toHaveLength(1);
      const body = (await verified.json()) as {
        workspaces: { id: string; name: string; slug: string; memberId: string; role: string }[];
      };
      expect(body.workspaces.map((w) => w.id).sort()).toEqual(
        [a.workspaceId, b.workspaceId].sort(),
      );
      const inB = body.workspaces.find((w) => w.id === b.workspaceId);
      expect(inB).toMatchObject({ memberId: b.members.admin.id, role: 'admin' });
      expect(inB?.slug).toMatch(/^ws-/);
      expect(inB?.name).toMatch(/^Workspace /);

      const sessions = await db.orm.select().from(session);
      expect(sessions).toHaveLength(2);
      expect(new Set(sessions.map((s) => s.tokenHash)).size).toBe(1);

      const current = await t.get('/api/auth/session', { cookie });
      expect(current.status).toBe(200);
      expect(await current.json()).toEqual(body);
    });
  });

  it('member deactivated after the request gets no session in that workspace', async () => {
    await withTempDatabase(async (db) => {
      const email = `shared-${unique()}@example.test`;
      const a = await createWorkspaceFixture(db.orm, { email: { owner: email } });
      const b = await createWorkspaceFixture(db.orm, { email: { owner: email } });
      const t = createAuthTestApp(db);
      await t.post('/api/auth/magic-link', { email });
      await t.waitForMail(1);
      await db.orm
        .update(member)
        .set({ deactivatedAt: new Date() })
        .where(eq(member.id, b.members.owner.id));

      const res = await t.post('/api/auth/verify', { token: t.tokenOf(0) });

      expect(res.status).toBe(200);
      const body = (await res.json()) as { workspaces: { id: string }[] };
      expect(body.workspaces.map((w) => w.id)).toEqual([a.workspaceId]);
      const sessions = await db.orm.select().from(session);
      expect(sessions.map((s) => s.workspaceId)).toEqual([a.workspaceId]);
    });
  });

  it('all members deactivated → 400 invalid_or_expired and no cookie', async () => {
    await withTempDatabase(async (db) => {
      const email = `owner-${unique()}@example.test`;
      const f = await createWorkspaceFixture(db.orm, { email: { owner: email } });
      const t = createAuthTestApp(db);
      await t.post('/api/auth/magic-link', { email });
      await t.waitForMail(1);
      await db.orm
        .update(member)
        .set({ deactivatedAt: new Date() })
        .where(eq(member.id, f.members.owner.id));

      const res = await t.post('/api/auth/verify', { token: t.tokenOf(0) });

      expect(res.status).toBe(400);
      expect(await res.json()).toMatchObject({ error: 'invalid_or_expired' });
      expect(res.headers.getSetCookie()).toHaveLength(0);
      expect(await db.orm.select().from(session)).toHaveLength(0);
    });
  });

  it('token is single use', async () => {
    await withTempDatabase(async (db) => {
      const email = `owner-${unique()}@example.test`;
      await createWorkspaceFixture(db.orm, { email: { owner: email } });
      const t = createAuthTestApp(db);
      await t.post('/api/auth/magic-link', { email });
      await t.waitForMail(1);
      const token = t.tokenOf(0);

      const first = await t.post('/api/auth/verify', { token });
      const second = await t.post('/api/auth/verify', { token });

      expect(first.status).toBe(200);
      expect(second.status).toBe(400);
      expect(await second.json()).toMatchObject({ error: 'invalid_or_expired' });
      expect(second.headers.getSetCookie()).toHaveLength(0);
    });
  });

  it('two concurrent verifies of one token: exactly one 200', async () => {
    await withTempDatabase(async (db) => {
      const email = `owner-${unique()}@example.test`;
      await createWorkspaceFixture(db.orm, { email: { owner: email } });
      const t = createAuthTestApp(db);
      await t.post('/api/auth/magic-link', { email });
      await t.waitForMail(1);
      const token = t.tokenOf(0);

      const results = await Promise.all(
        [1, 2, 3, 4].map(() => t.post('/api/auth/verify', { token })),
      );

      expect(results.map((r) => r.status).sort()).toEqual([200, 400, 400, 400]);
      expect(await db.orm.select().from(session)).toHaveLength(1);
    });
  });

  it('expired token → 400 invalid_or_expired, a token 14 minutes old still works', async () => {
    await withTempDatabase(async (db) => {
      const email = `owner-${unique()}@example.test`;
      await createWorkspaceFixture(db.orm, { email: { owner: email } });
      const t = createAuthTestApp(db);
      await t.post('/api/auth/magic-link', { email });
      await t.post('/api/auth/magic-link', { email });
      await t.waitForMail(2);

      t.clock.current = new Date(t.clock.current.getTime() + 14 * MINUTE);
      const fresh = await t.post('/api/auth/verify', { token: t.tokenOf(1) });
      t.clock.current = new Date(t.clock.current.getTime() + 2 * MINUTE);
      const stale = await t.post('/api/auth/verify', { token: t.tokenOf(0) });

      expect(fresh.status).toBe(200);
      expect(stale.status).toBe(400);
      expect(await stale.json()).toMatchObject({ error: 'invalid_or_expired' });
    });
  });

  it('missing, malformed or unknown token → 400 invalid_or_expired', async () => {
    await withTempDatabase(async (db) => {
      const t = createAuthTestApp(db);

      for (const body of [
        {},
        { token: 5 },
        { token: 'short' },
        { token: 'A'.repeat(43) },
        'nope{',
      ]) {
        const res = await t.post('/api/auth/verify', body);

        expect(res.status, JSON.stringify(body)).toBe(400);
        expect(await res.json()).toMatchObject({ error: 'invalid_or_expired' });
      }
    });
  });

  it('GET on /api/auth/verify does not consume the token', async () => {
    await withTempDatabase(async (db) => {
      const email = `owner-${unique()}@example.test`;
      await createWorkspaceFixture(db.orm, { email: { owner: email } });
      const t = createAuthTestApp(db);
      await t.post('/api/auth/magic-link', { email });
      await t.waitForMail(1);
      const token = t.tokenOf(0);

      const scanner = await t.get(`/api/auth/verify?token=${token}`);
      const scannerPage = await t.get(`/auth/verify?token=${token}`);
      const rows = await db.orm.select().from(loginToken);
      const real = await t.post('/api/auth/verify', { token });

      expect([404, 405]).toContain(scanner.status);
      expect(scannerPage.status).not.toBe(200);
      expect(rows.every((r) => r.usedAt === null)).toBe(true);
      expect(real.status).toBe(200);
    });
  });

  it('stored hashes are 64 hex chars and never equal the raw token or cookie', async () => {
    await withTempDatabase(async (db) => {
      const email = `owner-${unique()}@example.test`;
      await createWorkspaceFixture(db.orm, { email: { owner: email } });
      const t = createAuthTestApp(db);

      const { token, cookieValue } = await t.signIn(email);

      const [login] = await db.orm.select().from(loginToken);
      const [sess] = await db.orm.select().from(session);
      for (const hash of [login?.tokenHash, sess?.tokenHash])
        expect(hash).toMatch(/^[0-9a-f]{64}$/);
      expect(login?.tokenHash).toBe(sha256(token));
      expect(sess?.tokenHash).toBe(sha256(cookieValue));
      expect(login?.tokenHash).not.toBe(token);
      expect(sess?.tokenHash).not.toBe(cookieValue);
      expect(cookieValue).not.toBe(token);
      expect(login?.usedAt).not.toBeNull();
    });
  });

  it('cookie flags for an http APP_URL', async () => {
    await withTempDatabase(async (db) => {
      const email = `owner-${unique()}@example.test`;
      await createWorkspaceFixture(db.orm, { email: { owner: email } });
      const t = createAuthTestApp(db, { appUrl: 'http://app.example.test' });

      const { verified } = await t.signIn(email);

      const header = verified.headers.getSetCookie()[0] ?? '';
      expect(header).toMatch(/^sid=[A-Za-z0-9_-]{43};/);
      expect(header).toContain('HttpOnly');
      expect(header).toContain('SameSite=Lax');
      expect(header).toContain('Path=/');
      expect(header).toContain(`Max-Age=${30 * 24 * 60 * 60}`);
      expect(header).not.toContain('Secure');
      expect(header).not.toContain('Domain');
    });
  });

  it('cookie flags for an https APP_URL: __Host- prefix and Secure', async () => {
    await withTempDatabase(async (db) => {
      const email = `owner-${unique()}@example.test`;
      await createWorkspaceFixture(db.orm, { email: { owner: email } });
      const t = createAuthTestApp(db, { appUrl: 'https://app.example.test' });

      const { verified } = await t.signIn(email);

      const header = verified.headers.getSetCookie()[0] ?? '';
      expect(header).toMatch(/^__Host-sid=[A-Za-z0-9_-]{43};/);
      expect(header).toContain('HttpOnly');
      expect(header).toContain('SameSite=Lax');
      expect(header).toContain('Path=/');
      expect(header).toContain('Secure');
      expect(header).not.toContain('Domain');
    });
  });
});

describe.skipIf(!databaseUrl)('POST /api/auth/verify with a cookie already present', () => {
  const sessionsOf = async (db: Db, cookieValue: string) =>
    (await db.orm.select().from(session)).filter((row) => row.tokenHash === sha256(cookieValue));

  it("signing in again revokes the previous cookie's sessions; the new cookie works", async () => {
    await withTempDatabase(async (db) => {
      const email = `shared-${unique()}@example.test`;
      const a = await createWorkspaceFixture(db.orm, { email: { owner: email } });
      const b = await createWorkspaceFixture(db.orm, { email: { admin: email } });
      const t = createAuthTestApp(db);
      const first = await t.signIn(email);

      const second = await t.signIn(email, { cookie: first.cookie });

      expect(second.verified.status).toBe(200);
      expect(second.cookieValue).not.toBe(first.cookieValue);
      const old = await sessionsOf(db, first.cookieValue);
      expect(old).toHaveLength(2);
      expect(old.every((row) => row.revokedAt !== null)).toBe(true);
      const fresh = await sessionsOf(db, second.cookieValue);
      expect(fresh).toHaveLength(2);
      expect(fresh.every((row) => row.revokedAt === null)).toBe(true);
      for (const workspaceId of [a.workspaceId, b.workspaceId]) {
        expect(await t.auth.resolveActor(requestWith(first.cookie), workspaceId)).toBeNull();
        expect(await t.auth.resolveActor(requestWith(second.cookie), workspaceId)).not.toBeNull();
      }
      expect((await t.get('/api/auth/session', { cookie: first.cookie })).status).toBe(401);
      expect((await t.get('/api/auth/session', { cookie: second.cookie })).status).toBe(200);
    });
  });

  it('the previous cookie may belong to another person: it is revoked all the same', async () => {
    await withTempDatabase(async (db) => {
      const mine = `owner-${unique()}@example.test`;
      const theirs = `member-${unique()}@example.test`;
      const f = await createWorkspaceFixture(db.orm, { email: { owner: mine, member: theirs } });
      const t = createAuthTestApp(db);
      const attacker = await t.signIn(mine);

      // A victim's browser holds the attacker's cookie and then opens its own link.
      const victim = await t.signIn(theirs, { cookie: attacker.cookie });

      expect(victim.verified.status).toBe(200);
      expect(await t.auth.resolveActor(requestWith(attacker.cookie), f.workspaceId)).toBeNull();
      expect((await t.auth.resolveActor(requestWith(victim.cookie), f.workspaceId))?.memberId).toBe(
        f.members.member.id,
      );
    });
  });

  it('without a cookie nothing else is revoked: another browser keeps its session', async () => {
    await withTempDatabase(async (db) => {
      const email = `owner-${unique()}@example.test`;
      await createWorkspaceFixture(db.orm, { email: { owner: email } });
      const t = createAuthTestApp(db);
      const laptop = await t.signIn(email);

      const phone = await t.signIn(email);

      expect(phone.verified.status).toBe(200);
      expect((await sessionsOf(db, laptop.cookieValue)).every((r) => r.revokedAt === null)).toBe(
        true,
      );
      expect((await t.get('/api/auth/session', { cookie: laptop.cookie })).status).toBe(200);
    });
  });

  it('a garbage or unknown cookie is ignored: the sign-in works and no row is revoked', async () => {
    await withTempDatabase(async (db) => {
      const email = `owner-${unique()}@example.test`;
      await createWorkspaceFixture(db.orm, { email: { owner: email } });
      const t = createAuthTestApp(db);
      const other = await t.signIn(email);

      for (const cookie of ['sid=garbage', `sid=${generateToken()}`, 'sid=', 'other=1']) {
        const res = await t.signIn(email, { cookie });

        expect(res.verified.status, cookie).toBe(200);
      }

      expect((await sessionsOf(db, other.cookieValue)).every((r) => r.revokedAt === null)).toBe(
        true,
      );
      const revoked = (await db.orm.select().from(session)).filter((r) => r.revokedAt !== null);
      expect(revoked).toHaveLength(0);
    });
  });

  it('a link that fails leaves the cookie signed in (invalid token, used token)', async () => {
    await withTempDatabase(async (db) => {
      const email = `owner-${unique()}@example.test`;
      await createWorkspaceFixture(db.orm, { email: { owner: email } });
      const t = createAuthTestApp(db);
      const current = await t.signIn(email);

      const unknown = await t.post(
        '/api/auth/verify',
        { token: generateToken() },
        { cookie: current.cookie },
      );
      const replay = await t.post(
        '/api/auth/verify',
        { token: current.token },
        { cookie: current.cookie },
      );

      expect(unknown.status).toBe(400);
      expect(replay.status).toBe(400);
      expect(unknown.headers.getSetCookie()).toHaveLength(0);
      expect((await t.get('/api/auth/session', { cookie: current.cookie })).status).toBe(200);
    });
  });

  it('a link whose members were all deactivated fails and leaves the cookie signed in', async () => {
    await withTempDatabase(async (db) => {
      const email = `owner-${unique()}@example.test`;
      const keep = `member-${unique()}@example.test`;
      const f = await createWorkspaceFixture(db.orm, { email: { owner: email, member: keep } });
      const t = createAuthTestApp(db);
      const current = await t.signIn(keep);
      await t.post('/api/auth/magic-link', { email });
      await t.waitForMail(2);
      await db.orm
        .update(member)
        .set({ deactivatedAt: new Date() })
        .where(eq(member.id, f.members.owner.id));

      const res = await t.post(
        '/api/auth/verify',
        { token: t.tokenOf(1) },
        { cookie: current.cookie },
      );

      expect(res.status).toBe(400);
      expect(
        (await t.auth.resolveActor(requestWith(current.cookie), f.workspaceId))?.memberId,
      ).toBe(f.members.member.id);
    });
  });

  it('two concurrent verifies of two links with the same old cookie leave exactly the new ones live', async () => {
    await withTempDatabase(async (db) => {
      const email = `owner-${unique()}@example.test`;
      await createWorkspaceFixture(db.orm, { email: { owner: email } });
      const t = createAuthTestApp(db);
      const old = await t.signIn(email);
      await t.post('/api/auth/magic-link', { email });
      await t.post('/api/auth/magic-link', { email });
      await t.waitForMail(3);

      const [x, y] = await Promise.all([
        t.post('/api/auth/verify', { token: t.tokenOf(1) }, { cookie: old.cookie }),
        t.post('/api/auth/verify', { token: t.tokenOf(2) }, { cookie: old.cookie }),
      ]);

      expect([x.status, y.status]).toEqual([200, 200]);
      expect((await sessionsOf(db, old.cookieValue)).every((r) => r.revokedAt !== null)).toBe(true);
      const live = (await db.orm.select().from(session)).filter((r) => r.revokedAt === null);
      expect(live).toHaveLength(2);
    });
  });
});

describe.skipIf(!databaseUrl)('POST /api/auth/preview', () => {
  const issue = async (t: ReturnType<typeof createAuthTestApp>, email: string, index = 0) => {
    await t.post('/api/auth/magic-link', { email });
    await t.waitForMail(index + 1);
    return t.tokenOf(index);
  };

  it('a valid link: 200 with the normalised email, nothing consumed, the link still signs in', async () => {
    await withTempDatabase(async (db) => {
      const email = `owner-${unique()}@example.test`;
      await createWorkspaceFixture(db.orm, { email: { owner: email } });
      const t = createAuthTestApp(db);
      await t.post('/api/auth/magic-link', { email: `  ${email.toUpperCase()} ` });
      await t.waitForMail(1);
      const token = t.tokenOf(0);

      const first = await t.post('/api/auth/preview', { token });
      const second = await t.post('/api/auth/preview', { token });

      expect(first.status).toBe(200);
      expect(await first.json()).toEqual({ email });
      expect(second.status).toBe(200);
      expect(first.headers.getSetCookie()).toHaveLength(0);
      expect(first.headers.get('cache-control')).toBe('no-store');
      const rows = await db.orm.select().from(loginToken);
      expect(rows.every((row) => row.usedAt === null)).toBe(true);
      expect(await db.orm.select().from(session)).toHaveLength(0);
      expect((await t.post('/api/auth/verify', { token })).status).toBe(200);
    });
  });

  it('a link that covers two workspaces answers with the one email', async () => {
    await withTempDatabase(async (db) => {
      const email = `shared-${unique()}@example.test`;
      await createWorkspaceFixture(db.orm, { email: { owner: email } });
      await createWorkspaceFixture(db.orm, { email: { admin: email } });
      const t = createAuthTestApp(db);
      const token = await issue(t, email);

      const res = await t.post('/api/auth/preview', { token });

      expect(await res.json()).toEqual({ email });
    });
  });

  it('a used link → 400 invalid_or_expired', async () => {
    await withTempDatabase(async (db) => {
      const email = `owner-${unique()}@example.test`;
      await createWorkspaceFixture(db.orm, { email: { owner: email } });
      const t = createAuthTestApp(db);
      const token = await issue(t, email);
      await t.post('/api/auth/verify', { token });

      const res = await t.post('/api/auth/preview', { token });

      expect(res.status).toBe(400);
      expect(await res.json()).toMatchObject({ error: 'invalid_or_expired' });
    });
  });

  it('an expired link → 400, a link 14 minutes old → 200', async () => {
    await withTempDatabase(async (db) => {
      const email = `owner-${unique()}@example.test`;
      await createWorkspaceFixture(db.orm, { email: { owner: email } });
      const t = createAuthTestApp(db);
      const token = await issue(t, email);

      t.clock.current = new Date(t.clock.current.getTime() + 14 * MINUTE);
      expect((await t.post('/api/auth/preview', { token })).status).toBe(200);
      t.clock.current = new Date(t.clock.current.getTime() + 2 * MINUTE);
      const stale = await t.post('/api/auth/preview', { token });

      expect(stale.status).toBe(400);
      expect(await stale.json()).toMatchObject({ error: 'invalid_or_expired' });
    });
  });

  it('unknown and malformed tokens → 400 invalid_or_expired, never an email', async () => {
    await withTempDatabase(async (db) => {
      const t = createAuthTestApp(db);

      for (const body of [
        {},
        { token: 5 },
        { token: 'short' },
        { token: 'A'.repeat(43) },
        { token: generateToken() },
        'nope{',
      ]) {
        const res = await t.post('/api/auth/preview', body);

        expect(res.status, JSON.stringify(body)).toBe(400);
        expect(await res.json()).toMatchObject({ error: 'invalid_or_expired' });
      }
    });
  });

  it('a link whose members were all deactivated → 400 (it would not sign anyone in)', async () => {
    await withTempDatabase(async (db) => {
      const email = `owner-${unique()}@example.test`;
      const f = await createWorkspaceFixture(db.orm, { email: { owner: email } });
      const t = createAuthTestApp(db);
      const token = await issue(t, email);
      await db.orm
        .update(member)
        .set({ deactivatedAt: new Date() })
        .where(eq(member.id, f.members.owner.id));

      expect((await t.post('/api/auth/preview', { token })).status).toBe(400);
    });
  });

  it('a GET on the preview path answers no email (POST only)', async () => {
    await withTempDatabase(async (db) => {
      const email = `owner-${unique()}@example.test`;
      await createWorkspaceFixture(db.orm, { email: { owner: email } });
      const t = createAuthTestApp(db);
      const token = await issue(t, email);

      const res = await t.get(`/api/auth/preview?token=${token}`);

      expect([404, 405]).toContain(res.status);
    });
  });

  it('61st call from one IP answers 429 with Retry-After; another IP is unaffected', async () => {
    await withTempDatabase(async (db) => {
      const t = createAuthTestApp(db);
      const ask = (ip: string) => t.post('/api/auth/preview', { token: generateToken() }, { ip });

      for (let i = 1; i <= 60; i++) expect((await ask('203.0.113.7')).status).toBe(400);
      const blocked = await ask('203.0.113.7');

      expect(blocked.status).toBe(429);
      const retryAfter = Number(blocked.headers.get('retry-after'));
      expect(Number.isInteger(retryAfter)).toBe(true);
      expect(retryAfter).toBeGreaterThan(0);
      expect(retryAfter).toBeLessThanOrEqual(900);
      expect((await ask('203.0.113.8')).status).toBe(400);
    });
  });

  it('preview and verify share the 60 per 15 minutes of one IP', async () => {
    await withTempDatabase(async (db) => {
      const t = createAuthTestApp(db);
      const body = () => ({ token: generateToken() });

      for (let i = 1; i <= 30; i++) {
        expect((await t.post('/api/auth/preview', body(), { ip: '203.0.113.9' })).status).toBe(400);
        expect((await t.post('/api/auth/verify', body(), { ip: '203.0.113.9' })).status).toBe(400);
      }

      expect((await t.post('/api/auth/verify', body(), { ip: '203.0.113.9' })).status).toBe(429);
      expect((await t.post('/api/auth/preview', body(), { ip: '203.0.113.9' })).status).toBe(429);
      expect((await t.post('/api/auth/magic-link', { email: 'a@example.test' })).status).toBe(202);
    });
  });

  it('the limit is open again after 15 minutes', async () => {
    await withTempDatabase(async (db) => {
      const t = createAuthTestApp(db);
      const ask = () => t.post('/api/auth/preview', { token: generateToken() });
      for (let i = 1; i <= 60; i++) await ask();
      expect((await ask()).status).toBe(429);

      t.clock.current = new Date(t.clock.current.getTime() + 15 * MINUTE + 1000);

      expect((await ask()).status).toBe(400);
    });
  });
});

describe.skipIf(!databaseUrl)('GET /api/auth/session and POST /api/auth/logout', () => {
  it('no cookie, a garbage cookie or an expired session → 401 unauthenticated', async () => {
    await withTempDatabase(async (db) => {
      const email = `owner-${unique()}@example.test`;
      await createWorkspaceFixture(db.orm, { email: { owner: email } });
      const t = createAuthTestApp(db);
      const { cookie } = await t.signIn(email);

      for (const c of [undefined, 'sid=garbage', 'sid=', `other=${cookie.split('=')[1]}`]) {
        const res = await t.get('/api/auth/session', { cookie: c });

        expect(res.status, String(c)).toBe(401);
        expect(await res.json()).toMatchObject({ error: 'unauthenticated' });
      }

      expect((await t.get('/api/auth/session', { cookie })).status).toBe(200);
      t.clock.current = new Date(t.clock.current.getTime() + 31 * DAY);
      expect((await t.get('/api/auth/session', { cookie })).status).toBe(401);
    });
  });

  it("the cookie lives as long as the session does: GET /session re-sends it with the session's real expiry", async () => {
    await withTempDatabase(async (db) => {
      const email = `owner-${unique()}@example.test`;
      await createWorkspaceFixture(db.orm, { email: { owner: email } });
      const t = createAuthTestApp(db);
      const { cookie, cookieValue } = await t.signIn(email);
      const start = t.clock.current.getTime();
      const maxAgeAt = async (offsetMs: number) => {
        t.clock.current = new Date(start + offsetMs);
        const res = await t.get('/api/auth/session', { cookie });
        expect(res.status).toBe(200);
        const header = res.headers.getSetCookie()[0] ?? '';
        expect(header).toContain(`sid=${cookieValue};`);
        expect(header).toContain('HttpOnly');
        expect(header).toContain('SameSite=Lax');
        return Number(/Max-Age=(\d+)/.exec(header)?.[1]);
      };

      // Not touched yet (under an hour): the cookie still ends when the session row does.
      expect(await maxAgeAt(10 * MINUTE)).toBe(30 * 86_400 - 10 * 60);
      // Every touch slides the session by 30 days, and the cookie with it ...
      expect(await maxAgeAt(20 * DAY)).toBe(30 * 86_400);
      expect(await maxAgeAt(40 * DAY)).toBe(30 * 86_400);
      expect(await maxAgeAt(60 * DAY)).toBe(30 * 86_400);
      // ... until the 90-day ceiling of the session: 10 days left on day 80.
      expect(await maxAgeAt(80 * DAY)).toBe(10 * 86_400);
    });
  });

  it('a 401 from GET /session sets no cookie', async () => {
    await withTempDatabase(async (db) => {
      const t = createAuthTestApp(db);

      const res = await t.get('/api/auth/session', { cookie: 'sid=garbage' });

      expect(res.status).toBe(401);
      expect(res.headers.getSetCookie()).toHaveLength(0);
    });
  });

  it('logout revokes the session in every workspace and clears the cookie', async () => {
    await withTempDatabase(async (db) => {
      const email = `shared-${unique()}@example.test`;
      await createWorkspaceFixture(db.orm, { email: { owner: email } });
      await createWorkspaceFixture(db.orm, { email: { member: email } });
      const t = createAuthTestApp(db);
      const { cookie } = await t.signIn(email);

      const res = await t.post('/api/auth/logout', undefined, { cookie });

      expect(res.status).toBe(204);
      const cleared = res.headers.getSetCookie()[0] ?? '';
      expect(cleared).toMatch(/^sid=;/);
      expect(cleared).toMatch(/Max-Age=0|Expires=Thu, 01 Jan 1970/);
      const rows = await db.orm.select().from(session);
      expect(rows).toHaveLength(2);
      expect(rows.every((r) => r.revokedAt !== null)).toBe(true);
      expect((await t.get('/api/auth/session', { cookie })).status).toBe(401);
    });
  });

  it('logout leaves the sessions of another browser alone, and works without a cookie', async () => {
    await withTempDatabase(async (db) => {
      const email = `owner-${unique()}@example.test`;
      await createWorkspaceFixture(db.orm, { email: { owner: email } });
      const t = createAuthTestApp(db);
      const first = await t.signIn(email);
      const second = await t.signIn(email);

      expect((await t.post('/api/auth/logout', undefined, { cookie: first.cookie })).status).toBe(
        204,
      );
      expect((await t.post('/api/auth/logout', undefined)).status).toBe(204);

      expect((await t.get('/api/auth/session', { cookie: first.cookie })).status).toBe(401);
      expect((await t.get('/api/auth/session', { cookie: second.cookie })).status).toBe(200);
    });
  });
});

describe.skipIf(!databaseUrl)('secrets in the console', () => {
  it('no raw token, link or cookie value appears in console output across the whole flow', async () => {
    await withTempDatabase(async (db) => {
      const calls: string[] = [];
      for (const method of ['log', 'info', 'warn', 'error', 'debug'] as const) {
        vi.spyOn(console, method).mockImplementation((...args: unknown[]) => {
          calls.push(
            args
              .map((a) => (a instanceof Error ? `${a.message}\n${a.stack}` : String(a)))
              .join(' '),
          );
        });
      }
      const email = `owner-${unique()}@example.test`;
      await createWorkspaceFixture(db.orm, { email: { owner: email } });
      const t = createAuthTestApp(db);
      const failing = createAuthTestApp(db, { mailerFails: true });

      const { token, cookie, cookieValue } = await t.signIn(email);
      const link = /(https?:\/\/\S+)/.exec(t.mailer.sent[0]?.text ?? '')?.[1] ?? '';
      await t.get('/api/auth/session', { cookie });
      await t.post('/api/auth/verify', { token }); // replay
      await t.post('/api/auth/logout', undefined, { cookie });
      await failing.post('/api/auth/magic-link', { email });
      await failing.flush();

      expect(link).toContain(token);
      const output = calls.join('\n');
      for (const secret of [token, link, cookieValue, cookie]) {
        expect(output).not.toContain(secret);
      }
    });
  });
});

describe.skipIf(!databaseUrl)('rows written by sign-in', () => {
  it('login tokens live 15 minutes and sessions 30 days from the injected clock', async () => {
    await withTempDatabase(async (db) => {
      const email = `owner-${unique()}@example.test`;
      await createWorkspaceFixture(db.orm, { email: { owner: email } });
      const t = createAuthTestApp(db);
      const startedAt = t.clock.current.getTime();

      await t.signIn(email);

      const [login] = await db.orm.select().from(loginToken);
      const [sess] = await db.orm.select().from(session);
      expect(login?.expiresAt.getTime()).toBe(startedAt + 15 * MINUTE);
      expect(sess?.expiresAt.getTime()).toBe(startedAt + 30 * DAY);
      expect(sess?.createdAt.getTime()).toBe(startedAt);
    });
  });
});
