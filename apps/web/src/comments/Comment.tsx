import { MoreHorizontal } from 'lucide-react';
import { useState } from 'react';
import { cx } from '../design/cx.ts';
import { Avatar, Button, IconButton, Menu, Textarea, useLocale, useT } from '../design/index.ts';
import type { SyncedMember } from '../sync/collections.ts';
import { EditHistory } from './EditHistory.tsx';
import { formatMoment } from './format.ts';
import { MarkdownContent } from './MarkdownContent.tsx';
import type { CommentView } from './pending.ts';
import { ReactionBar } from './ReactionBar.tsx';

/**
 * One comment of a thread: who and when, the text (or a tombstone), its reactions, and the actions the person may take.
 * Whether they may is decided by the caller from the permission rules of `@torch/shared`; the server decides again.
 */
export function Comment({
  comment,
  workspaceId,
  members,
  nameOf,
  mentions,
  memberId,
  readOnly,
  compact,
  canEdit,
  canDelete,
  onReaction,
  onEdit,
  onDelete,
  actions,
}: {
  comment: CommentView;
  workspaceId: string;
  members: ReadonlyMap<string, SyncedMember>;
  /** The name to show for a person id, including the label for one the page does not hold (see `useMembers`). */
  nameOf?: (id: string) => string;
  mentions: ReadonlySet<string>;
  memberId: string;
  readOnly: boolean;
  compact: boolean;
  canEdit: boolean;
  canDelete: boolean;
  onReaction: (emoji: string, on: boolean) => void;
  onEdit: (body: string) => Promise<void>;
  onDelete: () => Promise<void>;
  /** Buttons of the thread (reply, resolve), shown with the others. */
  actions?: React.ReactNode;
}) {
  const t = useT();
  const locale = useLocale();
  const [editing, setEditing] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [history, setHistory] = useState(false);

  const author = members.get(comment.author_id);
  const name = nameOf ? nameOf(comment.author_id) : (author?.name ?? t('comments.workspaceMember'));
  const deleted = comment.deleted_at !== null;
  const unsent = comment.id.startsWith('pending:');
  const locked = readOnly || unsent;

  const save = () => {
    const text = editing?.trim() ?? '';
    if (editing === null || text === '') return;
    setEditing(null);
    if (text === comment.body) return;
    onEdit(text).catch(() => setEditing(text));
  };

  const items = [
    ...(canEdit && !deleted && !locked
      ? [{ id: 'edit', label: t('comments.edit'), onSelect: () => setEditing(comment.body) }]
      : []),
    ...(canDelete && !deleted && !locked
      ? [
          {
            id: 'delete',
            label: t('comments.delete'),
            danger: true,
            onSelect: () => setConfirming(true),
          },
        ]
      : []),
  ];

  return (
    <article
      className={cx(
        'comment',
        deleted && 'comment--removed',
        comment.pending && 'comment--pending',
      )}
      data-testid={`comment-${comment.id}`}
      aria-busy={comment.pending ? true : undefined}
    >
      <header className="comment__head">
        <Avatar name={name} size="sm" />
        <span className="comment__author">{name}</span>
        <time className="comment__time" dateTime={comment.created_at}>
          {formatMoment(locale, comment.created_at)}
        </time>
        {comment.edited_at && !deleted ? (
          compact || unsent ? (
            <span className="comment__edited">{t('comments.edited')}</span>
          ) : (
            <button
              type="button"
              className="comment__edited comment__edited--link"
              aria-label={`${t('comments.edited')}: ${t('comments.history')}`}
              onClick={() => setHistory(true)}
            >
              {t('comments.edited')}
            </button>
          )
        ) : null}
        {comment.pending && unsent ? (
          <span className="comment__sending">{t('comments.sending')}</span>
        ) : null}
        <span className="comment__actions">
          {locked ? null : actions}
          {items.length > 0 ? (
            <Menu
              align="end"
              items={items}
              trigger={
                <IconButton
                  size="sm"
                  label={t('common.moreActions')}
                  icon={<MoreHorizontal size={14} aria-hidden="true" />}
                />
              }
            />
          ) : null}
        </span>
      </header>

      {deleted ? (
        <p className="comment__removed-note">{t('comments.removed')}</p>
      ) : editing !== null ? (
        <div className="comment__edit">
          <Textarea
            aria-label={t('comments.edit')}
            value={editing}
            rows={3}
            onChange={(event) => setEditing(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
                event.preventDefault();
                save();
              }
              if (event.key === 'Escape') setEditing(null);
            }}
          />
          <div className="comment__edit-bar">
            <Button size="sm" variant="ghost" onClick={() => setEditing(null)}>
              {t('common.cancel')}
            </Button>
            <Button size="sm" variant="primary" disabled={editing.trim() === ''} onClick={save}>
              {t('common.save')}
            </Button>
          </div>
        </div>
      ) : (
        <MarkdownContent className="comment__body" source={comment.body} mentions={mentions} />
      )}

      {confirming ? (
        <div
          className="comment__confirm"
          role="alertdialog"
          aria-label={t('comments.deleteQuestion')}
        >
          <p>{t('comments.deleteQuestion')}</p>
          <Button size="sm" variant="ghost" onClick={() => setConfirming(false)}>
            {t('common.cancel')}
          </Button>
          <Button
            size="sm"
            variant="danger"
            onClick={() => {
              setConfirming(false);
              onDelete().catch(() => {});
            }}
          >
            {t('comments.deleteConfirm')}
          </Button>
        </div>
      ) : null}

      {deleted || unsent ? null : (
        <ReactionBar
          reactions={comment.reactions}
          memberId={memberId}
          members={members}
          nameOf={nameOf}
          readOnly={readOnly}
          onToggle={onReaction}
        />
      )}

      {history ? (
        <EditHistory
          open
          onOpenChange={setHistory}
          workspaceId={workspaceId}
          commentId={comment.id}
          current={comment.body}
          members={members}
          nameOf={nameOf}
        />
      ) : null}
    </article>
  );
}
