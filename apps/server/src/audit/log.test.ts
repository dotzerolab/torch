import { auditLog } from '@torch/shared/db/schema';
import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { createWorkspaceFixture, withTempDatabase } from '../test/fixtures.ts';
import { assertScalarMetadata, recordAudit } from './log.ts';

describe('assertScalarMetadata', () => {
  it('accepts strings, finite numbers, booleans and null', () => {
    expect(() =>
      assertScalarMetadata({ from: 'member', to: 'admin', count: 3, flag: false, none: null }),
    ).not.toThrow();
    expect(() => assertScalarMetadata({})).not.toThrow();
  });

  it('rejects an object, an array, undefined and a non-finite number', () => {
    for (const bad of [{ nested: 1 }, ['a'], undefined, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => assertScalarMetadata({ key: bad as never }), String(bad)).toThrow(
        /audit metadata/,
      );
    }
  });

  it('rejects a string too long to be an id, a role or a short label (no free text in the log)', () => {
    expect(() => assertScalarMetadata({ id: 'x'.repeat(64) })).not.toThrow();
    expect(() => assertScalarMetadata({ note: 'x'.repeat(65) })).toThrow(/audit metadata/);
  });
});

// Integration: needs the dev compose Postgres. Skipped, loudly, when DATABASE_URL is not set.
const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  console.warn('[audit/log.test] SKIPPED the audit integration tests: DATABASE_URL is not set.');
}

describe.skipIf(!databaseUrl)('recordAudit (Postgres)', () => {
  it('stores the entry with scalar metadata inside the caller transaction', async () => {
    await withTempDatabase(async (db) => {
      const a = await createWorkspaceFixture(db.orm);

      await db.orm.transaction((tx) =>
        recordAudit(tx, {
          workspaceId: a.workspaceId,
          actorMemberId: a.members.owner.id,
          action: 'member.role_changed',
          targetType: 'member',
          targetId: a.members.member.id,
          metadata: { from: 'member', to: 'admin', teams: 2, notified: true, reason: null },
        }),
      );

      const rows = await db.orm
        .select()
        .from(auditLog)
        .where(eq(auditLog.workspaceId, a.workspaceId));
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        actorMemberId: a.members.owner.id,
        action: 'member.role_changed',
        targetType: 'member',
        targetId: a.members.member.id,
        metadata: { from: 'member', to: 'admin', teams: 2, notified: true, reason: null },
      });
      expect(rows[0]?.createdAt).toBeInstanceOf(Date);
    });
  });

  it('an entry without actor, target or metadata is fine (system action)', async () => {
    await withTempDatabase(async (db) => {
      const a = await createWorkspaceFixture(db.orm);

      await db.orm.transaction((tx) =>
        recordAudit(tx, {
          workspaceId: a.workspaceId,
          actorMemberId: null,
          action: 'invite.accepted',
          targetType: 'invite',
        }),
      );

      const [row] = await db.orm
        .select()
        .from(auditLog)
        .where(eq(auditLog.workspaceId, a.workspaceId));
      expect(row).toMatchObject({ actorMemberId: null, targetId: null, metadata: {} });
    });
  });

  it('rejects an object value before touching the database', async () => {
    await withTempDatabase(async (db) => {
      const a = await createWorkspaceFixture(db.orm);

      const attempt = db.orm.transaction((tx) =>
        recordAudit(tx, {
          workspaceId: a.workspaceId,
          actorMemberId: a.members.owner.id,
          action: 'team.updated',
          targetType: 'team',
          // @ts-expect-error metadata values are scalars: an object does not type-check
          metadata: { changes: { name: 'x' } },
        }),
      );

      await expect(attempt).rejects.toThrow(/audit metadata/);
      const rows = await db.orm
        .select()
        .from(auditLog)
        .where(eq(auditLog.workspaceId, a.workspaceId));
      expect(rows).toEqual([]);
    });
  });

  it('is part of the caller transaction: a rollback removes the entry', async () => {
    await withTempDatabase(async (db) => {
      const a = await createWorkspaceFixture(db.orm);

      await expect(
        db.orm.transaction(async (tx) => {
          await recordAudit(tx, {
            workspaceId: a.workspaceId,
            actorMemberId: a.members.owner.id,
            action: 'team.created',
            targetType: 'team',
          });
          throw new Error('the mutation failed after the audit write');
        }),
      ).rejects.toThrow('the mutation failed');

      const rows = await db.orm
        .select()
        .from(auditLog)
        .where(eq(auditLog.workspaceId, a.workspaceId));
      expect(rows).toEqual([]);
    });
  });
});
