import * as RadixMenu from '@radix-ui/react-dropdown-menu';
import type { ReactNode } from 'react';
import { cx } from '../cx.ts';
import { Kbd } from './Kbd.tsx';

export type MenuItem = {
  id: string;
  label: string;
  icon?: ReactNode;
  /** Shown as a key cap on the right, for example `mod+k`. Display only: the screen binds the key itself. */
  shortcut?: string;
  onSelect: () => void;
  danger?: boolean;
  disabled?: boolean;
};

/** A menu opened from its trigger. Arrow keys move (skipping disabled items), Enter selects, Escape closes. */
export function Menu({
  trigger,
  items,
  align = 'start',
}: {
  trigger: ReactNode;
  items: MenuItem[];
  align?: 'start' | 'center' | 'end';
}) {
  return (
    <RadixMenu.Root>
      <RadixMenu.Trigger asChild>{trigger}</RadixMenu.Trigger>
      <RadixMenu.Portal>
        <RadixMenu.Content className="menu" align={align} sideOffset={6} loop>
          {items.map((item) => (
            <RadixMenu.Item
              key={item.id}
              className={cx('menu__item', item.danger && 'menu__item--danger')}
              disabled={item.disabled}
              onSelect={item.onSelect}
            >
              {item.icon ? <span className="menu__icon">{item.icon}</span> : null}
              <span className="menu__label">{item.label}</span>
              {item.shortcut ? <Kbd keys={item.shortcut} /> : null}
            </RadixMenu.Item>
          ))}
        </RadixMenu.Content>
      </RadixMenu.Portal>
    </RadixMenu.Root>
  );
}
