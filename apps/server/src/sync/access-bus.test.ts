import { describe, expect, it, vi } from 'vitest';
import { createAccessBus, notifySessionsRevoked } from './access-bus.ts';

const WS_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const WS_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const ALICE = '11111111-1111-4111-8111-111111111111';
const BOB = '22222222-2222-4222-8222-222222222222';

describe('AccessBus', () => {
  it("aborts only that member's requests", () => {
    const bus = createAccessBus();
    const alice = vi.fn();
    const aliceToo = vi.fn();
    const bob = vi.fn();
    const aliceElsewhere = vi.fn();
    bus.track(WS_A, ALICE, alice);
    bus.track(WS_A, ALICE, aliceToo);
    bus.track(WS_A, BOB, bob);
    bus.track(WS_B, ALICE, aliceElsewhere);

    bus.accessChanged(WS_A, [ALICE]);

    expect(alice).toHaveBeenCalledTimes(1);
    expect(aliceToo).toHaveBeenCalledTimes(1);
    expect(bob).not.toHaveBeenCalled();
    // The same member id in another workspace is another person: ids are scoped by workspace.
    expect(aliceElsewhere).not.toHaveBeenCalled();
  });

  it("'all' aborts the workspace only", () => {
    const bus = createAccessBus();
    const a1 = vi.fn();
    const a2 = vi.fn();
    const b1 = vi.fn();
    bus.track(WS_A, ALICE, a1);
    bus.track(WS_A, BOB, a2);
    bus.track(WS_B, ALICE, b1);

    bus.accessChanged(WS_A, 'all');

    expect(a1).toHaveBeenCalledTimes(1);
    expect(a2).toHaveBeenCalledTimes(1);
    expect(b1).not.toHaveBeenCalled();
  });

  it('unregister on normal completion: nothing is left tracked and a later change aborts nothing', () => {
    const bus = createAccessBus();
    const abort = vi.fn();
    const release = bus.track(WS_A, ALICE, abort);
    expect(bus.tracked()).toBe(1);

    release();
    release(); // idempotent

    expect(bus.tracked()).toBe(0);
    bus.accessChanged(WS_A, [ALICE]);
    bus.accessChanged(WS_A, 'all');
    expect(abort).not.toHaveBeenCalled();
  });

  it('a request is aborted at most once and is no longer tracked afterwards', () => {
    const bus = createAccessBus();
    const abort = vi.fn();
    bus.track(WS_A, ALICE, abort);

    bus.accessChanged(WS_A, [ALICE]);
    bus.accessChanged(WS_A, [ALICE]);

    expect(abort).toHaveBeenCalledTimes(1);
    expect(bus.tracked()).toBe(0);
  });

  it('an empty list changes nothing', () => {
    const bus = createAccessBus();
    const abort = vi.fn();
    bus.track(WS_A, ALICE, abort);

    bus.accessChanged(WS_A, []);

    expect(abort).not.toHaveBeenCalled();
    expect(bus.tracked()).toBe(1);
  });

  it('an abort callback that throws does not stop the others', () => {
    const bus = createAccessBus();
    const after = vi.fn();
    bus.track(WS_A, ALICE, () => {
      throw new Error('boom');
    });
    bus.track(WS_A, ALICE, after);

    expect(() => bus.accessChanged(WS_A, [ALICE])).not.toThrow();

    expect(after).toHaveBeenCalledTimes(1);
  });

  it('a request that registers while others are being aborted is not aborted by that change', () => {
    const bus = createAccessBus();
    const late = vi.fn();
    bus.track(WS_A, ALICE, () => {
      bus.track(WS_A, ALICE, late);
    });

    bus.accessChanged(WS_A, [ALICE]);

    expect(late).not.toHaveBeenCalled();
    expect(bus.tracked()).toBe(1);
  });
});

describe('notifySessionsRevoked', () => {
  it('tells the bus about every person whose session ended, once per workspace', () => {
    const accessChanged = vi.fn();

    notifySessionsRevoked({ accessChanged }, [
      { workspaceId: WS_A, memberId: ALICE },
      { workspaceId: WS_B, memberId: BOB },
      { workspaceId: WS_A, memberId: ALICE },
      { workspaceId: WS_A, memberId: BOB },
    ]);

    expect(accessChanged).toHaveBeenCalledTimes(2);
    expect(accessChanged).toHaveBeenCalledWith(WS_A, [ALICE, BOB]);
    expect(accessChanged).toHaveBeenCalledWith(WS_B, [BOB]);
  });

  it('does nothing without a bus or without sessions', () => {
    const accessChanged = vi.fn();

    notifySessionsRevoked(undefined, [{ workspaceId: WS_A, memberId: ALICE }]);
    notifySessionsRevoked({ accessChanged }, []);

    expect(accessChanged).not.toHaveBeenCalled();
  });
});
