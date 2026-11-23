// @vitest-environment jsdom
import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SessionWorkspace } from '../auth/useSession.ts';

const device = vi.hoisted(() => ({ resolve: (() => {}) as () => void, started: [] as string[][] }));
vi.mock('../sync/persistence.ts', () => ({
  startDeviceSession: (workspaces: Array<{ id: string; memberId: string }>) => {
    device.started.push(workspaces.map((workspace) => `${workspace.id}:${workspace.memberId}`));
    return new Promise<void>((resolve) => {
      device.resolve = resolve;
    });
  },
}));

import { useDeviceSession } from './useDeviceSession.ts';

const workspaces: SessionWorkspace[] = [
  { id: 'w1', name: 'Demo', slug: 'demo', memberId: 'm1', role: 'owner' },
];

describe('useDeviceSession', () => {
  beforeEach(() => {
    device.started = [];
  });

  it('holds everything back until the device knows who is signed in and has cleared what is not theirs', async () => {
    const { result } = renderHook(() => useDeviceSession(workspaces));
    await act(async () => {});
    expect(result.current).toBe(false);
    expect(device.started).toEqual([['w1:m1']]);
    await act(async () => device.resolve());
    expect(result.current).toBe(true);
  });

  it('starts over when the person behind the session changes', async () => {
    const { result, rerender } = renderHook(({ list }) => useDeviceSession(list), {
      initialProps: { list: workspaces },
    });
    await act(async () => device.resolve());
    expect(result.current).toBe(true);
    rerender({ list: [{ ...workspaces[0], memberId: 'm2' } as SessionWorkspace] });
    expect(result.current).toBe(false);
    expect(device.started).toEqual([['w1:m1'], ['w1:m2']]);
  });
});
