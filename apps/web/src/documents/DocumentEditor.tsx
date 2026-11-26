import { MAX_DOCUMENT_LENGTH, MAX_DOCUMENT_TITLE_LENGTH } from '@torch/shared/mutations/document';
import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { ApiError } from '../api.ts';
import { MarkdownContent } from '../comments/MarkdownContent.tsx';
import { documentContentKey, refreshAfterWrite } from '../comments/refresh.ts';
import { cx } from '../design/cx.ts';
import { Button, Input, Textarea, useLocale, useT } from '../design/index.ts';
import { enqueueWrite, pendingCount, subscribePending } from '../sync/outbox.ts';
import { documentErrorMessage } from './errors.ts';

type Saved = { title: string; body: string };

/**
 * The title and the text of one document. It saves on Cmd or Ctrl+S and when a field is left, sending only what changed
 * (once per change); the write goes through the outbox, so it survives a lost connection and says how many changes wait.
 * A refused save keeps the draft and says why. What others save arrives through the shapes and replaces the draft only
 * while the person has no unsaved change here (the last save wins, as the server decides). `readOnly` (a guest, an
 * archived document) shows the text through the safe renderer and no fields.
 */
export function DocumentEditor({
  workspaceId,
  teamId,
  documentId,
  title,
  body,
  readOnly,
  restored,
  onSaved,
}: {
  workspaceId: string;
  teamId: string;
  documentId: string;
  /** The synced title and text: the baseline the draft is compared with. */
  title: string;
  body: string;
  readOnly: boolean;
  /** A version handed over by the history: it fills the fields and is not saved by itself. */
  restored?: { title: string; body: string; at: number } | null;
  onSaved?: () => void;
}) {
  const t = useT();
  const locale = useLocale();
  const [draft, setDraft] = useState<Saved>({ title, body });
  const latestDraft = useRef(draft);
  latestDraft.current = draft;
  const baseline = useRef<Saved>({ title, body });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<'write' | 'preview'>('write');
  const waiting = useSyncExternalStore(
    subscribePending,
    () => pendingCount(workspaceId),
    () => 0,
  );

  // What others saved replaces the draft only while the person has changed nothing here.
  useEffect(() => {
    const unchanged =
      latestDraft.current.title === baseline.current.title &&
      latestDraft.current.body === baseline.current.body;
    baseline.current = { title, body };
    if (unchanged) setDraft({ title, body });
  }, [title, body]);

  // A version restored from the history fills the fields (an edit the person still has to save).
  useEffect(() => {
    if (restored) setDraft({ title: restored.title, body: restored.body });
  }, [restored]);

  const dirty =
    draft.title.trim() !== baseline.current.title || draft.body !== baseline.current.body;

  const save = () => {
    const changes: Partial<Saved> = {};
    const trimmed = draft.title.trim();
    if (trimmed !== baseline.current.title) changes.title = trimmed;
    if (draft.body !== baseline.current.body) changes.body = draft.body;
    if (changes.title === undefined && changes.body === undefined) return;
    if (changes.title === '') {
      setError(documentErrorMessage(locale, new ApiError(400, 'invalid_input', '')));
      return;
    }
    const sent = { ...baseline.current, ...changes };
    setError(null);
    setSaving(true);
    // The baseline moves at once: leaving the field twice must not send the same change twice.
    baseline.current = sent;
    enqueueWrite({
      workspaceId,
      teamId,
      method: 'PATCH',
      path: `/api/w/${workspaceId}/documents/${documentId}`,
      body: changes,
      idempotencyKey: crypto.randomUUID(),
    }).then(
      () => {
        setSaving(false);
        refreshAfterWrite(documentContentKey(workspaceId, teamId, documentId));
        onSaved?.();
      },
      (failure: unknown) => {
        setSaving(false);
        // The draft stays as it is; the next save sends the difference from what the server holds.
        baseline.current = {
          title: changes.title === undefined ? baseline.current.title : title,
          body: changes.body === undefined ? baseline.current.body : body,
        };
        setError(documentErrorMessage(locale, failure));
      },
    );
  };

  const saveOnShortcut = (event: React.KeyboardEvent) => {
    if (event.key.toLowerCase() === 's' && (event.metaKey || event.ctrlKey)) {
      event.preventDefault();
      save();
    }
  };

  if (readOnly) {
    return (
      <div className="doc-editor doc-editor--read">
        <h2 className="doc-editor__title">{title}</h2>
        {body.trim() === '' ? (
          <p className="doc-editor__empty">{t('documents.previewEmpty')}</p>
        ) : (
          <MarkdownContent source={body} />
        )}
      </div>
    );
  }

  const state = error
    ? null
    : waiting > 0 && !navigator.onLine
      ? t('documents.state.offline', { count: String(waiting) })
      : saving
        ? t('documents.state.saving')
        : dirty
          ? t('documents.state.dirty')
          : t('documents.state.saved');

  return (
    <div className="doc-editor">
      <Input
        className="doc-editor__title-field"
        aria-label={t('documents.titleLabel')}
        value={draft.title}
        maxLength={MAX_DOCUMENT_TITLE_LENGTH}
        onChange={(event) => setDraft({ ...draft, title: event.target.value })}
        onKeyDown={saveOnShortcut}
        onBlur={save}
      />
      <div className="doc-editor__tabs" role="tablist">
        {(['write', 'preview'] as const).map((name) => (
          <button
            key={name}
            type="button"
            role="tab"
            aria-selected={tab === name}
            className={cx('doc-editor__tab', tab === name && 'doc-editor__tab--on')}
            onClick={() => setTab(name)}
          >
            {t(`documents.tab.${name}`)}
          </button>
        ))}
      </div>
      {tab === 'write' ? (
        <Textarea
          aria-label={t('documents.bodyLabel')}
          value={draft.body}
          rows={16}
          maxLength={MAX_DOCUMENT_LENGTH}
          onChange={(event) => setDraft({ ...draft, body: event.target.value })}
          onKeyDown={saveOnShortcut}
          onBlur={save}
        />
      ) : draft.body.trim() === '' ? (
        <p className="doc-editor__empty">{t('documents.previewEmpty')}</p>
      ) : (
        <MarkdownContent source={draft.body} />
      )}
      <div className="doc-editor__bar">
        {error ? (
          <p className="doc-editor__error" role="alert">
            {error}
          </p>
        ) : (
          <p className="doc-editor__state" role="status">
            {state}
          </p>
        )}
        <Button size="sm" variant="primary" disabled={!dirty} onClick={save}>
          {t('documents.save')}
        </Button>
      </div>
    </div>
  );
}
