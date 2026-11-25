import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ShapeKey } from './registry.ts';
import { createRefresher, MIN_GAP_MS } from './snapshots.ts';

const labels: ShapeKey = { kind: 'labels', workspaceId: 'w1', teamId: 't1' };
const relations: ShapeKey = { kind: 'issueRelations', workspaceId: 'w1', teamId: 't1' };
const detail = (issueId: string): ShapeKey => ({
  kind: 'issueDetail',
  workspaceId: 'w1',
  teamId: 't1',
  issueId,
});

describe('createRefresher', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('refresher coalesces: ten requests in one second make one refresh at once and one after the gap', () => {
    const refresh = vi.fn();
    const refresher = createRefresher({ refresh });
    for (let i = 0; i < 10; i += 1) {
      refresher.request(labels);
      vi.advanceTimersByTime(100);
    }
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(refresh).toHaveBeenCalledWith(labels);
    // The trailing refresh comes MIN_GAP_MS after the first one (1 s of requests are already behind us).
    vi.advanceTimersByTime(MIN_GAP_MS - 1000 - 1);
    expect(refresh).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(1);
    expect(refresh).toHaveBeenCalledTimes(2);
    // Nothing else is due.
    vi.advanceTimersByTime(10 * MIN_GAP_MS);
    expect(refresh).toHaveBeenCalledTimes(2);
  });

  it('now: true refreshes at once, whatever the gap, and takes the place of a refresh that was waiting', () => {
    const refresh = vi.fn();
    const refresher = createRefresher({ refresh });
    refresher.request(labels); // t = 0: refreshes
    refresher.request(labels); // waits for t = MIN_GAP_MS
    vi.advanceTimersByTime(2000);
    refresher.request(labels, { now: true }); // t = 2000
    expect(refresh).toHaveBeenCalledTimes(2);
    // The refresh that waited for t = 3000 was served by the one above.
    vi.advanceTimersByTime(1000);
    expect(refresh).toHaveBeenCalledTimes(2);
    // The gap counts from the refresh at t = 2000.
    refresher.request(labels);
    vi.advanceTimersByTime(MIN_GAP_MS - 1001);
    expect(refresh).toHaveBeenCalledTimes(2);
    vi.advanceTimersByTime(1);
    expect(refresh).toHaveBeenCalledTimes(3);
  });

  it('a request after the gap refreshes at once', () => {
    const refresh = vi.fn();
    const refresher = createRefresher({ refresh });
    refresher.request(labels);
    vi.advanceTimersByTime(MIN_GAP_MS);
    refresher.request(labels);
    expect(refresh).toHaveBeenCalledTimes(2);
  });

  it('keeps one gap per shape: another shape, or another issue, is not held back', () => {
    const refresh = vi.fn();
    const refresher = createRefresher({ refresh });
    refresher.request(labels);
    refresher.request(relations);
    refresher.request(detail('i1'));
    refresher.request(detail('i2'));
    expect(refresh.mock.calls.map(([key]) => key)).toEqual([
      labels,
      relations,
      detail('i1'),
      detail('i2'),
    ]);
    // A repeat of the same issue waits; the same kind of another team does not.
    refresher.request(detail('i1'));
    expect(refresh).toHaveBeenCalledTimes(4);
  });

  it('dispose drops a refresh that is still waiting', () => {
    const refresh = vi.fn();
    const refresher = createRefresher({ refresh });
    refresher.request(labels);
    refresher.request(labels);
    refresher.dispose();
    vi.advanceTimersByTime(MIN_GAP_MS * 2);
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it('takes the clock and the timer it is given', () => {
    const refresh = vi.fn();
    let time = 1_000_000;
    const timers: Array<{ run: () => void; ms: number; cancelled: boolean }> = [];
    const refresher = createRefresher({
      refresh,
      now: () => time,
      setTimer: (run, ms) => {
        const timer = { run, ms, cancelled: false };
        timers.push(timer);
        return () => {
          timer.cancelled = true;
        };
      },
    });
    refresher.request(labels);
    time += 1200;
    refresher.request(labels);
    expect(timers).toHaveLength(1);
    expect(timers[0]?.ms).toBe(MIN_GAP_MS - 1200);
    time += MIN_GAP_MS - 1200;
    timers[0]?.run();
    expect(refresh).toHaveBeenCalledTimes(2);
  });

  it('a refresh that throws does not wedge the gap of the next request', () => {
    const refresh = vi.fn().mockImplementationOnce(() => {
      throw new Error('no such shape');
    });
    const refresher = createRefresher({ refresh });
    expect(() => refresher.request(labels)).not.toThrow();
    vi.advanceTimersByTime(MIN_GAP_MS);
    refresher.request(labels);
    expect(refresh).toHaveBeenCalledTimes(2);
  });
});
