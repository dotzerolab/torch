import { useEffect } from 'react';
import { closeAllStores } from '../sync/persistence.ts';
import { markSigningOut } from '../sync/signing-out.ts';
import { listenForSignOut } from '../sync/tabs.ts';

/**
 * Another tab of this browser signs out: this tab closes its device store (the files cannot be removed under it), and
 * goes to the sign-in page once the sign-out is over.
 */
export function useSignOutElsewhere(): void {
  useEffect(
    () =>
      listenForSignOut(
        async () => {
          // The session ends under this tab: a shape answering 401 must not send it away before the wipe is done.
          markSigningOut();
          await closeAllStores();
        },
        () => window.location.assign('/login'),
      ),
    [],
  );
}
