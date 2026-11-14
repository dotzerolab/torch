import { cx } from '../cx.ts';
import { useT } from '../locale.tsx';

/** A rotating ring. Announced as "loading" unless it sits inside something that already says so. */
export function Spinner({
  label,
  decorative = false,
  className,
}: {
  label?: string;
  decorative?: boolean;
  className?: string;
}) {
  const t = useT();
  return decorative ? (
    <span className={cx('spinner', className)} aria-hidden="true" />
  ) : (
    <span
      className={cx('spinner', className)}
      role="status"
      aria-label={label ?? t('common.loading')}
    />
  );
}
