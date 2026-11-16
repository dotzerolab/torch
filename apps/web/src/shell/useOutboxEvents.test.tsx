// @vitest-environment jsdom
import { renderHook } from '@testing-library/react';
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { LocaleProvider } from '../design/locale.tsx';

const box = vi.hoisted(() => ({
  resume: vi.fn(async () => {}),
  listener: undefined as
    | undefined
    | ((write: unknown, error: { code: string; message: string }, handled: boolean) => void),
  stop: vi.fn(),
}));
vi.mock('../sync/outbox.ts', () => ({
  outbox: {
    resume: box.resume,
    subscribeDropped: (listener: typeof box.listener) => {
      box.listener = listener;
      return box.stop;
    },
  },
}));
const show = vi.hoisted(() => vi.fn());
vi.mock('../design/components/Toast.tsx', () => ({ useToast: () => ({ show }) }));

import { useOutboxEvents } from './useOutboxEvents.ts';

const wrapper = ({ children }: { children: ReactNode }) => (
  <LocaleProvider locale="en">{children}</LocaleProvider>
);

describe('useOutboxEvents', () => {
  beforeEach(() => vi.clearAllMocks());

  it('sends what the last visit left behind when the page opens the workspace', () => {
    renderHook(() => useOutboxEvents('w1'), { wrapper });
    expect(box.resume).toHaveBeenCalledWith('w1');
  });

  it('tells the person about an unhandled dropped write, and stops listening on leave', () => {
    const { unmount } = renderHook(() => useOutboxEvents('w1'), { wrapper });
    box.listener?.({}, { code: 'network', message: 'dev text' }, true);
    expect(show).not.toHaveBeenCalled();
    box.listener?.({}, { code: 'network', message: 'dev text' }, false);
    expect(show).toHaveBeenCalledTimes(1);
    expect(show.mock.calls[0]?.[0]).toMatchObject({ tone: 'error' });
    expect(show.mock.calls[0]?.[0].message).toMatch(/^A change was not saved: /);
    expect(show.mock.calls[0]?.[0].message).not.toContain('dev text');
    unmount();
    expect(box.stop).toHaveBeenCalled();
  });
});
