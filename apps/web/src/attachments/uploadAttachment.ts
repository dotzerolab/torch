// One upload, from the browser straight to the storage. The server never sees the file: it presigns a request (`init`),
// the browser sends the file to it, and the server then verifies the stored object and publishes the row (`complete`).
// Every rule the server enforces is checked here first so a refused file costs no request; a failure after `init` leaves
// the row pending, and the server's cleanup removes it a day later.
import {
  ATTACHMENT_TYPES,
  attachmentInitInput,
  MAX_ATTACHMENT_BYTES,
} from '@torch/shared/mutations/attachment';
import { ApiError, apiFetch } from '../api.ts';
import type { AttachmentDto, UploadRequest } from './types.ts';

export type UploadContext = { workspaceId: string; issueId: string };

export type UploadDeps = {
  api: <T>(path: string, init?: RequestInit) => Promise<T>;
  createRequest: () => XMLHttpRequest;
};

const defaultDeps: UploadDeps = { api: apiFetch, createRequest: () => new XMLHttpRequest() };

/** The type a file is sent as: what the browser says, or, when it says nothing useful, what the extension means. */
export function contentTypeOf(file: Pick<File, 'name' | 'type'>): string {
  const declared = file.type.trim().toLowerCase();
  if (declared !== '' && declared !== 'application/octet-stream') return declared;
  const extension = file.name.includes('.') ? (file.name.split('.').pop() ?? '').toLowerCase() : '';
  const known = Object.entries(ATTACHMENT_TYPES).find(([, type]) =>
    type.extensions.includes(extension),
  );
  return known?.[0] ?? declared;
}

/** What `init` carries, after the checks the server makes: type first (html and svg never), then size. */
export function describeFile(file: Pick<File, 'name' | 'type' | 'size'>) {
  const contentType = contentTypeOf(file);
  if (!Object.hasOwn(ATTACHMENT_TYPES, contentType)) {
    throw new ApiError(415, 'file_type_not_allowed', 'This type of file is not allowed.');
  }
  if (file.size > MAX_ATTACHMENT_BYTES) {
    throw new ApiError(413, 'file_too_large', 'The file is larger than the size limit.');
  }
  const parsed = attachmentInitInput.safeParse({
    fileName: file.name,
    contentType,
    size: file.size,
  });
  if (!parsed.success) throw new ApiError(400, 'invalid_input', 'The file is not valid.');
  return parsed.data;
}

const aborted = () => new DOMException('The upload was cancelled.', 'AbortError');

/** Sends the file to the presigned request. No cookie goes to the storage host. */
function sendFile(
  request: XMLHttpRequest,
  file: File,
  upload: UploadRequest,
  onProgress: (fraction: number) => void,
  signal: AbortSignal,
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    if (signal.aborted) {
      reject(aborted());
      return;
    }
    const onAbort = () => request.abort();
    const finish = (settle: () => void) => {
      signal.removeEventListener('abort', onAbort);
      settle();
    };
    request.withCredentials = false;
    request.upload.onprogress = (event) => {
      if (event.lengthComputable && event.total > 0) onProgress(event.loaded / event.total);
    };
    request.onload = () =>
      finish(() => {
        if (request.status >= 200 && request.status < 300) {
          onProgress(1);
          resolve();
        } else if (request.status >= 500) {
          reject(new ApiError(503, 'storage_unavailable', 'File storage is not available.'));
        } else {
          // The storage enforces size, type and lifetime in the request the server signed: a refusal is one of those.
          reject(new ApiError(403, 'file_rejected', 'The storage refused the file.'));
        }
      });
    request.onerror = () =>
      finish(() => reject(new ApiError(0, 'network', 'The storage could not be reached.')));
    request.ontimeout = request.onerror;
    request.onabort = () => finish(() => reject(aborted()));
    signal.addEventListener('abort', onAbort, { once: true });

    request.open(upload.method, upload.url);
    if (upload.method === 'POST') {
      // The signed fields first and the file last: the storage ignores whatever follows the file.
      const form = new FormData();
      for (const [name, value] of Object.entries(upload.fields ?? {})) form.append(name, value);
      form.append('file', file);
      request.send(form);
    } else {
      for (const [name, value] of Object.entries(upload.headers ?? {})) {
        request.setRequestHeader(name, value);
      }
      request.send(file);
    }
  });
}

/**
 * Uploads `file` to the issue. Resolves with the published attachment. Rejects with an `ApiError` whose code names the
 * reason (`file_too_large`, `file_type_not_allowed`, `file_rejected`, `network`, `storage_unavailable`, or what the server
 * answered), or with an `AbortError` when `signal` aborts; an aborted upload never calls `complete`.
 */
export async function uploadAttachment(
  ctx: UploadContext,
  file: File,
  onProgress: (fraction: number) => void,
  signal: AbortSignal,
  deps: UploadDeps = defaultDeps,
): Promise<AttachmentDto> {
  const input = describeFile(file);
  if (signal.aborted) throw aborted();

  const started = await deps.api<{ attachment: AttachmentDto; upload: UploadRequest }>(
    `/api/w/${ctx.workspaceId}/issues/${ctx.issueId}/attachments`,
    { method: 'POST', body: JSON.stringify(input), signal },
  );
  await sendFile(deps.createRequest(), file, started.upload, onProgress, signal);
  const done = await deps.api<{ attachment: AttachmentDto }>(
    `/api/w/${ctx.workspaceId}/attachments/${started.attachment.id}/complete`,
    { method: 'POST', signal },
  );
  return done.attachment;
}
