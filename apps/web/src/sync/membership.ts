// Watches the person's own access and restarts the shapes it changes. A shape is scoped on the server by who is
// asking, so when that changes (a private-team join or removal, a new role, a deactivation) the rows an open page
// holds may be wrong in both directions: `teams` and `members` start over, and a team that is no longer in `teams`
// loses its own shapes.

import { deleteTeamsExcept } from './persistence.ts';
import type { ShapeKey } from './registry.ts';
import { syncRegistry } from './shapes.ts';

/** What the watcher reads of a collection. */
export type Watchable = {
  preload(): Promise<void>;
  keys(): Iterable<string | number>;
  get(key: string | number): Record<string, unknown> | undefined;
};

/** What the watcher needs of the registry. */
export type WatcherRegistry = {
  get(key: ShapeKey): Watchable;
  restart(key: ShapeKey): void;
  dropTeam(workspaceId: string, teamId: string): void;
  reinstateTeam(workspaceId: string, teamId: string): void;
  isGone(workspaceId: string, teamId: string): boolean;
  subscribe(listener: () => void): () => void;
  /** Heard every time the current instance of a shape of this kind has applied an answer of the server. */
  onSettled(kind: WatchedKind, listener: (workspaceId: string) => void): () => void;
};

type WatchedKind = 'ownMemberships' | 'members' | 'teams';

/**
 * A subscription to a collection's changes cannot be the signal: it reports only what happens after it was made, and
 * never the removal of a row that was already there (every row of the first sync), nor a truncate (subscribe-changes.test.ts
 * pins this). So the watcher reads the collection when its shape SETTLES (the registry says so after every answer of the
 * server, a must-refetch included) and compares with what it read the last time. The first answer of an instance is
 * only the baseline.
 */
export function startMembershipWatcher(
  workspaceId: string,
  selfId: string,
  registry: WatcherRegistry = syncRegistry as unknown as WatcherRegistry,
  forgetTeamsExcept: (workspaceId: string, keep: Set<string>) => unknown = (id, keep) =>
    deleteTeamsExcept(id, keep).catch(() => {}),
): () => void {
  let stopped = false;
  const attached = new Map<WatchedKind, Watchable>();
  // What each shape held at its last answer: the own memberships (their keys) and the own member row (role, status).
  let lastMemberships: string | undefined;
  let lastOwnRow: string | undefined;
  // The team ids the person could see the last time `teams` settled: what a restart is compared with.
  let knownTeams = new Set<string>();

  function restartAccess() {
    registry.restart({ kind: 'teams', workspaceId });
    registry.restart({ kind: 'members', workspaceId });
  }

  const sorted = (keys: Iterable<string | number>) => Array.from(keys, String).sort().join('\n');

  const settle: Record<WatchedKind, (instance: Watchable, first: boolean) => void> = {
    ownMemberships(instance, first) {
      const now = sorted(instance.keys());
      const before = lastMemberships;
      lastMemberships = now;
      if (!first && before !== now) restartAccess();
    },
    members(instance, first) {
      const own = instance.get(selfId);
      const now = own ? JSON.stringify([own.role, own.deactivated_at ?? null]) : '';
      const before = lastOwnRow;
      lastOwnRow = now;
      if (!first && before !== now) restartAccess();
    },
    teams(instance) {
      const now = new Set(Array.from(instance.keys(), String));
      // An answer with fewer teams: the ones that are gone lose their shapes. A team that was dropped and is listed
      // again (the person rejoined it) syncs again.
      for (const id of knownTeams) if (!now.has(id)) registry.dropTeam(workspaceId, id);
      for (const id of now)
        if (registry.isGone(workspaceId, id)) registry.reinstateTeam(workspaceId, id);
      knownTeams = now;
      // A team the device still holds rows of but `teams` does not list (access ended while the page was closed): nothing
      // would ever open its shapes again, so its copy goes now. A stale copy of `teams` itself is corrected by the drop
      // above, when the server's answer removes the team.
      forgetTeamsExcept(workspaceId, now);
    },
  };

  // The instance whose answers were already read: a new one (after a restart) starts with a baseline.
  const read = new Map<WatchedKind, Watchable>();

  function onSettled(kind: WatchedKind, id: string) {
    if (stopped || id !== workspaceId) return;
    const instance = registry.get({ kind, workspaceId });
    const first = read.get(kind) !== instance;
    read.set(kind, instance);
    settle[kind](instance, first);
  }

  function attach(kind: WatchedKind) {
    const instance = registry.get({ kind, workspaceId });
    if (attached.get(kind) === instance) return;
    attached.set(kind, instance);
    // Nothing else starts these shapes (no screen reads `ownMemberships`), and a collection only syncs once something
    // asks it to.
    instance.preload().catch(() => {});
  }

  function attachAll() {
    if (stopped) return;
    attach('ownMemberships');
    attach('members');
    attach('teams');
  }

  const unsubscribes = (['ownMemberships', 'members', 'teams'] as const).map((kind) =>
    registry.onSettled(kind, (id) => onSettled(kind, id)),
  );
  const unsubscribeRegistry = registry.subscribe(attachAll);
  attachAll();

  return () => {
    stopped = true;
    unsubscribeRegistry();
    for (const off of unsubscribes) off();
    attached.clear();
    read.clear();
  };
}
