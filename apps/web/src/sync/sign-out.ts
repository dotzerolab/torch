// Signing out of a shared computer must leave nothing of the person's workspaces on the device: the synced rows in the
// local store and the writes still waiting in the outbox. Writes that never reached the server would be lost, so the
// person is told how many first and may stay signed in.
import { signOut as endSession } from '../auth/useSession.ts';
import { outbox } from './outbox.ts';
import { wipeWorkspaceStore } from './persistence.ts';
import { markSigningOut } from './signing-out.ts';

export type SignOutDeps = {
  workspaceIds: string[];
  pendingCount: (workspaceId: string) => number;
  /** Asks the person; resolves true to go on. Called only when writes are waiting. */
  confirm: (pending: number) => Promise<boolean>;
  /** Ends the session on the server. */
  logout: () => Promise<void>;
  wipeWorkspace: (workspaceId: string) => Promise<void>;
  /** Leaves the page, so nothing of the signed-in screen stays in memory. */
  navigate: () => void;
};

export async function runSignOut(deps: SignOutDeps): Promise<'signed-out' | 'cancelled'> {
  const pending = deps.workspaceIds.reduce((sum, id) => sum + deps.pendingCount(id), 0);
  if (pending > 0 && !(await deps.confirm(pending))) return 'cancelled';
  markSigningOut();
  try {
    await deps.logout();
  } finally {
    // A wipe that fails must not keep the person signed in on a shared computer: every workspace is tried.
    await Promise.allSettled(deps.workspaceIds.map((id) => deps.wipeWorkspace(id)));
    deps.navigate();
  }
  return 'signed-out';
}

/** How many writes of these workspaces have not reached the server. */
export const pendingWrites = (workspaceIds: string[]) =>
  workspaceIds.reduce((sum, id) => sum + outbox.pendingCount(id), 0);

/** The page's sign-out: `confirm` shows the dialog; the rest is the real session, store and outbox. */
export function signOutWorkspaces(
  workspaceIds: string[],
  confirm: (pending: number) => Promise<boolean>,
) {
  return runSignOut({
    workspaceIds,
    pendingCount: outbox.pendingCount,
    confirm,
    logout: () => endSession({ navigate: false }),
    wipeWorkspace: async (id) => {
      await outbox.wipe(id);
      await wipeWorkspaceStore(id);
    },
    navigate: () => window.location.assign('/login'),
  });
}
