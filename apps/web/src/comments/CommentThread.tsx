import { canComment, canDeleteComment, canEditComment } from '@torch/shared/permissions';
import { useMemo, useState } from 'react';
import './comments.css';
import { Button, Skeleton, useLocale, useT } from '../design/index.ts';
import { Comment } from './Comment.tsx';
import { Composer } from './Composer.tsx';
import { commentErrorMessage } from './errors.ts';
import type { CommentView } from './pending.ts';
import {
  deleteComment,
  editComment,
  sendComment,
  setReaction,
  setResolved,
  type WriteContext,
} from './send.ts';
import { useActor } from './useActor.ts';
import { useIssueComments } from './useIssueComments.ts';
import { useMembers } from './useMembers.ts';

/**
 * The comments of one issue: threads one level deep, oldest first, each reply under its comment. Reads the `issueComments`
 * shape and the members shape; every write goes through the outbox (`send.ts`) and shows at once. `readOnly` (an archived
 * issue, or a role that cannot write) turns every write off; the permission rules are checked here as well, and the
 * server decides again. `compact` is the issue peek: the composer collapses to one line and the history is not offered.
 */
export function CommentThread({
  workspaceId,
  teamId,
  issueId,
  issueIdentifier,
  readOnly,
  compact = false,
}: {
  workspaceId: string;
  teamId: string;
  issueId: string;
  /** "ENG-12", for the labels of the screen. */
  issueIdentifier: string;
  readOnly: boolean;
  compact?: boolean;
}) {
  const t = useT();
  const locale = useLocale();
  const { actor, team } = useActor(teamId);
  const { comments, ready } = useIssueComments(workspaceId, teamId, issueId);
  const { members, byId, nameOf } = useMembers(workspaceId);
  const [error, setError] = useState<string | null>(null);
  const [replyTo, setReplyTo] = useState<string | null>(null);
  const [open, setOpen] = useState<ReadonlySet<string>>(new Set());

  const mentions = useMemo(
    () => new Set(members.filter((m) => !m.deactivated_at).map((m) => m.handle.toLowerCase())),
    [members],
  );
  const { threads } = useMemo(() => {
    const ids = new Set(comments.map((comment) => comment.id));
    const replies = new Map<string, CommentView[]>();
    const tops: CommentView[] = [];
    for (const comment of comments) {
      // A reply whose comment is not in the list is shown as a comment of its own rather than hidden.
      if (comment.parent_id && ids.has(comment.parent_id)) {
        replies.set(comment.parent_id, [...(replies.get(comment.parent_id) ?? []), comment]);
      } else tops.push(comment);
    }
    return { threads: tops.map((top) => ({ top, replies: replies.get(top.id) ?? [] })) };
  }, [comments]);

  const writable = !readOnly && team !== null && canComment(actor, team);
  const ctx: WriteContext = { workspaceId, teamId, memberId: actor.memberId };

  /** Runs a write; a refusal is said once, in the person's language, and passed on to whoever must undo something. */
  const run = (work: Promise<void>): Promise<void> => {
    setError(null);
    return work.catch((failure: unknown) => {
      setError(commentErrorMessage(locale, failure));
      throw failure;
    });
  };
  const quiet = (work: Promise<void>) => void run(work).catch(() => {});

  const composerNote = readOnly ? t('comments.composer.archived') : t('comments.composer.readOnly');

  const renderComment = (comment: CommentView, top: boolean) => {
    const author = { authorId: comment.author_id };
    const showReply = top && writable && comment.deleted_at === null;
    return (
      <Comment
        key={comment.id}
        comment={comment}
        workspaceId={workspaceId}
        members={byId}
        nameOf={nameOf}
        mentions={mentions}
        memberId={actor.memberId}
        readOnly={!writable}
        compact={compact}
        canEdit={team !== null && canEditComment(actor, team, author)}
        canDelete={team !== null && canDeleteComment(actor, team, author)}
        onReaction={(emoji, on) =>
          quiet(setReaction(ctx, { issueId, commentId: comment.id, emoji, on }))
        }
        onEdit={(body) => run(editComment(ctx, { issueId, commentId: comment.id, body }))}
        onDelete={() => run(deleteComment(ctx, { issueId, commentId: comment.id }))}
        actions={
          top && comment.deleted_at === null ? (
            <>
              {showReply ? (
                <Button size="sm" variant="ghost" onClick={() => setReplyTo(comment.id)}>
                  {t('comments.reply')}
                </Button>
              ) : null}
              {writable ? (
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() =>
                    quiet(
                      setResolved(ctx, {
                        issueId,
                        commentId: comment.id,
                        resolved: comment.resolved_at === null,
                      }),
                    )
                  }
                >
                  {comment.resolved_at === null ? t('comments.resolve') : t('comments.reopen')}
                </Button>
              ) : null}
            </>
          ) : null
        }
      />
    );
  };

  return (
    <section
      className={compact ? 'comments comments--compact' : 'comments'}
      aria-label={`${t('comments.title')} ${issueIdentifier}`}
      data-testid="comment-thread"
    >
      <h3 className="comments__title">{t('comments.title')}</h3>
      {error ? (
        <p className="comments__error" role="alert" data-testid="comment-error">
          {error}
        </p>
      ) : null}

      {!ready ? (
        <div aria-busy="true">
          <span className="visually-hidden">{t('comments.loading')}</span>
          <Skeleton />
        </div>
      ) : threads.length === 0 ? (
        <p className="comments__empty">{t('comments.empty')}</p>
      ) : (
        <ol className="comments__list">
          {threads.map(({ top, replies }) => {
            const resolved = top.resolved_at !== null && top.deleted_at === null;
            const expanded = !resolved || open.has(top.id);
            return (
              <li key={top.id} className="thread" data-testid={`thread-${top.id}`}>
                {resolved && !expanded ? (
                  <div className="thread__resolved">
                    <span>
                      {t('comments.resolved', {
                        name: nameOf(top.resolved_by ?? ''),
                      })}
                    </span>
                    <span className="thread__count">
                      {t('comments.resolved.replies', { count: String(replies.length) })}
                    </span>
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => setOpen(new Set([...open, top.id]))}
                    >
                      {t('comments.resolved.show')}
                    </Button>
                    {writable ? (
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() =>
                          quiet(setResolved(ctx, { issueId, commentId: top.id, resolved: false }))
                        }
                      >
                        {t('comments.reopen')}
                      </Button>
                    ) : null}
                  </div>
                ) : (
                  <>
                    {resolved ? (
                      <div className="thread__resolved thread__resolved--open">
                        <span>
                          {t('comments.resolved', {
                            name: nameOf(top.resolved_by ?? ''),
                          })}
                        </span>
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() => setOpen(new Set([...open].filter((id) => id !== top.id)))}
                        >
                          {t('comments.resolved.hide')}
                        </Button>
                      </div>
                    ) : null}
                    {renderComment(top, true)}
                    {replies.length > 0 ? (
                      <ul className="thread__replies">
                        {replies.map((reply) => (
                          <li key={reply.id}>{renderComment(reply, false)}</li>
                        ))}
                      </ul>
                    ) : null}
                    {replyTo === top.id && writable ? (
                      <div className="thread__reply">
                        <Composer
                          scope={`${issueId}:${top.id}`}
                          label={t('comments.composer.replyLabel', {
                            name: nameOf(top.author_id),
                          })}
                          placeholder={t('comments.composer.placeholder')}
                          submitLabel={t('comments.composer.reply')}
                          autoFocus
                          onCancel={() => setReplyTo(null)}
                          onSubmit={(body) => {
                            setReplyTo(null);
                            return run(sendComment(ctx, { issueId, body, parentId: top.id }));
                          }}
                        />
                      </div>
                    ) : null}
                  </>
                )}
              </li>
            );
          })}
        </ol>
      )}

      <div className="comments__composer">
        <Composer
          scope={issueId}
          label={t('comments.composer.label')}
          placeholder={compact ? t('comments.composer.expand') : t('comments.composer.placeholder')}
          submitLabel={t('comments.composer.send')}
          disabled={!writable}
          note={composerNote}
          compact={compact}
          onSubmit={(body) => run(sendComment(ctx, { issueId, body }))}
        />
      </div>
    </section>
  );
}
