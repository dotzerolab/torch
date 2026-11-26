import { ATTACHMENT_TYPES } from '@torch/shared/mutations/attachment';
import { canAttach, canRemoveAttachment } from '@torch/shared/permissions';
import { File as FileIcon, Trash2, X } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { formatMoment } from '../comments/format.ts';
import { issueObjectKey, refreshAfterWrite } from '../comments/refresh.ts';
import { useActor } from '../comments/useActor.ts';
import { useMembers } from '../comments/useMembers.ts';
import { Button, IconButton, Skeleton, useLocale, useT } from '../design/index.ts';
import { enqueueWrite } from '../sync/outbox.ts';
import { attachmentErrorMessage, formatSize } from './errors.ts';
import { UploadButton } from './UploadButton.tsx';
import { uploadAttachment } from './uploadAttachment.ts';
import { useIssueAttachments } from './useIssueAttachments.ts';
import { useOnline } from './useOnline.ts';
import './attachments.css';

type Upload = {
  key: number;
  file: File;
  fraction: number;
  status: 'uploading' | 'done' | 'error';
  /** The id of the published file, once the upload is done: the row stays until the shape shows the file. */
  id?: string;
  error?: string;
  abort: AbortController;
};

/**
 * The files of one issue and where new ones come in. Reads the `issueAttachments` shape; uploads go from the browser
 * straight to the storage (never through the server), one after the other, and need a connection. The page never holds a
 * signed address: a thumbnail or a download is the server's own `/file` address, which redirects to a 60-second one after
 * checking the person may read it. `readOnly` (an archived issue) turns adding and removing off; the permission rules are
 * checked here as well and the server decides again.
 */
export function AttachmentList({
  workspaceId,
  teamId,
  issueId,
  readOnly,
}: {
  workspaceId: string;
  teamId: string;
  issueId: string;
  readOnly: boolean;
}) {
  const t = useT();
  const locale = useLocale();
  const online = useOnline();
  const { actor, team } = useActor(teamId);
  const { attachments, ready } = useIssueAttachments(workspaceId, teamId, issueId);
  const { byId } = useMembers(workspaceId);
  const [uploads, setUploads] = useState<Upload[]>([]);
  const [removed, setRemoved] = useState<ReadonlySet<string>>(new Set());
  const [confirming, setConfirming] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const queue = useRef<Promise<void>>(Promise.resolve());
  const counter = useRef(0);

  const allowed = !readOnly && team !== null && canAttach(actor, team);
  const note = readOnly ? t('attachments.readOnly') : online ? undefined : t('attachments.offline');

  // A finished upload stays in the list until the shape shows its file, so the file never blinks out and back.
  useEffect(() => {
    const shown = new Set(attachments.map((file) => file.id));
    if (!uploads.some((upload) => upload.status === 'done' && upload.id && shown.has(upload.id))) {
      return;
    }
    setUploads((current) =>
      current.filter((upload) => !(upload.status === 'done' && upload.id && shown.has(upload.id))),
    );
  }, [attachments, uploads]);
  useEffect(() => {
    if (!uploads.some((upload) => upload.status === 'done')) return;
    const timer = setTimeout(
      () => setUploads((current) => current.filter((upload) => upload.status !== 'done')),
      10_000,
    );
    return () => clearTimeout(timer);
  }, [uploads]);

  const patch = (key: number, change: Partial<Upload>) =>
    setUploads((current) =>
      current.map((upload) => (upload.key === key ? { ...upload, ...change } : upload)),
    );

  const start = (file: File) => {
    counter.current += 1;
    const entry: Upload = {
      key: counter.current,
      file,
      fraction: 0,
      status: 'uploading',
      abort: new AbortController(),
    };
    setUploads((current) => [...current, entry]);
    queue.current = queue.current.then(async () => {
      if (entry.abort.signal.aborted) return;
      try {
        const done = await uploadAttachment(
          { workspaceId, issueId },
          file,
          (fraction) => patch(entry.key, { fraction }),
          entry.abort.signal,
        );
        refreshAfterWrite(issueObjectKey('issueAttachments', workspaceId, teamId, issueId));
        patch(entry.key, { status: 'done', fraction: 1, id: done.id });
      } catch (failure) {
        if (failure instanceof DOMException && failure.name === 'AbortError') {
          setUploads((current) => current.filter((upload) => upload.key !== entry.key));
        } else {
          patch(entry.key, { status: 'error', error: attachmentErrorMessage(locale, failure) });
        }
      }
    });
  };

  const onFiles = (files: File[]) => {
    setError(null);
    for (const file of files) start(file);
  };

  const remove = (id: string) => {
    setConfirming(null);
    setError(null);
    setRemoved((current) => new Set([...current, id]));
    enqueueWrite({
      workspaceId,
      teamId,
      method: 'DELETE',
      path: `/api/w/${workspaceId}/attachments/${id}`,
      idempotencyKey: crypto.randomUUID(),
    }).then(
      () => refreshAfterWrite(issueObjectKey('issueAttachments', workspaceId, teamId, issueId)),
      (failure: unknown) => {
        setRemoved((current) => new Set([...current].filter((other) => other !== id)));
        setError(attachmentErrorMessage(locale, failure));
      },
    );
  };

  const fileHref = (id: string, inline: boolean) =>
    `/api/w/${workspaceId}/attachments/${id}/file${inline ? '?inline=1' : ''}`;
  const visible = attachments.filter((file) => !removed.has(file.id));

  return (
    <section className="files" aria-label={t('attachments.title')} data-testid="attachment-list">
      <h3 className="files__title">{t('attachments.title')}</h3>
      {error ? (
        <p className="files__error" role="alert">
          {error}
        </p>
      ) : null}

      {!ready ? (
        <div aria-busy="true">
          <span className="visually-hidden">{t('common.loading')}</span>
          <Skeleton />
        </div>
      ) : visible.length === 0 && uploads.length === 0 ? (
        <p className="files__empty">{t('attachments.empty')}</p>
      ) : (
        <ul className="files__list">
          {visible.map((file) => {
            const inline = ATTACHMENT_TYPES[file.content_type]?.inline === true;
            const uploader = byId.get(file.uploader_id)?.name ?? t('comments.formerMember');
            const mayRemove =
              allowed &&
              team !== null &&
              canRemoveAttachment(actor, team, { uploaderId: file.uploader_id });
            return (
              <li key={file.id} className="file" data-testid={`attachment-${file.id}`}>
                {inline ? (
                  <a
                    className="file__thumb"
                    href={fileHref(file.id, true)}
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    <img src={fileHref(file.id, true)} alt={file.file_name} loading="lazy" />
                  </a>
                ) : (
                  <span className="file__icon" aria-hidden="true">
                    <FileIcon size={18} />
                  </span>
                )}
                <div className="file__info">
                  <a
                    className="file__name"
                    href={fileHref(file.id, false)}
                    download={file.file_name}
                  >
                    {file.file_name}
                  </a>
                  <span className="file__meta">
                    {formatSize(locale, file.size_bytes)} ·{' '}
                    {t('attachments.by', { name: uploader })} ·{' '}
                    <time dateTime={file.created_at}>{formatMoment(locale, file.created_at)}</time>
                  </span>
                </div>
                {mayRemove ? (
                  <IconButton
                    size="sm"
                    label={t('attachments.remove')}
                    icon={<Trash2 size={14} aria-hidden="true" />}
                    onClick={() => setConfirming(file.id)}
                  />
                ) : null}
                {confirming === file.id ? (
                  <div
                    className="file__confirm"
                    role="alertdialog"
                    aria-label={t('attachments.removeQuestion')}
                  >
                    <p>{t('attachments.removeQuestion')}</p>
                    <Button size="sm" variant="ghost" onClick={() => setConfirming(null)}>
                      {t('common.cancel')}
                    </Button>
                    <Button size="sm" variant="danger" onClick={() => remove(file.id)}>
                      {t('attachments.removeConfirm')}
                    </Button>
                  </div>
                ) : null}
              </li>
            );
          })}
          {uploads.map((upload) => (
            <li key={`upload-${upload.key}`} className="file file--upload" data-testid="upload">
              <span className="file__icon" aria-hidden="true">
                <FileIcon size={18} />
              </span>
              <div className="file__info">
                <span className="file__name">{upload.file.name}</span>
                {upload.status === 'error' ? (
                  <span className="file__problem" role="alert">
                    {upload.error}
                  </span>
                ) : (
                  <progress
                    className="file__progress"
                    max={1}
                    value={upload.fraction}
                    aria-label={t('attachments.uploading', { name: upload.file.name })}
                  />
                )}
              </div>
              {upload.status === 'uploading' ? (
                <IconButton
                  size="sm"
                  label={t('attachments.cancelUpload')}
                  icon={<X size={14} aria-hidden="true" />}
                  onClick={() => upload.abort.abort()}
                />
              ) : upload.status === 'error' ? (
                <IconButton
                  size="sm"
                  label={t('attachments.dismiss')}
                  icon={<X size={14} aria-hidden="true" />}
                  onClick={() =>
                    setUploads((current) => current.filter((other) => other.key !== upload.key))
                  }
                />
              ) : null}
            </li>
          ))}
        </ul>
      )}

      <UploadButton disabled={!allowed || !online} note={note} onFiles={onFiles} />
    </section>
  );
}
