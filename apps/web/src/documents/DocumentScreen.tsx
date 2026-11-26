import { canEditDocuments } from '@torch/shared/permissions';
import { ArrowLeft } from 'lucide-react';
import { useState } from 'react';
import { documentContentKey, refreshAfterWrite } from '../comments/refresh.ts';
import { useActor } from '../comments/useActor.ts';
import { useMembers } from '../comments/useMembers.ts';
import { Button, Skeleton, useLocale, useT } from '../design/index.ts';
import type { SyncedTeam } from '../sync/collections.ts';
import { enqueueWrite } from '../sync/outbox.ts';
import { DocumentEditor } from './DocumentEditor.tsx';
import { documentErrorMessage } from './errors.ts';
import { RevisionList } from './RevisionList.tsx';
import { useDocumentContent } from './useDocumentContent.ts';
import { useTeamDocuments } from './useTeamDocuments.ts';
import './documents.css';

/**
 * One document: its title and text, the editor for people who may edit it, the earlier versions, and archiving. A guest
 * and an archived document are read-only. Mounted by the route `/teams/:key/documents/:documentId`.
 */
export function DocumentScreen({
  workspaceId,
  team,
  documentId,
  onBack,
}: {
  workspaceId: string;
  team: SyncedTeam;
  documentId: string;
  onBack: () => void;
}) {
  const t = useT();
  const locale = useLocale();
  const { actor, team: access } = useActor(team.id);
  const { byId, nameOf } = useMembers(workspaceId);
  const { documents, ready: titlesReady } = useTeamDocuments(workspaceId, team.id);
  const { body, ready: bodyReady } = useDocumentContent(workspaceId, team.id, documentId);
  const [history, setHistory] = useState(false);
  const [restored, setRestored] = useState<{ title: string; body: string; at: number } | null>(
    null,
  );
  const [error, setError] = useState<string | null>(null);

  const summary = documents.find((document) => document.id === documentId);
  const archived = summary?.archived_at != null;
  const mayEdit = access !== null && canEditDocuments(actor, access);

  const setArchived = (value: boolean) => {
    setError(null);
    enqueueWrite({
      workspaceId,
      teamId: team.id,
      method: 'POST',
      path: `/api/w/${workspaceId}/documents/${documentId}/${value ? 'archive' : 'unarchive'}`,
      idempotencyKey: crypto.randomUUID(),
    }).then(
      () => refreshAfterWrite(documentContentKey(workspaceId, team.id, documentId)),
      (failure: unknown) => setError(documentErrorMessage(locale, failure)),
    );
  };

  const loading = !titlesReady || !bodyReady;
  const missing = !loading && summary === undefined;

  return (
    <section className="document" data-testid="document-screen">
      <header className="document__head">
        <Button size="sm" variant="ghost" onClick={onBack}>
          <ArrowLeft size={14} aria-hidden="true" /> {t('documents.back')}
        </Button>
        {summary && mayEdit ? (
          <span className="document__actions">
            <Button size="sm" onClick={() => setHistory(true)}>
              {t('documents.history')}
            </Button>
            <Button size="sm" onClick={() => setArchived(!archived)}>
              {archived ? t('documents.unarchive') : t('documents.archive')}
            </Button>
          </span>
        ) : null}
      </header>
      {error ? (
        <p className="document__error" role="alert">
          {error}
        </p>
      ) : null}
      {loading ? (
        <div aria-busy="true">
          <span className="visually-hidden">{t('common.loading')}</span>
          <Skeleton />
        </div>
      ) : missing || body === null ? (
        <p className="document__note">{t('documents.notFound')}</p>
      ) : (
        <>
          {archived ? <p className="document__note">{t('documents.archivedNote')}</p> : null}
          {!mayEdit ? <p className="document__note">{t('documents.readOnlyNote')}</p> : null}
          <DocumentEditor
            workspaceId={workspaceId}
            teamId={team.id}
            documentId={documentId}
            title={summary?.title ?? ''}
            body={body}
            readOnly={!mayEdit || archived}
            restored={restored}
          />
          {mayEdit ? (
            <RevisionList
              open={history}
              onOpenChange={setHistory}
              workspaceId={workspaceId}
              documentId={documentId}
              members={byId}
              nameOf={nameOf}
              canRestore={!archived}
              onRestore={(revision) => setRestored({ ...revision, at: Date.now() })}
            />
          ) : null}
        </>
      )}
    </section>
  );
}
