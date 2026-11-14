import { createHash, randomBytes } from 'node:crypto';
import { invite, session, workspace } from '@torch/shared/db/schema';
import { eq } from 'drizzle-orm';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '../app.ts';
import { createSessionsForMembers } from '../auth/sessions.ts';
import type { Db } from '../db.ts';
import { createAuthTestApp, testBrand } from '../test/auth-app.ts';
import { addMember, createWorkspaceFixture, type WorkspaceFixture } from '../test/fixtures.ts';
import { useSharedDatabase } from '../test/shared-database.ts';

const databaseUrl = process.env.DATABASE_URL;

// Integration: needs the dev compose Postgres (see db.test.ts). Skipped, loudly, when DATABASE_URL is not set.
if (!databaseUrl) {
  console.warn(
    '[invites/routes.test] SKIPPED the invite route tests: DATABASE_URL is not set. ' +
      'Start `docker compose -f docker-compose.dev.yml up -d --wait postgres` and set DATABASE_URL (see .env.example).',
  );
}

const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;
const sha256 = (value: string) => createHash('sha256').update(value).digest('hex');
const unique = () => randomBytes(4).toString('hex');
const UNKNOWN_UUID = '99999999-9999-4999-8999-999999999999';

afterEach(() => vi.restoreAllMocks());

describe.skipIf(!databaseUrl)('invite routes (Postgres)', () => {
  const getDb = useSharedDatabase();

  type Harness = ReturnType<typeof createAuthTestApp>;

  /** A cookie for a member, the way a sign-in would have issued it. */
  async function cookieFor(
    db: Db,
    t: Harness,
    f: WorkspaceFixture,
    role: keyof WorkspaceFixture['members'],
  ) {
    const token = await db.orm.transaction((tx) =>
      createSessionsForMembers(tx, [{ workspaceId: f.workspaceId, memberId: f.members[role].id }], {
        now: t.now(),
        userAgent: null,
      }),
    );
    return `${t.appUrl.startsWith('https:') ? '__Host-sid' : 'sid'}=${token}`;
  }

  async function setup(opts: Parameters<typeof createAuthTestApp>[1] = {}) {
    const db = getDb();
    const f = await createWorkspaceFixture(db.orm);
    const t = createAuthTestApp(db, opts);
    return {
      db,
      f,
      t,
      owner: await cookieFor(db, t, f, 'owner'),
      admin: await cookieFor(db, t, f, 'admin'),
      member: await cookieFor(db, t, f, 'member'),
      guest: await cookieFor(db, t, f, 'guest'),
      base: `/api/w/${f.workspaceId}`,
    };
  }

  const tokenInMail = (mail: { text: string } | undefined) => {
    const match = /#token=([A-Za-z0-9_-]+)/.exec(mail?.text ?? '');
    if (!match?.[1]) throw new Error('no invite link in the mail');
    return match[1];
  };

  /** Creates an invite through the API and returns its id and token (read from the mail). */
  async function createViaApi(
    s: Awaited<ReturnType<typeof setup>>,
    body: Record<string, unknown> = {},
    cookie = s.owner,
  ) {
    const before = s.t.mailer.sent.length;
    const res = await s.t.post(
      `${s.base}/invites`,
      { email: `new-${unique()}@example.test`, role: 'member', teamIds: [], ...body },
      { cookie },
    );
    if (res.status !== 201) throw new Error(`create answered ${res.status}`);
    const { inviteId } = (await res.json()) as { inviteId: string };
    await s.t.waitForMail(before + 1);
    return { inviteId, token: tokenInMail(s.t.mailer.sent[before]) };
  }

  describe('authenticated routes', () => {
    it('answer 401 without a cookie and with the cookie of another workspace', async () => {
      const s = await setup();
      const other = await setup();
      const calls: [string, string, unknown][] = [
        ['GET', '/invites', undefined],
        ['POST', '/invites', { email: 'x@example.test', role: 'member', teamIds: [] }],
        ['POST', `/invites/${UNKNOWN_UUID}/resend`, undefined],
        ['DELETE', `/invites/${UNKNOWN_UUID}`, undefined],
      ];

      for (const [method, path, body] of calls) {
        const anonymous = await s.t.request(method, `${s.base}${path}`, body);
        const foreign = await s.t.request(method, `${s.base}${path}`, body, {
          cookie: other.owner,
        });

        expect(anonymous.status, `${method} ${path}`).toBe(401);
        expect(foreign.status, `${method} ${path} with a cookie of another workspace`).toBe(401);
        expect(await foreign.json()).toMatchObject({ error: 'unauthenticated' });
      }
    });

    it('a workspace id that is not a uuid is 404', async () => {
      const s = await setup();

      const res = await s.t.get('/api/w/not-a-uuid/invites', { cookie: s.owner });

      expect(res.status).toBe(404);
    });

    it('POST /invites answers 201 with the id only and mails a fragment link, never a query token', async () => {
      const s = await setup();
      const { db, f, t } = s;
      const email = `  Ada.${unique()}@Example.TEST `;

      const res = await t.post(
        `${s.base}/invites`,
        { email, role: 'guest', teamIds: [f.teams.eng.id], locale: 'it' },
        { cookie: s.owner },
      );
      await t.waitForMail(1);
      await t.flush();

      expect(res.status).toBe(201);
      const body = (await res.json()) as Record<string, unknown>;
      expect(Object.keys(body)).toEqual(['inviteId']);
      expect(res.headers.get('cache-control')).toBe('no-store');
      expect(t.mailer.sent).toHaveLength(1);
      const mail = t.mailer.sent[0];
      const token = tokenInMail(mail);
      expect(mail?.to).toBe(email.trim().toLowerCase());
      for (const part of [mail?.text, mail?.html]) {
        expect(part).toContain(`${t.appUrl}/invite#token=${token}`);
        expect(part).not.toContain('?token');
      }
      const [ws] = await db.orm.select().from(workspace).where(eq(workspace.id, f.workspaceId));
      expect(mail?.subject).toBe(
        `${f.members.owner.name} ti invita a unirti a ${ws?.name} su Acme Tasks`,
      );
      expect(mail?.text).toContain('Ospite');
      const [row] = await db.orm
        .select()
        .from(invite)
        .where(eq(invite.id, String(body.inviteId)));
      expect(row?.tokenHash).toBe(sha256(token));
      expect(JSON.stringify(body)).not.toContain(token);
      expect(JSON.stringify(body)).not.toContain(row?.tokenHash ?? 'x');
    });

    it('the mail is in English unless the invite says otherwise, and names the inviter and the workspace', async () => {
      const s = await setup();
      const { db, f, t } = s;

      await createViaApi(s, { role: 'admin' });

      const [ws] = await db.orm.select().from(workspace).where(eq(workspace.id, f.workspaceId));
      expect(t.mailer.sent[0]?.subject).toBe(
        `${f.members.owner.name} invited you to ${ws?.name} on Acme Tasks`,
      );
      expect(t.mailer.sent[0]?.text).toContain('Admin');
    });

    it('an admin inviting an admin is 403 and sends no mail; a member and a guest are 403', async () => {
      const s = await setup();
      const { t } = s;

      const asAdmin = await t.post(
        `${s.base}/invites`,
        { email: `x-${unique()}@example.test`, role: 'admin', teamIds: [] },
        { cookie: s.admin },
      );
      const asMember = await t.post(
        `${s.base}/invites`,
        { email: `x-${unique()}@example.test`, role: 'guest', teamIds: [s.f.teams.eng.id] },
        { cookie: s.member },
      );
      const asGuest = await t.post(
        `${s.base}/invites`,
        { email: `x-${unique()}@example.test`, role: 'guest', teamIds: [s.f.teams.eng.id] },
        { cookie: s.guest },
      );
      await t.flush();

      for (const res of [asAdmin, asMember, asGuest]) {
        expect(res.status).toBe(403);
        expect(await res.json()).toMatchObject({ error: 'forbidden' });
      }
      expect(t.mailer.sent).toHaveLength(0);
    });

    it('validates the body: bad JSON, unknown field, bad email, guest without team, bad ids, 20 KB', async () => {
      const s = await setup();
      const { t } = s;
      const good = { email: `ok-${unique()}@example.test`, role: 'member', teamIds: [] };
      const bad: unknown[] = [
        'not json{',
        { ...good, extra: true },
        { ...good, email: 'nope' },
        { ...good, role: 'superuser' },
        { ...good, role: 'guest', teamIds: [] },
        { ...good, teamIds: ['not-a-uuid'] },
        { ...good, teamIds: [UNKNOWN_UUID, UNKNOWN_UUID] },
        {},
      ];

      for (const body of bad) {
        const res = await t.post(`${s.base}/invites`, body, { cookie: s.owner });

        expect(res.status, JSON.stringify(body)).toBe(400);
        expect(await res.json()).toMatchObject({ error: 'invalid_input' });
      }
      const huge = await t.post(
        `${s.base}/invites`,
        { ...good, email: `${'a'.repeat(20 * 1024)}@example.test` },
        { cookie: s.owner },
      );
      expect(huge.status).toBe(413);
    });

    it('a team of another workspace is 404, a duplicate is 409, an active member is 409', async () => {
      const s = await setup();
      const other = await setup();
      const { t, f } = s;
      const email = `dupe-${unique()}@example.test`;

      const foreignTeam = await t.post(
        `${s.base}/invites`,
        { email: `a-${unique()}@example.test`, role: 'guest', teamIds: [other.f.teams.eng.id] },
        { cookie: s.owner },
      );
      await createViaApi(s, { email });
      const pending = await t.post(
        `${s.base}/invites`,
        { email, role: 'member', teamIds: [] },
        { cookie: s.owner },
      );
      const existing = await t.post(
        `${s.base}/invites`,
        { email: f.members.member.email, role: 'member', teamIds: [] },
        { cookie: s.owner },
      );

      expect(foreignTeam.status).toBe(404);
      expect(await foreignTeam.json()).toMatchObject({ error: 'not_found' });
      expect(pending.status).toBe(409);
      expect(await pending.json()).toMatchObject({ error: 'invite_pending' });
      expect(existing.status).toBe(409);
      expect(await existing.json()).toMatchObject({ error: 'already_member' });
    });

    it('answers 201 at once even when the mail server never answers', async () => {
      const db = getDb();
      const f = await createWorkspaceFixture(db.orm);
      const helper = createAuthTestApp(db);
      const app = createApp({
        brand: testBrand,
        db,
        config: { appUrl: helper.appUrl, trustProxy: false },
        mailer: { send: () => new Promise<void>(() => {}) },
        auth: helper.auth,
        now: helper.now,
      });
      const cookie = await cookieFor(db, helper, f, 'owner');

      const res = await Promise.race([
        app.fetch(
          new Request(`${helper.origin}/api/w/${f.workspaceId}/invites`, {
            method: 'POST',
            headers: { 'content-type': 'application/json', origin: helper.origin, cookie },
            body: JSON.stringify({
              email: `hang-${unique()}@example.test`,
              role: 'member',
              teamIds: [],
            }),
          }),
        ),
        new Promise<null>((resolve) => setTimeout(() => resolve(null), 3000)),
      ]);

      expect(res?.status).toBe(201);
    });

    it('a failing mail server still answers 201 and the log never holds the link or the token', async () => {
      const s = await setup({ mailerFails: true });
      const errors = vi.spyOn(console, 'error').mockImplementation(() => {});

      const res = await s.t.post(
        `${s.base}/invites`,
        { email: `fail-${unique()}@example.test`, role: 'member', teamIds: [] },
        { cookie: s.owner },
      );
      await vi.waitFor(() => expect(errors).toHaveBeenCalled());

      expect(res.status).toBe(201);
      const { inviteId } = (await res.json()) as { inviteId: string };
      const [row] = await s.db.orm.select().from(invite).where(eq(invite.id, inviteId));
      expect(row).toBeDefined();
      const logged = errors.mock.calls.flat().map(String).join('\n');
      expect(logged).toContain('smtp down');
      expect(logged).not.toContain('#token');
      expect(logged).not.toContain('/invite');
      expect(logged).not.toContain(row?.tokenHash ?? 'x');
    });

    it('GET /invites lists the pending invites for an owner and an admin, never a token or a hash; 403 for a member', async () => {
      const s = await setup();
      const first = await createViaApi(s, { role: 'guest', teamIds: [s.f.teams.eng.id] });
      s.t.clock.current = new Date(s.t.clock.current.getTime() + MINUTE);
      const second = await createViaApi(s, {});

      const asOwner = await s.t.get(`${s.base}/invites`, { cookie: s.owner });
      const asAdmin = await s.t.get(`${s.base}/invites`, { cookie: s.admin });
      const asMember = await s.t.get(`${s.base}/invites`, { cookie: s.member });
      const asGuest = await s.t.get(`${s.base}/invites`, { cookie: s.guest });

      expect(asOwner.status).toBe(200);
      const text = await asOwner.text();
      const parsed = JSON.parse(text) as { invites: { id: string; teamIds: string[] }[] };
      expect(parsed.invites.map((item) => item.id)).toEqual([second.inviteId, first.inviteId]);
      expect(parsed.invites[1]?.teamIds).toEqual([s.f.teams.eng.id]);
      expect(text).not.toContain(first.token);
      expect(text).not.toContain(sha256(first.token));
      expect(text).not.toContain('tokenHash');
      expect(asAdmin.status).toBe(200);
      expect(asMember.status).toBe(403);
      expect(asGuest.status).toBe(403);
    });

    it('POST /invites/:id/resend mails a new link and kills the old one', async () => {
      const s = await setup();
      const { t } = s;
      const created = await createViaApi(s, {});

      const res = await t.post(`${s.base}/invites/${created.inviteId}/resend`, undefined, {
        cookie: s.owner,
      });
      await t.waitForMail(2);

      expect(res.status).toBe(202);
      expect(await res.json()).toEqual({ status: 'sent' });
      const fresh = tokenInMail(t.mailer.sent[1]);
      expect(fresh).not.toBe(created.token);
      const oldPreview = await t.post('/api/invites/preview', { token: created.token });
      const newPreview = await t.post('/api/invites/preview', { token: fresh });
      expect(oldPreview.status).toBe(400);
      expect(newPreview.status).toBe(200);
    });

    it('resend and revoke: unknown or foreign invite id 404, member 403, malformed id 404', async () => {
      const s = await setup();
      const other = await setup();
      const foreign = await createViaApi(other, {});

      for (const id of [UNKNOWN_UUID, foreign.inviteId, 'not-a-uuid']) {
        const resend = await s.t.post(`${s.base}/invites/${id}/resend`, undefined, {
          cookie: s.owner,
        });
        const revoke = await s.t.request('DELETE', `${s.base}/invites/${id}`, undefined, {
          cookie: s.owner,
        });

        expect(resend.status, `resend ${id}`).toBe(404);
        expect(revoke.status, `revoke ${id}`).toBe(404);
        expect(await revoke.json()).toMatchObject({ error: 'not_found' });
      }
      const own = await createViaApi(s, {});
      const memberResend = await s.t.post(`${s.base}/invites/${own.inviteId}/resend`, undefined, {
        cookie: s.member,
      });
      const memberRevoke = await s.t.request(
        'DELETE',
        `${s.base}/invites/${own.inviteId}`,
        undefined,
        {
          cookie: s.member,
        },
      );
      expect(memberResend.status).toBe(403);
      expect(memberRevoke.status).toBe(403);
    });

    it('DELETE /invites/:id answers a txid, kills the link, and a second DELETE is a 200 no-op', async () => {
      const s = await setup();
      const created = await createViaApi(s, {});

      const first = await s.t.request(
        'DELETE',
        `${s.base}/invites/${created.inviteId}`,
        undefined,
        {
          cookie: s.owner,
        },
      );
      const second = await s.t.request(
        'DELETE',
        `${s.base}/invites/${created.inviteId}`,
        undefined,
        {
          cookie: s.owner,
        },
      );

      expect(first.status).toBe(200);
      expect(typeof ((await first.json()) as { txid: unknown }).txid).toBe('number');
      expect(second.status).toBe(200);
      const preview = await s.t.post('/api/invites/preview', { token: created.token });
      expect(preview.status).toBe(400);
    });
  });

  describe('public routes', () => {
    it('preview works without a cookie and returns the invite summary, not the hash', async () => {
      const s = await setup();
      const { db, f, t } = s;
      const email = `peek-${unique()}@example.test`;
      const created = await createViaApi(s, { email, role: 'guest', teamIds: [f.teams.eng.id] });
      const [ws] = await db.orm.select().from(workspace).where(eq(workspace.id, f.workspaceId));

      const res = await t.post('/api/invites/preview', { token: created.token });

      expect(res.status).toBe(200);
      expect(res.headers.get('cache-control')).toBe('no-store');
      const text = await res.text();
      expect(JSON.parse(text)).toEqual({
        workspaceName: ws?.name,
        email,
        role: 'guest',
        teams: [{ key: f.teams.eng.key, name: f.teams.eng.name }],
      });
      expect(text).not.toContain(sha256(created.token));
    });

    it('preview of an unknown token is 400 invite_invalid; a missing token is 400 invalid_input', async () => {
      const s = await setup();

      const unknown = await s.t.post('/api/invites/preview', { token: 'a'.repeat(43) });
      const missing = await s.t.post('/api/invites/preview', {});
      const notJson = await s.t.post('/api/invites/preview', 'nope{');

      expect(unknown.status).toBe(400);
      expect(await unknown.json()).toMatchObject({ error: 'invite_invalid' });
      expect(missing.status).toBe(400);
      expect(await missing.json()).toMatchObject({ error: 'invalid_input' });
      expect(notJson.status).toBe(400);
    });

    it('accept signs the person in: 200 with the workspace and one session cookie that resolves to an actor', async () => {
      const s = await setup();
      const { db, f, t } = s;
      const created = await createViaApi(s, { role: 'guest', teamIds: [f.teams.eng.id] });

      const res = await t.post('/api/invites/accept', {
        token: created.token,
        name: 'Grace Hopper',
      });

      expect(res.status).toBe(200);
      expect(res.headers.get('cache-control')).toBe('no-store');
      const cookieHeaders = res.headers.getSetCookie();
      expect(cookieHeaders).toHaveLength(1);
      const [pair, ...attributes] = (cookieHeaders[0] ?? '').split(';').map((part) => part.trim());
      expect(pair).toMatch(/^sid=[A-Za-z0-9_-]{43}$/);
      expect(attributes).toEqual(expect.arrayContaining(['HttpOnly', 'SameSite=Lax', 'Path=/']));
      const maxAge = Number(attributes.find((a) => a.startsWith('Max-Age='))?.slice(8));
      expect(maxAge).toBe(30 * 24 * 60 * 60);
      expect(attributes).not.toContain('Secure');

      const body = (await res.json()) as {
        workspaces: { id: string; memberId: string; role: string }[];
      };
      expect(body.workspaces).toHaveLength(1);
      expect(body.workspaces[0]).toMatchObject({ id: f.workspaceId, role: 'guest' });
      const cookie = pair ?? '';
      const actor = await t.auth.resolveActor(
        new Request(`${t.origin}/x`, { headers: { cookie } }),
        f.workspaceId,
      );
      expect(actor).toMatchObject({
        workspaceId: f.workspaceId,
        memberId: body.workspaces[0]?.memberId,
        role: 'guest',
      });
      expect([...(actor?.teamIds ?? [])]).toEqual([f.teams.eng.id]);
      const sessionRes = await t.get('/api/auth/session', { cookie });
      expect(sessionRes.status).toBe(200);
      const text = JSON.stringify(body);
      expect(text).not.toContain(created.token);
      expect(text).not.toContain(sha256(created.token));
      const rows = await db.orm
        .select()
        .from(session)
        .where(eq(session.memberId, actor?.memberId ?? ''));
      expect(rows).toHaveLength(1);
    });

    it('over https the cookie is __Host-sid and Secure', async () => {
      const s = await setup({ appUrl: 'https://app.example.test' });
      const created = await createViaApi(s, {});

      const res = await s.t.post('/api/invites/accept', {
        token: created.token,
        name: 'Secure Person',
      });

      const header = res.headers.getSetCookie()[0] ?? '';
      expect(header).toMatch(/^__Host-sid=/);
      expect(header).toContain('Secure');
    });

    it('a second accept is 400 invite_invalid; a bad name is 400 invalid_input and the link still works', async () => {
      const s = await setup();
      const created = await createViaApi(s, {});

      const badName = await s.t.post('/api/invites/accept', { token: created.token, name: '   ' });
      const missingName = await s.t.post('/api/invites/accept', { token: created.token });
      const first = await s.t.post('/api/invites/accept', {
        token: created.token,
        name: 'Once Only',
      });
      const second = await s.t.post('/api/invites/accept', { token: created.token, name: 'Twice' });

      expect(badName.status).toBe(400);
      expect(await badName.json()).toMatchObject({ error: 'invalid_input' });
      expect(missingName.status).toBe(400);
      expect(first.status).toBe(200);
      expect(second.status).toBe(400);
      expect(await second.json()).toMatchObject({ error: 'invite_invalid' });
      expect(second.headers.getSetCookie()).toHaveLength(0);
    });

    it('an expired link is 400 invite_invalid', async () => {
      const s = await setup();
      const created = await createViaApi(s, {});
      s.t.clock.current = new Date(s.t.clock.current.getTime() + 7 * DAY);

      const preview = await s.t.post('/api/invites/preview', { token: created.token });
      const accept = await s.t.post('/api/invites/accept', { token: created.token, name: 'Late' });

      expect(preview.status).toBe(400);
      expect(accept.status).toBe(400);
      expect(await accept.json()).toMatchObject({ error: 'invite_invalid' });
    });

    it('an already_member race is 409', async () => {
      const s = await setup();
      const email = `race-${unique()}@example.test`;
      const created = await createViaApi(s, { email });
      await addMember(s.db.orm, s.f.workspaceId, 'member', { email });

      const res = await s.t.post('/api/invites/accept', {
        token: created.token,
        name: 'Late Comer',
      });

      expect(res.status).toBe(409);
      expect(await res.json()).toMatchObject({ error: 'already_member' });
    });

    it('accepting while signed in as someone else revokes that previous cookie', async () => {
      const s = await setup();
      const created = await createViaApi(s, {});
      const before = await s.t.auth.resolveActor(
        new Request(`${s.t.origin}/x`, { headers: { cookie: s.member } }),
        s.f.workspaceId,
      );
      expect(before).not.toBeNull();

      const res = await s.t.post(
        '/api/invites/accept',
        { token: created.token, name: 'Fresh Start' },
        { cookie: s.member },
      );

      expect(res.status).toBe(200);
      const after = await s.t.auth.resolveActor(
        new Request(`${s.t.origin}/x`, { headers: { cookie: s.member } }),
        s.f.workspaceId,
      );
      expect(after).toBeNull();
    });

    it('a failed accept leaves the previous cookie alone', async () => {
      const s = await setup();

      const res = await s.t.post(
        '/api/invites/accept',
        { token: 'a'.repeat(43), name: 'Nobody' },
        { cookie: s.member },
      );

      expect(res.status).toBe(400);
      const actor = await s.t.auth.resolveActor(
        new Request(`${s.t.origin}/x`, { headers: { cookie: s.member } }),
        s.f.workspaceId,
      );
      expect(actor).not.toBeNull();
    });

    it('the 21st public call from one address in 15 minutes is 429 with Retry-After; other addresses and the signed-in routes are not affected', async () => {
      const s = await setup();
      const { t } = s;
      const ip = '203.0.113.7';

      for (let call = 1; call <= 20; call++) {
        // Preview and accept share one limiter.
        const res =
          call % 2 === 0
            ? await t.post('/api/invites/preview', { token: 'a'.repeat(43) }, { ip })
            : await t.post('/api/invites/accept', { token: 'a'.repeat(43), name: 'X' }, { ip });
        expect(res.status, `call ${call}`).toBe(400);
      }
      const limited = await t.post('/api/invites/preview', { token: 'a'.repeat(43) }, { ip });
      const limitedAccept = await t.post(
        '/api/invites/accept',
        { token: 'a'.repeat(43), name: 'X' },
        { ip },
      );
      const elsewhere = await t.post(
        '/api/invites/preview',
        { token: 'a'.repeat(43) },
        { ip: '203.0.113.8' },
      );
      const signedIn = await t.get(`${s.base}/invites`, { cookie: s.owner, ip });

      expect(limited.status).toBe(429);
      expect(await limited.json()).toMatchObject({ error: 'rate_limited' });
      expect(Number(limited.headers.get('retry-after'))).toBeGreaterThan(0);
      expect(limitedAccept.status).toBe(429);
      expect(elsewhere.status).toBe(400);
      expect(signedIn.status).toBe(200);

      t.clock.current = new Date(t.clock.current.getTime() + 16 * MINUTE);
      const later = await t.post('/api/invites/preview', { token: 'a'.repeat(43) }, { ip });
      expect(later.status).toBe(400);
    });

    it('a body over 16 KB is 413', async () => {
      const s = await setup();

      const res = await s.t.post('/api/invites/accept', {
        token: 'a'.repeat(43),
        name: 'x'.repeat(20 * 1024),
      });

      expect(res.status).toBe(413);
    });
  });
});
