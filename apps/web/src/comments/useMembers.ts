import { useLiveQuery } from '@tanstack/react-db';
import { useMemo } from 'react';
import type { SyncedMember } from '../sync/collections.ts';
import { useShape } from '../sync/shapes.ts';

/**
 * The members of the workspace the person can see, by id. A person missing from it (a deactivated member a guest never
 * receives) is shown as a former member by the caller.
 */
export function useMembers(workspaceId: string): {
  members: SyncedMember[];
  byId: ReadonlyMap<string, SyncedMember>;
  ready: boolean;
} {
  const collection = useShape({ kind: 'members', workspaceId });
  const { data, isReady } = useLiveQuery({
    query: (q) => q.from({ member: collection }).orderBy(({ member }) => member.name),
  });
  const byId = useMemo(() => new Map(data.map((member) => [member.id, member])), [data]);
  return { members: data, byId, ready: isReady };
}
