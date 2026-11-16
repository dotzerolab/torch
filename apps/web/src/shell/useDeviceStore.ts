import { useEffect, useState } from 'react';
import { openWorkspaceStore, persistenceFor } from '../sync/persistence.ts';
import { leadWorkspace, syncRegistry } from '../sync/shapes.ts';
import { claimRole, onPromoted, roleOf } from '../sync/tabs.ts';

/**
 * Joins the tabs of the workspace and, for the tab that syncs it (the leader), opens its device store; reports when that
 * ended, so the shapes are created with their role and the store in place (a collection is configured once, when its
 * factory runs). A browser that cannot keep files rejects the open: the page then works from memory, as before. A tab
 * that follows another opens no store: it reads what the leader tab mirrors. The first sync starts only after this
 * settled. If the leader tab ends, this tab takes over: it opens the store and its shapes start again as leader shapes.
 */
export function useDeviceStore(workspaceId: string): boolean {
  const [settled, setSettled] = useState(
    () => persistenceFor(workspaceId) !== null && roleOf(workspaceId) === 'leader',
  );
  useEffect(() => {
    let live = true;
    const lead = async () => {
      await openWorkspaceStore(workspaceId).catch(() => {});
      if (!live) return;
      leadWorkspace(workspaceId);
    };
    claimRole(workspaceId).then(async (role) => {
      if (role === 'leader') await lead();
      if (live) setSettled(true);
    });
    const stopPromotion = onPromoted(workspaceId, () => {
      void lead().then(() => live && syncRegistry.promote(workspaceId));
    });
    // A page restored from the back/forward cache lost its database connection (the worker ends on `pagehide`): start over.
    const onPageShow = (event: PageTransitionEvent) => {
      if (event.persisted) window.location.reload();
    };
    window.addEventListener('pageshow', onPageShow);
    return () => {
      live = false;
      stopPromotion();
      window.removeEventListener('pageshow', onPageShow);
    };
  }, [workspaceId]);
  return settled;
}
