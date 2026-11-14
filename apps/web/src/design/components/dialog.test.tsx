// @vitest-environment jsdom
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { Dialog } from './Dialog.tsx';

function Harness({ onChange }: { onChange?: (open: boolean) => void }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" onClick={() => setOpen(true)}>
        Open
      </button>
      <Dialog
        open={open}
        onOpenChange={(next) => {
          onChange?.(next);
          setOpen(next);
        }}
        title="Rename issue"
        description="Pick a new title."
      >
        <input aria-label="Title" />
        <button type="button">Save</button>
      </Dialog>
    </>
  );
}

describe('Dialog', () => {
  it('focuses the first focusable element when it opens', async () => {
    render(<Harness />);
    await userEvent.click(screen.getByRole('button', { name: 'Open' }));
    await waitFor(() => expect(screen.getByLabelText('Title')).toHaveFocus());
  });

  it('keeps Tab inside the dialog', async () => {
    render(<Harness />);
    await userEvent.click(screen.getByRole('button', { name: 'Open' }));
    await waitFor(() => expect(screen.getByLabelText('Title')).toHaveFocus());
    const seen: (string | null)[] = [];
    for (let i = 0; i < 6; i++) {
      await userEvent.tab();
      seen.push(
        document.activeElement?.getAttribute('aria-label') ??
          document.activeElement?.textContent ??
          null,
      );
    }
    const dialog = screen.getByRole('dialog');
    expect(dialog.contains(document.activeElement)).toBe(true);
    expect(seen).toContain('Save');
    expect(seen).toContain('Close');
    expect(screen.getByRole('button', { name: 'Open', hidden: true })).not.toHaveFocus();
  });

  it('calls onOpenChange(false) on Escape and gives focus back to the trigger', async () => {
    const onChange = vi.fn();
    render(<Harness onChange={onChange} />);
    const trigger = screen.getByRole('button', { name: 'Open' });
    await userEvent.click(trigger);
    await waitFor(() => expect(screen.getByLabelText('Title')).toHaveFocus());
    await userEvent.keyboard('{Escape}');
    expect(onChange).toHaveBeenLastCalledWith(false);
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    // Radix hands focus back on the next tick after the content unmounts.
    await waitFor(() => expect(trigger).toHaveFocus());
  });

  it('is labelled by its title and described by its description', async () => {
    render(<Harness />);
    await userEvent.click(screen.getByRole('button', { name: 'Open' }));
    const dialog = await screen.findByRole('dialog', { name: 'Rename issue' });
    const labelledBy = dialog.getAttribute('aria-labelledby');
    expect(labelledBy).toBeTruthy();
    expect(document.getElementById(labelledBy as string)).toHaveTextContent('Rename issue');
    expect(dialog).toHaveAccessibleDescription('Pick a new title.');
  });

  it('closes from its close button', async () => {
    const onChange = vi.fn();
    render(<Harness onChange={onChange} />);
    await userEvent.click(screen.getByRole('button', { name: 'Open' }));
    await userEvent.click(await screen.findByRole('button', { name: 'Close' }));
    expect(onChange).toHaveBeenLastCalledWith(false);
  });
});
