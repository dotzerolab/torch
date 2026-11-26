// @vitest-environment jsdom
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { DEFAULT_DISPLAY, GROUPS } from '@torch/shared/views';
import { describe, expect, it, vi } from 'vitest';
import { LocaleProvider } from '../design/locale.tsx';
import { DisplayMenu } from './DisplayMenu.tsx';

async function open(onChange = vi.fn(), display = DEFAULT_DISPLAY) {
  const user = userEvent.setup();
  render(
    <LocaleProvider locale="en">
      <DisplayMenu display={display} onChange={onChange} />
    </LocaleProvider>,
  );
  await user.click(screen.getByRole('button', { name: 'Display' }));
  return { user, onChange };
}

describe('DisplayMenu', () => {
  it('shows the current choices', async () => {
    await open();
    expect(screen.getByLabelText('Grouping')).toHaveValue('state');
    expect(screen.getByLabelText('Ordering')).toHaveValue('manual');
    expect(screen.getByLabelText('Show empty groups')).not.toBeChecked();
    expect(screen.getByLabelText('Show sub-issues in the list')).toBeChecked();
  });

  it('a change sends the whole display, the other options untouched', async () => {
    const { user, onChange } = await open();
    await user.selectOptions(screen.getByLabelText('Grouping'), 'assignee');
    expect(onChange).toHaveBeenLastCalledWith({ ...DEFAULT_DISPLAY, group: 'assignee' });
    await user.selectOptions(screen.getByLabelText('Ordering'), 'title');
    expect(onChange).toHaveBeenLastCalledWith({ ...DEFAULT_DISPLAY, order: 'title' });
    await user.selectOptions(screen.getByLabelText('Direction'), 'desc');
    expect(onChange).toHaveBeenLastCalledWith({ ...DEFAULT_DISPLAY, direction: 'desc' });
  });

  it('layout, empty groups and archived switch', async () => {
    const { user, onChange } = await open();
    await user.click(screen.getByRole('radio', { name: 'Board' }));
    expect(onChange).toHaveBeenLastCalledWith({ ...DEFAULT_DISPLAY, layout: 'board' });
    await user.click(screen.getByLabelText('Show empty groups'));
    expect(onChange).toHaveBeenLastCalledWith({ ...DEFAULT_DISPLAY, showEmptyGroups: true });
    await user.click(screen.getByLabelText('Show archived issues'));
    expect(onChange).toHaveBeenLastCalledWith({ ...DEFAULT_DISPLAY, showArchived: true });
  });

  it('properties are switched one by one and keep their order', async () => {
    const { user, onChange } = await open();
    await user.click(screen.getByLabelText('Estimate'));
    expect(onChange).toHaveBeenLastCalledWith({
      ...DEFAULT_DISPLAY,
      properties: ['priority', 'identifier', 'state', 'labels', 'due', 'estimate', 'assignee'],
    });
    await user.click(screen.getByLabelText('Labels'));
    expect(onChange).toHaveBeenLastCalledWith({
      ...DEFAULT_DISPLAY,
      properties: ['priority', 'identifier', 'state', 'due', 'assignee'],
    });
  });

  it('offers no team grouping on a team screen, and does on a screen across teams', async () => {
    await open();
    expect(screen.queryByRole('option', { name: 'Team' })).not.toBeInTheDocument();
    render(
      <LocaleProvider locale="en">
        <DisplayMenu display={DEFAULT_DISPLAY} onChange={() => {}} groups={GROUPS} />
      </LocaleProvider>,
    );
    await userEvent.click(screen.getAllByRole('button', { name: 'Display' })[1] as HTMLElement);
    expect(screen.getByRole('option', { name: 'Team' })).toBeInTheDocument();
  });

  it('Reset gives the defaults back', async () => {
    const { user, onChange } = await open(vi.fn(), { ...DEFAULT_DISPLAY, group: 'priority' });
    await user.click(screen.getByRole('button', { name: 'Reset' }));
    expect(onChange).toHaveBeenLastCalledWith(DEFAULT_DISPLAY);
  });
});
