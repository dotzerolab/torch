// @vitest-environment jsdom

import { createCollection, useLiveQuery } from '@tanstack/react-db';
import { act, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  type Cleanable,
  createRegistry,
  type Factories,
  MAX_LIVE_SHAPES,
  PAUSE_AFTER_MS,
  type ShapeKey,
  useShapeFrom,
} from './registry.ts';

type Fake = Cleanable & { id: string; inert: boolean; cleaned: number };

function fakeFactories() {
  const made: Fake[] = [];
  const build = (_key: ShapeKey, id: string, context: { inert: boolean }): Fake => {
    const fake: Fake = {
      id,
      inert: context.inert,
      cleaned: 0,
      cleanup() {
        fake.cleaned += 1;
      },
    };
    made.push(fake);
    return fake;
  };
  const factories = {
    teams: build,
    members: build,
    ownMemberships: build,
    issues: build,
    workflowStates: build,
    teamMembers: build,
  } satisfies Factories;
  return { factories, made };
}

const ws = 'w1';
const team = (kind: 'issues' | 'workflowStates' | 'teamMembers', teamId = 't1') =>
  ({ kind, workspaceId: ws, teamId }) as const;

describe('syncRegistry', () => {
  it('creates a shape on first use and keeps the instance', () => {
    const { factories, made } = fakeFactories();
    const registry = createRegistry(factories);
    const a = registry.get({ kind: 'teams', workspaceId: ws });
    expect(registry.get({ kind: 'teams', workspaceId: ws })).toBe(a);
    expect(made).toHaveLength(1);
    expect(a.id).toBe('teams-w1');
  });

  it('restart replaces the instance, gives it a new id and notifies', async () => {
    const { factories } = fakeFactories();
    const registry = createRegistry(factories);
    const listener = vi.fn();
    registry.subscribe(listener);
    const first = registry.get({ kind: 'teams', workspaceId: ws });
    registry.restart({ kind: 'teams', workspaceId: ws });
    await Promise.resolve();
    const second = registry.get({ kind: 'teams', workspaceId: ws });
    expect(second).not.toBe(first);
    expect(second.id).toBe('teams-w1~2');
    expect(first.cleaned).toBe(1);
    expect(listener).toHaveBeenCalledTimes(1);
    registry.restart({ kind: 'teams', workspaceId: ws });
    expect(registry.get({ kind: 'teams', workspaceId: ws }).id).toBe('teams-w1~3');
  });

  it('restart of a shape nobody read yet creates nothing and stays quiet', () => {
    const { factories, made } = fakeFactories();
    const registry = createRegistry(factories);
    const listener = vi.fn();
    registry.subscribe(listener);
    registry.restart({ kind: 'members', workspaceId: ws });
    expect(made).toHaveLength(0);
    expect(listener).not.toHaveBeenCalled();
  });

  it('dropTeam cleans the three team shapes only', async () => {
    const { factories } = fakeFactories();
    const registry = createRegistry(factories);
    const teams = registry.get({ kind: 'teams', workspaceId: ws });
    const members = registry.get({ kind: 'members', workspaceId: ws });
    const otherTeam = registry.get(team('issues', 't2'));
    const mine = [
      registry.get(team('issues')),
      registry.get(team('workflowStates')),
      registry.get(team('teamMembers')),
    ];
    registry.dropTeam(ws, 't1');
    await Promise.resolve();
    expect(mine.map((fake) => fake.cleaned)).toEqual([1, 1, 1]);
    expect([teams.cleaned, members.cleaned, otherTeam.cleaned]).toEqual([0, 0, 0]);
  });

  it('serves a dropped team an inert collection until its id comes back', () => {
    const { factories } = fakeFactories();
    const registry = createRegistry(factories);
    registry.get(team('issues'));
    registry.dropTeam(ws, 't1');
    expect(registry.isGone(ws, 't1')).toBe(true);
    // A page still showing the team asks again: it must not start a request that would 404 and drop it again.
    expect(registry.get(team('issues')).inert).toBe(true);
    registry.reinstateTeam(ws, 't1');
    expect(registry.isGone(ws, 't1')).toBe(false);
    expect(registry.get(team('issues')).inert).toBe(false);
  });

  it('restarting teams forgives the dropped teams of that workspace', () => {
    const { factories } = fakeFactories();
    const registry = createRegistry(factories);
    registry.get({ kind: 'teams', workspaceId: ws });
    registry.dropTeam(ws, 't1');
    registry.restart({ kind: 'teams', workspaceId: ws });
    expect(registry.isGone(ws, 't1')).toBe(false);
  });
});

// react-db keys a live query by the ids of its source collections: if a restarted shape kept its id the query
// would stay bound to the collection that was cleaned up and never see the new rows.
function localFactory(rows: () => { id: string }[]) {
  const make = (_key: ShapeKey, id: string) =>
    createCollection<{ id: string }>({
      id,
      getKey: (row) => row.id,
      sync: {
        sync: ({ begin, write, commit, markReady }) => {
          begin();
          for (const row of rows()) write({ type: 'insert', value: row });
          commit();
          markReady();
        },
      },
    });
  return {
    teams: make,
    members: make,
    ownMemberships: make,
    issues: make,
    workflowStates: make,
    teamMembers: make,
  } satisfies Factories;
}

type LocalCollection = ReturnType<ReturnType<typeof localFactory>['teams']>;

let liveRegistry: ReturnType<typeof createRegistry<ReturnType<typeof localFactory>>> | undefined;

function List() {
  if (!liveRegistry) throw new Error('no registry');
  const collection = useShapeFrom(liveRegistry, { kind: 'teams', workspaceId: ws });
  const { data } = useLiveQuery({
    query: (q) => q.from({ row: collection as unknown as LocalCollection }),
  });
  return <p data-testid="ids">{data.map((row) => (row as { id: string }).id).join(',')}</p>;
}

describe('useShapeFrom with a live query', () => {
  afterEach(() => vi.useRealTimers());

  it('re-binds an open live query to the restarted collection', async () => {
    let rows = [{ id: 'a' }];
    liveRegistry = createRegistry(localFactory(() => rows));
    render(<List />);
    await act(async () => {});
    expect(screen.getByTestId('ids').textContent).toBe('a');

    rows = [{ id: 'b' }, { id: 'c' }];
    await act(async () => {
      liveRegistry?.restart({ kind: 'teams', workspaceId: ws });
    });
    await act(async () => {});
    expect(screen.getByTestId('ids').textContent).toBe('b,c');
  });
});

describe('live shape budget', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  function open(
    registry: ReturnType<typeof createRegistry<ReturnType<typeof fakeFactories>['factories']>>,
  ) {
    registry.get({ kind: 'teams', workspaceId: ws });
    registry.get({ kind: 'members', workspaceId: ws });
    registry.get({ kind: 'ownMemberships', workspaceId: ws });
  }

  it('keeps a team that left view for 30 s when there is room, then pauses it', async () => {
    const { factories } = fakeFactories();
    const registry = createRegistry(factories);
    const fake = registry.get(team('issues'));
    const release = registry.hold(team('issues'));
    release();
    vi.advanceTimersByTime(PAUSE_AFTER_MS - 1);
    await Promise.resolve();
    expect(fake.cleaned).toBe(0);
    vi.advanceTimersByTime(1);
    await Promise.resolve();
    expect(fake.cleaned).toBe(1);
    expect(registry.get(team('issues')).id).toBe('issues-w1-t1~2');
  });

  it('coming back in time keeps the open shape', async () => {
    const { factories } = fakeFactories();
    const registry = createRegistry(factories);
    const fake = registry.get(team('issues'));
    registry.hold(team('issues'))();
    vi.advanceTimersByTime(20_000);
    registry.hold(team('issues'));
    vi.advanceTimersByTime(60_000);
    await Promise.resolve();
    expect(fake.cleaned).toBe(0);
  });

  it('never has more than MAX_LIVE_SHAPES open when the team in view changes', async () => {
    const { factories } = fakeFactories();
    const registry = createRegistry(factories);
    open(registry);
    // Team t1 in view, then the page switches to t2: the new shape is read before the old reader lets go.
    registry.get(team('issues', 't1'));
    const releaseOld = registry.hold(team('issues', 't1'));
    registry.get(team('issues', 't2'));
    registry.hold(team('issues', 't2'));
    expect(registry.liveCount()).toBe(MAX_LIVE_SHAPES + 1);
    releaseOld();
    await Promise.resolve();
    expect(registry.liveCount()).toBe(MAX_LIVE_SHAPES);
  });

  it('a reader of a restarted shape does not pause the new instance when it lets go of the old one', async () => {
    const { factories } = fakeFactories();
    const registry = createRegistry(factories);
    open(registry);
    registry.get(team('issues'));
    const releaseOld = registry.hold(team('issues'));
    registry.restart(team('issues'));
    const fresh = registry.get(team('issues'));
    releaseOld();
    registry.hold(team('issues'));
    await Promise.resolve();
    expect(fresh.cleaned).toBe(0);
  });
});
