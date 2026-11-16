// The page's registry of live shapes and the hook that reads one. A shape that restarts (access changed) is a new
// collection: `useShape` re-renders its reader with the new instance, so live queries re-bind to it.
import { collectionFactories } from './collections.ts';
import { outbox } from './outbox.ts';
import { deleteShapeRows, deleteTeamRows } from './persistence.ts';
import { type CollectionFor, createRegistry, type ShapeKey, useShapeFrom } from './registry.ts';

export const syncRegistry = createRegistry(collectionFactories, {
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
