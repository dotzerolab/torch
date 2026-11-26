// @vitest-environment jsdom
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { LocaleProvider } from '../../design/locale.tsx';
import { type PickerOption, PropertyPicker } from './PropertyPicker.tsx';

const options: PickerOption[] = [
  { id: 'a', label: 'Alpha' },
  { id: 'b', label: 'Beta', hint: 'second' },
  { id: 'h', label: 'Group', heading: true },
  { id: 'c', label: 'Gamma' },
  { id: 'd', label: 'Delta', disabled: true },
];

function renderPicker(props: Partial<React.ComponentProps<typeof PropertyPicker>> = {}) {
  const onPick = vi.fn();
  const onClose = vi.fn();
  render(
    <LocaleProvider locale="en">
      <PropertyPicker
        label="Pick one"
        options={options}
        selectedIds={['b']}
        onPick={onPick}
        onClose={onClose}
        {...props}
      />
    </LocaleProvider>,
  );
  return { onPick, onClose };
}

describe('PropertyPicker', () => {
  it('lists the options with the selected one marked, and the headings as plain text', () => {
    renderPicker();
    expect(screen.getAllByRole('option').map((o) => o.textContent)).toEqual([
      'Alpha',
      'Betasecond',
      'Gamma',
      'Delta',
    ]);
    expect(screen.getByRole('option', { name: /Beta/ })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByRole('option', { name: 'Alpha' })).toHaveAttribute('aria-selected', 'false');
    expect(screen.getByText('Group')).toBeInTheDocument();
  });

  it('focuses the filter field, and the filter narrows the options (headings follow their options)', async () => {
    renderPicker();
    const filter = screen.getByRole('combobox');
    expect(filter).toHaveFocus();
    await userEvent.type(filter, 'gam');
    expect(screen.getAllByRole('option').map((o) => o.textContent)).toEqual(['Gamma']);
    expect(screen.getByText('Group')).toBeInTheDocument();
    await userEvent.clear(filter);
    await userEvent.type(filter, 'alp');
    expect(screen.queryByText('Group')).not.toBeInTheDocument();
  });

  it('says so when nothing matches', async () => {
    renderPicker();
    await userEvent.type(screen.getByRole('combobox'), 'zzz');
    expect(screen.queryAllByRole('option')).toHaveLength(0);
    expect(screen.getByText('No matches')).toBeInTheDocument();
  });

  it('arrow keys move the active option, Enter picks it, and aria-activedescendant follows', async () => {
    const { onPick } = renderPicker({ selectedIds: [] });
    const filter = screen.getByRole('combobox');
    const active = () =>
      document.getElementById(filter.getAttribute('aria-activedescendant') ?? '');
    expect(active()).toHaveTextContent('Alpha');
    await userEvent.keyboard('{ArrowDown}');
    expect(active()).toHaveTextContent('Beta');
    // The heading is skipped, and so is the disabled option.
    await userEvent.keyboard('{ArrowDown}');
    expect(active()).toHaveTextContent('Gamma');
    await userEvent.keyboard('{ArrowDown}');
    expect(active()).toHaveTextContent('Gamma');
    await userEvent.keyboard('{ArrowUp}{ArrowUp}{ArrowUp}');
    expect(active()).toHaveTextContent('Alpha');
    await userEvent.keyboard('{ArrowDown}{Enter}');
    expect(onPick).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ id: 'b' }));
  });

  it('starts on the selected option', () => {
    renderPicker({ selectedIds: ['c'] });
    const filter = screen.getByRole('combobox');
    expect(
      document.getElementById(filter.getAttribute('aria-activedescendant') ?? ''),
    ).toHaveTextContent('Gamma');
  });

  it('a click picks, a disabled option does not', async () => {
    const { onPick } = renderPicker();
    await userEvent.click(screen.getByRole('option', { name: 'Delta' }));
    expect(onPick).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole('option', { name: 'Gamma' }));
    expect(onPick).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ id: 'c' }));
  });

  it('Escape closes it', async () => {
    const { onClose } = renderPicker();
    await userEvent.keyboard('{Escape}');
    expect(onClose).toHaveBeenCalledOnce();
  });

  it('no filter field when asked not to (short lists)', () => {
    renderPicker({ filterable: false });
    expect(screen.queryByRole('combobox')).not.toBeInTheDocument();
    expect(screen.getByRole('listbox', { name: 'Pick one' })).toBeInTheDocument();
  });
});
