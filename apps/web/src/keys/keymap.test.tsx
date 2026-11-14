// @vitest-environment jsdom
import { fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { listShortcuts, registerShortcut } from './keymap.ts';
import { ShortcutHelp } from './ShortcutHelp.tsx';
import { useShortcut } from './useShortcut.ts';

const cleanups: (() => void)[] = [];
function register(...args: Parameters<typeof registerShortcut>) {
  const unregister = registerShortcut(...args);
  cleanups.push(unregister);
  return unregister;
}
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
  vi.useRealTimers();
});

const press = (key: string, init: KeyboardEventInit = {}, target: Element = document.body) =>
  fireEvent.keyDown(target, { key, ...init });

describe('registerShortcut', () => {
  it('runs a mod chord on ctrl and on meta, and not on the bare key', () => {
    const handler = vi.fn();
    register({ id: 'palette', keys: 'mod+k', labelKey: 'shortcuts.help' }, handler);
    press('k', { ctrlKey: true });
    press('k', { metaKey: true });
    expect(handler).toHaveBeenCalledTimes(2);
    press('k');
    press('k', { altKey: true });
    expect(handler).toHaveBeenCalledTimes(2);
  });

  it('runs a two-key sequence only when the second key follows within a second', () => {
    vi.useFakeTimers();
    const handler = vi.fn();
    register({ id: 'go-inbox', keys: 'g i', labelKey: 'shell.inbox' }, handler);
    press('i');
    expect(handler).not.toHaveBeenCalled();
    press('g');
    vi.advanceTimersByTime(900);
    press('i');
    expect(handler).toHaveBeenCalledTimes(1);
    press('g');
    vi.advanceTimersByTime(1100);
    press('i');
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('ignores plain keys typed into an input but still runs mod chords there', async () => {
    const plain = vi.fn();
    const chord = vi.fn();
    register({ id: 'go-inbox', keys: 'g i', labelKey: 'shell.inbox' }, plain);
    register({ id: 'palette', keys: 'mod+k', labelKey: 'shortcuts.help' }, chord);
    render(<input aria-label="Title" />);
    const input = screen.getByLabelText('Title');
    await userEvent.type(input, 'gi');
    expect(plain).not.toHaveBeenCalled();
    expect(input).toHaveValue('gi');
    press('k', { ctrlKey: true }, input);
    expect(chord).toHaveBeenCalledTimes(1);
  });

  it.each(['textarea', 'select', 'editable'])('ignores plain keys inside a %s', (kind) => {
    const handler = vi.fn();
    register({ id: 'new', keys: 'c', labelKey: 'shell.inbox' }, handler);
    const { container } = render(
      kind === 'textarea' ? (
        <textarea aria-label="Notes" />
      ) : kind === 'select' ? (
        <select aria-label="Pick">
          <option>a</option>
        </select>
      ) : (
        <div contentEditable suppressContentEditableWarning>
          <span>text</span>
        </div>
      ),
    );
    const target =
      kind === 'editable'
        ? (container.querySelector('span') as Element)
        : (container.firstElementChild as Element);
    press('c', {}, target);
    expect(handler).not.toHaveBeenCalled();
    press('c');
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('stops running after it is unregistered', () => {
    const handler = vi.fn();
    const unregister = register(
      { id: 'palette', keys: 'mod+k', labelKey: 'shortcuts.help' },
      handler,
    );
    unregister();
    press('k', { ctrlKey: true });
    expect(handler).not.toHaveBeenCalled();
    expect(listShortcuts().some((shortcut) => shortcut.id === 'palette')).toBe(false);
  });

  it('lets a later registration with the same id replace the earlier one', () => {
    const first = vi.fn();
    const second = vi.fn();
    const unregisterFirst = register(
      { id: 'palette', keys: 'mod+k', labelKey: 'shortcuts.help' },
      first,
    );
    register({ id: 'palette', keys: 'mod+k', labelKey: 'shortcuts.help' }, second);
    press('k', { ctrlKey: true });
    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledTimes(1);
    // The replaced registration's cleanup must not remove the one that replaced it.
    unregisterFirst();
    press('k', { ctrlKey: true });
    expect(second).toHaveBeenCalledTimes(2);
    expect(listShortcuts().filter((shortcut) => shortcut.id === 'palette')).toHaveLength(1);
  });

  it('lists shortcuts by scope, then in registration order', () => {
    register({ id: 'b', keys: 'b', labelKey: 'shell.inbox', scope: 'issues' }, () => {});
    register({ id: 'a', keys: 'a', labelKey: 'shell.inbox' }, () => {});
    register({ id: 'c', keys: 'c', labelKey: 'shell.inbox', scope: 'issues' }, () => {});
    register({ id: 'd', keys: 'd', labelKey: 'shell.inbox', scope: 'global' }, () => {});
    expect(listShortcuts().map((shortcut) => shortcut.id)).toEqual(['a', 'd', 'b', 'c']);
  });
});

function Probe({ enabled, handler }: { enabled?: boolean; handler: () => void }) {
  useShortcut({ id: 'probe', keys: 'mod+j', labelKey: 'shortcuts.help' }, handler, { enabled });
  return null;
}

describe('useShortcut', () => {
  it('registers while mounted and enabled, and follows the latest handler', () => {
    const first = vi.fn();
    const second = vi.fn();
    const { rerender, unmount } = render(<Probe handler={first} />);
    press('j', { ctrlKey: true });
    expect(first).toHaveBeenCalledTimes(1);
    rerender(<Probe handler={second} />);
    press('j', { ctrlKey: true });
    expect(second).toHaveBeenCalledTimes(1);
    expect(first).toHaveBeenCalledTimes(1);
    rerender(<Probe handler={second} enabled={false} />);
    press('j', { ctrlKey: true });
    expect(second).toHaveBeenCalledTimes(1);
    rerender(<Probe handler={second} />);
    unmount();
    expect(listShortcuts().some((shortcut) => shortcut.id === 'probe')).toBe(false);
  });
});

describe('ShortcutHelp', () => {
  beforeEach(() => {
    register(
      { id: 'shell.toggleSidebar', keys: 'mod+/', labelKey: 'shortcuts.toggleSidebar' },
      () => {},
    );
  });

  it('opens on ? and lists every registered shortcut once, with its label', async () => {
    render(<ShortcutHelp />);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    press('?', { shiftKey: true });
    const dialog = await screen.findByRole('dialog', { name: 'Keyboard shortcuts' });
    expect(dialog).toHaveTextContent('Toggle sidebar');
    expect(dialog).toHaveTextContent('Show keyboard shortcuts');
    expect(screen.getAllByRole('listitem')).toHaveLength(listShortcuts().length);
    expect(new Set(listShortcuts().map((shortcut) => shortcut.id)).size).toBe(
      listShortcuts().length,
    );
  });

  it('closes on Escape and gives focus back', async () => {
    render(
      <>
        <button type="button">Page</button>
        <ShortcutHelp />
      </>,
    );
    screen.getByRole('button', { name: 'Page' }).focus();
    press('?', { shiftKey: true }, screen.getByRole('button', { name: 'Page' }));
    await screen.findByRole('dialog');
    await userEvent.keyboard('{Escape}');
    await vi.waitFor(() => expect(screen.getByRole('button', { name: 'Page' })).toHaveFocus());
  });

  it('types a ? in a textarea and opens nothing', async () => {
    render(
      <>
        <textarea aria-label="Notes" />
        <ShortcutHelp />
      </>,
    );
    await userEvent.type(screen.getByLabelText('Notes'), '?');
    expect(screen.getByLabelText('Notes')).toHaveValue('?');
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });
});
