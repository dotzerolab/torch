import { useState } from 'react';
import { Dialog } from '../design/components/Dialog.tsx';
import { Kbd } from '../design/components/Kbd.tsx';
import { useT } from '../design/locale.tsx';
import { listShortcuts } from './keymap.ts';
import { useShortcut } from './useShortcut.ts';

/** The keyboard cheat sheet: `?` opens it, and it lists whatever is registered at that moment. */
export function ShortcutHelp() {
  const t = useT();
  const [open, setOpen] = useState(false);
  useShortcut({ id: 'shortcuts.help', keys: '?', labelKey: 'shortcuts.help' }, () => setOpen(true));

  return (
    <Dialog open={open} onOpenChange={setOpen} title={t('shortcuts.title')}>
      {open ? (
        <ul className="shortcut-list">
          {listShortcuts().map((shortcut) => (
            <li key={shortcut.id} className="shortcut-list__item">
              <span>{t(shortcut.labelKey)}</span>
              <Kbd keys={shortcut.keys} />
            </li>
          ))}
        </ul>
      ) : null}
    </Dialog>
  );
}
