import { useEffect, useState } from 'react';
import { openWorkspaceStore, persistenceFor } from '../sync/persistence.ts';

/**
 * Opens the device store of a workspace and reports when the attempt ended, so the shapes are created with the store
 * in place (a collection is configured once, when its factory runs). A browser that cannot keep files rejects the
 * open: the page then works from memory, as before. The first sync starts only after this settled.
 */
export function useDeviceStore(workspaceId: string): boolean {
  const [settled, setSettled] = useState(() => persistenceFor(workspaceId) !== null);
  useEffect(() => {
    let live = true;
    openWorkspaceStore(workspaceId).then(
      () => live && setSettled(true),
      () => live && setSettled(true),
    );
    // A page restored from the back/forward cache lost its database connection (the worker ends on `pagehide`): start over.
    const onPageShow = (event: PageTransitionEvent) => {
      if (event.persisted) window.location.reload();
    };
    window.addEventListener('pageshow', onPageShow);
    return () => {
      live = false;
      window.removeEventListener('pageshow', onPageShow);
    };
  }, [workspaceId]);
  return settled;
}
