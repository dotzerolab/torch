// @vitest-environment jsdom
import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../api.ts';
import { LocaleProvider } from '../design/index.ts';
import { ShellContext, type ShellState } from '../shell/ShellContext.ts';
import type { SyncedAttachment, SyncedIssue, SyncedMember } from '../sync/collections.ts';
import { manualCollection } from '../test/collections.ts';

const mocks = vi.hoisted(() => ({
  collections: {} as Record<string, unknown>,
  enqueue: vi.fn(),
  upload: vi.fn(),
}));
vi.mock('../sync/shapes.ts', () => ({
  syncRegistry: { get: () => ({}), refresh: () => {} },
  useShape: (key: { kind: string }) => mocks.collections[key.kind],
}));
vi.mock('../sync/outbox.ts', () => ({ enqueueWrite: mocks.enqueue }));
vi.mock('./uploadAttachment.ts', () => ({ uploadAttachment: mocks.upload }));

import { AttachmentList } from './AttachmentList.tsx';

const ME = 'aaaaaaaa-0000-4000-8000-000000000001';
const OTHER = 'aaaaaaaa-0000-4000-8000-000000000002';
const GONE = 'aaaaaaaa-0000-4000-8000-000000000009';
const F1 = 'ffffffff-0000-4000-8000-000000000001';
const F2 = 'ffffffff-0000-4000-8000-000000000002';

const member = (id: string, name: string): SyncedMember => ({
  id,
  workspace_id: 'w1',
  name,
  handle: name.toLowerCase(),
  role: 'member',
  locale: 'en',
  deactivated_at: null,
  created_at: '2026-11-01T10:00:00Z',
});
const file = (id: string, over: Partial<SyncedAttachment> = {}): SyncedAttachment => ({
  id,
  workspace_id: 'w1',
  team_id: 't1',
  issue_id: 'i1',
  uploader_id: OTHER,
  file_name: 'notes.pdf',
  content_type: 'application/pdf',
  size_bytes: 2048,
  created_at: '2026-11-26T10:00:00Z',
  ...over,
});

const shell = (role: ShellState['workspace']['role'], memberId: string): ShellState => {
  const teams = [{ id: 't1', workspace_id: 'w1', key: 'ENG', name: 'Engineering', private: false }];
  return {
    workspace: { id: 'w1', name: 'Demo', slug: 'demo', memberId, role },
    teams,
    teamsReady: true,
    team: teams[0] ?? null,
  };
};

async function setup(
  rows: SyncedAttachment[],
  {
    role = 'member',
    memberId = ME,
    readOnly = false,
  }: { role?: ShellState['workspace']['role']; memberId?: string; readOnly?: boolean } = {},
) {
  const files = manualCollection<SyncedAttachment>(`files-${Math.random()}`, (row) => row.id);
  const members = manualCollection<SyncedMember>(`members-${Math.random()}`, (row) => row.id);
  const issues = manualCollection<SyncedIssue>(`issues-${Math.random()}`, (row) => row.id);
  mocks.collections.issueAttachments = files.collection;
  mocks.collections.members = members.collection;
  mocks.collections.issues = issues.collection;
  members.set(member(ME, 'Mia'), member(OTHER, 'Olivia'));
  members.ready();
  issues.ready();
  files.set(...rows);
  files.ready();
  const user = userEvent.setup();
  render(
    <LocaleProvider locale="en">
      <ShellContext.Provider value={shell(role, memberId)}>
        <AttachmentList workspaceId="w1" teamId="t1" issueId="i1" readOnly={readOnly} />
      </ShellContext.Provider>
    </LocaleProvider>,
  );
  await screen.findByTestId('attachment-list');
  return { user, files };
}

const online = (value: boolean) =>
  vi.spyOn(window.navigator, 'onLine', 'get').mockReturnValue(value);

beforeEach(() => {
  mocks.enqueue.mockReset();
  mocks.upload.mockReset();
  mocks.enqueue.mockResolvedValue({ txid: 1 });
});
afterEach(() => vi.restoreAllMocks());

describe('AttachmentList: reading', () => {
  it('shows name, size and who added each file; an image has a thumbnail through the server address, others download', async () => {
    await setup([
      file(F1, { file_name: 'shot.png', content_type: 'image/png', size_bytes: 1_572_864 }),
      file(F2, { file_name: 'notes.pdf', created_at: '2026-11-26T10:05:00Z' }),
    ]);
    const image = screen.getByTestId(`attachment-${F1}`);
    expect(within(image).getByText('shot.png')).toBeInTheDocument();
    expect(within(image).getByText(/1\.5 MB/)).toBeInTheDocument();
    expect(within(image).getByText(/Added by Olivia/)).toBeInTheDocument();
    const thumb = within(image).getByRole('img', { name: 'shot.png' });
    expect(thumb).toHaveAttribute('src', `/api/w/w1/attachments/${F1}/file?inline=1`);

    const doc = screen.getByTestId(`attachment-${F2}`);
    expect(within(doc).queryByRole('img')).toBeNull();
    const link = within(doc).getByRole('link', { name: 'notes.pdf' });
    expect(link).toHaveAttribute('href', `/api/w/w1/attachments/${F2}/file`);
    expect(link).toHaveAttribute('download', 'notes.pdf');
    expect(within(doc).getByText(/2 kB/)).toBeInTheDocument();
  });

  it('never holds a signed address or a storage key', async () => {
    await setup([file(F1, { file_name: 'shot.png', content_type: 'image/png' }), file(F2)]);
    const html = screen.getByTestId('attachment-list').innerHTML;
    expect(html).not.toMatch(/X-Amz|Signature|storage_key|s3\./i);
    for (const element of document.querySelectorAll('[href], [src]')) {
      const address = element.getAttribute('href') ?? element.getAttribute('src') ?? '';
      expect(address.startsWith('/api/w/w1/attachments/')).toBe(true);
    }
  });

  it('names a person the members shape does not hold as a former member, and says when there are no files', async () => {
    await setup([file(F1, { uploader_id: GONE })]);
    expect(screen.getByText(/Added by Former member/)).toBeInTheDocument();
  });

  it('says so when the issue has no files', async () => {
    await setup([]);
    expect(screen.getByText('No files yet.')).toBeInTheDocument();
  });
});

describe('AttachmentList: removing', () => {
  it('a guest has no removal on the file of someone else', async () => {
    await setup([file(F1, { uploader_id: OTHER })], { role: 'guest', memberId: ME });
    expect(screen.queryByRole('button', { name: 'Remove file' })).toBeNull();
  });

  it('a guest may remove a file they added themselves', async () => {
    await setup([file(F1, { uploader_id: ME })], { role: 'guest', memberId: ME });
    expect(screen.getByRole('button', { name: 'Remove file' })).toBeInTheDocument();
  });

  it('a member may remove the file of someone else', async () => {
    await setup([file(F1, { uploader_id: OTHER })]);
    expect(screen.getByRole('button', { name: 'Remove file' })).toBeInTheDocument();
  });

  it('a read-only issue offers no removal', async () => {
    await setup([file(F1, { uploader_id: ME })], { readOnly: true });
    expect(screen.queryByRole('button', { name: 'Remove file' })).toBeNull();
  });

  it('asks first, then queues a DELETE and hides the file', async () => {
    const { user } = await setup([file(F1)]);
    await user.click(screen.getByRole('button', { name: 'Remove file' }));
    expect(mocks.enqueue).not.toHaveBeenCalled();
    expect(screen.getByRole('alertdialog')).toBeInTheDocument();
    await user.click(
      within(screen.getByRole('alertdialog')).getByRole('button', { name: 'Remove file' }),
    );
    await waitFor(() => expect(mocks.enqueue).toHaveBeenCalledTimes(1));
    expect(mocks.enqueue.mock.calls[0]?.[0]).toMatchObject({
      workspaceId: 'w1',
      teamId: 't1',
      method: 'DELETE',
      path: `/api/w/w1/attachments/${F1}`,
    });
    await waitFor(() => expect(screen.queryByTestId(`attachment-${F1}`)).toBeNull());
  });

  it('a refused removal brings the file back and says why', async () => {
    mocks.enqueue.mockRejectedValue(new ApiError(409, 'issue_archived', 'archived'));
    const { user } = await setup([file(F1)]);
    await user.click(screen.getByRole('button', { name: 'Remove file' }));
    await user.click(
      within(screen.getByRole('alertdialog')).getByRole('button', { name: 'Remove file' }),
    );
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'This issue is archived. Unarchive it to change its files.',
    );
    expect(screen.getByTestId(`attachment-${F1}`)).toBeInTheDocument();
  });
});

describe('AttachmentList: uploading', () => {
  const pick = async (user: ReturnType<typeof userEvent.setup>, name = 'shot.png') => {
    const chosen = new File(['x'], name, { type: 'image/png' });
    await user.upload(screen.getByTestId('file-input'), chosen);
    return chosen;
  };

  it('uploads the chosen file for the issue, shows its progress, and keeps it listed until the shape shows it', async () => {
    let report!: (fraction: number) => void;
    let finish!: (value: unknown) => void;
    mocks.upload.mockImplementation((_ctx, _file, onProgress) => {
      report = onProgress;
      return new Promise((resolve) => {
        finish = resolve;
      });
    });
    const { user, files } = await setup([]);
    const chosen = await pick(user);
    expect(mocks.upload).toHaveBeenCalledTimes(1);
    expect(mocks.upload.mock.calls[0]?.[0]).toEqual({ workspaceId: 'w1', issueId: 'i1' });
    expect(mocks.upload.mock.calls[0]?.[1]).toBe(chosen);

    await act(async () => report(0.5));
    expect(screen.getByRole('progressbar', { name: 'Uploading shot.png' })).toHaveValue(0.5);

    await act(async () => finish({ id: F1, status: 'ready' }));
    // Published, but the shape has not shown it yet: the row stays.
    expect(screen.getByTestId('upload')).toBeInTheDocument();
    await act(async () => {
      files.set(file(F1, { file_name: 'shot.png', content_type: 'image/png' }));
    });
    await waitFor(() => expect(screen.queryByTestId('upload')).toBeNull());
    expect(screen.getByTestId(`attachment-${F1}`)).toBeInTheDocument();
  });

  it("a refused upload says why in the person's language and can be dismissed", async () => {
    mocks.upload.mockRejectedValue(new ApiError(415, 'file_type_not_allowed', 'no'));
    const { user } = await setup([]);
    await pick(user, 'page.html');
    expect(await screen.findByText('This type of file is not allowed.')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Dismiss' }));
    expect(screen.queryByTestId('upload')).toBeNull();
  });

  it('names the size limit when the file is too large', async () => {
    mocks.upload.mockRejectedValue(new ApiError(413, 'file_too_large', 'big'));
    const { user } = await setup([]);
    await pick(user);
    expect(await screen.findByText('The file is larger than 25 MB.')).toBeInTheDocument();
  });

  it('a network failure says nothing was uploaded', async () => {
    mocks.upload.mockRejectedValue(new ApiError(0, 'network', 'down'));
    const { user } = await setup([]);
    await pick(user);
    expect(
      await screen.findByText('Could not reach the server. Nothing was uploaded.'),
    ).toBeInTheDocument();
  });

  it('cancelling aborts the upload and takes it off the list', async () => {
    let signal!: AbortSignal;
    mocks.upload.mockImplementation(
      (_ctx, _file, _progress, abort: AbortSignal) =>
        new Promise((_resolve, reject) => {
          signal = abort;
          abort.addEventListener('abort', () => reject(new DOMException('x', 'AbortError')));
        }),
    );
    const { user } = await setup([]);
    await pick(user);
    await user.click(screen.getByRole('button', { name: 'Cancel upload' }));
    expect(signal.aborted).toBe(true);
    await waitFor(() => expect(screen.queryByTestId('upload')).toBeNull());
  });

  it('uploads files one after the other', async () => {
    const finishers: Array<(value: unknown) => void> = [];
    mocks.upload.mockImplementation(
      () =>
        new Promise((resolve) => {
          finishers.push(resolve);
        }),
    );
    const { user } = await setup([]);
    await user.upload(screen.getByTestId('file-input'), [
      new File(['a'], 'a.txt', { type: 'text/plain' }),
      new File(['b'], 'b.txt', { type: 'text/plain' }),
    ]);
    expect(mocks.upload).toHaveBeenCalledTimes(1);
    await act(async () => finishers[0]?.({ id: F1 }));
    await waitFor(() => expect(mocks.upload).toHaveBeenCalledTimes(2));
  });

  it('on an archived issue the chooser is off and the note says files cannot change', async () => {
    await setup([], { readOnly: true });
    expect(screen.getByRole('button', { name: 'Upload file' })).toBeDisabled();
    expect(
      screen.getByText('This issue is archived, so files cannot be added or removed.'),
    ).toBeInTheDocument();
  });

  it('offline the chooser is off and the note says uploads need a connection', async () => {
    online(false);
    await setup([]);
    expect(screen.getByRole('button', { name: 'Upload file' })).toBeDisabled();
    expect(screen.getByText('Uploads need a connection.')).toBeInTheDocument();
  });
});
