import * as RadixPopover from '@radix-ui/react-popover';
import type { ReactNode } from 'react';
import { cx } from '../cx.ts';

/** Floating content anchored to a trigger. Closes on Escape or an outside click, focus returns to the trigger. */
export function Popover({
  trigger,
  children,
  open,
  onOpenChange,
  align = 'start',
  label,
  className,
}: {
  trigger: ReactNode;
  children: ReactNode;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  align?: 'start' | 'center' | 'end';
  label?: string;
  className?: string;
}) {
  return (
    <RadixPopover.Root open={open} onOpenChange={onOpenChange}>
      <RadixPopover.Trigger asChild>{trigger}</RadixPopover.Trigger>
      <RadixPopover.Portal>
        <RadixPopover.Content
          className={cx('popover', className)}
          align={align}
          sideOffset={6}
          aria-label={label}
        >
          {children}
        </RadixPopover.Content>
      </RadixPopover.Portal>
    </RadixPopover.Root>
  );
}
