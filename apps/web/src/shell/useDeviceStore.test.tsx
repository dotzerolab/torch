// @vitest-environment jsdom
import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const open = vi.hoisted(() => ({
  resolve: (() => {}) as () => void,
  reject: (() => {}) as () => void,
  calls: 0,
}));
const tabs = vi.hoisted(() => ({
  role: 'leader' as 'leader' | 'follower',
  promote: (() => {}) as () => void,
  led: [] as string[],
  promoted: [] as string[],
}));
vi.mock('../sync/persistence.ts', () => ({
  persistenceFor: () => null,
  openWorkspaceStore: () => {
    open.calls += 1;
    return new Promise<void>((resolve, reject) => {
      open.resolve = resolve;
      open.reject = reject;
    });
  },
}));
vi.mock('../sync/tabs.ts', () => ({
  roleOf: () => tabs.role,
  claimRole: async () => tabs.role,
  onPromoted: (_id: string, listener: () => void) => {
    tabs.promote = listener;
    return () => {};
  },
}));
vi.mock('../sync/shapes.ts', () => ({
  leadWorkspace: (id: string) => tabs.led.push(id),
  syncRegistry: { promote: (id: string) => tabs.promoted.push(id) },
}));

import { useDeviceStore } from './useDeviceStore.ts';

describe('useDeviceStore', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    open.calls = 0;
    tabs.role = 'leader';
    tabs.led = [];
    tabs.promoted = [];
  });

  it('holds the shapes back until the store is open', async () => {
    const { result } = renderHook(() => useDeviceStore('w1'));
    await act(async () => {});
    expect(result.current).toBe(false);
    await act(async () => open.resolve());
    expect(result.current).toBe(true);
    expect(tabs.led).toEqual(['w1']);
  });

  it('lets the page go on from memory when the browser cannot keep files', async () => {
    const { result } = renderHook(() => useDeviceStore('w2'));
    await act(async () => {});
    expect(result.current).toBe(false);
    await act(async () => open.reject());
    expect(result.current).toBe(true);
  });

  it('a follower tab opens no store and answers no one', async () => {
    tabs.role = 'follower';
    const { result } = renderHook(() => useDeviceStore('w3'));
    await act(async () => {});
    expect(result.current).toBe(true);
    expect(open.calls).toBe(0);
    expect(tabs.led).toEqual([]);
  });

  it('a follower that becomes the leader opens the store, then restarts its shapes as leader shapes', async () => {
    tabs.role = 'follower';
    renderHook(() => useDeviceStore('w4'));
    await act(async () => {});
    tabs.role = 'leader';
    await act(async () => tabs.promote());
    expect(open.calls).toBe(1);
    expect(tabs.promoted).toEqual([]);
    await act(async () => open.resolve());
    expect(tabs.led).toEqual(['w4']);
    expect(tabs.promoted).toEqual(['w4']);
  });
});
