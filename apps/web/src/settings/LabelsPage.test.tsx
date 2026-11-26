// @vitest-environment jsdom
import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../api.ts';
import type { SessionWorkspace } from '../auth/useSession.ts';
import { ToastProvider } from '../design/components/Toast.tsx';
import { LocaleProvider } from '../design/locale.tsx';
import type { SyncedLabel } from '../sync/collections.ts';
import type { LabelDto } from './admin-api.ts';

const label = (id: string, name: string, extra: Partial<SyncedLabel> = {}): SyncedLabel => ({
  id,
  workspace_id: 'w1',
  team_id: null,
  parent_id: null,
  name,
  color: '#cc0000',
  is_group: false,
  archived_at: null,
  created_at: '2026-11-01T00:00:00Z',
  ...extra,
});

const snapshot = { workspace: [] as SyncedLabel[], team: [] as SyncedLabel[] };
const refresh = vi.fn();

vi.mock('../shell/useTeams.ts', () => ({
  useTeams: () => ({
    ready: true,
    teams: [
      { id: 'team-eng', workspace_id: 'w1', key: 'ENG', name: 'Engineering', private: false },
    ],
  }),
}));
vi.mock('./useSettingsRows.ts', async () => {
  const { useConfirmedRows } = await import('./confirmed.ts');
  const use = (rows: SyncedLabel[]) => {
    const confirmed = useConfirmedRows(rows, refresh);
    return { rows: confirmed.rows, ready: true, remember: confirmed.remember, refresh };
  };
  return {
    useWorkspaceLabelRows: () => use(snapshot.workspace),
    useTeamLabelRows: () => use(snapshot.team),
  };
});
const api = { createLabel: vi.fn(), updateLabel: vi.fn(), archiveLabel: vi.fn() };
vi.mock('./admin-api.ts', () => ({ adminApi: api }));

const { LabelsPage } = await import('./LabelsPage.tsx');

const workspace = (role: SessionWorkspace['role']): SessionWorkspace => ({
  id: 'w1',
  name: 'Demo',
  slug: 'demo',
  memberId: 'm1',
  role,
});
const dto = (extra: Partial<LabelDto> = {}): LabelDto => ({
  id: 'new-1',
  teamId: null,
  parentId: null,
  name: 'Urgent',
  color: '#94a3b8',
  isGroup: false,
  archivedAt: null,
  createdAt: '2026-11-26T00:00:00.000Z',
  ...extra,
});

function renderPage(role: SessionWorkspace['role'] = 'owner') {
  return render(
    <LocaleProvider locale="en">
      <ToastProvider>
        <LabelsPage workspace={workspace(role)} />
      </ToastProvider>
    </LocaleProvider>,
  );
}

async function chooseScope(name: string) {
  await userEvent.click(screen.getByRole('combobox', { name: 'Labels of' }));
  await userEvent.click(await screen.findByRole('option', { name }));
}

beforeEach(() => {
  snapshot.workspace = [
    label('area', 'Area', { is_group: true }),
    label('bug', 'Bug', { parent_id: 'area' }),
    label('docs', 'Docs'),
    label('old', 'Old', { archived_at: '2026-11-02T00:00:00Z' }),
  ];
  snapshot.team = [label('team-only', 'Frontend', { team_id: 'team-eng' })];
  for (const fn of Object.values(api)) fn.mockReset();
  refresh.mockClear();
});
afterEach(cleanup);

describe('LabelsPage', () => {
  it('shows a guest no labels screen', () => {
    renderPage('guest');
    expect(screen.getByTestId('no-access')).toBeVisible();
  });

  it('lists the workspace labels with groups first and leaves archived ones out', () => {
    renderPage();
    const list = screen.getByTestId('label-list');
    expect(
      within(list)
        .getAllByRole('listitem')
        .map((row) => row.textContent),
    ).toEqual([
      expect.stringContaining('Area'),
      expect.stringContaining('Bug'),
      expect.stringContaining('Docs'),
    ]);
    expect(screen.queryByText('Old')).toBeNull();
  });

  it('lets a member read the workspace labels but not change them, and change the labels of a team', async () => {
    renderPage('member');
    expect(screen.queryByTestId('label-add-open')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Edit Docs' })).toBeNull();
    expect(screen.getByText(/Only owners and admins change the labels/)).toBeVisible();

    await chooseScope('ENG · Engineering');
    expect(await screen.findByTestId('label-row-Frontend')).toBeVisible();
    expect(screen.getByTestId('label-add-open')).toBeVisible();
    expect(screen.getByRole('button', { name: 'Archive Frontend' })).toBeVisible();
  });

  it('creates a team label in its scope, inside a group', async () => {
    snapshot.team = [label('grp', 'Kind', { team_id: 'team-eng', is_group: true })];
    api.createLabel.mockResolvedValue({
      label: dto({ id: 'n1', name: 'Urgent', teamId: 'team-eng', parentId: 'grp' }),
      txid: 4,
    });
    renderPage();
    await chooseScope('ENG · Engineering');

    await userEvent.click(await screen.findByTestId('label-add-open'));
    await userEvent.type(screen.getByLabelText('Name'), 'Urgent');
    await userEvent.click(screen.getByRole('combobox', { name: 'Group' }));
    await userEvent.click(await screen.findByRole('option', { name: 'Kind' }));
    await userEvent.click(screen.getByTestId('label-submit'));

    expect(api.createLabel).toHaveBeenCalledWith('w1', {
      name: 'Urgent',
      color: '#94a3b8',
      teamId: 'team-eng',
      parentId: 'grp',
      isGroup: false,
    });
    expect(await screen.findByTestId('label-row-Urgent')).toBeVisible();
    expect(refresh).toHaveBeenCalled();
  });

  it('creates a group of the workspace', async () => {
    api.createLabel.mockResolvedValue({
      label: dto({ id: 'g', name: 'Kind', isGroup: true }),
      txid: 1,
    });
    renderPage();
    await userEvent.click(screen.getByTestId('label-group-open'));
    expect(screen.queryByRole('combobox', { name: 'Group' })).toBeNull();
    await userEvent.type(screen.getByLabelText('Name'), 'Kind');
    await userEvent.click(screen.getByTestId('label-submit'));
    expect(api.createLabel).toHaveBeenCalledWith('w1', {
      name: 'Kind',
      color: '#94a3b8',
      teamId: null,
      parentId: null,
      isGroup: true,
    });
  });

  it('moves a label to another group and out of its group', async () => {
    api.updateLabel.mockResolvedValue({
      label: dto({ id: 'bug', name: 'Bug', parentId: null }),
      txid: 2,
    });
    renderPage();
    await userEvent.click(screen.getByRole('button', { name: 'Edit Bug' }));
    await userEvent.click(screen.getByRole('combobox', { name: 'Group' }));
    await userEvent.click(await screen.findByRole('option', { name: 'No group' }));
    await userEvent.click(screen.getByTestId('label-submit'));
    expect(api.updateLabel).toHaveBeenCalledWith('w1', 'bug', {
      name: 'Bug',
      color: '#cc0000',
      parentId: null,
    });
  });

  it('archives a label, and shows the text of a refusal', async () => {
    api.archiveLabel.mockResolvedValueOnce({
      label: dto({ id: 'docs', name: 'Docs', archivedAt: '2026-11-26T10:00:00.000Z' }),
      txid: 6,
    });
    renderPage();
    await userEvent.click(screen.getByRole('button', { name: 'Archive Docs' }));
    await vi.waitFor(() => expect(api.archiveLabel).toHaveBeenCalledWith('w1', 'docs'));
    expect(screen.queryByTestId('label-row-Docs')).toBeNull();

    api.archiveLabel.mockRejectedValueOnce(new ApiError(403, 'forbidden', 'dev'));
    await userEvent.click(screen.getByRole('button', { name: 'Archive Bug' }));
    expect(await screen.findByText('You are not allowed to do this.')).toBeVisible();
  });

  it('shows the text of a duplicate name inside the dialog', async () => {
    api.createLabel.mockRejectedValue(new ApiError(409, 'label_name_taken', 'dev'));
    renderPage();
    await userEvent.click(screen.getByTestId('label-add-open'));
    await userEvent.type(screen.getByLabelText('Name'), 'Docs');
    await userEvent.click(screen.getByTestId('label-submit'));
    expect(await screen.findByTestId('label-error')).toHaveTextContent(
      'A label with this name already exists here.',
    );
  });
});
