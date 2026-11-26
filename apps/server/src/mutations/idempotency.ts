// The claim-then-replay rule of an `Idempotency-Key`, for every create that takes one (comments today; issues keep
// their own copy in create-issue.ts). The key row is written first, in the caller's transaction: a second request with
// the same key waits for the first to commit or roll back, then replays its stored answer, or runs if the first rolled
// back. A refusal must therefore be THROWN (it rolls the claim back); a returned failure would commit a claim with no
// answer.
import { createHash } from 'node:crypto';
import { idempotencyKey } from '@torch/shared/db/schema';
import { and, eq } from 'drizzle-orm';
import type { Tx } from '../db.ts';
import { refusal } from '../issues/errors.ts';
import type { ClientActor } from '../permissions/load-actor.ts';

/** Sorted keys at every depth, so two bodies with the same content hash the same whatever the key order. */
function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

/** The hash a request is compared by: the operation and everything that identifies what it asks for. */
export const requestHashOf = (request: unknown): string =>
  createHash('sha256').update(canonicalJson(request)).digest('hex');

export type Claim = { replay: { status: number; response: unknown } } | { claimed: true };

/**
 * Takes the key for this actor, or returns the stored answer of an earlier request with the same hash. The same key
 * with another hash throws 422 `idempotency_key_reused`.
 */
export async function claimIdempotency(
  tx: Tx,
  actor: ClientActor,
  key: string,
  requestHash: string,
): Promise<Claim> {
  const inserted = await tx
    .insert(idempotencyKey)
    .values({
      workspaceId: actor.workspaceId,
      actorId: actor.memberId,
      key,
      requestHash,
      status: 0,
      response: {},
    })
    .onConflictDoNothing()
    .returning({ key: idempotencyKey.key });
  if (inserted.length > 0) return { claimed: true };

  const [stored] = await tx
    .select()
    .from(idempotencyKey)
    .where(
      and(
        eq(idempotencyKey.workspaceId, actor.workspaceId),
        eq(idempotencyKey.actorId, actor.memberId),
        eq(idempotencyKey.key, key),
      ),
    );
  if (!stored) throw refusal('not_found', 404);
  if (stored.requestHash !== requestHash) throw refusal('idempotency_key_reused', 422);
  return { replay: { status: stored.status, response: stored.response } };
}

/** Finishes a claim made in this transaction: what a replay answers. Keep ids and the transaction id, never text. */
export async function storeIdempotent(
  tx: Tx,
  actor: ClientActor,
  key: string,
  status: number,
  response: unknown,
): Promise<void> {
  await tx
    .update(idempotencyKey)
    .set({ status, response: response ?? {} })
    .where(
      and(
        eq(idempotencyKey.workspaceId, actor.workspaceId),
        eq(idempotencyKey.actorId, actor.memberId),
        eq(idempotencyKey.key, key),
      ),
    );
}
