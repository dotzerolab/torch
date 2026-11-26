import { useEffect, useState } from 'react';
import { apiFetch } from '../api.ts';
import { formatMoment } from '../comments/format.ts';
import { MarkdownContent } from '../comments/MarkdownContent.tsx';
import { Button, Dialog, Spinner, useLocale, useT } from '../design/index.ts';
import type { SyncedMember } from '../sync/collections.ts';

type Revision = { id: string; title: string; body: string; editedBy: string; createdAt: string };

/**
 * The earlier versions of a document, newest first, read over REST when the dialog opens (they are not synced). Restoring
 * one hands its title and text to the editor; it does not save by itself.
 */
export function RevisionList({
  open,
  onOpenChange,
  workspaceId,
  documentId,
  members,
  canRestore,
  onRestore,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  workspaceId: string;
  documentId: string;
  members: ReadonlyMap<string, SyncedMember>;
  canRestore: boolean;
  onRestore: (revision: { title: string; body: string }) => void;
}) {
  const t = useT();
  const locale = useLocale();
  const [state, setState] = useState<
    { status: 'loading' } | { status: 'error' } | { status: 'ready'; revisions: Revision[] }
  >({ status: 'loading' });

  useEffect(() => {
    if (!open) return;
    const controller = new AbortController();
    setState({ status: 'loading' });
    apiFetch<{ revisions: Revision[] }>(`/api/w/${workspaceId}/documents/${documentId}/revisions`, {
      signal: controller.signal,
    }).then(
      (answer) => setState({ status: 'ready', revisions: answer.revisions }),
      () => {
        if (!controller.signal.aborted) setState({ status: 'error' });
      },
    );
    return () => controller.abort();
  }, [open, workspaceId, documentId]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange} title={t('documents.history.title')}>
      <div className="revisions" data-testid="revision-list">
        {state.status === 'loading' ? <Spinner label={t('common.loading')} /> : null}
        {state.status === 'error' ? <p role="alert">{t('documents.history.error')}</p> : null}
        {state.status === 'ready' && state.revisions.length === 0 ? (
          <p>{t('documents.history.empty')}</p>
        ) : null}
        {state.status === 'ready' && state.revisions.length > 0 ? (
          <ol className="revisions__list">
            {state.revisions.map((revision) => (
              <li key={revision.id} className="revisions__item">
                <p className="revisions__meta">
                  {members.get(revision.editedBy)?.name ?? t('comments.formerMember')}
                  {' · '}
                  <time dateTime={revision.createdAt}>
                    {formatMoment(locale, revision.createdAt)}
                  </time>
                </p>
                <p className="revisions__title">{revision.title}</p>
                <MarkdownContent source={revision.body} />
                {canRestore ? (
                  <Button
                    size="sm"
                    onClick={() => {
                      onRestore({ title: revision.title, body: revision.body });
                      onOpenChange(false);
                    }}
                  >
                    {t('documents.history.restore')}
                  </Button>
                ) : null}
              </li>
            ))}
          </ol>
        ) : null}
      </div>
    </Dialog>
  );
}
