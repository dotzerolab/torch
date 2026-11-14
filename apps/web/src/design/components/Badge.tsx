import type { ReactNode } from 'react';
import { cx } from '../cx.ts';

export type BadgeTone = 'neutral' | 'accent' | 'danger' | 'success' | 'warning';

export function Badge({ tone = 'neutral', children }: { tone?: BadgeTone; children: ReactNode }) {
  return <span className={cx('badge', `badge--${tone}`)}>{children}</span>;
}
