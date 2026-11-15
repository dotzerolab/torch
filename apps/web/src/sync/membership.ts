// Watches the person's own access and restarts the shapes it changes. A shape is scoped on the server by who is
// asking, so when that changes (a private-team join or removal, a new role, a deactivation) the rows an open page
// holds may be wrong in both directions: `teams` and `members` start over, and a team that is no longer in `teams`
// loses its own shapes.
import type { ShapeKey } from './registry.ts';
import { syncRegistry } from './shapes.ts';

type Change = {
  type: 'insert' | 'update' | 'delete';
  key: string | number;
  value: Record<string, unknown>;
  previousValue?: Record<string, unknown>;
};

/** What the watcher reads of a collection. */
export type Watchable = {
  onFirstReady(callback: () => void): unknown;
  subscribeChanges(callback: (changes: Change[]) => void): { unsubscribe(): void };
  keys(): Iterable<string | number>;
};

/** What the watcher needs of the registry. */
export type WatcherRegistry = {
  get(key: ShapeKey): Watchable;
  restart(key: ShapeKey): void;
  dropTeam(workspaceId: string, teamId: string): void;
  reinstateTeam(workspaceId: string, teamId: string): void;
  subscribe(listener: () => void): () => void;
};

export function startMembershipWatcher(
  workspaceId: string,
  selfId: string,
  registry: WatcherRegistry = syncRegistry as unknown as WatcherRegistry,
): () => void {
  let stopped = false;
  const attached = new Map<string, { instance: Watchable; stop: () => void }>();
  // The team ids the person could see the last time `teams` was ready: what a restart is compared with.
  let knownTeams = new Set<string>();

  function restartAccess() {
    registry.restart({ kind: 'teams', workspaceId });
    registry.restart({ kind: 'members', workspaceId });
  }

  const watchers: Record<string, (changes: Change[]) => void> = {
    ownMemberships(changes) {
      // Only changes after the first sync count: the initial rows are the person's current memberships.
      if (changes.some((change) => change.type !== 'update')) restartAccess();
    },
    members(changes) {
      const own = changes.find((change) => change.key === selfId && change.type === 'update');
      if (!own) return;
      const before = own.previousValue;
      if (before?.role !== own.value.role || before?.deactivated_at !== own.value.deactivated_at) {
        restartAccess();
      }
    },
    teams(changes) {
      for (const change of changes) {
        const id = String(change.key);
        if (change.type === 'delete') {
          knownTeams.delete(id);
          registry.dropTeam(workspaceId, id);
        } else {
          knownTeams.add(id);
          registry.reinstateTeam(workspaceId, id);
        }
      }
    },
  };

  function onTeamsReady(instance: Watchable) {
    const now = new Set(Array.from(instance.keys(), String));
    // A restart answered with fewer teams: the ones that are gone lose their shapes (the restart itself already
    // forgave every dropped team).
    for (const id of knownTeams) if (!now.has(id)) registry.dropTeam(workspaceId, id);
    knownTeams = now;
  }

  function attach(kind: 'ownMemberships' | 'members' | 'teams') {
    const instance = registry.get({ kind, workspaceId });
    const current = attached.get(kind);
    if (current?.instance === instance) return;
    current?.stop();
    let subscription: { unsubscribe(): void } | undefined;
    let live = true;
    // Changes are read only once the first sync is in, so the rows of that sync are not mistaken for changes.
    instance.onFirstReady(() => {
      if (!live || stopped) return;
      if (kind === 'teams') onTeamsReady(instance);
      subscription = instance.subscribeChanges(watchers[kind] as (changes: Change[]) => void);
    });
    attached.set(kind, {
      instance,
      stop: () => {
        live = false;
        subscription?.unsubscribe();
      },
    });
  }

  function attachAll() {
    if (stopped) return;
    attach('ownMemberships');
    attach('members');
    attach('teams');
  }

  const unsubscribeRegistry = registry.subscribe(attachAll);
  attachAll();

  return () => {
    stopped = true;
    unsubscribeRegistry();
    for (const entry of attached.values()) entry.stop();
    attached.clear();
  };
}
