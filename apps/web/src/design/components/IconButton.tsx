import type { ComponentPropsWithRef, ReactNode } from 'react';
import { cx } from '../cx.ts';
import { Tooltip } from './Tooltip.tsx';

export type IconButtonProps = Omit<ComponentPropsWithRef<'button'>, 'children' | 'aria-label'> & {
  /** What the button does. Required: it is the accessible name and the tooltip. */
  label: string;
  icon: ReactNode;
  tooltip?: boolean;
  size?: 'sm' | 'md';
};

export function IconButton({
  label,
  icon,
  tooltip = true,
  size = 'md',
  type = 'button',
  className,
  ref,
  ...rest
}: IconButtonProps) {
  const button = (
    <button
      ref={ref}
      type={type}
      aria-label={label}
      className={cx('icon-btn', size === 'sm' && 'icon-btn--sm', className)}
      {...rest}
    >
      {icon}
    </button>
  );
  return tooltip ? <Tooltip content={label}>{button}</Tooltip> : button;
}
