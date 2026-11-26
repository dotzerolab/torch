import { canEditDocuments } from '@torch/shared/permissions';
import { Plus } from 'lucide-react';
import { useState } from 'react';
import { formatMoment } from '../comments/format.ts';
import { useActor } from '../comments/useActor.ts';
import { useMembers } from '../comments/useMembers.ts';
import { Badge, Button, EmptyState, Skeleton, useLocale, useT } from '../design/index.ts';
import type { SyncedTeam } from '../sync/collections.ts';
import { enqueueWrite } from '../sync/outbox.ts';
import { documentErrorMessage } from './errors.ts';
import { useTeamDocuments } from './useTeamDocuments.ts';
import './documents.css';

/**
 * The documents of a team: titles only, the most recently changed first, archived ones behind a toggle. A person who may
 * edit documents (not a guest) can start a new one. Mounted by the route `/teams/:key/documents`.
 */
export function DocumentsScreen({
  workspaceId,
  team,
  onOpen,
}: {
  workspaceId: string;
  team: SyncedTeam;
  onOpen: (documentId: string) => void;
}) {
  const t = useT();
  const locale = useLocale();
  const { actor, team: access } = useActor(team.id);
  const { nameOf } = useMembers(workspaceId);
  const { documents, ready } = useTeamDocuments(workspaceId, team.id);
  const [archived, setArchived] = useState(false);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const mayEdit = access !== null && canEditDocuments(actor, access);
  const shown = documents.filter((document) => archived || document.archived_at === null);
  const hasArchived = documents.some((document) => document.archived_at !== null);

  const create = () => {
    setError(null);
    setCreating(true);
    enqueueWrite({
      workspaceId,
      teamId: team.id,
      method: 'POST',
      path: `/api/w/${workspaceId}/teams/${team.id}/documents`,
      body: { title: t('documents.untitled') },
      idempotencyKey: crypto.randomUUID(),
    }).then(
      (answer) => {
        setCreating(false);
        // The outbox hands back the server's whole answer: `{ document, txid }`.
        const id = (answer as { document?: { id?: unknown } }).document?.id;
        if (typeof id === 'string') onOpen(id);
      },
      (failure: unknown) => {
        setCreating(false);
        setError(documentErrorMessage(locale, failure));
      },
    );
  };

  return (
    <section className="documents" aria-label={t('documents.title')} data-testid="documents-screen">
      <header className="documents__head">
        <h2 className="documents__title">{t('documents.title')}</h2>
        {hasArchived ? (
          <Button size="sm" variant="ghost" onClick={() => setArchived(!archived)}>
            {archived ? t('documents.hideArchived') : t('documents.showArchived')}
          </Button>
        ) : null}
        {mayEdit ? (
          <Button size="sm" variant="primary" loading={creating} onClick={create}>
            <Plus size={14} aria-hidden="true" /> {t('documents.new')}
          </Button>
        ) : null}
      </header>
      {error ? (
        <p className="documents__error" role="alert">
          {error}
        </p>
      ) : null}
      {!ready ? (
        <div aria-busy="true">
          <span className="visually-hidden">{t('documents.loading')}</span>
          <Skeleton />
        </div>
      ) : shown.length === 0 ? (
        <EmptyState title={t('documents.empty')} />
      ) : (
        <ul className="documents__list">
          {shown.map((document) => (
            <li key={document.id}>
              <button
                type="button"
                className="documents__row"
                data-testid={`document-${document.id}`}
                onClick={() => onOpen(document.id)}
              >
                <span className="documents__name">{document.title}</span>
                {document.archived_at ? <Badge>{t('documents.archivedBadge')}</Badge> : null}
                <span className="documents__meta">
                  {t('documents.updated', {
                    time: formatMoment(locale, document.updated_at),
                    name: nameOf(document.updated_by),
                  })}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
