// Housekeeping: rows that nothing reads any more. Sign-in tokens and sessions only ever grow otherwise, and an
// invitation that was never accepted is no use after its link is long dead. Accepted invitations stay: they are the
// record of who joined how.
import { attachment, idempotencyKey, invite, loginToken, session } from '@torch/shared/db/schema';
import { and, asc, eq, isNull, lt, or } from 'drizzle-orm';
import type { Orm } from '../db.ts';
import { stagingKeyOf } from '../files/keys.ts';
import type { FileStorage } from '../files/storage.ts';

const DAY_MS = 24 * 60 * 60 * 1000;
const RUN_EVERY_MS = 6 * 60 * 60 * 1000;

export type CleanupCounts = {
  loginTokens: number;
  sessions: number;
  invites: number;
  idempotencyKeys: number;
  pendingAttachments: number;
};

/** How long an upload may stay unfinished before the row and any object are removed. */
export const PENDING_UPLOAD_MAX_AGE_MS = DAY_MS;
const ATTACHMENT_BATCH = 200;

/**
 * Deletes login tokens that expired over a day ago, sessions that expired or were revoked over 7 days ago, and
 * invitations that were never accepted and expired or were revoked over 30 days ago (their team rows go with them),
 * and idempotency keys older than 24 hours (a replay window, not a record), and, when `storage` is given, uploads that
 * stayed pending for over 24 hours (rows that queued a removal are among them, see files/attachments.ts) together with
 * their objects: a row goes only after its object did, so an object that cannot be removed now is tried again on the
 * next run. `now` is a parameter so tests move the clock. Running it again at the same `now` deletes nothing.
 */
export async function cleanupExpiredRows(
  orm: Orm,
  now: Date,
  storage?: FileStorage,
): Promise<CleanupCounts> {
  const before = (days: number) => new Date(now.getTime() - days * DAY_MS);

  const loginTokens = await orm.delete(loginToken).where(lt(loginToken.expiresAt, before(1)));
  const sessions = await orm
    .delete(session)
    .where(or(lt(session.expiresAt, before(7)), lt(session.revokedAt, before(7))));
  const invites = await orm
    .delete(invite)
    .where(
      and(
        isNull(invite.acceptedAt),
        or(lt(invite.expiresAt, before(30)), lt(invite.revokedAt, before(30))),
      ),
    );
  const idempotencyKeys = await orm
    .delete(idempotencyKey)
    .where(lt(idempotencyKey.createdAt, new Date(now.getTime() - DAY_MS)));
  const pendingAttachments = storage ? await removeStaleUploads(orm, now, storage) : 0;
  return {
    loginTokens: loginTokens.rowCount ?? 0,
    sessions: sessions.rowCount ?? 0,
    invites: invites.rowCount ?? 0,
    idempotencyKeys: idempotencyKeys.rowCount ?? 0,
    pendingAttachments,
  };
}

/** Removes the objects (the staged one and the published key), then the row, of every upload that has been pending for over 24 hours; returns how many rows went. */
async function removeStaleUploads(orm: Orm, now: Date, storage: FileStorage): Promise<number> {
  const stale = await orm
    .select({
      id: attachment.id,
      workspaceId: attachment.workspaceId,
      storageKey: attachment.storageKey,
    })
    .from(attachment)
    .where(
      and(
        eq(attachment.status, 'pending'),
        lt(attachment.createdAt, new Date(now.getTime() - PENDING_UPLOAD_MAX_AGE_MS)),
      ),
    )
    .orderBy(asc(attachment.createdAt))
    .limit(ATTACHMENT_BATCH);

  let removed = 0;
  for (const row of stale) {
    try {
      await storage.remove(stagingKeyOf(row.workspaceId, row.id));
      await storage.remove(row.storageKey);
    } catch {
      continue; // the row stays, so the next run tries again
    }
    const gone = await orm
      .delete(attachment)
      .where(and(eq(attachment.id, row.id), eq(attachment.status, 'pending')));
    removed += gone.rowCount ?? 0;
  }
  return removed;
}

/** The SQLSTATE of a database error: `code` on the error or on the pg error that Drizzle wraps as its cause. */
function errorCode(error: unknown): string {
  for (const candidate of [error, (error as { cause?: unknown } | undefined)?.cause]) {
    const code = (candidate as { code?: unknown } | undefined)?.code;
    if (typeof code === 'string') return code;
  }
  return '';
}

/**
 * Runs the cleanup now and every 6 hours. The timer is unref'd (it never keeps the process alive), a run that fails
 * is logged by error name and code only (the message of a database error carries the SQL), and the next one still
 * happens. Logs counts, never rows. Returns the function that stops it.
 */
export function startCleanupSchedule(
  orm: Orm,
  opts: {
    now?: () => Date;
    log?: (line: string) => void;
    everyMs?: number;
    /** Object storage, when attachments are on: unfinished uploads are removed with their objects. */
    storage?: FileStorage;
  } = {},
): () => void {
  const now = opts.now ?? (() => new Date());
  const log = opts.log ?? ((line: string) => console.info(line));
  let running = false;

  async function run() {
    if (running) return;
    running = true;
    try {
      const counts = await cleanupExpiredRows(orm, now(), opts.storage);
      log(
        `cleanup removed login tokens: ${counts.loginTokens}, sessions: ${counts.sessions}, invites: ${counts.invites}, idempotency keys: ${counts.idempotencyKeys}, unfinished uploads: ${counts.pendingAttachments}`,
      );
    } catch (error) {
      console.error(
        'cleanup failed:',
        error instanceof Error ? error.name : 'unknown',
        errorCode(error),
      );
    } finally {
      running = false;
    }
  }

  void run();
  const timer = setInterval(() => void run(), opts.everyMs ?? RUN_EVERY_MS);
  timer.unref();
  return () => clearInterval(timer);
}
