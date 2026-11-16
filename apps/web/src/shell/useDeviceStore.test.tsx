// @vitest-environment jsdom
import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const open = vi.hoisted(() => ({
  resolve: (() => {}) as () => void,
  reject: (() => {}) as () => void,
}));
vi.mock('../sync/persistence.ts', () => ({
  persistenceFor: () => null,
  openWorkspaceStore: () =>
    new Promise<void>((resolve, reject) => {
      open.resolve = resolve;
      open.reject = reject;
    }),
}));

import { useDeviceStore } from './useDeviceStore.ts';

describe('useDeviceStore', () => {
  beforeEach(() => vi.clearAllMocks());

  it('holds the shapes back until the store is open', async () => {
    const { result } = renderHook(() => useDeviceStore('w1'));
    expect(result.current).toBe(false);
    await act(async () => open.resolve());
    expect(result.current).toBe(true);
  });

  it('lets the page go on from memory when the browser cannot keep files', async () => {
    const { result } = renderHook(() => useDeviceStore('w2'));
    expect(result.current).toBe(false);
    await act(async () => open.reject());
    expect(result.current).toBe(true);
  });
});
