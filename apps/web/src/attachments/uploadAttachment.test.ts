import { MAX_ATTACHMENT_BYTES } from '@torch/shared/mutations/attachment';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../api.ts';
import type { AttachmentDto, UploadRequest } from './types.ts';
import {
  contentTypeOf,
  describeFile,
  type UploadDeps,
  uploadAttachment,
} from './uploadAttachment.ts';

class FakeXhr {
  static last: FakeXhr | null = null;
  withCredentials = true;
  status = 0;
  method = '';
  url = '';
  headers: Record<string, string> = {};
  body: unknown = null;
  aborted = false;
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onabort: (() => void) | null = null;
  ontimeout: (() => void) | null = null;
  upload: {
    onprogress:
      | ((event: { lengthComputable: boolean; loaded: number; total: number }) => void)
      | null;
  } = {
    onprogress: null,
  };
  constructor() {
    FakeXhr.last = this;
  }
  open(method: string, url: string) {
    this.method = method;
    this.url = url;
  }
  setRequestHeader(name: string, value: string) {
    this.headers[name] = value;
  }
  send(body: unknown) {
    this.body = body;
  }
  abort() {
    this.aborted = true;
    this.onabort?.();
  }
  answer(status: number) {
    this.status = status;
    this.onload?.();
  }
}

const attachment = (over: Partial<AttachmentDto> = {}): AttachmentDto => ({
  id: 'a1',
  issueId: 'i1',
  fileName: 'shot.png',
  contentType: 'image/png',
  size: 5,
  uploaderId: 'm1',
  createdAt: '2026-11-26T10:00:00Z',
  status: 'pending',
  ...over,
});
const post: UploadRequest = {
  url: 'http://storage.example.test/bucket',
  method: 'POST',
  fields: { key: 'k', policy: 'p', 'Content-Type': 'image/png' },
};

function deps(upload: UploadRequest = post) {
  const calls: Array<{ path: string; init?: RequestInit }> = [];
  const api = vi.fn(async (path: string, init?: RequestInit) => {
    calls.push({ path, init });
    if (path.endsWith('/complete')) return { attachment: attachment({ status: 'ready' }) };
    return { attachment: attachment(), upload };
  });
  const made: UploadDeps = {
    api: api as unknown as UploadDeps['api'],
    createRequest: () => new FakeXhr() as unknown as XMLHttpRequest,
  };
  return { made, calls, api };
}
const png = () => new File([new Uint8Array([1, 2, 3, 4, 5])], 'shot.png', { type: 'image/png' });
const ctx = { workspaceId: 'w1', issueId: 'i1' };
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

beforeEach(() => {
  FakeXhr.last = null;
});

describe('uploadAttachment: refused before any request', () => {
  it('a file over the limit', async () => {
    const { made, api } = deps();
    const big = new File([new Uint8Array(8)], 'big.png', { type: 'image/png' });
    Object.defineProperty(big, 'size', { value: MAX_ATTACHMENT_BYTES + 1 });
    await expect(
      uploadAttachment(ctx, big, vi.fn(), new AbortController().signal, made),
    ).rejects.toMatchObject({
      code: 'file_too_large',
      status: 413,
    });
    expect(api).not.toHaveBeenCalled();
    expect(FakeXhr.last).toBeNull();
  });

  it.each([
    ['page.html', 'text/html'],
    ['logo.svg', 'image/svg+xml'],
    ['data.xml', 'application/xml'],
    ['run.js', 'text/javascript'],
    ['shot.png', 'text/html'],
    ['movie.mp4', 'video/mp4'],
  ])('%s declared as %s', async (name, type) => {
    const { made, api } = deps();
    const file = new File(['x'], name, { type });
    await expect(
      uploadAttachment(ctx, file, vi.fn(), new AbortController().signal, made),
    ).rejects.toMatchObject({
      code: 'file_type_not_allowed',
      status: 415,
    });
    expect(api).not.toHaveBeenCalled();
  });

  it('an empty file', async () => {
    const { made, api } = deps();
    const file = new File([], 'empty.txt', { type: 'text/plain' });
    await expect(
      uploadAttachment(ctx, file, vi.fn(), new AbortController().signal, made),
    ).rejects.toMatchObject({
      code: 'invalid_input',
    });
    expect(api).not.toHaveBeenCalled();
  });
});

describe('contentTypeOf and describeFile', () => {
  it('takes the type the browser gives, and the extension when it gives none', () => {
    expect(contentTypeOf({ name: 'a.png', type: 'image/png' })).toBe('image/png');
    expect(contentTypeOf({ name: 'notes.md', type: '' })).toBe('text/markdown');
    expect(contentTypeOf({ name: 'data.CSV', type: 'application/octet-stream' })).toBe('text/csv');
    expect(contentTypeOf({ name: 'page.html', type: '' })).toBe('');
    expect(contentTypeOf({ name: 'noextension', type: '' })).toBe('');
  });

  it('keeps the name, the allowed type and the size for init', () => {
    expect(describeFile({ name: 'notes.md', type: '', size: 10 })).toEqual({
      fileName: 'notes.md',
      contentType: 'text/markdown',
      size: 10,
    });
  });
});

describe('uploadAttachment: the sequence', () => {
  it('init, then the file to the storage, then complete; policy fields come before the file', async () => {
    const { made, calls } = deps();
    const progress = vi.fn();
    const sent = uploadAttachment(ctx, png(), progress, new AbortController().signal, made);
    await tick();

    expect(calls[0]?.path).toBe('/api/w/w1/issues/i1/attachments');
    expect(calls[0]?.init?.method).toBe('POST');
    expect(JSON.parse(String(calls[0]?.init?.body))).toEqual({
      fileName: 'shot.png',
      contentType: 'image/png',
      size: 5,
    });

    const request = FakeXhr.last as FakeXhr;
    expect(request.method).toBe('POST');
    expect(request.url).toBe('http://storage.example.test/bucket');
    // No cookie travels to the storage host.
    expect(request.withCredentials).toBe(false);
    const form = request.body as FormData;
    expect([...form.keys()]).toEqual(['key', 'policy', 'Content-Type', 'file']);
    expect(form.get('policy')).toBe('p');
    expect((form.get('file') as File).name).toBe('shot.png');
    // Complete waits for the storage.
    expect(calls).toHaveLength(1);

    request.upload.onprogress?.({ lengthComputable: true, loaded: 2, total: 5 });
    request.upload.onprogress?.({ lengthComputable: true, loaded: 5, total: 5 });
    request.answer(204);
    const done = await sent;

    expect(calls[1]?.path).toBe('/api/w/w1/attachments/a1/complete');
    expect(calls[1]?.init?.method).toBe('POST');
    expect(done.status).toBe('ready');
    expect(progress.mock.calls.map((call) => call[0])).toEqual([0.4, 1, 1]);
  });

  it('sends a PUT request as the raw file with the signed headers', async () => {
    const { made } = deps({
      url: 'http://storage.example.test/obj',
      method: 'PUT',
      headers: { 'Content-Type': 'image/png', 'x-amz-meta': 'v' },
    });
    const file = png();
    const sent = uploadAttachment(ctx, file, vi.fn(), new AbortController().signal, made);
    await tick();
    const request = FakeXhr.last as FakeXhr;
    expect(request.method).toBe('PUT');
    expect(request.headers).toEqual({ 'Content-Type': 'image/png', 'x-amz-meta': 'v' });
    expect(request.body).toBe(file);
    request.answer(200);
    await sent;
  });

  it('aborting stops the send and never calls complete', async () => {
    const { made, calls } = deps();
    const controller = new AbortController();
    const sent = uploadAttachment(ctx, png(), vi.fn(), controller.signal, made);
    const outcome = expect(sent).rejects.toMatchObject({ name: 'AbortError' });
    await tick();
    controller.abort();
    await outcome;
    expect((FakeXhr.last as FakeXhr).aborted).toBe(true);
    expect(calls.map((call) => call.path)).toEqual(['/api/w/w1/issues/i1/attachments']);
  });

  it('an upload aborted before the file is sent never starts the send', async () => {
    const { made, api } = deps();
    const controller = new AbortController();
    controller.abort();
    await expect(
      uploadAttachment(ctx, png(), vi.fn(), controller.signal, made),
    ).rejects.toMatchObject({
      name: 'AbortError',
    });
    expect(api).not.toHaveBeenCalled();
  });
});

describe('uploadAttachment: what goes wrong after init', () => {
  async function failWith(status: number) {
    const { made, calls } = deps();
    const sent = uploadAttachment(ctx, png(), vi.fn(), new AbortController().signal, made);
    const outcome = sent.then(
      () => null,
      (error: unknown) => error,
    );
    await tick();
    (FakeXhr.last as FakeXhr).answer(status);
    return { error: await outcome, calls };
  }

  it('a 403 from the storage reads as a rejected file, and complete is not called', async () => {
    const { error, calls } = await failWith(403);
    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({ code: 'file_rejected' });
    expect(calls).toHaveLength(1);
  });

  it('a 400 from the storage (the signed size or type did not hold) reads as a rejected file', async () => {
    expect((await failWith(400)).error).toMatchObject({ code: 'file_rejected' });
  });

  it('a 503 from the storage reads as storage unavailable', async () => {
    expect((await failWith(503)).error).toMatchObject({ code: 'storage_unavailable' });
  });

  it('a lost connection reads as a network failure', async () => {
    const { made } = deps();
    const sent = uploadAttachment(ctx, png(), vi.fn(), new AbortController().signal, made);
    const outcome = expect(sent).rejects.toMatchObject({ code: 'network', status: 0 });
    await tick();
    (FakeXhr.last as FakeXhr).onerror?.();
    await outcome;
  });

  it('passes on what the server answers to init', async () => {
    const { made } = deps();
    made.api = vi.fn(async () => {
      throw new ApiError(409, 'issue_archived', 'archived');
    }) as unknown as UploadDeps['api'];
    await expect(
      uploadAttachment(ctx, png(), vi.fn(), new AbortController().signal, made),
    ).rejects.toMatchObject({ code: 'issue_archived' });
    expect(FakeXhr.last).toBeNull();
  });
});
