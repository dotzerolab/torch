// @vitest-environment jsdom
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ViewFilter } from '@torch/shared/views';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { LocaleProvider } from '../design/locale.tsx';
import { FilterBar } from './FilterBar.tsx';
import { makeData } from './testing.ts';

function Harness({
  initial = {},
  onChange = () => {},
  ready = true,
}: {
  initial?: ViewFilter;
  onChange?: (next: ViewFilter) => void;
  ready?: boolean;
}) {
  const [filter, setFilter] = useState<ViewFilter>(initial);
  return (
    <LocaleProvider locale="en">
      <FilterBar
        filter={filter}
        data={makeData({ ready })}
        meId="me"
        onChange={(next) => {
          onChange(next);
          setFilter(next);
        }}
      />
    </LocaleProvider>
  );
}

describe('FilterBar', () => {
  it('offers the fields, then the values of one, and shows the choice as a chip', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<Harness onChange={onChange} />);
    await user.click(screen.getByRole('button', { name: 'Filter' }));
    await user.click(screen.getByRole('button', { name: 'State' }));
    await user.click(screen.getByRole('option', { name: /^Todo/ }));
    expect(onChange).toHaveBeenLastCalledWith({ state: ['s1'] });
    // A multi-value picker stays open: a second value joins the first.
    await user.click(screen.getByRole('option', { name: /^Done/ }));
    expect(onChange).toHaveBeenLastCalledWith({ state: ['s1', 's3'] });
    expect(screen.getByText('State: Todo')).toBeInTheDocument();
    expect(screen.getByText('State: Done')).toBeInTheDocument();
  });

  it('picking a chosen value again takes it out', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<Harness initial={{ priority: [1, 2] }} onChange={onChange} />);
    await user.click(screen.getByRole('button', { name: 'Filter' }));
    await user.click(screen.getByRole('button', { name: 'Priority' }));
    await user.click(screen.getByRole('option', { name: /^Urgent/ }));
    expect(onChange).toHaveBeenLastCalledWith({ priority: [2] });
  });

  it('names me, no assignee and a member', () => {
    render(<Harness initial={{ assignee: ['me', 'none', 'm2'] }} />);
    expect(screen.getByText('Assignee: Me')).toBeInTheDocument();
    expect(screen.getByText('Assignee: No assignee')).toBeInTheDocument();
    expect(screen.getByText('Assignee: Bo Sample')).toBeInTheDocument();
  });

  it('an id that no longer exists is an unavailable chip that can be removed', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    const gone = '11111111-1111-4111-8111-111111111111';
    render(<Harness initial={{ label: [gone, 'l1'] }} onChange={onChange} />);
    const stale = screen.getByText('Unavailable label');
    expect(stale).toBeInTheDocument();
    expect(screen.getByText('Label: Bug')).toBeInTheDocument();
    await user.click(within(stale.closest('[data-stale]') as HTMLElement).getByRole('button'));
    expect(onChange).toHaveBeenLastCalledWith({ label: ['l1'] });
  });

  it('an archived label, an archived state and a deactivated person are unavailable too', () => {
    render(
      <Harness initial={{ label: ['l2'], assignee: ['m3'], creator: ['m3'], state: ['nope'] }} />,
    );
    expect(screen.getByText('Unavailable label')).toBeInTheDocument();
    expect(screen.getAllByText('Unavailable person')).toHaveLength(2);
    expect(screen.getByText('Unavailable state')).toBeInTheDocument();
  });

  it('shows no unavailable chip while the reference data is still loading', () => {
    render(<Harness initial={{ label: ['l1', 'unknown-yet'] }} ready={false} />);
    expect(screen.queryByText('Unavailable label')).not.toBeInTheDocument();
  });

  it('removing the last value of a field removes the field', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<Harness initial={{ priority: [1], due: ['overdue'] }} onChange={onChange} />);
    await user.click(screen.getByRole('button', { name: 'Remove filter Priority: Urgent' }));
    expect(onChange).toHaveBeenLastCalledWith({ due: ['overdue'] });
  });

  it('Clear removes every chip and the text', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(
      <Harness initial={{ state: ['s1'], priority: [1], text: 'login' }} onChange={onChange} />,
    );
    await user.click(screen.getByRole('button', { name: 'Clear' }));
    expect(onChange).toHaveBeenLastCalledWith({});
    expect(screen.queryByText('State: Todo')).not.toBeInTheDocument();
    expect(screen.getByRole('searchbox')).toHaveValue('');
    expect(screen.queryByRole('button', { name: 'Clear' })).not.toBeInTheDocument();
  });

  it('typing searches the text, spaces included', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<Harness onChange={onChange} />);
    const box = screen.getByRole('searchbox', { name: 'Search title or identifier' });
    await user.type(box, 'a b');
    expect(box).toHaveValue('a b');
    expect(onChange).toHaveBeenLastCalledWith({ text: 'a b' });
    await user.clear(box);
    expect(onChange).toHaveBeenLastCalledWith({});
  });

  it('f opens the filter menu and / focuses the text field', async () => {
    const user = userEvent.setup();
    render(<Harness />);
    await user.keyboard('/');
    expect(screen.getByRole('searchbox')).toHaveFocus();
    await user.keyboard('{Escape}');
    (document.activeElement as HTMLElement).blur();
    await user.keyboard('f');
    expect(screen.getByRole('button', { name: 'State' })).toBeInTheDocument();
  });
});
