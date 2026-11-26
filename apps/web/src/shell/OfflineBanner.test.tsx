// @vitest-environment jsdom
import { act, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { LocaleProvider } from '../design/locale.tsx';

let waiting = 3;
const heard = new Set<() => void>();
vi.mock('../sync/outbox.ts', () => ({
  pendingCount: () => waiting,
  subscribePending: (listener: () => void) => {
    heard.add(listener);
    return () => heard.delete(listener);
  },
}));

import { OfflineBanner } from './OfflineBanner.tsx';

const setOnline = (online: boolean) =>
  Object.defineProperty(window.navigator, 'onLine', { configurable: true, value: online });

afterEach(() => {
  setOnline(true);
  waiting = 3;
});

describe('OfflineBanner', () => {
  it('says "Offline, 3 waiting" in English and Italian', () => {
    setOnline(false);
    const { rerender } = render(
      <LocaleProvider locale="en">
        <OfflineBanner workspaceId="w" />
      </LocaleProvider>,
    );
    expect(screen.getByRole('status')).toHaveTextContent('Offline, 3 waiting');
    rerender(
      <LocaleProvider locale="it">
        <OfflineBanner workspaceId="w" />
      </LocaleProvider>,
    );
    expect(screen.getByRole('status')).toHaveTextContent('Offline, 3 in attesa');
  });

  it('shows the waiting writes while online, and nothing when the queue is empty', () => {
    const { container, rerender } = render(
      <LocaleProvider locale="en">
        <OfflineBanner workspaceId="w" />
      </LocaleProvider>,
    );
    expect(screen.getByRole('status')).toHaveTextContent('3 waiting to send');
    waiting = 0;
    rerender(
      <LocaleProvider locale="en">
        <OfflineBanner workspaceId="w" />
      </LocaleProvider>,
    );
    expect(container).toBeEmptyDOMElement();
  });

  it('shows "1 waiting" when the one waiting write was queued by another tab', () => {
    waiting = 0;
    const { container } = render(
      <LocaleProvider locale="en">
        <OfflineBanner workspaceId="w" />
      </LocaleProvider>,
    );
    expect(container).toBeEmptyDOMElement();
    // The outbox counts the device, not this tab: the other tab's write arrives as a change of the count.
    waiting = 1;
    act(() => {
      for (const listener of [...heard]) listener();
    });
    expect(screen.getByRole('status')).toHaveTextContent('1 waiting to send');
  });
});
