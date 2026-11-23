// The page's registry of live shapes and the hook that reads one. A shape that restarts (access changed) is a new
// collection: `useShape` re-renders its reader with the new instance, so live queries re-bind to it.
import { collectionFactories } from './collections.ts';
import { hubFor } from './mirror.ts';
import { outbox } from './outbox.ts';
import {
  closeWorkspaceStore,
  deleteShapeRows,
  deleteTeamRows,
  storedGeneration,
} from './persistence.ts';
import {
  type CollectionFor,
  createRegistry,
  parseShapeId,
  type ShapeKey,
  useShapeFrom,
} from './registry.ts';
import { roleOf } from './tabs.ts';

export const syncRegistry = createRegistry(collectionFactories, {
  role: roleOf,
  storedGeneration: (key, baseId) => storedGeneration(key.workspaceId, baseId),
  // A team the person lost: its persisted rows and its queued writes must not outlive the access.
  onTeamDropped: (workspaceId, teamId) => {
    void deleteTeamRows(workspaceId, teamId).catch(() => {});
    void outbox.dropTeamWrites(workspaceId, teamId).catch(() => {});
  },
  // A shape that started over (access changed) must not leave its old rows on the device for the next page load.
  onShapeRestarted: (key, baseId, keepId) => {
    void deleteShapeRows(key.workspaceId, baseId, keepId).catch(() => {});
  },
});

/** The collection of a shape, for render: re-reads when the shape restarts or its team is dropped. */
export function useShape<K extends ShapeKey>(key: K): CollectionFor<typeof collectionFactories, K> {
  return useShapeFrom(syncRegistry, key);
}

// For event handlers and effects, which run at call time and so always see the current instance.
export const teamsCollection = (workspaceId: string) =>
  syncRegistry.get({ kind: 'teams', workspaceId });
export const membersCollection = (workspaceId: string) =>
  syncRegistry.get({ kind: 'members', workspaceId });

/**
 * This tab leads the workspace: the follower tabs read their shapes through it. A shape a follower reads is opened and
 * held here as if a screen of this tab read it, and a follower's write waits here for the txid to come back.
 */
export function leadWorkspace(workspaceId: string) {
  const hold = (shape: string) => {
    const key = parseShapeId(shape);
    let released = false;
    let release = () => {};
    const open = () => {
      // The instance may have been replaced (a restart): the new one must run too.
      void (syncRegistry.get(key) as { preload(): Promise<void> }).preload().catch(() => {});
    };
    open();
    release = syncRegistry.hold(key);
    const stop = syncRegistry.subscribe(() => {
      if (!released) open();
    });
    return () => {
      released = true;
      stop();
      release();
    };
  };
  hubFor(workspaceId).lead({
    demand: hold,
    awaitTxId: (shape, txid, timeoutMs) => {
      const collection = syncRegistry.get(parseShapeId(shape)) as {
        utils?: { awaitTxId?: (txid: number, timeoutMs?: number) => Promise<unknown> };
      };
      if (!collection.utils?.awaitTxId) return Promise.reject(new Error('no such shape'));
      return collection.utils.awaitTxId(txid, timeoutMs);
    },
  });
}

/**
 * The page no longer shows the workspace: this tab stops answering followers, ends its shapes of it and closes its device
 * store, so another tab can lead (and open the store) at once.
 */
export async function stopWorkspace(workspaceId: string): Promise<void> {
  hubFor(workspaceId).stopLeading();
  syncRegistry.leave(workspaceId);
  await closeWorkspaceStore(workspaceId);
}
