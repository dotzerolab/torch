// @vitest-environment jsdom
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { Button } from './Button.tsx';
import { Menu } from './Menu.tsx';

function setup() {
  const onRename = vi.fn();
  const onArchive = vi.fn();
  const onDelete = vi.fn();
  render(
    <Menu
      trigger={<Button variant="secondary">Actions</Button>}
      items={[
        { id: 'rename', label: 'Rename', shortcut: 'r', onSelect: onRename },
        { id: 'archive', label: 'Archive', disabled: true, onSelect: onArchive },
        { id: 'delete', label: 'Delete', danger: true, onSelect: onDelete },
      ]}
    />,
  );
  return {
    onRename,
    onArchive,
    onDelete,
    trigger: screen.getByRole('button', { name: 'Actions' }),
  };
}

describe('Menu', () => {
  it('opens with the keyboard and moves between items, skipping a disabled one', async () => {
    const { trigger } = setup();
    trigger.focus();
    await userEvent.keyboard('{ArrowDown}');
    const first = await screen.findByRole('menuitem', { name: /Rename/ });
    await waitFor(() => expect(first).toHaveFocus());
    await userEvent.keyboard('{ArrowDown}');
    expect(screen.getByRole('menuitem', { name: 'Delete' })).toHaveFocus();
    await userEvent.keyboard('{ArrowDown}');
    expect(first).toHaveFocus();
  });

  it('runs onSelect for the focused item on Enter', async () => {
    const { trigger, onDelete, onArchive } = setup();
    trigger.focus();
    await userEvent.keyboard('{ArrowDown}');
    await screen.findByRole('menuitem', { name: /Rename/ });
    await userEvent.keyboard('{ArrowDown}{Enter}');
    expect(onDelete).toHaveBeenCalledTimes(1);
    expect(onArchive).not.toHaveBeenCalled();
  });

  it('marks the disabled item and shows the shortcut', async () => {
    const { trigger } = setup();
    trigger.focus();
    await userEvent.keyboard('{ArrowDown}');
    expect(await screen.findByRole('menuitem', { name: 'Archive' })).toHaveAttribute(
      'aria-disabled',
      'true',
    );
    expect(screen.getByRole('menuitem', { name: /Rename/ })).toHaveTextContent('R');
  });

  it('closes on Escape and returns focus to the trigger', async () => {
    const { trigger } = setup();
    trigger.focus();
    await userEvent.keyboard('{ArrowDown}');
    await screen.findByRole('menu');
    await userEvent.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('menu')).not.toBeInTheDocument());
    expect(trigger).toHaveFocus();
  });
});
