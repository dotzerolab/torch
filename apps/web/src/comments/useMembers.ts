import { useLiveQuery } from '@tanstack/react-db';
import { useCallback, useContext, useMemo } from 'react';
import { useT } from '../design/index.ts';
import { ShellContext } from '../shell/ShellContext.ts';
import type { SyncedMember } from '../sync/collections.ts';
import { useShape } from '../sync/shapes.ts';

/**
 * The members of the workspace the person can see, by id, and `nameOf`: the name to show for a person id.
 *
 * A person missing from the list is not necessarily gone. Everybody but a guest receives every member of the workspace
 * (a deactivated one included), so for them an id that is missing once the list has loaded belongs to a person who no
 * longer exists: "Former member". A guest receives only the members they share a team with, and can see the comment of
 * somebody who is not among them (a member who commented in a public team without being in it): for a guest, and for
 * anybody while the list is still loading, a missing id is just somebody they cannot see, "A workspace member".
 */
export function useMembers(workspaceId: string): {
  members: SyncedMember[];
  byId: ReadonlyMap<string, SyncedMember>;
  ready: boolean;
  nameOf: (id: string) => string;
} {
  const t = useT();
  const role = useContext(ShellContext)?.workspace.role;
  const collection = useShape({ kind: 'members', workspaceId });
  const { data, isReady } = useLiveQuery({
    query: (q) => q.from({ member: collection }).orderBy(({ member }) => member.name),
  });
  const byId = useMemo(() => new Map(data.map((member) => [member.id, member])), [data]);
  const seesEveryone = isReady && role !== undefined && role !== 'guest';
  const nameOf = useCallback(
    (id: string) =>
      byId.get(id)?.name ?? t(seesEveryone ? 'comments.formerMember' : 'comments.workspaceMember'),
    [byId, seesEveryone, t],
  );
  return { members: data, byId, ready: isReady, nameOf };
}
