// Concurrency tests for the row locks of the admin services. Postgres locks are what keeps two admin actions on one
// member from deadlocking each other and what keeps a deactivation ahead of a sign-in, so these tests run real
// transactions against each other. The window a race needs is only a few milliseconds wide, so each test widens it
// on purpose: a trigger on the table that the FIRST call inserts into sleeps before the row goes in (the foreign-key
// checks run after it), the test waits until that call is asleep, starts the SECOND call, and only then lets the
// first one go on. With the wrong lock modes this reproduces the exact cycle every time (`40P01`, "deadlock
// detected"); with the right ones the second call simply waits for the first.
import { member, session, teamMember } from '@torch/shared/db/schema';
import { and, eq, isNull } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { consumeMagicLink, issueMagicLink } from '../auth/magic-link.ts';
import type { Db } from '../db.ts';
import { acceptInvite, createInvite } from '../invites/service.ts';
import { changeMemberRole, setMemberActive } from '../members/service.ts';
import { addTeamMember, removeTeamMember } from '../teams/service.ts';
import type { ServiceResult } from '../util/result.ts';
import { actorOf, auditRows, successOf } from './admin-helpers.ts';
import { addMember, createWorkspaceFixture, pgErrorCode, withTempDatabase } from './fixtures.ts';

const databaseUrl = process.env.DATABASE_URL;

// Integration: needs the dev compose Postgres (see db.test.ts). Skipped, loudly, when DATABASE_URL is not set.
if (!databaseUrl) {
  console.warn(
    '[test/lock-races.test] SKIPPED the lock race tests: DATABASE_URL is not set. ' +
      'Start `docker compose -f docker-compose.dev.yml up -d --wait postgres` and set DATABASE_URL (see .env.example).',
  );
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Makes every INSERT statement into `table` sleep half a second before it touches the table (and its foreign keys). */
async function slowInserts(db: Db, table: 'audit_log' | 'team_member' | 'session'): Promise<void> {
  await db.pool.query(
    `create function slow_insert() returns trigger language plpgsql as
     $$ begin perform pg_sleep(0.5); return null; end $$`,
  );
  await db.pool.query(
    `create trigger slow_insert before insert on ${table} for each statement execute function slow_insert()`,
  );
}

/** Resolves once some backend of this database is inside `pg_sleep` (the slowed insert), i.e. the first call is mid-way. */
async function waitUntilAsleep(db: Db): Promise<void> {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    const { rowCount } = await db.pool.query(
      `select 1 from pg_stat_activity where datname = current_database() and wait_event = 'PgSleep'`,
    );
    if (rowCount) return;
    await sleep(10);
  }
  throw new Error('the first call never reached the slowed insert');
}

/** "ok", the refusal code, or `threw <pg code>` for a call that rejected (a deadlock victim). */
function outcome(settled: PromiseSettledResult<ServiceResult<unknown>>): string {
  if (settled.status === 'rejected') {
    return `threw ${pgErrorCode(settled.reason) ?? String(settled.reason)}`;
  }
  return settled.value.ok ? 'ok' : settled.value.code;
}

/** Starts `first`, waits until it sleeps inside the slowed insert, then starts `second`; both run to the end. */
async function race(
  db: Db,
  first: () => Promise<ServiceResult<unknown>>,
  second: () => Promise<ServiceResult<unknown>>,
): Promise<string[]> {
  const running = first();
  // A rejection of `first` before the second call starts must not be an unhandled rejection.
  running.catch(() => undefined);
  await waitUntilAsleep(db);
  const other = second();
  const settled = await Promise.allSettled([running, other]);
  return settled.map(outcome);
}

describe.skipIf(!databaseUrl)('row locks: admin actions on one member never deadlock', () => {
  it('addTeamMember against setMemberActive(false) on the same member', async () => {
    await withTempDatabase(async (db) => {
      const f = await createWorkspaceFixture(db.orm);
      const target = await addMember(db.orm, f.workspaceId, 'member');
      const admin = await actorOf(db, f.workspaceId, f.members.admin.id);
      const owner = await actorOf(db, f.workspaceId, f.members.owner.id);
      await slowInserts(db, 'audit_log');

      const outcomes = await race(
        db,
        () => addTeamMember(db.orm, admin, f.teams.eng.id, target.id),
        () => setMemberActive(db.orm, owner, target.id, false),
      );

      expect(outcomes).toEqual(['ok', 'ok']);
    });
  });

  it('addTeamMember against changeMemberRole on the same member', async () => {
    await withTempDatabase(async (db) => {
      const f = await createWorkspaceFixture(db.orm);
      const target = await addMember(db.orm, f.workspaceId, 'member');
      const admin = await actorOf(db, f.workspaceId, f.members.admin.id);
      const owner = await actorOf(db, f.workspaceId, f.members.owner.id);
      await slowInserts(db, 'audit_log');

      const outcomes = await race(
        db,
        () => addTeamMember(db.orm, admin, f.teams.eng.id, target.id),
        () => changeMemberRole(db.orm, owner, target.id, 'admin'),
      );

      expect(outcomes).toEqual(['ok', 'ok']);
    });
  });

  it('removeTeamMember against an invite accepted by the same (deactivated) member', async () => {
    await withTempDatabase(async (db) => {
      const f = await createWorkspaceFixture(db.orm);
      const returning = await addMember(db.orm, f.workspaceId, 'member', {
        teamIds: [f.teams.eng.id],
      });
      await db.orm
        .update(member)
        .set({ deactivatedAt: new Date() })
        .where(eq(member.id, returning.id));
      const owner = await actorOf(db, f.workspaceId, f.members.owner.id);
      const admin = await actorOf(db, f.workspaceId, f.members.admin.id);
      const now = new Date();
      const created = successOf(
        await createInvite(
          db.orm,
          owner,
          { email: returning.email, role: 'member', teamIds: [f.teams.eng.id] },
          { now },
        ),
      );
      await slowInserts(db, 'team_member');

      const outcomes = await race(
        db,
        () =>
          acceptInvite(db.orm, { token: created.token, name: 'Back Again', now, userAgent: null }),
        () => removeTeamMember(db.orm, admin, f.teams.eng.id, returning.id),
      );

      expect(outcomes).toEqual(['ok', 'ok']);
      // The invite replaced the memberships while the removal waited: the member is back in ENG and the removal
      // that found nothing to delete left no audit entry.
      const [stored] = await db.orm.select().from(member).where(eq(member.id, returning.id));
      expect(stored?.deactivatedAt).toBeNull();
      const rows = await db.orm
        .select({ teamId: teamMember.teamId })
        .from(teamMember)
        .where(eq(teamMember.memberId, returning.id));
      expect(rows).toEqual([{ teamId: f.teams.eng.id }]);
      expect((await auditRows(db, f.workspaceId)).map((row) => row.action)).not.toContain(
        'team.member_removed',
      );
    });
  });

  it('the same pairs under real timing (no widening): never a thrown error', async () => {
    await withTempDatabase(async (db) => {
      for (let round = 0; round < 8; round++) {
        const f = await createWorkspaceFixture(db.orm);
        const admin = await actorOf(db, f.workspaceId, f.members.admin.id);
        const owner = await actorOf(db, f.workspaceId, f.members.owner.id);
        const one = await addMember(db.orm, f.workspaceId, 'member');
        const two = await addMember(db.orm, f.workspaceId, 'member');

        const settled = await Promise.allSettled([
          setMemberActive(db.orm, owner, one.id, false),
          addTeamMember(db.orm, admin, f.teams.eng.id, one.id),
          changeMemberRole(db.orm, owner, two.id, 'admin'),
          addTeamMember(db.orm, admin, f.teams.eng.id, two.id),
        ]);

        expect(settled.map(outcome), `round ${round}`).not.toContainEqual(
          expect.stringMatching(/^threw/),
        );
      }
    });
  });
});

describe.skipIf(!databaseUrl)('row locks: a sign-in never outlives a deactivation', () => {
  const liveSessions = (db: Db, memberId: string) =>
    db.orm
      .select({ id: session.id })
      .from(session)
      .where(and(eq(session.memberId, memberId), isNull(session.revokedAt)));

  it('a sign-in link consumed while the member is being deactivated leaves no live session', async () => {
    await withTempDatabase(async (db) => {
      const f = await createWorkspaceFixture(db.orm);
      const target = await addMember(db.orm, f.workspaceId, 'member');
      const owner = await actorOf(db, f.workspaceId, f.members.owner.id);
      const link = await issueMagicLink(db.orm, { email: target.email, now: new Date() });
      if (!link) throw new Error('no sign-in link was issued');
      await slowInserts(db, 'session');

      const running = consumeMagicLink(db.orm, {
        token: link.token,
        now: new Date(),
        userAgent: null,
      });
      running.catch(() => undefined);
      await waitUntilAsleep(db);
      const deactivated = await setMemberActive(db.orm, owner, target.id, false);
      await running;

      expect(deactivated.ok).toBe(true);
      const [stored] = await db.orm.select().from(member).where(eq(member.id, target.id));
      expect(stored?.deactivatedAt).not.toBeNull();
      expect(await liveSessions(db, target.id)).toEqual([]);
    });
  });

  it('an invite accepted while the same address is being deactivated elsewhere leaves no live session there', async () => {
    await withTempDatabase(async (db) => {
      const home = await createWorkspaceFixture(db.orm);
      const other = await createWorkspaceFixture(db.orm);
      const email = `both-${Date.now()}@example.test`;
      const elsewhere = await addMember(db.orm, other.workspaceId, 'member', { email });
      const homeOwner = await actorOf(db, home.workspaceId, home.members.owner.id);
      const otherOwner = await actorOf(db, other.workspaceId, other.members.owner.id);
      const now = new Date();
      const created = successOf(
        await createInvite(db.orm, homeOwner, { email, role: 'member', teamIds: [] }, { now }),
      );
      await slowInserts(db, 'session');

      const running = acceptInvite(db.orm, {
        token: created.token,
        name: 'Two Places',
        now,
        userAgent: null,
      });
      running.catch(() => undefined);
      await waitUntilAsleep(db);
      const deactivated = await setMemberActive(db.orm, otherOwner, elsewhere.id, false);
      await running;

      expect(deactivated.ok).toBe(true);
      expect(await liveSessions(db, elsewhere.id)).toEqual([]);
    });
  });
});
