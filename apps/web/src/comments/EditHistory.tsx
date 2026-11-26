import { useEffect, useState } from 'react';
import { apiFetch } from '../api.ts';
import { Dialog, Spinner, useLocale, useT } from '../design/index.ts';
import type { SyncedMember } from '../sync/collections.ts';
import { formatMoment } from './format.ts';
import { MarkdownContent } from './MarkdownContent.tsx';

type Edit = { id: string; body: string; editedBy: string; createdAt: string };

/**
 * The earlier texts of a comment, oldest first, read over REST when the dialog opens (the history is not synced), and the
 * text it has now at the end. Each earlier text is shown as it was, through the same safe renderer.
 */
export function EditHistory({
  open,
  onOpenChange,
  workspaceId,
  commentId,
  current,
  members,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  workspaceId: string;
  commentId: string;
  current: string;
  members: ReadonlyMap<string, SyncedMember>;
}) {
  const t = useT();
  const locale = useLocale();
  const [state, setState] = useState<
    { status: 'loading' } | { status: 'error' } | { status: 'ready'; edits: Edit[] }
  >({ status: 'loading' });

  useEffect(() => {
    if (!open) return;
    const controller = new AbortController();
    setState({ status: 'loading' });
    apiFetch<{ edits: Edit[] }>(`/api/w/${workspaceId}/comments/${commentId}/history`, {
      signal: controller.signal,
    }).then(
      (answer) => setState({ status: 'ready', edits: answer.edits }),
      () => {
        if (!controller.signal.aborted) setState({ status: 'error' });
      },
    );
    return () => controller.abort();
  }, [open, workspaceId, commentId]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange} title={t('comments.history.title')}>
      <div className="history" data-testid="edit-history">
        {state.status === 'loading' ? <Spinner label={t('common.loading')} /> : null}
        {state.status === 'error' ? <p role="alert">{t('comments.history.error')}</p> : null}
        {state.status === 'ready' ? (
          <ol className="history__list">
            {state.edits.map((edit) => (
              <li key={edit.id} className="history__item">
                <p className="history__meta">
                  {members.get(edit.editedBy)?.name ?? t('comments.formerMember')}
                  {' · '}
                  <time dateTime={edit.createdAt}>{formatMoment(locale, edit.createdAt)}</time>
                </p>
                <MarkdownContent source={edit.body} />
              </li>
            ))}
            <li className="history__item history__item--current">
              <p className="history__meta">{t('comments.history.current')}</p>
              <MarkdownContent source={current} />
            </li>
          </ol>
        ) : null}
      </div>
    </Dialog>
  );
}
