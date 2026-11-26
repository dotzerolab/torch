// Comments on issues (spec section 6): threads one level deep, reactions, edit history, resolve and delete. One
// function per write, shared by REST today and by MCP and the public API later; the HTTP routes are thin wrappers.
// Every write is ONE transaction: permission check under the issue lock, the change, the outbox event (create only),
// the move of the issue's `updated_at` and the transaction id for the client. A refusal is thrown inside the
// transaction, so the rollback takes everything the call wrote with it (an idempotency claim included).
//
// Visibility: an issue the actor cannot see answers 404, never 403, exactly like an id that does not exist; 403 is for
// a person who sees the issue but may not do this (editing another person's comment). An archived issue is read-only.
// The issue's `updated_at` moves with every change, in the same transaction: the web refreshes its snapshot reads of
// comments from that change.
import { type CommentRow, comment, commentEdit } from '@torch/shared/db/schema';
import {
  type CommentCreateInput,
  type CommentEditInput,
  commentCreateInput,
  commentEditInput,
  reactionEmoji,
} from '@torch/shared/mutations/comment';
import {
  canComment,
  canDeleteComment,
  canEditComment,
  type TeamAccess,
} from '@torch/shared/permissions';
import { and, asc, desc, eq, sql } from 'drizzle-orm';
import type { Orm, Tx } from '../db.ts';
import { type IssueApiError, IssueRefusal, invalidReference, refusal } from '../issues/errors.ts';
import type { ChangeResult } from '../issues/join-changes.ts';
import { readableIssue } from '../issues/readable-issue.ts';
import { type Failure, lockEditableIssue, refuse, touchIssue } from '../issues/update-issue.ts';
import { claimIdempotency, requestHashOf, storeIdempotent } from '../mutations/idempotency.ts';
import { currentTxid } from '../mutations/txid.ts';
import type { ClientActor } from '../permissions/load-actor.ts';
import { isUuid } from '../util/uuid.ts';
import { type CommentDto, type CommentEditDto, toCommentDto } from './dto.ts';
import { recordCommentCreated } from './events.ts';

export type CommentResult<T> = ChangeResult<T>;
/** A read: the value, or the refusal. There is no transaction id to wait for. */
export type ReadResult<T> = { ok: true; value: T } | Failure;

/** Earlier versions kept per comment: the newest ones; an edit that pushes the count over it drops the oldest. */
export const MAX_EDITS = 50;
/** A page of the comment list: this many without `limit`, at most `MAX_LIST_LIMIT`. */
export const DEFAULT_LIST_LIMIT = 50;
export const MAX_LIST_LIMIT = 100;

// A cursor is the creation time of the last comment seen, with microseconds (a JavaScript Date keeps milliseconds
// only), and its id. Opaque to callers.
const STAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/;
const encodeCursor = (stamp: string, id: string) =>
  Buffer.from(`${stamp}|${id}`, 'utf8').toString('base64url');

function decodeCursor(cursor: string): { stamp: string; id: string } | null {
  if (!/^[A-Za-z0-9_-]+$/.test(cursor)) return null;
  const [stamp, id, extra] = Buffer.from(cursor, 'base64url').toString('utf8').split('|');
  if (extra !== undefined || !stamp || !id || !STAMP.test(stamp) || !isUuid(id)) return null;
  return { stamp, id };
}
export type CreateCommentResult =
  | { ok: true; txid: number; value: CommentDto; replayed: boolean }
  | Failure;

type Context = { tx: Tx; actor: ClientActor; access: TeamAccess; issueTeamId: string };

const toRefusal = (failure: IssueApiError) =>
  new IssueRefusal({
    code: failure.code,
    status: failure.status,
    ...(failure.message ? { message: failure.message } : {}),
    ...(failure.details ? { details: failure.details } : {}),
  });

const failureOf = (error: IssueApiError): Failure => ({ ok: false, ...error });

function invalidInput(error: {
  issues: readonly { path: readonly PropertyKey[]; message: string }[];
}): Failure {
  const first = error.issues[0];
  const where = first?.path.length ? `${first.path.join('.')}: ` : '';
  return refuse('invalid_input', 400, { message: `${where}${first?.message ?? ''}` });
}

/**
 * Runs `run` on one issue, as one transaction: the issue row is locked (writers of this issue queue here, so a
 * read-change-write on a comment never loses a concurrent one), the actor is re-read as the database says now, an
 * archived issue is refused, and the issue's `updated_at` moves when `run` says it changed something.
 */
async function writeOnIssue<T>(
  orm: Orm,
  requested: ClientActor,
  issueId: string,
  run: (context: Context) => Promise<{ value: T; changed: boolean }>,
): Promise<CommentResult<T>> {
  if (!isUuid(issueId)) return refuse('not_found', 404);
  try {
    return await orm.transaction(async (tx) => {
      const locked = await lockEditableIssue(tx, requested, issueId, 'see');
      if (!locked.ok) throw toRefusal(locked.refusal);
      if (locked.row.archivedAt) throw refusal('issue_archived', 409);
      const { value, changed } = await run({
        tx,
        actor: locked.actor,
        access: locked.access,
        issueTeamId: locked.row.teamId,
      });
      if (changed) await touchIssue(tx, locked.actor.workspaceId, issueId);
      return { ok: true as const, txid: await currentTxid(tx), value };
    });
  } catch (error) {
    if (error instanceof IssueRefusal) return failureOf(error.error);
    throw error;
  }
}

/** The issue a comment belongs to, within the actor's workspace; null for an unknown or foreign id. */
async function issueIdOfComment(
  orm: Orm,
  workspaceId: string,
  commentId: string,
): Promise<string | null> {
  if (!isUuid(commentId)) return null;
  const [row] = await orm
    .select({ issueId: comment.issueId })
    .from(comment)
    .where(and(eq(comment.workspaceId, workspaceId), eq(comment.id, commentId)));
  return row?.issueId ?? null;
}

/** The comment row, locked for this transaction (after the issue lock, always in that order). */
async function lockComment(
  tx: Tx,
  workspaceId: string,
  issueId: string,
  commentId: string,
): Promise<CommentRow> {
  const [row] = await tx
    .select()
    .from(comment)
    .where(
      and(
        eq(comment.workspaceId, workspaceId),
        eq(comment.issueId, issueId),
        eq(comment.id, commentId),
      ),
    )
    .for('no key update');
  if (!row) throw refusal('not_found', 404);
  return row;
}

/** Runs a change on an existing comment: finds its issue, then `writeOnIssue` with the comment locked. */
async function changeComment<T>(
  orm: Orm,
  requested: ClientActor,
  commentId: string,
  run: (context: Context & { row: CommentRow }) => Promise<{ value: T; changed: boolean }>,
): Promise<CommentResult<T>> {
  const issueId = await issueIdOfComment(orm, requested.workspaceId, commentId);
  if (!issueId) return refuse('not_found', 404);
  return writeOnIssue(orm, requested, issueId, async (context) => {
    const row = await lockComment(context.tx, context.actor.workspaceId, issueId, commentId);
    return run({ ...context, row });
  });
}

/**
 * Adds a comment to an issue, or a reply to a top-level comment of the same issue. `idempotencyKey` (the
 * `Idempotency-Key` header) makes a retry safe: the same person, key and body get the stored answer again and write
 * nothing; the same key with another body is 422. Writes the `comment.created` event in the same transaction.
 */
export async function createComment(
  orm: Orm,
  requested: ClientActor,
  issueId: string,
  input: CommentCreateInput,
  opts: { idempotencyKey?: string } = {},
): Promise<CreateCommentResult> {
  const parsed = commentCreateInput.safeParse(input);
  if (!parsed.success) return invalidInput(parsed.error);
  if (!isUuid(issueId)) return refuse('not_found', 404);
  const data = parsed.data;
  const key = opts.idempotencyKey;

  try {
    return await orm.transaction(async (tx) => {
      if (key !== undefined) {
        const claim = await claimIdempotency(
          tx,
          requested,
          key,
          requestHashOf({
            op: 'comment.create',
            issueId: issueId.toLowerCase(),
            body: data.body,
            parentId: data.parentId ?? null,
          }),
        );
        if ('replay' in claim) return replayOf(tx, requested, issueId, claim.replay.response);
      }

      const locked = await lockEditableIssue(tx, requested, issueId, 'see');
      if (!locked.ok) throw toRefusal(locked.refusal);
      if (locked.row.archivedAt) throw refusal('issue_archived', 409);
      const { actor, row: issueRow } = locked;

      if (data.parentId) {
        const [parent] = await tx
          .select({ parentId: comment.parentId, deletedAt: comment.deletedAt })
          .from(comment)
          .where(
            and(
              eq(comment.workspaceId, actor.workspaceId),
              eq(comment.issueId, issueRow.id),
              eq(comment.id, data.parentId),
            ),
          )
          .for('key share');
        // One level deep: the parent is a top-level comment of this very issue.
        if (!parent || parent.parentId !== null) throw invalidReference('parentId');
        if (parent.deletedAt) throw refusal('comment_deleted', 409);
      }

      const [created] = await tx
        .insert(comment)
        .values({
          workspaceId: actor.workspaceId,
          teamId: issueRow.teamId,
          issueId: issueRow.id,
          parentId: data.parentId ?? null,
          authorId: actor.memberId,
          body: data.body,
          // Write time, not transaction start: comments keep the order they were written in.
          createdAt: sql`clock_timestamp()`,
        })
        .returning();
      if (!created) throw new Error('comment insert returned no row');

      await recordCommentCreated(tx, actor, created);
      await touchIssue(tx, actor.workspaceId, issueRow.id);
      const txid = await currentTxid(tx);
      if (key !== undefined) {
        // Ids and the transaction id only: a replay rebuilds the answer through the current visibility check.
        await storeIdempotent(tx, requested, key, 201, { commentId: created.id, txid });
      }
      return { ok: true as const, txid, value: toCommentDto(created), replayed: false };
    });
  } catch (error) {
    if (error instanceof IssueRefusal) return failureOf(error.error);
    throw error;
  }
}

/** The answer of a replayed create: the comment as it is now, if the actor still sees the issue. */
async function replayOf(
  tx: Tx,
  requested: ClientActor,
  issueId: string,
  stored: unknown,
): Promise<CreateCommentResult> {
  const { commentId, txid } = (stored ?? {}) as { commentId?: unknown; txid?: unknown };
  if (typeof commentId !== 'string' || typeof txid !== 'number') throw refusal('not_found', 404);
  const locked = await lockEditableIssue(tx, requested, issueId, 'see');
  if (!locked.ok) throw toRefusal(locked.refusal);
  const [row] = await tx
    .select()
    .from(comment)
    .where(
      and(
        eq(comment.workspaceId, locked.actor.workspaceId),
        eq(comment.issueId, locked.row.id),
        eq(comment.id, commentId),
      ),
    );
  if (!row) throw refusal('not_found', 404);
  return { ok: true, txid, value: toCommentDto(row), replayed: true };
}

/** Changes the text of a comment. Only its author may; the previous body goes to the history. */
export async function editComment(
  orm: Orm,
  requested: ClientActor,
  commentId: string,
  input: CommentEditInput,
): Promise<CommentResult<null>> {
  const parsed = commentEditInput.safeParse(input);
  if (!parsed.success) return invalidInput(parsed.error);
  const { body } = parsed.data;

  return changeComment(orm, requested, commentId, async ({ tx, actor, access, row }) => {
    if (!canEditComment(actor, access, row)) throw refusal('forbidden', 403);
    if (row.deletedAt) throw refusal('comment_deleted', 409);
    if (row.body === body) return { value: null, changed: false };

    await tx.insert(commentEdit).values({
      workspaceId: row.workspaceId,
      teamId: row.teamId,
      issueId: row.issueId,
      commentId: row.id,
      body: row.body,
      editedBy: actor.memberId,
      createdAt: sql`clock_timestamp()`,
    });
    await tx
      .update(comment)
      .set({ body, editedAt: sql`clock_timestamp()` })
      .where(and(eq(comment.workspaceId, row.workspaceId), eq(comment.id, row.id)));
    // Keep the newest versions only: a person who may comment cannot make the history grow without end.
    await tx.delete(commentEdit).where(
      and(
        eq(commentEdit.workspaceId, row.workspaceId),
        eq(commentEdit.commentId, row.id),
        sql`${commentEdit.id} not in (
          select id from comment_edit
          where workspace_id = ${row.workspaceId} and comment_id = ${row.id}
          order by created_at desc, id desc
          limit ${MAX_EDITS})`,
      ),
    );
    return { value: null, changed: true };
  });
}

/**
 * Deletes a comment: its author, or an owner or admin. The comment stays as a tombstone so the replies keep their
 * thread: `deleted_at` set, text blanked, reactions cleared and its edit history removed in the same transaction, so
 * the database keeps no deleted text (events and activity never held it). The same write raises the generation of the
 * issue's comments shape (the number of tombstones, see sync/shapes.ts), so the sync log that saw the text is never
 * served again. Deleting twice is a no-op.
 */
export async function deleteComment(
  orm: Orm,
  requested: ClientActor,
  commentId: string,
): Promise<CommentResult<null>> {
  return changeComment(orm, requested, commentId, async ({ tx, actor, access, row }) => {
    if (!canDeleteComment(actor, access, row)) throw refusal('forbidden', 403);
    if (row.deletedAt) return { value: null, changed: false };

    await tx
      .delete(commentEdit)
      .where(and(eq(commentEdit.workspaceId, row.workspaceId), eq(commentEdit.commentId, row.id)));
    await tx
      .update(comment)
      .set({ body: '', reactions: {}, deletedAt: sql`clock_timestamp()` })
      .where(and(eq(comment.workspaceId, row.workspaceId), eq(comment.id, row.id)));
    return { value: null, changed: true };
  });
}

/** Resolves or reopens a thread. Only a top-level comment is a thread: a reply answers 422. Idempotent. */
export async function setResolved(
  orm: Orm,
  requested: ClientActor,
  commentId: string,
  resolved: boolean,
): Promise<CommentResult<null>> {
  return changeComment(orm, requested, commentId, async ({ tx, actor, access, row }) => {
    if (!canComment(actor, access)) throw refusal('forbidden', 403);
    if (row.parentId !== null) {
      throw refusal('invalid_input', 422, {
        message: 'Only the first comment of a thread can be resolved.',
        details: { field: 'commentId' },
      });
    }
    if (row.deletedAt) throw refusal('comment_deleted', 409);
    if (resolved === (row.resolvedAt !== null)) return { value: null, changed: false };

    await tx
      .update(comment)
      .set(
        resolved
          ? { resolvedAt: sql`clock_timestamp()`, resolvedBy: actor.memberId }
          : { resolvedAt: null, resolvedBy: null },
      )
      .where(and(eq(comment.workspaceId, row.workspaceId), eq(comment.id, row.id)));
    return { value: null, changed: true };
  });
}

/**
 * Adds or removes the actor's reaction. The emoji is one of the fixed set; the reactions of the locked row are
 * changed in application code and written back, so twenty people reacting at once all land. Idempotent.
 */
export async function setReaction(
  orm: Orm,
  requested: ClientActor,
  commentId: string,
  emoji: string,
  on: boolean,
): Promise<CommentResult<null>> {
  const parsedEmoji = reactionEmoji.safeParse(emoji);
  if (!parsedEmoji.success) return refuse('invalid_input', 400, { message: 'Unknown reaction.' });
  const symbol = parsedEmoji.data;

  return changeComment(orm, requested, commentId, async ({ tx, actor, access, row }) => {
    if (!canComment(actor, access)) throw refusal('forbidden', 403);
    if (row.deletedAt) throw refusal('comment_deleted', 409);
    const current = row.reactions[symbol] ?? [];
    if (current.includes(actor.memberId) === on) return { value: null, changed: false };

    const reactions = { ...row.reactions };
    const next = on ? [...current, actor.memberId] : current.filter((id) => id !== actor.memberId);
    if (next.length === 0) delete reactions[symbol];
    else reactions[symbol] = next;
    await tx
      .update(comment)
      .set({ reactions })
      .where(and(eq(comment.workspaceId, row.workspaceId), eq(comment.id, row.id)));
    return { value: null, changed: true };
  });
}

/**
 * The comments of an issue, oldest first, one page at a time: `limit` (1 to 100, default 50) and the `nextCursor` of the
 * previous page, like the other lists. Tombstones keep their place. 404 for an issue the actor cannot see.
 */
export async function listComments(
  orm: Orm,
  actor: ClientActor,
  issueId: string,
  options: { limit?: number; cursor?: string } = {},
): Promise<ReadResult<{ comments: CommentDto[]; nextCursor: string | null }>> {
  const limit = options.limit ?? DEFAULT_LIST_LIMIT;
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIST_LIMIT) {
    return refuse('invalid_input', 400, {
      message: `limit must be an integer from 1 to ${MAX_LIST_LIMIT}.`,
    });
  }
  const cursor = options.cursor === undefined ? undefined : decodeCursor(options.cursor);
  if (options.cursor !== undefined && !cursor) {
    return refuse('invalid_input', 400, { message: 'cursor is not valid.' });
  }
  if (!isUuid(issueId)) return refuse('not_found', 404);
  if (!(await readableIssue(orm, actor, issueId))) return refuse('not_found', 404);
  const rows = await orm
    .select({
      row: comment,
      stamp: sql<string>`to_char(${comment.createdAt} at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`,
    })
    .from(comment)
    .where(
      and(
        eq(comment.workspaceId, actor.workspaceId),
        eq(comment.issueId, issueId),
        cursor
          ? sql`(${comment.createdAt}, ${comment.id}) > (${cursor.stamp}::timestamptz, ${cursor.id}::uuid)`
          : undefined,
      ),
    )
    .orderBy(asc(comment.createdAt), asc(comment.id))
    .limit(limit + 1);
  const page = rows.slice(0, limit);
  const last = page.at(-1);
  return {
    ok: true,
    value: {
      comments: page.map((entry) => toCommentDto(entry.row)),
      nextCursor: rows.length > limit && last ? encodeCursor(last.stamp, last.row.id) : null,
    },
  };
}

/**
 * The earlier versions of a comment, oldest first: the newest 50 (the history keeps no more). Needs sight of the issue;
 * a deleted comment has none.
 */
export async function listEdits(
  orm: Orm,
  actor: ClientActor,
  commentId: string,
): Promise<ReadResult<CommentEditDto[]>> {
  const issueId = await issueIdOfComment(orm, actor.workspaceId, commentId);
  if (!issueId || !(await readableIssue(orm, actor, issueId))) return refuse('not_found', 404);
  const rows = await orm
    .select()
    .from(commentEdit)
    .where(
      and(eq(commentEdit.workspaceId, actor.workspaceId), eq(commentEdit.commentId, commentId)),
    )
    .orderBy(desc(commentEdit.createdAt), desc(commentEdit.id))
    .limit(MAX_EDITS);
  return {
    ok: true,
    value: rows.reverse().map((row) => ({
      id: row.id,
      body: row.body,
      editedBy: row.editedBy,
      createdAt: row.createdAt.toISOString(),
    })),
  };
}
