// Ends open shape requests when somebody's access changes. A long-poll on a team's issues is authorised once, when
// it starts, and Electric then answers it with whatever the shape matches at that moment; a member removed from the
// team meanwhile would still receive the next row. The proxy registers every upstream request here and the services
// call `accessChanged` after their transaction commits, so the request ends and the client's next one is
// authorised again against the new state.
//
// In process only: one server instance. A second instance would need the same signal over the database
// (LISTEN/NOTIFY), planned with the multi-instance work.

export type AccessBus = {
  /** Registers an open upstream request; returns the function that unregisters it (safe to call twice). */
  track(workspaceId: string, memberId: string, abort: () => void): () => void;
  /** After commit: ends every tracked request of these members of one workspace ('all' = the whole workspace). */
  accessChanged(workspaceId: string, memberIds: readonly string[] | 'all'): void;
  /** How many requests are tracked right now. */
  tracked(): number;
};

/** What the services need of the bus; a missing one (tests, tools) means nobody is listening. */
export type AccessNotifier = Pick<AccessBus, 'accessChanged'>;

export function createAccessBus(): AccessBus {
  // workspace -> member -> the abort callbacks of that member's open requests.
  const open = new Map<string, Map<string, Set<() => void>>>();
  let count = 0;

  function forget(workspaceId: string, memberId: string, abort: () => void): boolean {
    const members = open.get(workspaceId);
    const requests = members?.get(memberId);
    if (!members || !requests?.delete(abort)) return false;
    count--;
    if (requests.size === 0) members.delete(memberId);
    if (members.size === 0) open.delete(workspaceId);
    return true;
  }

  return {
    track(workspaceId, memberId, abort) {
      const members = open.get(workspaceId) ?? new Map<string, Set<() => void>>();
      const requests = members.get(memberId) ?? new Set<() => void>();
      requests.add(abort);
      members.set(memberId, requests);
      open.set(workspaceId, members);
      count++;
      return () => {
        forget(workspaceId, memberId, abort);
      };
    },

    accessChanged(workspaceId, memberIds) {
      const members = open.get(workspaceId);
      if (!members) return;
      const targets = memberIds === 'all' ? [...members.keys()] : memberIds;
      // Collect first: an abort may unregister (or register) requests while this loop runs.
      const ending: Array<{ memberId: string; abort: () => void }> = [];
      for (const memberId of targets) {
        for (const abort of members.get(memberId) ?? []) ending.push({ memberId, abort });
      }
      for (const { memberId, abort } of ending) {
        if (!forget(workspaceId, memberId, abort)) continue;
        try {
          abort();
        } catch {
          // One request failing to end must not leave the others of the same change open.
        }
      }
    },

    tracked: () => count,
  };
}

/**
 * Sessions that were just revoked or signed out: every person they belonged to may have open requests in their
 * workspace (one cookie can carry sessions of several workspaces, so the pairs are grouped per workspace).
 */
export function notifySessionsRevoked(
  bus: AccessNotifier | undefined,
  revoked: ReadonlyArray<{ workspaceId: string; memberId: string }>,
): void {
  if (!bus || revoked.length === 0) return;
  const byWorkspace = new Map<string, Set<string>>();
  for (const { workspaceId, memberId } of revoked) {
    const ids = byWorkspace.get(workspaceId) ?? new Set<string>();
    ids.add(memberId);
    byWorkspace.set(workspaceId, ids);
  }
  for (const [workspaceId, ids] of byWorkspace) bus.accessChanged(workspaceId, [...ids]);
}
