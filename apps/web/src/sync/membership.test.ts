import { describe, expect, it, vi } from 'vitest';
import { startMembershipWatcher, type Watchable, type WatcherRegistry } from './membership.ts';
import type { ShapeKey } from './registry.ts';

type Row = Record<string, unknown>;

/** A collection whose rows the test sets by hand; `settle()` is what the registry tells the watcher. */
function fakeCollection(initial: Record<string, Row> = {}) {
  const state = { rows: new Map(Object.entries(initial)) };
  const preloaded = vi.fn();
  const collection: Watchable = {
    async preload() {
      preloaded();
    },
    keys: () => state.rows.keys(),
    get: (key) => state.rows.get(String(key)),
  };
  return {
    collection,
    state,
    preloaded,
    set(rows: Record<string, Row>) {
      state.rows = new Map(Object.entries(rows));
    },
  };
}

type Fake = ReturnType<typeof fakeCollection>;

const mine = { role: 'member', deactivated_at: null, name: 'A' };

function setup(options: { teams?: string[]; members?: Record<string, Row> } = {}) {
  const own = fakeCollection();
  let members = fakeCollection(options.members ?? { me: mine });
  let teams = fakeCollection(
    Object.fromEntries((options.teams ?? ['t1', 't2']).map((id) => [id, {}])),
  );
  const listeners = new Set<() => void>();
  const settledListeners = new Map<string, Set<(workspaceId: string) => void>>();
  const calls: string[] = [];
  const gone = new Set<string>();
  const registry: WatcherRegistry = {
    get(key: ShapeKey) {
      if (key.kind === 'ownMemberships') return own.collection;
      if (key.kind === 'members') return members.collection;
      return teams.collection;
    },
    restart(key) {
      calls.push(`restart:${key.kind}`);
    },
    dropTeam(_workspaceId, teamId) {
      gone.add(teamId);
      calls.push(`drop:${teamId}`);
    },
    reinstateTeam(_workspaceId, teamId) {
      gone.delete(teamId);
      calls.push(`reinstate:${teamId}`);
    },
    isGone: (_workspaceId, teamId) => gone.has(teamId),
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    onSettled(kind, listener) {
      const set = settledListeners.get(kind) ?? new Set();
      settledListeners.set(kind, set);
      set.add(listener);
      return () => set.delete(listener);
    },
  };
  return {
    own,
    calls,
    registry,
    get members() {
      return members;
    },
    get teams() {
      return teams;
    },
    settle(kind: 'ownMemberships' | 'members' | 'teams', workspaceId = 'w1') {
      for (const listener of [...(settledListeners.get(kind) ?? [])]) listener(workspaceId);
    },
    /** The registry started a new instance (a restart) and told the watcher. */
    replaceTeams(next: Fake) {
      teams = next;
      for (const listener of listeners) listener();
    },
    replaceMembers(next: Fake) {
      members = next;
      for (const listener of listeners) listener();
    },
    listenerCount: () => [...settledListeners.values()].reduce((n, set) => n + set.size, 0),
  };
}

const start = (s: ReturnType<typeof setup>, forget: (...args: never[]) => unknown = () => {}) =>
  startMembershipWatcher('w1', 'me', s.registry, forget as never);

describe('startMembershipWatcher', () => {
  it('records the first answer of each shape as the baseline and restarts nothing', () => {
    const s = setup();
    s.own.set({ 't1:me': {} });
    start(s);
    s.settle('ownMemberships');
    s.settle('members');
    s.settle('teams');
    expect(s.calls).toEqual([]);
  });

  it('restarts teams and members when the person joins a team', () => {
    const s = setup();
    start(s);
    s.settle('ownMemberships');
    s.own.set({ 't3:me': {} });
    s.settle('ownMemberships');
    expect(s.calls).toEqual(['restart:teams', 'restart:members']);
  });

  it('restarts when the person is removed from a team, though the row came with the first sync', () => {
    const s = setup();
    s.own.set({ 't1:me': {}, 't3:me': {} });
    start(s);
    s.settle('ownMemberships');
    s.own.set({ 't1:me': {} });
    s.settle('ownMemberships');
    expect(s.calls).toEqual(['restart:teams', 'restart:members']);
  });

  it('restarts when the answer after a must-refetch no longer holds a membership', () => {
    const s = setup();
    s.own.set({ 't1:me': {} });
    start(s);
    s.settle('ownMemberships');
    s.own.set({});
    s.settle('ownMemberships');
    expect(s.calls).toEqual(['restart:teams', 'restart:members']);
  });

  it('does not restart for an answer that changes nothing in the key set', () => {
    const s = setup();
    s.own.set({ 't1:me': { a: 1 } });
    start(s);
    s.settle('ownMemberships');
    s.own.set({ 't1:me': { a: 2 } });
    s.settle('ownMemberships');
    s.settle('ownMemberships');
    expect(s.calls).toEqual([]);
  });

  it('restarts when the own role or deactivation changes, not for another member or a name', () => {
    const s = setup({ members: { me: mine, someone: { ...mine, name: 'S' } } });
    start(s);
    s.settle('members');
    s.members.set({ me: mine, someone: { ...mine, role: 'admin' } });
    s.settle('members');
    s.members.set({ me: { ...mine, name: 'B' }, someone: { ...mine, role: 'admin' } });
    s.settle('members');
    expect(s.calls).toEqual([]);
    s.members.set({ me: { ...mine, role: 'admin' } });
    s.settle('members');
    expect(s.calls).toEqual(['restart:teams', 'restart:members']);
    s.calls.length = 0;
    s.members.set({ me: { ...mine, role: 'admin', deactivated_at: '2026-11-15T00:00:00Z' } });
    s.settle('members');
    expect(s.calls).toEqual(['restart:teams', 'restart:members']);
  });

  it('restarts when the own member row disappears from the members shape', () => {
    const s = setup();
    start(s);
    s.settle('members');
    s.members.set({});
    s.settle('members');
    expect(s.calls).toEqual(['restart:teams', 'restart:members']);
  });

  it('takes the first answer of a new members instance as its baseline', () => {
    const s = setup();
    start(s);
    s.settle('members');
    // The restart's new instance already holds the new role: that is the restart working, not another change.
    s.replaceMembers(fakeCollection({ me: { ...mine, role: 'admin' } }));
    s.settle('members');
    expect(s.calls).toEqual([]);
    s.members.set({ me: { ...mine, role: 'guest' } });
    s.settle('members');
    expect(s.calls).toEqual(['restart:teams', 'restart:members']);
  });

  it('compares each settle of `teams` with the last: drops the team that vanished, reinstates one that is back', () => {
    const s = setup({ teams: ['t1', 't2'] });
    start(s);
    s.settle('teams');
    s.calls.length = 0;
    s.teams.set({ t1: {} });
    s.settle('teams');
    expect(s.calls).toEqual(['drop:t2']);
    s.calls.length = 0;
    s.teams.set({ t1: {}, t2: {}, t9: {} });
    s.settle('teams');
    expect(s.calls).toEqual(['reinstate:t2']);
  });

  it('compares a restarted teams shape with what it held and drops the vanished team', () => {
    const s = setup({ teams: ['t1', 't2'] });
    start(s);
    s.settle('teams');
    s.calls.length = 0;
    s.replaceTeams(fakeCollection({ t1: {} }));
    s.settle('teams');
    expect(s.calls).toContain('drop:t2');
    expect(s.calls).not.toContain('drop:t1');
  });

  it('reinstates a dropped team that a restarted teams shape lists again, and only that one', () => {
    const s = setup({ teams: ['t1', 't2'] });
    start(s);
    s.settle('teams');
    s.replaceTeams(fakeCollection({ t1: {} }));
    s.settle('teams');
    expect(s.calls).toContain('drop:t2');
    s.calls.length = 0;
    // The person rejoined t2: the next answer lists both, and t1 (never dropped) is left alone.
    s.replaceTeams(fakeCollection({ t1: {}, t2: {} }));
    s.settle('teams');
    expect(s.calls).toEqual(['reinstate:t2']);
  });

  it('ignores a settle of another workspace', () => {
    const s = setup();
    start(s);
    s.settle('ownMemberships', 'w2');
    s.own.set({ 't3:me': {} });
    s.settle('ownMemberships', 'w2');
    expect(s.calls).toEqual([]);
  });

  it('starts the sync of the three shapes it watches', () => {
    const s = setup();
    start(s);
    expect(s.own.preloaded).toHaveBeenCalledOnce();
    expect(s.members.preloaded).toHaveBeenCalledOnce();
    expect(s.teams.preloaded).toHaveBeenCalledOnce();
  });

  it('stops listening when stopped', () => {
    const s = setup();
    const stop = start(s);
    expect(s.listenerCount()).toBe(3);
    stop();
    expect(s.listenerCount()).toBe(0);
    s.own.set({ 't3:me': {} });
    s.settle('ownMemberships');
    expect(s.calls).toEqual([]);
  });
});

describe('persisted teams the person no longer sees', () => {
  it('forgets the device copy of every team missing from the answer of `teams`', () => {
    const s = setup({ teams: ['t1'] });
    const forget = vi.fn();
    const stop = start(s, forget);
    s.settle('teams');
    expect(forget).toHaveBeenCalledWith('w1', new Set(['t1']));
    stop();
  });
});
