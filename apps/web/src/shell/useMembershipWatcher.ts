import { useEffect } from 'react';
import { startMembershipWatcher } from '../sync/membership.ts';

/** Keeps the shapes of one workspace in step with the signed-in member's access for as long as the shell shows it. */
export function useMembershipWatcher(workspaceId: string, memberId: string): void {
  useEffect(() => startMembershipWatcher(workspaceId, memberId), [workspaceId, memberId]);
}
