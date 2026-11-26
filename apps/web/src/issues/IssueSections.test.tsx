// @vitest-environment jsdom
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { LocaleProvider } from '../design/locale.tsx';
import type { SyncedActivity, SyncedIssueLink } from '../sync/collections.ts';
import { IssueActivity } from './IssueActivity.tsx';
import { Links } from './Links.tsx';
import type { RelationView } from './model/detail.ts';
import { Relations } from './Relations.tsx';
import { SubIssues } from './SubIssues.tsx';
import { Subscribers } from './Subscribers.tsx';
import { MEMBERS, makeData, makeRow } from './testing.ts';

const wrap = (node: React.ReactNode, locale: 'en' | 'it' = 'en') => (
  <LocaleProvider locale={locale}>{node}</LocaleProvider>
);

describe('Relations', () => {
  const self = makeRow(3);
  const rows = [self, makeRow(2), makeRow(4)];

  it('shows each relation from this issue’s end, with the other issue named', () => {
    const relations: RelationView[] = [
      { id: 'r1', kind: 'blocked_by', otherId: 'i2' },
      { id: 'r2', kind: 'related', otherId: 'i4' },
    ];
    render(
      wrap(
        <Relations
          relations={relations}
          rows={rows}
          self={self}
          readOnly={false}
          onAdd={() => {}}
          onRemove={() => {}}
        />,
      ),
    );
    expect(screen.getByTestId('relation-blocked_by')).toHaveTextContent('Blocked by');
    expect(screen.getByTestId('relation-blocked_by')).toHaveTextContent('ENG-2 Issue 2');
    expect(screen.getByTestId('relation-related')).toHaveTextContent('ENG-4 Issue 4');
  });

  it('an end this screen does not have shows no title and no number', () => {
    render(
      wrap(
        <Relations
          relations={[{ id: 'r1', kind: 'blocks', otherId: 'private-issue' }]}
          rows={rows}
          self={self}
          readOnly={false}
          onAdd={() => {}}
          onRemove={() => {}}
        />,
      ),
    );
    const hidden = screen.getByTestId('relation-hidden');
    expect(hidden).toHaveTextContent('Issue you cannot see');
    expect(hidden.textContent).not.toMatch(/ENG|private/);
  });

  it('blocked_by is sent as blocked_by with the issue that was found', async () => {
    const user = userEvent.setup();
    const onAdd = vi.fn();
    render(
      wrap(
        <Relations
          relations={[]}
          rows={rows}
          self={self}
          readOnly={false}
          onAdd={onAdd}
          onRemove={() => {}}
        />,
      ),
    );
    await user.selectOptions(screen.getByLabelText('Relation type'), 'blocked_by');
    await user.type(screen.getByRole('searchbox', { name: 'Find an issue' }), 'issue 4');
    expect(screen.queryByRole('button', { name: /ENG-3/ })).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'ENG-4 Issue 4' }));
    expect(onAdd).toHaveBeenCalledWith('blocked_by', 'i4');
  });

  it('a relation is removed from its own button', async () => {
    const user = userEvent.setup();
    const onRemove = vi.fn();
    render(
      wrap(
        <Relations
          relations={[{ id: 'r1', kind: 'blocks', otherId: 'i2' }]}
          rows={rows}
          self={self}
          readOnly={false}
          onAdd={() => {}}
          onRemove={onRemove}
        />,
      ),
    );
    await user.click(screen.getByRole('button', { name: /Remove relation/ }));
    expect(onRemove).toHaveBeenCalledWith('r1');
  });

  it('a read-only issue has no controls', () => {
    render(
      wrap(
        <Relations
          relations={[{ id: 'r1', kind: 'blocks', otherId: 'i2' }]}
          rows={rows}
          self={self}
          readOnly
          onAdd={() => {}}
          onRemove={() => {}}
        />,
      ),
    );
    expect(screen.queryByRole('button', { name: /Remove/ })).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Relation type')).not.toBeInTheDocument();
  });
});

describe('Links', () => {
  const link = { id: 'l1', url: 'https://example.test/a', title: 'Spec' } as SyncedIssueLink;

  it('lists links that open safely in a new tab', () => {
    render(
      wrap(<Links links={[link]} readOnly={false} onAdd={async () => {}} onRemove={() => {}} />),
    );
    const anchor = screen.getByRole('link', { name: 'Spec' });
    expect(anchor).toHaveAttribute('href', 'https://example.test/a');
    expect(anchor).toHaveAttribute('rel', 'noopener noreferrer');
  });

  it('a refused address says so and keeps what was typed', async () => {
    const user = userEvent.setup();
    const onAdd = vi.fn().mockRejectedValue(new Error('invalid'));
    render(wrap(<Links links={[]} readOnly={false} onAdd={onAdd} onRemove={() => {}} />));
    await user.type(screen.getByLabelText('Address (http or https)'), 'example.test');
    await user.click(screen.getByRole('button', { name: 'Add link' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('http');
    expect(screen.getByLabelText('Address (http or https)')).toHaveValue('example.test');
  });

  it('an accepted address clears the form', async () => {
    const user = userEvent.setup();
    const onAdd = vi.fn().mockResolvedValue(undefined);
    render(wrap(<Links links={[]} readOnly={false} onAdd={onAdd} onRemove={() => {}} />));
    await user.type(screen.getByLabelText('Address (http or https)'), 'https://example.test');
    await user.click(screen.getByRole('button', { name: 'Add link' }));
    expect(onAdd).toHaveBeenCalledWith('https://example.test', '');
    await vi.waitFor(() =>
      expect(screen.getByLabelText('Address (http or https)')).toHaveValue(''),
    );
  });
});

describe('SubIssues', () => {
  it('shows the progress and the parent', () => {
    const data = makeData();
    const done = makeRow(5, { state_id: 's3' });
    const open = makeRow(6, { state_id: 's1' });
    render(wrap(<SubIssues parent={makeRow(1)} subIssues={[done, open]} done={1} data={data} />));
    expect(screen.getByTestId('sub-issue-progress')).toHaveTextContent('1 of 2 done');
    expect(screen.getByTestId('issue-parent')).toHaveTextContent('ENG-1');
    expect(screen.getByTestId('sub-issue-5')).toBeInTheDocument();
  });

  it('shows nothing for an issue with no parent and no children', () => {
    const { container } = render(
      wrap(<SubIssues parent={undefined} subIssues={[]} done={0} data={makeData()} />),
    );
    expect(container).toBeEmptyDOMElement();
  });
});

describe('Subscribers', () => {
  const data = makeData();
  it('lists followers, offers the others and lets me leave', async () => {
    const user = userEvent.setup();
    const onRemoveSelf = vi.fn();
    const onAdd = vi.fn();
    render(
      wrap(
        <Subscribers
          subscriberIds={['me']}
          members={data.members}
          membersById={data.membersById}
          meId="me"
          readOnly={false}
          onAdd={onAdd}
          onRemoveSelf={onRemoveSelf}
        />,
      ),
    );
    expect(screen.getByTestId('subscriber')).toHaveTextContent('Ada Tester');
    await user.selectOptions(screen.getByLabelText('Add a follower'), 'm2');
    expect(onAdd).toHaveBeenCalledWith('m2');
    await user.click(screen.getByRole('button', { name: 'Remove Ada Tester' }));
    expect(onRemoveSelf).toHaveBeenCalledOnce();
    expect(MEMBERS.length).toBeGreaterThan(0);
  });
});

describe('IssueActivity', () => {
  const data = makeData();
  const change = {
    id: 'a1',
    workspace_id: 'w',
    team_id: 't',
    issue_id: 'i1',
    actor_id: 'me',
    client: 'api',
    type: 'issue.field_changed',
    field: 'stateId',
    from_value: 's1',
    to_value: 's3',
    created_at: '2026-11-20T10:00:00Z',
  } as SyncedActivity;

  it('writes the history in English and in Italian', () => {
    const { unmount } = render(wrap(<IssueActivity activity={[change]} data={data} />));
    expect(screen.getByTestId('activity-row')).toHaveTextContent(
      'Ada Tester changed the state from Todo to Done',
    );
    expect(screen.getByTestId('activity-row')).toHaveTextContent('via api');
    unmount();
    render(wrap(<IssueActivity activity={[change]} data={data} />, 'it'));
    expect(screen.getByTestId('activity-row')).toHaveTextContent(
      'Ada Tester ha cambiato lo stato da Todo a Done',
    );
  });

  it('an actor the workspace does not list is someone', () => {
    render(wrap(<IssueActivity activity={[{ ...change, actor_id: 'gone' }]} data={data} />));
    expect(screen.getByTestId('activity-row')).toHaveTextContent('someone changed');
  });

  it('shows nothing without history', () => {
    const { container } = render(wrap(<IssueActivity activity={[]} data={data} />));
    expect(container).toBeEmptyDOMElement();
  });
});
