// @vitest-environment jsdom
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { Select } from './Select.tsx';

const options = [
  { value: 'low', label: 'Low' },
  { value: 'high', label: 'High' },
  { value: 'urgent', label: 'Urgent' },
];

describe('Select', () => {
  it('uses its label as the accessible name and shows the chosen option', () => {
    render(<Select label="Priority" value="high" onValueChange={() => {}} options={options} />);
    const trigger = screen.getByRole('combobox', { name: 'Priority' });
    expect(trigger).toHaveTextContent('High');
  });

  it('reports the value of the option chosen with the keyboard', async () => {
    const onValueChange = vi.fn();
    render(<Select label="Priority" value="low" onValueChange={onValueChange} options={options} />);
    screen.getByRole('combobox', { name: 'Priority' }).focus();
    await userEvent.keyboard('{Enter}');
    await screen.findByRole('listbox');
    await userEvent.keyboard('{ArrowDown}{Enter}');
    expect(onValueChange).toHaveBeenCalledWith('high');
  });
});
