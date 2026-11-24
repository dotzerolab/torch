import { describe, expect, it, vi } from 'vitest';
import { createDeviceFollower } from './device-follow.ts';

/** A job whose end the test controls. */
function job() {
  const calls: Array<() => void> = [];
  const fn = vi.fn(
    () =>
      new Promise<void>((resolve) => {
        calls.push(resolve);
      }),
  );
  return { fn, finish: (n = 0) => calls[n]?.() };
}

function setup(initial: string[] = ['a', 'b']) {
  const live = { keys: initial };
  const copy = job();
  const refresh = job();
  const onCancel = vi.fn();
  const follower = createDeviceFollower({
    keys: () => live.keys,
    copy: copy.fn,
    refresh: refresh.fn,
    onCancel,
  });
  return { live, copy, refresh, follower, onCancel };
}

const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

describe('createDeviceFollower', () => {
  it('copies once at the first answer and takes it as the baseline: no refresh', () => {
    const s = setup();
    s.follower.settled();
    expect(s.copy.fn).toHaveBeenCalledOnce();
    expect(s.refresh.fn).not.toHaveBeenCalled();
    s.follower.settled();
    expect(s.copy.fn).toHaveBeenCalledOnce();
  });

  it('a truncate before the first answer is the first snapshot, not a change', async () => {
    const s = setup();
    s.follower.truncated();
    s.follower.settled();
    s.copy.finish();
    await tick();
    expect(s.refresh.fn).not.toHaveBeenCalled();
  });

  it('refreshes when a row left, and when nothing but rows were added or changed it does not', async () => {
    const s = setup(['a', 'b']);
    s.follower.settled();
    s.copy.finish();
    await tick();
    s.live.keys = ['a', 'b', 'c'];
    s.follower.settled();
    expect(s.refresh.fn).not.toHaveBeenCalled();
    s.live.keys = ['a', 'c'];
    s.follower.settled();
    expect(s.refresh.fn).toHaveBeenCalledOnce();
  });

  it('refreshes after a truncate even when the answer holds the same keys', async () => {
    const s = setup(['a']);
    s.follower.settled();
    s.copy.finish();
    await tick();
    s.follower.truncated();
    expect(s.refresh.fn).not.toHaveBeenCalled(); // waits for the answer that follows the truncate
    s.follower.settled();
    expect(s.refresh.fn).toHaveBeenCalledOnce();
  });

  it('runs one refresh and one more at most while changes keep coming (coalesced)', async () => {
    const s = setup(['a', 'b', 'c', 'd']);
    s.follower.settled();
    s.copy.finish();
    await tick();
    s.live.keys = ['a', 'b', 'c'];
    s.follower.settled();
    expect(s.refresh.fn).toHaveBeenCalledOnce();
    // Three more deletions while the first refresh is running: one refresh follows it, not three.
    s.live.keys = ['a', 'b'];
    s.follower.settled();
    s.live.keys = ['a'];
    s.follower.settled();
    s.live.keys = [];
    s.follower.settled();
    expect(s.refresh.fn).toHaveBeenCalledOnce();
    s.refresh.finish(0);
    await tick();
    expect(s.refresh.fn).toHaveBeenCalledTimes(2);
    s.refresh.finish(1);
    await tick();
    expect(s.refresh.fn).toHaveBeenCalledTimes(2);
  });

  it('waits for the first copy before it refreshes (one job at a time)', async () => {
    const s = setup(['a', 'b']);
    s.follower.settled();
    s.live.keys = ['a'];
    s.follower.settled();
    expect(s.refresh.fn).not.toHaveBeenCalled();
    s.copy.finish();
    await tick();
    expect(s.refresh.fn).toHaveBeenCalledOnce();
  });

  it('recovers when a job ends badly: the next change still refreshes', async () => {
    const t = setup(['a', 'b', 'c']);
    t.refresh.fn.mockRejectedValueOnce(new Error('refresh failed'));
    t.follower.settled();
    t.copy.finish();
    await tick();
    t.live.keys = ['a', 'b'];
    t.follower.settled();
    await tick();
    t.live.keys = ['a'];
    t.follower.settled();
    expect(t.refresh.fn).toHaveBeenCalledTimes(2);
  });

  it('does nothing after it was cancelled, and starts no pending refresh', async () => {
    const s = setup(['a', 'b']);
    s.follower.settled();
    s.copy.finish();
    await tick();
    s.live.keys = ['a'];
    s.follower.settled();
    s.live.keys = [];
    s.follower.settled(); // pending
    s.follower.cancel();
    expect(s.follower.cancelled).toBe(true);
    s.refresh.finish(0);
    await tick();
    expect(s.refresh.fn).toHaveBeenCalledOnce();
    s.follower.truncated();
    s.follower.settled();
    expect(s.refresh.fn).toHaveBeenCalledOnce();
  });

  it('ends the running job when it is cancelled', () => {
    const s = setup();
    s.follower.settled();
    s.follower.cancel();
    expect(s.onCancel).toHaveBeenCalledOnce();
  });

  it('copies nothing when cancelled before the first answer', () => {
    const s = setup();
    s.follower.cancel();
    s.follower.settled();
    expect(s.copy.fn).not.toHaveBeenCalled();
  });
});
