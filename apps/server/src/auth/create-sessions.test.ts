import { member, session } from '@torch/shared/db/schema';
import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { addMember, createWorkspaceFixture } from '../test/fixtures.ts';
import { useSharedDatabase } from '../test/shared-database.ts';
import { createSessionsForMembers, SESSION_TTL_MS } from './sessions.ts';
import { hashToken } from './tokens.ts';

const databaseUrl = process.env.DATABASE_URL;

// Integration: needs the dev compose Postgres (see db.test.ts). Skipped, loudly, when DATABASE_URL is not set.
if (!databaseUrl) {
  console.warn(
    '[auth/create-sessions.test] SKIPPED the session creation tests: DATABASE_URL is not set. ' +
      'Start `docker compose -f docker-compose.dev.yml up -d --wait postgres` and set DATABASE_URL (see .env.example).',
  );
}

describe.skipIf(!databaseUrl)('createSessionsForMembers (Postgres)', () => {
  const getDb = useSharedDatabase();

  it('inserts one row per member behind one token hash and returns the raw token', async () => {
    const db = getDb();
    const a = await createWorkspaceFixture(db.orm);
    const b = await createWorkspaceFixture(db.orm);
    const now = new Date();

    const token = await db.orm.transaction((tx) =>
      createSessionsForMembers(
        tx,
        [
          { workspaceId: a.workspaceId, memberId: a.members.owner.id },
          { workspaceId: b.workspaceId, memberId: b.members.guest.id },
        ],
        { now, userAgent: 'Vitest/1.0' },
      ),
    );

    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const rows = await db.orm
      .select()
      .from(session)
      .where(eq(session.tokenHash, hashToken(token)));
    expect(rows.map((row) => [row.workspaceId, row.memberId]).sort()).toEqual(
      [
        [a.workspaceId, a.members.owner.id],
        [b.workspaceId, b.members.guest.id],
      ].sort(),
    );
    for (const row of rows) {
      expect(row.createdAt.getTime()).toBe(now.getTime());
      expect(row.lastSeenAt.getTime()).toBe(now.getTime());
      expect(row.expiresAt.getTime()).toBe(now.getTime() + SESSION_TTL_MS);
      expect(row.userAgent).toBe('Vitest/1.0');
      expect(row.revokedAt).toBeNull();
    }
    expect(JSON.stringify(rows)).not.toContain(token);
  });

  it('every call makes a new token, and it writes inside the caller transaction (a rollback leaves nothing)', async () => {
    const db = getDb();
    const f = await createWorkspaceFixture(db.orm);
    const added = await addMember(db.orm, f.workspaceId, 'member');
    const now = new Date();
    const target = [{ workspaceId: f.workspaceId, memberId: added.id }];

    const first = await db.orm.transaction((tx) =>
      createSessionsForMembers(tx, target, { now, userAgent: null }),
    );
    const second = await db.orm.transaction((tx) =>
      createSessionsForMembers(tx, target, { now, userAgent: null }),
    );
    let rolledBack = '';
    await db.orm
      .transaction(async (tx) => {
        rolledBack = await createSessionsForMembers(tx, target, { now, userAgent: null });
        throw new Error('abort');
      })
      .catch(() => undefined);

    expect(first).not.toBe(second);
    const kept = await db.orm.select().from(session).where(eq(session.memberId, added.id));
    expect(kept).toHaveLength(2);
    expect(kept.map((row) => row.tokenHash)).not.toContain(hashToken(rolledBack));
    const [stillThere] = await db.orm.select().from(member).where(eq(member.id, added.id));
    expect(stillThere).toBeDefined();
  });
});
