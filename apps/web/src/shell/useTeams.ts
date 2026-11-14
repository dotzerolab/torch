import { useLiveQuery } from '@tanstack/react-db';
import { type SyncedTeam, teamsCollection } from '../sync/collections.ts';

/** The teams of a workspace the signed-in member can see, ordered by key, and whether the first sync finished. */
export function useTeams(workspaceId: string): { teams: SyncedTeam[]; ready: boolean } {
  const collection = teamsCollection(workspaceId);
  const { data, isReady } = useLiveQuery({
    query: (q) => q.from({ team: collection }).orderBy(({ team }) => team.key),
  });
  return { teams: data, ready: isReady };
}
