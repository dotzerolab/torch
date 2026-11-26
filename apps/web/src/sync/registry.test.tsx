// @vitest-environment jsdom

import { createCollection, useLiveQuery } from '@tanstack/react-db';
import { act, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { startMembershipWatcher, type WatcherRegistry } from './membership.ts';
import {
  type Cleanable,
  createRegistry,
  type Factories,
  isShapeId,
  isSnapshotKind,
  MAX_LIVE_SHAPES,
  PAUSE_AFTER_MS,
  parseShapeId,
  type ShapeKey,
  SNAPSHOT_KINDS,
  shapeId,
  TEAM_KINDS,
  useShapeFrom,
} from './registry.ts';

type Fake = Cleanable & { id: string; inert: boolean; cleaned: number };

const KIND_NAMES = [
  'teams',
  'members',
  'ownMemberships',
  'workspaceLabels',
  'myIssues',
  'issues',
  'workflowStates',
  'teamMembers',
  'labels',
  'issueLabels',
  'issueRelations',
  'issueLinks',
  'issueSubscribers',
  'issueDetail',
  'issueActivity',
  'issueComments',
  'issueAttachments',
  'documents',
  'documentContent',
] as const;
/** A factory table where every kind is made by `make`. */
function allKinds<T>(make: T): { [K in (typeof KIND_NAMES)[number]]: T } {
  return Object.fromEntries(KIND_NAMES.map((kind) => [kind, make])) as never;
}

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
  const factories = allKinds(build) satisfies Factories;
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
    const registry = createRegistry(allKinds(build) as unknown as Factories);
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

  it('tells an instance that ends whether it was paused or replaced', async () => {
    const contexts: Array<{ paused: () => boolean }> = [];
    const build = (_key: ShapeKey, _id: string, context: { paused: () => boolean }) => {
      contexts.push(context);
      return { cleanup() {} };
    };
    const registry = createRegistry(allKinds(build) as unknown as Factories);
    registry.get(team('issues'));
    registry.get({ kind: 'members', workspaceId: ws });
    expect(contexts.map((c) => c.paused())).toEqual([false, false]);
    registry.hold(team('issues'))();
    registry.restart({ kind: 'members', workspaceId: ws });
    registry.dropTeam(ws, 't1');
    expect(contexts[1]?.paused()).toBe(false);
    // The team shape was ended by `dropTeam` here; a pause is what `hold` does over budget:
    const paused = createRegistry({ issues: build } as unknown as Factories);
    const before = contexts.length;
    paused.get(team('issues'));
    for (const t of ['t2', 't3', 't4', 't5']) paused.get(team('issues', t));
    const release = paused.hold(team('issues'));
    release();
    await Promise.resolve();
    expect(contexts[before]?.paused()).toBe(true);
    expect(contexts[before + 1]?.paused()).toBe(false);
  });

  it('stops telling a listener that unsubscribed', () => {
    let settle = () => {};
    const build = (_key: ShapeKey, _id: string, context: { settled: () => void }) => {
      settle = context.settled;
      return { cleanup() {} };
    };
    const registry = createRegistry(allKinds(build) as unknown as Factories);
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
function localFactory(rows: () => { id: string }[], made: Array<{ status: string }> = []) {
  const make = (_key: ShapeKey, id: string) => {
    const collection = createCollection<{ id: string }>({
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
    made.push(collection);
    return collection;
  };
  return allKinds(make) satisfies Factories;
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

const labelsKey = { kind: 'labels', workspaceId: ws, teamId: 't1' } as const;

/** What each render of `SnapshotList` showed, in order. */
const snapshotRenders: string[] = [];

function SnapshotList() {
  if (!liveRegistry) throw new Error('no registry');
  const collection = useShapeFrom(liveRegistry, labelsKey);
  const { data } = useLiveQuery({
    query: (q) => q.from({ row: collection as unknown as LocalCollection }),
  });
  const text = data.map((row) => (row as { id: string }).id).join(',');
  snapshotRenders.push(text);
  return <p data-testid="labels">{text}</p>;
}

describe('refreshing a snapshot shape', () => {
  /** Like `localFactory`, but the shape only counts as answered when the test says so. */
  function gatedFactory(rows: () => { id: string }[], made: Array<{ status: string }>) {
    const answers: Array<() => void> = [];
    const make = (_key: ShapeKey, id: string, context: { settled: () => void }) => {
      const collection = createCollection<{ id: string }>({
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
      made.push(collection);
      answers.push(() => context.settled());
      return collection;
    };
    return { factories: allKinds(make) satisfies Factories, answers };
  }

  it('keeps showing the old rows until the new instance has answered, then re-binds and cleans the old one up', async () => {
    let rows = [{ id: 'a' }];
    const made: Array<{ status: string }> = [];
    const { factories, answers } = gatedFactory(() => rows, made);
    liveRegistry = createRegistry(factories);
    snapshotRenders.length = 0;
    render(<SnapshotList />);
    await act(async () => {});
    expect(screen.getByTestId('labels').textContent).toBe('a');
    expect(made).toHaveLength(1);

    rows = [{ id: 'b' }, { id: 'c' }];
    await act(async () => {
      liveRegistry?.refresh(labelsKey);
    });
    await act(async () => {});
    // The new instance is reading, but has not answered: readers keep the old one, with its rows.
    expect(made).toHaveLength(2);
    expect(screen.getByTestId('labels').textContent).toBe('a');
    expect(made[0]?.status).not.toBe('cleaned-up');

    await act(async () => {
      answers[1]?.();
    });
    await act(async () => {});
    expect(screen.getByTestId('labels').textContent).toBe('b,c');
    expect(made[0]?.status).toBe('cleaned-up');
    expect(made[1]?.status).toBe('ready');
    // Once the rows were there, no render in between showed an empty list.
    expect(
      snapshotRenders.slice(snapshotRenders.indexOf('a')).filter((text) => text === ''),
    ).toEqual([]);
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

  describe('my issues, the one workspace shape a screen reads', () => {
    const mine = { kind: 'myIssues', workspaceId: ws } as const;

    it('is a live shape: it counts against the budget and names a shape the tabs share', () => {
      const { factories } = fakeFactories();
      const registry = createRegistry(factories);
      open(registry);
      registry.get(mine);
      expect(registry.liveCount()).toBe(MAX_LIVE_SHAPES);
      expect(isSnapshotKind('myIssues')).toBe(false);
      expect(shapeId(mine)).toBe('myIssues:w1');
      expect(isShapeId('myIssues:w1')).toBe(true);
      expect(parseShapeId('myIssues:w1')).toEqual(mine);
      expect(TEAM_KINDS).not.toContain('myIssues');
    });

    it('stays open 30 s after its screen left when there is room, then pauses and resumes under the same id', async () => {
      const { factories } = fakeFactories();
      const registry = createRegistry(factories);
      const fake = registry.get(mine);
      expect(registry.holdCount(mine)).toBe(0);
      registry.hold(mine)();
      expect(registry.holdCount(mine)).toBe(0);
      vi.advanceTimersByTime(PAUSE_AFTER_MS - 1);
      await Promise.resolve();
      expect(fake.cleaned).toBe(0);
      vi.advanceTimersByTime(1);
      await Promise.resolve();
      expect(fake.cleaned).toBe(1);
      expect(registry.get(mine).id).toBe('myIssues-w1');
    });

    it('a reader keeps it open however long it reads', async () => {
      const { factories } = fakeFactories();
      const registry = createRegistry(factories);
      const fake = registry.get(mine);
      registry.hold(mine);
      vi.advanceTimersByTime(PAUSE_AFTER_MS * 4);
      await Promise.resolve();
      expect(fake.cleaned).toBe(0);
    });

    it('going from My Issues to a team keeps the live count at the budget, not above it', async () => {
      const { factories } = fakeFactories();
      const registry = createRegistry(factories);
      open(registry);
      registry.get(mine);
      const releaseMine = registry.hold(mine);
      expect(registry.liveCount()).toBe(MAX_LIVE_SHAPES);
      registry.get(team('issues', 't1'));
      registry.hold(team('issues', 't1'));
      expect(registry.liveCount()).toBe(MAX_LIVE_SHAPES + 1);
      releaseMine();
      await Promise.resolve();
      expect(registry.liveCount()).toBe(MAX_LIVE_SHAPES);
      expect(registry.isOpen(mine)).toBe(false);
    });

    it('going from a team to My Issues pauses the team the same way', async () => {
      const { factories } = fakeFactories();
      const registry = createRegistry(factories);
      open(registry);
      registry.get(team('issues', 't1'));
      const releaseTeam = registry.hold(team('issues', 't1'));
      registry.get(mine);
      registry.hold(mine);
      expect(registry.liveCount()).toBe(MAX_LIVE_SHAPES + 1);
      releaseTeam();
      await Promise.resolve();
      expect(registry.liveCount()).toBe(MAX_LIVE_SHAPES);
      expect(registry.isOpen(team('issues', 't1'))).toBe(false);
    });

    it('asks the page to make room when a reader takes it above the budget', () => {
      const overBudget = vi.fn();
      const { factories } = fakeFactories();
      const registry = createRegistry(factories, { overBudget });
      open(registry);
      registry.get(team('issues', 't1'));
      registry.hold(team('issues', 't1'));
      registry.get(mine);
      registry.hold(mine);
      expect(overBudget).toHaveBeenCalled();
    });

    it('pauseNow ends it when nobody holds it, and leaves a held one alone', async () => {
      const { factories } = fakeFactories();
      const registry = createRegistry(factories);
      const fake = registry.get(mine);
      const release = registry.hold(mine);
      registry.pauseNow(mine);
      await Promise.resolve();
      expect(fake.cleaned).toBe(0);
      release();
      registry.pauseNow(mine);
      await Promise.resolve();
      expect(fake.cleaned).toBe(1);
    });

    it('the three always-live shapes are never held or paused', async () => {
      const { factories } = fakeFactories();
      const registry = createRegistry(factories);
      const teams = registry.get({ kind: 'teams', workspaceId: ws });
      registry.hold({ kind: 'teams', workspaceId: ws })();
      registry.pauseNow({ kind: 'teams', workspaceId: ws });
      vi.advanceTimersByTime(PAUSE_AFTER_MS * 2);
      await Promise.resolve();
      expect(teams.cleaned).toBe(0);
    });
  });

  it('tells whether a shape is open and how many readers hold it', () => {
    const { factories } = fakeFactories();
    const registry = createRegistry(factories);
    expect(registry.isOpen(team('issues'))).toBe(false);
    registry.get(team('issues'));
    expect(registry.isOpen(team('issues'))).toBe(true);
    expect(registry.holdCount(team('issues'))).toBe(0);
    const first = registry.hold(team('issues'));
    registry.hold(team('issues'));
    expect(registry.holdCount(team('issues'))).toBe(2);
    first();
    expect(registry.holdCount(team('issues'))).toBe(1);
  });

  it('pauseNow ends a team shape nobody holds at once, and leaves a held one alone', async () => {
    const { factories } = fakeFactories();
    const registry = createRegistry(factories);
    const free = registry.get(team('issues', 'free'));
    const kept = registry.get(team('issues', 'kept'));
    registry.hold(team('issues', 'kept'));
    registry.pauseNow(team('issues', 'free'));
    registry.pauseNow(team('issues', 'kept'));
    await Promise.resolve();
    expect(free.cleaned).toBe(1);
    expect(kept.cleaned).toBe(0);
    expect(registry.isOpen(team('issues', 'free'))).toBe(false);
  });

  it('asks the page to make room when a reader takes the page above its budget', () => {
    const { factories } = fakeFactories();
    const overBudget = vi.fn();
    const registry = createRegistry(factories, { overBudget });
    open(registry);
    registry.get(team('issues', 't1'));
    registry.hold(team('issues', 't1'));
    expect(overBudget).not.toHaveBeenCalled();
    registry.get(team('issues', 't2'));
    registry.hold(team('issues', 't2'));
    expect(overBudget).toHaveBeenCalledTimes(1);
  });

  it('a reader that lets go and reads again in the same tick keeps the shape, also over the budget', async () => {
    const { factories } = fakeFactories();
    const registry = createRegistry(factories);
    open(registry);
    registry.get(team('issues', 't0'));
    registry.hold(team('issues', 't0'));
    const fake = registry.get(team('issues', 't1'));
    expect(registry.liveCount()).toBe(MAX_LIVE_SHAPES + 1);
    // What a development render does to an effect: it ends the effect and starts it again at once, with a live query
    // still bound to the open instance, which must not be replaced under it.
    registry.hold(team('issues', 't1'))();
    registry.hold(team('issues', 't1'));
    await Promise.resolve();
    expect(fake.cleaned).toBe(0);
    expect(registry.get(team('issues', 't1'))).toBe(fake);
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

describe('syncRegistry across tabs', () => {
  it('a leader continues from the generation the device holds', () => {
    const { factories } = fakeFactories();
    const registry = createRegistry(factories, { storedGeneration: () => 3 });
    expect(registry.get({ kind: 'teams', workspaceId: ws }).id).toBe('teams-w1~3');
    registry.restart({ kind: 'teams', workspaceId: ws });
    expect(registry.get({ kind: 'teams', workspaceId: ws }).id).toBe('teams-w1~4');
  });

  it('a follower reads under ids that are never a device id, and ignores what the device holds', () => {
    const { factories } = fakeFactories();
    const registry = createRegistry(factories, {
      role: () => 'follower',
      storedGeneration: () => 3,
    });
    expect(registry.get({ kind: 'teams', workspaceId: ws }).id).toBe('mirror-teams-w1');
  });

  it('promote ends the follower instances of the workspace and starts leader ones from the device copy', () => {
    const { factories, made } = fakeFactories();
    let role: 'leader' | 'follower' = 'follower';
    const registry = createRegistry(factories, { role: () => role, storedGeneration: () => 2 });
    const follower = registry.get({ kind: 'teams', workspaceId: ws });
    const other = registry.get({ kind: 'teams', workspaceId: 'w2' });
    const listener = vi.fn();
    registry.subscribe(listener);
    role = 'leader';
    registry.promote(ws);
    expect(follower.cleaned).toBe(1);
    expect(other.cleaned).toBe(0);
    expect(listener).toHaveBeenCalled();
    const leader = registry.get({ kind: 'teams', workspaceId: ws });
    expect(leader).not.toBe(follower);
    expect(leader.id).toBe('teams-w1~2');
    expect(made.map((fake) => fake.id)).toContain('teams-w1~2');
  });
});

describe('snapshot shapes', () => {
  const labels = (teamId = 't1') => ({ kind: 'labels', workspaceId: ws, teamId }) as const;
  const detail = (issueId = 'i1', teamId = 't1') =>
    ({ kind: 'issueDetail', workspaceId: ws, teamId, issueId }) as const;
  const activity = (issueId = 'i1') =>
    ({ kind: 'issueActivity', workspaceId: ws, teamId: 't1', issueId }) as const;

  function openLive(
    registry: ReturnType<typeof createRegistry<ReturnType<typeof fakeFactories>['factories']>>,
  ) {
    registry.get({ kind: 'teams', workspaceId: ws });
    registry.get({ kind: 'members', workspaceId: ws });
    registry.get({ kind: 'ownMemberships', workspaceId: ws });
    registry.get(team('issues'));
  }

  it('names the snapshot kinds: the existing workflow states and the new read-only tables', () => {
    expect([...SNAPSHOT_KINDS].sort()).toEqual(
      [
        'documentContent',
        'issueActivity',
        'issueAttachments',
        'issueComments',
        'issueDetail',
        'issueLabels',
        'issueLinks',
        'issueRelations',
        'issueSubscribers',
        'labels',
        'workflowStates',
        'workspaceLabels',
      ].sort(),
    );
    for (const kind of SNAPSHOT_KINDS) expect(isSnapshotKind(kind)).toBe(true);
    for (const kind of [
      'teams',
      'members',
      'ownMemberships',
      'issues',
      'teamMembers',
      'documents',
    ]) {
      expect(isSnapshotKind(kind)).toBe(false);
    }
    expect(isSnapshotKind('nonsense')).toBe(false);
  });

  it('snapshots are not live: nine open snapshots leave the live count and the budget alone', () => {
    const { factories } = fakeFactories();
    const overBudget = vi.fn();
    const registry = createRegistry(factories, { overBudget });
    openLive(registry);
    const keys: ShapeKey[] = [
      labels(),
      team('workflowStates'),
      { kind: 'issueLabels', workspaceId: ws, teamId: 't1' },
      { kind: 'issueRelations', workspaceId: ws, teamId: 't1' },
      { kind: 'issueLinks', workspaceId: ws, teamId: 't1' },
      { kind: 'issueSubscribers', workspaceId: ws, teamId: 't1' },
      { kind: 'workspaceLabels', workspaceId: ws },
      detail(),
      activity(),
    ];
    for (const key of keys) {
      registry.get(key);
      registry.hold(key);
    }
    expect(registry.liveCount()).toBe(MAX_LIVE_SHAPES);
    expect(overBudget).not.toHaveBeenCalled();
    // The same count of live shapes would be over budget.
    registry.get(team('issues', 't2'));
    registry.hold(team('issues', 't2'));
    expect(registry.liveCount()).toBe(MAX_LIVE_SHAPES + 1);
    expect(overBudget).toHaveBeenCalledOnce();
  });

  it('a released snapshot waits the usual delay even when the page is over its budget', async () => {
    vi.useFakeTimers();
    try {
      const { factories } = fakeFactories();
      const registry = createRegistry(factories);
      openLive(registry);
      registry.get(team('issues', 't2'));
      const snapshot = registry.get(labels());
      registry.hold(labels())();
      await Promise.resolve();
      // A live team shape would close at once here; a snapshot holds no connection that is worth freeing.
      expect(snapshot.cleaned).toBe(0);
      vi.advanceTimersByTime(PAUSE_AFTER_MS);
      await Promise.resolve();
      expect(snapshot.cleaned).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  /** Fakes that can be started and answered one by one. */
  function controlled() {
    const made: Array<Fake & { preloaded: number; answer: () => void }> = [];
    const build = (
      _key: ShapeKey,
      id: string,
      context: { inert: boolean; settled: () => void },
    ) => {
      const fake: Fake & { preloaded: number; answer: () => void } = {
        id,
        inert: context.inert,
        cleaned: 0,
        preloaded: 0,
        answer: () => context.settled(),
        cleanup() {
          fake.cleaned += 1;
        },
        preload() {
          fake.preloaded += 1;
          return Promise.resolve();
        },
      } as never;
      made.push(fake);
      return fake;
    };
    return { factories: allKinds(build) as unknown as Factories, made };
  }

  it('refresh starts the next instance beside the old one: readers keep the old one until the new one answers', async () => {
    const { factories, made } = controlled();
    const registry = createRegistry(factories);
    const listener = vi.fn();
    const first = registry.get(labels());
    registry.subscribe(listener);
    registry.refresh(labels());
    await Promise.resolve();
    // The new instance is made and started, nobody reads it yet.
    expect(made.map((fake) => fake.id)).toEqual(['labels-w1-t1', 'labels-w1-t1~2']);
    expect(made[1]?.preloaded).toBe(1);
    expect(registry.get(labels())).toBe(first);
    expect(made[0]?.cleaned).toBe(0);
    expect(listener).not.toHaveBeenCalled();

    made[1]?.answer();
    await Promise.resolve();
    expect(registry.get(labels())).toBe(made[1]);
    expect(made[0]?.cleaned).toBe(1);
    expect(made[1]?.cleaned).toBe(0);
    expect(listener).toHaveBeenCalledOnce();
  });

  it('a refresh that never answers (offline) leaves readers on the old instance, and a newer refresh replaces it', async () => {
    const { factories, made } = controlled();
    const registry = createRegistry(factories);
    const first = registry.get(labels());
    registry.refresh(labels());
    registry.refresh(labels());
    await Promise.resolve();
    expect(registry.get(labels())).toBe(first);
    expect(made.map((fake) => fake.id)).toEqual([
      'labels-w1-t1',
      'labels-w1-t1~2',
      'labels-w1-t1~3',
    ]);
    // The read that was still waiting is ended, the old instance is untouched.
    expect(made.map((fake) => fake.cleaned)).toEqual([0, 1, 0]);
    // The ended read answering late changes nothing.
    made[1]?.answer();
    expect(registry.get(labels())).toBe(first);
    made[2]?.answer();
    await Promise.resolve();
    expect(registry.get(labels())).toBe(made[2]);
    expect(made[0]?.cleaned).toBe(1);
  });

  it('refresh of a snapshot nobody read creates nothing and stays quiet', () => {
    const { factories, made } = fakeFactories();
    const registry = createRegistry(factories);
    const listener = vi.fn();
    registry.subscribe(listener);
    registry.refresh(labels());
    expect(made).toHaveLength(0);
    expect(listener).not.toHaveBeenCalled();
  });

  it('refresh leaves a live shape alone', () => {
    const { factories } = fakeFactories();
    const registry = createRegistry(factories);
    const issues = registry.get(team('issues'));
    registry.refresh(team('issues'));
    expect(registry.get(team('issues'))).toBe(issues);
    expect(issues.cleaned).toBe(0);
  });

  it('refresh of a team that is gone reads nothing', () => {
    const { factories, made } = controlled();
    const registry = createRegistry(factories);
    registry.get(labels());
    registry.dropTeam(ws, 't1');
    const before = made.length;
    registry.refresh(labels());
    expect(made).toHaveLength(before);
  });

  it('older device copies go once the new instance has answered and the old one has stopped, not before', async () => {
    const { factories, made } = controlled();
    const onShapeRestarted = vi.fn();
    const registry = createRegistry(factories, { onShapeRestarted });
    registry.get(labels());
    registry.refresh(labels());
    await Promise.resolve();
    // The new instance has not heard from the server: the copy on the device is all that shows labels offline.
    expect(onShapeRestarted).not.toHaveBeenCalled();
    made[1]?.answer();
    await Promise.resolve();
    await Promise.resolve();
    expect(onShapeRestarted).toHaveBeenCalledOnce();
    expect(onShapeRestarted).toHaveBeenCalledWith(labels(), 'labels-w1-t1', 'labels-w1-t1~2');
    // Later answers of the same instance delete nothing more.
    made[1]?.answer();
    await Promise.resolve();
    expect(onShapeRestarted).toHaveBeenCalledOnce();
  });

  it('an instance that was replaced again before it answered deletes nothing', async () => {
    const { factories, made } = controlled();
    const onShapeRestarted = vi.fn();
    const registry = createRegistry(factories, { onShapeRestarted });
    registry.get(labels());
    registry.refresh(labels());
    registry.refresh(labels());
    made[1]?.answer();
    await Promise.resolve();
    expect(onShapeRestarted).not.toHaveBeenCalled();
    made[2]?.answer();
    await Promise.resolve();
    await Promise.resolve();
    expect(onShapeRestarted).toHaveBeenCalledWith(labels(), 'labels-w1-t1', 'labels-w1-t1~3');
  });

  it('dropTeam ends a read that was waiting for its answer too', async () => {
    const { factories, made } = controlled();
    const registry = createRegistry(factories);
    registry.get(labels());
    registry.refresh(labels());
    registry.dropTeam(ws, 't1');
    await Promise.resolve();
    expect(made.map((fake) => fake.cleaned)).toEqual([1, 1]);
    made[1]?.answer();
    await Promise.resolve();
    // The team stays gone: what is read now is an inert collection.
    registry.get(labels());
    expect(made[made.length - 1]?.inert).toBe(true);
  });

  it('dropTeam ends the snapshots of the team, the per-issue ones included, and keeps the workspace ones', async () => {
    const { factories } = fakeFactories();
    const registry = createRegistry(factories);
    const workspaceLabels = registry.get({ kind: 'workspaceLabels', workspaceId: ws });
    const otherTeam = registry.get(labels('t2'));
    const mine = [registry.get(labels()), registry.get(detail()), registry.get(activity('i2'))];
    registry.dropTeam(ws, 't1');
    await Promise.resolve();
    expect(mine.map((fake) => fake.cleaned)).toEqual([1, 1, 1]);
    expect([workspaceLabels.cleaned, otherTeam.cleaned]).toEqual([0, 0]);
    // The team stays gone: its snapshots are inert until its id returns.
    expect(registry.get(detail()).inert).toBe(true);
    registry.reinstateTeam(ws, 't1');
    expect(registry.get(detail()).inert).toBe(false);
  });

  it('names an issue shape by workspace, team and issue, and reads the name back', () => {
    const keys: ShapeKey[] = [{ kind: 'teams', workspaceId: ws }, team('issues'), detail('i9')];
    expect(keys.map(shapeId)).toEqual(['teams:w1', 'issues:w1:t1', 'issueDetail:w1:t1:i9']);
    for (const key of keys) expect(parseShapeId(shapeId(key))).toEqual(key);
    const { factories } = fakeFactories();
    const registry = createRegistry(factories);
    expect(registry.get(detail('i9')).id).toBe('issueDetail-w1-t1-i9');
    expect(registry.get({ kind: 'workspaceLabels', workspaceId: ws }).id).toBe(
      'workspaceLabels-w1',
    );
  });

  it('shares only live shapes between tabs: a snapshot id from another tab is not a shape id', () => {
    expect(isShapeId('issues:w1:t1')).toBe(true);
    expect(isShapeId('teamMembers:w1:t1')).toBe(true);
    expect(isShapeId('teams:w1')).toBe(true);
    for (const id of [
      'labels:w1:t1',
      'workflowStates:w1:t1',
      'workspaceLabels:w1',
      'issueDetail:w1:t1:i1',
      'issues:w1',
      'issues:w1:t1:i1',
      'issueDetail:w1:t1',
    ]) {
      expect(isShapeId(id)).toBe(false);
    }
  });

  it('the kinds a team owns include its snapshots and the per-issue ones, but not the workspace labels', () => {
    expect(TEAM_KINDS).toEqual(
      expect.arrayContaining(['issues', 'labels', 'issueDetail', 'issueActivity', 'teamMembers']),
    );
    expect(TEAM_KINDS).not.toContain('workspaceLabels');
  });
});

describe('shapes of comments, attachments and documents', () => {
  const issueKey = (kind: 'issueComments' | 'issueAttachments', issueId = 'i1') =>
    ({ kind, workspaceId: ws, teamId: 't1', issueId }) as const;
  const docKey = {
    kind: 'documentContent',
    workspaceId: ws,
    teamId: 't1',
    documentId: 'd1',
  } as const;
  const documentsKey = { kind: 'documents', workspaceId: ws, teamId: 't1' } as const;

  it('names the shapes of one issue and of one document by their team and object', () => {
    expect(shapeId(issueKey('issueComments'))).toBe('issueComments:w1:t1:i1');
    expect(shapeId(issueKey('issueAttachments'))).toBe('issueAttachments:w1:t1:i1');
    expect(shapeId(docKey)).toBe('documentContent:w1:t1:d1');
    expect(shapeId(documentsKey)).toBe('documents:w1:t1');
    expect(parseShapeId('issueComments:w1:t1:i1')).toEqual(issueKey('issueComments'));
    expect(parseShapeId('documentContent:w1:t1:d1')).toEqual(docKey);
    expect(parseShapeId('documents:w1:t1')).toEqual(documentsKey);
  });

  it('shares the live document titles between tabs and never a snapshot of one object', () => {
    expect(isShapeId('documents:w1:t1')).toBe(true);
    expect(isShapeId('documents:w1')).toBe(false);
    expect(isShapeId('issueComments:w1:t1:i1')).toBe(false);
    expect(isShapeId('issueAttachments:w1:t1:i1')).toBe(false);
    expect(isShapeId('documentContent:w1:t1:d1')).toBe(false);
    expect(isShapeId('documents:w1:t1:extra')).toBe(false);
  });

  it("makes the three object kinds snapshots and the document titles live, all of them the team's", () => {
    for (const kind of ['issueComments', 'issueAttachments', 'documentContent']) {
      expect(isSnapshotKind(kind)).toBe(true);
      expect(SNAPSHOT_KINDS).toContain(kind);
    }
    expect(isSnapshotKind('documents')).toBe(false);
    for (const kind of ['issueComments', 'issueAttachments', 'documentContent', 'documents']) {
      expect(TEAM_KINDS).toContain(kind);
    }
  });

  it('gives every object its own collection id, and a refresh a new one once it has answered', async () => {
    // A refresh starts the new instance beside the old one; readers move to it when it settles.
    const settles: Array<() => void> = [];
    const factories = allKinds((_key: ShapeKey, id: string, context: { settled: () => void }) => {
      settles.push(context.settled);
      return { id, cleanup() {} } as Fake;
    }) satisfies Factories;
    const registry = createRegistry(factories);
    expect(registry.get(issueKey('issueComments')).id).toBe('issueComments-w1-t1-i1');
    expect(registry.get(issueKey('issueComments', 'i2')).id).toBe('issueComments-w1-t1-i2');
    expect(registry.get(issueKey('issueAttachments')).id).toBe('issueAttachments-w1-t1-i1');
    expect(registry.get(docKey).id).toBe('documentContent-w1-t1-d1');
    expect(registry.get(documentsKey).id).toBe('documents-w1-t1');
    registry.refresh(issueKey('issueComments'));
    await Promise.resolve();
    expect(registry.get(issueKey('issueComments')).id).toBe('issueComments-w1-t1-i1');
    settles.at(-1)?.();
    await Promise.resolve();
    expect(registry.get(issueKey('issueComments')).id).toBe('issueComments-w1-t1-i1~2');
    // A live shape is never refreshed: it is always current.
    registry.refresh(documentsKey);
    expect(registry.get(documentsKey).id).toBe('documents-w1-t1');
  });

  it('ends them with their team, and starts them again when the team is back', async () => {
    const { factories } = fakeFactories();
    const registry = createRegistry(factories);
    const mine = [
      registry.get(issueKey('issueComments')),
      registry.get(issueKey('issueAttachments')),
      registry.get(docKey),
      registry.get(documentsKey),
    ];
    const other = registry.get({ ...issueKey('issueComments'), teamId: 't2' });
    registry.dropTeam(ws, 't1');
    await Promise.resolve();
    expect(mine.map((fake) => fake.cleaned)).toEqual([1, 1, 1, 1]);
    expect(other.cleaned).toBe(0);
    // A reader of a dropped team is served an empty collection.
    expect(registry.get(issueKey('issueComments')).inert).toBe(true);
    registry.reinstateTeam(ws, 't1');
    expect(registry.get(issueKey('issueComments')).inert).toBe(false);
  });

  it('counts the document titles against the live budget and the snapshots not at all', () => {
    const { factories } = fakeFactories();
    const registry = createRegistry(factories);
    registry.get(issueKey('issueComments'));
    registry.get(issueKey('issueAttachments'));
    registry.get(docKey);
    expect(registry.liveCount()).toBe(0);
    registry.get(documentsKey);
    expect(registry.liveCount()).toBe(1);
  });

  it('pauses a held snapshot of one object 30 s after its reader left, over budget or not', async () => {
    vi.useFakeTimers();
    try {
      const { factories } = fakeFactories();
      const registry = createRegistry(factories);
      const fake = registry.get(issueKey('issueComments'));
      registry.hold(issueKey('issueComments'))();
      vi.advanceTimersByTime(PAUSE_AFTER_MS - 1);
      await Promise.resolve();
      expect(fake.cleaned).toBe(0);
      vi.advanceTimersByTime(1);
      await Promise.resolve();
      expect(fake.cleaned).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });
});
