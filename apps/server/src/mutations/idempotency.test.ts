import { idempotencyKey } from '@torch/shared/db/schema';
import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { IssueRefusal } from '../issues/errors.ts';
import { createWorkspaceFixture } from '../test/fixtures.ts';
import { actorOf } from '../test/issue-helpers.ts';
import { useSharedDatabase } from '../test/shared-database.ts';
import { claimIdempotency, storeIdempotent } from './idempotency.ts';

const databaseUrl = process.env.DATABASE_URL;

if (!databaseUrl) {
  console.warn(
    '[mutations/idempotency.test] SKIPPED: DATABASE_URL is not set. ' +
      'Start `docker compose -f docker-compose.dev.yml up -d --wait postgres` and set DATABASE_URL (see .env.example).',
  );
}

describe.skipIf(!databaseUrl)('claimIdempotency and storeIdempotent', () => {
  const getDb = useSharedDatabase();
  const setup = async () => {
    const db = getDb();
    const f = await createWorkspaceFixture(db.orm);
    return { db, f, actor: await actorOf(db, f, 'member'), other: await actorOf(db, f, 'admin') };
  };

  it('claims a new key, then replays the stored answer for the same request', async () => {
    const { db, actor } = await setup();

    const first = await db.orm.transaction(async (tx) => {
      const claim = await claimIdempotency(tx, actor, 'key-1', 'hash-a');
      await storeIdempotent(tx, actor, 'key-1', 201, { commentId: 'c1', txid: 7 });
      return claim;
    });
    const second = await db.orm.transaction((tx) => claimIdempotency(tx, actor, 'key-1', 'hash-a'));

    expect(first).toEqual({ claimed: true });
    expect(second).toEqual({ replay: { status: 201, response: { commentId: 'c1', txid: 7 } } });
  });

  it('the same key with another request hash is 422 idempotency_key_reused', async () => {
    const { db, actor } = await setup();
    await db.orm.transaction(async (tx) => {
      await claimIdempotency(tx, actor, 'key-2', 'hash-a');
      await storeIdempotent(tx, actor, 'key-2', 201, {});
    });

    const attempt = db.orm.transaction((tx) => claimIdempotency(tx, actor, 'key-2', 'hash-b'));

    await expect(attempt).rejects.toBeInstanceOf(IssueRefusal);
    await expect(attempt).rejects.toMatchObject({
      error: { code: 'idempotency_key_reused', status: 422 },
    });
  });

  it('a key belongs to one person: another member can use the same text', async () => {
    const { db, actor, other } = await setup();
    await db.orm.transaction(async (tx) => {
      await claimIdempotency(tx, actor, 'shared-text', 'hash-a');
      await storeIdempotent(tx, actor, 'shared-text', 201, {});
    });

    const claim = await db.orm.transaction((tx) =>
      claimIdempotency(tx, other, 'shared-text', 'hash-b'),
    );

    expect(claim).toEqual({ claimed: true });
  });

  it('a rolled-back claim leaves the key free', async () => {
    const { db, actor } = await setup();

    await expect(
      db.orm.transaction(async (tx) => {
        await claimIdempotency(tx, actor, 'key-3', 'hash-a');
        throw new Error('later step failed');
      }),
    ).rejects.toThrow('later step failed');

    const rows = await db.orm
      .select()
      .from(idempotencyKey)
      .where(eq(idempotencyKey.workspaceId, actor.workspaceId));
    expect(rows.filter((row) => row.key === 'key-3')).toHaveLength(0);
    await expect(
      db.orm.transaction((tx) => claimIdempotency(tx, actor, 'key-3', 'hash-b')),
    ).resolves.toEqual({ claimed: true });
  });

  it('a second claim of the same key waits for the first and then replays it', async () => {
    const { db, actor } = await setup();
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const first = db.orm.transaction(async (tx) => {
      await claimIdempotency(tx, actor, 'key-4', 'hash-a');
      await gate;
      await storeIdempotent(tx, actor, 'key-4', 201, { commentId: 'c9', txid: 1 });
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    const second = db.orm.transaction((tx) => claimIdempotency(tx, actor, 'key-4', 'hash-a'));
    await new Promise((resolve) => setTimeout(resolve, 100));
    release?.();

    await first;
    await expect(second).resolves.toEqual({
      replay: { status: 201, response: { commentId: 'c9', txid: 1 } },
    });
  });
});
