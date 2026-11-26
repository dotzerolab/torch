// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { LocaleProvider } from '../design/locale.tsx';
import type { SyncedTeam } from '../sync/collections.ts';
import type { IssueRow } from './model/engine.ts';
import { makeData, makeRow } from './testing.ts';

const shapesAsked: string[] = [];
const MINE = { id: 'collection-of-my-issues' };
vi.mock('../sync/shapes.ts', () => ({
  useShape: (key: { kind: string }) => {
    shapesAsked.push(key.kind);
    return MINE;
  },
}));

const state = { rows: [] as IssueRow[], ready: true };
vi.mock('./useMyIssues.ts', () => ({
  useMyIssues: () => ({
    rows: state.rows,
    ready: state.ready,
    data: makeData(),
    names: new Map([
      ['t1', 'Engineering'],
      ['t2', 'Operations'],
    ]),
  }),
}));

const updateIssue = vi.fn(async () => {});
vi.mock('./mutate.ts', () => ({
  updateIssue: (...args: unknown[]) => updateIssue(...(args as [])),
}));

const { MyIssuesScreen } = await import('./MyIssuesScreen.tsx');

const TEAMS: SyncedTeam[] = [
  { id: 't1', workspace_id: 'w', key: 'ENG', name: 'Engineering', private: false },
  { id: 't2', workspace_id: 'w', key: 'OPS', name: 'Operations', private: true },
];

const row = (n: number, team: 't1' | 't2', extra: Parameters<typeof makeRow>[1] = {}): IssueRow => {
  const made = makeRow(n, { team_id: team, ...extra });
  return { ...made, identifier: `${team === 't1' ? 'ENG' : 'OPS'}-${n}` };
};

const ROWS = [
  row(1, 't1', { assignee_id: 'me', creator_id: 'other', state_id: 's1' }),
  row(2, 't2', { assignee_id: 'me', creator_id: 'other', state_id: 's2' }),
  row(3, 't1', { assignee_id: 'other', creator_id: 'me', state_id: 's1' }),
  row(4, 't2', { assignee_id: 'me', creator_id: 'me', state_id: 's3' }),
];

function Screen() {
  return (
    <LocaleProvider locale="en">
      <MyIssuesScreen workspaceId="w" memberId="me" teams={TEAMS} />
    </LocaleProvider>
  );
}

const titles = () =>
  screen.queryAllByTestId(/^issue-title-\d+$/).map((element) => element.textContent);

beforeAll(() => {
  Object.defineProperty(Element.prototype, 'clientHeight', { configurable: true, get: () => 600 });
  Object.defineProperty(Element.prototype, 'clientWidth', { configurable: true, get: () => 900 });
});
beforeEach(() => {
  window.history.replaceState({}, '', '/my-issues');
  state.rows = ROWS;
  state.ready = true;
  shapesAsked.length = 0;
  updateIssue.mockClear();
});
afterEach(() => {
  cleanup();
  window.localStorage.clear();
});

describe('MyIssuesScreen', () => {
  it('opens on Assigned: the issues assigned to the person, from every team', () => {
    render(<Screen />);
    expect(screen.getByRole('tab', { name: 'Assigned' }).getAttribute('aria-selected')).toBe(
      'true',
    );
    expect(screen.getByRole('tab', { name: 'Created' }).getAttribute('aria-selected')).toBe(
      'false',
    );
    expect(titles().sort()).toEqual(['Issue 1', 'Issue 2', 'Issue 4']);
    // Each row carries the number of its own team.
    expect(screen.getByText('ENG-1')).toBeTruthy();
    expect(screen.getByText('OPS-2')).toBeTruthy();
  });

  it('?tab=created shows the issues the person made, and an issue can be on both tabs', () => {
    window.history.replaceState({}, '', '/my-issues?tab=created');
    render(<Screen />);
    expect(screen.getByRole('tab', { name: 'Created' }).getAttribute('aria-selected')).toBe('true');
    expect(titles().sort()).toEqual(['Issue 3', 'Issue 4']);
  });

  it('a click on the Created tab writes it in the address and keeps the filter', async () => {
    window.history.replaceState({}, '', '/my-issues?priority=0');
    render(<Screen />);
    await userEvent.click(screen.getByRole('tab', { name: 'Created' }));
    expect(window.location.search).toBe('?priority=0&tab=created');
    expect(titles().sort()).toEqual(['Issue 3', 'Issue 4']);
    await userEvent.click(screen.getByRole('tab', { name: 'Assigned' }));
    expect(window.location.search).toBe('?priority=0');
  });

  it('groups by state type by default', () => {
    const { container } = render(<Screen />);
    expect(container.querySelector('[data-testid="section-stateType:unstarted"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="section-stateType:started"]')).not.toBeNull();
    expect(container.querySelector('[data-testid^="section-team:"]')).toBeNull();
  });

  it('groups by team on request, each group named after its team', () => {
    window.history.replaceState({}, '', '/my-issues?group=team');
    const { container } = render(<Screen />);
    expect(container.querySelector('[data-testid="section-team:t1"]')?.textContent).toContain(
      'Engineering',
    );
    expect(container.querySelector('[data-testid="section-team:t2"]')?.textContent).toContain(
      'Operations',
    );
  });

  it('offers grouping by team in the display menu', async () => {
    render(<Screen />);
    await userEvent.click(screen.getByRole('button', { name: /display/i }));
    const group = screen.getByLabelText('Grouping') as HTMLSelectElement;
    expect([...group.options].map((option) => option.value)).toContain('team');
    expect(group.value).toBe('stateType');
  });

  it('reads the one live shape of My Issues and opens no shape of a team', () => {
    render(<Screen />);
    expect(shapesAsked.length).toBeGreaterThan(0);
    expect(new Set(shapesAsked)).toEqual(new Set(['myIssues']));
  });

  it('a change from a row goes to the issue of that row, through the My Issues collection', async () => {
    render(<Screen />);
    await userEvent.dblClick(screen.getByTestId('issue-title-2'));
    const input = screen.getByTestId('issue-title-input-2');
    await userEvent.clear(input);
    await userEvent.type(input, 'Renamed{Enter}');
    await waitFor(() => expect(updateIssue).toHaveBeenCalledOnce());
    const [collection, issue, patch] = updateIssue.mock.calls[0] as unknown as [
      unknown,
      { id: string; team_id: string },
      unknown,
    ];
    expect(collection).toBe(MINE);
    expect(issue.id).toBe('i2');
    // The row is OPS's: the write is queued for OPS, not for a team the screen is "on".
    expect(issue.team_id).toBe('t2');
    expect(patch).toEqual({ title: 'Renamed' });
  });

  it('says it is loading until the issues are there', () => {
    state.ready = false;
    render(<Screen />);
    expect(screen.getByText('Loading…')).toBeTruthy();
    expect(titles()).toEqual([]);
  });

  it('says what an empty tab means: nothing assigned, and nothing created', async () => {
    state.rows = [];
    render(<Screen />);
    expect(screen.getByText('Nothing is assigned to you.')).toBeTruthy();
    await userEvent.click(screen.getByRole('tab', { name: 'Created' }));
    expect(screen.getByText('You have not created any issue.')).toBeTruthy();
  });

  it('a click on a row opens the issue page: there is no preview, which would open a second live shape', async () => {
    render(<Screen />);
    await userEvent.click(screen.getByTestId('issue-1'));
    expect(window.location.pathname).toBe('/issues/ENG-1');
  });
});
