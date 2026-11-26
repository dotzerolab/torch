// @vitest-environment jsdom
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { DEFAULT_DISPLAY, type ViewDisplay } from '@torch/shared/views';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { LocaleProvider } from '../design/locale.tsx';
import type { SyncedIssue, SyncedWorkflowState } from '../sync/collections.ts';
import type { TeamData } from './data.ts';
import { IssueList } from './IssueList.tsx';
import { buildSections, type IssueRow } from './model/engine.ts';
import { SelectionProvider, useSelection } from './SelectionContext.tsx';

const STATES: SyncedWorkflowState[] = [
  {
    id: 's1',
    workspace_id: 'w',
    team_id: 't',
    name: 'Todo',
    type: 'unstarted',
    position: 1,
    color: '#aaaaaa',
    archived_at: null,
  },
  {
    id: 's2',
    workspace_id: 'w',
    team_id: 't',
    name: 'In Progress',
    type: 'started',
    position: 2,
    color: '#bbbbbb',
    archived_at: null,
  },
];
const data: TeamData = {
  states: STATES,
  labels: [],
  members: [],
  statesById: new Map(STATES.map((s) => [s.id, s])),
  labelsById: new Map(),
  membersById: new Map(),
  ready: true,
  statesReady: true,
};
const ctx = { meId: 'me', today: '2026-11-26', states: data.statesById };

function row(n: number, extra: Partial<SyncedIssue> = {}, pending = false): IssueRow {
  const issue: SyncedIssue = {
    id: `i${n}`,
    workspace_id: 'w',
    team_id: 't',
    number: n,
    title: `Issue ${n}`,
    state_id: n % 2 === 0 ? 's2' : 's1',
    priority: 0,
    assignee_id: null,
    creator_id: 'me',
    created_at: '2026-11-01T00:00:00Z',
    updated_at: '2026-11-01T00:00:00Z',
    archived_at: null,
    estimate: null,
    due_date: null,
    parent_id: null,
    sort_order: n,
    started_at: null,
    completed_at: null,
    canceled_at: null,
    ...extra,
  };
  return { id: issue.id, issue, identifier: pending ? '' : `ENG-${n}`, labelIds: [], pending };
}
const many = (count: number) => Array.from({ length: count }, (_, i) => row(i + 1));

function Harness({
  rows,
  display = DEFAULT_DISPLAY,
  ...props
}: {
  rows: IssueRow[];
  display?: ViewDisplay;
  onOpen?: (row: IssueRow) => void;
  onPeek?: (row: IssueRow) => void;
  peekOpen?: boolean;
  onClosePeek?: () => void;
  onRename?: (row: IssueRow, title: string) => void;
  revealId?: string;
}) {
  const sections = buildSections(rows, {}, display, ctx);
  return (
    <LocaleProvider locale="en">
      <SelectionProvider>
        <Selected />
        <IssueList
          sections={sections}
          display={display}
          data={data}
          meId="me"
          today="2026-11-26"
          teamKey="ENG"
          initialRect={{ width: 900, height: 600 }}
          onOpen={props.onOpen ?? (() => {})}
          onPeek={props.onPeek}
          peekOpen={props.peekOpen}
          onClosePeek={props.onClosePeek}
          onRename={props.onRename ?? (() => {})}
          onUpdate={() => {}}
          revealId={props.revealId}
        />
      </SelectionProvider>
    </LocaleProvider>
  );
}

function Selected() {
  const { ids } = useSelection();
  return <p data-testid="selected">{[...ids].sort().join(',')}</p>;
}

// jsdom has no layout: give the list a size, and a scrollTo that moves the scroll position the way a browser does.
beforeAll(() => {
  Object.defineProperty(Element.prototype, 'clientHeight', {
    configurable: true,
    get: () => 600,
  });
  Object.defineProperty(Element.prototype, 'clientWidth', {
    configurable: true,
    get: () => 900,
  });
  // jsdom keeps no scroll position: remember what is written.
  const tops = new WeakMap<Element, number>();
  Object.defineProperty(Element.prototype, 'scrollTop', {
    configurable: true,
    get(this: Element) {
      return tops.get(this) ?? 0;
    },
    set(this: Element, value: number) {
      tops.set(this, value);
    },
  });
  Element.prototype.scrollTo = function scrollTo(
    this: Element,
    options?: ScrollToOptions | number,
  ) {
    const top = typeof options === 'object' ? (options.top ?? 0) : 0;
    this.scrollTop = top;
    this.dispatchEvent(new Event('scroll'));
  } as typeof Element.prototype.scrollTo;
});

const focusedTestId = () => document.activeElement?.getAttribute('data-testid');

describe('IssueList', () => {
  it('renders only the window: 10,000 rows make fewer than 60 list items', () => {
    render(<Harness rows={many(10_000)} />);
    const items = screen.getAllByRole('listitem');
    expect(items.length).toBeGreaterThan(5);
    expect(items.length).toBeLessThan(60);
  });

  it('groups by state in workflow order, with a header and a count', () => {
    render(<Harness rows={many(6)} />);
    const headers = screen.getAllByRole('heading', { level: 2 });
    expect(headers.map((h) => h.textContent)).toEqual(['Todo3', 'In Progress3']);
    expect(screen.getByTestId('section-state:s1')).toBeInTheDocument();
  });

  it('scroll to the row of a number renders it', async () => {
    const { rerender } = render(<Harness rows={many(10_000)} />);
    expect(screen.queryByTestId('issue-5000')).not.toBeInTheDocument();
    rerender(<Harness rows={many(10_000)} revealId="i5000" />);
    await waitFor(() => expect(screen.getByTestId('issue-5000')).toBeInTheDocument());
    expect(screen.getAllByRole('listitem').length).toBeLessThan(60);
  });

  it('j and k move focus down and up, Enter opens the focused issue', async () => {
    const onOpen = vi.fn();
    render(<Harness rows={many(4)} onOpen={onOpen} />);
    await userEvent.keyboard('j');
    expect(focusedTestId()).toBe('issue-1');
    await userEvent.keyboard('j');
    expect(focusedTestId()).toBe('issue-3');
    await userEvent.keyboard('k');
    expect(focusedTestId()).toBe('issue-1');
    await userEvent.keyboard('{Enter}');
    expect(onOpen).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ id: 'i1' }));
  });

  it('arrow keys move too, and stop at the ends', async () => {
    render(<Harness rows={many(2)} />);
    // The first key puts focus in the list; the arrows work from there.
    await userEvent.keyboard('j{ArrowDown}{ArrowDown}');
    expect(focusedTestId()).toBe('issue-2');
    await userEvent.keyboard('{ArrowUp}{ArrowUp}{ArrowUp}');
    expect(focusedTestId()).toBe('issue-1');
  });

  it('x selects the focused issue, shift+click selects the range up to the one clicked', async () => {
    render(<Harness rows={many(6)} display={{ ...DEFAULT_DISPLAY, group: 'none' }} />);
    await userEvent.keyboard('j');
    await userEvent.keyboard('x');
    expect(screen.getByTestId('selected')).toHaveTextContent('i1');
    await userEvent.keyboard('x');
    expect(screen.getByTestId('selected').textContent).toBe('');
    await userEvent.keyboard('x');
    const user = userEvent.setup();
    await user.keyboard('{Shift>}');
    await user.click(screen.getByTestId('issue-4'));
    await user.keyboard('{/Shift}');
    expect(screen.getByTestId('selected')).toHaveTextContent('i1,i2,i3,i4');
  });

  it('a click selects, and cmd+click adds to the selection', async () => {
    render(<Harness rows={many(4)} display={{ ...DEFAULT_DISPLAY, group: 'none' }} />);
    await userEvent.click(screen.getByTestId('issue-2'));
    expect(screen.getByTestId('selected')).toHaveTextContent('i2');
    const user = userEvent.setup();
    await user.keyboard('{Meta>}');
    await user.click(screen.getByTestId('issue-3'));
    await user.keyboard('{/Meta}');
    expect(screen.getByTestId('selected')).toHaveTextContent('i2,i3');
  });

  it('Escape clears the selection', async () => {
    render(<Harness rows={many(3)} />);
    await userEvent.keyboard('jx');
    expect(screen.getByTestId('selected')).toHaveTextContent('i1');
    await userEvent.keyboard('{Escape}');
    expect(screen.getByTestId('selected').textContent).toBe('');
  });

  it('the checkbox of a section header selects its issues', async () => {
    render(<Harness rows={many(6)} />);
    await userEvent.click(screen.getByRole('checkbox', { name: 'Select Todo' }));
    expect(screen.getByTestId('selected')).toHaveTextContent('i1,i3,i5');
    await userEvent.click(screen.getByRole('checkbox', { name: 'Select Todo' }));
    expect(screen.getByTestId('selected').textContent).toBe('');
  });

  it('F2 renames: Enter saves the new title', async () => {
    const onRename = vi.fn();
    render(<Harness rows={many(3)} onRename={onRename} />);
    await userEvent.keyboard('j{F2}');
    const input = screen.getByTestId('issue-title-input-1');
    expect(input).toHaveFocus();
    await userEvent.clear(input);
    await userEvent.type(input, 'New name{Enter}');
    expect(onRename).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ id: 'i1' }),
      'New name',
    );
    expect(screen.queryByTestId('issue-title-input-1')).not.toBeInTheDocument();
  });

  it('double-click renames; Escape reverts without saving', async () => {
    const onRename = vi.fn();
    render(<Harness rows={many(3)} onRename={onRename} />);
    await userEvent.dblClick(screen.getByTestId('issue-title-2'));
    const input = screen.getByTestId('issue-title-input-2');
    await userEvent.clear(input);
    await userEvent.type(input, 'Nope{Escape}');
    expect(onRename).not.toHaveBeenCalled();
    expect(screen.getByTestId('issue-title-2')).toHaveTextContent('Issue 2');
  });

  it('leaving the field reverts too, and an unchanged or blank title is not saved', async () => {
    const onRename = vi.fn();
    render(<Harness rows={many(3)} onRename={onRename} />);
    await userEvent.dblClick(screen.getByTestId('issue-title-1'));
    await userEvent.type(screen.getByTestId('issue-title-input-1'), 'x');
    fireEvent.blur(screen.getByTestId('issue-title-input-1'));
    expect(onRename).not.toHaveBeenCalled();
    await userEvent.dblClick(screen.getByTestId('issue-title-1'));
    await userEvent.keyboard('{Enter}');
    expect(onRename).not.toHaveBeenCalled();
    await userEvent.dblClick(screen.getByTestId('issue-title-1'));
    await userEvent.clear(screen.getByTestId('issue-title-input-1'));
    await userEvent.keyboard('   {Enter}');
    expect(onRename).not.toHaveBeenCalled();
  });

  it('plain keys are ignored while renaming', async () => {
    render(<Harness rows={many(3)} display={{ ...DEFAULT_DISPLAY, group: 'none' }} />);
    await userEvent.keyboard('j{F2}');
    const input = screen.getByTestId('issue-title-input-1');
    await userEvent.clear(input);
    await userEvent.keyboard('jkx');
    expect(input).toHaveValue('jkx');
    expect(input).toHaveFocus();
    expect(screen.getByTestId('selected').textContent).toBe('');
  });

  it('a pending row shows the identifier placeholder, never a number', () => {
    render(
      <Harness
        rows={[row(1), row(0, { number: 0, id: 'tmp' }, true)]}
        display={{ ...DEFAULT_DISPLAY, group: 'none' }}
      />,
    );
    const pending = screen.getByTestId('issue-tmp');
    expect(within(pending).getByText('ENG-…')).toBeInTheDocument();
    expect(pending).toHaveAttribute('data-pending', 'true');
  });

  it('shows the properties the display asks for, and only those', () => {
    const rows = [row(1, { priority: 2, estimate: 5, due_date: '2026-12-02' })];
    const { rerender } = render(
      <Harness
        rows={rows}
        display={{
          ...DEFAULT_DISPLAY,
          group: 'none',
          properties: ['identifier', 'estimate', 'due'],
        }}
      />,
    );
    const item = screen.getByTestId('issue-1');
    expect(within(item).getByText('ENG-1')).toBeInTheDocument();
    expect(within(item).getByText('5')).toBeInTheDocument();
    expect(within(item).queryByLabelText('Priority')).not.toBeInTheDocument();
    rerender(
      <Harness rows={rows} display={{ ...DEFAULT_DISPLAY, group: 'none', properties: [] }} />,
    );
    expect(within(screen.getByTestId('issue-1')).queryByText('ENG-1')).not.toBeInTheDocument();
  });

  it('announces where focus went, politely', async () => {
    render(<Harness rows={many(3)} />);
    await userEvent.keyboard('j');
    expect(screen.getByRole('status')).toHaveTextContent('ENG-1');
    await act(async () => {});
  });

  it('a click and Space preview the issue, Enter opens it', async () => {
    const onOpen = vi.fn();
    const onPeek = vi.fn();
    render(<Harness rows={many(4)} onOpen={onOpen} onPeek={onPeek} />);
    await userEvent.click(screen.getByTestId('issue-1'));
    expect(onPeek).toHaveBeenLastCalledWith(expect.objectContaining({ id: 'i1' }));
    await userEvent.keyboard('j');
    await userEvent.keyboard('{ }');
    expect(onPeek).toHaveBeenLastCalledWith(expect.objectContaining({ id: 'i3' }));
    await userEvent.keyboard('{Enter}');
    expect(onOpen).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ id: 'i3' }));
    expect(onPeek).toHaveBeenCalledTimes(2);
  });

  it('Escape closes the preview before it clears the selection', async () => {
    const onClosePeek = vi.fn();
    render(<Harness rows={many(3)} peekOpen onClosePeek={onClosePeek} onPeek={() => {}} />);
    await userEvent.click(screen.getByTestId('issue-1'));
    expect(screen.getByTestId('selected')).toHaveTextContent('i1');
    await userEvent.keyboard('{Escape}');
    expect(onClosePeek).toHaveBeenCalledOnce();
    expect(screen.getByTestId('selected')).toHaveTextContent('i1');
  });
});
