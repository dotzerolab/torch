import { member } from '@torch/shared/db/schema';
import { eq, sql } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { createWorkspaceFixture, withTempDatabase } from '../test/fixtures.ts';
import { currentTxid } from './txid.ts';

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  console.warn('[txid.test] SKIPPED the txid integration test: DATABASE_URL is not set.');
}

describe.skipIf(!databaseUrl)('currentTxid (Postgres)', () => {
  it('is a number equal to the xmin of a row written in the same transaction', async () => {
    await withTempDatabase(async (db) => {
      const a = await createWorkspaceFixture(db.orm);

      const { txid, xmin } = await db.orm.transaction(async (tx) => {
        await tx.update(member).set({ name: 'Renamed' }).where(eq(member.id, a.members.member.id));
        const txid = await currentTxid(tx);
        const { rows } = await tx.execute<{ xmin: string }>(
          sql`select xmin::text as xmin from member where id = ${a.members.member.id}`,
        );
        return { txid, xmin: Number(rows[0]?.xmin) };
      });

      expect(typeof txid).toBe('number');
      expect(Number.isInteger(txid)).toBe(true);
      expect(txid).toBe(xmin);
    });
  });

  it('differs between two transactions', async () => {
    await withTempDatabase(async (db) => {
      const a = await createWorkspaceFixture(db.orm);
      const write = () =>
        db.orm.transaction(async (tx) => {
          await tx.update(member).set({ name: 'Again' }).where(eq(member.id, a.members.admin.id));
          return currentTxid(tx);
        });

      const first = await write();
      const second = await write();

      expect(second).toBeGreaterThan(first);
    });
  });
});
