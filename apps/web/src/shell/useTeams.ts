import { useLiveQuery } from '@tanstack/react-db';
import type { SyncedTeam } from '../sync/collections.ts';
import { useShape } from '../sync/shapes.ts';

/** The teams of a workspace the signed-in member can see, ordered by key, and whether the first sync finished. */
export function useTeams(workspaceId: string): { teams: SyncedTeam[]; ready: boolean } {
  const collection = useShape({ kind: 'teams', workspaceId });
  const { data, isReady } = useLiveQuery({
    query: (q) => q.from({ team: collection }).orderBy(({ team }) => team.key),
  });
  return { teams: data, ready: isReady };
}
