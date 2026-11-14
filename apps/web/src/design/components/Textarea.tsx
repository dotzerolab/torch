import type { ComponentPropsWithRef } from 'react';
import { cx } from '../cx.ts';

export type TextareaProps = ComponentPropsWithRef<'textarea'> & { invalid?: boolean };

export function Textarea({ invalid, className, ref, ...rest }: TextareaProps) {
  return (
    <textarea
      ref={ref}
      className={cx('field', 'field--multiline', className)}
      aria-invalid={invalid ? true : undefined}
      {...rest}
    />
  );
}
