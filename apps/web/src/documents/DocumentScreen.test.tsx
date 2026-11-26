// @vitest-environment jsdom
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { LocaleProvider } from '../design/index.ts';
import { ShellContext, type ShellState } from '../shell/ShellContext.ts';
import type {
  SyncedDocumentContent,
  SyncedDocumentSummary,
  SyncedMember,
  SyncedTeam,
} from '../sync/collections.ts';
import { manualCollection } from '../test/collections.ts';

const mocks = vi.hoisted(() => ({
  collections: {} as Record<string, unknown>,
  enqueue: vi.fn(),
  apiFetch: vi.fn(),
}));
vi.mock('../sync/shapes.ts', () => ({
  syncRegistry: { get: () => ({}), refresh: () => {} },
  useShape: (key: { kind: string }) => mocks.collections[key.kind],
}));
vi.mock('../sync/outbox.ts', () => ({
  enqueueWrite: mocks.enqueue,
  pendingCount: () => 0,
  subscribePending: () => () => {},
}));
vi.mock('../api.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../api.ts')>()),
  apiFetch: mocks.apiFetch,
}));

import { DocumentScreen } from './DocumentScreen.tsx';

const ME = 'aaaaaaaa-0000-4000-8000-000000000001';
const team: SyncedTeam = {
  id: 't1',
  workspace_id: 'w1',
  key: 'ENG',
  name: 'Engineering',
  private: false,
};

async function setup({
  role = 'member',
  archived = false,
  body = '# Notes',
}: {
  role?: ShellState['workspace']['role'];
  archived?: boolean;
  body?: string;
} = {}) {
  const titles = manualCollection<SyncedDocumentSummary>(`t-${Math.random()}`, (row) => row.id);
  const content = manualCollection<SyncedDocumentContent>(`c-${Math.random()}`, (row) => row.id);
  const members = manualCollection<SyncedMember>(`m-${Math.random()}`, (row) => row.id);
  mocks.collections.documents = titles.collection;
  mocks.collections.documentContent = content.collection;
  mocks.collections.members = members.collection;
  members.set({
    id: ME,
    workspace_id: 'w1',
    name: 'Mia',
    handle: 'mia',
    role: 'member',
    locale: 'en',
    deactivated_at: null,
    created_at: '2026-11-01T10:00:00Z',
  });
  members.ready();
  titles.set({
    id: 'd1',
    workspace_id: 'w1',
    team_id: 't1',
    title: 'Plan',
    created_by: ME,
    updated_by: ME,
    created_at: '2026-11-26T09:00:00Z',
    updated_at: '2026-11-26T10:00:00Z',
    archived_at: archived ? '2026-11-26T11:00:00Z' : null,
  });
  titles.ready();
  content.set({ id: 'd1', workspace_id: 'w1', team_id: 't1', body });
  content.ready();
  const onBack = vi.fn();
  const user = userEvent.setup();
  render(
    <LocaleProvider locale="en">
      <ShellContext.Provider
        value={{
          workspace: { id: 'w1', name: 'Demo', slug: 'demo', memberId: ME, role },
          teams: [team],
          teamsReady: true,
          team,
        }}
      >
        <DocumentScreen workspaceId="w1" team={team} documentId="d1" onBack={onBack} />
      </ShellContext.Provider>
    </LocaleProvider>,
  );
  await screen.findByTestId('document-screen');
  return { user, onBack };
}

beforeEach(() => {
  mocks.enqueue.mockReset();
  mocks.apiFetch.mockReset();
  mocks.enqueue.mockResolvedValue({ txid: 1 });
});

describe('DocumentScreen', () => {
  it('a member edits the document: title and text are fields', async () => {
    await setup();
    expect(await screen.findByRole('textbox', { name: 'Title' })).toHaveValue('Plan');
    expect(screen.getByRole('textbox', { name: 'Document text' })).toHaveValue('# Notes');
  });

  it('a guest reads the document and has no editor, no history and no archive', async () => {
    await setup({ role: 'guest' });
    expect(
      await screen.findByText('You can read this document but not edit it.'),
    ).toBeInTheDocument();
    expect(screen.queryByRole('textbox')).toBeNull();
    expect(screen.queryByRole('button', { name: 'History' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Archive' })).toBeNull();
    expect(screen.getByRole('heading', { name: 'Notes' })).toBeInTheDocument();
  });

  it('an archived document is read-only and offers to unarchive', async () => {
    const { user } = await setup({ archived: true });
    expect(
      await screen.findByText('This document is archived. Unarchive it to edit.'),
    ).toBeInTheDocument();
    expect(screen.queryByRole('textbox')).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Unarchive' }));
    await waitFor(() => expect(mocks.enqueue).toHaveBeenCalledTimes(1));
    expect(mocks.enqueue.mock.calls[0]?.[0]).toMatchObject({
      method: 'POST',
      path: '/api/w/w1/documents/d1/unarchive',
    });
  });

  it('archives a live document with a POST', async () => {
    const { user } = await setup();
    await user.click(await screen.findByRole('button', { name: 'Archive' }));
    await waitFor(() => expect(mocks.enqueue).toHaveBeenCalledTimes(1));
    expect(mocks.enqueue.mock.calls[0]?.[0].path).toBe('/api/w/w1/documents/d1/archive');
  });

  it('goes back', async () => {
    const { user, onBack } = await setup();
    await user.click(await screen.findByRole('button', { name: /Back to documents/ }));
    expect(onBack).toHaveBeenCalled();
  });

  it('the history lists earlier versions newest first, and restoring one fills the editor without saving', async () => {
    mocks.apiFetch.mockResolvedValue({
      revisions: [
        {
          id: 'r2',
          title: 'Plan B',
          body: 'Second text',
          editedBy: ME,
          createdAt: '2026-11-26T10:30:00Z',
        },
        {
          id: 'r1',
          title: 'Plan A',
          body: 'First text',
          editedBy: ME,
          createdAt: '2026-11-26T10:10:00Z',
        },
      ],
    });
    const { user } = await setup();
    await user.click(await screen.findByRole('button', { name: 'History' }));
    const list = await screen.findByTestId('revision-list');
    expect(mocks.apiFetch).toHaveBeenCalledWith(
      '/api/w/w1/documents/d1/revisions',
      expect.anything(),
    );
    await waitFor(() => expect(within(list).getByText('Second text')).toBeInTheDocument());
    const titles = within(list)
      .getAllByText(/^Plan [AB]$/)
      .map((el) => el.textContent);
    expect(titles).toEqual(['Plan B', 'Plan A']);

    await user.click(
      within(list).getAllByRole('button', { name: 'Restore this version' })[1] as HTMLElement,
    );
    await waitFor(() =>
      expect(screen.getByRole('textbox', { name: 'Title' })).toHaveValue('Plan A'),
    );
    expect(screen.getByRole('textbox', { name: 'Document text' })).toHaveValue('First text');
    expect(mocks.enqueue).not.toHaveBeenCalled();
  });

  it('says so when the document is not there', async () => {
    const titles = manualCollection<SyncedDocumentSummary>('t-none', (row) => row.id);
    const content = manualCollection<SyncedDocumentContent>('c-none', (row) => row.id);
    const members = manualCollection<SyncedMember>('m-none', (row) => row.id);
    titles.ready();
    content.ready();
    members.ready();
    mocks.collections.documents = titles.collection;
    mocks.collections.documentContent = content.collection;
    mocks.collections.members = members.collection;
    render(
      <LocaleProvider locale="en">
        <ShellContext.Provider
          value={{
            workspace: { id: 'w1', name: 'Demo', slug: 'demo', memberId: ME, role: 'member' },
            teams: [team],
            teamsReady: true,
            team,
          }}
        >
          <DocumentScreen workspaceId="w1" team={team} documentId="d9" onBack={() => {}} />
        </ShellContext.Provider>
      </LocaleProvider>,
    );
    expect(await screen.findByText('This document is not available.')).toBeInTheDocument();
  });
});
