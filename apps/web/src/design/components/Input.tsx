import type { ComponentPropsWithRef } from 'react';
import { cx } from '../cx.ts';

export type InputProps = ComponentPropsWithRef<'input'> & { invalid?: boolean };

export function Input({ invalid, className, ref, ...rest }: InputProps) {
  return (
    <input
      ref={ref}
      className={cx('field', className)}
      aria-invalid={invalid ? true : undefined}
      {...rest}
    />
  );
}
