// @vitest-environment jsdom
import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../api.ts';
import { ToastProvider } from '../design/components/Toast.tsx';
import { LocaleProvider } from '../design/locale.tsx';
import { ShellContext } from '../shell/ShellContext.ts';
import type { SyncedTeam } from '../sync/collections.ts';
import { IssueDetail } from './IssueDetail.tsx';
import { IssuePanel } from './IssuePanel.tsx';
import { IssuePeek } from './IssuePeek.tsx';
import type { IssueRow } from './model/engine.ts';
import { makeData, makeRow } from './testing.ts';

const hub = vi.hoisted(() => ({
  rows: [] as unknown[],
  ready: true,
  detail: {
    description: 'Hello',
    subscriberIds: [] as string[],
    relations: [] as unknown[],
    links: [] as unknown[],
    activity: [] as unknown[],
    ready: true,
  },
}));
const mocks = vi.hoisted(() => ({
  updateIssue: vi.fn(),
  saveDescription: vi.fn(),
  setSubscribed: vi.fn(),
  setArchived: vi.fn(),
  addRelation: vi.fn(),
  removeRelation: vi.fn(),
  addLink: vi.fn(),
  removeLink: vi.fn(),
}));

vi.mock('./data.ts', async () => {
  const testing = await import('./testing.ts');
  return {
    useTeamData: () => testing.makeData(),
    useIssueRows: () => ({ rows: hub.rows, ready: hub.ready }),
  };
});
vi.mock('./useIssueDetail.ts', () => ({ useIssueDetail: () => hub.detail }));
vi.mock('../sync/shapes.ts', () => ({ useShape: () => ({ stub: true }) }));
vi.mock('./mutate.ts', () => mocks);

const team = { id: 't', key: 'ENG', name: 'Engineering' } as SyncedTeam;
const shell = {
  workspace: { id: 'w', memberId: 'me' },
  teams: [team],
  teamsReady: true,
  team,
} as never;

function wrap(children: React.ReactNode) {
  return (
    <LocaleProvider locale="en">
      <ShellContext.Provider value={shell}>
        <ToastProvider>{children}</ToastProvider>
      </ShellContext.Provider>
    </LocaleProvider>
  );
}

beforeEach(() => {
  hub.rows = [makeRow(3), makeRow(4)];
  hub.ready = true;
  hub.detail = {
    description: 'Hello',
    subscriberIds: [],
    relations: [],
    links: [],
    activity: [],
    ready: true,
  };
  for (const mock of Object.values(mocks)) mock.mockReset().mockResolvedValue(undefined);
  window.history.replaceState({}, '', '/');
  void makeData;
});

describe('IssuePanel', () => {
  it('shows the issue of the identifier', () => {
    render(
      wrap(
        <IssuePanel
          workspaceId="w"
          team={team}
          identifier="ENG-3"
          variant="page"
          onClose={() => {}}
        />,
      ),
    );
    expect(screen.getByRole('textbox', { name: /Title of ENG-3/ })).toHaveValue('Issue 3');
    expect(screen.getByTestId('issue-description')).toHaveTextContent('Hello');
  });

  it('a title edit PATCHes and shows at once', async () => {
    const user = userEvent.setup();
    render(
      wrap(
        <IssuePanel
          workspaceId="w"
          team={team}
          identifier="ENG-3"
          variant="peek"
          onClose={() => {}}
        />,
      ),
    );
    const title = screen.getByRole('textbox', { name: /Title of ENG-3/ });
    await user.clear(title);
    await user.type(title, 'Fresh{Enter}');
    expect(mocks.updateIssue).toHaveBeenCalledWith(
      { stub: true },
      expect.objectContaining({ id: 'i3' }),
      { title: 'Fresh' },
    );
    expect(title).toHaveValue('Fresh');
  });

  it('a refused write shows the server refusal in words', async () => {
    mocks.updateIssue.mockRejectedValue(new ApiError(403, 'forbidden', 'no'));
    const user = userEvent.setup();
    render(
      wrap(
        <IssuePanel
          workspaceId="w"
          team={team}
          identifier="ENG-3"
          variant="peek"
          onClose={() => {}}
        />,
      ),
    );
    await user.click(screen.getByRole('button', { name: /Priority/ }));
    await user.click(await screen.findByRole('option', { name: /^Urgent/ }));
    expect(await screen.findByTestId('panel-error')).toBeInTheDocument();
  });

  it('a saved description shows at once; a refused one shows a message and keeps the editor', async () => {
    const user = userEvent.setup();
    render(
      wrap(
        <IssuePanel
          workspaceId="w"
          team={team}
          identifier="ENG-3"
          variant="peek"
          onClose={() => {}}
        />,
      ),
    );
    await user.click(screen.getByTestId('issue-description'));
    await user.clear(screen.getByRole('textbox', { name: 'Description' }));
    await user.type(screen.getByRole('textbox', { name: 'Description' }), 'Brand new');
    await user.click(screen.getByRole('button', { name: 'Save' }));
    expect(mocks.saveDescription).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'i3' }),
      'Brand new',
    );
    expect(await screen.findByTestId('issue-description')).toHaveTextContent('Brand new');

    mocks.saveDescription.mockRejectedValue(new ApiError(409, 'issue_archived', 'archived'));
    await user.click(screen.getByTestId('issue-description'));
    await user.click(screen.getByRole('button', { name: 'Save' }));
    expect(await screen.findByRole('alert')).toBeInTheDocument();
    expect(screen.getByRole('textbox', { name: 'Description' })).toHaveValue('Brand new');
  });

  it('subscribe toggles at once and goes back when refused', async () => {
    const user = userEvent.setup();
    render(
      wrap(
        <IssuePanel
          workspaceId="w"
          team={team}
          identifier="ENG-3"
          variant="peek"
          onClose={() => {}}
        />,
      ),
    );
    await user.click(screen.getByRole('button', { name: 'Subscribe' }));
    expect(mocks.setSubscribed).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'i3' }),
      'me',
      true,
    );
    expect(screen.getByRole('button', { name: 'Unsubscribe' })).toBeInTheDocument();
    mocks.setSubscribed.mockRejectedValue(new ApiError(403, 'forbidden', 'no'));
    await user.click(screen.getByRole('button', { name: 'Unsubscribe' }));
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Unsubscribe' })).toBeInTheDocument(),
    );
  });

  it('an archived issue is read-only', () => {
    hub.rows = [makeRow(3, { archived_at: '2026-11-01T00:00:00Z' })];
    render(
      wrap(
        <IssuePanel
          workspaceId="w"
          team={team}
          identifier="ENG-3"
          variant="peek"
          onClose={() => {}}
        />,
      ),
    );
    expect(screen.getByText('This issue is archived and read-only.')).toBeInTheDocument();
    expect(screen.getByRole('textbox', { name: /Title of ENG-3/ })).toHaveAttribute('readonly');
  });

  it('an unknown number and another team show the same state', () => {
    const { unmount } = render(
      wrap(
        <IssuePanel
          workspaceId="w"
          team={team}
          identifier="ENG-99"
          variant="peek"
          onClose={() => {}}
        />,
      ),
    );
    const unknown = screen.getByTestId('issue-not-found').textContent;
    unmount();
    render(
      wrap(
        <IssuePanel
          workspaceId="w"
          team={team}
          identifier="OPS-3"
          variant="peek"
          onClose={() => {}}
        />,
      ),
    );
    expect(screen.getByTestId('issue-not-found').textContent).toBe(unknown);
  });

  it('an issue that leaves the collection closes the panel with a toast', async () => {
    const onClose = vi.fn();
    const { rerender } = render(
      wrap(
        <IssuePanel
          workspaceId="w"
          team={team}
          identifier="ENG-3"
          variant="peek"
          onClose={onClose}
        />,
      ),
    );
    expect(onClose).not.toHaveBeenCalled();
    hub.rows = [makeRow(4)];
    rerender(
      wrap(
        <IssuePanel
          workspaceId="w"
          team={team}
          identifier="ENG-3"
          variant="peek"
          onClose={onClose}
        />,
      ),
    );
    await waitFor(() => expect(onClose).toHaveBeenCalledOnce());
    expect(screen.getByText('This issue is no longer available.')).toBeInTheDocument();
  });
});

describe('IssuePeek', () => {
  it('Escape closes it', async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    render(wrap(<IssuePeek workspaceId="w" team={team} identifier="ENG-3" onClose={onClose} />));
    expect(screen.getByTestId('issue-peek')).toBeInTheDocument();
    await user.keyboard('{Escape}');
    expect(onClose).toHaveBeenCalledOnce();
  });
});

describe('IssueDetail', () => {
  const page = (identifier: string, teams: SyncedTeam[] = [team], teamsReady = true) =>
    wrap(
      <IssueDetail workspaceId="w" teams={teams} teamsReady={teamsReady} identifier={identifier} />,
    );

  it('shows the issue as a page', () => {
    render(page('ENG-3'));
    expect(screen.getByRole('link', { name: 'Engineering' })).toBeInTheDocument();
    expect(screen.getByRole('textbox', { name: /Title of ENG-3/ })).toHaveValue('Issue 3');
  });

  it('an unknown number, an unknown team and a team the person cannot see are one state', () => {
    const states = ['ENG-99', 'ZZZ-1', 'nonsense'].map((identifier) => {
      const { unmount } = render(page(identifier));
      const text = screen.getByTestId('issue-not-found').textContent;
      unmount();
      return text;
    });
    expect(new Set(states).size).toBe(1);
    // The team exists on the server but is not among the person's teams.
    render(page('ENG-3', []));
    expect(screen.getByTestId('issue-not-found').textContent).toBe(states[0]);
  });

  it('waits for the teams before it says anything', () => {
    render(page('ENG-3', [], false));
    expect(screen.queryByTestId('issue-not-found')).not.toBeInTheDocument();
  });

  it('goes back to the team when the issue leaves', async () => {
    window.history.replaceState({}, '', '/issues/ENG-3');
    const { rerender } = render(page('ENG-3'));
    hub.rows = [];
    rerender(page('ENG-3'));
    await waitFor(() => expect(window.location.pathname).toBe('/teams/ENG'));
    void act;
    void (null as IssueRow | null);
  });
});
