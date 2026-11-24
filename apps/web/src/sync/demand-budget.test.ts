import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createDemandBudget, type DemandRegistry } from './demand-budget.ts';
import { parseShapeId, shapeId } from './registry.ts';

// A registry reduced to what the budget reads: which shapes are open and how many readers hold each.
function fakeRegistry(max: number, base: string[] = []) {
  const open = new Set<string>(base);
  const holds = new Map<string, number>();
  const listeners = new Set<() => void>();
  const paused: string[] = [];
  const registry: DemandRegistry = {
    isOpen: (key) => open.has(shapeId(key)),
    liveCount: () => open.size,
    holdCount: (key) => holds.get(shapeId(key)) ?? 0,
    open: (key) => {
      open.add(shapeId(key));
    },
    hold: (key) => {
      const id = shapeId(key);
      holds.set(id, (holds.get(id) ?? 0) + 1);
      return () => holds.set(id, (holds.get(id) ?? 1) - 1);
    },
    pauseNow: (key) => {
      const id = shapeId(key);
      if ((holds.get(id) ?? 0) > 0) return;
      open.delete(id);
      paused.push(id);
    },
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
  return { registry, open, holds, paused, max };
}

const BASE = ['teams:w1', 'members:w1', 'ownMemberships:w1'];
const issues = (team: string) => `issues:w1:${team}`;

describe('follower demand and the live shape budget', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('opens a demanded team shape while there is room', () => {
    const { registry, open } = fakeRegistry(4, BASE);
    const budget = createDemandBudget(registry, { max: 4, retryMs: 1000 });
    budget.hold(issues('a'));
    expect(open.has(issues('a'))).toBe(true);
  });

  it('opens a shape the page already has open without counting it again', () => {
    const { registry, open } = fakeRegistry(4, [...BASE, issues('a')]);
    const budget = createDemandBudget(registry, { max: 4, retryMs: 1000 });
    budget.hold(issues('a'));
    expect(open.size).toBe(4);
    expect(registry.holdCount(parseShapeId(issues('a')))).toBe(1);
  });

  it('never opens a team shape above the budget: it waits, and writes keep a connection', () => {
    const { registry, open } = fakeRegistry(4, [...BASE, issues('a')]);
    const budget = createDemandBudget(registry, { max: 4, retryMs: 1000 });
    budget.hold(issues('b'));
    vi.advanceTimersByTime(5000);
    expect(open.has(issues('b'))).toBe(false);
    expect(open.size).toBe(4);
  });

  it('opens a waiting shape once a slot frees', () => {
    const { registry, open } = fakeRegistry(4, [...BASE, issues('a')]);
    const budget = createDemandBudget(registry, { max: 4, retryMs: 1000 });
    budget.hold(issues('b'));
    open.delete(issues('a'));
    vi.advanceTimersByTime(1000);
    expect(open.has(issues('b'))).toBe(true);
  });

  it('opens the workspace shapes whatever the count: the page shows them anyway', () => {
    const { registry, open } = fakeRegistry(4, [
      'teams:w1',
      'members:w1',
      issues('a'),
      issues('c'),
    ]);
    const budget = createDemandBudget(registry, { max: 4, retryMs: 1000 });
    budget.hold('ownMemberships:w1');
    expect(open.has('ownMemberships:w1')).toBe(true);
  });

  it('a follower that leaves while waiting never opens the shape', () => {
    const { registry, open } = fakeRegistry(4, [...BASE, issues('a')]);
    const budget = createDemandBudget(registry, { max: 4, retryMs: 1000 });
    const release = budget.hold(issues('b'));
    release();
    open.delete(issues('a'));
    vi.advanceTimersByTime(5000);
    expect(open.has(issues('b'))).toBe(false);
  });

  it('letting go of an open shape releases its hold', () => {
    const { registry } = fakeRegistry(4, BASE);
    const budget = createDemandBudget(registry, { max: 4, retryMs: 1000 });
    const release = budget.hold(issues('a'));
    expect(registry.holdCount(parseShapeId(issues('a')))).toBe(1);
    release();
    expect(registry.holdCount(parseShapeId(issues('a')))).toBe(0);
  });

  it('makeRoom closes the least recent demanded shape when the page is over its budget', () => {
    const { registry, open, paused } = fakeRegistry(4, BASE);
    const budget = createDemandBudget(registry, { max: 4, retryMs: 1000 });
    budget.hold(issues('b'));
    // The person on the leader tab opens a team: that shape is read by a screen, so it is held and over the budget.
    registry.open(parseShapeId(issues('a')));
    registry.hold(parseShapeId(issues('a')));
    expect(open.size).toBe(5);
    budget.makeRoom();
    expect(open.size).toBe(4);
    expect(paused).toEqual([issues('b')]);
  });

  it('makeRoom never closes a shape a screen of this tab reads', () => {
    const { registry, open } = fakeRegistry(4, BASE);
    const budget = createDemandBudget(registry, { max: 4, retryMs: 1000 });
    registry.open(parseShapeId(issues('b')));
    registry.hold(parseShapeId(issues('b')));
    budget.hold(issues('b'));
    registry.open(parseShapeId(issues('a')));
    registry.hold(parseShapeId(issues('a')));
    budget.makeRoom();
    expect(open.has(issues('b'))).toBe(true);
    expect(open.has(issues('a'))).toBe(true);
  });

  it('makeRoom closes the oldest demand first and stops at the budget', () => {
    const { registry, open, paused } = fakeRegistry(4, ['teams:w1', 'members:w1']);
    const budget = createDemandBudget(registry, { max: 4, retryMs: 1000 });
    budget.hold(issues('b'));
    vi.advanceTimersByTime(10);
    budget.hold(issues('c'));
    expect(open.size).toBe(4);
    registry.open(parseShapeId('ownMemberships:w1'));
    registry.hold(parseShapeId('ownMemberships:w1'));
    expect(open.size).toBe(5);
    budget.makeRoom();
    expect(paused).toEqual([issues('b')]);
    expect(open.has(issues('c'))).toBe(true);
  });

  it('a shape that was closed to make room opens again when a slot frees, without anyone asking', () => {
    const { registry, open } = fakeRegistry(4, BASE);
    const budget = createDemandBudget(registry, { max: 4, retryMs: 1000 });
    budget.hold(issues('b'));
    registry.open(parseShapeId(issues('a')));
    const releaseA = registry.hold(parseShapeId(issues('a')));
    budget.makeRoom();
    expect(open.has(issues('b'))).toBe(false);
    vi.advanceTimersByTime(3000);
    expect(open.has(issues('b'))).toBe(false);
    // The leader tab's person goes on to another screen: the shape of team a is let go and closed.
    releaseA();
    open.delete(issues('a'));
    vi.advanceTimersByTime(1000);
    expect(open.has(issues('b'))).toBe(true);
  });

  it('a shape that was closed to make room and then released by the follower stays closed', () => {
    const { registry, open } = fakeRegistry(4, BASE);
    const budget = createDemandBudget(registry, { max: 4, retryMs: 1000 });
    const releaseB = budget.hold(issues('b'));
    registry.open(parseShapeId(issues('a')));
    registry.hold(parseShapeId(issues('a')));
    budget.makeRoom();
    releaseB();
    open.delete(issues('a'));
    vi.advanceTimersByTime(5000);
    expect(open.has(issues('b'))).toBe(false);
  });
});
