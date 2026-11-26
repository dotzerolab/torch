// @vitest-environment jsdom
import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../api.ts';
import type { SessionWorkspace } from '../auth/useSession.ts';
import { ToastProvider } from '../design/components/Toast.tsx';
import { LocaleProvider } from '../design/locale.tsx';
import type { SyncedWorkflowState } from '../sync/collections.ts';
import type { WorkflowStateDto } from './admin-api.ts';

const state = (id: string, name: string, type: string, position: number): SyncedWorkflowState => ({
  id,
  workspace_id: 'w1',
  team_id: 'team-eng',
  name,
  type,
  position,
  color: '#aaaaaa',
  archived_at: null,
});

const snapshot = {
  rows: [] as SyncedWorkflowState[],
};
const refresh = vi.fn();

vi.mock('../shell/useTeams.ts', () => ({
  useTeams: () => ({
    ready: true,
    teams: [
      { id: 'team-eng', workspace_id: 'w1', key: 'ENG', name: 'Engineering', private: false },
    ],
  }),
}));
// The snapshot is a mutable list; the real "keep a written row until the snapshot shows it" logic runs over it.
vi.mock('./useSettingsRows.ts', async () => {
  const { useConfirmedRows } = await import('./confirmed.ts');
  return {
    useWorkflowStates: () => {
      const { rows, remember } = useConfirmedRows(snapshot.rows, refresh);
      return { rows, ready: true, remember, refresh };
    },
  };
});
const api = {
  createState: vi.fn(),
  updateState: vi.fn(),
  archiveState: vi.fn(),
};
vi.mock('./admin-api.ts', () => ({ adminApi: api }));

const { WorkflowPage } = await import('./WorkflowPage.tsx');

const workspace = (role: SessionWorkspace['role']): SessionWorkspace => ({
  id: 'w1',
  name: 'Demo',
  slug: 'demo',
  memberId: 'm1',
  role,
});

const dto = (extra: Partial<WorkflowStateDto> = {}): WorkflowStateDto => ({
  id: 'new-1',
  teamId: 'team-eng',
  name: 'Review',
  type: 'started',
  position: 6,
  color: '#94a3b8',
  archivedAt: null,
  createdAt: '2026-11-26T00:00:00.000Z',
  ...extra,
});

function renderPage(role: SessionWorkspace['role'] = 'owner') {
  return render(
    <LocaleProvider locale="en">
      <ToastProvider>
        <WorkflowPage workspace={workspace(role)} />
      </ToastProvider>
    </LocaleProvider>,
  );
}

beforeEach(() => {
  snapshot.rows = [
    state('triage', 'Triage', 'triage', 0),
    state('backlog', 'Backlog', 'backlog', 1),
    state('todo', 'Todo', 'unstarted', 2),
    state('done', 'Done', 'completed', 3),
    state('canceled', 'Canceled', 'canceled', 4),
  ];
  for (const fn of Object.values(api)) fn.mockReset();
  refresh.mockClear();
});
afterEach(cleanup);

describe('WorkflowPage', () => {
  it.each(['member', 'guest'] as const)('shows %s no workflow at all', (role) => {
    renderPage(role);
    expect(screen.getByTestId('no-access')).toBeVisible();
    expect(screen.queryByTestId('state-list')).toBeNull();
  });

  it('lists the states of the team in order, with their type', () => {
    renderPage();
    const rows = within(screen.getByTestId('state-list')).getAllByRole('listitem');
    expect(rows.map((row) => row.textContent)).toEqual([
      expect.stringContaining('Triage'),
      expect.stringContaining('Backlog'),
      expect.stringContaining('Todo'),
      expect.stringContaining('Done'),
      expect.stringContaining('Canceled'),
    ]);
  });

  it('new state appears at once from the answer of the write, and once from the snapshot after the refresh', async () => {
    api.createState.mockResolvedValue({ state: dto(), txid: 9 });
    renderPage();

    await userEvent.click(screen.getByTestId('state-add-open'));
    await userEvent.type(screen.getByLabelText('Name'), 'Review');
    await userEvent.click(screen.getByTestId('state-submit'));

    expect(api.createState).toHaveBeenCalledWith('w1', 'team-eng', {
      name: 'Review',
      color: '#94a3b8',
      type: 'started',
    });
    expect(await screen.findByTestId('state-row-Review')).toBeVisible();
    expect(refresh).toHaveBeenCalled();
    expect(screen.queryByTestId('state-form')).toBeNull();
  });

  it('refuses an empty name before sending anything', async () => {
    renderPage();
    await userEvent.click(screen.getByTestId('state-add-open'));
    await userEvent.click(screen.getByTestId('state-submit'));
    expect(await screen.findByTestId('state-error')).toHaveTextContent('Give the state a name');
    expect(api.createState).not.toHaveBeenCalled();
  });

  it('shows the translated text of a refusal inside the dialog', async () => {
    api.createState.mockRejectedValue(new ApiError(409, 'workflow_state_name_taken', 'dev text'));
    renderPage();
    await userEvent.click(screen.getByTestId('state-add-open'));
    await userEvent.type(screen.getByLabelText('Name'), 'Todo');
    await userEvent.click(screen.getByTestId('state-submit'));
    expect(await screen.findByTestId('state-error')).toHaveTextContent(
      'A state with this name already exists in the team.',
    );
  });

  it('renames a state and keeps its type out of the form', async () => {
    api.updateState.mockResolvedValue({
      state: dto({ id: 'todo', name: 'Ready', type: 'unstarted', position: 2 }),
      txid: 3,
    });
    renderPage();
    await userEvent.click(screen.getByRole('button', { name: 'Edit Todo' }));
    expect(screen.queryByRole('combobox', { name: 'Type' })).toBeNull();
    const name = screen.getByLabelText('Name');
    await userEvent.clear(name);
    await userEvent.type(name, 'Ready');
    await userEvent.click(screen.getByTestId('state-submit'));

    expect(api.updateState).toHaveBeenCalledWith('w1', 'team-eng', 'todo', {
      name: 'Ready',
      color: '#aaaaaa',
    });
    expect(await screen.findByTestId('state-row-Ready')).toBeVisible();
  });

  it('moves a state up by writing the positions of the states that changed', async () => {
    api.updateState.mockImplementation(async (_w, _t, id: string, patch: { position: number }) => ({
      state: dto({ id, name: id, position: patch.position, type: 'unstarted' }),
      txid: 1,
    }));
    renderPage();
    await userEvent.click(screen.getByRole('button', { name: 'Move Todo up' }));
    await vi.waitFor(() => expect(api.updateState).toHaveBeenCalledTimes(2));
    expect(api.updateState).toHaveBeenCalledWith('w1', 'team-eng', 'todo', { position: 1 });
    expect(api.updateState).toHaveBeenCalledWith('w1', 'team-eng', 'backlog', { position: 2 });
  });

  it('archive state asks where to move issues when it has some, then archives with the answer', async () => {
    api.archiveState
      .mockRejectedValueOnce(new ApiError(422, 'move_target_required', 'dev'))
      .mockResolvedValueOnce({
        state: dto({
          id: 'backlog',
          name: 'Backlog',
          type: 'backlog',
          archivedAt: '2026-11-26T10:00:00.000Z',
        }),
        txid: 5,
      });
    renderPage();

    await userEvent.click(screen.getByRole('button', { name: 'Archive Backlog' }));
    const dialog = await screen.findByTestId('move-issues-dialog');
    expect(api.archiveState).toHaveBeenLastCalledWith('w1', 'team-eng', 'backlog', undefined);
    // Todo (unstarted) is the default target, and the state being archived is not offered.
    expect(within(dialog).getByRole('combobox', { name: 'Move issues to' })).toHaveTextContent(
      'Todo',
    );
    await userEvent.click(screen.getByTestId('move-confirm'));

    await vi.waitFor(() =>
      expect(api.archiveState).toHaveBeenLastCalledWith('w1', 'team-eng', 'backlog', 'todo'),
    );
    expect(screen.queryByTestId('move-issues-dialog')).toBeNull();
    expect(screen.queryByTestId('state-row-Backlog')).toBeNull();
  });

  it('last completed state cannot be archived, and the screen says why', () => {
    renderPage();
    const button = screen.getByRole('button', { name: 'Archive Done' });
    expect(button).toBeDisabled();
    expect(
      within(screen.getByTestId('state-row-Done')).getByText('Keep at least one completed state.'),
    ).toBeVisible();
    // A state that is not the last of its kind can go.
    expect(screen.getByRole('button', { name: 'Archive Canceled' })).toBeEnabled();
  });

  it('keeps the last backlog or unstarted state', () => {
    snapshot.rows = [
      state('todo', 'Todo', 'unstarted', 0),
      state('done', 'Done', 'completed', 1),
      state('done2', 'Shipped', 'completed', 2),
    ];
    renderPage();
    expect(screen.getByRole('button', { name: 'Archive Todo' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Archive Done' })).toBeEnabled();
  });

  it('server 422 shows its message when the screen offered the archive anyway', async () => {
    api.archiveState.mockRejectedValue(new ApiError(422, 'workflow_state_required', 'dev text'));
    renderPage();
    await userEvent.click(screen.getByRole('button', { name: 'Archive Canceled' }));
    expect(
      await screen.findByText(
        'A team keeps at least one backlog or unstarted state and one completed state.',
      ),
    ).toBeVisible();
  });
});
