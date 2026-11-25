import { randomBytes } from 'node:crypto';
import {
  attachment,
  idempotencyKey,
  invite,
  inviteTeam,
  loginToken,
  session,
} from '@torch/shared/db/schema';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Orm } from '../db.ts';
import { createFakeStorage } from '../files/fake-storage.ts';
import {
  createWorkspaceFixture,
  type WorkspaceFixture,
  withTempDatabase,
} from '../test/fixtures.ts';
import { cleanupExpiredRows, startCleanupSchedule } from './cleanup.ts';

const databaseUrl = process.env.DATABASE_URL;

// Integration: needs the dev compose Postgres (see db.test.ts). Skipped, loudly, when DATABASE_URL is not set.
if (!databaseUrl) {
  console.warn(
    '[db/cleanup.test] SKIPPED the cleanup integration tests: DATABASE_URL is not set. ' +
      'Start `docker compose -f docker-compose.dev.yml up -d --wait postgres` and set DATABASE_URL (see .env.example).',
  );
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;
const NOW = new Date('2026-11-14T12:00:00.000Z');
const ago = (ms: number) => new Date(NOW.getTime() - ms);
const later = (ms: number) => new Date(NOW.getTime() + ms);
const hash = () => randomBytes(32).toString('hex');
const unique = () => randomBytes(4).toString('hex');

/** Login tokens, one per label: the label says which side of the one-day threshold the row is on. */
async function insertLoginTokens(orm: Orm, f: WorkspaceFixture) {
  const base = {
    workspaceId: f.workspaceId,
    memberId: f.members.owner.id,
    createdAt: ago(3 * DAY),
  };
  const rows = {
    expiredLongAgo: { expiresAt: ago(DAY + MINUTE) },
    usedAndExpiredLongAgo: { expiresAt: ago(2 * DAY), usedAt: ago(2 * DAY) },
    expiredRecently: { expiresAt: ago(DAY - MINUTE) },
    expiredAMomentAgo: { expiresAt: ago(MINUTE) },
    stillValid: { expiresAt: later(10 * MINUTE) },
    usedButNotExpired: { expiresAt: later(MINUTE), usedAt: ago(MINUTE) },
  };
  const ids: Record<string, string> = {};
  for (const [label, extra] of Object.entries(rows)) {
    const [row] = await orm
      .insert(loginToken)
      .values({ ...base, tokenHash: hash(), ...extra })
      .returning({ id: loginToken.id });
    ids[label] = (row as { id: string }).id;
  }
  return ids;
}

async function insertSessions(orm: Orm, f: WorkspaceFixture) {
  const base = {
    workspaceId: f.workspaceId,
    memberId: f.members.member.id,
    createdAt: ago(60 * DAY),
  };
  const rows = {
    expiredLongAgo: { expiresAt: ago(7 * DAY + MINUTE) },
    expiredRecently: { expiresAt: ago(7 * DAY - MINUTE) },
    revokedLongAgo: { expiresAt: later(20 * DAY), revokedAt: ago(7 * DAY + MINUTE) },
    revokedRecently: { expiresAt: later(20 * DAY), revokedAt: ago(7 * DAY - MINUTE) },
    revokedAndExpiredLongAgo: { expiresAt: ago(30 * DAY), revokedAt: ago(40 * DAY) },
    live: { expiresAt: later(20 * DAY) },
  };
  const ids: Record<string, string> = {};
  for (const [label, extra] of Object.entries(rows)) {
    const [row] = await orm
      .insert(session)
      .values({ ...base, tokenHash: hash(), lastSeenAt: ago(DAY), ...extra })
      .returning({ id: session.id });
    ids[label] = (row as { id: string }).id;
  }
  return ids;
}

async function insertInvites(orm: Orm, f: WorkspaceFixture) {
  const base = {
    workspaceId: f.workspaceId,
    role: 'member' as const,
    invitedBy: f.members.owner.id,
    createdAt: ago(90 * DAY),
  };
  const rows = {
    expiredLongAgo: { expiresAt: ago(30 * DAY + MINUTE) },
    expiredRecently: { expiresAt: ago(30 * DAY - MINUTE) },
    revokedLongAgo: { expiresAt: later(5 * DAY), revokedAt: ago(30 * DAY + MINUTE) },
    revokedRecently: { expiresAt: later(5 * DAY), revokedAt: ago(30 * DAY - MINUTE) },
    pending: { expiresAt: later(5 * DAY) },
    // Accepted long ago and expired long ago: kept for the audit trail whatever its age.
    acceptedLongAgo: {
      expiresAt: ago(80 * DAY),
      acceptedAt: ago(85 * DAY),
      acceptedMemberId: f.members.guest.id,
    },
  };
  const ids: Record<string, string> = {};
  for (const [label, extra] of Object.entries(rows)) {
    const [row] = await orm
      .insert(invite)
      .values({ ...base, email: `invitee-${unique()}@example.test`, tokenHash: hash(), ...extra })
      .returning({ id: invite.id });
    const id = (row as { id: string }).id;
    ids[label] = id;
    // Every invite names a team, to show the rows of a deleted invite go with it.
    await orm
      .insert(inviteTeam)
      .values({ workspaceId: f.workspaceId, inviteId: id, teamId: f.teams.eng.id });
  }
  return ids;
}

const idsOf = async (orm: Orm, table: typeof loginToken | typeof session | typeof invite) =>
  new Set((await orm.select({ id: table.id }).from(table)).map((row) => row.id));

const survivors = (ids: Record<string, string>, present: Set<string>) =>
  Object.entries(ids)
    .filter(([, id]) => present.has(id))
    .map(([label]) => label)
    .sort();

describe.skipIf(!databaseUrl)('cleanupExpiredRows', () => {
  it('deletes login tokens expired over a day ago and keeps the rest', async () => {
    await withTempDatabase(async (db) => {
      const f = await createWorkspaceFixture(db.orm);
      const ids = await insertLoginTokens(db.orm, f);

      const result = await cleanupExpiredRows(db.orm, NOW);

      expect(result.loginTokens).toBe(2);
      expect(survivors(ids, await idsOf(db.orm, loginToken))).toEqual([
        'expiredAMomentAgo',
        'expiredRecently',
        'stillValid',
        'usedButNotExpired',
      ]);
    });
  });

  it('deletes sessions expired or revoked over 7 days ago and keeps the rest', async () => {
    await withTempDatabase(async (db) => {
      const f = await createWorkspaceFixture(db.orm);
      const ids = await insertSessions(db.orm, f);

      const result = await cleanupExpiredRows(db.orm, NOW);

      expect(result.sessions).toBe(3);
      expect(survivors(ids, await idsOf(db.orm, session))).toEqual([
        'expiredRecently',
        'live',
        'revokedRecently',
      ]);
    });
  });

  it('deletes unaccepted invites expired or revoked over 30 days ago, with their teams; accepted ones stay', async () => {
    await withTempDatabase(async (db) => {
      const f = await createWorkspaceFixture(db.orm);
      const ids = await insertInvites(db.orm, f);

      const result = await cleanupExpiredRows(db.orm, NOW);

      expect(result.invites).toBe(2);
      expect(survivors(ids, await idsOf(db.orm, invite))).toEqual([
        'acceptedLongAgo',
        'expiredRecently',
        'pending',
        'revokedRecently',
      ]);
      const teamRows = await db.orm.select({ inviteId: inviteTeam.inviteId }).from(inviteTeam);
      expect(teamRows.map((row) => row.inviteId).sort()).toEqual(
        ['acceptedLongAgo', 'expiredRecently', 'pending', 'revokedRecently']
          .map((label) => ids[label] as string)
          .sort(),
      );
    });
  });

  it('a second run deletes nothing, and rows of every workspace are covered', async () => {
    await withTempDatabase(async (db) => {
      const a = await createWorkspaceFixture(db.orm);
      const b = await createWorkspaceFixture(db.orm);
      await insertLoginTokens(db.orm, a);
      await insertLoginTokens(db.orm, b);
      await insertSessions(db.orm, a);
      await insertSessions(db.orm, b);
      await insertInvites(db.orm, a);
      await insertInvites(db.orm, b);

      const first = await cleanupExpiredRows(db.orm, NOW);
      const second = await cleanupExpiredRows(db.orm, NOW);

      expect(first).toEqual({
        loginTokens: 4,
        sessions: 6,
        invites: 4,
        idempotencyKeys: 0,
        pendingAttachments: 0,
      });
      expect(second).toEqual({
        loginTokens: 0,
        sessions: 0,
        invites: 0,
        idempotencyKeys: 0,
        pendingAttachments: 0,
      });
    });
  });

  it('is relative to the clock it is given: a week later, more rows qualify', async () => {
    await withTempDatabase(async (db) => {
      const f = await createWorkspaceFixture(db.orm);
      await insertSessions(db.orm, f);
      await cleanupExpiredRows(db.orm, NOW);

      const later_ = await cleanupExpiredRows(db.orm, new Date(NOW.getTime() + 8 * DAY));

      // expiredRecently and revokedRecently are now over 7 days old; `live` (20 days left) stays.
      expect(later_.sessions).toBe(2);
      expect(await db.orm.select().from(session)).toHaveLength(1);
    });
  });

  it('on an empty database it deletes nothing and does not fail', async () => {
    await withTempDatabase(async (db) => {
      expect(await cleanupExpiredRows(db.orm, NOW)).toEqual({
        loginTokens: 0,
        sessions: 0,
        invites: 0,
        idempotencyKeys: 0,
        pendingAttachments: 0,
      });
    });
  });

  describe('uploads that never finished', () => {
    const HOUR = 60 * MINUTE;
    async function rowsOf(db: { orm: Orm }, f: WorkspaceFixture) {
      const issueRow = f.issues.eng[0];
      if (!issueRow) throw new Error('fixture has no ENG issue');
      const make = async (label: string, over: Partial<typeof attachment.$inferInsert>) => {
        const [row] = await db.orm
          .insert(attachment)
          .values({
            workspaceId: f.workspaceId,
            teamId: f.teams.eng.id,
            issueId: issueRow.id,
            uploaderId: f.members.member.id,
            fileName: `${label}.png`,
            contentType: 'image/png',
            sizeBytes: 10,
            storageKey: `workspaces/${f.workspaceId}/attachments/${crypto.randomUUID()}`,
            status: 'pending',
            ...over,
          })
          .returning();
        if (!row) throw new Error('attachment insert returned no row');
        return row;
      };
      return {
        stale: await make('stale', { createdAt: ago(25 * HOUR) }),
        fresh: await make('fresh', { createdAt: ago(23 * HOUR) }),
        ready: await make('ready', {
          createdAt: ago(5 * DAY),
          status: 'ready',
          readyAt: ago(5 * DAY),
        }),
        queued: await make('queued', { createdAt: new Date(0) }),
      };
    }

    it('removes pending uploads older than 24 hours and their objects, and keeps newer and ready ones', async () => {
      await withTempDatabase(async (db) => {
        const f = await createWorkspaceFixture(db.orm);
        const storage = createFakeStorage();
        const rows = await rowsOf(db, f);
        for (const row of Object.values(rows)) {
          storage.put(row.storageKey, new Uint8Array([1]), 'image/png');
        }

        const first = await cleanupExpiredRows(db.orm, NOW, storage);
        const second = await cleanupExpiredRows(db.orm, NOW, storage);

        expect(first.pendingAttachments).toBe(2);
        expect(second.pendingAttachments).toBe(0);
        const left = await db.orm.select({ id: attachment.id }).from(attachment);
        expect(left.map((row) => row.id).sort()).toEqual([rows.fresh.id, rows.ready.id].sort());
        expect(storage.keys().sort()).toEqual(
          [rows.fresh.storageKey, rows.ready.storageKey].sort(),
        );
      });
    });

    it('keeps the row of an object it could not remove, and tries again on the next run', async () => {
      await withTempDatabase(async (db) => {
        const f = await createWorkspaceFixture(db.orm);
        const storage = createFakeStorage();
        const rows = await rowsOf(db, f);
        storage.put(rows.queued.storageKey, new Uint8Array([1]), 'image/png');
        storage.faults.remove = true;

        const down = await cleanupExpiredRows(db.orm, NOW, storage);
        storage.faults.remove = false;
        const up = await cleanupExpiredRows(db.orm, NOW, storage);

        expect(down.pendingAttachments).toBe(0);
        expect(storage.keys()).toEqual([]);
        expect(up.pendingAttachments).toBe(2);
        expect(await db.orm.select().from(attachment)).toHaveLength(2);
      });
    });

    it('leaves attachment rows alone when no storage is given', async () => {
      await withTempDatabase(async (db) => {
        const f = await createWorkspaceFixture(db.orm);
        await rowsOf(db, f);

        const counts = await cleanupExpiredRows(db.orm, NOW);

        expect(counts.pendingAttachments).toBe(0);
        expect(await db.orm.select().from(attachment)).toHaveLength(4);
      });
    });
  });

  it('deletes idempotency keys older than 24 hours and keeps the newer ones', async () => {
    await withTempDatabase(async (db) => {
      const f = await createWorkspaceFixture(db.orm);
      const HOUR = 60 * MINUTE;
      const rows = {
        old: 25 * HOUR,
        justOver: 24 * HOUR + MINUTE,
        recent: 23 * HOUR,
        fresh: MINUTE,
      };
      for (const [key, age] of Object.entries(rows)) {
        await db.orm.insert(idempotencyKey).values({
          workspaceId: f.workspaceId,
          actorId: f.members.owner.id,
          key,
          requestHash: hash(),
          status: 201,
          response: {},
          createdAt: ago(age),
        });
      }

      const first = await cleanupExpiredRows(db.orm, NOW);
      const second = await cleanupExpiredRows(db.orm, NOW);

      expect(first.idempotencyKeys).toBe(2);
      expect(second.idempotencyKeys).toBe(0);
      const left = await db.orm.select({ key: idempotencyKey.key }).from(idempotencyKey);
      expect(left.map((row) => row.key).sort()).toEqual(['fresh', 'recent']);
    });
  });
});

describe.skipIf(!databaseUrl)('startCleanupSchedule', () => {
  it('runs at once and then every 6 hours, logging counts only', async () => {
    await withTempDatabase(async (db) => {
      const f = await createWorkspaceFixture(db.orm);
      const tokens = await insertLoginTokens(db.orm, f);
      vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
      const logged: string[] = [];

      const stop = startCleanupSchedule(db.orm, {
        now: () => NOW,
        log: (line) => logged.push(line),
      });
      await vi.waitFor(() => expect(logged).toHaveLength(1));
      expect(survivors(tokens, await idsOf(db.orm, loginToken))).not.toContain('expiredLongAgo');
      await db.orm.insert(loginToken).values({
        workspaceId: f.workspaceId,
        memberId: f.members.owner.id,
        tokenHash: hash(),
        createdAt: ago(5 * DAY),
        expiresAt: ago(4 * DAY),
      });
      vi.advanceTimersByTime(6 * 60 * MINUTE - 1);
      expect(logged).toHaveLength(1);
      vi.advanceTimersByTime(1);
      await vi.waitFor(() => expect(logged).toHaveLength(2));
      stop();

      expect(logged[0]).toMatch(/login tokens: 2, sessions: 0, invites: 0/);
      expect(logged[1]).toMatch(/login tokens: 1, sessions: 0, invites: 0/);
      for (const line of logged) expect(line).not.toMatch(/[0-9a-f]{32}|@/);
    });
  });

  it('a failing run is logged by name only and the schedule keeps going', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    const failing = {
      delete: () => {
        throw Object.assign(new Error('relation "login_token" does not exist: select secret'), {
          code: '42P01',
        });
      },
    } as unknown as Orm;
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});

    const stop = startCleanupSchedule(failing, { now: () => NOW, log: () => {} });
    await vi.waitFor(() => expect(errors).toHaveBeenCalledTimes(1));
    vi.advanceTimersByTime(6 * 60 * MINUTE);
    await vi.waitFor(() => expect(errors).toHaveBeenCalledTimes(2));
    stop();

    const output = errors.mock.calls.flat().join(' ');
    expect(output).toContain('42P01');
    expect(output).not.toContain('secret');
    expect(output).not.toContain('login_token');
  });

  it('the schedule does not keep the process alive', () => {
    const interval = vi.spyOn(globalThis, 'setInterval');
    const idle = {
      delete: () => ({ where: () => Promise.resolve({ rowCount: 0 }) }),
    } as unknown as Orm;

    const stop = startCleanupSchedule(idle, { now: () => NOW, log: () => {} });

    const handle = interval.mock.results[0]?.value as NodeJS.Timeout;
    expect(handle.hasRef()).toBe(false);
    stop();
  });
});
