// @vitest-environment jsdom

import { createCollection, useLiveQuery } from '@tanstack/react-db';
import { act, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { startMembershipWatcher, type WatcherRegistry } from './membership.ts';
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

  it('tells onSettled listeners of a kind when its current instance settles, and ignores a replaced one', () => {
    const contexts: Array<{ id: string; settled: () => void }> = [];
    const build = (_key: ShapeKey, id: string, context: { settled: () => void }) => {
      contexts.push({ id, settled: context.settled });
      return { cleanup() {} };
    };
    const registry = createRegistry({
      teams: build,
      members: build,
      ownMemberships: build,
      issues: build,
      workflowStates: build,
      teamMembers: build,
    } as unknown as Factories);
    const onTeams = vi.fn();
    const onMembers = vi.fn();
    registry.onSettled('teams', onTeams);
    registry.onSettled('members', onMembers);
    registry.get({ kind: 'teams', workspaceId: ws });
    registry.get({ kind: 'members', workspaceId: ws });

    contexts[0]?.settled();
    contexts[0]?.settled();
    expect(onTeams).toHaveBeenCalledTimes(2);
    expect(onTeams).toHaveBeenCalledWith(ws);
    expect(onMembers).not.toHaveBeenCalled();

    // A restarted shape: the old instance may still answer once while it stops; nobody must hear it.
    registry.restart({ kind: 'teams', workspaceId: ws });
    registry.get({ kind: 'teams', workspaceId: ws });
    contexts[0]?.settled();
    expect(onTeams).toHaveBeenCalledTimes(2);
    contexts[2]?.settled();
    expect(onTeams).toHaveBeenCalledTimes(3);
  });

  it('stops telling a listener that unsubscribed', () => {
    let settle = () => {};
    const build = (_key: ShapeKey, _id: string, context: { settled: () => void }) => {
      settle = context.settled;
      return { cleanup() {} };
    };
    const registry = createRegistry({
      teams: build,
      members: build,
      ownMemberships: build,
      issues: build,
      workflowStates: build,
      teamMembers: build,
    } as unknown as Factories);
    const listener = vi.fn();
    const off = registry.onSettled('teams', listener);
    registry.get({ kind: 'teams', workspaceId: ws });
    off();
    settle();
    expect(listener).not.toHaveBeenCalled();
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

  it('restarting teams keeps a dropped team dropped: only the new answer can bring it back', () => {
    const { factories } = fakeFactories();
    const registry = createRegistry(factories);
    registry.get({ kind: 'teams', workspaceId: ws });
    registry.get(team('issues'));
    registry.dropTeam(ws, 't1');
    registry.restart({ kind: 'teams', workspaceId: ws });
    expect(registry.isGone(ws, 't1')).toBe(true);
    expect(registry.get(team('issues')).inert).toBe(true);
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
    // Nobody reads it, so the instance that starts again keeps the id (and with it the device copy it resumes from).
    expect(registry.get(team('issues')).id).toBe('issues-w1-t1');
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

// The membership watcher and the registry together: a team the person left and later rejoins must sync again
// whichever of the two signals (the own-membership change, the teams rows) arrives first.
describe('a team that is left and then rejoined', () => {
  function watchable(id: string, initial: string[], context: { settled: () => void }) {
    let keys = initial;
    // A new instance is never settled on the spot: its first answer arrives a moment later.
    queueMicrotask(context.settled);
    return {
      id,
      inert: false,
      cleanup() {},
      async preload() {},
      keys: () => keys,
      get: () => undefined,
      // A later answer of the server: the rows are `next` and the shape settles.
      answer(next: string[]) {
        keys = next;
        context.settled();
      },
    };
  }

  function setup(teamAnswers: string[][]) {
    const teams: Array<ReturnType<typeof watchable>> = [];
    const answers = [...teamAnswers];
    const build = (_key: ShapeKey, id: string, context: { inert: boolean }) => ({
      id,
      inert: context.inert,
      cleanup() {},
    });
    const registry = createRegistry({
      teams: (_key: ShapeKey, id: string, context: { settled: () => void }) => {
        const instance = watchable(id, answers.shift() ?? [], context);
        teams.push(instance);
        return instance;
      },
      members: (_key: ShapeKey, id: string, context: { settled: () => void }) =>
        watchable(id, ['me'], context),
      ownMemberships: (_key: ShapeKey, id: string, context: { settled: () => void }) =>
        watchable(id, [], context),
      issues: build,
      workflowStates: build,
      teamMembers: build,
    } as unknown as Factories);
    const stop = startMembershipWatcher(ws, 'me', registry as unknown as WatcherRegistry, () => {});
    return { registry, teams, stop };
  }

  const issues = (registry: { get(key: ShapeKey): unknown }) =>
    registry.get(team('issues')) as { id: string; inert: boolean };
  const teamsKey = { kind: 'teams', workspaceId: ws } as const;
  const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

  it('syncs again when the restarted teams shape already lists the team', async () => {
    const { registry, stop } = setup([['t1'], [], ['t1']]);
    await settle();
    const before = issues(registry);
    expect(before.inert).toBe(false);

    registry.restart(teamsKey); // removed: the new answer has no t1
    await settle();
    expect(registry.isGone(ws, 't1')).toBe(true);
    expect(issues(registry).inert).toBe(true);

    registry.restart(teamsKey); // re-added: the new answer lists t1 from its first sync
    await settle();
    expect(registry.isGone(ws, 't1')).toBe(false);
    const after = issues(registry);
    expect(after.inert).toBe(false);
    expect(after.id).not.toBe(before.id);
    stop();
  });

  it('syncs again when the team row arrives after the restart', async () => {
    const { registry, teams, stop } = setup([['t1'], [], []]);
    await settle();
    issues(registry);
    registry.restart(teamsKey);
    await settle();
    expect(registry.isGone(ws, 't1')).toBe(true);

    registry.restart(teamsKey); // re-added: first sync without the team, its row comes next
    await settle();
    expect(issues(registry).inert).toBe(true);
    teams[2]?.answer(['t1']);

    expect(registry.isGone(ws, 't1')).toBe(false);
    expect(issues(registry).inert).toBe(false);
    stop();
  });
});
