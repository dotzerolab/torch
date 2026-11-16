import { describe, expect, it, vi } from 'vitest';
import { startMembershipWatcher, type Watchable, type WatcherRegistry } from './membership.ts';
import type { ShapeKey } from './registry.ts';

type Change = Parameters<Parameters<Watchable['subscribeChanges']>[0]>[0][number];

/** A collection whose first sync is done (or not yet) and whose changes the test emits by hand. */
function fakeCollection(initialKeys: string[], ready = true) {
  let listener: ((changes: Change[]) => void) | undefined;
  let onReady: (() => void) | undefined;
  const state = { ready, keys: initialKeys };
  const preloaded = vi.fn();
  const collection: Watchable = {
    async preload() {
      preloaded();
    },
    onFirstReady(callback) {
      if (state.ready) callback();
      else onReady = callback;
    },
    subscribeChanges(callback) {
      listener = callback;
      return {
        unsubscribe() {
          listener = undefined;
        },
      };
    },
    keys: () => state.keys,
  };
  return {
    collection,
    emit: (...changes: Change[]) => listener?.(changes),
    becomeReady: () => {
      state.ready = true;
      onReady?.();
    },
    state,
    preloaded,
    get subscribed() {
      return listener !== undefined;
    },
  };
}

function setup(teamKeys = ['t1', 't2']) {
  const own = fakeCollection([]);
  const members = fakeCollection(['me']);
  let teams = fakeCollection(teamKeys);
  const listeners = new Set<() => void>();
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
  };
  return {
    own,
    members,
    calls,
    registry,
    get teams() {
      return teams;
    },
    replaceTeams(next: ReturnType<typeof fakeCollection>) {
      teams = next;
      for (const listener of listeners) listener();
    },
  };
}

const row = (extra: Record<string, unknown> = {}) => ({ team_id: 't3', member_id: 'me', ...extra });

describe('startMembershipWatcher', () => {
  it('restarts teams and members when the person joins a team', () => {
    const s = setup();
    startMembershipWatcher('w1', 'me', s.registry);
    s.own.emit({ type: 'insert', key: 't3:me', value: row() });
    expect(s.calls).toEqual(['restart:teams', 'restart:members']);
  });

  it('restarts when the person is removed from a team', () => {
    const s = setup();
    startMembershipWatcher('w1', 'me', s.registry);
    s.own.emit({ type: 'delete', key: 't3:me', value: row() });
    expect(s.calls).toEqual(['restart:teams', 'restart:members']);
  });

  it('does not treat the rows of the first sync as changes', () => {
    const s = setup();
    s.own.state.ready = false;
    startMembershipWatcher('w1', 'me', s.registry);
    expect(s.own.subscribed).toBe(false);
    s.own.becomeReady();
    expect(s.calls).toEqual([]);
    expect(s.own.subscribed).toBe(true);
  });

  it('restarts when the own role or deactivation changes, not for another member or a name', () => {
    const s = setup();
    startMembershipWatcher('w1', 'me', s.registry);
    const base = { role: 'member', deactivated_at: null, name: 'A' };
    s.members.emit({
      type: 'update',
      key: 'someone',
      value: { ...base, role: 'admin' },
      previousValue: base,
    });
    s.members.emit({
      type: 'update',
      key: 'me',
      value: { ...base, name: 'B' },
      previousValue: base,
    });
    expect(s.calls).toEqual([]);
    s.members.emit({
      type: 'update',
      key: 'me',
      value: { ...base, role: 'admin' },
      previousValue: base,
    });
    expect(s.calls).toEqual(['restart:teams', 'restart:members']);
    s.calls.length = 0;
    s.members.emit({
      type: 'update',
      key: 'me',
      value: { ...base, deactivated_at: '2026-11-15T00:00:00Z' },
      previousValue: base,
    });
    expect(s.calls).toEqual(['restart:teams', 'restart:members']);
  });

  it('drops a team that disappears from the teams shape and reinstates one that appears', () => {
    const s = setup();
    startMembershipWatcher('w1', 'me', s.registry);
    s.calls.length = 0;
    s.teams.emit({ type: 'delete', key: 't2', value: {} });
    s.teams.emit({ type: 'insert', key: 't9', value: {} });
    expect(s.calls).toEqual(['drop:t2', 'reinstate:t9']);
  });

  it('compares a restarted teams shape with what it held and drops the vanished team', () => {
    const s = setup(['t1', 't2']);
    startMembershipWatcher('w1', 'me', s.registry);
    s.calls.length = 0;
    // The restart's new instance answers with t1 only.
    s.replaceTeams(fakeCollection(['t1']));
    expect(s.calls).toContain('drop:t2');
    expect(s.calls).not.toContain('drop:t1');
  });

  it('reinstates a dropped team that a restarted teams shape lists again, and only that one', () => {
    const s = setup(['t1', 't2']);
    startMembershipWatcher('w1', 'me', s.registry);
    s.replaceTeams(fakeCollection(['t1']));
    expect(s.calls).toContain('drop:t2');
    s.calls.length = 0;
    // The person rejoined t2: the next answer lists both, and t1 (never dropped) is left alone.
    s.replaceTeams(fakeCollection(['t1', 't2']));
    expect(s.calls).toEqual(['reinstate:t2']);
  });

  it('starts the sync of the three shapes it watches', () => {
    const s = setup();
    startMembershipWatcher('w1', 'me', s.registry);
    expect(s.own.preloaded).toHaveBeenCalledOnce();
    expect(s.members.preloaded).toHaveBeenCalledOnce();
    expect(s.teams.preloaded).toHaveBeenCalledOnce();
  });

  it('stops listening when stopped', () => {
    const s = setup();
    const stop = startMembershipWatcher('w1', 'me', s.registry);
    stop();
    expect(s.own.subscribed).toBe(false);
    expect(vi.isMockFunction(stop)).toBe(false);
  });
});

describe('persisted teams the person no longer sees', () => {
  it('forgets the device copy of every team missing from the first answer of `teams`', () => {
    const teams = fakeCollection(['t1']);
    const quiet = fakeCollection([]);
    const registry = {
      get: (key: ShapeKey) => (key.kind === 'teams' ? teams.collection : quiet.collection),
      restart() {},
      dropTeam() {},
      reinstateTeam() {},
      isGone: () => false,
      subscribe: () => () => {},
    } as WatcherRegistry;
    const forget = vi.fn();
    const stop = startMembershipWatcher('w1', 'me', registry, forget);
    expect(forget).toHaveBeenCalledWith('w1', new Set(['t1']));
    stop();
  });
});
