import type { ComponentPropsWithRef } from 'react';
import { cx } from '../cx.ts';
import { Spinner } from './Spinner.tsx';

export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger';

export type ButtonProps = ComponentPropsWithRef<'button'> & {
  variant?: ButtonVariant;
  size?: 'sm' | 'md';
  loading?: boolean;
};

export function Button({
  variant = 'secondary',
  size = 'md',
  loading = false,
  type = 'button',
  className,
  children,
  onClick,
  ref,
  ...rest
}: ButtonProps) {
  return (
    <button
      ref={ref}
      type={type}
      className={cx('btn', `btn--${variant}`, size === 'sm' && 'btn--sm', className)}
      aria-busy={loading ? true : undefined}
      onClick={(event) => {
        // A busy button stays focusable (it keeps its place in the tab order) but does nothing.
        if (loading) event.preventDefault();
        else onClick?.(event);
      }}
      {...rest}
    >
      {loading ? <Spinner decorative /> : null}
      {children}
    </button>
  );
}
