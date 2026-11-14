import { cx } from '../cx.ts';

/** A grey placeholder block while content loads. Hidden from assistive technology: the region says it is busy. */
export function Skeleton({
  width,
  height,
  className,
}: {
  width?: string;
  height?: string;
  className?: string;
}) {
  return (
    <span className={cx('skeleton', className)} aria-hidden="true" style={{ width, height }} />
  );
}
