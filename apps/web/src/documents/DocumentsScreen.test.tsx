// @vitest-environment jsdom
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../api.ts';
import { LocaleProvider } from '../design/index.ts';
import { ShellContext, type ShellState } from '../shell/ShellContext.ts';
import type { SyncedDocumentSummary, SyncedMember, SyncedTeam } from '../sync/collections.ts';
import { manualCollection } from '../test/collections.ts';

const mocks = vi.hoisted(() => ({ collections: {} as Record<string, unknown>, enqueue: vi.fn() }));
vi.mock('../sync/shapes.ts', () => ({
  syncRegistry: { get: () => ({}), refresh: () => {} },
  useShape: (key: { kind: string }) => mocks.collections[key.kind],
}));
vi.mock('../sync/outbox.ts', () => ({ enqueueWrite: mocks.enqueue }));

import { DocumentsScreen } from './DocumentsScreen.tsx';

const ME = 'aaaaaaaa-0000-4000-8000-000000000001';
const team: SyncedTeam = {
  id: 't1',
  workspace_id: 'w1',
  key: 'ENG',
  name: 'Engineering',
  private: false,
};
const summary = (
  id: string,
  title: string,
  updated_at: string,
  archived_at: string | null = null,
): SyncedDocumentSummary => ({
  id,
  workspace_id: 'w1',
  team_id: 't1',
  title,
  created_by: ME,
  updated_by: ME,
  created_at: '2026-11-26T09:00:00Z',
  updated_at,
  archived_at,
});

async function setup(
  rows: SyncedDocumentSummary[],
  role: ShellState['workspace']['role'] = 'member',
) {
  const documents = manualCollection<SyncedDocumentSummary>(
    `docs-${Math.random()}`,
    (row) => row.id,
  );
  const members = manualCollection<SyncedMember>(`members-${Math.random()}`, (row) => row.id);
  mocks.collections.documents = documents.collection;
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
  documents.set(...rows);
  documents.ready();
  const onOpen = vi.fn();
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
        <DocumentsScreen workspaceId="w1" team={team} onOpen={onOpen} />
      </ShellContext.Provider>
    </LocaleProvider>,
  );
  await screen.findByTestId('documents-screen');
  return { user, onOpen };
}

beforeEach(() => {
  mocks.enqueue.mockReset();
  mocks.enqueue.mockResolvedValue({ txid: 1, document: { id: 'new-doc' } });
});

describe('DocumentsScreen', () => {
  it('lists titles, the most recently changed first, with who changed them and no text of the body', async () => {
    await setup([
      summary('a', 'Older', '2026-11-26T10:00:00Z'),
      summary('b', 'Newer', '2026-11-26T12:00:00Z'),
    ]);
    const rows = screen
      .getAllByRole('button')
      .filter((b) => b.dataset.testid?.startsWith('document-'));
    expect(rows.map((row) => within(row).getByText(/Older|Newer/).textContent)).toEqual([
      'Newer',
      'Older',
    ]);
    expect(within(rows[0] as HTMLElement).getByText(/by Mia/)).toBeInTheDocument();
  });

  it('opens a document', async () => {
    const { user, onOpen } = await setup([summary('a', 'Plan', '2026-11-26T10:00:00Z')]);
    await user.click(screen.getByTestId('document-a'));
    expect(onOpen).toHaveBeenCalledWith('a');
  });

  it('keeps archived documents behind a toggle', async () => {
    const { user } = await setup([
      summary('a', 'Live', '2026-11-26T10:00:00Z'),
      summary('b', 'Gone', '2026-11-26T11:00:00Z', '2026-11-26T11:30:00Z'),
    ]);
    expect(screen.queryByText('Gone')).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Show archived' }));
    expect(screen.getByText('Gone')).toBeInTheDocument();
    expect(screen.getByText('Archived')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Hide archived' }));
    expect(screen.queryByText('Gone')).toBeNull();
  });

  it('says so when a team has no documents', async () => {
    await setup([]);
    expect(screen.getByText('No documents yet.')).toBeInTheDocument();
  });

  it('a guest has no "New document"', async () => {
    await setup([summary('a', 'Plan', '2026-11-26T10:00:00Z')], 'guest');
    expect(screen.queryByRole('button', { name: 'New document' })).toBeNull();
    expect(screen.getByText('Plan')).toBeInTheDocument();
  });

  it('a member starts a document with a POST to the team and opens it', async () => {
    const { user, onOpen } = await setup([]);
    await user.click(screen.getByRole('button', { name: 'New document' }));
    await waitFor(() => expect(mocks.enqueue).toHaveBeenCalledTimes(1));
    expect(mocks.enqueue.mock.calls[0]?.[0]).toMatchObject({
      workspaceId: 'w1',
      teamId: 't1',
      method: 'POST',
      path: '/api/w/w1/teams/t1/documents',
      body: { title: 'Untitled document' },
    });
    await waitFor(() => expect(onOpen).toHaveBeenCalledWith('new-doc'));
  });

  it('a refused creation says why and opens nothing', async () => {
    mocks.enqueue.mockRejectedValue(new ApiError(403, 'forbidden', 'no'));
    const { user, onOpen } = await setup([]);
    await user.click(screen.getByRole('button', { name: 'New document' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('You cannot do this in this team.');
    expect(onOpen).not.toHaveBeenCalled();
  });
});
