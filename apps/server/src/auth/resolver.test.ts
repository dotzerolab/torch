import { member, session } from '@torch/shared/db/schema';
import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { loadActor } from '../permissions/load-actor.ts';
import { createAuthTestApp } from '../test/auth-app.ts';
import { createWorkspaceFixture, withTempDatabase } from '../test/fixtures.ts';

const databaseUrl = process.env.DATABASE_URL;

// Integration: needs the dev compose Postgres (see db.test.ts). Skipped, loudly, when DATABASE_URL is not set.
if (!databaseUrl) {
  console.warn(
    '[auth/resolver.test] SKIPPED the session-resolver integration tests: DATABASE_URL is not set. ' +
      'Start `docker compose -f docker-compose.dev.yml up -d --wait postgres` and set DATABASE_URL (see .env.example).',
  );
}

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const unique = () => crypto.randomUUID().slice(0, 8);
const withCookie = (cookie?: string) =>
  new Request('http://app.example.test/api/x', { headers: cookie ? { cookie } : {} });

describe.skipIf(!databaseUrl)('createSessionActorResolver', () => {
  it('valid session → the actor of that workspace', async () => {
    await withTempDatabase(async (db) => {
      const email = `member-${unique()}@example.test`;
      const f = await createWorkspaceFixture(db.orm, { email: { member: email } });
      const t = createAuthTestApp(db);
      const { cookie } = await t.signIn(email);

      const actor = await t.auth.resolveActor(withCookie(cookie), f.workspaceId);

      expect(actor).toEqual(await loadActor(db.orm, f.workspaceId, f.members.member.id));
      expect(actor).toMatchObject({ role: 'member', memberId: f.members.member.id });
    });
  });

  it('finds the cookie among others', async () => {
    await withTempDatabase(async (db) => {
      const email = `member-${unique()}@example.test`;
      const f = await createWorkspaceFixture(db.orm, { email: { member: email } });
      const t = createAuthTestApp(db);
      const { cookie } = await t.signIn(email);

      const actor = await t.auth.resolveActor(withCookie(`a=1; ${cookie}; b=2`), f.workspaceId);

      expect(actor?.memberId).toBe(f.members.member.id);
    });
  });

  it('other workspace → null, even when the same cookie signs into a second workspace', async () => {
    await withTempDatabase(async (db) => {
      const email = `member-${unique()}@example.test`;
      await createWorkspaceFixture(db.orm, { email: { member: email } });
      const other = await createWorkspaceFixture(db.orm);
      const t = createAuthTestApp(db);
      const { cookie } = await t.signIn(email);

      expect(await t.auth.resolveActor(withCookie(cookie), other.workspaceId)).toBeNull();
      expect(await t.auth.resolveActor(withCookie(cookie), 'not-a-uuid')).toBeNull();
    });
  });

  it('an upper-case workspace id → null', async () => {
    await withTempDatabase(async (db) => {
      const email = `member-${unique()}@example.test`;
      const f = await createWorkspaceFixture(db.orm, { email: { member: email } });
      const t = createAuthTestApp(db);
      const { cookie } = await t.signIn(email);

      expect(await t.auth.resolveActor(withCookie(cookie), f.workspaceId)).not.toBeNull();
      expect(await t.auth.resolveActor(withCookie(cookie), f.workspaceId.toUpperCase())).toBeNull();
    });
  });

  it('no cookie, garbage cookie → null', async () => {
    await withTempDatabase(async (db) => {
      const f = await createWorkspaceFixture(db.orm);
      const t = createAuthTestApp(db);

      expect(await t.auth.resolveActor(withCookie(), f.workspaceId)).toBeNull();
      expect(await t.auth.resolveActor(withCookie('sid=garbage'), f.workspaceId)).toBeNull();
      expect(
        await t.auth.resolveActor(withCookie(`sid=${'A'.repeat(43)}`), f.workspaceId),
      ).toBeNull();
    });
  });

  it('revoked → null', async () => {
    await withTempDatabase(async (db) => {
      const email = `member-${unique()}@example.test`;
      const f = await createWorkspaceFixture(db.orm, { email: { member: email } });
      const t = createAuthTestApp(db);
      const { cookie } = await t.signIn(email);
      await db.orm.update(session).set({ revokedAt: new Date() });

      expect(await t.auth.resolveActor(withCookie(cookie), f.workspaceId)).toBeNull();
    });
  });

  it('expired → null', async () => {
    await withTempDatabase(async (db) => {
      const email = `member-${unique()}@example.test`;
      const f = await createWorkspaceFixture(db.orm, { email: { member: email } });
      const t = createAuthTestApp(db);
      const startedAt = t.clock.current.getTime();
      const { cookie } = await t.signIn(email);

      t.clock.current = new Date(startedAt + 29 * DAY);
      expect(await t.auth.resolveActor(withCookie(cookie), f.workspaceId)).not.toBeNull();
      // That use slid the expiry to day 59: day 60 is past it.
      t.clock.current = new Date(startedAt + 60 * DAY);
      expect(await t.auth.resolveActor(withCookie(cookie), f.workspaceId)).toBeNull();
    });
  });

  it('deactivated → null', async () => {
    await withTempDatabase(async (db) => {
      const email = `member-${unique()}@example.test`;
      const f = await createWorkspaceFixture(db.orm, { email: { member: email } });
      const t = createAuthTestApp(db);
      const { cookie } = await t.signIn(email);
      await db.orm
        .update(member)
        .set({ deactivatedAt: new Date() })
        .where(eq(member.id, f.members.member.id));

      expect(await t.auth.resolveActor(withCookie(cookie), f.workspaceId)).toBeNull();
    });
  });

  it('touch: within the hour nothing changes; after one hour last_seen_at and expires_at move', async () => {
    await withTempDatabase(async (db) => {
      const email = `member-${unique()}@example.test`;
      const f = await createWorkspaceFixture(db.orm, { email: { member: email } });
      const t = createAuthTestApp(db);
      const startedAt = t.clock.current.getTime();
      const { cookie } = await t.signIn(email);
      const read = async () => {
        const [row] = await db.orm.select().from(session);
        return row;
      };

      t.clock.current = new Date(startedAt + 59 * MINUTE);
      await t.auth.resolveActor(withCookie(cookie), f.workspaceId);
      const early = await read();
      t.clock.current = new Date(startedAt + HOUR + MINUTE);
      await t.auth.resolveActor(withCookie(cookie), f.workspaceId);
      const later = await read();

      expect(early?.lastSeenAt.getTime()).toBe(startedAt);
      expect(early?.expiresAt.getTime()).toBe(startedAt + 30 * DAY);
      expect(later?.lastSeenAt.getTime()).toBe(startedAt + HOUR + MINUTE);
      expect(later?.expiresAt.getTime()).toBe(startedAt + HOUR + MINUTE + 30 * DAY);
    });
  });

  it('touch after 1 hour extends expires_at, capped at created_at + 90 days', async () => {
    await withTempDatabase(async (db) => {
      const email = `member-${unique()}@example.test`;
      const f = await createWorkspaceFixture(db.orm, { email: { member: email } });
      const t = createAuthTestApp(db);
      const startedAt = t.clock.current.getTime();
      const { cookie } = await t.signIn(email);

      for (const day of [29, 58, 87]) {
        t.clock.current = new Date(startedAt + day * DAY);
        expect(await t.auth.resolveActor(withCookie(cookie), f.workspaceId)).not.toBeNull();
      }

      const [row] = await db.orm.select().from(session);
      expect(row?.expiresAt.getTime()).toBe(startedAt + 90 * DAY);

      t.clock.current = new Date(startedAt + 90 * DAY + MINUTE);
      expect(await t.auth.resolveActor(withCookie(cookie), f.workspaceId)).toBeNull();
    });
  });
});

describe.skipIf(!databaseUrl)('SessionResolver.touchedExpiry', () => {
  it('is the new expiry of the row when resolveActor slid it, and undefined when it did not', async () => {
    await withTempDatabase(async (db) => {
      const email = `member-${unique()}@example.test`;
      const f = await createWorkspaceFixture(db.orm, { email: { member: email } });
      const t = createAuthTestApp(db);
      const startedAt = t.clock.current.getTime();
      const { cookie } = await t.signIn(email);

      // Under an hour: the row is not rewritten, so there is no new expiry to report.
      t.clock.current = new Date(startedAt + 59 * MINUTE);
      const early = withCookie(cookie);
      expect(await t.auth.resolveActor(early, f.workspaceId)).not.toBeNull();
      expect(t.auth.touchedExpiry(early)).toBeUndefined();

      // Over an hour: the row is rewritten and the reported expiry is exactly the stored one.
      t.clock.current = new Date(startedAt + HOUR + MINUTE);
      const later = withCookie(cookie);
      expect(await t.auth.resolveActor(later, f.workspaceId)).not.toBeNull();
      const [row] = await db.orm.select().from(session);
      expect(t.auth.touchedExpiry(later)?.getTime()).toBe(startedAt + HOUR + MINUTE + 30 * DAY);
      expect(t.auth.touchedExpiry(later)?.getTime()).toBe(row?.expiresAt.getTime());
    });
  });

  it('is remembered per request object, not per cookie', async () => {
    await withTempDatabase(async (db) => {
      const email = `member-${unique()}@example.test`;
      const f = await createWorkspaceFixture(db.orm, { email: { member: email } });
      const t = createAuthTestApp(db);
      const { cookie } = await t.signIn(email);
      t.clock.current = new Date(t.clock.current.getTime() + 2 * HOUR);

      const touching = withCookie(cookie);
      await t.auth.resolveActor(touching, f.workspaceId);
      const sameCookieOtherRequest = withCookie(cookie);
      await t.auth.resolveActor(sameCookieOtherRequest, f.workspaceId);

      expect(t.auth.touchedExpiry(touching)).toBeInstanceOf(Date);
      // The second request found a row touched a moment ago: nothing to refresh for it.
      expect(t.auth.touchedExpiry(sameCookieOtherRequest)).toBeUndefined();
      expect(t.auth.touchedExpiry(withCookie(cookie))).toBeUndefined();
    });
  });

  it('is undefined when no actor was resolved (no cookie, other workspace, deactivated member)', async () => {
    await withTempDatabase(async (db) => {
      const email = `member-${unique()}@example.test`;
      const f = await createWorkspaceFixture(db.orm, { email: { member: email } });
      const other = await createWorkspaceFixture(db.orm);
      const t = createAuthTestApp(db);
      const { cookie } = await t.signIn(email);
      t.clock.current = new Date(t.clock.current.getTime() + 2 * HOUR);

      const noCookie = withCookie();
      const wrongWorkspace = withCookie(cookie);
      await t.auth.resolveActor(noCookie, f.workspaceId);
      await t.auth.resolveActor(wrongWorkspace, other.workspaceId);
      await db.orm
        .update(member)
        .set({ deactivatedAt: new Date() })
        .where(eq(member.id, f.members.member.id));
      const deactivated = withCookie(cookie);
      await t.auth.resolveActor(deactivated, f.workspaceId);

      expect(t.auth.touchedExpiry(noCookie)).toBeUndefined();
      expect(t.auth.touchedExpiry(wrongWorkspace)).toBeUndefined();
      expect(t.auth.touchedExpiry(deactivated)).toBeUndefined();
    });
  });

  it('never goes past created_at + 90 days', async () => {
    await withTempDatabase(async (db) => {
      const email = `member-${unique()}@example.test`;
      const f = await createWorkspaceFixture(db.orm, { email: { member: email } });
      const t = createAuthTestApp(db);
      const startedAt = t.clock.current.getTime();
      const { cookie } = await t.signIn(email);
      for (const day of [25, 50, 75]) {
        t.clock.current = new Date(startedAt + day * DAY);
        await t.auth.resolveActor(withCookie(cookie), f.workspaceId);
      }

      t.clock.current = new Date(startedAt + 89 * DAY);
      const request = withCookie(cookie);
      await t.auth.resolveActor(request, f.workspaceId);

      expect(t.auth.touchedExpiry(request)?.getTime()).toBe(startedAt + 90 * DAY);
    });
  });
});
