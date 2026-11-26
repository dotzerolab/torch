// @vitest-environment jsdom
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { LocaleProvider } from '../../design/locale.tsx';
import type { SyncedLabel, SyncedMember, SyncedWorkflowState } from '../../sync/collections.ts';
import { AssigneePicker } from './AssigneePicker.tsx';
import { DatePicker } from './DatePicker.tsx';
import { ESTIMATE_SCALE, EstimatePicker } from './EstimatePicker.tsx';
import { LabelPicker, labelDiff } from './LabelPicker.tsx';
import { PriorityPicker } from './PriorityPicker.tsx';
import { StatePicker } from './StatePicker.tsx';

const inEnglish = (node: React.ReactNode) =>
  render(<LocaleProvider locale="en">{node}</LocaleProvider>);
const names = () => screen.getAllByRole('option').map((o) => o.textContent);

const state = (
  id: string,
  name: string,
  type: string,
  position: number,
  archived = false,
): SyncedWorkflowState => ({
  id,
  workspace_id: 'w',
  team_id: 't',
  name,
  type,
  position,
  color: '#aabbcc',
  archived_at: archived ? '2026-01-01T00:00:00Z' : null,
});

describe('StatePicker', () => {
  const states = [
    state('s3', 'Done', 'completed', 3),
    state('s1', 'Todo', 'unstarted', 1),
    state('s2', 'In Progress', 'started', 2),
    state('s0', 'Old', 'backlog', 0, true),
  ];

  it('lists by workflow position with the type, and leaves out archived states', () => {
    inEnglish(<StatePicker states={states} value="s1" onChange={() => {}} onClose={() => {}} />);
    expect(names()).toEqual(['TodoUnstarted', 'In ProgressStarted', 'DoneCompleted']);
    expect(screen.getByRole('option', { name: /Todo/ })).toHaveAttribute('aria-selected', 'true');
  });

  it('still shows the archived state an issue is in, so the current value is not blank', () => {
    inEnglish(<StatePicker states={states} value="s0" onChange={() => {}} onClose={() => {}} />);
    expect(names()[0]).toBe('OldBacklog');
    expect(screen.getByRole('option', { name: /Old/ })).toHaveAttribute('aria-selected', 'true');
  });

  it('chooses a state by its id', async () => {
    const onChange = vi.fn();
    const onClose = vi.fn();
    inEnglish(<StatePicker states={states} value="s1" onChange={onChange} onClose={onClose} />);
    await userEvent.click(screen.getByRole('option', { name: /Done/ }));
    expect(onChange).toHaveBeenCalledExactlyOnceWith('s3');
    expect(onClose).toHaveBeenCalledOnce();
  });
});

describe('PriorityPicker', () => {
  it('offers the five priorities, urgent first and none last, and picks a number', async () => {
    const onChange = vi.fn();
    inEnglish(<PriorityPicker value={0} onChange={onChange} onClose={() => {}} />);
    expect(names()).toEqual(['Urgent', 'High', 'Medium', 'Low', 'No priority']);
    await userEvent.click(screen.getByRole('option', { name: 'High' }));
    expect(onChange).toHaveBeenCalledExactlyOnceWith(2);
  });
});

const member = (id: string, name: string, deactivated = false): SyncedMember => ({
  id,
  workspace_id: 'w',
  name,
  handle: name.toLowerCase(),
  role: 'member',
  locale: 'en',
  deactivated_at: deactivated ? '2026-01-01T00:00:00Z' : null,
  created_at: '2025-01-01T00:00:00Z',
});

// An avatar's initials are part of the text of an option: B, A, C, D.
describe('AssigneePicker', () => {
  const members = [
    member('m3', 'Cleo'),
    member('m1', 'Ana'),
    member('me', 'Bea'),
    member('m4', 'Dan', true),
  ];

  it('lists No assignee, then Me, then the members by name; deactivated ones are omitted', () => {
    inEnglish(
      <AssigneePicker
        members={members}
        meId="me"
        value={null}
        onChange={() => {}}
        onClose={() => {}}
      />,
    );
    expect(names()).toEqual(['No assignee', 'BMeBea', 'AAna', 'CCleo']);
  });

  it('keeps a deactivated current assignee, marked, and omits the other deactivated ones', () => {
    inEnglish(
      <AssigneePicker
        members={members}
        meId="me"
        value="m4"
        onChange={() => {}}
        onClose={() => {}}
      />,
    );
    expect(names()).toEqual(['No assignee', 'BMeBea', 'AAna', 'CCleo', 'DDanDeactivated']);
    expect(screen.getByRole('option', { name: /Dan/ })).toHaveAttribute('aria-selected', 'true');
  });

  it('picks null for no assignee and an id for a person', async () => {
    const onChange = vi.fn();
    inEnglish(
      <AssigneePicker
        members={members}
        meId="me"
        value="m1"
        onChange={onChange}
        onClose={() => {}}
      />,
    );
    await userEvent.click(screen.getByRole('option', { name: 'No assignee' }));
    expect(onChange).toHaveBeenLastCalledWith(null);
    await userEvent.click(screen.getByRole('option', { name: /Cleo/ }));
    expect(onChange).toHaveBeenLastCalledWith('m3');
  });
});

const label = (id: string, name: string, extra: Partial<SyncedLabel> = {}): SyncedLabel => ({
  id,
  workspace_id: 'w',
  team_id: 't',
  parent_id: null,
  name,
  color: '#112233',
  is_group: false,
  archived_at: null,
  created_at: '2025-01-01T00:00:00Z',
  ...extra,
});

describe('LabelPicker', () => {
  const labels = [
    label('g', 'Area', { is_group: true }),
    label('g1', 'Web', { parent_id: 'g' }),
    label('g2', 'API', { parent_id: 'g' }),
    label('bug', 'Bug'),
    label('ws', 'Customer', { team_id: null }),
  ];

  it('shows a group as a heading with its labels under it, and the scope of each label', () => {
    inEnglish(<LabelPicker labels={labels} value={[]} onChange={() => {}} onClose={() => {}} />);
    expect(screen.getByText('Area')).toBeInTheDocument();
    expect(screen.queryByRole('option', { name: 'Area' })).not.toBeInTheDocument();
    expect(names()).toEqual(['APITeam', 'WebTeam', 'BugTeam', 'CustomerWorkspace']);
  });

  it('choosing a child replaces its siblings, the server rule', async () => {
    const onChange = vi.fn();
    inEnglish(
      <LabelPicker labels={labels} value={['g1', 'bug']} onChange={onChange} onClose={() => {}} />,
    );
    await userEvent.click(screen.getByRole('option', { name: /API/ }));
    expect(onChange).toHaveBeenLastCalledWith(['bug', 'g2']);
  });

  it('choosing a selected label takes it off, and a plain label toggles freely', async () => {
    const onChange = vi.fn();
    inEnglish(
      <LabelPicker labels={labels} value={['bug']} onChange={onChange} onClose={() => {}} />,
    );
    await userEvent.click(screen.getByRole('option', { name: /Customer/ }));
    expect(onChange).toHaveBeenLastCalledWith(['bug', 'ws']);
    await userEvent.click(screen.getByRole('option', { name: /Bug/ }));
    expect(onChange).toHaveBeenLastCalledWith([]);
  });

  it('stays open for more choices', async () => {
    const onClose = vi.fn();
    inEnglish(<LabelPicker labels={labels} value={[]} onChange={() => {}} onClose={onClose} />);
    await userEvent.click(screen.getByRole('option', { name: /Bug/ }));
    expect(onClose).not.toHaveBeenCalled();
  });

  it('labelDiff says what to add and what to remove', () => {
    expect(labelDiff(['a', 'b'], ['b', 'c'])).toEqual({
      addLabelIds: ['c'],
      removeLabelIds: ['a'],
    });
    expect(labelDiff(['a'], ['a'])).toEqual({ addLabelIds: [], removeLabelIds: [] });
  });
});

describe('DatePicker', () => {
  it('offers today, tomorrow, next week and clear, counted from the day it is given', async () => {
    const onChange = vi.fn();
    inEnglish(
      <DatePicker value={null} today="2026-12-30" onChange={onChange} onClose={() => {}} />,
    );
    await userEvent.click(screen.getByRole('option', { name: /Today/ }));
    expect(onChange).toHaveBeenLastCalledWith('2026-12-30');
    await userEvent.click(screen.getByRole('option', { name: /Tomorrow/ }));
    expect(onChange).toHaveBeenLastCalledWith('2026-12-31');
    await userEvent.click(screen.getByRole('option', { name: /Next week/ }));
    expect(onChange).toHaveBeenLastCalledWith('2027-01-06');
  });

  it('clears the date with null', async () => {
    const onChange = vi.fn();
    inEnglish(
      <DatePicker value="2026-12-01" today="2026-11-26" onChange={onChange} onClose={() => {}} />,
    );
    await userEvent.click(screen.getByRole('option', { name: 'No due date' }));
    expect(onChange).toHaveBeenLastCalledWith(null);
  });

  it('takes a date typed in the field', async () => {
    const onChange = vi.fn();
    inEnglish(
      <DatePicker value={null} today="2026-11-26" onChange={onChange} onClose={() => {}} />,
    );
    const input = screen.getByLabelText('Pick a date');
    await userEvent.type(input, '2026-12-24');
    expect(onChange).toHaveBeenLastCalledWith('2026-12-24');
  });

  it('shows the chosen date', () => {
    inEnglish(
      <DatePicker value="2026-12-01" today="2026-11-26" onChange={() => {}} onClose={() => {}} />,
    );
    expect(screen.getByLabelText('Pick a date')).toHaveValue('2026-12-01');
  });
});

describe('EstimatePicker', () => {
  it('offers the scale, none first', async () => {
    const onChange = vi.fn();
    inEnglish(<EstimatePicker value={5} onChange={onChange} onClose={() => {}} />);
    expect(names()).toEqual(['No estimate', '0', '1', '2', '3', '5', '8', '13', '21']);
    expect([...ESTIMATE_SCALE]).toEqual([0, 1, 2, 3, 5, 8, 13, 21]);
    expect(screen.getByRole('option', { name: '5' })).toHaveAttribute('aria-selected', 'true');
    await userEvent.click(screen.getByRole('option', { name: '13' }));
    expect(onChange).toHaveBeenLastCalledWith(13);
    await userEvent.click(screen.getByRole('option', { name: 'No estimate' }));
    expect(onChange).toHaveBeenLastCalledWith(null);
  });

  it('keeps an estimate outside the scale as the current value', () => {
    inEnglish(<EstimatePicker value={7} onChange={() => {}} onClose={() => {}} />);
    const list = screen.getByRole('listbox');
    expect(within(list).getByRole('option', { name: '7' })).toHaveAttribute(
      'aria-selected',
      'true',
    );
  });
});
