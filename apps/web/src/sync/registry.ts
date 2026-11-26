// One collection per shape for the life of the page, so going back to a team does not restart its sync, plus the
// ways a shape ends: `restart` (access changed, start over), `dropTeam` (the team is gone for this person).
// A restarted collection is a NEW instance with a NEW id: react-db derives a live query's identity from the ids of
// its source collections, so a reused id would leave open queries bound to the instance that was cleaned up.
// Most shapes are live (they keep a connection open and count against `MAX_LIVE_SHAPES`). A snapshot shape
// (`SNAPSHOT_KINDS`) is read to its end and closed: it holds no connection, is not counted, and `refresh` reads it again.
import { useEffect, useSyncExternalStore } from 'react';

type WorkspaceKind = 'teams' | 'members' | 'ownMemberships' | 'workspaceLabels';
type TeamKind =
  | 'issues'
  | 'workflowStates'
  | 'teamMembers'
  | 'labels'
  | 'issueLabels'
  | 'issueRelations'
  | 'issueLinks'
  | 'issueSubscribers';
/** Shapes of one opened issue (its description, its history): a team's, and keyed by the issue too. */
type IssueKind = 'issueDetail' | 'issueActivity';
export type ShapeKind = WorkspaceKind | TeamKind | IssueKind;
type KeyOf<K extends ShapeKind> = K extends WorkspaceKind
  ? { kind: K; workspaceId: string }
  : K extends IssueKind
    ? { kind: K; workspaceId: string; teamId: string; issueId: string }
    : { kind: K; workspaceId: string; teamId: string };
export type ShapeKey = KeyOf<ShapeKind>;

/** What the registry needs of a collection. */
export type Cleanable = { cleanup(options?: { dependents?: boolean }): unknown };

/** What a factory may call back into. `inert` asks for an empty collection that never syncs (a team that is gone). */
export type ShapeContext = {
  dropTeam: (workspaceId: string, teamId: string) => void;
  inert: boolean;
  /**
   * The shape has just applied an answer of the server (every `up-to-date`, and the one after a `must-refetch`): its rows
   * are current. Only the instance the registry holds is heard; a replaced one may still answer once while it stops.
   */
  settled: () => void;
  /** True while the instance ends because it was paused (it starts again under the same id), false for a restart or a drop. */
  paused: () => boolean;
  /**
   * `leader`: this tab syncs the shape and keeps it on the device. `follower`: another tab does, and this instance
   * reads what that tab mirrors (`mirror.ts`); it opens no request. A snapshot shape (`SNAPSHOT_KINDS`) is never
   * mirrored: a follower reads it for itself, one short request, in memory only.
   */
  role: 'leader' | 'follower';
};

export type Factories = {
  [K in ShapeKind]: (key: KeyOf<K>, id: string, context: ShapeContext) => Cleanable;
};
export type CollectionFor<F extends Factories, K extends ShapeKey> = ReturnType<F[K['kind']]>;

/**
 * The kinds of shape a team owns; collection ids on the device are `<kind>-<workspaceId>-<teamId>`, and for the shapes of
 * one issue `<kind>-<workspaceId>-<teamId>-<issueId>`: losing the team ends every one of them with a single prefix.
 */
export const TEAM_KINDS: readonly (TeamKind | IssueKind)[] = [
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
];

const ISSUE_KINDS: readonly IssueKind[] = ['issueDetail', 'issueActivity'];

/**
 * Snapshot shapes: read to `up-to-date` and then closed, so they hold no connection and are not counted against
 * `MAX_LIVE_SHAPES`. They are refreshed (`refresh`) when a screen needs them current. Kinds that read small tables or
 * one object (labels, relations, links, subscribers, workflow states, an issue's description and history) belong here;
 * a new snapshot kind is an entry in this list and a factory in `collections.ts`.
 */
export const SNAPSHOT_KINDS: readonly ShapeKind[] = [
  'workflowStates',
  'labels',
  'issueLabels',
  'issueRelations',
  'issueLinks',
  'issueSubscribers',
  'workspaceLabels',
  'issueDetail',
  'issueActivity',
];

export function isSnapshotKind(kind: string): boolean {
  return (SNAPSHOT_KINDS as readonly string[]).includes(kind);
}

export function isTeamKey(key: ShapeKey): key is Extract<ShapeKey, { teamId: string }> {
  return (TEAM_KINDS as readonly string[]).includes(key.kind);
}

function isIssueKey(key: ShapeKey): key is Extract<ShapeKey, { issueId: string }> {
  return (ISSUE_KINDS as readonly string[]).includes(key.kind);
}

function keyOf(key: ShapeKey): string {
  if (isIssueKey(key)) return `${key.kind}:${key.workspaceId}:${key.teamId}:${key.issueId}`;
  return isTeamKey(key)
    ? `${key.kind}:${key.workspaceId}:${key.teamId}`
    : `${key.kind}:${key.workspaceId}`;
}

/** The name of a shape between tabs; the same in every tab. Ids are UUIDs, so `:` never occurs inside one. */
export const shapeId = keyOf;

/** The live shapes: the ones a tab reads through the leader. A snapshot is read by every tab on its own. */
const SHARED_KINDS: readonly ShapeKind[] = [
  'teams',
  'members',
  'ownMemberships',
  'issues',
  'teamMembers',
];

/**
 * Does the id name a shape the tabs share, of a known kind (a message from another tab is not trusted)? Snapshot kinds
 * never travel between tabs, so a message naming one is refused.
 */
export function isShapeId(id: string): boolean {
  const [kind, workspaceId, teamId, extra] = id.split(':');
  if (!kind || !workspaceId || extra !== undefined) return false;
  if (!(SHARED_KINDS as readonly string[]).includes(kind)) return false;
  return (TEAM_KINDS as readonly string[]).includes(kind) ? Boolean(teamId) : teamId === undefined;
}

/** The key a shape id names (any kind, the id of a shape of one issue included). */
export function parseShapeId(id: string): ShapeKey {
  const [kind, workspaceId, teamId, issueId] = id.split(':') as [
    ShapeKind,
    string,
    string | undefined,
    string | undefined,
  ];
  if (teamId === undefined) return { kind, workspaceId } as ShapeKey;
  return (
    issueId === undefined ? { kind, workspaceId, teamId } : { kind, workspaceId, teamId, issueId }
  ) as ShapeKey;
}

function goneKey(workspaceId: string, teamId: string): string {
  return `${workspaceId}:${teamId}`;
}

type Entry = {
  key: ShapeKey;
  collection: Cleanable;
  generation: number;
  state: { paused: boolean };
};

/**
 * How many LIVE shapes a page keeps open at once. The browser allows about six connections per origin on HTTP/1.1 and a
 * live shape holds one for its long-poll, so the budget leaves room for a write and a page load: `teams`, `members`,
 * `ownMemberships` and the `issues` of the team in view. Snapshot shapes (`SNAPSHOT_KINDS`) end after their first answer
 * and are not counted.
 */
export const MAX_LIVE_SHAPES = 4;

/** How long a team's shapes stay open after it left view, when the budget has room. */
export const PAUSE_AFTER_MS = 30_000;

/** Side effects of the registry the page wires in: what else must go when a shape ends or a team is gone. */
export type RegistryHooks = {
  /** Called once the ended instances have stopped: the team is gone for this person. */
  onTeamDropped?: (workspaceId: string, teamId: string) => void;
  /**
   * Called once the old instance of a restarted shape has stopped. `baseId` is the shape's id without a restart suffix,
   * `keepId` the id of the instance that replaces it: whatever else was stored under `baseId` is stale.
   */
  onShapeRestarted?: (key: ShapeKey, baseId: string, keepId: string) => void;
  /** The role of this tab for a workspace, read whenever an instance is made. Default: leader. */
  role?: (workspaceId: string) => 'leader' | 'follower';
  /**
   * The generation the device already holds for a shape (0 when it holds none): a leader that starts a shape continues
   * from the copy on the device, instead of starting a new one beside it. Tabs do not share their generation counters,
   * so a leader that took over from another tab finds the id its predecessor used here.
   */
  storedGeneration?: (key: ShapeKey, baseId: string) => number;
  /**
   * Called when a reader takes a team shape and the page is then over its budget (`MAX_LIVE_SHAPES`): whatever is open for
   * no screen of this tab (a shape a follower tab reads) must close to make room.
   */
  overBudget?: () => void;
};

export function createRegistry<F extends Factories>(factories: F, hooks: RegistryHooks = {}) {
  const entries = new Map<string, Entry>();
  // Highest generation ever used per key: ids are never reused, even after a drop.
  const generations = new Map<string, number>();
  // Teams the server said are gone for this person (404). A page still showing one would otherwise ask for it
  // again and loop; it is served an empty local collection until the team id comes back in the `teams` shape.
  const gone = new Set<string>();
  const listeners = new Set<() => void>();
  const settledListeners = new Map<ShapeKind, Set<(workspaceId: string) => void>>();
  // Readers per team-scoped shape (React components holding it), and the timer that closes one nobody reads.
  const holds = new Map<string, number>();
  const pauseTimers = new Map<string, ReturnType<typeof setTimeout>>();

  const notify = () => {
    for (const listener of [...listeners]) listener();
  };

  function dispose(collection: Cleanable): Promise<void> {
    // `dependents: true` also ends the live queries that still read it; they re-bind on the notification. The call
    // starts at once: the request of the shape must be aborted before its replacement is made. The promise settles
    // when the instance has stopped, which is when its device copy may be deleted without a write racing it.
    try {
      return Promise.resolve(collection.cleanup({ dependents: true })).then(
        () => {},
        () => {},
      );
    } catch {
      // A collection that cannot be cleaned up right now ends with the page.
      return Promise.resolve();
    }
  }

  function baseId(key: ShapeKey): string {
    if (isIssueKey(key)) return `${key.kind}-${key.workspaceId}-${key.teamId}-${key.issueId}`;
    return isTeamKey(key)
      ? `${key.kind}-${key.workspaceId}-${key.teamId}`
      : `${key.kind}-${key.workspaceId}`;
  }

  // Snapshots that were refreshed and whose next instance has not settled yet: the older device copies of such a shape go
  // once the new one holds the server's answer, so a refresh that cannot reach the server (offline) loses nothing.
  const refreshing = new Set<string>();

  function create(key: ShapeKey): Entry {
    const k = keyOf(key);
    const role = hooks.role?.(key.workspaceId) ?? 'leader';
    if (role === 'leader' && !generations.has(k)) {
      generations.set(k, Math.max(0, (hooks.storedGeneration?.(key, baseId(key)) ?? 0) - 1));
    }
    const generation = (generations.get(k) ?? 0) + 1;
    generations.set(k, generation);
    const storeId = generation === 1 ? baseId(key) : `${baseId(key)}~${generation}`;
    // A follower reads through another tab: its ids never equal a device id, so the instance that replaces it when this
    // tab becomes the leader is a different source for react-db (see the note at the top of this file).
    const id = role === 'follower' ? `mirror-${storeId}` : storeId;
    const inert = isTeamKey(key) && gone.has(goneKey(key.workspaceId, key.teamId));
    const make = factories[key.kind] as (
      key: ShapeKey,
      id: string,
      context: ShapeContext,
    ) => Cleanable;
    let supersedes = refreshing.delete(k);
    const settled = () => {
      // Only the current instance of the shape: a restart or a drop already replaced the one that calls.
      if (entries.get(k)?.generation !== generation) return;
      if (supersedes) {
        supersedes = false;
        hooks.onShapeRestarted?.(key, baseId(key), storeId);
      }
      for (const listener of [...(settledListeners.get(key.kind) ?? [])]) listener(key.workspaceId);
    };
    const state = { paused: false };
    return {
      key,
      collection: make(key, id, { dropTeam, inert, settled, paused: () => state.paused, role }),
      generation,
      state,
    };
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

  /** Ends the instance of a shape; resolves when it has stopped, or at once when there was none. */
  function replace(key: ShapeKey): Promise<void> | null {
    const k = keyOf(key);
    clearTimeout(pauseTimers.get(k));
    pauseTimers.delete(k);
    refreshing.delete(k);
    const old = entries.get(k);
    entries.delete(k);
    return old ? dispose(old.collection) : null;
  }

  /** Ends the shape and starts a fresh one the next time it is read; open readers are told to re-bind. */
  function restart(key: ShapeKey) {
    const stopped = replace(key);
    // A shape nobody read yet has nothing to restart. Create it lazily on the next `get`.
    if (!stopped) return;
    const keepId = `${baseId(key)}~${(generations.get(keyOf(key)) ?? 0) + 1}`;
    void stopped.then(() => hooks.onShapeRestarted?.(key, baseId(key), keepId));
    notify();
  }

  /** Every open shape of a team: its own and those of its issues. */
  function teamEntries(workspaceId: string, teamId: string): Entry[] {
    return [...entries.values()].filter(
      (entry) =>
        isTeamKey(entry.key) &&
        entry.key.workspaceId === workspaceId &&
        entry.key.teamId === teamId,
    );
  }

  /**
   * Reads a snapshot shape again: the instance ends and the next read makes a new one, with a new id (see the note at the
   * top of this file), so open readers re-bind. Only a snapshot is refreshed; a live shape is always current.
   */
  function refresh(key: ShapeKey) {
    if (!isSnapshotKind(key.kind)) return;
    const stopped = replace(key);
    // A shape nobody read yet has nothing to refresh. It starts the first time it is read.
    if (!stopped) return;
    refreshing.add(keyOf(key));
    notify();
  }

  /** The team is no longer visible: end its shapes. Readers still on screen get empty collections. */
  function dropTeam(workspaceId: string, teamId: string) {
    gone.add(goneKey(workspaceId, teamId));
    const stopped = teamEntries(workspaceId, teamId).map((entry) => replace(entry.key));
    // The shapes are ended; once they have stopped writing, the device copy and the queued writes of the team go too.
    void Promise.all(stopped).then(() => hooks.onTeamDropped?.(workspaceId, teamId));
    notify();
  }

  /** The team id is back in the person's `teams` shape: shapes of it may sync again. */
  function reinstateTeam(workspaceId: string, teamId: string) {
    if (!gone.delete(goneKey(workspaceId, teamId))) return;
    for (const entry of teamEntries(workspaceId, teamId)) replace(entry.key);
    notify();
  }

  /**
   * This tab became the leader of the workspace: its instances read from a leader that is gone, so they end and start
   * again as leaders, from the device copy the old leader left.
   */
  function promote(workspaceId: string) {
    for (const entry of [...entries.values()]) {
      if (entry.key.workspaceId !== workspaceId) continue;
      replace(entry.key);
      generations.delete(keyOf(entry.key));
    }
    notify();
  }

  /** The page no longer shows the workspace: every instance of it ends, and a later visit starts them afresh. */
  function leave(workspaceId: string) {
    for (const entry of [...entries.values()]) {
      if (entry.key.workspaceId !== workspaceId) continue;
      replace(entry.key);
      generations.delete(keyOf(entry.key));
    }
    notify();
  }

  function isGone(workspaceId: string, teamId: string): boolean {
    return gone.has(goneKey(workspaceId, teamId));
  }

  /**
   * Ends a team shape nobody reads. It starts again the next time it is read, under the SAME id: no live query reads it
   * now, and the device copy it left (rows and resume position) is what the new instance starts from.
   */
  function pause(key: ShapeKey) {
    const entry = entries.get(keyOf(key));
    if (entry) entry.state.paused = true;
    if (!replace(key)) return;
    const k = keyOf(key);
    generations.set(k, Math.max(0, (generations.get(k) ?? 1) - 1));
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
    if (liveCount() > MAX_LIVE_SHAPES) hooks.overBudget?.();
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
      // A snapshot holds no connection after its answer, so being over budget is no reason to close it at once.
      if (liveCount() > MAX_LIVE_SHAPES && !isSnapshotKind(key.kind)) {
        // At once, but not before the end of the tick: a reader that ends and starts again in it (a development render
        // does this to every effect) must find the open instance, which a live query may be bound to.
        queueMicrotask(() => {
          if (!holds.has(k) && entries.get(k) === held) pause(key);
        });
      } else {
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

  /** How many live shapes the page has open: a snapshot is read to its end and closed, so it is not counted. */
  function liveCount(): number {
    let live = 0;
    for (const entry of entries.values()) if (!isSnapshotKind(entry.key.kind)) live += 1;
    return live;
  }

  /** Is the shape running on this page (an instance exists)? */
  function isOpen(key: ShapeKey): boolean {
    return entries.has(keyOf(key));
  }

  /** How many readers hold a team shape. */
  function holdCount(key: ShapeKey): number {
    return holds.get(keyOf(key)) ?? 0;
  }

  /** Ends a team shape now, unless a reader holds it. It starts again, under the same id, when it is next read. */
  function pauseNow(key: ShapeKey) {
    if (!isTeamKey(key) || holds.has(keyOf(key))) return;
    pause(key);
  }

  /** `listener` hears every settle of the current instance of a shape of this kind (any workspace). */
  function onSettled(kind: ShapeKind, listener: (workspaceId: string) => void): () => void {
    const set = settledListeners.get(kind) ?? new Set();
    settledListeners.set(kind, set);
    set.add(listener);
    return () => {
      set.delete(listener);
    };
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
    refreshing.clear();
    notify();
  }

  return {
    get,
    hold,
    liveCount,
    isOpen,
    holdCount,
    pauseNow,
    restart,
    refresh,
    dropTeam,
    reinstateTeam,
    promote,
    leave,
    isGone,
    subscribe,
    onSettled,
    reset,
  };
}

export type SyncRegistry<F extends Factories = Factories> = ReturnType<typeof createRegistry<F>>;

/** The collection of a shape, for render: re-reads when the shape restarts or its team is dropped. */
export function useShapeFrom<F extends Factories, K extends ShapeKey>(
  registry: SyncRegistry<F>,
  key: K,
): CollectionFor<F, K> {
  const collection = useSyncExternalStore(registry.subscribe, () => registry.get(key));
  const id = isTeamKey(key) ? shapeId(key) : null;
  // biome-ignore lint/correctness/useExhaustiveDependencies: `id` is the key; the object is new every render
  useEffect(() => registry.hold(key), [registry, id, collection]);
  return collection;
}
