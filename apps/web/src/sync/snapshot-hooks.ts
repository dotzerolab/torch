// The page's snapshot refresh wiring: one refresher and one watch for the registry, and the hooks a screen reads
// snapshots and the live issues of its team through (`snapshot-watch.ts` has the rules).
import { useEffect } from 'react';
import type { collectionFactories } from './collections.ts';
import { type CollectionFor, type ShapeKey, shapeId } from './registry.ts';
import { syncRegistry, useShape, useShapes } from './shapes.ts';
import { createSnapshotWatch } from './snapshot-watch.ts';
import { createRefresher } from './snapshots.ts';

export const refresher = createRefresher({ refresh: (key) => syncRegistry.refresh(key) });
export const snapshotWatch = createSnapshotWatch({ request: refresher.request });

/**
 * The collection of a snapshot shape for a screen, which also keeps it fresh: it is read again when the screen opens
 * after a minute, when the page comes back online or into focus, after this person's own write and when the team's
 * issues change (`useIssuesFeed`). The collection is a new one after each refresh: the hook re-renders with it.
 */
export function useSnapshot<K extends ShapeKey>(
  key: K,
): CollectionFor<typeof collectionFactories, K> {
  const collection = useShape(key);
  const id = shapeId(key);
  // biome-ignore lint/correctness/useExhaustiveDependencies: `id` is the key; the object is new every render
  useEffect(() => snapshotWatch.mount(key), [id]);
  return collection;
}

/**
 * Listens to the live `issues` shape of the team the screen shows and asks for the team's held snapshots when it
 * changes (the server moves an issue's `updated_at` for every change of its labels, relations, links and subscribers).
 * The first load of the issues is not a change.
 */
export function useIssuesFeed(workspaceId: string, teamId: string): void {
  const issues = useShape({ kind: 'issues', workspaceId, teamId });
  useEffect(() => {
    const subscription = issues.subscribeChanges(() => {
      if (issues.isReady()) snapshotWatch.issuesChanged(workspaceId, teamId);
    });
    return () => subscription.unsubscribe();
  }, [issues, workspaceId, teamId]);
}

/** `useSnapshot` for as many snapshots as a screen needs (one per team it shows): all of them kept fresh the same way. */
export function useSnapshots<K extends ShapeKey>(
  keys: readonly K[],
): CollectionFor<typeof collectionFactories, K>[] {
  const collections = useShapes(keys);
  const ids = keys.map((key) => shapeId(key)).join('|');
  // biome-ignore lint/correctness/useExhaustiveDependencies: `ids` names the keys; the array is new every render
  useEffect(() => {
    const unmounts = keys.map((key) => snapshotWatch.mount(key));
    return () => {
      for (const unmount of unmounts) unmount();
    };
  }, [ids]);
  return collections;
}

/**
 * `useIssuesFeed` for My Issues: when issues change, the snapshots of the teams they belong to are asked for (the server
 * moves an issue's `updated_at` for every change of its labels). The first load is not a change.
 */
export function useMyIssuesFeed(workspaceId: string): void {
  const issues = useShape({ kind: 'myIssues', workspaceId });
  useEffect(() => {
    const subscription = issues.subscribeChanges((changes) => {
      if (!issues.isReady()) return;
      const teams = new Set(changes.map((change) => change.value.team_id));
      for (const teamId of teams) snapshotWatch.issuesChanged(workspaceId, teamId);
    });
    return () => subscription.unsubscribe();
  }, [issues, workspaceId]);
}
