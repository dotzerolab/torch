// @vitest-environment jsdom
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { LocaleProvider } from '../design/locale.tsx';
import { IssuesView } from './IssuesView.tsx';
import { makeData, makeRow } from './testing.ts';
import { useViewState } from './useViewState.ts';

const rows = [
  makeRow(1, { priority: 1 }, ['l1']),
  makeRow(2, { priority: 2 }),
  makeRow(3, { priority: 1, assignee_id: 'me' }),
];
const GONE = '99999999-9999-4999-8999-999999999999';

function Screen({ all = rows }: { all?: typeof rows }) {
  const view = useViewState('t');
  return (
    <LocaleProvider locale="en">
      <IssuesView
        rows={all}
        data={makeData()}
        meId="me"
        today="2026-11-26"
        teamKey="ENG"
        teamName="Engineering"
        view={view}
        error={null}
        initialRect={{ width: 900, height: 600 }}
        onOpen={() => {}}
        onRename={() => {}}
        onUpdate={() => {}}
      />
    </LocaleProvider>
  );
}

const titles = () =>
  screen.queryAllByTestId(/^issue-title-\d+$/).map((element) => element.textContent);

// jsdom has no layout: give the list a size.
beforeAll(() => {
  Object.defineProperty(Element.prototype, 'clientHeight', { configurable: true, get: () => 600 });
  Object.defineProperty(Element.prototype, 'clientWidth', { configurable: true, get: () => 900 });
});

beforeEach(() => window.history.replaceState({}, '', '/teams/ENG'));
afterEach(() => window.localStorage.clear());

describe('IssuesView', () => {
  it('shows every issue without a filter', () => {
    render(<Screen />);
    expect(titles()).toEqual(['Issue 1', 'Issue 3', 'Issue 2']);
  });

  it('a filter from the address shows only its issues, and the count', () => {
    window.history.replaceState({}, '', '/teams/ENG?priority=1');
    render(<Screen />);
    expect(titles()).toEqual(['Issue 1', 'Issue 3']);
    expect(screen.getByTestId('issue-total')).toHaveTextContent('2 of 3 issues');
  });

  it('an address with a stale label shows an unavailable chip and no rows; removing it restores them', async () => {
    const user = userEvent.setup();
    window.history.replaceState({}, '', `/teams/ENG?label=${GONE}`);
    render(<Screen />);
    expect(screen.getByText('Unavailable label')).toBeInTheDocument();
    expect(titles()).toEqual([]);
    expect(screen.getByText('No issues match this filter.')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /^Remove filter/ }));
    await waitFor(() => expect(titles()).toEqual(['Issue 1', 'Issue 3', 'Issue 2']));
    expect(window.location.search).toBe('');
  });

  it('an address that is garbage opens the plain view', () => {
    window.history.replaceState({}, '', '/teams/ENG?priority=zzz&group=cube&state=1&label=%00');
    render(<Screen />);
    expect(titles()).toEqual(['Issue 1', 'Issue 3', 'Issue 2']);
  });

  it('typing in the search narrows the list and the address', async () => {
    const user = userEvent.setup();
    render(<Screen />);
    await user.type(screen.getByRole('searchbox'), 'issue 2');
    expect(titles()).toEqual(['Issue 2']);
    expect(window.location.search).toBe('?text=issue+2');
  });

  it('a blocked local storage does not break the screen', async () => {
    const real = Storage.prototype.getItem;
    const set = Storage.prototype.setItem;
    Storage.prototype.getItem = () => {
      throw new Error('blocked');
    };
    Storage.prototype.setItem = () => {
      throw new Error('blocked');
    };
    try {
      const user = userEvent.setup();
      render(<Screen />);
      expect(titles()).toHaveLength(3);
      await user.click(screen.getByRole('button', { name: 'Display' }));
      await user.selectOptions(screen.getByLabelText('Grouping'), 'none');
      expect(titles()).toHaveLength(3);
    } finally {
      Storage.prototype.getItem = real;
      Storage.prototype.setItem = set;
    }
  });

  it('no issues at all says so, with no filter in the way', () => {
    render(<Screen all={[]} />);
    expect(screen.getByText('No issues in this team.')).toBeInTheDocument();
  });
});
