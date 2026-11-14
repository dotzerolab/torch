import * as RadixDialog from '@radix-ui/react-dialog';
import { X } from 'lucide-react';
import { type ReactNode, useRef } from 'react';
import { cx } from '../cx.ts';
import { useT } from '../locale.tsx';
import { IconButton } from './IconButton.tsx';

/**
 * A modal. Focus moves inside when it opens, Tab stays inside, Escape closes it and focus returns to what
 * opened it. The title is always required (it names the dialog); `hideTitle` keeps it for assistive technology only.
 */
export function Dialog({
  open,
  onOpenChange,
  title,
  description,
  children,
  variant = 'center',
  hideTitle = false,
  className,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description?: string;
  children?: ReactNode;
  /** `drawer` slides in from the left edge (the sidebar on a phone). */
  variant?: 'center' | 'drawer';
  hideTitle?: boolean;
  className?: string;
}) {
  const t = useT();
  // The dialog is controlled and has no Radix trigger, so remember what had focus when it opened.
  const returnFocusTo = useRef<HTMLElement | null>(null);
  return (
    <RadixDialog.Root open={open} onOpenChange={onOpenChange}>
      <RadixDialog.Portal>
        <RadixDialog.Overlay className="dialog-overlay" />
        <RadixDialog.Content
          className={cx('dialog', variant === 'drawer' && 'dialog--drawer', className)}
          onOpenAutoFocus={() => {
            returnFocusTo.current = document.activeElement as HTMLElement | null;
          }}
          onCloseAutoFocus={(event) => {
            event.preventDefault();
            const target = returnFocusTo.current;
            returnFocusTo.current = null;
            if (target?.isConnected) target.focus();
          }}
          // Without a description Radix would warn about a missing one: say there is none on purpose.
          {...(description ? {} : { 'aria-describedby': undefined })}
        >
          <RadixDialog.Title className={hideTitle ? 'visually-hidden' : 'dialog__title'}>
            {title}
          </RadixDialog.Title>
          {description ? (
            <RadixDialog.Description className="dialog__description">
              {description}
            </RadixDialog.Description>
          ) : null}
          <div className="dialog__body">{children}</div>
          {/* Last in the DOM so the first thing to take focus is the dialog's own content. */}
          <RadixDialog.Close asChild>
            <IconButton
              label={t('common.close')}
              icon={<X size={16} aria-hidden="true" />}
              tooltip={false}
              className="dialog__close"
            />
          </RadixDialog.Close>
        </RadixDialog.Content>
      </RadixDialog.Portal>
    </RadixDialog.Root>
  );
}
