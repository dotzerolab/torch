// One live collection per shape for the life of the page, so going back to a team does not restart its sync, plus the
// ways a shape ends: `restart` (access changed, start over), `dropTeam` (the team is gone for this person).
// A restarted collection is a NEW instance with a NEW id: react-db derives a live query's identity from the ids of
// its source collections, so a reused id would leave open queries bound to the instance that was cleaned up.
import { useSyncExternalStore } from 'react';

type WorkspaceKind = 'teams' | 'members' | 'ownMemberships';
type TeamKind = 'issues' | 'workflowStates' | 'teamMembers';
export type ShapeKind = WorkspaceKind | TeamKind;
type KeyOf<K extends ShapeKind> = K extends WorkspaceKind
  ? { kind: K; workspaceId: string }
  : { kind: K; workspaceId: string; teamId: string };
export type ShapeKey = KeyOf<ShapeKind>;

/** What the registry needs of a collection. */
export type Cleanable = { cleanup(options?: { dependents?: boolean }): unknown };

/** What a factory may call back into. `inert` asks for an empty collection that never syncs (a team that is gone). */
export type ShapeContext = {
  dropTeam: (workspaceId: string, teamId: string) => void;
  inert: boolean;
};

export type Factories = {
  [K in ShapeKind]: (key: KeyOf<K>, id: string, context: ShapeContext) => Cleanable;
};
export type CollectionFor<F extends Factories, K extends ShapeKey> = ReturnType<F[K['kind']]>;

const TEAM_KINDS: readonly TeamKind[] = ['issues', 'workflowStates', 'teamMembers'];

export function isTeamKey(key: ShapeKey): key is Extract<ShapeKey, { teamId: string }> {
  return (TEAM_KINDS as readonly string[]).includes(key.kind);
}

function keyOf(key: ShapeKey): string {
  return isTeamKey(key)
    ? `${key.kind}:${key.workspaceId}:${key.teamId}`
    : `${key.kind}:${key.workspaceId}`;
}

function goneKey(workspaceId: string, teamId: string): string {
  return `${workspaceId}:${teamId}`;
}

type Entry = { collection: Cleanable; generation: number };

export function createRegistry<F extends Factories>(factories: F) {
  const entries = new Map<string, Entry>();
  // Highest generation ever used per key: ids are never reused, even after a drop.
  const generations = new Map<string, number>();
  // Teams the server said are gone for this person (404). A page still showing one would otherwise ask for it
  // again and loop; it is served an empty local collection until `teams` restarts or the team id comes back.
  const gone = new Set<string>();
  const listeners = new Set<() => void>();

  const notify = () => {
    for (const listener of [...listeners]) listener();
  };

  function dispose(collection: Cleanable) {
    // `dependents: true` also ends the live queries that still read it; they re-bind on the notification.
    void Promise.resolve()
      .then(() => collection.cleanup({ dependents: true }))
      .catch(() => {});
  }

  function baseId(key: ShapeKey): string {
    return isTeamKey(key)
      ? `${key.kind}-${key.workspaceId}-${key.teamId}`
      : `${key.kind}-${key.workspaceId}`;
  }

  function create(key: ShapeKey): Entry {
    const k = keyOf(key);
    const generation = (generations.get(k) ?? 0) + 1;
    generations.set(k, generation);
    const id = generation === 1 ? baseId(key) : `${baseId(key)}~${generation}`;
    const inert = isTeamKey(key) && gone.has(goneKey(key.workspaceId, key.teamId));
    const make = factories[key.kind] as (
      key: ShapeKey,
      id: string,
      context: ShapeContext,
    ) => Cleanable;
    return { collection: make(key, id, { dropTeam, inert }), generation };
  }

  function get<K extends ShapeKey>(key: K): CollectionFor<F, K> {
    const k = keyOf(key);
    let entry = entries.get(k);
    if (!entry) {
      entry = create(key);
      entries.set(k, entry);
    }
    return entry.collection as CollectionFor<F, K>;
  }

  function replace(key: ShapeKey) {
    const k = keyOf(key);
    const old = entries.get(k);
    if (old) dispose(old.collection);
    entries.delete(k);
    return old !== undefined;
  }

  /** Ends the shape and starts a fresh one the next time it is read; open readers are told to re-bind. */
  function restart(key: ShapeKey) {
    const existed = replace(key);
    if (key.kind === 'teams') {
      for (const entry of [...gone])
        if (entry.startsWith(`${key.workspaceId}:`)) gone.delete(entry);
    }
    // A shape nobody read yet has nothing to restart. Create it lazily on the next `get`.
    if (existed) notify();
  }

  /** The team is no longer visible: end its shapes. Readers still on screen get empty collections. */
  function dropTeam(workspaceId: string, teamId: string) {
    gone.add(goneKey(workspaceId, teamId));
    for (const kind of TEAM_KINDS) {
      replace({ kind, workspaceId, teamId } as ShapeKey);
    }
    notify();
  }

  /** The team id is back in the person's `teams` shape: shapes of it may sync again. */
  function reinstateTeam(workspaceId: string, teamId: string) {
    if (!gone.delete(goneKey(workspaceId, teamId))) return;
    for (const kind of TEAM_KINDS) replace({ kind, workspaceId, teamId } as ShapeKey);
    notify();
  }

  function isGone(workspaceId: string, teamId: string): boolean {
    return gone.has(goneKey(workspaceId, teamId));
  }

  function subscribe(listener: () => void): () => void {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  }

  /** Test helper: end everything. */
  function reset() {
    for (const entry of entries.values()) dispose(entry.collection);
    entries.clear();
    generations.clear();
    gone.clear();
    notify();
  }

  return { get, restart, dropTeam, reinstateTeam, isGone, subscribe, reset };
}

export type SyncRegistry<F extends Factories = Factories> = ReturnType<typeof createRegistry<F>>;

/** The collection of a shape, for render: re-reads when the shape restarts or its team is dropped. */
export function useShapeFrom<F extends Factories, K extends ShapeKey>(
  registry: SyncRegistry<F>,
  key: K,
): CollectionFor<F, K> {
  return useSyncExternalStore(registry.subscribe, () => registry.get(key));
}
