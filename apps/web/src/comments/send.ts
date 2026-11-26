// The writes of a comment: create, edit, delete, resolve and react. Each goes through the outbox (stored on the device,
// sent in order, sent again after a lost connection with the same `Idempotency-Key`, so a replay never duplicates a
// comment), shows at once on top of the synced rows (`pending.ts`), and asks for the comments shape to be read again as soon
// as the server answers. A refusal rejects after the overlay is gone, so the screen can say why.
import {
  commentCreateInput,
  commentEditInput,
  reactionEmoji,
} from '@torch/shared/mutations/comment';
import { ApiError } from '../api.ts';
import { enqueueWrite, type OutboxWrite } from '../sync/outbox.ts';
import { addPending, markDone, type PendingOp, removePending } from './pending.ts';
import { issueObjectKey, refreshAfterWrite } from './refresh.ts';

/** Who writes and where: the workspace and team of the issue, and the member (for the overlay's author and names). */
export type WriteContext = { workspaceId: string; teamId: string; memberId: string };

export type WriteDeps = {
  enqueue: (write: OutboxWrite) => Promise<{ txid: number }>;
  /** Reads the comments of the issue again; returns the instance that was current. */
  refresh: (ctx: WriteContext, issueId: string) => object;
  now: () => string;
  newKey: () => string;
};

const defaultDeps: WriteDeps = {
  enqueue: enqueueWrite,
  refresh: (ctx, issueId) =>
    refreshAfterWrite(issueObjectKey('issueComments', ctx.workspaceId, ctx.teamId, issueId)),
  now: () => new Date().toISOString(),
  newKey: () => crypto.randomUUID(),
};

const invalid = () => new ApiError(400, 'invalid_input', 'The comment is not valid.');

async function run(
  ctx: WriteContext,
  issueId: string,
  op: PendingOp,
  request: Pick<OutboxWrite, 'method' | 'path' | 'body'>,
  deps: WriteDeps,
): Promise<void> {
  const entry = addPending(issueId, op);
  try {
    const result = await deps.enqueue({
      workspaceId: ctx.workspaceId,
      teamId: ctx.teamId,
      idempotencyKey: deps.newKey(),
      ...request,
    });
    // The answer of the server is the whole body (`{ comment, txid }` for a create); the outbox types it by its txid.
    const answered = (result as { comment?: { id?: unknown } }).comment?.id;
    markDone(
      issueId,
      entry,
      deps.refresh(ctx, issueId),
      typeof answered === 'string' ? { serverId: answered } : {},
    );
  } catch (error) {
    removePending(issueId, entry);
    throw error;
  }
}

const commentsPath = (ctx: WriteContext, issueId: string) =>
  `/api/w/${ctx.workspaceId}/issues/${issueId}/comments`;
const commentPath = (ctx: WriteContext, commentId: string) =>
  `/api/w/${ctx.workspaceId}/comments/${commentId}`;

export async function sendComment(
  ctx: WriteContext,
  input: { issueId: string; body: string; parentId?: string | null },
  deps: WriteDeps = defaultDeps,
): Promise<void> {
  const parsed = commentCreateInput.safeParse({
    body: input.body,
    ...(input.parentId ? { parentId: input.parentId } : {}),
  });
  if (!parsed.success) throw invalid();
  await run(
    ctx,
    input.issueId,
    {
      kind: 'create',
      workspaceId: ctx.workspaceId,
      teamId: ctx.teamId,
      issueId: input.issueId,
      body: parsed.data.body,
      parentId: parsed.data.parentId ?? null,
      authorId: ctx.memberId,
      createdAt: deps.now(),
    },
    { method: 'POST', path: commentsPath(ctx, input.issueId), body: parsed.data },
    deps,
  );
}

export async function editComment(
  ctx: WriteContext,
  input: { issueId: string; commentId: string; body: string },
  deps: WriteDeps = defaultDeps,
): Promise<void> {
  const parsed = commentEditInput.safeParse({ body: input.body });
  if (!parsed.success) throw invalid();
  await run(
    ctx,
    input.issueId,
    { kind: 'edit', commentId: input.commentId, body: parsed.data.body, at: deps.now() },
    { method: 'PATCH', path: commentPath(ctx, input.commentId), body: parsed.data },
    deps,
  );
}

export async function deleteComment(
  ctx: WriteContext,
  input: { issueId: string; commentId: string },
  deps: WriteDeps = defaultDeps,
): Promise<void> {
  await run(
    ctx,
    input.issueId,
    { kind: 'delete', commentId: input.commentId, at: deps.now() },
    { method: 'DELETE', path: commentPath(ctx, input.commentId) },
    deps,
  );
}

export async function setResolved(
  ctx: WriteContext,
  input: { issueId: string; commentId: string; resolved: boolean },
  deps: WriteDeps = defaultDeps,
): Promise<void> {
  await run(
    ctx,
    input.issueId,
    {
      kind: 'resolve',
      commentId: input.commentId,
      resolved: input.resolved,
      by: ctx.memberId,
      at: deps.now(),
    },
    {
      method: 'POST',
      path: `${commentPath(ctx, input.commentId)}/${input.resolved ? 'resolve' : 'unresolve'}`,
    },
    deps,
  );
}

export async function setReaction(
  ctx: WriteContext,
  input: { issueId: string; commentId: string; emoji: string; on: boolean },
  deps: WriteDeps = defaultDeps,
): Promise<void> {
  const emoji = reactionEmoji.safeParse(input.emoji);
  if (!emoji.success) throw invalid();
  await run(
    ctx,
    input.issueId,
    {
      kind: 'react',
      commentId: input.commentId,
      emoji: emoji.data,
      memberId: ctx.memberId,
      on: input.on,
    },
    {
      method: input.on ? 'PUT' : 'DELETE',
      path: `${commentPath(ctx, input.commentId)}/reactions/${encodeURIComponent(emoji.data)}`,
    },
    deps,
  );
}
