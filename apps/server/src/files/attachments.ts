// Issue attachments (spec section 16). The file never passes through this server: `initAttachment` stores a pending row
// and hands the browser a presigned upload request whose policy pins the key, the type and the size range; the
// browser sends the file to the storage; `completeAttachment` then verifies the stored object (size, type, first bytes)
// and publishes the row; reads are a signed URL of 60 seconds minted after the permission check, never stored or logged.
//
// Rows are `pending` until verified and only `ready` rows are listed or synced. An object is never removed before the
// database says it should be: a removal first turns the row into a "queued removal" (pending, created at the epoch, so
// the 24-hour rule of `cleanupExpiredRows` picks it up), then, after the commit, removes the object and the row. If that
// last step fails, the cleanup job tries again; nothing is left dangling either way. No function here logs a URL, a key
// or a storage message.
import { type AttachmentRow, attachment, team } from '@torch/shared/db/schema';
import {
  ATTACHMENT_TYPES,
  attachmentInitInput,
  MAX_ATTACHMENT_BYTES,
  MAX_ATTACHMENTS_PER_ISSUE,
  safeFileName,
} from '@torch/shared/mutations/attachment';
import { canAttach, canRemoveAttachment, canSeeTeam } from '@torch/shared/permissions';
import { and, asc, count, eq, gt, isNull, or, sql } from 'drizzle-orm';
import { recordIssueChange } from '../activity/record.ts';
import { PENDING_UPLOAD_MAX_AGE_MS } from '../db/cleanup.ts';
import type { Orm, Tx } from '../db.ts';
import { type ChangeResult, changeIssueJoin } from '../issues/join-changes.ts';
import { readableIssue } from '../issues/readable-issue.ts';
import { type Failure, refuse } from '../issues/update-issue.ts';
import { currentTxid } from '../mutations/txid.ts';
import { currentActor } from '../permissions/current-actor.ts';
import type { ClientActor } from '../permissions/load-actor.ts';
import { isUuid } from '../util/uuid.ts';
import { sniffMatches } from './sniff.ts';
import type { FileStorage, UploadRequest } from './storage.ts';

export type AttachmentDto = {
  id: string;
  issueId: string;
  fileName: string;
  contentType: string;
  size: number;
  uploaderId: string;
  createdAt: string;
  status: 'pending' | 'ready';
};

export type AttachmentResult<T> = ChangeResult<T>;
/** A read: the value, or the refusal. There is no transaction id to wait for. */
export type AttachmentReadResult<T> = { ok: true; value: T } | Failure;

/** Pending uploads one person may have open at the same time. */
export const MAX_PENDING_UPLOADS_PER_MEMBER = 10;
/** A signed upload request is good for this long. */
export const UPLOAD_LIFETIME_SECONDS = 300;
/** A signed download URL is good for this long. */
export const DOWNLOAD_LIFETIME_SECONDS = 60;
/** How many leading bytes the type check reads. */
const SNIFF_BYTES = 512;
/** The created-at of a row that queued its own removal: older than any limit, so the next cleanup run takes it. */
const QUEUED_AT = new Date(0);

const keyOf = (workspaceId: string, attachmentId: string) =>
  `workspaces/${workspaceId}/attachments/${attachmentId}`;

export function toAttachmentDto(row: AttachmentRow): AttachmentDto {
  return {
    id: row.id,
    issueId: row.issueId,
    fileName: row.fileName,
    contentType: row.contentType,
    size: row.sizeBytes,
    uploaderId: row.uploaderId,
    createdAt: row.createdAt.toISOString(),
    status: row.status,
  };
}

const staleBefore = (now = Date.now()) => new Date(now - PENDING_UPLOAD_MAX_AGE_MS);
const isStale = (row: AttachmentRow) => row.status === 'pending' && row.createdAt < staleBefore();

/** The id of the issue an attachment belongs to, within the actor's workspace. */
async function issueIdOf(
  orm: Orm,
  workspaceId: string,
  attachmentId: string,
): Promise<string | null> {
  if (!isUuid(attachmentId)) return null;
  const [row] = await orm
    .select({ issueId: attachment.issueId })
    .from(attachment)
    .where(and(eq(attachment.workspaceId, workspaceId), eq(attachment.id, attachmentId)));
  return row?.issueId ?? null;
}

async function lockAttachment(tx: Tx, workspaceId: string, attachmentId: string) {
  const [row] = await tx
    .select()
    .from(attachment)
    .where(and(eq(attachment.workspaceId, workspaceId), eq(attachment.id, attachmentId)))
    .for('no key update');
  return row;
}

/** Turns a row into a queued removal: pending, as old as can be, never visible, never completable. */
const queueRemoval = (tx: Tx, row: AttachmentRow) =>
  tx
    .update(attachment)
    .set({ status: 'pending', readyAt: null, createdAt: QUEUED_AT })
    .where(and(eq(attachment.workspaceId, row.workspaceId), eq(attachment.id, row.id)));

/** After the commit: removes the object, then the row. A failure leaves the queued row for the cleanup job. */
async function finishRemoval(orm: Orm, storage: FileStorage, row: AttachmentRow): Promise<void> {
  try {
    await storage.remove(row.storageKey);
    await orm
      .delete(attachment)
      .where(
        and(
          eq(attachment.workspaceId, row.workspaceId),
          eq(attachment.id, row.id),
          eq(attachment.status, 'pending'),
        ),
      );
  } catch {
    // The queued row stays; the next cleanup run removes the object and the row.
  }
}

const storageUnavailable = () => refuse('storage_unavailable', 503);

/**
 * Starts an upload: validates what the browser declares, stores a pending row and returns the presigned request the
 * browser sends the file with. The row counts towards the 50 files of the issue and towards the 10 open uploads of the
 * person (uploads pending for over 24 hours count for neither). Nothing about the issue changes yet: a pending file is
 * invisible.
 */
export async function initAttachment(
  orm: Orm,
  storage: FileStorage,
  requested: ClientActor,
  issueId: string,
  input: { fileName: string; contentType: string; size: number },
): Promise<AttachmentResult<{ attachment: AttachmentDto; upload: UploadRequest }>> {
  const parsed = attachmentInitInput.safeParse(input);
  if (!parsed.success) {
    const raw = (input ?? {}) as Record<string, unknown>;
    const declared =
      typeof raw.contentType === 'string' ? raw.contentType.trim().toLowerCase() : null;
    if (declared !== null && !Object.hasOwn(ATTACHMENT_TYPES, declared)) {
      return refuse('file_type_not_allowed', 415);
    }
    if (
      typeof raw.size === 'number' &&
      Number.isInteger(raw.size) &&
      raw.size > MAX_ATTACHMENT_BYTES
    ) {
      return refuse('file_too_large', 413, { details: { maxBytes: storage.maxBytes } });
    }
    const first = parsed.error.issues[0];
    const where = first?.path.length ? `${first.path.join('.')}: ` : '';
    return refuse('invalid_input', 400, { message: `${where}${first?.message ?? ''}` });
  }
  const data = parsed.data;
  if (data.size > storage.maxBytes) {
    return refuse('file_too_large', 413, { details: { maxBytes: storage.maxBytes } });
  }

  return changeIssueJoin(orm, requested, issueId, 'see', async ({ tx, actor, access, row }) => {
    if (!canAttach(actor, access)) return refuse('forbidden', 403);

    // Under the issue lock, so two uploads cannot both take the last place. The per-person count spans issues and is
    // checked without a lock of its own: a few parallel uploads of one person may overshoot it by a little.
    const live = or(eq(attachment.status, 'ready'), gt(attachment.createdAt, staleBefore()));
    const [onIssue] = await tx
      .select({ total: count() })
      .from(attachment)
      .where(and(eq(attachment.issueId, row.id), live));
    if ((onIssue?.total ?? 0) >= MAX_ATTACHMENTS_PER_ISSUE)
      return refuse('too_many_attachments', 409);
    const [open] = await tx
      .select({ total: count() })
      .from(attachment)
      .where(
        and(
          eq(attachment.workspaceId, actor.workspaceId),
          eq(attachment.uploaderId, actor.memberId),
          eq(attachment.status, 'pending'),
          gt(attachment.createdAt, staleBefore()),
        ),
      );
    if ((open?.total ?? 0) >= MAX_PENDING_UPLOADS_PER_MEMBER) return refuse('rate_limited', 429);

    const id = crypto.randomUUID();
    const [created] = await tx
      .insert(attachment)
      .values({
        id,
        workspaceId: actor.workspaceId,
        teamId: row.teamId,
        issueId: row.id,
        uploaderId: actor.memberId,
        fileName: safeFileName(data.fileName),
        contentType: data.contentType,
        sizeBytes: data.size,
        storageKey: keyOf(actor.workspaceId, id),
        status: 'pending',
        createdAt: sql`clock_timestamp()`,
      })
      .returning();
    if (!created) throw new Error('attachment insert returned no row');

    let upload: UploadRequest;
    try {
      upload = await storage.presignUpload({
        key: created.storageKey,
        contentType: created.contentType,
        size: created.sizeBytes,
        expiresInSeconds: UPLOAD_LIFETIME_SECONDS,
      });
    } catch {
      // Nothing was written yet that must survive: a failed presign is not an attachment.
      await tx.delete(attachment).where(eq(attachment.id, id));
      return storageUnavailable();
    }
    return { value: { attachment: toAttachmentDto(created), upload }, changed: false };
  });
}

/**
 * Verifies the stored object against what was declared (size, stored type, first bytes) and publishes the row. Only
 * the uploader completes. A file that does not match is removed with its row and answers 422 `file_rejected`; a missing
 * object answers the same and leaves the row pending, so the upload can be sent again. Doing it twice changes nothing.
 */
export async function completeAttachment(
  orm: Orm,
  storage: FileStorage,
  requested: ClientActor,
  attachmentId: string,
): Promise<AttachmentResult<AttachmentDto>> {
  const issueId = await issueIdOf(orm, requested.workspaceId, attachmentId);
  if (!issueId) return refuse('not_found', 404);

  let rejected: AttachmentRow | undefined;
  const result = await changeIssueJoin(
    orm,
    requested,
    issueId,
    'see',
    async ({ tx, actor, access }) => {
      const row = await lockAttachment(tx, actor.workspaceId, attachmentId);
      if (!row || isStale(row)) return refuse('not_found', 404);
      if (!canAttach(actor, access)) return refuse('forbidden', 403);
      if (row.uploaderId !== actor.memberId) return refuse('forbidden', 403);
      if (row.status === 'ready') return { value: toAttachmentDto(row), changed: false };

      let head: Awaited<ReturnType<FileStorage['head']>>;
      let start: Uint8Array = new Uint8Array();
      try {
        head = await storage.head(row.storageKey);
        if (head) start = await storage.readStart(row.storageKey, SNIFF_BYTES);
      } catch {
        return storageUnavailable();
      }
      if (!head) {
        return refuse('file_rejected', 422, { message: 'The file has not been uploaded.' });
      }

      const declaredType = row.contentType.toLowerCase();
      const storedType = head.contentType?.trim().toLowerCase() ?? null;
      if (
        head.size !== row.sizeBytes ||
        storedType !== declaredType ||
        !sniffMatches(declaredType, start)
      ) {
        await queueRemoval(tx, row);
        rejected = row;
        return refuse('file_rejected', 422);
      }

      const [published] = await tx
        .update(attachment)
        .set({ status: 'ready', readyAt: sql`clock_timestamp()` })
        .where(and(eq(attachment.workspaceId, row.workspaceId), eq(attachment.id, row.id)))
        .returning();
      if (!published) throw new Error('attachment update returned no row');
      await recordIssueChange(tx, actor, {
        kind: 'attachment',
        issueId: row.issueId,
        op: 'added',
        data: {
          attachmentId: row.id,
          fileName: row.fileName,
          size: row.sizeBytes,
          contentType: row.contentType,
        },
      });
      return { value: toAttachmentDto(published), changed: true };
    },
  );

  if (rejected) await finishRemoval(orm, storage, rejected);
  return result;
}

/**
 * A signed URL for one file, valid for 60 seconds, minted after the permission check and never stored. The actor is
 * read again from the database: a person removed from the team, or deactivated, since their request was resolved gets
 * nothing. `inline` is honoured only for a raster image whose name carries the image's own extension; everything else
 * is an attachment.
 */
export async function readAttachmentUrl(
  orm: Orm,
  storage: FileStorage,
  requested: ClientActor,
  attachmentId: string,
  opts: { inline: boolean },
): Promise<AttachmentReadResult<string>> {
  if (!isUuid(attachmentId)) return refuse('not_found', 404);

  const found = await orm.transaction(async (tx) => {
    const fresh = await currentActor(tx, requested);
    if (!fresh) return refuse('unauthenticated', 401);
    const [row] = await tx
      .select({ file: attachment, private: team.private })
      .from(attachment)
      .innerJoin(
        team,
        and(eq(team.workspaceId, attachment.workspaceId), eq(team.id, attachment.teamId)),
      )
      .where(and(eq(attachment.workspaceId, fresh.workspaceId), eq(attachment.id, attachmentId)));
    if (row?.file.status !== 'ready') return refuse('not_found', 404);
    const access = { id: row.file.teamId, workspaceId: fresh.workspaceId, private: row.private };
    if (!canSeeTeam(fresh, access)) return refuse('not_found', 404);
    return row.file;
  });
  if ('ok' in found) return found;

  const spec = Object.hasOwn(ATTACHMENT_TYPES, found.contentType)
    ? ATTACHMENT_TYPES[found.contentType]
    : undefined;
  const extension = found.fileName.split('.').pop()?.toLowerCase() ?? '';
  const inline = opts.inline && !!spec?.inline && spec.extensions.includes(extension);
  try {
    const url = await storage.presignDownload({
      key: found.storageKey,
      fileName: found.fileName,
      contentType: found.contentType,
      inline,
      expiresInSeconds: DOWNLOAD_LIFETIME_SECONDS,
    });
    return { ok: true, value: url };
  } catch {
    return storageUnavailable();
  }
}

/**
 * Removes a file: its uploader, or anybody but a guest who can see the team. The row stops being visible at once, in
 * the same transaction as its activity entry; the object follows right after the commit, and the cleanup job finishes
 * the job if the storage was not reachable. A pending upload can only be cancelled by its uploader.
 */
export async function removeAttachment(
  orm: Orm,
  storage: FileStorage,
  requested: ClientActor,
  attachmentId: string,
): Promise<AttachmentResult<null>> {
  const issueId = await issueIdOf(orm, requested.workspaceId, attachmentId);
  if (!issueId) return refuse('not_found', 404);

  let removed: AttachmentRow | undefined;
  const result = await changeIssueJoin(
    orm,
    requested,
    issueId,
    'see',
    async ({ tx, actor, access }) => {
      const row = await lockAttachment(tx, actor.workspaceId, attachmentId);
      if (!row || isStale(row)) return refuse('not_found', 404);
      // A pending upload exists for its uploader only.
      if (row.status === 'pending' && row.uploaderId !== actor.memberId)
        return refuse('not_found', 404);
      if (!canRemoveAttachment(actor, access, row)) return refuse('forbidden', 403);

      await queueRemoval(tx, row);
      removed = row;
      if (row.status === 'ready') {
        await recordIssueChange(tx, actor, {
          kind: 'attachment',
          issueId: row.issueId,
          op: 'removed',
          data: {
            attachmentId: row.id,
            fileName: row.fileName,
            size: row.sizeBytes,
            contentType: row.contentType,
          },
        });
      }
      return { value: null, changed: row.status === 'ready' };
    },
  );

  if (result.ok && removed) await finishRemoval(orm, storage, removed);
  return result;
}

/** The ready files of an issue, oldest first. 404 for an issue the actor cannot see. */
export async function listAttachments(
  orm: Orm,
  actor: ClientActor,
  issueId: string,
): Promise<AttachmentReadResult<AttachmentDto[]>> {
  if (!isUuid(issueId)) return refuse('not_found', 404);
  if (!(await readableIssue(orm, actor, issueId))) return refuse('not_found', 404);
  const rows = await orm
    .select()
    .from(attachment)
    .where(
      and(
        eq(attachment.workspaceId, actor.workspaceId),
        eq(attachment.issueId, issueId),
        eq(attachment.status, 'ready'),
      ),
    )
    .orderBy(asc(attachment.readyAt), asc(attachment.id));
  return { ok: true, value: rows.map(toAttachmentDto) };
}

export { currentTxid, isNull };
