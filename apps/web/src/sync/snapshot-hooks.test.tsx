// @vitest-environment jsdom

import { act, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ShapeKey } from './registry.ts';

const refresh = vi.fn<(key: ShapeKey) => void>();
let issuesChange: (() => void) | null = null;
const unsubscribe = vi.fn();
let ready = true;
const issuesCollection = {
  isReady: () => ready,
  subscribeChanges: (callback: () => void) => {
    issuesChange = callback;
    return { unsubscribe };
  },
};

vi.mock('./shapes.ts', () => ({
  syncRegistry: { refresh: (key: ShapeKey) => refresh(key) },
  useShape: (key: ShapeKey) => (key.kind === 'issues' ? issuesCollection : { kind: key.kind }),
}));

const { refresher, snapshotWatch, useIssuesFeed, useSnapshot } = await import(
  './snapshot-hooks.ts'
);

const labels = { kind: 'labels', workspaceId: 'w1', teamId: 't1' } as const;

function Screen({ team = 't1' }: { team?: string }) {
  useSnapshot(labels);
  useIssuesFeed('w1', team);
  return null;
}

describe('snapshot hooks', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    // The refresher and the watch are the page's: forget what an earlier test asked for.
    refresher.dispose();
    refresh.mockClear();
    unsubscribe.mockClear();
    issuesChange = null;
    ready = true;
  });
  afterEach(() => vi.useRealTimers());

  it('a change of the live issues of the team refreshes the labels the screen reads, once per burst', () => {
    render(<Screen />);
    expect(refresh).not.toHaveBeenCalled();
    act(() => issuesChange?.());
    expect(refresh).toHaveBeenCalledExactlyOnceWith(labels);
    // Ten changes inside the gap: one more read after the gap.
    act(() => {
      for (let i = 0; i < 10; i += 1) issuesChange?.();
    });
    expect(refresh).toHaveBeenCalledOnce();
    act(() => {
      vi.advanceTimersByTime(3000);
    });
    expect(refresh).toHaveBeenCalledTimes(2);
  });

  it('changes while the issues are still loading ask for nothing', () => {
    ready = false;
    render(<Screen />);
    act(() => issuesChange?.());
    expect(refresh).not.toHaveBeenCalled();
  });

  it('the subscription ends with the screen, and a read after it is not asked for', () => {
    const view = render(<Screen />);
    view.unmount();
    expect(unsubscribe).toHaveBeenCalledOnce();
    refresh.mockClear();
    snapshotWatch.issuesChanged('w1', 't1');
    expect(refresh).not.toHaveBeenCalled();
  });

  it('coming back online reads the held snapshot at once', () => {
    render(<Screen />);
    act(() => {
      window.dispatchEvent(new Event('online'));
    });
    expect(refresh).toHaveBeenCalledExactlyOnceWith(labels);
  });
});
