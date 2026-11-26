// @vitest-environment jsdom
import { fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { DEFAULT_DISPLAY, type ViewDisplay } from '@torch/shared/views';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { LocaleProvider } from '../design/locale.tsx';
import { IssueBoard } from './IssueBoard.tsx';
import { buildSections, type IssueRow } from './model/engine.ts';
import { SelectionProvider, useSelection } from './SelectionContext.tsx';
import { makeData, makeRow } from './testing.ts';

const data = makeData();
const ctx = { meId: 'me', today: '2026-11-26', states: data.statesById };

// jsdom has no layout: give the columns a size.
beforeAll(() => {
  Object.defineProperty(Element.prototype, 'clientHeight', { configurable: true, get: () => 600 });
  Object.defineProperty(Element.prototype, 'clientWidth', { configurable: true, get: () => 300 });
});

function Selected() {
  const { ids } = useSelection();
  return <p data-testid="selected">{[...ids].sort().join(',')}</p>;
}

function Harness({
  rows,
  display = { ...DEFAULT_DISPLAY, layout: 'board' },
  onUpdate = () => {},
  onOpen = () => {},
}: {
  rows: IssueRow[];
  display?: ViewDisplay;
  onUpdate?: (row: IssueRow, patch: unknown) => void;
  onOpen?: (row: IssueRow) => void;
}) {
  const sections = buildSections(rows, {}, display, ctx);
  return (
    <LocaleProvider locale="en">
      <SelectionProvider>
        <Selected />
        <IssueBoard
          sections={sections}
          display={display}
          data={data}
          meId="me"
          today="2026-11-26"
          teamKey="ENG"
          initialRect={{ width: 300, height: 600 }}
          renderHeaderAction={(section) => <span data-testid={`action-${section.key}`}>+</span>}
          onOpen={onOpen}
          onRename={() => {}}
          onUpdate={onUpdate as never}
        />
      </SelectionProvider>
    </LocaleProvider>
  );
}

const five = () => [1, 2, 3, 4, 5].map((n) => makeRow(n));
const focusedKey = () => document.activeElement?.getAttribute('data-testid');

describe('IssueBoard', () => {
  it('columns follow workflow order with counts', () => {
    render(
      <Harness
        rows={five()}
        display={{ ...DEFAULT_DISPLAY, layout: 'board', showEmptyGroups: true }}
      />,
    );
    const columns = screen.getAllByTestId(/^column-/);
    expect(columns.map((column) => column.getAttribute('data-testid'))).toEqual([
      'column-state:s1',
      'column-state:s2',
      'column-state:s3',
    ]);
    expect(within(columns[0] as HTMLElement).getByRole('heading')).toHaveTextContent('Todo3');
    expect(within(columns[1] as HTMLElement).getByRole('heading')).toHaveTextContent(
      'In Progress2',
    );
    expect(within(columns[2] as HTMLElement).getByRole('heading')).toHaveTextContent('Done0');
  });

  it('each column header carries the slot of its action', () => {
    render(<Harness rows={five()} />);
    expect(screen.getByTestId('action-state:s1')).toBeInTheDocument();
  });

  it('a card shows identifier, title and its cells', () => {
    render(
      <Harness rows={[makeRow(3, { priority: 1, due_date: '2026-11-20', assignee_id: 'me' })]} />,
    );
    const card = screen.getByTestId('issue-3');
    expect(card).toHaveTextContent('ENG-3');
    expect(within(card).getByTestId('issue-title-3')).toHaveTextContent('Issue 3');
    expect(within(card).getByRole('button', { name: 'Assignee' })).toBeInTheDocument();
    expect(within(card).getByRole('button', { name: 'Due date' })).toHaveClass(
      'issue-cell--overdue',
    );
  });

  it('a 5,000-card column renders a window', () => {
    const rows = Array.from({ length: 5000 }, (_, i) => makeRow(i + 1, { state_id: 's1' }));
    render(<Harness rows={rows} />);
    const cards = screen.getAllByRole('listitem');
    expect(cards.length).toBeGreaterThan(5);
    expect(cards.length).toBeLessThan(40);
    expect(screen.getByTestId('column-state:s1').querySelector('[role="list"]')).toHaveAttribute(
      'data-issue-count',
      '5000',
    );
  });

  it('arrow keys move focus down a column and across columns', async () => {
    const user = userEvent.setup();
    render(<Harness rows={five()} />);
    // Todo: 1, 3, 5 (sorted by manual order); In Progress: 2, 4.
    screen.getByTestId('issue-1').focus();
    await user.keyboard('{ArrowDown}');
    expect(focusedKey()).toBe('issue-3');
    await user.keyboard('{ArrowRight}');
    expect(focusedKey()).toBe('issue-4');
    await user.keyboard('{ArrowLeft}');
    expect(focusedKey()).toBe('issue-3');
    await user.keyboard('{ArrowUp}');
    expect(focusedKey()).toBe('issue-1');
    // The edges stay where they are.
    await user.keyboard('{ArrowLeft}');
    expect(focusedKey()).toBe('issue-1');
    await user.keyboard('j');
    expect(focusedKey()).toBe('issue-3');
  });

  it('moving right from a deeper card lands on the last card of a shorter column', async () => {
    const user = userEvent.setup();
    render(<Harness rows={five()} />);
    screen.getByTestId('issue-5').focus();
    await user.keyboard('{ArrowRight}');
    expect(focusedKey()).toBe('issue-4');
  });

  it('clicking selects and opens; x selects the focused card', async () => {
    const user = userEvent.setup();
    const onOpen = vi.fn();
    render(<Harness rows={five()} onOpen={onOpen} />);
    await user.click(screen.getByTestId('issue-2'));
    expect(screen.getByTestId('selected')).toHaveTextContent('i2');
    expect(onOpen).toHaveBeenCalledOnce();
    screen.getByTestId('issue-1').focus();
    await user.keyboard('x');
    expect(screen.getByTestId('selected')).toHaveTextContent('i1,i2');
    await user.keyboard('{Escape}');
    expect(screen.getByTestId('selected')).toHaveTextContent('');
  });

  it('s on a card opens the state picker and a pick updates that issue', async () => {
    const user = userEvent.setup();
    const onUpdate = vi.fn();
    render(<Harness rows={five()} onUpdate={onUpdate} />);
    screen.getByTestId('issue-1').focus();
    await user.keyboard('s');
    await user.click(await screen.findByRole('option', { name: /^Done/ }));
    expect(onUpdate).toHaveBeenCalledWith(expect.objectContaining({ id: 'i1' }), { stateId: 's3' });
  });

  it('double-click renames the title in place', async () => {
    const user = userEvent.setup();
    render(<Harness rows={five()} />);
    fireEvent.doubleClick(screen.getByTestId('issue-title-1'));
    expect(screen.getByTestId('issue-title-input-1')).toHaveFocus();
    await user.keyboard('{Escape}');
    expect(screen.queryByTestId('issue-title-input-1')).not.toBeInTheDocument();
  });
});
