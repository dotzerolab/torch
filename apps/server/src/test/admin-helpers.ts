// Helpers shared by the member, team and directory tests.
import { auditLog, session } from '@torch/shared/db/schema';
import type { Actor } from '@torch/shared/permissions';
import { asc, eq } from 'drizzle-orm';
import { expect } from 'vitest';
import { generateToken, hashToken } from '../auth/tokens.ts';
import type { Db, Orm } from '../db.ts';
import { loadActor } from '../permissions/load-actor.ts';
import type { ServiceResult } from '../util/result.ts';

/** The actor of a fixture member, as the resolver would load it for a request. */
export async function actorOf(db: Db, workspaceId: string, memberId: string): Promise<Actor> {
  const actor = await loadActor(db.orm, workspaceId, memberId);
  if (!actor) throw new Error('no actor for this member');
  return actor;
}

/** Asserts a success and returns the value. */
export function successOf<T>(result: ServiceResult<T>): T {
  if (!result.ok) throw new Error(`expected success, got ${result.code} (${result.status})`);
  return result.value;
}

/** Asserts a success carrying a transaction id and returns it as a positive integer. */
export function txidOf(result: ServiceResult<{ txid: number }>): number {
  const { txid } = successOf(result);
  expect(Number.isInteger(txid) && txid > 0).toBe(true);
  return txid;
}

export const refusal = (code: string, status: number) => ({ ok: false, code, status });

/** Every audit row of a workspace, oldest first. */
export const auditRows = (db: Db, workspaceId: string) =>
  db.orm
    .select()
    .from(auditLog)
    .where(eq(auditLog.workspaceId, workspaceId))
    .orderBy(asc(auditLog.createdAt), asc(auditLog.id));

/** Opens a session for a member without the sign-in dance; `cookie` is what a browser would send over http. */
export async function openSession(
  orm: Orm,
  workspaceId: string,
  memberId: string,
  opts: { cookieName?: string } = {},
): Promise<{ cookie: string; token: string }> {
  const token = generateToken();
  await orm.insert(session).values({
    workspaceId,
    memberId,
    tokenHash: hashToken(token),
    expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
  });
  return { cookie: `${opts.cookieName ?? 'sid'}=${token}`, token };
}
