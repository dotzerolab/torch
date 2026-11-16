// One live collection per shape for the life of the page, so going back to a team does not restart its sync, plus the
// ways a shape ends: `restart` (access changed, start over), `dropTeam` (the team is gone for this person).
// A restarted collection is a NEW instance with a NEW id: react-db derives a live query's identity from the ids of
// its source collections, so a reused id would leave open queries bound to the instance that was cleaned up.
import { useEffect, useSyncExternalStore } from 'react';

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

/**
 * How many shapes a page keeps open at once. The browser allows about six connections per origin on HTTP/1.1 and a
 * live shape holds one for its long-poll, so the budget leaves room for a write and a page load: `teams`, `members`,
 * `ownMemberships` and the `issues` of the team in view.
 */
export const MAX_LIVE_SHAPES = 4;

/** How long a team's shapes stay open after it left view, when the budget has room. */
export const PAUSE_AFTER_MS = 30_000;

export function createRegistry<F extends Factories>(factories: F) {
  const entries = new Map<string, Entry>();
  // Highest generation ever used per key: ids are never reused, even after a drop.
  const generations = new Map<string, number>();
  // Teams the server said are gone for this person (404). A page still showing one would otherwise ask for it
  // again and loop; it is served an empty local collection until the team id comes back in the `teams` shape.
  const gone = new Set<string>();
  const listeners = new Set<() => void>();
  // Readers per team-scoped shape (React components holding it), and the timer that closes one nobody reads.
  const holds = new Map<string, number>();
  const pauseTimers = new Map<string, ReturnType<typeof setTimeout>>();

  const notify = () => {
    for (const listener of [...listeners]) listener();
  };

  function dispose(collection: Cleanable) {
    // `dependents: true` also ends the live queries that still read it; they re-bind on the notification. The call
    // starts at once: the request of the shape must be aborted before its replacement is made.
    try {
      Promise.resolve(collection.cleanup({ dependents: true })).catch(() => {});
    } catch {
      // A collection that cannot be cleaned up right now ends with the page.
    }
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
    clearTimeout(pauseTimers.get(k));
    pauseTimers.delete(k);
    const old = entries.get(k);
    if (old) dispose(old.collection);
    entries.delete(k);
    return old !== undefined;
  }

  /** Ends the shape and starts a fresh one the next time it is read; open readers are told to re-bind. */
  function restart(key: ShapeKey) {
    const existed = replace(key);
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

  /** Ends a team shape nobody reads. It starts again, from scratch, the next time it is read. */
  function pause(key: ShapeKey) {
    replace(key);
  }

  /**
   * A component is reading this shape. A team-scoped shape stays open while it is read; once the last reader left it
   * closes at once when the page is over its budget (`MAX_LIVE_SHAPES`), else 30 s later so a quick return is free.
   */
  function hold(key: ShapeKey): () => void {
    if (!isTeamKey(key)) return () => {};
    const k = keyOf(key);
    const held = entries.get(k);
    holds.set(k, (holds.get(k) ?? 0) + 1);
    clearTimeout(pauseTimers.get(k));
    pauseTimers.delete(k);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const left = (holds.get(k) ?? 1) - 1;
      if (left > 0) {
        holds.set(k, left);
        return;
      }
      holds.delete(k);
      // A restart or a drop already replaced the instance this reader held: nothing of it is left to pause.
      if (entries.get(k) !== held) return;
      if (entries.size > MAX_LIVE_SHAPES) pause(key);
      else {
        pauseTimers.set(
          k,
          setTimeout(() => {
            pauseTimers.delete(k);
            if (!holds.has(k)) pause(key);
          }, PAUSE_AFTER_MS),
        );
      }
    };
  }

  /** How many shapes the page has open. */
  function liveCount(): number {
    return entries.size;
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
    for (const timer of pauseTimers.values()) clearTimeout(timer);
    pauseTimers.clear();
    holds.clear();
    generations.clear();
    gone.clear();
    notify();
  }

  return { get, hold, liveCount, restart, dropTeam, reinstateTeam, isGone, subscribe, reset };
}

export type SyncRegistry<F extends Factories = Factories> = ReturnType<typeof createRegistry<F>>;

/** The collection of a shape, for render: re-reads when the shape restarts or its team is dropped. */
export function useShapeFrom<F extends Factories, K extends ShapeKey>(
  registry: SyncRegistry<F>,
  key: K,
): CollectionFor<F, K> {
  const collection = useSyncExternalStore(registry.subscribe, () => registry.get(key));
  const id = isTeamKey(key) ? `${key.kind}:${key.workspaceId}:${key.teamId}` : null;
  // biome-ignore lint/correctness/useExhaustiveDependencies: `id` is the key; the object is new every render
  useEffect(() => registry.hold(key), [registry, id, collection]);
  return collection;
}
