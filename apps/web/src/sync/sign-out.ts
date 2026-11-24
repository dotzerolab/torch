// Signing out of a shared computer must leave nothing of the person's workspaces on the device: the synced rows in the
// local store and the writes still waiting in the outbox. Writes that never reached the server would be lost, so the
// person is told how many first and may stay signed in.
import { signOut as endSession } from '../auth/useSession.ts';
import { outbox } from './outbox.ts';
import { wipeWorkspaceStore } from './persistence.ts';
import { markSigningOut } from './signing-out.ts';
import { announceSignedOut, announceSignOut } from './tabs.ts';

export type SignOutDeps = {
  workspaceIds: string[];
  /** How many writes of the workspace wait on the device, whichever tab queued them. */
  pendingCount: (workspaceId: string) => Promise<number>;
  /** Asks the person; resolves true to go on. Called only when writes are waiting. */
  confirm: (pending: number) => Promise<boolean>;
  /** Ends the session on the server. */
  logout: () => Promise<void>;
  wipeWorkspace: (workspaceId: string) => Promise<void>;
  /** Leaves the page, so nothing of the signed-in screen stays in memory. */
  navigate: () => void;
  /** Tells the other tabs of this browser to let go of the device copy, and waits for them. */
  announce?: () => Promise<void>;
  /** Tells the other tabs the sign-out is over: they leave too. */
  announceDone?: () => void;
};

export async function runSignOut(deps: SignOutDeps): Promise<'signed-out' | 'cancelled'> {
  const counts = await Promise.all(deps.workspaceIds.map((id) => deps.pendingCount(id)));
  const pending = counts.reduce((sum, count) => sum + count, 0);
  if (pending > 0 && !(await deps.confirm(pending))) return 'cancelled';
  markSigningOut();
  // The tab that holds the device store must close it before its files can go; it is not signed out yet, so it waits.
  await deps.announce?.().catch(() => {});
  try {
    await deps.logout();
  } finally {
    // A wipe that fails must not keep the person signed in on a shared computer: every workspace is tried.
    await Promise.allSettled(deps.workspaceIds.map((id) => deps.wipeWorkspace(id)));
    deps.announceDone?.();
    deps.navigate();
  }
  return 'signed-out';
}

/** The page's sign-out: `confirm` shows the dialog; the rest is the real session, store and outbox. */
export function signOutWorkspaces(
  workspaceIds: string[],
  confirm: (pending: number) => Promise<boolean>,
) {
  return runSignOut({
    workspaceIds,
    pendingCount: outbox.storedCount,
    confirm,
    logout: () => endSession({ navigate: false }),
    wipeWorkspace: async (id) => {
      await outbox.wipe(id);
      await wipeWorkspaceStore(id);
    },
    navigate: () => window.location.assign('/login'),
    announce: () => announceSignOut(),
    announceDone: () => announceSignedOut(),
  });
}
