import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { bindTestSession, deviceScope, resetIdentityForTests } from './identity.ts';
import {
  claimRole,
  leaveWorkspace,
  liveTabs,
  onPromoted,
  resetTabsForTests,
  roleOf,
  type TabPlatform,
} from './tabs.ts';

/** A lock manager that hands each name to one holder at a time, like the browser's. */
function fakeLocks() {
  const holders = new Set<string>();
  const queues = new Map<string, Array<() => void>>();
  const take = (name: string, callback: (lock: unknown) => unknown) => {
    holders.add(name);
    return Promise.resolve(callback({ name })).finally(() => {
      holders.delete(name);
      queues.get(name)?.shift()?.();
    });
  };
  return {
    request: (async (name: string, a: unknown, b?: unknown) => {
      const options = (typeof a === 'function' ? {} : a) as {
        ifAvailable?: boolean;
        signal?: AbortSignal;
      };
      const callback = (typeof a === 'function' ? a : b) as (lock: unknown) => unknown;
      if (!holders.has(name)) return take(name, callback);
      if (options.ifAvailable) return callback(null);
      return new Promise((resolve, reject) => {
        const turn = () => take(name, callback).then(resolve, reject);
        // A request that was aborted while it waited never gets the lock; the next one in line does.
        let aborted = false;
        const guarded = () => (aborted ? void queues.get(name)?.shift()?.() : turn());
        queues.set(name, [...(queues.get(name) ?? []), guarded]);
        options.signal?.addEventListener('abort', () => {
          aborted = true;
          reject(new Error('aborted'));
        });
      });
    }) as unknown as LockManager['request'],
    query: async () => ({ held: [...holders].map((name) => ({ name })), pending: [] }),
  };
}

const platformOf = (locks: ReturnType<typeof fakeLocks>): TabPlatform => ({
  locks,
  channel: () => new BroadcastChannel('unused'),
});

beforeEach(() => bindTestSession('w1', 'w2', 'w3'));
afterEach(() => {
  resetTabsForTests();
  resetIdentityForTests();
});
const lockOf = (workspaceId: string) => `sync-leader:${deviceScope(workspaceId)}`;

describe('tabs', () => {
  it('without Web Locks every tab leads on its own', async () => {
    expect(
      await claimRole('w1', { locks: undefined, channel: () => new BroadcastChannel('x') }),
    ).toBe('leader');
    expect(roleOf('w1')).toBe('leader');
  });

  it('the first tab of a workspace leads, a second one follows, and takes over when the leader lets go', async () => {
    const locks = fakeLocks();
    const platform = platformOf(locks);
    expect(await claimRole('w1', platform)).toBe('leader');
    // The same page claiming again gets the same answer.
    expect(await claimRole('w1', platform)).toBe('leader');
    expect((await liveTabs(platform))?.size).toBe(1);

    // A second tab: another module instance, played by a fresh claim on the same lock manager.
    const requested: string[] = [];
    const second = await new Promise<string>((resolve) => {
      void locks.request(lockOf('w1'), { ifAvailable: true }, (lock) => {
        requested.push(String(lock));
        resolve(lock ? 'leader' : 'follower');
        return undefined;
      });
    });
    expect(second).toBe('follower');
    leaveWorkspace('w1')();
  });

  it('a follower is told when it becomes the leader', async () => {
    const locks = fakeLocks();
    // Another tab holds the lock for good.
    let letGo: () => void = () => {};
    void locks.request(
      lockOf('w2'),
      (async () => new Promise<void>((resolve) => (letGo = resolve))) as never,
    );
    const platform = platformOf(locks);
    expect(await claimRole('w2', platform)).toBe('follower');
    expect(roleOf('w2')).toBe('follower');
    let promoted = 0;
    onPromoted('w2', () => {
      promoted += 1;
    });
    letGo();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(promoted).toBe(1);
    expect(roleOf('w2')).toBe('leader');
  });
  it('a tab that leaves a workspace stops waiting for its lock: the next tab is promoted, not the one that left', async () => {
    const locks = fakeLocks();
    let letGo: () => void = () => {};
    void locks.request(
      lockOf('w3'),
      (async () => new Promise<void>((resolve) => (letGo = resolve))) as never,
    );
    // This tab follows w3, then the person switches to another workspace.
    expect(await claimRole('w3', platformOf(locks))).toBe('follower');
    let promoted = 0;
    onPromoted('w3', () => {
      promoted += 1;
    });
    leaveWorkspace('w3')();
    // Another tab of the workspace waits too and must be the one that gets the lock.
    let otherLeads = false;
    void locks.request(lockOf('w3'), (async () => {
      otherLeads = true;
    }) as never);
    letGo();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(otherLeads).toBe(true);
    expect(promoted).toBe(0);
  });

  it('a leader that leaves hands the lock to the next tab, and claims the workspace afresh when it comes back', async () => {
    const locks = fakeLocks();
    const platform = platformOf(locks);
    expect(await claimRole('w1', platform)).toBe('leader');
    let otherLeads = false;
    void locks.request(lockOf('w1'), (async () => {
      otherLeads = true;
    }) as never);
    leaveWorkspace('w1')();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(otherLeads).toBe(true);
    // Back on the workspace: a new claim, not the cached answer of the first one.
    expect(roleOf('w1')).toBe('leader');
    expect(await claimRole('w1', platform)).toBe('leader');
  });
});
