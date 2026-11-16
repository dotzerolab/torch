// The page's registry of live shapes and the hook that reads one. A shape that restarts (access changed) is a new
// collection: `useShape` re-renders its reader with the new instance, so live queries re-bind to it.
import { collectionFactories } from './collections.ts';
import { type CollectionFor, createRegistry, type ShapeKey, useShapeFrom } from './registry.ts';

export const syncRegistry = createRegistry(collectionFactories);

/** The collection of a shape, for render: re-reads when the shape restarts or its team is dropped. */
export function useShape<K extends ShapeKey>(key: K): CollectionFor<typeof collectionFactories, K> {
  return useShapeFrom(syncRegistry, key);
}

// For event handlers and effects, which run at call time and so always see the current instance.
export const teamsCollection = (workspaceId: string) =>
  syncRegistry.get({ kind: 'teams', workspaceId });
export const membersCollection = (workspaceId: string) =>
  syncRegistry.get({ kind: 'members', workspaceId });
